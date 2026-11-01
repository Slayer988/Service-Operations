'use strict';
// E-mail channel (EMAIL-001 .. EMAIL-013). Two shared mailboxes (Security, IT Services) are read over IMAP.
// Every message is recorded once (unique provider message id), kept as a raw .eml for traceability and manual
// reprocessing, then turned into a new ticket or a comment on an existing ticket.
const crypto = require('crypto');
// The database module is loaded lazily so the pure helpers below can be unit-tested without a database driver.
const dbm = () => require('../db');
const settings = require('../lib/settings');
const storage = require('../lib/storage');
const tickets = require('./tickets');
const notifications = require('./notifications');

const KEEP_HEADERS = ['from', 'to', 'cc', 'subject', 'date', 'message-id', 'in-reply-to', 'references', 'reply-to', 'return-path',
  'received-spf', 'authentication-results', 'x-mailer', 'auto-submitted', 'precedence', 'x-auto-response-suppress', 'list-id', 'x-itsm-notification'];

// ---------------------------------------------------------------- pure helpers (unit tested)
function headerMap(parsed) {
  const out = {};
  for (const k of KEEP_HEADERS) {
    const v = parsed.headers && parsed.headers.get(k);
    if (v === undefined || v === null) continue;
    out[k] = (typeof v === 'string' ? v : (v.text || v.value ? (v.text || JSON.stringify(v.value)) : String(v))).slice(0, 2000);
  }
  return out;
}

/** True for automatic replies, bulk mail, bounces and our own notifications (EMAIL-007 loop protection). */
function isAutomated(headers, fromAddr, ownAddresses = []) {
  const h = headers || {};
  const auto = String(h['auto-submitted'] || '').toLowerCase();
  if (auto && auto !== 'no') return 'automatic reply';
  if (/^(bulk|junk|list|auto_reply)$/i.test(String(h.precedence || '').trim())) return 'bulk mail';
  if (h['x-auto-response-suppress']) return 'automatic reply';
  if (h['x-itsm-notification']) return 'our own notification';
  if (h['list-id']) return 'mailing list';
  const from = String(fromAddr || '').toLowerCase();
  if (/^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounce[s]?)(\+|@|-)/.test(from) || /^(no-?reply|mailer-daemon|postmaster)@/.test(from)) return 'no-reply sender';
  if (ownAddresses.map((a) => String(a).toLowerCase()).includes(from)) return 'sent from a service desk mailbox';
  return null;
}

/** SPF / DKIM / DMARC failure reported by the receiving mail server: do not trust the From address. */
function authFailed(headers) {
  const a = String((headers || {})['authentication-results'] || '') + ' ' + String((headers || {})['received-spf'] || '');
  return /\b(dkim|spf|dmarc)=(fail|softfail|permerror)\b/i.test(a) || /^\s*fail\b/i.test(String((headers || {})['received-spf'] || ''));
}

function extractRef(subject) {
  const m = /\b(INC|REQ)-(\d{6})\b/i.exec(String(subject || ''));
  return m ? `${m[1].toUpperCase()}-${m[2]}` : null;
}

function cleanSubject(subject) {
  return String(subject || '(no subject)').replace(/^\s*((re|fw|fwd|aw|sv)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim() || '(no subject)';
}

function stripQuoted(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    if (/^On .{5,200} wrote:\s*$/i.test(line) || /^-{2,}\s*(original message|forwarded message)/i.test(line)
      || /^_{5,}\s*$/.test(line) || /^From:\s.+@.+/i.test(line) && out.length > 0 && out[out.length - 1].trim() === '') break;
    if (/^\s*>/.test(line)) continue;
    out.push(line);
  }
  const result = out.join('\n').trim();
  return result || String(text || '').trim();
}

function bodyText(parsed) {
  let t = parsed.text;
  if (!t && parsed.html) t = String(parsed.html).replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/p>/gi, '\n').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  return String(t || '').replace(/[ \t]+\n/g, '\n').slice(0, 20000);
}

// ---------------------------------------------------------------- recording
function parseMail(raw) {
  const { simpleParser } = require('mailparser');
  return simpleParser(raw);
}

/** Record a message exactly once, then process it. Returns { duplicate } or the processing outcome. */
async function ingest(mailbox, raw, imapUid = null) {
  const parsed = await parseMail(raw);
  const providerId = (parsed.messageId || '').trim() || `sha256:${crypto.createHash('sha256').update(raw).digest('hex')}`;
  const from = (parsed.from && parsed.from.value && parsed.from.value[0]) || {};
  const to = parsed.to && parsed.to.text ? parsed.to.text : '';
  const rawName = await storage.saveRaw(raw);
  const ins = await dbm().pool.query(
    `insert into inbound_messages (mailbox_id, provider_message_id, imap_uid, from_addr, from_name, to_addr, subject, sent_at, headers, raw_name)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (mailbox_id, provider_message_id) do nothing returning id`,
    [mailbox.id, providerId.slice(0, 500), imapUid, String(from.address || '').toLowerCase().slice(0, 320), String(from.name || '').slice(0, 200),
      to.slice(0, 500), String(parsed.subject || '').slice(0, 500), parsed.date || null, JSON.stringify(headerMap(parsed)), rawName]);
  if (!ins.rows.length) {
    await require('fs/promises').unlink(require('path').join(storage.dirs.mail, rawName)).catch(() => {});
    return { duplicate: true };   // EMAIL-009: the same message never creates a second ticket
  }
  return processMessage(ins.rows[0].id, parsed);
}

// ---------------------------------------------------------------- processing
async function processMessage(messageId, parsedOverride = null) {
  const row = (await dbm().pool.query('select * from inbound_messages where id = $1', [messageId])).rows[0];
  if (!row) return { outcome: 'failed', detail: 'message not found' };
  const parsed = parsedOverride || await parseMail(await storage.readRaw(row.raw_name));
  try {
    const result = await dbm().tx((db) => handle(db, row, parsed));
    await dbm().pool.query(
      `update inbound_messages set outcome = $2, ticket_id = $3, detail = $4, processed_at = now(), attempts = attempts + 1 where id = $1`,
      [row.id, result.outcome, result.ticketId || null, String(result.detail || '').slice(0, 500)]);
    return result;
  } catch (err) {
    console.error('[inbound] processing failed for message', row.id, err.message);
    await dbm().pool.query(`update inbound_messages set outcome = 'failed', detail = $2, attempts = attempts + 1 where id = $1`, [row.id, String(err.message).slice(0, 500)]);
    return { outcome: 'failed', detail: err.message };
  }
}

async function handle(db, row, parsed) {
  const mailbox = (await db.query('select * from mailboxes where id = $1', [row.mailbox_id])).rows[0];
  const own = (await db.query('select address from mailboxes')).rows.map((r) => r.address);
  const headers = row.headers || {};
  const sender = row.from_addr;
  if (!sender) return { outcome: 'rejected', detail: 'message has no sender address' };

  const automated = isAutomated(headers, sender, own);
  if (automated) return { outcome: 'ignored', detail: `Ignored: ${automated}` };

  const st = await settings.getAll(db, ['attachment_blocked_ext', 'attachment_max_mb', 'email_ack_per_sender_per_hour', 'reopen_window_days']);
  const text = bodyText(parsed);
  const suspicious = authFailed(headers);

  // Who is the sender? (EMAIL-005) Only an exact match to a registered, active user is trusted.
  const person = suspicious ? null : (await db.query(
    `select u.id, u.name, u.email, u.kind, u.role, u.customer_id, c.status as customer_status
       from users u left join customers c on c.id = u.customer_id
      where lower(u.email) = $1 and u.active`, [sender])).rows[0] || null;
  const trusted = person && (person.kind === 'staff' || person.customer_status === 'active') ? person : null;

  // Is it a reply? Match on our own message ids first, then on a ticket reference in the subject (EMAIL-006).
  let ticket = null;
  const refIds = [headers['in-reply-to'], headers.references].filter(Boolean).join(' ').match(/<[^>]+>/g) || [];
  if (refIds.length) {
    const t = await db.query(
      `select ticket_id from notifications where message_id = any($1) and ticket_id is not null
       union select ticket_id from inbound_messages where provider_message_id = any($1) and ticket_id is not null limit 1`, [refIds]);
    if (t.rows[0]) ticket = await tickets.summary(db, t.rows[0].ticket_id);
  }
  if (!ticket) {
    const ref = extractRef(row.subject);
    if (ref) {
      const t = await db.query('select id from tickets where ref = $1', [ref]);
      if (t.rows[0]) ticket = await tickets.summary(db, t.rows[0].id);
    }
  }

  const maxBytes = Math.min(Number(st.attachment_max_mb || 10), mailbox.max_attachment_mb || 10) * 1048576;
  const blocked = st.attachment_blocked_ext || [];

  // ---- reply to an existing ticket, only from someone allowed to write to it
  if (ticket && trusted) {
    const allowed = trusted.kind === 'staff'
      ? (ticket.queue !== 'security' || require('../lib/perms').can(trusted, 'security.view'))
      : (trusted.customer_id === ticket.customer_id && (trusted.role === 'customer_admin' || trusted.id === ticket.requester_id));
    if (allowed) {
      const stripped = stripQuoted(text);
      let t = await tickets.addComment(db, ticket, {
        author: trusted, authorLabel: row.from_name || trusted.name, body: stripped || '(empty message)',
        internal: false, source: 'email', messageId: row.provider_message_id,
      });
      await saveAttachments(db, parsed, t, trusted, { maxBytes, blocked });
      if (['resolved', 'closed'].includes(t.status) && trusted.kind === 'customer') {
        try { await tickets.setStatus(db, t, 'open', trusted); } catch (e) {
          if (!(e instanceof tickets.UserError)) throw e;
          await tickets.event(db, t.id, null, 'email', `A reply arrived after the reopen period: ${e.userMessage}`, true);
        }
      }
      return { outcome: 'reply_appended', ticketId: ticket.id, detail: `Appended to ${ticket.ref}` };
    }
  }

  // ---- otherwise a new ticket
  let customerId = null; let csidId = null; let serviceId = null; let requester = null; let needsVerification = true;
  if (trusted && trusted.kind === 'customer') {
    customerId = trusted.customer_id; requester = trusted; needsVerification = false;
    const cs = (await db.query(`select id from csids where customer_id = $1 and status = 'active'`, [customerId])).rows;
    if (cs.length === 1) {
      csidId = cs[0].id;
      const sv = (await db.query(`select id from services where csid_id = $1 and customer_id = $2 and status = 'active'`, [csidId, customerId])).rows;
      if (sv.length === 1) serviceId = sv[0].id;
    }
  }
  const prefix = ticket ? `[Possible reply to ${ticket.ref} from an unrecognised sender] ` : '';
  let description = text;
  if (needsVerification) {
    description = `${prefix}From: ${row.from_name ? row.from_name + ' ' : ''}<${sender}>${suspicious ? '\nNote: the mail server reported a failed sender check (SPF/DKIM/DMARC).' : ''}\n\n${text}`;
  }
  const created = await tickets.createTicket(db, {
    type: 'incident', queue: mailbox.queue, tier: mailbox.tier, customerId, csidId, serviceId,
    requester: requester ? { id: requester.id, email: requester.email, name: requester.name } : { email: sender, name: row.from_name || sender },
    subject: cleanSubject(row.subject), description, category: mailbox.category, impact: 2, urgency: 2,
    priority: mailbox.default_priority, source: 'email', mailboxId: mailbox.id, mailboxPolicyId: mailbox.sla_policy_id,
    needsVerification, enforceActive: false,
  });
  await saveAttachments(db, parsed, created, requester, { maxBytes, blocked });
  await tickets.event(db, created.id, null, 'email',
    `Created from e-mail received by the ${mailbox.name || mailbox.key} mailbox. Original subject: "${String(row.subject).slice(0, 150)}".`, true);

  if (needsVerification) {
    for (const s of await notifications.supervisors(db, mailbox.queue)) {
      await notifications.enqueue(db, {
        kind: 'verification_needed', ticketId: created.id, to: s, dedupeKey: `verify:${created.id}:${s.id}`,
        subject: `[${created.ref}] E-mail from an unverified sender needs review`,
        body: `An e-mail from ${sender} arrived in the ${mailbox.name || mailbox.key} mailbox. The sender could not be matched to a registered customer contact.\nReview it in the verification queue: ${require('../config').baseUrl}/verification\n`,
      });
    }
  }
  await sendAck(db, created, row, st, mailbox, needsVerification);
  return { outcome: needsVerification ? 'verification' : 'ticket_created', ticketId: created.id, detail: `Created ${created.ref}` };
}

async function sendAck(db, ticket, row, st, mailbox, needsVerification) {
  const limit = Number(st.email_ack_per_sender_per_hour || 3);
  const recent = await db.query(
    `select count(*)::int as n from notifications where kind = 'email_ack' and lower(recipient_email) = $1 and created_at > now() - interval '1 hour'`, [row.from_addr]);
  if (recent.rows[0].n >= limit) return; // loop / flood safeguard
  const body = needsVerification
    ? `Thank you. We received your message and logged it as ${ticket.ref}.\nBefore we can act on it we need to confirm who you are, and a member of our team will review it shortly.\nPlease keep ${ticket.ref} in the subject line of any reply.\n`
    : `Thank you. We received your message and logged it as ${ticket.ref}.\nYour priority is ${require('../lib/priority').LABELS[ticket.priority]}. You can follow progress in the customer portal: ${notifications.link({ kind: 'customer' }, ticket.ref)}\nTo add information, reply to this message and keep ${ticket.ref} in the subject line.\n`;
  await notifications.enqueue(db, {
    kind: 'email_ack', ticketId: ticket.id, to: { email: row.from_addr, name: row.from_name }, replyTo: mailbox.address,
    dedupeKey: `ack:${ticket.id}`, subject: `[${ticket.ref}] We received your request: ${cleanSubject(row.subject)}`.slice(0, 200), body,
  });
}

async function saveAttachments(db, parsed, ticket, user, { maxBytes, blocked }) {
  for (const a of parsed.attachments || []) {
    if (!a.content || !a.filename) continue;
    const r = await storage.storeFile({ buffer: a.content, filename: a.filename, mime: a.contentType, maxBytes, blockedExt: blocked });
    if (r.rejected) {
      await tickets.event(db, ticket.id, null, 'attachment', `Attachment "${storage.safeName(a.filename)}" was not kept: ${r.rejected}.`, true);
      continue;
    }
    await db.query(
      `insert into attachments (ticket_id, customer_id, filename, mime, size_bytes, sha256, storage_name, scan_status, uploaded_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [ticket.id, ticket.customer_id, r.filename, r.mime, r.size_bytes, r.sha256, r.storage_name, r.scan_status, user ? user.id : null]);
  }
}

/** Authorised manual reprocess of a failed / ignored / rejected message (EMAIL-010). */
async function reprocess(messageId) {
  const row = (await dbm().pool.query('select outcome from inbound_messages where id = $1', [messageId])).rows[0];
  if (!row) throw new tickets.UserError('Message not found.', 404);
  if (!['failed', 'ignored', 'rejected'].includes(row.outcome)) throw new tickets.UserError('Only failed, ignored or rejected messages can be reprocessed.');
  return processMessage(messageId);
}

/** Re-run messages that failed (for example because the database was briefly unavailable). */
async function retryFailed() {
  const r = await dbm().pool.query(`select id from inbound_messages where outcome = 'failed' and attempts < 3 order by id limit 20`);
  for (const { id } of r.rows) await processMessage(id);
  return r.rows.length;
}

// ---------------------------------------------------------------- mailbox sync (providers: IMAP, Microsoft 365 Graph, Gmail)
// A provider fetches raw RFC 822 messages; everything after that (recording once, threading, spoofing checks, tickets) is the same code.
const providers = require('./providers');
const poison = new Map();       // "mailboxId:ref" -> failed attempts in this worker run

function scrub(err, secrets) {
  let m = String((err && err.message) || err || 'unknown error');
  for (const s of secrets || []) if (s) m = m.split(s).join('***');
  return m.slice(0, 400);
}

async function markFailure(mailbox, status, message) {
  await dbm().pool.query(
    `update mailboxes set last_sync_at = now(), last_status = $2, last_error = $3, consecutive_failures = consecutive_failures + 1 where id = $1`,
    [mailbox.id, status, message]);
}

/** A message that fails three times in a row is stored as "failed" and skipped, so one bad mail cannot block the whole mailbox. */
async function quarantine(mailbox, raw, ref, uid, err) {
  const rawName = await storage.saveRaw(raw);
  await dbm().pool.query(
    `insert into inbound_messages (mailbox_id, provider_message_id, imap_uid, subject, raw_name, outcome, detail, attempts)
     values ($1,$2,$3,'(could not be read)',$4,'failed',$5,3) on conflict (mailbox_id, provider_message_id) do nothing`,
    [mailbox.id, `quarantine:${mailbox.id}:${ref}`.slice(0, 500), uid || null, rawName, String(err.message || err).slice(0, 300)]);
}

/** Used by the providers: ingest one message; retry on the next check twice, then quarantine it. */
async function ingestSafe(mailbox, raw, { ref, uid = null }) {
  const key = `${mailbox.id}:${ref}`;
  try { await ingest(mailbox, raw, uid); poison.delete(key); } catch (err) {
    const n = (poison.get(key) || 0) + 1; poison.set(key, n);
    if (n < 3) throw err;
    await quarantine(mailbox, raw, ref, uid, err);
    poison.delete(key);
  }
}

async function seen(mailbox, providerMessageId) {
  const r = await dbm().pool.query('select 1 from inbound_messages where mailbox_id = $1 and provider_message_id = $2', [mailbox.id, String(providerMessageId).slice(0, 500)]);
  return r.rows.length > 0;
}

function context(overrides = {}) {
  return { pool: dbm().pool, fetch: globalThis.fetch, env: process.env, ingestSafe, seen, ...overrides };
}

async function syncMailbox(mailbox, ctxOverrides = {}) {
  const p = providers.get(mailbox.provider);
  const ctx = context(ctxOverrides);
  const secrets = p.secrets(mailbox, ctx.env);
  const bad = p.configError(mailbox, ctx.env);
  if (bad) { await markFailure(mailbox, 'not configured', bad); return 0; }
  try {
    const count = await p.poll(mailbox, ctx);
    await ctx.pool.query(
      `update mailboxes set last_sync_at = now(), last_success_at = now(), last_status = 'ok', last_error = '', consecutive_failures = 0 where id = $1`, [mailbox.id]);
    return count;
  } catch (err) {
    const msg = scrub(err, secrets);
    await markFailure(mailbox, 'error', msg);
    console.error(`[mail] ${mailbox.key}: ${msg}`);
    return 0;
  }
}

/** "Test connection" on the E-mail page: sign in and look, without reading any mail into the system. */
async function testConnection(mailbox, ctxOverrides = {}) {
  const p = providers.get(mailbox.provider);
  const ctx = context(ctxOverrides);
  const bad = p.configError(mailbox, ctx.env);
  if (bad) return { ok: false, message: bad };
  try { return await p.test(mailbox, ctx); } catch (err) { return { ok: false, message: scrub(err, p.secrets(mailbox, ctx.env)) }; }
}

module.exports = { isAutomated, authFailed, extractRef, cleanSubject, stripQuoted, bodyText, ingest, processMessage, reprocess, retryFailed, syncMailbox, testConnection };
