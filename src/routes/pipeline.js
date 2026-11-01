'use strict';
// Pipeline tracker (PT-001 .. PT-030): opportunities, forecasts and Service Delivery Engineer (SDE) support.
// Commercial staff (pipeline.view) see every opportunity. An SDE (pipeline.support) sees only the opportunities assigned to them,
// can record technical work but cannot change commercial values, stages or ownership.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const csrf = require('../lib/csrf');
const audit = require('../lib/audit');
const u = require('../lib/util');
const charts = require('../lib/charts');
const reporting = require('../lib/reporting');
const tickets = require('../services/tickets');
const P = require('../services/pipeline');
const PR = require('../services/pipeline_reports');
const docs = require('../services/documents');
const { upload, wrap } = require('./util');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
const db0 = { query: q };
const UserError = tickets.UserError;
const forbidden = (res) => res.status(403).render('error', { title: 'Not allowed', message: 'Your role does not allow this action.' });
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That opportunity does not exist.' });
const today = () => new Date().toISOString().slice(0, 10);
const qsOf = (query, skip = ['format']) => new URLSearchParams(Object.entries(query).filter(([k, v]) => !skip.includes(k) && typeof v === 'string' && v)).toString();

// anyone with pipeline.view or pipeline.support gets in; what they see is decided per request
const gate = [requireStaff, (req, res, next) => (perms.can(req.user, 'pipeline.view') || perms.can(req.user, 'pipeline.support') ? next() : forbidden(res))];
const full = [requireStaff, (req, res, next) => (perms.can(req.user, 'pipeline.view') ? next() : forbidden(res))];
const manage = [requireStaff, (req, res, next) => (perms.can(req.user, 'pipeline.manage') ? next() : forbidden(res))];
const isManager = (user) => perms.can(user, 'pipeline.manage') || perms.can(user, 'pipeline.assign_sde');

const money = (v, c) => `${c} ${Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
async function formData(extra = {}) {
  const s = await P.listSettings(db0);
  return {
    customers: (await q('select id, name from customers order by name')).rows,
    staff: (await q(`select id, name from users where kind = 'staff' and active order by name`)).rows,
    ...s, stages: P.STAGES, money, ...extra,
  };
}
/** The opportunity if this user may see it, with their level of access. */
async function access(req, id) {
  if (!id) return null;
  const o = (await q(
    `select o.*, c.name as customer_name, c.industry as customer_industry, ow.name as owner_name, nso.name as next_owner_name, (o.next_step_date < current_date and o.stage = any($2)) as late
       from opportunities o left join customers c on c.id = o.customer_id join users ow on ow.id = o.owner_id left join users nso on nso.id = o.next_step_owner_id where o.id = $1`, [id, P.ACTIVE])).rows[0];
  if (!o) return null;
  const fullView = perms.can(req.user, 'pipeline.view');
  const assigned = (await q('select 1 from opportunity_engineers where opportunity_id = $1 and user_id = $2', [id, req.user.id])).rows.length > 0;
  if (!fullView && !(perms.can(req.user, 'pipeline.support') && assigned)) return null;
  const manager = isManager(req.user);
  return { o, fullView, assigned, escalate: fullView && perms.can(req.user, 'pipeline.escalate'), manage: perms.can(req.user, 'pipeline.manage'), assign: perms.can(req.user, 'pipeline.assign_sde'), support: manager || (assigned && perms.can(req.user, 'pipeline.support')) };
}
/** Wrap a handler that needs a given kind of access to the opportunity named by :id. */
const guarded = (need, fn) => [...gate, wrap(async (req, res) => {
  const a = await access(req, u.id(req.params.id));
  if (!a) return notFound(res);
  if (need && !a[need]) return forbidden(res);
  req.opp = a;
  return fn(req, res, a);
})];

// ---------------------------------------------------------------- register, dashboard
function filters(query, user) {
  const where = ['true']; const params = []; const f = {};
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  f.q = u.str(query.q, 100);
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); const n = params.length; where.push(`(o.name ilike $${n} or o.ref ilike $${n} or o.prospect ilike $${n} or c.name ilike $${n})`); }
  f.stage = u.oneOf(query.stage, [...P.STAGES, 'open']) || ''; if (f.stage === 'open') where.push(`o.stage = any(array['${P.OPEN.join("','")}'])`); else if (f.stage) add('o.stage = ?', f.stage);
  f.owner = query.owner === 'me' ? 'me' : (u.id(query.owner) || ''); if (f.owner) add('o.owner_id = ?', f.owner === 'me' ? user.id : f.owner);
  f.customer = u.id(query.customer) || ''; if (f.customer) add('o.customer_id = ?', f.customer);
  f.industry = u.str(query.industry, 80); if (f.industry) add('o.industry = ?', f.industry);
  f.classification = u.str(query.classification, 60); if (f.classification) add('o.classification = ?', f.classification);
  const vmin = u.money(query.value_min); const vmax = u.money(query.value_max);
  f.value_min = vmin === null || Number.isNaN(vmin) ? '' : vmin; f.value_max = vmax === null || Number.isNaN(vmax) ? '' : vmax;
  if (f.value_min !== '') add('o.value >= ?', f.value_min); if (f.value_max !== '') add('o.value <= ?', f.value_max);
  f.from = u.dateStr(query.from) || ''; f.to = u.dateStr(query.to) || '';
  if (f.from) add('o.expected_close >= ?::date', f.from); if (f.to) add('o.expected_close <= ?::date', f.to);
  return { where, params, f };
}
const LIST_SQL = `select o.id, o.ref, o.name, o.stage, o.value, o.currency, o.probability, o.owner_id, o.next_step, o.next_step_date, o.expected_close, o.lost_reason, o.industry, o.classification,
                         coalesce(c.name, nullif(o.prospect, '')) as org, ow.name as owner_name,
                         (o.expected_close < current_date and o.stage = any(array['${P.OPEN.join("','")}'])) as late,
                         (o.next_step_date < current_date and o.stage = any(array['${P.ACTIVE.join("','")}'])) as followup_late
                    from opportunities o left join customers c on c.id = o.customer_id join users ow on ow.id = o.owner_id`;

router.get('/pipeline', ...gate, wrap(async (req, res) => {
  if (!perms.can(req.user, 'pipeline.view')) return res.redirect('/pipeline/sde');
  const mode = req.query.view === 'list' ? 'list' : 'board';
  const { where, params, f } = filters(req.query, req.user);
  const rows = (await q(`${LIST_SQL} where ${where.join(' and ')} order by o.expected_close nulls last, o.id desc limit 1000`, params)).rows;
  const fd = await formData();
  const d = await PR.dashboard(q, today(), fd.defaultCurrency);
  const primary = d.currencies.includes(fd.defaultCurrency) ? fd.defaultCurrency : (d.currencies[0] || fd.defaultCurrency);
  const t = d.totals[primary] || { open: 0, weighted: 0, count: 0, stages: Object.fromEntries(P.OPEN.map((k) => [k, { count: 0, value: 0, weighted: 0 }])) };
  const fc = d.forecast[primary] || { months: [], quarters: [] };
  const stageChart = charts.hbars(P.OPEN.map((k) => ({ label: fd.labels[k], value: t.stages[k].value, text: `${t.stages[k].count} · ${Number(t.stages[k].value).toLocaleString('en-US', { maximumFractionDigits: 0 })}` })), { labelW: 38 });
  const monthChart = charts.hbars(fc.months.filter((m) => m.count).map((m) => ({ label: m.key, value: m.weighted, text: Number(m.weighted).toLocaleString('en-US', { maximumFractionDigits: 0 }) })));
  const customerChart = charts.hbars(d.byCustomer.filter((x) => x.currency === primary).map((x) => ({ label: x.label, value: x.weighted, text: Number(x.weighted).toLocaleString('en-US', { maximumFractionDigits: 0 }) })), { labelW: 38 });
  const byStage = Object.fromEntries(P.STAGES.map((k) => [k, rows.filter((r) => r.stage === k)]));
  res.render('staff/pipeline', {
    title: 'Pipeline Tracker', mode, rows, byStage, d, t, primary, fc, stageChart, monthChart, customerChart, money, ...fd, f, labels: fd.labels,
    others: d.currencies.filter((c) => c !== primary).map((c) => `${money(d.totals[c].open, c)} open / ${money(d.totals[c].weighted, c)} weighted`),
    canManage: perms.can(req.user, 'pipeline.manage'), qs: qsOf(req.query),
  });
}));

router.get('/pipeline/export', ...full, wrap(async (req, res) => {
  const { where, params } = filters(req.query, req.user);
  const labels = (await P.listSettings(db0)).labels;
  const rows = (await q(`${LIST_SQL} where ${where.join(' and ')} order by o.expected_close nulls last, o.id desc limit 5000`, params)).rows
    .map((r) => ({ ...r, stage_label: labels[r.stage], weighted: Math.round(Number(r.value) * r.probability) / 100 }));
  const columns = [{ key: 'ref', header: 'Reference', width: 14 }, { key: 'name', header: 'Opportunity', width: 32, weight: 3 }, { key: 'org', header: 'Customer / prospect', width: 26, weight: 2 }, { key: 'stage_label', header: 'Stage', width: 20 },
    { key: 'owner_name', header: 'Owner', width: 18 }, { key: 'value', header: 'Value', type: 'money', width: 16 }, { key: 'currency', header: 'Cur.', width: 7 }, { key: 'probability', header: 'Prob. %', type: 'integer', width: 9 },
    { key: 'weighted', header: 'Weighted value', type: 'money', width: 16 }, { key: 'expected_close', header: 'Expected close', type: 'date', width: 14 }, { key: 'next_step', header: 'Next step', width: 30 }];
  await audit(db0, req.user, 'report_exported', 'report', 'pipeline', `${rows.length} rows`, null, req.ip);
  if (!reporting.send(res, u.oneOf(req.query.format, ['csv', 'xlsx', 'pdf'], 'csv'), { title: 'Pipeline', subtitle: `${rows.length} opportunities`, columns, rows }, req.user)) res.redirect('/pipeline');
}));
router.get('/pipeline/export.csv', ...full, (req, res) => res.redirect(301, '/pipeline/export?format=csv'));

// ---------------------------------------------------------------- SDE dashboard (PT-024)
router.get('/pipeline/sde', ...gate, wrap(async (req, res) => {
  const mine = !isManager(req.user) && !perms.can(req.user, 'pipeline.view');
  const scope = mine || req.query.scope === 'me' ? req.user.id : null;
  const d = await PR.sdeDashboard(q, scope);
  res.render('staff/sde', { title: scope ? 'My Opportunities' : 'Engineering support', d, scope, mineOnly: mine, today: today(), labels: (await P.listSettings(db0)).labels, priorities: P.PRIORITIES, taskStatuses: P.TASK_STATUSES,
    canSeeAll: !mine });
}));

// ---------------------------------------------------------------- reports
router.get('/pipeline/reports', ...full, wrap(async (req, res) => {
  res.render('staff/pipeline_reports', { title: 'Pipeline reports', reports: Object.entries(PR.REPORTS).map(([id, r]) => ({ id, title: r.title, description: r.description })) });
}));
router.get('/pipeline/reports/:id', ...full, wrap(async (req, res) => {
  const labels = (await P.listSettings(db0)).labels;
  const report = await PR.run(q, req.params.id, req.query, labels);
  if (!report) return notFound(res);
  const format = u.oneOf(req.query.format, reporting.FORMATS, 'html');
  if (format !== 'html') await audit(db0, req.user, 'report_exported', 'report', `pipeline:${report.id}`, format, null, req.ip);
  if (reporting.send(res, format, report, req.user)) return undefined;
  return res.render('staff/pipeline_report', { title: report.title, report, cell: reporting.cell, qs: qsOf(req.query), query: req.query, takesPeriod: (PR.REPORTS[report.id].params || []).includes('from') });
}));

// ---------------------------------------------------------------- create
router.get('/pipeline/new', ...manage, wrap(async (req, res) => {
  res.render('staff/pipeline_new', { title: 'New opportunity', form: { customer_id: u.id(req.query.customer_id) || '' }, ownerId: req.user.id, ...(await formData()) });
}));
router.post('/pipeline', ...manage, wrap(async (req, res) => {
  const fd = await formData();
  try {
    const f = P.readFields(req.body, fd);
    const owner = u.id(req.body.owner_id) || req.user.id;
    const o = await tx(async (db) => {
      try { return await P.create(db, f, owner, req.user, fd.probs, { name: u.str(req.body.contact_name, 120), title: u.str(req.body.contact_title, 120), email: u.str(req.body.contact_email, 320), phone: u.str(req.body.contact_phone, 40) }); } catch (e) {
        if (e.code === '23503') throw new UserError('The customer or owner you chose does not exist.');
        throw e;
      }
    });
    req.flash('success', `Opportunity ${o.ref} created.`);
    return res.redirect(`/pipeline/${o.id}`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    return res.status(400).render('staff/pipeline_new', { title: 'New opportunity', ...fd, form: req.body, ownerId: u.id(req.body.owner_id) || req.user.id, error: err.userMessage || err.message });
  }
}));

// ---------------------------------------------------------------- detail
router.get('/pipeline/:id', ...guarded(null, async (req, res, a) => {
  const o = a.o; const id = o.id; const fd = await formData();
  const one = async (sql, p = [id]) => (await q(sql, p)).rows;
  const events = await one(`select e.*, u.name as actor_name from opportunity_events e left join users u on u.id = e.actor_id where e.opportunity_id = $1 order by e.id desc limit 300`);
  const contacts = await one('select * from opportunity_contacts where opportunity_id = $1 order by id');
  const activities = await one(`select a.*, u.name as by from opportunity_activities a left join users u on u.id = a.created_by where a.opportunity_id = $1 order by a.activity_date desc, a.id desc`);
  const proposals = await one(`select p.*, u.name as prepared_by_name from opportunity_proposals p left join users u on u.id = p.prepared_by where p.opportunity_id = $1 order by p.id desc`);
  const engineers = await one(`select u.id, u.name from opportunity_engineers e join users u on u.id = e.user_id where e.opportunity_id = $1 order by u.name`);
  const tasks = await one(`select t.*, u.name as assignee_name, (t.status <> 'completed' and t.due_date < current_date) as overdue from opp_tasks t left join users u on u.id = t.assignee_id where t.opportunity_id = $1 order by (t.status = 'completed'), t.due_date nulls last, t.id`);
  const history = await one(`select h.*, t.ref, u.name as actor_name from opp_task_history h join opp_tasks t on t.id = h.task_id left join users u on u.id = h.actor_id where t.opportunity_id = $1 order by h.id desc limit 60`);
  const solution = await one(`select s.*, u.name as author from opportunity_solution_items s left join users u on u.id = s.author_id where s.opportunity_id = $1 order by s.id desc`);
  const resources = await one(`select r.*, u.name as person from opportunity_resources r left join users u on u.id = r.user_id where r.opportunity_id = $1 order by r.id`);
  const linkedTenders = perms.can(req.user, 'tender.view') ? await one(`select id, ref, title, status, submission_due from tenders where opportunity_id = $1 order by id desc`) : [];
  const contracts = perms.can(req.user, 'contract.view') ? await one('select id, reference, title, status from contracts where opportunity_id = $1 order by id desc') : [];
  const staffAll = fd.staff;
  res.render('staff/opportunity', {
    title: o.ref, o, a, bar: (n) => charts.bar(n), events, contacts, activities, proposals, engineers, tasks, history, solution, resources, linkedTenders, contracts,
    files: await docs.list(db0, 'opportunity', id), docKinds: docs.KINDS.opportunity, progress: P.overallProgress(tasks), ...fd, labels: fd.labels, P, today: today(),
    isOpen: P.ACTIVE.includes(o.stage), stageIdx: P.OPEN.indexOf(o.stage), assignable: staffAll.filter((s) => !engineers.some((e) => e.id === s.id)),
    canTender: perms.can(req.user, 'tender.manage'), canProject: perms.can(req.user, 'project.manage'), canContract: perms.can(req.user, 'contract.manage'),
  });
}));

router.post('/pipeline/:id/escalation', ...guarded('escalate', async (req, res, a) => {
  const on = req.body.escalate === '1';
  await tx((db) => P.setEscalation(db, a.o.id, on, req.body.note, req.user));
  req.flash('success', on ? 'The opportunity is escalated.' : 'The escalation is cleared.');
  return res.redirect(`/pipeline/${a.o.id}`);
}));

router.post('/pipeline/:id', ...guarded('manage', async (req, res, a) => {
  const fd = await P.listSettings(db0);
  const f = P.readFields(req.body, fd);
  const owner = u.id(req.body.owner_id);
  if (!owner) throw new UserError('Choose the owner.');
  const probChanged = req.body.probability !== '' && req.body.probability !== undefined;
  await tx(async (db) => {
    try { await P.update(db, a.o.id, { ...f, probability: probChanged ? f.probability : null }, owner, req.user); } catch (e) {
      if (e.code === '23503') throw new UserError('The customer or owner you chose does not exist.');
      throw e;
    }
  });
  req.flash('success', 'Saved.');
  res.redirect(`/pipeline/${a.o.id}`);
}));

router.post('/pipeline/:id/stage', ...guarded('manage', async (req, res, a) => {
  const fd = await P.listSettings(db0);
  const stage = u.oneOf(req.body.stage, P.STAGES);
  if (!stage) throw new UserError('Choose a stage.');
  await tx((db) => P.move(db, a.o.id, stage, { reason: req.body.reason, actor: req.user, probs: fd.probs, labels: fd.labels }));
  req.flash('success', `Moved to ${fd.labels[stage]}.`);
  res.redirect(req.body.from === 'board' ? '/pipeline' : `/pipeline/${a.o.id}`);
}));

const act = (need, fn, message, anchor) => guarded(need, async (req, res, a) => {
  await tx((db) => fn(db, req, a.o.id, a));
  if (message) req.flash('success', message);
  return res.redirect(`/pipeline/${a.o.id}${anchor ? `#${anchor}` : ''}`);
});

// commercial
router.post('/pipeline/:id/contacts', ...act('manage', (db, req, id) => P.addContact(db, id, req.body, req.user), 'Contact added.', 'contacts'));
router.post('/pipeline/:id/contacts/:cid/remove', ...act('manage', (db, req, id) => P.removeContact(db, id, u.id(req.params.cid), req.user), null, 'contacts'));
router.post('/pipeline/:id/activities', ...act('support', (db, req, id) => P.addActivity(db, id, req.body, req.user), 'Activity recorded.', 'activities'));
router.post('/pipeline/:id/proposals', ...act('manage', (db, req, id) => P.addProposal(db, id, req.body, req.user), 'Proposal started.', 'proposals'));
router.post('/pipeline/:id/proposals/:pid', ...act('manage', (db, req, id) => P.setProposal(db, id, u.id(req.params.pid), req.body.status, req.user), null, 'proposals'));
router.post('/pipeline/:id/note', ...guarded('support', async (req, res, a) => {
  const text = u.str(req.body.text, 2000);
  if (!text) throw new UserError('Write a note first.');
  await P.addEvent(db0, a.o.id, req.user, 'note', `${req.user.name}: ${text}`);
  res.redirect(`/pipeline/${a.o.id}#history`);
}));
router.post('/pipeline/:id/followup', ...act('manage', async (db, req, id) => {
  const date = u.dateStr(req.body.next_step_date); if (req.body.next_step_date && !date) throw new UserError('The date is not valid.');
  await db.query('update opportunities set next_step = $2, next_step_date = $3, next_step_owner_id = $4, updated_at = now() where id = $1', [id, u.str(req.body.next_step, 300), date, u.id(req.body.next_step_owner_id)]);
  await P.addEvent(db, id, req.user, 'edited', `${req.user.name} set the next action: ${u.str(req.body.next_step, 300) || 'none'}${date ? ` (${date})` : ''}.`);
}, 'Next action saved.', 'details'));

// Service Delivery Engineers
router.post('/pipeline/:id/engineers', ...act('assign', (db, req, id) => P.assignEngineer(db, id, u.id(req.body.user_id), req.user), 'Engineer assigned.', 'support'));
router.post('/pipeline/:id/engineers/:uid/remove', ...act('assign', (db, req, id) => P.unassignEngineer(db, id, u.id(req.params.uid), req.user), 'Engineer removed.', 'support'));
router.post('/pipeline/:id/tasks', ...act('support', (db, req, id) => P.createTask(db, id, req.body, req.user), 'Task created.', 'tasks'));
router.post('/pipeline/:id/tasks/:tid', ...guarded('support', async (req, res, a) => {
  // an engineer works on their own tasks; managers can update any
  const t = (await q('select assignee_id from opp_tasks where id = $1 and opportunity_id = $2', [u.id(req.params.tid), a.o.id])).rows[0];
  if (!t) return notFound(res);
  if (!isManager(req.user) && t.assignee_id !== null && t.assignee_id !== req.user.id) return forbidden(res);
  const body = isManager(req.user) ? req.body : { status: req.body.status, progress: req.body.progress, work_notes: req.body.work_notes };
  const bits = await tx((db) => P.updateTask(db, a.o.id, u.id(req.params.tid), body, req.user));
  req.flash('success', bits.length ? 'Task updated.' : 'Nothing changed.');
  res.redirect(`/pipeline/${a.o.id}#tasks`);
}));
router.post('/pipeline/:id/solution', ...act('support', (db, req, id) => P.addSolutionItem(db, id, req.body, req.user), 'Recorded.', 'solution'));
router.post('/pipeline/:id/solution/:sid', ...act('support', (db, req, id) => P.setSolutionItem(db, id, u.id(req.params.sid), req.body.status, req.user), null, 'solution'));
router.post('/pipeline/:id/resources', ...act('support', (db, req, id) => P.addResource(db, id, req.body, req.user), 'Resource recorded.', 'resources'));
router.post('/pipeline/:id/resources/:rid', ...act('support', (db, req, id) => P.updateResource(db, id, u.id(req.params.rid), req.body, req.user), null, 'resources'));
router.post('/pipeline/:id/support-notes', ...act('support', (db, req, id) => P.saveSupportNotes(db, id, req.body, req.user), 'Saved.', 'notes'));

// Opportunity Support Report (PT-028): on screen, PDF or Excel
router.get('/pipeline/:id/support-report', ...guarded(null, async (req, res, a) => {
  const from = u.dateStr(req.query.from); const to = u.dateStr(req.query.to);
  const r = await P.supportReportData(db0, a.o.id, { from, to });
  const labels = (await P.listSettings(db0)).labels;
  const format = u.oneOf(req.query.format, ['html', 'pdf', 'xlsx'], 'html');
  if (format !== 'html') {
    await audit(db0, req.user, 'report_exported', 'report', `support:${a.o.ref}`, format, a.o.customer_id, req.ip);
    const base = `opportunity-support-report-${a.o.ref}-${today()}`;
    if (format === 'pdf') { res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${base}.pdf"` }); return res.send(PR.supportPdf(r, labels)); }
    res.set({ 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'Content-Disposition': `attachment; filename="${base}.xlsx"` });
    return res.send(PR.supportXlsx(r, req.user, labels));
  }
  return res.render('staff/support_report', { title: `Support report ${a.o.ref}`, r, sections: PR.supportSections(r, labels), from: from || '', to: to || '', o: a.o, qs: qsOf(req.query) });
}));

// documents (versioned); an engineer may add evidence to an opportunity they are assigned to
router.post('/pipeline/:id/files', ...gate, upload.array('files', 5), csrf.protect, wrap(async (req, res) => {
  const storage = require('../lib/storage');
  try {
    const a = await access(req, u.id(req.params.id));
    if (!a) return notFound(res);
    if (!a.support && !a.manage) return forbidden(res);
    const r = await docs.store(db0, req.files, { type: 'opportunity', id: a.o.id, customerId: a.o.customer_id, kind: req.body.kind, user: req.user });
    for (const s of r.stored) await P.addEvent(db0, a.o.id, req.user, 'document', `${req.user.name} added "${s.filename}" (${docs.KINDS.opportunity[s.kind]}, version ${s.version}).`);
    if (r.rejected.length) req.flash('error', `Some files were not kept: ${r.rejected.join('; ')}`);
    else if (r.stored.length) req.flash('success', 'Document added.');
    return res.redirect(`/pipeline/${a.o.id}#documents`);
  } finally { await storage.removeTmp(req.files); }
}));

module.exports = router;
