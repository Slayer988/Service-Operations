'use strict';
// Service desk productivity: time on tickets and timesheets, reply templates, and automation rules.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const audit = require('../lib/audit');
const u = require('../lib/util');
const config = require('../config');
const reporting = require('../lib/reporting');
const markdown = require('../lib/markdown');
const tickets = require('../services/tickets');
const T = require('../services/time');
const TPL = require('../services/templates');
const AU = require('../services/automation');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const db0 = { query: q };
const today = () => u.localDay(config.timezone);
const flashError = (req, err) => { if (!(err instanceof tickets.UserError)) throw err; req.flash('error', err.userMessage); };
const ticketOr404 = async (req, res) => { const t = await tickets.getVisible(db0, req.user, req.params.ref); if (!t) res.status(404).render('error', { title: 'Not found', message: 'That ticket does not exist.' }); return t; };

// ---------------------------------------------------------------- time on a ticket
router.post('/tickets/:ref/time', requireStaff, requirePerm('ticket.work'), wrap(async (req, res) => {
  const t = await ticketOr404(req, res); if (!t) return;
  try { const e = await tx((db) => T.log(db, t, req.user, { ...req.body, billable: req.body.billable === '1' }, today(), req.ip)); req.flash('success', `${T.show(e.minutes)} logged.`); } catch (err) { flashError(req, err); }
  return res.redirect(`/tickets/${t.ref}#time`);
}));
router.post('/tickets/:ref/time/:id(\\d+)/delete', requireStaff, requirePerm('ticket.work'), wrap(async (req, res) => {
  const t = await ticketOr404(req, res); if (!t) return;
  try { await tx((db) => T.remove(db, u.id(req.params.id), req.user, perms.can(req.user, 'time.view_all'), today(), req.ip)); req.flash('success', 'Time entry removed.'); } catch (err) { flashError(req, err); }
  return res.redirect(`/tickets/${t.ref}#time`);
}));

// ---------------------------------------------------------------- timesheets: a week per person, or everyone (managers)
async function sheet(req) {
  const all = perms.can(req.user, 'time.view_all');
  const week = T.monday(u.dateStr(req.query.week) || today());
  const end = T.addDays(week, 6);
  const who = all ? (req.query.user === 'all' ? 'all' : (u.id(req.query.user) || req.user.id)) : req.user.id;
  const params = [week, end]; let where = 'tt.work_date between $1 and $2';
  if (who !== 'all') { params.push(who); where += ` and tt.user_id = $${params.length}`; }
  const rows = (await q(`select tt.id, tt.work_date, tt.minutes, tt.billable, tt.note, t.ref, t.subject, c.name as customer_name, us.name as user_name
                           from ticket_time tt join tickets t on t.id = tt.ticket_id left join customers c on c.id = t.customer_id join users us on us.id = tt.user_id
                          where ${where} order by tt.work_date, us.name, t.ref`, params)).rows;
  return { all, week, end, who, rows };
}
router.get('/time', requireStaff, requirePerm('ticket.work'), wrap(async (req, res) => {
  const s = await sheet(req);
  const days = Array.from({ length: 7 }, (_, i) => T.addDays(s.week, i));
  const byDay = Object.fromEntries(days.map((d) => [d, 0])); let billable = 0;
  for (const r of s.rows) { byDay[r.work_date] += r.minutes; if (r.billable) billable += r.minutes; }
  const byCustomer = {}; for (const r of s.rows) { const k = r.customer_name || '(no customer)'; byCustomer[k] = byCustomer[k] || { total: 0, billable: 0 }; byCustomer[k].total += r.minutes; if (r.billable) byCustomer[k].billable += r.minutes; }
  const people = s.all ? (await q(`select id, name from users where kind = 'staff' and active order by name`)).rows : [];
  res.render('staff/timesheet', { title: 'Timesheet', ...s, days, byDay, billable, total: s.rows.reduce((a, r) => a + r.minutes, 0), byCustomer, people, T, prev: T.addDays(s.week, -7), next: T.addDays(s.week, 7) });
}));
router.get('/time/export', requireStaff, requirePerm('ticket.work'), wrap(async (req, res) => {
  const s = await sheet(req);
  const rows = s.rows.map((r) => ({ ...r, hours: Math.round((r.minutes / 60) * 100) / 100, chargeable: r.billable ? 'Yes' : 'No' }));
  const columns = [{ key: 'work_date', header: 'Date', type: 'date', width: 12 }, { key: 'user_name', header: 'Person', width: 18 }, { key: 'ref', header: 'Ticket', width: 13 },
    { key: 'subject', header: 'Subject', width: 30, weight: 3 }, { key: 'customer_name', header: 'Customer', width: 22, weight: 2 }, { key: 'hours', header: 'Hours', type: 'number', width: 8 },
    { key: 'chargeable', header: 'Chargeable', width: 10 }, { key: 'note', header: 'Note', width: 26, weight: 2 }];
  await audit(db0, req.user, 'report_exported', 'report', 'timesheet', `${s.week} ${rows.length} rows`, null, req.ip);
  if (!reporting.send(res, u.oneOf(req.query.format, ['csv', 'xlsx', 'pdf'], 'xlsx'), { title: 'Timesheet', subtitle: `Week of ${s.week}`, columns, rows }, req.user)) res.redirect('/time');
}));

// ---------------------------------------------------------------- reply templates
const canShared = (user) => perms.can(user, 'template.manage');
router.get('/templates', requireStaff, requirePerm('ticket.work'), wrap(async (req, res) => {
  const rows = (await q(`select t.*, o.name as owner_name from reply_templates t left join users o on o.id = t.owner_id where t.shared or t.owner_id = $1 order by t.shared desc, t.category, t.title`, [req.user.id])).rows;
  res.render('staff/templates', { title: 'Reply templates', rows, TPL, canShared: canShared(req.user), me: req.user.id });
}));
router.get('/templates/new', requireStaff, requirePerm('ticket.work'), (req, res) => res.render('staff/template_form', { title: 'New reply template', form: {}, error: null, TPL, canShared: canShared(req.user) }));
router.post('/templates', requireStaff, requirePerm('ticket.work'), wrap(async (req, res) => {
  try { const t = await TPL.save(db0, req.user, req.body, canShared(req.user)); req.flash('success', `Template "${t.title}" saved.`); return res.redirect('/templates'); } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return res.status(400).render('staff/template_form', { title: 'New reply template', form: req.body, error: err.userMessage, TPL, canShared: canShared(req.user) });
  }
}));
const tplOr404 = async (req, res) => { const t = (await q('select * from reply_templates where id = $1', [u.id(req.params.id)])).rows[0]; if (!t || !TPL.canEdit(req.user, t, canShared(req.user))) { res.status(404).render('error', { title: 'Not found', message: 'That template does not exist, or you cannot change it.' }); return null; } return t; };
router.get('/templates/:id(\\d+)', requireStaff, requirePerm('ticket.work'), wrap(async (req, res) => {
  const t = await tplOr404(req, res); if (!t) return;
  res.render('staff/template_form', { title: t.title, form: { ...t, shared: t.shared ? '1' : '' }, id: t.id, error: null, TPL, canShared: canShared(req.user) });
}));
router.post('/templates/:id(\\d+)', requireStaff, requirePerm('ticket.work'), wrap(async (req, res) => {
  const t = await tplOr404(req, res); if (!t) return;
  try { await TPL.save(db0, req.user, req.body, canShared(req.user), t); req.flash('success', 'Template saved.'); return res.redirect('/templates'); } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return res.status(400).render('staff/template_form', { title: t.title, form: req.body, id: t.id, error: err.userMessage, TPL, canShared: canShared(req.user) });
  }
}));
router.post('/templates/:id(\\d+)/delete', requireStaff, requirePerm('ticket.work'), wrap(async (req, res) => {
  const t = await tplOr404(req, res); if (!t) return;
  await q('delete from reply_templates where id = $1', [t.id]); req.flash('success', `Template "${t.title}" deleted.`);
  return res.redirect('/templates');
}));
// the template filled in for one ticket, as HTML for the reply editor and as plain text
router.get('/api/templates/:id(\\d+)/fill', requireStaff, requirePerm('ticket.work'), wrap(async (req, res) => {
  const tpl = (await q('select * from reply_templates where id = $1 and (shared or owner_id = $2)', [u.id(req.params.id), req.user.id])).rows[0];
  const t = await tickets.getVisible(db0, req.user, u.str(req.query.ticket, 20));
  if (!tpl || !t) return res.status(404).json({ error: 'not found' });
  const text = TPL.fill(tpl.body, t, req.user);
  await q('update reply_templates set use_count = use_count + 1 where id = $1', [tpl.id]);
  res.set('Cache-Control', 'no-store');
  return res.json({ text, html: markdown.render(text) });
}));

// ---------------------------------------------------------------- automation rules
const auto = [requireStaff, requirePerm('automation.manage')];
const ruleData = async () => ({ people: (await q(`select id, name from users where kind = 'staff' and active order by name`)).rows, customers: (await q('select id, name from customers order by name')).rows,
  categories: (await q(`select distinct category from tickets where category <> '' order by category limit 100`)).rows.map((r) => r.category) });
const names = (d) => ({ people: Object.fromEntries(d.people.map((p) => [p.id, p.name])), customers: Object.fromEntries(d.customers.map((c) => [c.id, c.name])) });
router.get('/admin/automation', ...auto, wrap(async (req, res) => {
  const rows = (await q('select * from automation_rules order by position, id')).rows;
  const d = await ruleData();
  res.render('admin/automation', { title: 'Automation rules', rows: rows.map((r) => ({ ...r, text: AU.describe(r, names(d)) })) });
}));
const formFor = (r) => {
  const c = r.conditions || {}; const a = r.actions || {};
  return { name: r.name, active: r.active === false ? '0' : '1', stop: r.stop ? '1' : '', c_source: c.source || '', c_type: c.type || '', c_queue: c.queue || '', c_category: c.category || '', c_customer_id: c.customer_id || '',
    c_priority_max: c.priority_max || '', c_words: (c.words || []).join(', '), c_domain: c.domain || '', a_impact: a.impact || '', a_urgency: a.urgency || '', a_queue: a.queue || '', a_tier: a.tier || '', a_assignee_id: a.assignee_id || '', a_note: a.note || '' };
};
router.get('/admin/automation/new', ...auto, wrap(async (req, res) => res.render('admin/automation_form', { title: 'New automation rule', form: { active: '1' }, id: null, error: null, preview: null, AU, ...(await ruleData()) })));
async function saveRule(req, res, existing) {
  const d = await ruleData();
  try {
    const v = AU.read(req.body, d.people);
    if (req.body.preview) return res.render('admin/automation_form', { title: v.name, form: req.body, id: existing ? existing.id : null, error: null, preview: await AU.preview(db0, v.conditions), AU, ...d });
    if (existing) {
      await q('update automation_rules set name=$2, conditions=$3, actions=$4, stop=$5, active=$6, updated_at=now() where id=$1', [existing.id, v.name, v.conditions, v.actions, v.stop, v.active]);
    } else {
      const pos = (await q('select coalesce(max(position), 0) + 10 as p from automation_rules')).rows[0].p;
      await q('insert into automation_rules (name, conditions, actions, stop, active, position, created_by) values ($1,$2,$3,$4,$5,$6,$7)', [v.name, v.conditions, v.actions, v.stop, v.active, pos, req.user.id]);
    }
    await audit(db0, req.user, existing ? 'automation_rule_changed' : 'automation_rule_created', 'automation', v.name, JSON.stringify({ when: v.conditions, then: v.actions }).slice(0, 900), null, req.ip);
    req.flash('success', `Rule "${v.name}" saved. It applies to new tickets from now on.`);
    return res.redirect('/admin/automation');
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return res.status(400).render('admin/automation_form', { title: 'Automation rule', form: req.body, id: existing ? existing.id : null, error: err.userMessage, preview: null, AU, ...d });
  }
}
router.post('/admin/automation', ...auto, wrap(async (req, res) => saveRule(req, res, null)));
const ruleOr404 = async (req, res) => { const r = (await q('select * from automation_rules where id = $1', [u.id(req.params.id)])).rows[0]; if (!r) res.status(404).render('error', { title: 'Not found', message: 'That rule does not exist.' }); return r; };
router.get('/admin/automation/:id(\\d+)', ...auto, wrap(async (req, res) => {
  const r = await ruleOr404(req, res); if (!r) return;
  res.render('admin/automation_form', { title: r.name, form: formFor(r), id: r.id, error: null, preview: await AU.preview(db0, r.conditions), AU, ...(await ruleData()) });
}));
router.post('/admin/automation/:id(\\d+)', ...auto, wrap(async (req, res) => { const r = await ruleOr404(req, res); if (!r) return null; return saveRule(req, res, r); }));
router.post('/admin/automation/:id(\\d+)/move', ...auto, wrap(async (req, res) => {
  const r = await ruleOr404(req, res); if (!r) return;
  const all = (await q('select id from automation_rules order by position, id')).rows.map((x) => Number(x.id));
  const i = all.indexOf(Number(r.id)); const j = req.body.dir === 'up' ? i - 1 : i + 1;
  if (j >= 0 && j < all.length) { [all[i], all[j]] = [all[j], all[i]]; await tx(async (db) => { for (const [k, id] of all.entries()) await db.query('update automation_rules set position = $2 where id = $1', [id, (k + 1) * 10]); }); }
  return res.redirect('/admin/automation');
}));
router.post('/admin/automation/:id(\\d+)/delete', ...auto, wrap(async (req, res) => {
  const r = await ruleOr404(req, res); if (!r) return;
  await q('delete from automation_rules where id = $1', [r.id]);
  await audit(db0, req.user, 'automation_rule_deleted', 'automation', r.name, '', null, req.ip);
  req.flash('success', `Rule "${r.name}" deleted.`); return res.redirect('/admin/automation');
}));

module.exports = router;
