'use strict';
// Daily housekeeping run by the worker: keep records no longer than the retention settings say, check that the audit log has not been
// altered, and encrypt any two-step secrets saved by an earlier version. Everything here is safe to run again at any time.
const { tx } = require('../db');
const settings = require('../lib/settings');
const storage = require('../lib/storage');
const audit = require('../lib/audit');
const twofactor = require('../lib/twofactor');
const notifications = require('./notifications');

/** Delete finished e-mail notifications older than the limit. 0 keeps them for ever. Waiting messages are never touched. */
async function purgeNotifications(db, days) {
  if (!(days > 0)) return 0;
  const r = await db.query(`delete from notifications where status in ('sent','failed','cancelled') and created_at < now() - ($1 || ' days')::interval`, [String(days)]);
  return r.rowCount;
}

/** Delete closed and cancelled tickets older than the limit, with their comments, history, notifications, files and original e-mails.
 *  Works through 50 tickets at a time. 0 keeps them for ever. */
async function purgeTickets(years) {
  if (!(years > 0)) return 0;
  return tx(async (db) => {
    const ids = (await db.query(
      `select id from tickets where status in ('closed','cancelled') and coalesce(closed_at, updated_at) < now() - ($1 || ' years')::interval order by id limit 50 for update`, [String(years)])).rows.map((r) => r.id);
    if (!ids.length) return 0;
    const files = (await db.query('select storage_name from attachments where ticket_id = any($1)', [ids])).rows.map((r) => r.storage_name);
    const raws = (await db.query(`select raw_name from inbound_messages where ticket_id = any($1) and raw_name is not null and raw_name <> ''`, [ids])).rows.map((r) => r.raw_name);
    await db.query('delete from notifications where ticket_id = any($1)', [ids]);
    await db.query('delete from inbound_messages where ticket_id = any($1)', [ids]);
    await db.query('delete from attachments where ticket_id = any($1)', [ids]);
    await db.query('delete from ticket_comments where ticket_id = any($1)', [ids]);
    await db.query('delete from ticket_events where ticket_id = any($1)', [ids]);
    await db.query('delete from tickets where id = any($1)', [ids]);
    await audit(db, null, 'retention_tickets_deleted', 'tickets', '', `${ids.length} closed ticket(s) older than ${years} year(s) were deleted`, null, '');
    for (const f of [...files, ...raws]) await storage.removeStored(f);          // after the rows are gone; a failed commit never loses a file
    return ids.length;
  });
}

/** Trim the oldest part of the audit log. The log can only be shortened from its old end (audit_purge keeps it checkable). */
async function purgeAudit(db, years) {
  if (!(years > 0)) return 0;
  const n = Number((await db.query(`select audit_purge(($1 || ' years')::interval) as n`, [String(years)])).rows[0].n);
  if (n) await audit(db, null, 'retention_audit_trimmed', 'audit_log', '', `${n} entr${n === 1 ? 'y' : 'ies'} older than ${years} year(s) were removed`, null, '');
  return n;
}

/** Walks the audit log's hash chain. Stores the result for the Audit log page and the health check; tells administrators once if it is broken. */
async function verifyAudit(db) {
  const bad = (await db.query('select audit_verify() as bad')).rows[0].bad;
  const result = { at: new Date().toISOString(), ok: bad === null, bad_id: bad === null ? null : Number(bad) };
  await settings.set(db, 'audit_verify', result);
  if (!result.ok) {
    console.error(`[audit] INTEGRITY CHECK FAILED: the audit log does not match its chain (${result.bad_id === -1 ? 'the newest entries are missing' : `first mismatch at entry ${result.bad_id}`}).`);
    const people = (await db.query(`select id, email, name, kind, role from users where kind = 'staff' and active and role in ('platform_admin','auditor')`)).rows;
    for (const u of people) {
      await notifications.enqueue(db, {
        kind: 'audit_integrity', to: u, dedupeKey: `auditbreak:${result.bad_id}:${u.id}`, subject: 'Audit log integrity check failed',
        body: `The daily check found that the audit log no longer matches its tamper-evident chain (${result.bad_id === -1 ? 'the newest entries are missing' : `first mismatch at entry ${result.bad_id}`}).\nThe log may have been altered or restored from a backup. Please investigate.\n`,
      });
    }
  }
  return result;
}

/** Secrets saved by an earlier version as plain text are encrypted. Returns how many. */
async function protectTotpSecrets(db) {
  const rows = (await db.query(`select id, totp_secret from users where totp_secret is not null and totp_secret <> '' and totp_secret not like 'v1:%'`)).rows;
  for (const r of rows) await db.query('update users set totp_secret = $2 where id = $1', [r.id, twofactor.protect(r.totp_secret)]);
  return rows.length;
}

/** The whole daily run. Each part is independent: one failing does not stop the others. */
async function daily(db) {
  const st = await settings.getAll(db, ['retention_notification_days', 'retention_audit_years', 'retention_ticket_years']);
  const out = {};
  const step = async (name, fn) => { try { out[name] = await fn(); } catch (err) { console.error(`[maintenance:${name}]`, err.message); out[name] = null; } };
  await step('totp_protected', () => protectTotpSecrets(db));
  await step('notifications', () => purgeNotifications(db, Number(st.retention_notification_days ?? 365)));
  await step('tickets', () => purgeTickets(Number(st.retention_ticket_years || 0)));
  await step('audit_trimmed', () => purgeAudit(db, Number(st.retention_audit_years || 0)));
  await step('audit_check', () => verifyAudit(db));
  return out;
}

module.exports = { daily, purgeNotifications, purgeTickets, purgeAudit, verifyAudit, protectTotpSecrets };
