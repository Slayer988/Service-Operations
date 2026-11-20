'use strict';
// All outgoing e-mail goes through the notifications table (an outbox): every attempt is recorded,
// failures are retried with back-off, and a final failure alerts a supervisor (SLA-012, AUTO-004, REN-011).
const crypto = require('crypto');
const config = require('../config');
const mailer = require('../lib/mailer');
const outgoing = require('./outgoing');
const perms = require('../lib/perms');
const { URL } = require('url');

function domain() { try { return new URL(config.baseUrl).hostname; } catch (_) { return 'localhost'; } }
function newMessageId() { return `<${crypto.randomBytes(12).toString('hex')}@${domain()}>`; }

function link(user, ref) {
  if (user && user.kind === 'customer') return `${config.baseUrl}/portal/tickets/${ref}`;
  return `${config.baseUrl}/tickets/${ref}`;
}

/**
 * Queue one e-mail. `to` is { id?, email, name?, kind?, role? }. dedupeKey makes a repeat a no-op (REN-011, AUTO-005).
 * Returns the new row id, or null when the key already existed.
 */
async function enqueue(db, { kind, ticketId = null, renewalId = null, tenderId = null, contractId = null, opportunityId = null, to, subject, body, dedupeKey = null, inReplyTo = null, replyTo = null, maxAttempts = 5 }) {
  if (!to || !to.email) return null;
  const r = await db.query(
    `insert into notifications (kind, ticket_id, renewal_id, tender_id, contract_id, opportunity_id, recipient_user_id, recipient_email, subject, body,
                                message_id, in_reply_to, reply_to, dedupe_key, max_attempts)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     on conflict (dedupe_key) do nothing returning id`,
    [kind, ticketId, renewalId, tenderId, contractId, opportunityId, to.id || null, to.email, subject.slice(0, 300), body, newMessageId(), inReplyTo, replyTo, dedupeKey, maxAttempts],
  );
  return r.rows.length ? r.rows[0].id : null;
}

/** Staff who supervise: service managers and platform administrators (security tickets: only those with security access). */
async function supervisors(db, queue = 'it_services') {
  const r = await db.query(
    `select id, email, name, kind, role from users
      where kind = 'staff' and active and role in ('service_manager','platform_admin')`,
  );
  return r.rows.filter((u) => queue !== 'security' || perms.can(u, 'security.view'));
}

/** The address customers should reply to: the mailbox the ticket came in through, else the first enabled mailbox of the queue. */
async function replyAddress(db, queue, mailboxId = null) {
  if (mailboxId) {
    const m = await db.query('select address from mailboxes where id = $1 and enabled', [mailboxId]);
    if (m.rows[0]) return m.rows[0].address;
  }
  const r = await db.query('select address from mailboxes where queue = $1 and enabled order by id limit 1', [queue]);
  return r.rows[0] ? r.rows[0].address : null;
}

const HOLD_DAYS = 7;          // how long a message waits for a mail server before it is given up on
let lastHoldNote = 0;

/** Pick up due messages, send them, record the outcome. Returns how many were attempted.
 *  With no mail server set up nothing is attempted: the messages stay waiting (and are sent once a server is saved), so they are never
 *  recorded as sent when nobody received them. Messages that waited longer than HOLD_DAYS are marked failed. */
async function processDue(db, limit = 20) {
  if ((await outgoing.effective(db)).source === 'none') {
    await db.query(`update notifications set status = 'failed', last_error = $1 where status = 'pending' and created_at < now() - ($2 || ' days')::interval`,
      [`No mail server was set up within ${HOLD_DAYS} days, so this message was never sent.`, String(HOLD_DAYS)]);
    if (Date.now() - lastHoldNote > 3600000) {
      lastHoldNote = Date.now();
      const n = (await db.query(`select count(*)::int as n from notifications where status = 'pending'`)).rows[0].n;
      if (n) console.log(`[mail:waiting] ${n} message(s) are waiting: outgoing mail is not set up (Administration > E-mail). They are sent as soon as a mail server is saved.`);
    }
    return 0;
  }
  // Claim rows first (push next_attempt_at out) so a crash cannot cause a tight retry loop, then send outside the lock.
  const claimed = await db.query(
    `update notifications set next_attempt_at = now() + interval '5 minutes'
      where id in (select id from notifications where status = 'pending' and next_attempt_at <= now()
                    order by id limit $1 for update skip locked)
      returning *`,
    [limit],
  );
  for (const n of claimed.rows) {
    try {
      const out = await mailer.send({ to: n.recipient_email, subject: n.subject, text: n.body, messageId: n.message_id, inReplyTo: n.in_reply_to, replyTo: n.reply_to });
      if (out && out.logged) {         // the mail server was removed while this ran: keep the message waiting, do not call it sent
        await db.query(`update notifications set next_attempt_at = now() + interval '10 minutes' where id = $1`, [n.id]);
        continue;
      }
      await db.query(`update notifications set status = 'sent', attempts = attempts + 1, sent_at = now(), last_error = '' where id = $1`, [n.id]);
    } catch (err) {
      const attempts = n.attempts + 1;
      const final = attempts >= n.max_attempts;
      await db.query(
        `update notifications set attempts = $2, last_error = $3, status = $4,
                next_attempt_at = now() + ($5 || ' minutes')::interval where id = $1`,
        [n.id, attempts, String(err.message).slice(0, 500), final ? 'failed' : 'pending', String(Math.min(60, 2 ** attempts))],
      );
      // Never raise an alert about a failed alert: that would loop when the mail server is down.
      if (final && n.kind !== 'notification_failed') await alertFailure(db, n, err);
    }
  }
  return claimed.rows.length;
}

async function alertFailure(db, n, err) {
  let queue = 'it_services';
  let ref = '';
  if (n.ticket_id) {
    const t = await db.query('select ref, queue from tickets where id = $1', [n.ticket_id]);
    if (t.rows[0]) { queue = t.rows[0].queue; ref = t.rows[0].ref; }
    await db.query(
      `insert into ticket_events (ticket_id, kind, text, internal) values ($1,'notification_failed',$2,true)`,
      [n.ticket_id, `Notification "${n.kind}" to ${n.recipient_email} failed after ${n.attempts + 1} attempts: ${String(err.message).slice(0, 200)}`],
    );
  }
  for (const s of await supervisors(db, queue)) {
    await enqueue(db, {
      kind: 'notification_failed', ticketId: n.ticket_id, to: s, dedupeKey: `failed:${n.id}:${s.id}`,
      subject: `Notification could not be delivered${ref ? ` (${ref})` : ''}`,
      body: `A "${n.kind}" e-mail to ${n.recipient_email} could not be delivered after several attempts.\nReason: ${String(err.message).slice(0, 200)}\n${ref ? `Ticket: ${link(s, ref)}\n` : ''}Please contact the recipient another way and check the mail settings.`,
    });
  }
}

module.exports = { enqueue, supervisors, processDue, link, newMessageId, replyAddress };
