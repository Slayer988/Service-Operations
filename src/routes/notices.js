'use strict';
// Service notices: declare a major incident (often from a P1 ticket), announce planned maintenance (often from a change), post updates,
// and the customers' Service status page.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const u = require('../lib/util');
const tickets = require('../services/tickets');
const N = require('../services/notices');
const C = require('../services/changes');
const { wrap } = require('./util');
const { requireStaff, requireCustomer, requirePerm } = require('../middleware/auth');

const router = express.Router();
const db0 = { query: q };
const view = [requireStaff, requirePerm('ticket.view')];
const manage = [requireStaff, requirePerm('notice.manage')];
const customers = async () => (await q(`select id, name from customers where status = 'active' order by name`)).rows;

router.get('/notices', ...view, wrap(async (req, res) => {
  const open = (await q(`select n.*, (select count(*)::int from notice_updates nu where nu.notice_id = n.id) as updates from notices n where n.closed_at is null order by (n.kind = 'incident') desc, n.starts_at`)).rows;
  const closed = (await q(`select n.* from notices n where n.closed_at is not null order by n.closed_at desc limit 50`)).rows;
  const names = {}; for (const c of await customers()) names[c.id] = c.name;
  res.render('staff/notices', { title: 'Service notices', open, closed, N, names, canManage: perms.can(req.user, 'notice.manage') });
}));

router.get('/notices/new', ...manage, wrap(async (req, res) => {
  const form = { kind: req.query.kind === 'maintenance' ? 'maintenance' : 'incident', severity: 'outage', customer_ids: [], email: '1' };
  if (req.query.ticket) {
    const t = (await q('select id, ref, subject, customer_id from tickets where upper(ref) = upper($1)', [u.str(req.query.ticket, 20)])).rows[0];
    if (t) Object.assign(form, { kind: 'incident', ticket_id: t.id, ticket_ref: t.ref, title: t.subject, customer_ids: t.customer_id ? [t.customer_id] : [],
      text: 'We are aware of the problem and our engineers are working on it. The next update will follow within 30 minutes.' });
  }
  if (req.query.change) {
    const c = await C.get(db0, u.id(req.query.change));
    if (c) Object.assign(form, { kind: 'maintenance', change_id: c.id, change_ref: c.ref, title: c.title, customer_ids: c.customer_id ? [c.customer_id] : [],
      starts_at: C.forInput(c.planned_start), ends_at: C.forInput(c.planned_end), text: c.impact ? `${c.impact}` : 'Planned work. The service may be unavailable during this window.' });
  }
  res.render('staff/notice_new', { title: form.kind === 'incident' ? 'Declare a major incident' : 'Announce maintenance', form, error: null, N, customers: await customers() });
}));

router.post('/notices', ...manage, wrap(async (req, res) => {
  try {
    const r = await tx((db) => N.create(db, req.body, req.user, req.ip));
    req.flash('success', `${r.notice.ref} published to the customers affected${r.sent ? ` and e-mailed to ${r.sent} contact${r.sent === 1 ? '' : 's'}` : ''}.`);
    return res.redirect(`/notices/${r.notice.id}`);
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    const form = { ...req.body, customer_ids: [].concat(req.body.customer_ids || []) };
    return res.status(400).render('staff/notice_new', { title: 'Service notice', form, error: err.userMessage, N, customers: await customers() });
  }
}));

router.get('/notices/:id(\\d+)', ...view, wrap(async (req, res) => {
  const n = await N.get(db0, u.id(req.params.id));
  if (!n) return res.status(404).render('error', { title: 'Not found', message: 'That notice does not exist.' });
  res.render('staff/notice', { title: `${n.ref} ${n.title}`, n, N, canManage: perms.can(req.user, 'notice.manage'), recipients: (await N.recipients(db0, n)).length });
}));

router.post('/notices/:id(\\d+)/updates', ...manage, wrap(async (req, res) => {
  const n = (await q('select * from notices where id = $1', [u.id(req.params.id)])).rows[0];
  if (!n) return res.status(404).render('error', { title: 'Not found', message: 'That notice does not exist.' });
  try {
    const r = await tx((db) => N.addUpdate(db, n, req.body, req.user, req.ip));
    req.flash('success', `Update published${r.sent ? ` and e-mailed to ${r.sent} contact${r.sent === 1 ? '' : 's'}` : ''}.`);
  } catch (err) { if (!(err instanceof tickets.UserError)) throw err; req.flash('error', err.userMessage); }
  return res.redirect(`/notices/${n.id}`);
}));

// ---------------------------------------------------------------- customers: Service status
router.get('/portal/status', requireCustomer, wrap(async (req, res) => {
  const active = await N.activeFor(db0, req.user.customer_id);
  const recent = (await q(`select n.id, n.ref, n.kind, n.title, n.status, n.starts_at, n.ends_at, n.closed_at from notices n
                            where n.closed_at > now() - interval '30 days' and (n.all_customers or $1 = any(n.customer_ids)) order by n.closed_at desc limit 20`, [req.user.customer_id])).rows;
  const ids = [...active.map((x) => x.id), ...recent.map((x) => x.id)];
  const updates = {};
  for (const r of (await q(`select notice_id, status, text, at from notice_updates where notice_id = any($1) order by at desc, id desc`, [ids])).rows) (updates[r.notice_id] = updates[r.notice_id] || []).push(r);
  res.render('portal/status', { title: 'Service status', active, recent, updates, N });
}));

module.exports = router;
