'use strict';
// Projects: register, new project, project page with tasks and milestones, team, escalation and activity.
// Everyone with project.view sees every project. Managers (project.manage) change anything; a member of the team who has
// project.contribute adds and updates tasks on the projects they are on.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const u = require('../lib/util');
const charts = require('../lib/charts');
const tickets = require('../services/tickets');
const PJ = require('../services/projects');
const { wrap } = require('./util');
const { requireStaff } = require('../middleware/auth');

const router = express.Router();
const db0 = { query: q };
const UserError = tickets.UserError;
const forbidden = (res) => res.status(403).render('error', { title: 'Not allowed', message: 'Your role does not allow this action.' });
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That project does not exist.' });
const view = [requireStaff, (req, res, next) => (perms.can(req.user, 'project.view') ? next() : forbidden(res))];
const manage = [requireStaff, (req, res, next) => (perms.can(req.user, 'project.manage') ? next() : forbidden(res))];
const money = (v, c) => `${c} ${Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

async function formData(extra = {}) {
  return {
    customers: (await q('select id, name from customers order by name')).rows,
    staff: (await q(`select id, name from users where kind = 'staff' and active order by name`)).rows,
    opportunities: (await q(`select id, ref, name from opportunities order by id desc limit 300`)).rows,
    contracts: (await q(`select id, reference, title from contracts where status in ('active','expiring_soon','renewal_in_progress') order by id desc limit 300`)).rows,
    ...(await PJ.listSettings(db0)), statusLabels: PJ.STATUS_LABELS, healthLabels: PJ.HEALTH_LABELS, ...extra,
  };
}

const LIST_SQL = `select p.*, c.name as customer_name, m.name as manager_name,
    (select count(*)::int from project_tasks t where t.project_id = p.id and t.status <> 'cancelled') as task_total,
    (select count(*)::int from project_tasks t where t.project_id = p.id and t.status = 'done') as task_done,
    (select count(*)::int from project_tasks t where t.project_id = p.id and t.status in ('open','in_progress') and t.due_date < current_date) as task_overdue,
    (p.end_date < current_date and p.status in ('planning','active','on_hold')) as late
  from projects p left join customers c on c.id = p.customer_id join users m on m.id = p.manager_id`;

function filters(query, user) {
  const where = ['true']; const params = []; const f = {};
  f.status = ['open', ...PJ.STATUSES].includes(query.status) ? query.status : '';
  if (f.status === 'open') { params.push(PJ.OPEN); where.push(`p.status = any($${params.length})`); } else if (f.status) { params.push(f.status); where.push(`p.status = $${params.length}`); }
  f.health = u.oneOf(query.health, Object.keys(PJ.HEALTH_LABELS), '');
  if (f.health) { params.push(f.health); where.push(`p.health = $${params.length}`); }
  f.customer = u.id(query.customer_id) || '';
  if (f.customer) { params.push(f.customer); where.push(`p.customer_id = $${params.length}`); }
  f.mine = query.mine === '1';
  if (f.mine) { params.push(user.id); where.push(`exists (select 1 from project_members pm where pm.project_id = p.id and pm.user_id = $${params.length})`); }
  f.escalated = query.escalated === '1';
  if (f.escalated) where.push('p.escalated');
  f.q = u.str(query.q, 100);
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); const n = params.length; where.push(`(p.name ilike $${n} or p.ref ilike $${n} or c.name ilike $${n})`); }
  return { where, params, f };
}

router.get('/projects', ...view, wrap(async (req, res) => {
  const { where, params, f } = filters(req.query, req.user);
  const rows = (await q(`${LIST_SQL} where ${where.join(' and ')} order by (p.status in ('completed','cancelled')), p.end_date nulls last, p.id desc limit 500`, params)).rows
    .map((r) => ({ ...r, progress: r.task_total ? Math.round((100 * r.task_done) / r.task_total) : null }));
  const k = (await q(
    `select count(*) filter (where status in ('planning','active','on_hold'))::int as open, count(*) filter (where status = 'active')::int as active,
            count(*) filter (where status in ('planning','active','on_hold') and health = 'red')::int as red, count(*) filter (where status in ('planning','active','on_hold') and escalated)::int as escalated,
            count(*) filter (where status in ('planning','active','on_hold') and end_date < current_date)::int as late, count(*) filter (where status = 'completed')::int as completed from projects`)).rows[0];
  res.render('staff/projects', { title: 'Projects', rows, k, f, ...(await formData()), canManage: perms.can(req.user, 'project.manage'), bar: (n) => charts.bar(n), money });
}));

router.get('/projects/new', ...manage, wrap(async (req, res) => {
  const fd = await formData();
  const form = { manager_id: req.user.id, status: 'planning', health: 'green', currency: fd.defaultCurrency };
  const oid = u.id(req.query.opportunity_id);
  if (oid) {                                                                  // start from a won deal
    const o = (await q('select id, name, customer_id, value, currency from opportunities where id = $1', [oid])).rows[0];
    if (o) Object.assign(form, { name: o.name, customer_id: o.customer_id || '', opportunity_id: o.id });
  }
  res.render('staff/project_new', { title: 'New project', form, ...fd });
}));

router.post('/projects', ...manage, wrap(async (req, res) => {
  const fd = await formData();
  try {
    const f = PJ.readFields(req.body, fd);
    const p = await tx((db) => PJ.create(db, f, req.user));
    req.flash('success', `Project ${p.ref} created.`);
    return res.redirect(`/projects/${p.id}`);
  } catch (err) {
    if (!(err instanceof UserError)) throw err;
    return res.status(400).render('staff/project_new', { title: 'New project', ...fd, form: req.body, error: err.userMessage || err.message });
  }
}));

/** The project and what this person may do with it. */
async function access(req, id) {
  if (!id) return null;
  const p = (await q(`${LIST_SQL} where p.id = $1`, [id])).rows[0];
  if (!p) return null;
  const member = (await q('select 1 from project_members where project_id = $1 and user_id = $2', [id, req.user.id])).rows.length > 0;
  const manager = perms.can(req.user, 'project.manage');
  return { p, member, manage: manager, work: manager || (member && perms.can(req.user, 'project.contribute')) };
}
const guarded = (need, fn) => [...view, wrap(async (req, res) => {
  const a = await access(req, u.id(req.params.id));
  if (!a) return notFound(res);
  if (need && !a[need]) return forbidden(res);
  try { return await fn(req, res, a); } catch (err) {
    if (!(err instanceof UserError)) throw err;
    req.flash('error', err.userMessage || err.message);
    return res.redirect(`/projects/${a.p.id}`);
  }
})];

router.get('/projects/:id', ...guarded(null, async (req, res, a) => {
  const id = a.p.id; const fd = await formData();
  const tasks = (await q(`select t.*, u.name as assignee_name, (t.status in ('open','in_progress') and t.due_date < current_date) as overdue from project_tasks t left join users u on u.id = t.assignee_id
                          where t.project_id = $1 order by (t.status in ('done','cancelled')), t.due_date nulls last, t.id`, [id])).rows;
  const team = (await q('select u.id, u.name, pm.role from project_members pm join users u on u.id = pm.user_id where pm.project_id = $1 order by (u.id = $2) desc, u.name', [id, a.p.manager_id])).rows;
  const events = (await q('select e.*, u.name as actor_name from project_events e left join users u on u.id = e.actor_id where e.project_id = $1 order by e.id desc limit 200', [id])).rows;
  const opp = a.p.opportunity_id && perms.can(req.user, 'pipeline.view') ? (await q('select id, ref, name from opportunities where id = $1', [a.p.opportunity_id])).rows[0] : null;
  const contract = a.p.contract_id && perms.can(req.user, 'contract.view') ? (await q('select id, reference, title from contracts where id = $1', [a.p.contract_id])).rows[0] : null;
  res.render('staff/project', {
    title: a.p.ref, p: a.p, a, tasks, team, events, opp, contract, progress: PJ.progress(tasks), bar: (n) => charts.bar(n), money, ...fd,
    taskStatuses: PJ.TASK_STATUS_LABELS, taskKinds: PJ.TASK_KIND_LABELS, addable: fd.staff.filter((s) => !team.some((m) => m.id === s.id)),
  });
}));

router.post('/projects/:id', ...guarded('manage', async (req, res, a) => {
  const fd = await PJ.listSettings(db0);
  const f = PJ.readFields(req.body, fd);
  await tx((db) => PJ.update(db, a.p.id, f, req.user));
  req.flash('success', 'Project saved.');
  return res.redirect(`/projects/${a.p.id}`);
}));

router.post('/projects/:id/escalation', ...guarded('manage', async (req, res, a) => {
  const on = req.body.escalate === '1';
  await tx((db) => PJ.setEscalation(db, a.p.id, on, req.body.note, req.user));
  req.flash('success', on ? 'The project is escalated.' : 'The escalation is cleared.');
  return res.redirect(`/projects/${a.p.id}`);
}));

router.post('/projects/:id/tasks', ...guarded('work', async (req, res, a) => {
  const f = PJ.readTask(req.body);
  await tx((db) => PJ.addTask(db, a.p.id, f, req.user));
  req.flash('success', `${PJ.TASK_KIND_LABELS[f.kind]} added.`);
  return res.redirect(`/projects/${a.p.id}#tasks`);
}));
router.post('/projects/:id/tasks/:tid', ...guarded('work', async (req, res, a) => {
  const tid = u.id(req.params.tid);
  if (!tid) throw new UserError('Task not found.');
  await tx((db) => PJ.setTask(db, a.p.id, tid, req.body, req.user));
  return res.redirect(`/projects/${a.p.id}#tasks`);
}));

router.post('/projects/:id/team', ...guarded('manage', async (req, res, a) => {
  const uid = u.id(req.body.user_id);
  if (!uid) throw new UserError('Choose a member of staff.');
  await tx((db) => PJ.addMember(db, a.p.id, uid, req.body.role, req.user));
  req.flash('success', 'Team member added.');
  return res.redirect(`/projects/${a.p.id}#team`);
}));
router.post('/projects/:id/team/:uid/remove', ...guarded('manage', async (req, res, a) => {
  const uid = u.id(req.params.uid);
  if (!uid) throw new UserError('Team member not found.');
  await tx((db) => PJ.removeMember(db, a.p.id, uid, req.user));
  return res.redirect(`/projects/${a.p.id}#team`);
}));

module.exports = router;
