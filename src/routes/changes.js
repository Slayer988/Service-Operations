'use strict';
// Changes: list, calendar, raise, plan, ask for approval, schedule, carry out and record the outcome; announce the maintenance.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const u = require('../lib/util');
const config = require('../config');
const tickets = require('../services/tickets');
const C = require('../services/changes');
const A = require('../services/approvals');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const db0 = { query: q };
const view = [requireStaff, requirePerm('change.view')];
const manage = [requireStaff, requirePerm('change.manage')];
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That change does not exist.' });
const flashError = (req, err) => { if (!(err instanceof tickets.UserError)) throw err; req.flash('error', err.userMessage); };
async function formData() {
  return { people: (await q(`select id, name from users where kind = 'staff' and active order by name`)).rows, customers: (await q('select id, name from customers order by name')).rows,
    problems: (await q(`select id, ref, title from problems where status in ('open','investigating','known_error') order by id desc limit 200`)).rows };
}

router.get('/changes', ...view, wrap(async (req, res) => {
  const f = { status: u.oneOf(req.query.status, [...Object.keys(C.STATUS_LABELS), 'active', 'all'], 'active'), q: u.str(req.query.q, 100) };
  const where = []; const params = [];
  if (f.status === 'active') where.push(`c.status in ('draft','scheduled','in_progress')`); else if (f.status !== 'all') { params.push(f.status); where.push(`c.status = $${params.length}`); }
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(c.ref ilike $${params.length} or c.title ilike $${params.length})`); }
  const rows = (await q(`select c.id, c.ref, c.title, c.type, c.risk, c.status, c.planned_start, c.planned_end, cu.name as customer_name, o.name as owner_name,
                                (select a.status from approvals a where a.entity = 'change' and a.entity_id = c.id and a.status <> 'withdrawn' order by a.id desc limit 1) as approval
                           from changes c left join customers cu on cu.id = c.customer_id left join users o on o.id = c.owner_id
                          ${where.length ? `where ${where.join(' and ')}` : ''} order by coalesce(c.planned_start, c.created_at) desc limit 500`, params)).rows;
  res.render('staff/changes', { title: 'Changes', rows, f, C, canManage: perms.can(req.user, 'change.manage') });
}));

// ---------------------------------------------------------------- calendar: a month of changes, with clashes marked
router.get('/changes/calendar', ...view, wrap(async (req, res) => {
  const today = u.localDay(config.timezone);
  const month = /^\d{4}-\d{2}$/.test(String(req.query.month || '')) ? req.query.month : today.slice(0, 7);
  const [Y, M] = month.split('-').map(Number);
  const first = new Date(Date.UTC(Y, M - 1, 1)); const last = new Date(Date.UTC(Y, M, 0));
  const startGrid = new Date(first); startGrid.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));        // Monday on or before the 1st
  const endGrid = new Date(last); endGrid.setUTCDate(last.getUTCDate() + (7 - ((last.getUTCDay() + 6) % 7) - 1));
  const iso = (d) => d.toISOString().slice(0, 10);
  const rows = (await q(`select c.id, c.ref, c.title, c.status, c.type, c.risk, c.planned_start, c.planned_end, c.customer_id, cu.name as customer_name
                           from changes c left join customers cu on cu.id = c.customer_id
                          where c.status not in ('cancelled','draft') and c.planned_start is not null and c.planned_start < ($2::date + 2)::timestamptz and c.planned_end > ($1::date - 1)::timestamptz
                          order by c.planned_start`, [iso(startGrid), iso(endGrid)])).rows;
  // clashes: two scheduled/running changes overlapping in time on the same customer or the same equipment
  const clash = new Set();
  const live = rows.filter((r) => ['scheduled', 'in_progress'].includes(r.status));
  const assetsOf = {};
  for (const r of (await q('select change_id, asset_id from change_assets where change_id = any($1)', [live.map((x) => x.id)])).rows) (assetsOf[r.change_id] = assetsOf[r.change_id] || new Set()).add(Number(r.asset_id));
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const a = live[i]; const b = live[j];
    if (!(new Date(a.planned_start) < new Date(b.planned_end) && new Date(b.planned_start) < new Date(a.planned_end))) continue;
    const sameCust = a.customer_id && Number(a.customer_id) === Number(b.customer_id);
    const sameAsset = [...(assetsOf[a.id] || [])].some((x) => (assetsOf[b.id] || new Set()).has(x));
    if (sameCust || sameAsset) { clash.add(a.id); clash.add(b.id); }
  }
  const local = (d) => C.forInput(d).slice(0, 10);
  const days = [];
  for (let d = new Date(startGrid); d <= endGrid; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = iso(d);
    days.push({ day, inMonth: d.getUTCMonth() === M - 1, today: day === today,
      items: rows.filter((r) => local(r.planned_start) <= day && local(r.planned_end) >= day).map((r) => ({ ...r, clash: clash.has(r.id), startsHere: local(r.planned_start) === day })) });
  }
  const shift = (n) => { const d = new Date(Date.UTC(Y, M - 1 + n, 1)); return iso(d).slice(0, 7); };
  res.render('staff/change_calendar', { title: 'Change calendar', month, monthLabel: first.toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }), days, prev: shift(-1), next: shift(1),
    clashes: clash.size, C, canManage: perms.can(req.user, 'change.manage') });
}));

router.get('/changes/new', ...manage, wrap(async (req, res) => {
  const form = { type: 'normal', risk: 'medium', customer_id: u.id(req.query.customer) || '', problem_id: u.id(req.query.problem) || '', assets: u.str(req.query.asset, 20), ticket: u.str(req.query.ticket, 20) };
  if (form.problem_id) { const p = (await q('select title, customer_id, permanent_fix from problems where id = $1', [form.problem_id])).rows[0]; if (p) { form.title = `Permanent fix: ${p.title}`.slice(0, 200); form.customer_id = form.customer_id || p.customer_id || ''; } }
  if (form.assets) { const a = (await q('select customer_id from assets where upper(tag) = upper($1)', [form.assets])).rows[0]; if (a && a.customer_id) form.customer_id = form.customer_id || a.customer_id; }
  res.render('staff/change_new', { title: 'Raise a change', form, error: null, C, ...(await formData()) });
}));
router.post('/changes', ...manage, wrap(async (req, res) => {
  try {
    const c = await tx((db) => C.create(db, req.body, req.user, req.ip));
    req.flash('success', `${c.ref} raised as a draft.`);
    return res.redirect(`/changes/${c.id}`);
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return res.status(400).render('staff/change_new', { title: 'Raise a change', form: req.body, error: err.userMessage, C, ...(await formData()) });
  }
}));

const load = (fn) => wrap(async (req, res) => { const c = await C.get(db0, u.id(req.params.id)); if (!c) return notFound(res); return fn(req, res, c); });

router.get('/changes/:id(\\d+)', ...view, load(async (req, res, c) => {
  const canManage = perms.can(req.user, 'change.manage');
  const assets = (await q(`select a.id, a.tag, a.name, a.customer_id from change_assets ca join assets a on a.id = ca.asset_id where ca.change_id = $1 order by a.tag`, [c.id])).rows;
  const linkedTickets = (await q(`select t.ref, t.subject, t.status from change_tickets ct join tickets t on t.id = ct.ticket_id where ct.change_id = $1`, [c.id])).rows;
  const events = (await q(`select text, at from change_events where change_id = $1 order by at desc, id desc limit 200`, [c.id])).rows;
  const notices = (await q(`select id, ref, status, kind from notices where change_id = $1 order by id desc`, [c.id])).rows;
  const ap = c.status === 'draft' ? await A.state(db0, 'change', await A.load(db0, 'change', c.id)) : null;
  let moves = canManage ? C.MOVES[c.status] : [];
  if (ap && ap.needed.length && !ap.complete) moves = moves.filter((m) => m !== 'scheduled');
  const apDecider = !!(ap && ap.pending && A.canDecide(req.user, ap.pending.record.roles) && req.user.id !== Number(ap.pending.record.requested_by) && req.user.id !== Number(c.owner_id));
  res.render('staff/change', { title: `${c.ref} ${c.title}`, c, assets, linkedTickets, events, notices, conflicts: await C.conflicts(db0, c), C, A, ap, apDecider, moves, canManage,
    editable: canManage && c.status === 'draft', canNotice: perms.can(req.user, 'notice.manage'), roleLabels: perms.ROLE_LABELS, ...(canManage ? await formData() : {}) });
}));
router.post('/changes/:id(\\d+)', ...manage, load(async (req, res, c) => {
  try { await tx((db) => C.update(db, c, req.body, req.user, req.ip)); req.flash('success', 'Saved.'); } catch (err) { flashError(req, err); }
  return res.redirect(`/changes/${c.id}`);
}));
router.post('/changes/:id(\\d+)/status', ...manage, load(async (req, res, c) => {
  try { const out = await tx((db) => C.setStatus(db, c, u.str(req.body.status, 20), req.user, req.body.note, req.ip)); req.flash('success', `${c.ref}: ${C.STATUS_LABELS[out.status].toLowerCase()}.`); } catch (err) { flashError(req, err); }
  return res.redirect(`/changes/${c.id}`);
}));
router.post('/changes/:id(\\d+)/assets', ...manage, load(async (req, res, c) => {
  try { const a = await tx((db) => C.linkAsset(db, c, req.body.tag, req.user)); req.flash('success', `${a.tag} added.`); } catch (err) { flashError(req, err); }
  return res.redirect(`/changes/${c.id}#assets`);
}));
router.post('/changes/:id(\\d+)/assets/:aid(\\d+)/unlink', ...manage, load(async (req, res, c) => {
  await tx((db) => C.unlinkAsset(db, c, u.id(req.params.aid), req.user)); req.flash('success', 'Removed.');
  return res.redirect(`/changes/${c.id}#assets`);
}));

module.exports = router;
