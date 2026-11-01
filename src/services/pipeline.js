'use strict';
// Pipeline tracker (PT-001 .. PT-030): opportunities, weighted forecasts, and Service Delivery Engineer (SDE) support
// with tasks, activities, solution work, resources, evidence and the Opportunity Support Report.
const { UserError } = require('./tickets');
const notifications = require('./notifications');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const u = require('../lib/util');
const config = require('../config');

const STAGES = ['lead_identification', 'prospecting', 'qualification', 'solution_development', 'proposal_submission', 'negotiation', 'closing', 'won', 'lost', 'on_hold'];
const STAGE_LABELS = { lead_identification: 'Lead Identification', prospecting: 'Prospecting', qualification: 'Qualification', solution_development: 'Solution Development', proposal_submission: 'Proposal Submission',
  negotiation: 'Negotiation', closing: 'Closing', won: 'Won', lost: 'Lost', on_hold: 'On Hold' };
const DEFAULT_PROB = { lead_identification: 5, prospecting: 10, qualification: 25, solution_development: 40, proposal_submission: 60, negotiation: 75, closing: 90, won: 100, lost: 0, on_hold: 10 };
const OPEN = ['lead_identification', 'prospecting', 'qualification', 'solution_development', 'proposal_submission', 'negotiation', 'closing'];   // counted in the weighted pipeline
const ACTIVE = [...OPEN, 'on_hold'];
const CLOSED = ['won', 'lost'];
const ACTIVITY_KINDS = { meeting: 'Customer meeting', call: 'Call', email: 'E-mail', presentation: 'Presentation', follow_up: 'Follow-up', technical_meeting: 'Technical meeting', site_assessment: 'Site assessment',
  solution_review: 'Solution review', consultation: 'Consultation', other: 'Other' };
const TECHNICAL_KINDS = ['technical_meeting', 'site_assessment', 'solution_review', 'consultation'];
const PROPOSAL_KINDS = { quotation: 'Quotation', proposal: 'Proposal', technical_submission: 'Technical submission' };
const PROPOSAL_STATUSES = { preparing: 'Preparing', submitted: 'Submitted', accepted: 'Accepted', rejected: 'Rejected' };
const SOLUTION_KINDS = { design: 'Solution design', architecture: 'Architecture', bom: 'Bill of materials', sizing: 'Sizing', technical_proposal: 'Technical proposal contribution', other: 'Other' };
const TASK_STATUSES = { pending: 'Pending', in_progress: 'In progress', completed: 'Completed' };
const PRIORITIES = { low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' };

async function listSettings(db) {
  const st = await settings.getAll(db, ['pipeline_probabilities', 'pipeline_stage_labels', 'opportunity_categories', 'currencies', 'default_currency']);
  const labels = { ...STAGE_LABELS };
  if (st.pipeline_stage_labels && typeof st.pipeline_stage_labels === 'object') for (const k of STAGES) if (typeof st.pipeline_stage_labels[k] === 'string' && st.pipeline_stage_labels[k].trim()) labels[k] = st.pipeline_stage_labels[k].trim().slice(0, 40);
  const probs = { ...DEFAULT_PROB };
  if (st.pipeline_probabilities && typeof st.pipeline_probabilities === 'object') for (const k of STAGES) { const n = Number(st.pipeline_probabilities[k]); if (Number.isFinite(n) && n >= 0 && n <= 100) probs[k] = Math.round(n); }
  probs.won = 100; probs.lost = 0;
  return { labels, probs, categories: Array.isArray(st.opportunity_categories) && st.opportunity_categories.length ? st.opportunity_categories : ['Service', 'Solution', 'Product', 'Other'],
    currencies: Array.isArray(st.currencies) && st.currencies.length ? st.currencies : ['UGX', 'USD'], defaultCurrency: st.default_currency || 'UGX' };
}

/** Clean and check the editable fields of an opportunity. opts: { categories, currencies, defaultCurrency } */
function readFields(b, opts) {
  const name = u.str(b.name, 200); const customerId = u.id(b.customer_id); const prospect = u.str(b.prospect, 200);
  if (!name) throw new UserError('Enter a name for the opportunity.');
  if (!customerId && !prospect) throw new UserError('Choose an existing customer or enter the name of the prospective customer.');
  const value = u.money(b.value);
  if (Number.isNaN(value)) throw new UserError('The estimated value must be a positive number.');
  const probability = b.probability === '' || b.probability === undefined ? null : u.intIn(String(b.probability), 0, 100);
  if (b.probability !== '' && b.probability !== undefined && probability === null) throw new UserError('Probability is a whole number from 0 to 100.');
  if (b.expected_close && !u.dateStr(b.expected_close)) throw new UserError('The expected close date is not valid.');
  if (b.next_step_date && !u.dateStr(b.next_step_date)) throw new UserError('The next step date is not valid.');
  return {
    name, customer_id: customerId, prospect: customerId ? '' : prospect, industry: u.str(b.industry, 80), source: u.str(b.source, 120),
    classification: opts.categories.includes(b.classification) ? b.classification : '', segment: u.str(b.segment, 100), team: u.str(b.team, 100), competitor: u.str(b.competitor, 200),
    value: value === null ? 0 : value, currency: opts.currencies.includes(b.currency) ? b.currency : opts.defaultCurrency, probability,
    expected_close: u.dateStr(b.expected_close), next_step: u.str(b.next_step, 300), next_step_date: u.dateStr(b.next_step_date), next_step_owner_id: u.id(b.next_step_owner_id), notes: u.str(b.notes, 5000),
  };
}
const COLS = ['name', 'customer_id', 'prospect', 'industry', 'source', 'classification', 'segment', 'team', 'competitor', 'value', 'currency', 'probability', 'expected_close', 'next_step', 'next_step_date', 'next_step_owner_id', 'notes'];

/** Pure: totals for rows { stage, value, probability, currency } per currency; only OPEN stages count. */
function totals(rows) {
  const by = {};
  for (const r of rows) {
    const c = r.currency || 'UGX';
    const t = (by[c] = by[c] || { open: 0, weighted: 0, count: 0, stages: Object.fromEntries(OPEN.map((k) => [k, { count: 0, value: 0, weighted: 0 }])) });
    if (!OPEN.includes(r.stage)) continue;
    const v = Number(r.value) || 0; const w = (v * (Number(r.probability) || 0)) / 100;
    t.open += v; t.weighted += w; t.count++;
    t.stages[r.stage].count++; t.stages[r.stage].value += v; t.stages[r.stage].weighted += w;
  }
  for (const t of Object.values(by)) { t.open = Math.round(t.open * 100) / 100; t.weighted = Math.round(t.weighted * 100) / 100; }
  return by;
}
/** Win rate (whole percent) from counts, or null when nothing has closed. */
function winRate(won, lost) { return won + lost > 0 ? Math.round((won / (won + lost)) * 100) : null; }

/**
 * Pure: revenue forecast from open opportunities by expected close, per currency: the next `months` months and the next 4 quarters, plus unscheduled.
 * `today` is 'YYYY-MM-DD'. Overdue expected-close dates fall into the current month.
 */
function forecast(rows, today, months = 12) {
  const [y0, m0] = today.split('-').map(Number);
  const mkey = (y, m) => `${y}-${String(m).padStart(2, '0')}`;
  const monthList = []; for (let i = 0; i < months; i++) { const t = (m0 - 1) + i; monthList.push({ key: mkey(y0 + Math.floor(t / 12), (t % 12) + 1), y: y0 + Math.floor(t / 12), m: (t % 12) + 1 }); }
  const qOf = (y, m) => `${y}-Q${Math.ceil(m / 3)}`;
  const quarterKeys = []; for (const mo of monthList) { const k = qOf(mo.y, mo.m); if (!quarterKeys.includes(k)) quarterKeys.push(k); }
  const quarters = quarterKeys.slice(0, 4);
  const out = {};
  for (const r of rows) {
    if (!OPEN.includes(r.stage)) continue;
    const c = r.currency || 'UGX';
    const f = (out[c] = out[c] || { months: monthList.map((m) => ({ key: m.key, value: 0, weighted: 0, count: 0 })), quarters: quarters.map((k) => ({ key: k, value: 0, weighted: 0, count: 0 })), unscheduled: { value: 0, weighted: 0, count: 0 }, later: { value: 0, weighted: 0, count: 0 } });
    const v = Number(r.value) || 0; const w = (v * (Number(r.probability) || 0)) / 100;
    const add = (b) => { b.value += v; b.weighted += w; b.count++; };
    const ec = r.expected_close ? String(r.expected_close).slice(0, 10) : null;
    if (!ec) { add(f.unscheduled); continue; }
    let [y, m] = ec.split('-').map(Number);
    if (mkey(y, m) < mkey(y0, m0)) { y = y0; m = m0; }
    const mb = f.months.find((x) => x.key === mkey(y, m));
    if (mb) add(mb); else add(f.later);
    const qb = f.quarters.find((x) => x.key === qOf(y, m)); if (qb) add(qb);
  }
  for (const f of Object.values(out)) for (const b of [...f.months, ...f.quarters, f.unscheduled, f.later]) { b.value = Math.round(b.value * 100) / 100; b.weighted = Math.round(b.weighted * 100) / 100; }
  return out;
}

async function addEvent(db, id, actor, kind, text) {
  await db.query('insert into opportunity_events (opportunity_id, actor_id, kind, text) values ($1,$2,$3,$4)', [id, actor ? actor.id : null, kind, String(text).slice(0, 2000)]);
}

async function create(db, f, ownerId, actor, probs, contact) {
  const prob = f.probability ?? (probs || DEFAULT_PROB).lead_identification;
  const cols = [...COLS.filter((k) => k !== 'probability'), 'probability', 'owner_id', 'created_by'];
  const vals = [...COLS.filter((k) => k !== 'probability').map((k) => f[k]), prob, ownerId, actor.id];
  const r = await db.query(`insert into opportunities (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning *`, vals);
  const o = r.rows[0];
  if (contact && contact.name) await db.query('insert into opportunity_contacts (opportunity_id, name, title, email, phone) values ($1,$2,$3,$4,$5)', [o.id, contact.name, contact.title || '', contact.email || '', contact.phone || '']);
  await addEvent(db, o.id, actor, 'created', `${actor.name} created the opportunity ${o.ref}.`);
  await audit(db, actor, 'opportunity_created', 'opportunity', o.ref, f.name, f.customer_id, '');
  return o;
}

const LABELS = { name: 'name', customer_id: 'customer', prospect: 'prospect', industry: 'industry', source: 'source', classification: 'category', segment: 'segment', team: 'team', competitor: 'competitor', value: 'value',
  currency: 'currency', probability: 'probability', expected_close: 'expected close', next_step: 'next step', next_step_date: 'next step date', next_step_owner_id: 'next step owner', notes: 'notes' };
const norm = (v) => (v === null || v === undefined ? '' : String(v));

async function update(db, id, f, ownerId, actor) {
  const old = (await db.query('select * from opportunities where id = $1 for update', [id])).rows[0];
  if (!old) throw new UserError('Opportunity not found.', 404);
  const next = { ...f, probability: f.probability === null ? old.probability : f.probability };
  await db.query(`update opportunities set ${COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')}, owner_id = $${COLS.length + 2}, updated_at = now() where id = $1`, [id, ...COLS.map((k) => next[k]), ownerId]);
  const changed = COLS.filter((k) => norm(old[k]) !== norm(next[k])).map((k) => LABELS[k]);
  if (old.owner_id !== ownerId) changed.push('owner');
  if (changed.length) await addEvent(db, id, actor, 'edited', `${actor.name} changed: ${changed.join(', ')}.`);
  return old;
}

/** Flag an open deal as needing leadership support, or clear the flag. Closed (won / lost) deals cannot be escalated. */
async function setEscalation(db, id, on, note, actor) {
  const old = (await db.query('select * from opportunities where id = $1 for update', [id])).rows[0];
  if (!old) throw new UserError('Opportunity not found.', 404);
  const text = u.str(note, 500);
  if (on) {
    if (CLOSED.includes(old.stage)) throw new UserError('A won or lost opportunity cannot be escalated.');
    if (!text) throw new UserError('Say what leadership needs to help with.');
  }
  await db.query(`update opportunities set escalated = $2, escalation_note = $3,
                    escalated_at = case when $2 and not escalated then now() when $2 then escalated_at else escalated_at end,
                    escalation_cleared_at = case when $2 then null else now() end, updated_at = now() where id = $1`, [id, !!on, on ? text : '']);
  await addEvent(db, id, actor, 'escalation', on ? `${actor.name} escalated the opportunity: ${text}` : `${actor.name} cleared the escalation.`);
  await audit(db, actor, on ? 'opportunity_escalated' : 'opportunity_escalation_cleared', 'opportunity', old.ref, text, old.customer_id, '');
}

/** Move to another stage. Lost needs a reason; won / lost close the opportunity; moving back to an active stage reopens it. Probability follows the stage. */
async function move(db, id, stage, { reason = '', actor, auto = false, probs = DEFAULT_PROB, labels = STAGE_LABELS } = {}) {
  if (!STAGES.includes(stage)) throw new UserError('Unknown stage.');
  const old = (await db.query('select * from opportunities where id = $1 for update', [id])).rows[0];
  if (!old) throw new UserError('Opportunity not found.', 404);
  if (old.stage === stage) return old;
  if (stage === 'lost' && !u.str(reason, 500)) throw new UserError('Say why the opportunity was lost.');
  const closing = CLOSED.includes(stage);
  const r = await db.query(
    `update opportunities set stage = $2, probability = $3, closed_at = case when $4 then now() else null end,
            escalation_cleared_at = case when $4 and escalated then now() else escalation_cleared_at end, escalated = case when $4 then false else escalated end, lost_reason = case when $5 then $6 else '' end, updated_at = now() where id = $1 returning *`,
    [id, stage, probs[stage], closing, stage === 'lost', u.str(reason, 500)]);
  const who = auto || !actor ? 'Automatically' : actor.name;
  await addEvent(db, id, auto ? null : actor, 'stage', `${who} moved the opportunity from ${labels[old.stage]} to ${labels[stage]}.${stage === 'lost' ? ` Reason: ${u.str(reason, 500)}` : ''}`);
  if (actor) await audit(db, actor, 'opportunity_stage', 'opportunity', old.ref, `${old.stage} -> ${stage}`, old.customer_id, '');
  return r.rows[0];
}

// ---------------------------------------------------------------- contacts, activities, proposals (commercial)
async function addContact(db, id, b, actor) {
  const name = u.str(b.name, 120);
  if (!name) throw new UserError('Enter the contact name.');
  const email = u.str(b.email, 320);
  if (email && !u.email(email)) throw new UserError('The contact e-mail address is not valid.');
  await db.query('insert into opportunity_contacts (opportunity_id, name, title, email, phone) values ($1,$2,$3,$4,$5)', [id, name, u.str(b.title, 120), email.toLowerCase(), u.str(b.phone, 40)]);
  await addEvent(db, id, actor, 'contact', `${actor.name} added the contact ${name}.`);
}
async function removeContact(db, id, contactId, actor) {
  const r = await db.query('delete from opportunity_contacts where id = $1 and opportunity_id = $2 returning name', [contactId, id]);
  if (r.rows[0]) await addEvent(db, id, actor, 'contact', `${actor.name} removed the contact ${r.rows[0].name}.`);
}
async function addActivity(db, id, b, actor) {
  const kind = u.oneOf(b.kind, Object.keys(ACTIVITY_KINDS), 'other'); const description = u.str(b.description, 2000); const date = u.dateStr(b.activity_date);
  if (!description || !date) throw new UserError('Enter the date and describe the activity.');
  await db.query('insert into opportunity_activities (opportunity_id, kind, activity_date, description, outcome, technical, created_by) values ($1,$2,$3,$4,$5,$6,$7)',
    [id, kind, date, description, u.str(b.outcome, 1000), TECHNICAL_KINDS.includes(kind) || b.technical === 'on', actor.id]);
  await addEvent(db, id, actor, 'activity', `${actor.name} recorded a ${ACTIVITY_KINDS[kind].toLowerCase()} (${date}).`);
}
async function addProposal(db, id, b, actor) {
  const kind = u.oneOf(b.kind, Object.keys(PROPOSAL_KINDS), 'proposal');
  await db.query('insert into opportunity_proposals (opportunity_id, kind, reference, due_date, prepared_by, notes) values ($1,$2,$3,$4,$5,$6)',
    [id, kind, u.str(b.reference, 120), u.dateStr(b.due_date), u.id(b.prepared_by), u.str(b.notes, 500)]);
  await addEvent(db, id, actor, 'proposal', `${actor.name} started a ${PROPOSAL_KINDS[kind].toLowerCase()}.`);
}
async function setProposal(db, id, proposalId, status, actor) {
  if (!Object.keys(PROPOSAL_STATUSES).includes(status)) throw new UserError('Unknown status.');
  const r = await db.query(`update opportunity_proposals set status = $3, submitted_on = case when $3 = 'submitted' and submitted_on is null then current_date else submitted_on end where id = $2 and opportunity_id = $1 returning kind, reference`, [id, proposalId, status]);
  if (!r.rows[0]) throw new UserError('Not found.', 404);
  await addEvent(db, id, actor, 'proposal', `${actor.name} marked the ${PROPOSAL_KINDS[r.rows[0].kind].toLowerCase()}${r.rows[0].reference ? ` ${r.rows[0].reference}` : ''} as ${PROPOSAL_STATUSES[status].toLowerCase()}.`);
}

// ---------------------------------------------------------------- Service Delivery Engineer support (PT-018 .. PT-030)
async function assignEngineer(db, id, userId, actor) {
  const e = (await db.query(`select id, name, email, kind, role from users where id = $1 and kind = 'staff' and active`, [userId])).rows[0];
  if (!e) throw new UserError('Choose an active member of staff.');
  const r = await db.query('insert into opportunity_engineers (opportunity_id, user_id, assigned_by) values ($1,$2,$3) on conflict do nothing returning user_id', [id, userId, actor.id]);
  if (r.rows[0]) {
    const o = (await db.query('select ref, name from opportunities where id = $1', [id])).rows[0];
    await addEvent(db, id, actor, 'engineer', `${actor.name} assigned ${e.name} as Service Delivery Engineer.`);
    await notifications.enqueue(db, { kind: 'opportunity_assigned', opportunityId: id, to: e, subject: `You are assigned to opportunity ${o.ref}: ${o.name}`.slice(0, 200),
      body: `You have been assigned as Service Delivery Engineer on opportunity ${o.ref}: ${o.name}.\n\nOpen it: ${config.baseUrl}/pipeline/${id}\n` });
  }
}
async function unassignEngineer(db, id, userId, actor) {
  const r = await db.query('delete from opportunity_engineers where opportunity_id = $1 and user_id = $2 returning user_id', [id, userId]);
  if (r.rows[0]) {
    await db.query('update opp_tasks set assignee_id = null where opportunity_id = $1 and assignee_id = $2 and status <> $3', [id, userId, 'completed']);
    await addEvent(db, id, actor, 'engineer', `${actor.name} removed a Service Delivery Engineer from the opportunity (their open tasks are now unassigned).`);
  }
}
async function taskHistory(db, taskId, actor, text) { await db.query('insert into opp_task_history (task_id, actor_id, text) values ($1,$2,$3)', [taskId, actor ? actor.id : null, String(text).slice(0, 1000)]); }

async function createTask(db, id, b, actor) {
  const title = u.str(b.title, 250);
  if (!title) throw new UserError('Enter the task title.');
  const start = u.dateStr(b.start_date); const due = u.dateStr(b.due_date);
  if (start && due && due < start) throw new UserError('The target date cannot be before the start date.');
  const assignee = u.id(b.assignee_id);
  if (assignee && !(await db.query('select 1 from opportunity_engineers where opportunity_id = $1 and user_id = $2', [id, assignee])).rows.length) throw new UserError('Tasks can only be assigned to engineers assigned to this opportunity.');
  const r = await db.query(
    `insert into opp_tasks (opportunity_id, title, description, assignee_id, priority, start_date, due_date, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8) returning *`,
    [id, title, u.str(b.description, 2000), assignee, u.oneOf(b.priority, Object.keys(PRIORITIES), 'normal'), start, due, actor.id]);
  const t = r.rows[0];
  await taskHistory(db, t.id, actor, `${actor.name} created the task${assignee ? ' and assigned it' : ''}.`);
  await addEvent(db, id, actor, 'task', `${actor.name} created task ${t.ref}: ${title}.`);
  if (assignee && assignee !== actor.id) {
    const p = (await db.query(`select id, name, email, kind, role from users where id = $1 and active`, [assignee])).rows[0];
    const o = (await db.query('select ref, name from opportunities where id = $1', [id])).rows[0];
    if (p) await notifications.enqueue(db, { kind: 'opportunity_task', opportunityId: id, to: p, dedupeKey: `opptask:new:${t.id}`, subject: `New task ${t.ref}: ${title}`.slice(0, 200),
      body: `${actor.name} assigned you a task on opportunity ${o.ref} ${o.name}.\n\n${t.ref}: ${title}\nPriority: ${PRIORITIES[t.priority]}\nTarget date: ${due || 'not set'}\n\nOpen it: ${config.baseUrl}/pipeline/${id}#tasks\n` });
  }
  return t;
}

/** Engineer or manager updates a task: status, progress, work performed and notes. Completing a task sets progress to 100 and the completion date. */
async function updateTask(db, id, taskId, b, actor) {
  const t = (await db.query('select * from opp_tasks where id = $1 and opportunity_id = $2 for update', [taskId, id])).rows[0];
  if (!t) throw new UserError('Task not found.', 404);
  let status = u.oneOf(b.status, Object.keys(TASK_STATUSES), t.status);
  let progress = b.progress === '' || b.progress === undefined ? t.progress : u.intIn(String(b.progress), 0, 100);
  if (progress === null) throw new UserError('Progress is a whole number from 0 to 100.');
  if (status === 'completed') progress = 100;
  else if (status === 'pending' && progress > 0 && b.status === undefined) status = 'in_progress';
  else if (status === 'in_progress' && progress === 100) status = 'completed';
  if (status === 'pending' && progress > 0) status = 'in_progress';
  const notes = b.work_notes === undefined ? t.work_notes : u.str(b.work_notes, 4000);
  const assignee = b.assignee_id === undefined ? t.assignee_id : u.id(b.assignee_id);
  if (assignee && assignee !== t.assignee_id && !(await db.query('select 1 from opportunity_engineers where opportunity_id = $1 and user_id = $2', [id, assignee])).rows.length) throw new UserError('Tasks can only be assigned to engineers assigned to this opportunity.');
  await db.query(
    `update opp_tasks set status = $2, progress = $3, work_notes = $4, assignee_id = $5, completed_at = case when $2 = 'completed' then coalesce(completed_at, now()) else null end, updated_at = now() where id = $1`,
    [taskId, status, progress, notes, assignee]);
  const bits = [];
  if (status !== t.status) bits.push(`status ${TASK_STATUSES[t.status]} to ${TASK_STATUSES[status]}`);
  if (progress !== t.progress) bits.push(`progress ${t.progress}% to ${progress}%`);
  if (notes !== t.work_notes) bits.push('work notes');
  if (assignee !== t.assignee_id) bits.push('assignee');
  if (bits.length) {
    await taskHistory(db, taskId, actor, `${actor.name} updated: ${bits.join('; ')}.`);
    await addEvent(db, id, actor, 'task', `${actor.name} updated task ${t.ref}: ${bits.join('; ')}.`);
  }
  return bits;
}

async function addSolutionItem(db, id, b, actor) {
  const title = u.str(b.title, 250);
  if (!title) throw new UserError('Enter the title of the design, BOM or proposal contribution.');
  await db.query('insert into opportunity_solution_items (opportunity_id, kind, title, description, status, author_id) values ($1,$2,$3,$4,$5,$6)',
    [id, u.oneOf(b.kind, Object.keys(SOLUTION_KINDS), 'other'), title, u.str(b.description, 2000), b.status === 'completed' ? 'completed' : 'in_progress', actor.id]);
  await addEvent(db, id, actor, 'solution', `${actor.name} recorded a technical contribution: ${title}.`);
}
async function setSolutionItem(db, id, itemId, status, actor) {
  const r = await db.query(`update opportunity_solution_items set status = $3 where id = $2 and opportunity_id = $1 returning title`, [id, itemId, status === 'completed' ? 'completed' : 'in_progress']);
  if (r.rows[0]) await addEvent(db, id, actor, 'solution', `${actor.name} marked "${r.rows[0].title}" as ${status === 'completed' ? 'completed' : 'in progress'}.`);
}
async function addResource(db, id, b, actor) {
  const userId = u.id(b.user_id); const name = u.str(b.name, 120);
  if (!userId && !name) throw new UserError('Choose a person or enter the resource name.');
  const planned = u.money(b.planned_hours, 100000); const actual = u.money(b.actual_hours, 100000);
  if (Number.isNaN(planned) || Number.isNaN(actual)) throw new UserError('Hours must be positive numbers.');
  await db.query('insert into opportunity_resources (opportunity_id, user_id, name, skill, planned_hours, actual_hours, notes) values ($1,$2,$3,$4,$5,$6,$7)',
    [id, userId, name, u.str(b.skill, 120), planned || 0, actual || 0, u.str(b.notes, 300)]);
  await addEvent(db, id, actor, 'resource', `${actor.name} recorded a technical resource${name ? ` (${name})` : ''}.`);
}
async function updateResource(db, id, resId, b, actor) {
  const actual = u.money(b.actual_hours, 100000);
  if (actual === null || Number.isNaN(actual)) throw new UserError('Enter the hours worked.');
  const r = await db.query('update opportunity_resources set actual_hours = $3 where id = $2 and opportunity_id = $1 returning skill', [id, resId, actual]);
  if (r.rows[0]) await addEvent(db, id, actor, 'resource', `${actor.name} updated effort to ${actual} hours.`);
}
async function saveSupportNotes(db, id, b, actor) {
  await db.query('update opportunities set support_challenges = $2, support_recommendations = $3, updated_at = now() where id = $1', [id, u.str(b.support_challenges, 4000), u.str(b.support_recommendations, 4000)]);
  await addEvent(db, id, actor, 'support', `${actor.name} updated the challenges and recommendations.`);
}

/** Overall engineering support progress: the average progress of all tasks (0 when there are none). */
function overallProgress(tasks) { return tasks.length ? Math.round(tasks.reduce((a, t) => a + Number(t.progress || 0), 0) / tasks.length) : 0; }
const isOverdue = (t, today) => t.status !== 'completed' && !!t.due_date && String(t.due_date).slice(0, 10) < today;

/** Everything the Opportunity Support Report (PT-028, spec 3.4.5) contains, for a reporting period [from, to] (inclusive, either may be null). */
async function supportReportData(db, id, { from = null, to = null } = {}) {
  const o = (await db.query(
    `select o.*, coalesce(c.name, nullif(o.prospect, '')) as customer_name, c.industry as customer_industry, ow.name as owner_name from opportunities o left join customers c on c.id = o.customer_id join users ow on ow.id = o.owner_id where o.id = $1`, [id])).rows[0];
  if (!o) throw new UserError('Opportunity not found.', 404);
  const engineers = (await db.query('select u.id, u.name, u.email from opportunity_engineers e join users u on u.id = e.user_id where e.opportunity_id = $1 order by u.name', [id])).rows;
  const contacts = (await db.query('select name, title, email, phone from opportunity_contacts where opportunity_id = $1 order by id', [id])).rows;
  const today = new Date().toISOString().slice(0, 10);
  const inPeriod = (col) => `(${from ? `${col} >= '${from}'::date` : 'true'} and ${to ? `${col} <= '${to}'::date` : 'true'})`;
  const tasks = (await db.query(`select t.*, u.name as assignee_name from opp_tasks t left join users u on u.id = t.assignee_id where t.opportunity_id = $1 order by t.id`, [id])).rows.map((t) => ({ ...t, overdue: isOverdue(t, today) }));
  const activities = (await db.query(
    `select a.*, u.name as by from opportunity_activities a left join users u on u.id = a.created_by where a.opportunity_id = $1 and ${inPeriod('a.activity_date')} order by a.activity_date, a.id`, [id])).rows;
  const solution = (await db.query(`select s.*, u.name as author from opportunity_solution_items s left join users u on u.id = s.author_id where s.opportunity_id = $1 order by s.id`, [id])).rows;
  const documents = (await db.query(`select a.filename, a.doc_kind, a.version, a.created_at, u.name as uploader from attachments a left join users u on u.id = a.uploaded_by where a.opportunity_id = $1 order by a.id`, [id])).rows;
  const resources = (await db.query(`select r.*, u.name as person from opportunity_resources r left join users u on u.id = r.user_id where r.opportunity_id = $1 order by r.id`, [id])).rows;
  const completedInPeriod = tasks.filter((t) => t.status === 'completed' && t.completed_at && (!from || String(t.completed_at.toISOString ? t.completed_at.toISOString() : t.completed_at).slice(0, 10) >= from) && (!to || String(t.completed_at.toISOString ? t.completed_at.toISOString() : t.completed_at).slice(0, 10) <= to));
  return { opportunity: o, contacts, engineers, from, to, generated: today, tasks, completedInPeriod, outstanding: tasks.filter((t) => t.status !== 'completed'), activities,
    technical: activities.filter((a) => a.technical), solution, documents, resources, progress: overallProgress(tasks), done: tasks.filter((t) => t.status === 'completed').length };
}

// ---------------------------------------------------------------- reminders (PT-015, PT-030)
async function runSchedule(db, now = new Date()) {
  const day = now.toISOString().slice(0, 10); let sent = 0; const week = Math.floor(now.getTime() / (7 * 86400000));
  const get = async (uid) => (await db.query(`select id, email, name, kind, role from users where id = $1 and active`, [uid])).rows[0];
  // owners: follow-ups overdue or due within 2 days
  const follow = (await db.query(
    `select o.id, o.ref, o.name, o.owner_id, o.next_step, o.next_step_date, o.next_step_owner_id from opportunities o
      where o.stage = any($1) and o.next_step_date is not null and o.next_step_date <= $2::date + 2`, [ACTIVE, day])).rows;
  for (const f of follow) {
    const p = await get(f.next_step_owner_id || f.owner_id); if (!p) continue;
    const overdue = String(f.next_step_date).slice(0, 10) < day;
    if (await notifications.enqueue(db, { kind: 'opportunity_followup', opportunityId: f.id, to: p, dedupeKey: `oppfu:${f.id}:${String(f.next_step_date).slice(0, 10)}:${overdue ? week : 'soon'}:${p.id}`,
      subject: `${overdue ? 'Overdue follow-up' : 'Follow-up due'}: ${f.ref} ${f.name}`.slice(0, 200), body: `${overdue ? 'This follow-up is overdue' : 'A follow-up is due'}: ${f.next_step || 'next step'} (${String(f.next_step_date).slice(0, 10)}).\n\nOpen the opportunity: ${config.baseUrl}/pipeline/${f.id}\n` })) sent++;
  }
  // engineers: tasks due within 2 days or overdue
  const tasks = (await db.query(
    `select t.id, t.ref, t.title, t.due_date, t.assignee_id, t.opportunity_id, o.ref as oref, o.name as oname, o.owner_id from opp_tasks t join opportunities o on o.id = t.opportunity_id
      where t.status <> 'completed' and t.assignee_id is not null and t.due_date is not null and t.due_date <= $1::date + 2 and o.stage = any($2)`, [day, ACTIVE])).rows;
  for (const t of tasks) {
    const p = await get(t.assignee_id); if (!p) continue;
    const overdue = String(t.due_date).slice(0, 10) < day;
    if (await notifications.enqueue(db, { kind: 'opportunity_task', opportunityId: t.opportunity_id, to: p, dedupeKey: `opptask:${t.id}:${overdue ? `over:${week}` : 'soon'}:${p.id}`,
      subject: `${overdue ? 'Overdue task' : 'Task due soon'}: ${t.ref} ${t.title}`.slice(0, 200), body: `Task ${t.ref} "${t.title}" on opportunity ${t.oref} ${t.oname} is ${overdue ? 'overdue' : 'due'} (${String(t.due_date).slice(0, 10)}).\n\nOpen it: ${config.baseUrl}/pipeline/${t.opportunity_id}#tasks\n` })) sent++;
    if (overdue) { const owner = await get(t.owner_id); if (owner && owner.id !== p.id && await notifications.enqueue(db, { kind: 'opportunity_task', opportunityId: t.opportunity_id, to: owner, dedupeKey: `opptask:owner:${t.id}:${week}:${owner.id}`,
      subject: `Overdue engineering task on ${t.oref}: ${t.title}`.slice(0, 200), body: `Task ${t.ref} "${t.title}" (${p.name}) is overdue.\n\nOpen it: ${config.baseUrl}/pipeline/${t.opportunity_id}#tasks\n` })) sent++; }
  }
  return sent;
}

module.exports = { setEscalation, STAGES, STAGE_LABELS, DEFAULT_PROB, OPEN, ACTIVE, CLOSED, ACTIVITY_KINDS, TECHNICAL_KINDS, PROPOSAL_KINDS, PROPOSAL_STATUSES, SOLUTION_KINDS, TASK_STATUSES, PRIORITIES,
  listSettings, readFields, totals, winRate, forecast, create, update, move, addEvent, addContact, removeContact, addActivity, addProposal, setProposal,
  assignEngineer, unassignEngineer, createTask, updateTask, addSolutionItem, setSolutionItem, addResource, updateResource, saveSupportNotes, overallProgress, isOverdue, supportReportData, runSchedule };
