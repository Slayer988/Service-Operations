'use strict';
// Service notices: major incidents and planned maintenance, shown to the customers affected (a banner on every portal page and the
// Service status page) and, when chosen, e-mailed to their contacts. Each notice has a running list of updates.
const audit = require('../lib/audit');
const u = require('../lib/util');
const tz = require('../lib/tz');
const config = require('../config');
const notifications = require('./notifications');
const { UserError } = require('./tickets');

const KINDS = { incident: 'Major incident', maintenance: 'Planned maintenance' };
const SEVERITIES = { outage: 'Service down', degraded: 'Degraded or slow', info: 'Information' };
const STATUS = {
  incident: { investigating: 'Investigating', identified: 'Cause identified', monitoring: 'Fixed, monitoring', resolved: 'Resolved' },
  maintenance: { scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', cancelled: 'Cancelled' },
};
const CLOSING = ['resolved', 'completed', 'cancelled'];
const label = (n) => (STATUS[n.kind] || {})[n.status] || n.status;

const when = (v) => { const s = String(v || '').trim(); if (!s) return null; return tz.localToDate(s, config.timezone) || undefined; };

function read(b, kind) {
  const v = { kind: u.oneOf(kind || b.kind, Object.keys(KINDS), 'incident'), title: u.str(b.title, 200), severity: u.oneOf(b.severity, Object.keys(SEVERITIES), 'degraded'),
    all_customers: b.all_customers === '1', customer_ids: [].concat(b.customer_ids || []).map((x) => u.id(x)).filter(Boolean).slice(0, 500),
    ticket_id: u.id(b.ticket_id) || null, change_id: u.id(b.change_id) || null, text: u.str(b.text, 4000), email: b.email === '1' };
  v.status = v.kind === 'incident' ? 'investigating' : 'scheduled';
  v.starts_at = when(b.starts_at); v.ends_at = when(b.ends_at);
  const errors = [];
  if (!v.title) errors.push('Give the notice a title customers will understand, for example "Internet access down at the head office".');
  if (!v.all_customers && !v.customer_ids.length) errors.push('Choose the customers affected (or tick "All customers").');
  if (!v.text) errors.push('Write the first message: what is happening and what customers should do.');
  if (v.starts_at === undefined || v.ends_at === undefined) errors.push('A date and time is not valid.');
  if (v.kind === 'maintenance' && (!v.starts_at || !v.ends_at)) errors.push('Planned maintenance needs its start and end.');
  if (v.starts_at && v.ends_at && v.ends_at <= v.starts_at) errors.push('The end must be after the start.');
  if (errors.length) throw new UserError(errors.join(' '));
  return v;
}

/** Contacts to e-mail: each affected customer's administrators (and, for an incident, the person who reported the linked ticket). */
async function recipients(db, n) {
  const rows = (await db.query(`select id, name, email, kind, role from users where kind = 'customer' and active and role = 'customer_admin' and ($1 or customer_id = any($2))`,
    [n.all_customers, n.customer_ids])).rows;
  if (n.ticket_id) { const t = (await db.query(`select u.id, u.name, u.email, u.kind, u.role from tickets t join users u on u.id = t.requester_id where t.id = $1 and u.active`, [n.ticket_id])).rows[0]; if (t) rows.push(t); }
  const seen = new Set(); return rows.filter((r) => r.email && !seen.has(r.email.toLowerCase()) && seen.add(r.email.toLowerCase()));
}

async function mail(db, n, update) {
  const to = await recipients(db, n);
  const times = n.kind === 'maintenance' ? `\nWhen: ${fmt(n.starts_at)} to ${fmt(n.ends_at)}.` : '';
  for (const r of to) {
    await notifications.enqueue(db, { kind: 'service_notice', to: r, dedupeKey: `notice-${n.id}-${update.id}-${r.email.toLowerCase()}`,
      subject: `[${n.ref}] ${KINDS[n.kind]}: ${n.title} (${label(n)})`,
      body: `${KINDS[n.kind]}: ${n.title}\nStatus: ${label(n)}${times}\n\n${update.text}\n\nFollow it on the Service status page: ${config.baseUrl}/portal/status\n` });
  }
  await db.query('update notice_updates set emailed = $2 where id = $1', [update.id, to.length]);
  return to.length;
}
const fmt = (d) => (d ? u.localStamp(d, config.timezone) : '');

async function create(db, b, actor, ip = '') {
  const v = read(b);
  if (v.ticket_id && !v.customer_ids.length && !v.all_customers) throw new UserError('Choose the customers affected.');
  const n = (await db.query(`insert into notices (kind, title, severity, status, all_customers, customer_ids, ticket_id, change_id, starts_at, ends_at, created_by)
                             values ($1,$2,$3,$4,$5,$6,$7,$8,coalesce($9, now()),$10,$11) returning *`,
    [v.kind, v.title, v.kind === 'maintenance' ? 'info' : v.severity, v.status, v.all_customers, v.customer_ids, v.ticket_id, v.change_id, v.starts_at, v.ends_at, actor.id])).rows[0];
  const up = (await db.query('insert into notice_updates (notice_id, status, text, created_by) values ($1,$2,$3,$4) returning *', [n.id, n.status, v.text, actor.id])).rows[0];
  const sent = v.email ? await mail(db, n, up) : 0;
  if (n.ticket_id) await db.query(`insert into ticket_events (ticket_id, actor_id, kind, text, internal) values ($1,$2,'major_incident',$3,true)`, [n.ticket_id, actor.id, `${actor.name} declared major incident ${n.ref}: ${n.title}.`]);
  if (n.change_id) await require('./changes').event(db, n.change_id, actor, `${actor.name} announced the maintenance to customers (${n.ref}).`);
  await audit(db, actor, 'notice_created', 'notice', n.ref, `${KINDS[n.kind]}: ${n.title}${sent ? `; e-mailed ${sent}` : ''}`, null, ip);
  return { notice: n, sent };
}

async function addUpdate(db, n, b, actor, ip = '') {
  if (n.closed_at) throw new UserError('This notice is closed. Open a new one if something else happens.');
  const status = u.oneOf(b.status, Object.keys(STATUS[n.kind]), n.status);
  const text = u.str(b.text, 4000);
  if (!text) throw new UserError('Write the update: what has changed and what customers should do.');
  const closing = CLOSING.includes(status);
  const out = (await db.query(`update notices set status = $2, closed_at = case when $3 then now() else null end, ends_at = case when $3 and kind = 'incident' then coalesce(ends_at, now()) else ends_at end
                                where id = $1 returning *`, [n.id, status, closing])).rows[0];
  const up = (await db.query('insert into notice_updates (notice_id, status, text, created_by) values ($1,$2,$3,$4) returning *', [n.id, status, text, actor.id])).rows[0];
  const sent = b.email === '1' ? await mail(db, out, up) : 0;
  await audit(db, actor, 'notice_updated', 'notice', n.ref, `${label(out)}${sent ? `; e-mailed ${sent}` : ''}`, null, ip);
  return { notice: out, sent };
}

async function get(db, id) {
  const n = (await db.query(`select n.*, t.ref as ticket_ref, c.ref as change_ref, cb.name as created_by_name from notices n left join tickets t on t.id = n.ticket_id
                              left join changes c on c.id = n.change_id left join users cb on cb.id = n.created_by where n.id = $1`, [id])).rows[0];
  if (!n) return null;
  n.updates = (await db.query(`select nu.*, u.name as by_name from notice_updates nu left join users u on u.id = nu.created_by where nu.notice_id = $1 order by nu.at desc, nu.id desc`, [id])).rows;
  n.customers = n.all_customers ? [] : (await db.query('select id, name from customers where id = any($1) order by name', [n.customer_ids])).rows;
  return n;
}

/** Notices a customer should see now: open incidents, and maintenance that is running or starts within 7 days. */
async function activeFor(db, customerId) {
  return (await db.query(`select n.id, n.ref, n.kind, n.title, n.severity, n.status, n.starts_at, n.ends_at,
                                 (select text from notice_updates nu where nu.notice_id = n.id order by nu.at desc, nu.id desc limit 1) as latest
                            from notices n where n.closed_at is null and (n.all_customers or $1 = any(n.customer_ids))
                             and (n.kind = 'incident' or n.status = 'in_progress' or n.starts_at <= now() + interval '7 days')
                           order by (n.kind = 'incident') desc, n.starts_at`, [customerId])).rows;
}
/** For the staff banner: open major incidents. */
async function openIncidents(db) {
  return (await db.query(`select id, ref, title, severity, status from notices where kind = 'incident' and closed_at is null order by created_at`)).rows;
}

module.exports = { KINDS, SEVERITIES, STATUS, CLOSING, label, read, create, addUpdate, get, activeFor, openIncidents, recipients };
