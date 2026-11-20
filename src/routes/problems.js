'use strict';
// Problems: list, open (on its own or from a ticket), investigate, record the known error, resolve; link incidents and equipment.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const u = require('../lib/util');
const tickets = require('../services/tickets');
const P = require('../services/problems');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const db0 = { query: q };
const view = [requireStaff, requirePerm('problem.view')];
const manage = [requireStaff, requirePerm('problem.manage')];
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That problem does not exist.' });
const flashError = (req, err) => { if (!(err instanceof tickets.UserError)) throw err; req.flash('error', err.userMessage); };
const people = async () => (await q(`select id, name from users where kind = 'staff' and active order by name`)).rows;
const customers = async () => (await q(`select id, name from customers order by name`)).rows;

router.get('/problems', ...view, wrap(async (req, res) => {
  const f = { status: u.oneOf(req.query.status, [...P.STATUSES, 'active', 'all'], 'active'), q: u.str(req.query.q, 100) };
  const where = []; const params = [];
  if (f.status === 'active') where.push(`p.status in ('open','investigating','known_error')`); else if (f.status !== 'all') { params.push(f.status); where.push(`p.status = $${params.length}`); }
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(p.ref ilike $${params.length} or p.title ilike $${params.length} or p.root_cause ilike $${params.length} or p.workaround ilike $${params.length})`); }
  const rows = (await q(`select p.id, p.ref, p.title, p.status, p.priority, p.created_at, p.updated_at, c.name as customer_name, o.name as owner_name, p.workaround <> '' as has_workaround,
                                (select count(*)::int from problem_tickets pt where pt.problem_id = p.id) as incidents,
                                (select count(*)::int from problem_tickets pt join tickets t on t.id = pt.ticket_id where pt.problem_id = p.id and t.status not in ('resolved','closed','cancelled')) as open_incidents
                           from problems p left join customers c on c.id = p.customer_id left join users o on o.id = p.owner_id
                          ${where.length ? `where ${where.join(' and ')}` : ''} order by p.priority, p.updated_at desc limit 500`, params)).rows;
  const counts = (await q(`select status, count(*)::int as n from problems group by status`)).rows.reduce((a, r) => ({ ...a, [r.status]: r.n }), {});
  res.render('staff/problems', { title: 'Problems', rows, f, counts, P, canManage: perms.can(req.user, 'problem.manage') });
}));

// from a ticket: link it to an existing problem by reference
router.post('/problems/link-ticket', ...manage, wrap(async (req, res) => {
  const ref = u.str(req.body.ticket, 20);
  try {
    const p = (await q('select * from problems where upper(ref) = upper($1)', [u.str(req.body.problem, 20)])).rows[0];
    if (!p) throw new tickets.UserError(`There is no problem ${u.str(req.body.problem, 20)}.`);
    await tx((db) => P.linkTicket(db, p, ref, req.user));
    req.flash('success', `Linked to ${p.ref}.`);
  } catch (err) { flashError(req, err); }
  return res.redirect(`/tickets/${encodeURIComponent(ref)}#problem`);
}));

router.get('/problems/new', ...manage, wrap(async (req, res) => {
  const t = req.query.ticket ? (await q('select ref, subject, description, customer_id, priority from tickets where upper(ref) = upper($1)', [u.str(req.query.ticket, 20)])).rows[0] : null;
  const form = t ? { title: t.subject, description: t.description, customer_id: t.customer_id, priority: Math.min(4, Math.max(1, Number(t.priority) || 3)), ticket: t.ref } : { priority: 3 };
  res.render('staff/problem_new', { title: 'Open a problem', form, error: null, P, people: await people(), customers: await customers() });
}));

router.post('/problems', ...manage, wrap(async (req, res) => {
  try {
    const p = await tx((db) => P.create(db, req.body, req.user, req.ip));
    req.flash('success', `${p.ref} opened.`);
    return res.redirect(`/problems/${p.id}`);
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return res.status(400).render('staff/problem_new', { title: 'Open a problem', form: req.body, error: err.userMessage, P, people: await people(), customers: await customers() });
  }
}));

const load = (fn) => wrap(async (req, res) => { const p = await P.get(db0, u.id(req.params.id)); if (!p) return notFound(res); return fn(req, res, p); });

router.get('/problems/:id(\\d+)', ...view, load(async (req, res, p) => {
  const incidents = (await q(`select t.id, t.ref, t.subject, t.status, t.priority, t.created_at, c.name as customer_name from problem_tickets pt join tickets t on t.id = pt.ticket_id
                               left join customers c on c.id = t.customer_id where pt.problem_id = $1 order by t.created_at desc`, [p.id])).rows;
  const assets = (await q(`select a.id, a.tag, a.name from problem_assets pa join assets a on a.id = pa.asset_id where pa.problem_id = $1 order by a.tag`, [p.id])).rows;
  const changes = (await q(`select id, ref, title, status from changes where problem_id = $1 order by id desc`, [p.id])).rows;
  const events = (await q(`select e.text, e.at from problem_events e where e.problem_id = $1 order by e.at desc, e.id desc limit 200`, [p.id])).rows;
  const canManage = perms.can(req.user, 'problem.manage');
  res.render('staff/problem', { title: `${p.ref} ${p.title}`, p, incidents, assets, changes, events, P, canManage, canChange: perms.can(req.user, 'change.manage'),
    people: canManage ? await people() : [], customers: canManage ? await customers() : [] });
}));

router.post('/problems/:id(\\d+)', ...manage, load(async (req, res, p) => {
  try { await tx((db) => P.update(db, p, req.body, req.user, req.ip)); req.flash('success', 'Saved.'); } catch (err) { flashError(req, err); }
  return res.redirect(`/problems/${p.id}`);
}));
router.post('/problems/:id(\\d+)/status', ...manage, load(async (req, res, p) => {
  try { const out = await tx((db) => P.setStatus(db, p, u.str(req.body.status, 20), req.user, req.body.note, req.ip)); req.flash('success', `${p.ref} is now ${P.STATUS_LABELS[out.status].toLowerCase()}.`); } catch (err) { flashError(req, err); }
  return res.redirect(`/problems/${p.id}`);
}));
router.post('/problems/:id(\\d+)/tickets', ...manage, load(async (req, res, p) => {
  try { const t = await tx((db) => P.linkTicket(db, p, req.body.ref, req.user)); req.flash('success', `${t.ref} linked.`); } catch (err) { flashError(req, err); }
  return res.redirect(`/problems/${p.id}#incidents`);
}));
router.post('/problems/:id(\\d+)/tickets/:tid(\\d+)/unlink', ...manage, load(async (req, res, p) => {
  await tx((db) => P.unlinkTicket(db, p, u.id(req.params.tid), req.user)); req.flash('success', 'Unlinked.');
  return res.redirect(`/problems/${p.id}#incidents`);
}));
router.post('/problems/:id(\\d+)/assets', ...manage, load(async (req, res, p) => {
  try { const a = await tx((db) => P.linkAsset(db, p, req.body.tag, req.user)); req.flash('success', `${a.tag} linked.`); } catch (err) { flashError(req, err); }
  return res.redirect(`/problems/${p.id}#assets`);
}));
router.post('/problems/:id(\\d+)/article', ...manage, requirePerm('kb.write'), load(async (req, res, p) => {
  try { const a = await tx((db) => P.toArticle(db, p, req.user, req.ip)); req.flash('success', `Draft article ${a.code} written from the known error. Review and publish it.`); return res.redirect(`/kb/${a.code}`); } catch (err) { flashError(req, err); }
  return res.redirect(`/problems/${p.id}`);
}));

module.exports = router;
