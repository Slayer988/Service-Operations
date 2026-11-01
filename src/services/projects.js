'use strict';
// Projects: delivery work for a customer (or internal), with a manager, a team, tasks and milestones, a status and a health.
// Progress is not typed in: it is the share of tasks and milestones that are done, so it cannot drift from the work.
const { UserError } = require('./tickets');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const u = require('../lib/util');

const STATUS_LABELS = { planning: 'Planning', active: 'Active', on_hold: 'On hold', completed: 'Completed', cancelled: 'Cancelled' };
const STATUSES = Object.keys(STATUS_LABELS);
const OPEN = ['planning', 'active', 'on_hold'];                      // not finished: counted as delivery projects
const CLOSED = ['completed', 'cancelled'];
const HEALTH_LABELS = { green: 'On track', amber: 'At risk', red: 'Off track' };
const TASK_STATUS_LABELS = { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
const TASK_KIND_LABELS = { task: 'Task', milestone: 'Milestone' };

async function listSettings(db) {
  const st = await settings.getAll(db, ['currencies', 'default_currency']);
  return { currencies: Array.isArray(st.currencies) && st.currencies.length ? st.currencies : ['UGX', 'USD'], defaultCurrency: st.default_currency || 'UGX' };
}

async function addEvent(db, id, actor, kind, text) {
  await db.query('insert into project_events (project_id, actor_id, kind, text) values ($1,$2,$3,$4)', [id, actor ? actor.id : null, kind, String(text).slice(0, 2000)]);
}

/** Clean and check the editable fields. opts: { currencies, defaultCurrency } */
function readFields(b, opts) {
  const name = u.str(b.name, 200);
  if (!name) throw new UserError('Enter a name for the project.');
  const manager = u.id(b.manager_id);
  if (!manager) throw new UserError('Choose the project manager.');
  const start = b.start_date ? u.dateStr(b.start_date) : null; const end = b.end_date ? u.dateStr(b.end_date) : null;
  if (b.start_date && !start) throw new UserError('The start date is not valid.');
  if (b.end_date && !end) throw new UserError('The planned end date is not valid.');
  if (start && end && end < start) throw new UserError('The planned end date cannot be before the start date.');
  const budget = u.money(b.budget);
  if (Number.isNaN(budget)) throw new UserError('The budget must be a positive number.');
  return {
    name, customer_id: u.id(b.customer_id), opportunity_id: u.id(b.opportunity_id), contract_id: u.id(b.contract_id), manager_id: manager,
    status: u.oneOf(b.status, STATUSES, 'planning'), health: u.oneOf(b.health, Object.keys(HEALTH_LABELS), 'green'),
    start_date: start, end_date: end, budget, currency: opts.currencies.includes(b.currency) ? b.currency : opts.defaultCurrency,
    description: u.str(b.description, 5000), status_note: u.str(b.status_note, 1000),
  };
}
const COLS = ['name', 'customer_id', 'opportunity_id', 'contract_id', 'manager_id', 'status', 'health', 'start_date', 'end_date', 'budget', 'currency', 'description', 'status_note'];

function fkError(e) {
  if (e.code === '23503') return new UserError('The customer, deal, contract or manager you chose does not exist.');
  if (e.code === '23514') return new UserError('Check the dates: the planned end cannot be before the start.');
  return e;
}

async function create(db, f, actor) {
  let p;
  try {
    p = (await db.query(
      `insert into projects (${COLS.join(', ')}, closed_at, created_by) values (${COLS.map((_, i) => `$${i + 1}`).join(', ')}, case when $${COLS.length + 1} then now() end, $${COLS.length + 2}) returning *`,
      [...COLS.map((c) => f[c] === undefined ? null : f[c]), CLOSED.includes(f.status), actor.id])).rows[0];
  } catch (e) { throw fkError(e); }
  await db.query('insert into project_members (project_id, user_id, role) values ($1,$2,$3) on conflict do nothing', [p.id, f.manager_id, 'Project manager']);
  await addEvent(db, p.id, actor, 'created', `${actor.name} created the project ${p.ref}.`);
  await audit(db, actor, 'project_created', 'project', p.ref, p.name, p.customer_id, '');
  return p;
}

async function update(db, id, f, actor) {
  const old = (await db.query('select * from projects where id = $1 for update', [id])).rows[0];
  if (!old) throw new UserError('Project not found.', 404);
  const closing = CLOSED.includes(f.status);
  let p;
  try {
    p = (await db.query(
      `update projects set ${COLS.map((c, i) => `${c} = $${i + 2}`).join(', ')},
              closed_at = case when $${COLS.length + 2} then coalesce(closed_at, now()) else null end, updated_at = now() where id = $1 returning *`,
      [id, ...COLS.map((c) => f[c] === undefined ? null : f[c]), closing])).rows[0];
  } catch (e) { throw fkError(e); }
  await db.query('insert into project_members (project_id, user_id, role) values ($1,$2,$3) on conflict do nothing', [id, f.manager_id, 'Project manager']);
  const changed = [];
  if (old.status !== p.status) changed.push(`status from ${STATUS_LABELS[old.status]} to ${STATUS_LABELS[p.status]}`);
  if (old.health !== p.health) changed.push(`health from ${HEALTH_LABELS[old.health]} to ${HEALTH_LABELS[p.health]}`);
  if (old.manager_id !== p.manager_id) changed.push('the project manager');
  for (const [k, label] of [['name', 'the name'], ['customer_id', 'the customer'], ['start_date', 'the start date'], ['end_date', 'the planned end date'], ['budget', 'the budget'], ['status_note', 'the status note'], ['description', 'the description']]) {
    if (String(old[k] ?? '') !== String(p[k] ?? '')) changed.push(label);
  }
  if (changed.length) await addEvent(db, id, actor, 'edited', `${actor.name} changed ${changed.join(', ')}.`);
  if (old.status !== p.status) await audit(db, actor, 'project_status', 'project', p.ref, `${old.status} -> ${p.status}`, p.customer_id, '');
  return p;
}

/** Flag or clear an escalation (leadership support needed). */
async function setEscalation(db, id, on, note, actor) {
  const old = (await db.query('select * from projects where id = $1 for update', [id])).rows[0];
  if (!old) throw new UserError('Project not found.', 404);
  const text = u.str(note, 500);
  if (on && !text) throw new UserError('Say what leadership needs to help with.');
  await db.query('update projects set escalated = $2, escalation_note = $3, updated_at = now() where id = $1', [id, !!on, on ? text : '']);
  await addEvent(db, id, actor, 'escalation', on ? `${actor.name} escalated the project: ${text}` : `${actor.name} cleared the escalation.`);
  await audit(db, actor, on ? 'project_escalated' : 'project_escalation_cleared', 'project', old.ref, text, old.customer_id, '');
}

// ---------------------------------------------------------------- tasks and milestones
function readTask(b) {
  const title = u.str(b.title, 200);
  if (!title) throw new UserError('Enter what needs to be done.');
  if (b.due_date && !u.dateStr(b.due_date)) throw new UserError('The due date is not valid.');
  return { title, kind: u.oneOf(b.kind, Object.keys(TASK_KIND_LABELS), 'task'), assignee_id: u.id(b.assignee_id), due_date: b.due_date ? u.dateStr(b.due_date) : null };
}
async function addTask(db, projectId, f, actor) {
  try {
    const t = (await db.query('insert into project_tasks (project_id, kind, title, assignee_id, due_date, created_by) values ($1,$2,$3,$4,$5,$6) returning *', [projectId, f.kind, f.title, f.assignee_id, f.due_date, actor.id])).rows[0];
    await db.query('update projects set updated_at = now() where id = $1', [projectId]);
    await addEvent(db, projectId, actor, 'task', `${actor.name} added the ${TASK_KIND_LABELS[f.kind].toLowerCase()} "${f.title}".`);
    return t;
  } catch (e) { if (e.code === '23503') throw new UserError('That person does not exist.'); throw e; }
}
async function setTask(db, projectId, taskId, b, actor) {
  const old = (await db.query('select * from project_tasks where id = $1 and project_id = $2 for update', [taskId, projectId])).rows[0];
  if (!old) throw new UserError('Task not found.', 404);
  const status = u.oneOf(b.status, Object.keys(TASK_STATUS_LABELS), old.status);
  const assignee = b.assignee_id === undefined ? old.assignee_id : u.id(b.assignee_id);
  if (b.due_date && !u.dateStr(b.due_date)) throw new UserError('The due date is not valid.');
  const due = b.due_date === undefined ? old.due_date : (b.due_date ? u.dateStr(b.due_date) : null);
  try {
    await db.query(`update project_tasks set status = $3, assignee_id = $4, due_date = $5, done_at = case when $3 = 'done' then coalesce(done_at, now()) else null end where id = $1 and project_id = $2`, [taskId, projectId, status, assignee, due]);
  } catch (e) { if (e.code === '23503') throw new UserError('That person does not exist.'); throw e; }
  await db.query('update projects set updated_at = now() where id = $1', [projectId]);
  if (status !== old.status) await addEvent(db, projectId, actor, 'task', `${actor.name} marked "${old.title}" as ${TASK_STATUS_LABELS[status].toLowerCase()}.`);
}

/** Pure: progress (0-100) from task rows; cancelled tasks do not count. null when there is nothing to measure. */
function progress(tasks) {
  const live = tasks.filter((t) => t.status !== 'cancelled');
  return live.length ? Math.round((100 * live.filter((t) => t.status === 'done').length) / live.length) : null;
}

// ---------------------------------------------------------------- team
async function addMember(db, projectId, userId, role, actor) {
  const user = (await db.query(`select id, name from users where id = $1 and kind = 'staff' and active`, [userId])).rows[0];
  if (!user) throw new UserError('Choose a member of staff.');
  await db.query('insert into project_members (project_id, user_id, role) values ($1,$2,$3) on conflict (project_id, user_id) do update set role = excluded.role', [projectId, userId, u.str(role, 80)]);
  await addEvent(db, projectId, actor, 'team', `${actor.name} added ${user.name} to the team.`);
}
async function removeMember(db, projectId, userId, actor) {
  const p = (await db.query('select manager_id from projects where id = $1', [projectId])).rows[0];
  if (p && p.manager_id === userId) throw new UserError('The project manager is always on the team. Change the manager first.');
  const r = await db.query('delete from project_members pm using users us where pm.project_id = $1 and pm.user_id = $2 and us.id = pm.user_id returning us.name', [projectId, userId]);
  if (r.rows[0]) await addEvent(db, projectId, actor, 'team', `${actor.name} removed ${r.rows[0].name} from the team.`);
}

module.exports = { STATUS_LABELS, STATUSES, OPEN, CLOSED, HEALTH_LABELS, TASK_STATUS_LABELS, TASK_KIND_LABELS, listSettings, readFields, create, update, setEscalation, readTask, addTask, setTask, progress, addMember, removeMember };
