'use strict';
// Tender management (TM-001 .. TM-015): register, prepare, review, submit, evaluate and award; dashboard and reports.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const csrf = require('../lib/csrf');
const audit = require('../lib/audit');
const u = require('../lib/util');
const tz = require('../lib/tz');
const config = require('../config');
const charts = require('../lib/charts');
const reporting = require('../lib/reporting');
const tickets = require('../services/tickets');
const T = require('../services/tenders');
const TR = require('../services/tender_reports');
const docs = require('../services/documents');
const { upload, wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const view = [requireStaff, requirePerm('tender.view')];
const manage = [requireStaff, requirePerm('tender.manage')];
const contribute = [requireStaff, requirePerm('tender.contribute')];
const UserError = tickets.UserError;
const db0 = { query: q };
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That tender does not exist.' });
const LOCAL = (d) => tz.dateToLocal(d, config.timezone);
const qsOf = (query, skip = ['format']) => new URLSearchParams(Object.entries(query).filter(([k, v]) => !skip.includes(k) && typeof v === 'string' && v)).toString();

async function formData(user, extra = {}) {
  const s = await T.listSettings(db0);
  return {
    customers: (await q('select id, name from customers order by name')).rows,
    staff: (await q(`select id, name from users where kind = 'staff' and active order by name`)).rows,
    opportunities: perms.can(user, 'pipeline.view') ? (await q(`select id, ref, name from opportunities where stage not in ('won','lost') order by id desc limit 300`)).rows : [],
    ...s, timezone: config.timezone, local: LOCAL, ...extra,
  };
}

// ---------------------------------------------------------------- register, search and dashboard
function filters(query) {
  const where = ['true']; const params = []; const f = {};
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  f.q = u.str(query.q, 100);
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); const n = params.length; where.push(`(t.title ilike $${n} or t.ref ilike $${n} or t.issuer ilike $${n} or t.tender_no ilike $${n} or cu.name ilike $${n})`); }
  f.status = u.oneOf(query.status, [...T.STATUSES, 'active', 'closed_out']) || '';
  if (f.status === 'active') where.push(`t.status = any(array['${T.ACTIVE.join("','")}'])`); else if (f.status === 'closed_out') where.push(`t.status in ('awarded','unsuccessful','cancelled','withdrawn','closed')`); else if (f.status) add('t.status = ?', f.status);
  f.type = u.str(query.type, 40); if (f.type) add('t.type = ?', f.type);
  f.customer = u.id(query.customer) || ''; if (f.customer) add('t.customer_id = ?', f.customer);
  f.owner = u.id(query.owner) || ''; if (f.owner) add('t.owner_id = ?', f.owner);
  f.department = u.str(query.department, 100); if (f.department) add('t.department = ?', f.department);
  const vmin = u.money(query.value_min); const vmax = u.money(query.value_max);
  f.value_min = vmin === null || Number.isNaN(vmin) ? '' : vmin; f.value_max = vmax === null || Number.isNaN(vmax) ? '' : vmax;
  if (f.value_min !== '') add('t.est_value >= ?', f.value_min); if (f.value_max !== '') add('t.est_value <= ?', f.value_max);
  f.from = u.dateStr(query.from) || ''; f.to = u.dateStr(query.to) || '';
  if (f.from) add('t.submission_due >= ?::date', f.from); if (f.to) add(`t.submission_due < (?::date + 1)`, f.to);
  return { where, params, f };
}
const LIST_SQL = `select t.id, t.ref, t.title, t.issuer, t.type, t.status, t.submission_due, t.est_value, t.award_value, t.currency, coalesce(cu.name, t.issuer) as client, o.name as owner, t.department,
                         (select count(*)::int from tender_tasks k where k.tender_id = t.id) as tasks, (select count(*)::int from tender_tasks k where k.tender_id = t.id and k.done_at is not null) as tasks_done
                    from tenders t left join customers cu on cu.id = t.customer_id join users o on o.id = t.owner_id`;

router.get('/tenders', ...view, wrap(async (req, res) => {
  const { where, params, f } = filters(req.query);
  const rows = (await q(`${LIST_SQL} where ${where.join(' and ')} order by case when t.status = any($${params.length + 1}) then 0 else 1 end, t.submission_due ${f.status === 'closed_out' ? 'desc' : 'asc'} limit 500`, [...params, T.ACTIVE])).rows;
  const now = Date.now();
  for (const r of rows) { r.left = new Date(r.submission_due).getTime() - now; r.leftText = T.PRE_SUBMISSION.includes(r.status) ? (r.left < 0 ? `overdue by ${charts.duration(-r.left)}` : charts.duration(r.left)) : ''; }
  const fd = await formData(req.user);
  const d = await TR.dashboard(q, fd.defaultCurrency);
  const statusSegs = T.STATUSES.map((k, i) => ({ key: k, value: (d.byStatus.find((x) => x.status === k) || { n: 0 }).n })).filter((s) => s.value > 0);
  const top = statusSegs.slice().sort((a, b) => b.value - a.value);
  const segs = top.slice(0, 4).map((s, i) => ({ ...s, cls: `c${i}`, label: fd.labels[s.key] }));
  const rest = top.slice(4).reduce((a, s) => a + s.value, 0); if (rest) segs.push({ key: 'other', value: rest, cls: 'c4', label: 'Other statuses' });
  const types = d.byType.slice(0, 5).map((x) => ({ label: x.label, value: x.n, text: String(x.n) }));
  res.render('staff/tenders', { title: 'Tender Management', rows, f, d, ...fd, statuses: fd.labels, statusChart: charts.donut(segs), segs,
    typeChart: charts.hbars(types), clientChart: charts.hbars(d.byClient.map((x) => ({ label: x.label, value: x.won, text: `${x.won} of ${x.won + x.lost}` })), { labelW: 38 }),
    unitChart: charts.hbars(d.byUnit.map((x) => ({ label: x.label, value: x.won, text: `${x.won} of ${x.won + x.lost}` })), { labelW: 38 }),
    canManage: perms.can(req.user, 'tender.manage'), qs: qsOf(req.query) });
}));

router.get('/tenders/export', ...view, wrap(async (req, res) => {
  const { where, params } = filters(req.query);
  const labels = (await T.listSettings(db0)).labels;
  const rows = (await q(`${LIST_SQL} where ${where.join(' and ')} order by t.submission_due desc limit 5000`, params)).rows.map((r) => ({ ...r, status_label: labels[r.status] }));
  const columns = [{ key: 'ref', header: 'Reference', width: 15 }, { key: 'title', header: 'Tender', width: 34, weight: 3 }, { key: 'client', header: 'Client', width: 26, weight: 2 }, { key: 'type', header: 'Type', width: 10 }, { key: 'status_label', header: 'Status', width: 18 },
    { key: 'owner', header: 'Owner', width: 18 }, { key: 'department', header: 'Department', width: 16 }, { key: 'submission_due', header: 'Deadline', type: 'date', width: 13 }, { key: 'est_value', header: 'Estimated value', type: 'money', width: 16 },
    { key: 'award_value', header: 'Award value', type: 'money', width: 16 }, { key: 'currency', header: 'Cur.', width: 7 }];
  await audit(db0, req.user, 'report_exported', 'report', 'tenders', `${rows.length} rows`, null, req.ip);
  if (!reporting.send(res, u.oneOf(req.query.format, ['csv', 'xlsx', 'pdf'], 'csv'), { title: 'Tender register', subtitle: `${rows.length} tenders`, columns, rows }, req.user)) res.redirect('/tenders');
}));

// ---------------------------------------------------------------- reports
router.get('/tenders/reports', ...view, wrap(async (req, res) => {
  res.render('staff/tender_reports', { title: 'Tender reports', reports: Object.entries(TR.REPORTS).map(([id, r]) => ({ id, title: r.title, description: r.description, params: r.params || [] })) });
}));
router.get('/tenders/reports/:id', ...view, wrap(async (req, res) => {
  const fd = await T.listSettings(db0);
  const report = await TR.run(q, req.params.id, req.query, fd.labels);
  if (!report) return notFound(res);
  const format = u.oneOf(req.query.format, reporting.FORMATS, 'html');
  if (format !== 'html') await audit(db0, req.user, 'report_exported', 'report', `tenders:${report.id}`, format, null, req.ip);
  if (reporting.send(res, format, report, req.user)) return undefined;
  return res.render('staff/tender_report', { title: report.title, report, cell: reporting.cell, qs: qsOf(req.query), query: req.query, takesPeriod: (TR.REPORTS[report.id].params || []).includes('from') });
}));

// ---------------------------------------------------------------- create
router.get('/tenders/new', ...manage, wrap(async (req, res) => {
  const form = { currency: undefined };
  const oid = u.id(req.query.opportunity);
  if (oid) {
    const o = (await q(`select o.id, o.name, o.customer_id, o.prospect, o.value, o.currency, c.name as customer_name from opportunities o left join customers c on c.id = o.customer_id where o.id = $1`, [oid])).rows[0];
    if (o) Object.assign(form, { opportunity_id: o.id, title: o.name, issuer: o.customer_name || o.prospect, customer_id: o.customer_id || '', est_value: o.value || '', currency: o.currency });
  }
  res.render('staff/tender_new', { title: 'Register a tender', form, ownerId: req.user.id, ...(await formData(req.user)) });
}));

router.post('/tenders', ...manage, wrap(async (req, res) => {
  const fd = await formData(req.user);
  try {
    const f = T.readFields(req.body, fd);
    const owner = u.id(req.body.owner_id) || req.user.id;
    const status = u.oneOf(req.body.status, ['identified', 'registered'], 'registered');
    const t = await tx(async (db) => {
      try { return await T.create(db, f, owner, req.user, status); } catch (e) {
        if (e.code === '23503') throw new UserError('The customer, opportunity or owner you chose does not exist.');
        throw e;
      }
    });
    req.flash('success', `Tender ${t.ref} registered.`);
    return res.redirect(`/tenders/${t.id}`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    return res.status(400).render('staff/tender_new', { title: 'Register a tender', form: req.body, ownerId: u.id(req.body.owner_id) || req.user.id, ...fd, error: err.userMessage || err.message });
  }
}));

// ---------------------------------------------------------------- detail
async function load(id) {
  return id ? (await q(
    `select t.*, o.name as owner_name, c.name as customer_name, op.ref as opp_ref, op.name as opp_name, op.stage as opp_stage, co.id as contract_id, co.reference as contract_ref
       from tenders t join users o on o.id = t.owner_id left join customers c on c.id = t.customer_id left join opportunities op on op.id = t.opportunity_id
       left join contracts co on co.tender_id = t.id where t.id = $1`, [id])).rows[0] : null;
}

router.get('/tenders/:id', ...view, wrap(async (req, res) => {
  const id = u.id(req.params.id); const t = await load(id);
  if (!t) return notFound(res);
  const fd = await formData(req.user);
  const tasks = (await q(`select k.*, a.name as assignee_name, d.name as done_by_name from tender_tasks k left join users a on a.id = k.assignee_id left join users d on d.id = k.done_by where k.tender_id = $1 order by k.section, (k.done_at is not null), k.due_at nulls last, k.id`, [id])).rows;
  const events = (await q(`select e.*, u.name as actor_name from tender_events e left join users u on u.id = e.actor_id where e.tender_id = $1 order by e.id desc limit 300`, [id])).rows;
  const members = (await q(`select m.user_id, m.role, u.name from tender_members m join users u on u.id = m.user_id where m.tender_id = $1 order by u.name`, [id])).rows;
  const reviews = (await q(`select r.*, u.name as reviewer_name from tender_reviews r join users u on u.id = r.reviewer_id where r.tender_id = $1 order by r.id desc`, [id])).rows;
  const evals = (await q(`select e.*, u.name as by from tender_evaluations e left join users u on u.id = e.created_by where e.tender_id = $1 order by e.event_date nulls last, e.id`, [id])).rows;
  const mail = (await q(`select kind, recipient_email, status, last_error, created_at from notifications where tender_id = $1 order by id desc limit 15`, [id])).rows;
  const left = new Date(t.submission_due).getTime() - Date.now();
  const sections = {}; for (const k of tasks) (sections[k.section] = sections[k.section] || []).push(k);
  const review = T.reviewSummary(reviews);
  res.render('staff/tender', {
    title: t.ref, t, tasks, sections, events, members, reviews, review, approved: T.approvedAll(review), evals, mail, files: await docs.list(db0, 'tender', id), docKinds: docs.KINDS.tender,
    next: T.TRANSITIONS[t.status] || [], ...fd, T, myStages: T.stagesFor(req.user.role),
    leftText: T.PRE_SUBMISSION.includes(t.status) ? (left < 0 ? `overdue by ${charts.duration(-left)}` : `${charts.duration(left)} left`) : '', overdue: left < 0 && T.PRE_SUBMISSION.includes(t.status),
    canManage: perms.can(req.user, 'tender.manage'), canContribute: perms.can(req.user, 'tender.contribute'), canReview: perms.can(req.user, 'tender.review'), canContract: perms.can(req.user, 'contract.manage'),
    canPipeline: perms.can(req.user, 'pipeline.view'),
  });
}));

router.post('/tenders/:id', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const fd = await formData(req.user);
  const f = T.readFields(req.body, fd);
  const owner = u.id(req.body.owner_id);
  if (!owner) throw new UserError('Choose the owner.');
  const ch = await tx(async (db) => {
    try { return await T.update(db, id, f, owner, req.user); } catch (e) {
      if (e.code === '23503') throw new UserError('The customer, opportunity or owner you chose does not exist.');
      throw e;
    }
  });
  req.flash('success', ch.length ? 'Saved.' : 'Nothing changed.');
  res.redirect(`/tenders/${id}`);
}));

router.post('/tenders/:id/status', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const to = u.oneOf(req.body.status, T.STATUSES);
  if (!to) throw new UserError('Choose the new status.');
  const fd = await T.listSettings(db0);
  const awardRaw = u.money(req.body.award_value);
  if (Number.isNaN(awardRaw)) throw new UserError('The award value must be a positive number.');
  await tx((db) => T.move(db, id, to, { actor: req.user, reason: req.body.reason, note: req.body.outcome_note, awardValue: awardRaw, awardedTo: req.body.awarded_to, awardedOn: req.body.awarded_on,
    method: req.body.method, reference: req.body.reference, requireReviews: fd.requireReviews, labels: fd.labels }));
  req.flash('success', `Status changed to ${fd.labels[to]}.`);
  res.redirect(`/tenders/${id}`);
}));

// checklist, team, reviews, evaluation
const exists = async (id) => (id ? (await q('select 1 from tenders where id = $1', [id])).rows.length > 0 : false);
router.post('/tenders/:id/tasks', ...contribute, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  if (!(await exists(id))) return notFound(res);
  const due = req.body.due_at ? tz.localToDate(req.body.due_at, config.timezone) : null;
  if (req.body.due_at && !due) throw new UserError('The due date is not valid.');
  await tx(async (db) => {
    if (req.body.standard) { const n = await T.addStandardChecklist(db, id, req.user); req.flash('success', n ? `Added ${n} checklist items.` : 'The standard checklist is already on this tender.'); return; }
    await T.addTask(db, id, { title: req.body.title, section: req.body.section, assigneeId: u.id(req.body.assignee_id), dueAt: due, notes: req.body.notes }, req.user);
  });
  res.redirect(`/tenders/${id}#checklist`);
}));
router.post('/tenders/:id/tasks/:taskId/toggle', ...contribute, wrap(async (req, res) => {
  const id = u.id(req.params.id); const tid = u.id(req.params.taskId);
  const own = tid ? (await q('select 1 from tender_tasks where id = $1 and tender_id = $2', [tid, id])).rows[0] : null;
  if (!own) return notFound(res);
  await tx((db) => T.toggleTask(db, tid, req.user));
  res.redirect(`/tenders/${id}#checklist`);
}));
router.post('/tenders/:id/tasks/:taskId/delete', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id); const tid = u.id(req.params.taskId);
  const t = tid ? (await q('select title from tender_tasks where id = $1 and tender_id = $2', [tid, id])).rows[0] : null;
  if (!t) return notFound(res);
  await tx(async (db) => { await db.query('delete from tender_tasks where id = $1', [tid]); await T.addEvent(db, id, req.user, 'task', `${req.user.name} removed the checklist item "${t.title}".`); });
  res.redirect(`/tenders/${id}#checklist`);
}));
router.post('/tenders/:id/members', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  if (!(await exists(id))) return notFound(res);
  await tx((db) => T.addMember(db, id, u.id(req.body.user_id), req.body.role, req.user));
  res.redirect(`/tenders/${id}#team`);
}));
router.post('/tenders/:id/members/:uid/remove', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  await tx((db) => T.removeMember(db, id, u.id(req.params.uid), req.user));
  res.redirect(`/tenders/${id}#team`);
}));
router.post('/tenders/:id/reviews', requireStaff, requirePerm('tender.review'), wrap(async (req, res) => {
  const id = u.id(req.params.id);
  await tx((db) => T.addReview(db, id, req.body, req.user));
  req.flash('success', 'Review recorded.');
  res.redirect(`/tenders/${id}#reviews`);
}));
router.post('/tenders/:id/evaluations', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  if (!(await exists(id))) return notFound(res);
  await tx((db) => T.addEvaluation(db, id, req.body, req.user));
  res.redirect(`/tenders/${id}#evaluation`);
}));

// documents (versioned)
router.post('/tenders/:id/files', requireStaff, requirePerm('tender.view'), upload.array('files', 5), csrf.protect, wrap(async (req, res) => {
  const storage = require('../lib/storage');
  const id = u.id(req.params.id);
  try {
    if (!(perms.can(req.user, 'tender.manage') || perms.can(req.user, 'tender.contribute'))) return res.status(403).render('error', { title: 'Not allowed', message: 'You do not have permission to add documents.' });
    const t = await load(id);
    if (!t) return notFound(res);
    const r = await docs.store(db0, req.files, { type: 'tender', id, customerId: t.customer_id, kind: req.body.kind, user: req.user });
    for (const s of r.stored) await T.addEvent(db0, id, req.user, 'document', `${req.user.name} added "${s.filename}" (${docs.KINDS.tender[s.kind]}, version ${s.version}).`);
    if (r.rejected.length) req.flash('error', `Some files were not kept: ${r.rejected.join('; ')}`);
    else if (r.stored.length) req.flash('success', 'Document added.');
    res.redirect(`/tenders/${id}#documents`);
  } finally { await storage.removeTmp(req.files); }
}));

module.exports = router;
