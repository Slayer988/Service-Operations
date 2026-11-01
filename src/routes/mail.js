'use strict';
// Shared mailboxes, processed messages and the outgoing notification log (EMAIL-004, EMAIL-010, EMAIL-013, SLA-012).
const express = require('express');
const { q } = require('../db');
const perms = require('../lib/perms');
const audit = require('../lib/audit');
const u = require('../lib/util');
const tickets = require('../services/tickets');
const inbound = require('../services/inbound');
const mailhealth = require('../services/mailhealth');
const providers = require('../services/providers');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();

function visibleMailboxClause(user) { return perms.can(user, 'security.view') ? 'true' : `mb.queue <> 'security'`; }

router.get('/mail', requireStaff, requirePerm('mail.view'), wrap(async (req, res) => {
  const mailboxes = (await q(`select mb.*, p.name as policy_name from mailboxes mb left join sla_policies p on p.id = mb.sla_policy_id where ${visibleMailboxClause(req.user)} order by mb.id`)).rows;
  const params = []; const where = [visibleMailboxClause(req.user)];
  const outcome = u.oneOf(req.query.outcome, ['pending', 'ticket_created', 'reply_appended', 'verification', 'ignored', 'rejected', 'failed']);
  if (outcome) { params.push(outcome); where.push(`m.outcome = $${params.length}`); }
  const messages = (await q(
    `select m.id, m.received_at, m.from_addr, m.subject, m.outcome, m.detail, m.attempts, mb.key as mailbox_key, t.ref as ticket_ref
       from inbound_messages m join mailboxes mb on mb.id = m.mailbox_id left join tickets t on t.id = m.ticket_id
      where ${where.join(' and ')} order by m.id desc limit 100`, params)).rows;
  const policies = (await q('select id, name from sla_policies where active order by name')).rows;
  const notifications = perms.can(req.user, 'mail.manage')
    ? (await q(`select id, kind, recipient_email, subject, status, attempts, last_error, created_at, sent_at from notifications order by id desc limit 60`)).rows : [];
  const stats = Object.fromEntries((await q(
    `select mailbox_id, count(*) filter (where received_at > now() - interval '24 hours')::int as n24, max(received_at) as last_at from inbound_messages group by mailbox_id`)).rows.map((r) => [r.mailbox_id, r]));
  const health = Object.fromEntries(mailboxes.map((m) => [m.id, mailhealth.assess(m)]));
  const secretsConfigured = Object.fromEntries(mailboxes.map((m) => [m.id, !!(m.secret_env && process.env[m.secret_env])]));
  res.render('staff/mail', { title: 'Mailboxes and e-mail', providerList: providers.names, providerLabels: Object.fromEntries(Object.entries(providers.providers).map(([k, v]) => [k, v.label])), maxMailboxes: MAX_MAILBOXES, mailboxes, messages, policies, notifications, outcome: outcome || '', secretsConfigured, stats, health, canManage: perms.can(req.user, 'mail.manage') });
}));

router.get('/mail/messages/:id', requireStaff, requirePerm('mail.view'), wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const m = id ? (await q(`select m.*, mb.key as mailbox_key, mb.queue, t.ref as ticket_ref from inbound_messages m join mailboxes mb on mb.id = m.mailbox_id left join tickets t on t.id = m.ticket_id where m.id = $1`, [id])).rows[0] : null;
  if (!m || (m.queue === 'security' && !perms.can(req.user, 'security.view'))) return res.status(404).render('error', { title: 'Not found', message: 'Not found.' });
  if (m.queue === 'security') await audit({ query: q }, req.user, 'security_mail_viewed', 'inbound_message', m.id, '', null, req.ip);
  return res.render('staff/mail_message', { title: 'Message', m });
}));

router.post('/mail/messages/:id/reprocess', requireStaff, requirePerm('mail.view'), wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const m = id ? (await q('select mb.queue from inbound_messages m join mailboxes mb on mb.id = m.mailbox_id where m.id = $1', [id])).rows[0] : null;
  if (!m || (m.queue === 'security' && !perms.can(req.user, 'security.view'))) return res.status(404).render('error', { title: 'Not found', message: 'Not found.' });
  const r = await inbound.reprocess(id);
  await audit({ query: q }, req.user, 'mail_reprocessed', 'inbound_message', id, r.outcome, null, req.ip);
  req.flash(r.outcome === 'failed' ? 'error' : 'success', `Reprocessed: ${r.outcome}. ${r.detail || ''}`);
  res.redirect('/mail');
}));

const MAX_MAILBOXES = 5;
const PROVIDERS = providers.names;

function dbFailure(err) {
  if (err.code === '23505') return new tickets.UserError('Another mailbox already uses that address or name.');
  if (err.code === '23514' && /At most 5/.test(err.message)) return new tickets.UserError(`At most ${MAX_MAILBOXES} shared mailboxes are supported. Remove one first.`);
  return err;
}

function slug(name) {
  const base = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').replace(/^[^a-z]+/, '').slice(0, 24);
  return base.length >= 2 ? base : 'mailbox';
}

router.post('/mail/mailboxes', requireStaff, requirePerm('mail.manage'), wrap(async (req, res) => {
  const b = req.body;
  const name = u.str(b.name, 40); const address = u.email(b.address);
  const provider = u.oneOf(b.provider, PROVIDERS); const queue = u.oneOf(b.queue, ['it_services', 'security']);
  if (!name || !address || !provider || !queue) throw new tickets.UserError('Enter a name, the mailbox address, the provider and the team (queue).');
  let key = slug(name);
  for (let i = 2; (await q('select 1 from mailboxes where key = $1', [key])).rows.length; i++) key = `${slug(name).slice(0, 26)}_${i}`;
  try {
    await q(`insert into mailboxes (key, name, address, queue, category, provider, imap_port) values ($1,$2,$3,$4,$5,$6,993)`, [key, name, address, queue, queue === 'security' ? 'Security' : 'General', provider]);
  } catch (err) { throw dbFailure(err); }
  await audit({ query: q }, req.user, 'mailbox_added', 'mailbox', key, `${address} via ${provider}`, null, req.ip);
  req.flash('success', 'Mailbox added (switched off). Fill in its connection details, test it, then enable it.');
  res.redirect(`/mail#mb-${key}`);
}));

router.post('/mail/mailboxes/:id', requireStaff, requirePerm('mail.manage'), wrap(async (req, res) => {
  const id = u.id(req.params.id); const b = req.body;
  const before = id ? (await q('select * from mailboxes where id = $1', [id])).rows[0] : null;
  if (!before) return res.status(404).render('error', { title: 'Not found', message: 'Not found.' });
  const name = u.str(b.name, 40) || before.name;
  const address = u.email(b.address);
  if (!address) throw new tickets.UserError('Enter the mailbox address.');
  const provider = u.oneOf(b.provider, PROVIDERS, before.provider);
  const queue = u.oneOf(b.queue, ['it_services', 'security'], before.queue);
  const secretEnv = u.str(b.secret_env, 64);
  if (secretEnv && !/^[A-Z][A-Z0-9_]{2,63}$/.test(secretEnv)) throw new tickets.UserError('The variable name must be capital letters, digits and underscores, for example MAILBOX_SECURITY_PASSWORD.');
  const tenant = u.str(b.tenant_id, 100); const client = u.str(b.client_id, 60);
  if (tenant && !/^[A-Za-z0-9.-]{3,100}$/.test(tenant)) throw new tickets.UserError('The Microsoft tenant ID is a GUID (or your .onmicrosoft.com domain).');
  if (client && !/^[0-9a-fA-F-]{36}$/.test(client)) throw new tickets.UserError('The application (client) ID is a GUID such as 11111111-2222-3333-4444-555555555555.');
  const folder = u.str(b.imap_folder, 100) || 'INBOX';
  if (!/^[A-Za-z0-9 ._/&-]{1,100}$/.test(folder)) throw new tickets.UserError('The folder name may contain letters, digits, spaces and . _ / - only.');
  // A different account or folder is a different message stream: start again from "unread mail of the last two days".
  const restart = provider !== before.provider || address.toLowerCase() !== before.address.toLowerCase() || folder !== before.imap_folder
    || tenant !== before.tenant_id || client !== before.client_id || u.str(b.imap_host, 200) !== before.imap_host || u.str(b.imap_user, 200) !== before.imap_user;
  let r;
  try {
    r = await q(
      `update mailboxes set name = $2, address = $3, category = $4, default_priority = $5, tier = $6, sla_policy_id = $7, imap_host = $8, imap_port = $9, imap_tls = $10,
              imap_user = $11, secret_env = $12, poll_seconds = $13, max_attachment_mb = $14, enabled = $15, imap_folder = $16, mark_seen = $17, stale_minutes = $18,
              provider = $19, tenant_id = $20, client_id = $21, queue = $22,
              last_uid = case when $23 then null else last_uid end, uid_validity = case when $23 then null else uid_validity end,
              last_received_at = case when $23 then null else last_received_at end,
              consecutive_failures = case when $23 then 0 else consecutive_failures end
        where id = $1 returning key`,
      [id, name, address, u.str(b.category, 60) || 'General', u.intIn(b.default_priority, 1, 4) || 3, u.oneOf(b.tier, ['l1', 'l2', 'l3'], 'l1'), u.id(b.sla_policy_id),
        u.str(b.imap_host, 200), u.intIn(b.imap_port, 1, 65535) || 993, b.imap_tls === 'on', u.str(b.imap_user, 200), secretEnv,
        u.intIn(b.poll_seconds, 30, 3600) || 60, u.intIn(b.max_attachment_mb, 1, 25) || 10, b.enabled === 'on', folder, b.mark_seen === 'on',
        u.intIn(b.stale_minutes, 2, 1440) || 15, provider, tenant, client, queue, restart]);
  } catch (err) { throw dbFailure(err); }
  await audit({ query: q }, req.user, 'mailbox_updated', 'mailbox', r.rows[0].key, `${provider}, enabled=${b.enabled === 'on'}`, null, req.ip);
  req.flash('success', 'Mailbox settings saved. Passwords, secrets and key files are never stored here: they are read from the server environment file.');
  res.redirect(`/mail#mb-${r.rows[0].key}`);
}));

router.post('/mail/mailboxes/:id/delete', requireStaff, requirePerm('mail.manage'), wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const mb = id ? (await q('select * from mailboxes where id = $1', [id])).rows[0] : null;
  if (!mb) return res.status(404).render('error', { title: 'Not found', message: 'Not found.' });
  const used = (await q(`select (select count(*) from inbound_messages where mailbox_id = $1)::int as m, (select count(*) from tickets where mailbox_id = $1)::int as t`, [id])).rows[0];
  if (used.m || used.t) throw new tickets.UserError(`This mailbox has ${used.m} recorded message(s) and ${used.t} ticket(s), so it cannot be deleted (the history must stay). Untick "Enabled" to stop reading it.`);
  await q('delete from mailboxes where id = $1', [id]);
  await audit({ query: q }, req.user, 'mailbox_deleted', 'mailbox', mb.key, mb.address, null, req.ip);
  req.flash('success', 'Mailbox removed.');
  res.redirect('/mail');
}));

router.post('/mail/mailboxes/:id/test', requireStaff, requirePerm('mail.manage'), wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const mb = id ? (await q('select * from mailboxes where id = $1', [id])).rows[0] : null;
  if (!mb) return res.status(404).render('error', { title: 'Not found', message: 'Not found.' });
  const r = await inbound.testConnection(mb);
  await audit({ query: q }, req.user, 'mailbox_tested', 'mailbox', mb.key, r.ok ? 'ok' : 'failed', null, req.ip);
  req.flash(r.ok ? 'success' : 'error', `${mb.name}: ${r.message}`);
  res.redirect('/mail');
}));

router.post('/mail/notifications/:id/retry', requireStaff, requirePerm('mail.manage'), wrap(async (req, res) => {
  await q(`update notifications set status = 'pending', attempts = 0, next_attempt_at = now(), last_error = '' where id = $1 and status = 'failed'`, [u.id(req.params.id)]);
  await audit({ query: q }, req.user, 'notification_retry', 'notification', req.params.id, '', null, req.ip);
  res.redirect('/mail');
}));

module.exports = router;
