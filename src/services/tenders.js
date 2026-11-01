'use strict';
// Tender management (TM-001 .. TM-015): identification to closure, compliance checklists, internal reviews, submission,
// evaluation and award, with notifications for deadlines and outstanding work.
const { UserError } = require('./tickets');
const notifications = require('./notifications');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const tz = require('../lib/tz');
const u = require('../lib/util');
const config = require('../config');

const STATUS_LABELS = {
  identified: 'Identified', registered: 'Registered', under_review: 'Under Review', qualification: 'Qualification', bid_preparation: 'Bid Preparation', internal_approval: 'Internal Approval',
  submitted: 'Submitted', under_evaluation: 'Under Evaluation', clarification: 'Clarification', awarded: 'Awarded', unsuccessful: 'Unsuccessful', cancelled: 'Cancelled', withdrawn: 'Withdrawn', closed: 'Closed',
};
const STATUSES = Object.keys(STATUS_LABELS);
const PRE_SUBMISSION = ['identified', 'registered', 'under_review', 'qualification', 'bid_preparation', 'internal_approval'];
const AFTER_SUBMISSION = ['submitted', 'under_evaluation', 'clarification'];
const ACTIVE = [...PRE_SUBMISSION, ...AFTER_SUBMISSION];
const OUTCOMES = ['awarded', 'unsuccessful', 'cancelled', 'withdrawn'];
const TRANSITIONS = {
  identified: ['registered', 'under_review', 'cancelled', 'withdrawn'],
  registered: ['under_review', 'qualification', 'cancelled', 'withdrawn'],
  under_review: ['qualification', 'bid_preparation', 'cancelled', 'withdrawn'],
  qualification: ['bid_preparation', 'cancelled', 'withdrawn'],
  bid_preparation: ['internal_approval', 'cancelled', 'withdrawn'],
  internal_approval: ['submitted', 'bid_preparation', 'cancelled', 'withdrawn'],
  submitted: ['under_evaluation', 'clarification', 'awarded', 'unsuccessful', 'cancelled'],
  under_evaluation: ['clarification', 'awarded', 'unsuccessful', 'cancelled'],
  clarification: ['under_evaluation', 'awarded', 'unsuccessful', 'cancelled'],
  awarded: ['closed'], unsuccessful: ['closed'], cancelled: ['closed'], withdrawn: ['closed'], closed: [],
};
const SECTIONS = { administrative: 'Administrative', technical: 'Technical', financial: 'Financial', statutory: 'Statutory', preparation: 'Bid preparation', general: 'General' };
const REVIEW_STAGES = { technical: 'Technical review', commercial: 'Commercial review', management: 'Management review' };
const REVIEW_DECISIONS = { approved: 'Approved', changes_requested: 'Changes requested', rejected: 'Rejected' };
const STAGE_BY_ROLE = { technical_team: ['technical'], sde: ['technical'], finance: ['commercial'], bd_manager: ['commercial'], management: ['management'], dept_head: ['management', 'technical'],
  service_manager: ['technical', 'commercial', 'management'], platform_admin: ['technical', 'commercial', 'management'] };
const stagesFor = (role) => STAGE_BY_ROLE[role] || [];
const EVAL_KINDS = { stage: 'Evaluation stage', clarification: 'Clarification request', score: 'Score / result' };
const DEFAULT_TYPES = ['RFP', 'RFQ', 'RFI', 'EOI', 'Other'];
const MEMBER_ROLES = { bid_manager: 'Bid manager', technical: 'Technical', finance: 'Finance', legal: 'Legal', sde: 'Service delivery engineer', other: 'Other' };

// A starting checklist: administrative, technical, financial and statutory compliance, and the bid documents to prepare (TM-006, TM-007)
const STANDARD_CHECKLIST = [
  ['administrative', 'Tender document and addenda read and logged'], ['administrative', 'Bid security / bid bond arranged'], ['administrative', 'Company profile and references prepared'], ['administrative', 'Power of attorney / signatory authority'],
  ['technical', 'Technical compliance matrix completed'], ['technical', 'Technical certifications and manufacturer authorisations'], ['technical', 'Team CVs and experience'], ['technical', 'Site visit attended (if required)'],
  ['financial', 'Audited financial statements'], ['financial', 'Bank reference / letter of credit'], ['financial', 'Tax compliance evidence'],
  ['statutory', 'Business registration and trading licence'], ['statutory', 'Tax clearance certificate'], ['statutory', 'Social security (NSSF) compliance'], ['statutory', 'Procurement authority registration (e.g. PPDA)'],
  ['preparation', 'Technical proposal drafted'], ['preparation', 'Bill of materials (BOM) prepared'], ['preparation', 'Pricing and financial proposal prepared'], ['preparation', 'Supporting documentation assembled'], ['preparation', 'Final proof-read and submission pack checked'],
];

async function listSettings(db) {
  const st = await settings.getAll(db, ['tender_types', 'currencies', 'departments', 'default_currency', 'tender_reminder_days', 'tender_require_reviews', 'tender_status_labels']);
  const labels = { ...STATUS_LABELS };
  if (st.tender_status_labels && typeof st.tender_status_labels === 'object') for (const k of STATUSES) if (typeof st.tender_status_labels[k] === 'string' && st.tender_status_labels[k].trim()) labels[k] = st.tender_status_labels[k].trim().slice(0, 40);
  return {
    types: Array.isArray(st.tender_types) && st.tender_types.length ? st.tender_types : DEFAULT_TYPES,
    currencies: Array.isArray(st.currencies) && st.currencies.length ? st.currencies : ['UGX', 'USD'],
    departments: Array.isArray(st.departments) ? st.departments : [],
    defaultCurrency: st.default_currency || 'UGX',
    reminderDays: (Array.isArray(st.tender_reminder_days) ? st.tender_reminder_days : [14, 7, 3, 1]).map(Number).filter((n) => n > 0),
    requireReviews: st.tender_require_reviews !== false, labels,
  };
}

function readFields(b, opts) {
  const timezone = opts.timezone || config.timezone;
  const title = u.str(b.title, 250); const issuer = u.str(b.issuer, 200);
  if (!title || !issuer) throw new UserError('Enter the tender title and the procuring entity (the organisation that issued it).');
  const due = tz.localToDate(b.submission_due, timezone);
  if (!due) throw new UserError('Enter the submission deadline (date and time).');
  const opt = (v, label) => { if (!v) return null; const d = tz.localToDate(v, timezone); if (!d) throw new UserError(`${label} is not a valid date and time.`); return d; };
  const est = u.money(b.est_value);
  if (Number.isNaN(est)) throw new UserError('The estimated value must be a positive number.');
  if (b.published_on && !u.dateStr(b.published_on)) throw new UserError('The publication date is not valid.');
  return {
    title, issuer, customer_id: u.id(b.customer_id), opportunity_id: u.id(b.opportunity_id), tender_no: u.str(b.tender_no, 120), source: u.str(b.source, 200),
    type: opts.types.includes(b.type) ? b.type : opts.types[0], description: u.str(b.description, 4000), scope: u.str(b.scope, 4000), category: u.str(b.category, 80),
    department: u.str(b.department, 100), business_unit: u.str(b.business_unit, 100),
    est_value: est, currency: opts.currencies.includes(b.currency) ? b.currency : opts.currencies[0], published_on: u.dateStr(b.published_on),
    clarification_due: opt(b.clarification_due, 'The clarification deadline'), site_visit_at: opt(b.site_visit_at, 'The site visit'), submission_due: due, notes: u.str(b.notes, 5000),
  };
}

async function addEvent(db, id, actor, kind, text) {
  await db.query('insert into tender_events (tender_id, actor_id, kind, text) values ($1,$2,$3,$4)', [id, actor ? actor.id : null, kind, String(text).slice(0, 2000)]);
}

const COLS = ['title', 'issuer', 'customer_id', 'opportunity_id', 'tender_no', 'source', 'type', 'description', 'scope', 'category', 'department', 'business_unit', 'est_value', 'currency', 'published_on', 'clarification_due', 'site_visit_at', 'submission_due', 'notes'];

async function create(db, f, ownerId, actor, status = 'registered') {
  const r = await db.query(
    `insert into tenders (${COLS.join(',')}, owner_id, created_by, status) values (${COLS.map((_, i) => `$${i + 1}`).join(',')}, $${COLS.length + 1}, $${COLS.length + 2}, $${COLS.length + 3}) returning *`,
    [...COLS.map((k) => f[k]), ownerId, actor.id, status]);
  await addEvent(db, r.rows[0].id, actor, 'created', `${actor.name} registered the tender ${r.rows[0].ref}.`);
  await audit(db, actor, 'tender_created', 'tender', r.rows[0].ref, f.title, f.customer_id, '');
  if (f.opportunity_id) await db.query(`insert into opportunity_events (opportunity_id, actor_id, kind, text) values ($1,$2,'tender',$3)`, [f.opportunity_id, actor.id, `${actor.name} linked tender ${r.rows[0].ref}.`]);
  return r.rows[0];
}

const LABELS = { title: 'title', issuer: 'procuring entity', customer_id: 'customer', opportunity_id: 'opportunity', tender_no: 'tender number', source: 'source', type: 'type', description: 'description', scope: 'scope', category: 'category',
  department: 'department', business_unit: 'business unit', est_value: 'estimated value', currency: 'currency', published_on: 'publication date', clarification_due: 'clarification deadline', site_visit_at: 'site visit',
  submission_due: 'submission deadline', notes: 'notes' };
const norm = (v) => (v === null || v === undefined ? '' : v instanceof Date ? String(v.getTime()) : String(v));

async function update(db, id, f, ownerId, actor) {
  const old = (await db.query('select * from tenders where id = $1 for update', [id])).rows[0];
  if (!old) throw new UserError('Tender not found.', 404);
  await db.query(`update tenders set ${COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')}, owner_id = $${COLS.length + 2}, updated_at = now() where id = $1`, [id, ...COLS.map((k) => f[k]), ownerId]);
  const ch = COLS.filter((k) => norm(old[k]) !== norm(f[k])).map((k) => LABELS[k]);
  if (old.owner_id !== ownerId) ch.push('bid manager / owner');
  if (ch.length) await addEvent(db, id, actor, 'edited', `${actor.name} changed: ${ch.join(', ')}.`);
  return ch;
}

/** The latest decision per review stage. */
function reviewSummary(rows) { const l = {}; for (const r of rows) if (!l[r.stage] || r.id > l[r.stage].id) l[r.stage] = r; return l; }
const approvedAll = (summary) => Object.keys(REVIEW_STAGES).every((k) => summary[k] && summary[k].decision === 'approved');

/**
 * Move a tender along its lifecycle. opts: { actor, reason, note, awardValue, awardedTo, awardedOn, method, reference, submittedAt, requireReviews, labels }
 * Rules: outcomes need a reason or note; submission needs a method and (when reviews are required) approved technical, commercial and management reviews;
 * a linked opportunity follows an award or a loss.
 */
async function move(db, id, to, opts = {}) {
  const { actor } = opts; const labels = opts.labels || STATUS_LABELS;
  const t = (await db.query('select * from tenders where id = $1 for update', [id])).rows[0];
  if (!t) throw new UserError('Tender not found.', 404);
  if (!STATUSES.includes(to)) throw new UserError('Unknown status.');
  if (!(TRANSITIONS[t.status] || []).includes(to)) throw new UserError(`A tender that is "${labels[t.status]}" cannot be moved to "${labels[to]}".`);
  const reason = u.str(opts.reason, 1000); const note = u.str(opts.note, 2000);
  if (['cancelled', 'withdrawn'].includes(to) && !reason) throw new UserError(`Say why the tender is ${to}.`);
  if (to === 'unsuccessful' && !note && !reason) throw new UserError('Record the outcome: who won, and any feedback received.');
  const awardValue = opts.awardValue === undefined ? null : opts.awardValue;
  if (awardValue !== null && (!Number.isFinite(awardValue) || awardValue < 0)) throw new UserError('The award value must be a positive number.');
  const sets = { status: to };
  let text = `${actor.name} moved the tender from "${labels[t.status]}" to "${labels[to]}".`;
  if (to === 'submitted') {
    const method = u.str(opts.method, 120);
    if (!method) throw new UserError('Record how the bid was submitted (portal, courier, e-mail, in person ...).');
    if (opts.requireReviews !== false) {
      const sum = reviewSummary((await db.query('select id, stage, decision from tender_reviews where tender_id = $1', [id])).rows);
      const missing = Object.keys(REVIEW_STAGES).filter((k) => !sum[k] || sum[k].decision !== 'approved');
      if (missing.length) throw new UserError(`Before submission the ${missing.map((k) => k).join(', ')} review(s) must be approved (see Internal review).`);
    }
    sets.submitted_at = opts.submittedAt || new Date(); sets.submission_method = method; sets.submission_reference = u.str(opts.reference, 200);
    const open = (await db.query('select count(*)::int as n from tender_tasks where tender_id = $1 and done_at is null', [id])).rows[0].n;
    text += ` Submitted by ${method}${sets.submission_reference ? `, reference ${sets.submission_reference}` : ''}.`;
    if (open) text += ` ${open} checklist item(s) were still open.`;
  }
  if (to === 'awarded') { sets.awarded_on = u.dateStr(opts.awardedOn) || new Date().toISOString().slice(0, 10); sets.awarded_to = u.str(opts.awardedTo, 200); if (awardValue !== null) sets.award_value = awardValue; }
  if (to === 'unsuccessful') { sets.awarded_to = u.str(opts.awardedTo, 200); sets.awarded_on = u.dateStr(opts.awardedOn); }
  if (note) sets.outcome_note = note;
  if (reason) sets.decision_reason = reason;
  if (to === 'closed') sets.closed_at = new Date();
  const keys = Object.keys(sets);
  await db.query(`update tenders set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [id, ...keys.map((k) => sets[k])]);
  if (reason) text += ` Reason: ${reason.slice(0, 300)}`;
  await addEvent(db, id, actor, 'status', text);
  await audit(db, actor, 'tender_status', 'tender', t.ref, `${t.status} -> ${to}`, t.customer_id, '');
  if (t.opportunity_id && (to === 'awarded' || to === 'unsuccessful')) {
    const pipeline = require('./pipeline');
    const opp = (await db.query('select stage from opportunities where id = $1', [t.opportunity_id])).rows[0];
    if (opp && pipeline.OPEN.includes(opp.stage)) {
      await pipeline.move(db, t.opportunity_id, to === 'awarded' ? 'won' : 'lost', { actor, reason: to === 'unsuccessful' ? (note || reason || 'Tender unsuccessful') : '', auto: true });
      await addEvent(db, id, null, 'pipeline', `The linked opportunity was marked ${to === 'awarded' ? 'won' : 'lost'}.`);
    }
  }
  return (await db.query('select * from tenders where id = $1', [id])).rows[0];
}

// ---------------------------------------------------------------- checklist (compliance and bid preparation)
async function addTask(db, tenderId, { title, section = 'general', assigneeId = null, dueAt = null, notes = '' }, actor) {
  const t = u.str(title, 250);
  if (!t) throw new UserError('Enter the checklist item.');
  const sec = Object.keys(SECTIONS).includes(section) ? section : 'general';
  const r = await db.query('insert into tender_tasks (tender_id, title, section, assignee_id, due_at, notes) values ($1,$2,$3,$4,$5,$6) returning *', [tenderId, t, sec, assigneeId, dueAt, u.str(notes, 500)]);
  await addEvent(db, tenderId, actor, 'task', `${actor.name} added the ${SECTIONS[sec].toLowerCase()} item "${t}".`);
  return r.rows[0];
}
async function addStandardChecklist(db, tenderId, actor) {
  const have = new Set((await db.query('select lower(title) as t from tender_tasks where tender_id = $1', [tenderId])).rows.map((r) => r.t));
  let n = 0;
  for (const [section, title] of STANDARD_CHECKLIST) {
    if (have.has(title.toLowerCase())) continue;
    await db.query('insert into tender_tasks (tender_id, title, section) values ($1,$2,$3)', [tenderId, title, section]); n++;
  }
  if (n) await addEvent(db, tenderId, actor, 'task', `${actor.name} added the standard checklist (${n} items).`);
  return n;
}
async function toggleTask(db, taskId, actor) {
  const t = (await db.query('select * from tender_tasks where id = $1 for update', [taskId])).rows[0];
  if (!t) throw new UserError('Checklist item not found.', 404);
  await db.query('update tender_tasks set done_at = case when done_at is null then now() else null end, done_by = case when done_at is null then $2::bigint else null end where id = $1', [taskId, actor.id]);
  await addEvent(db, t.tender_id, actor, 'task', `${actor.name} ${t.done_at ? 'reopened' : 'completed'} "${t.title}".`);
  return t.tender_id;
}

// ---------------------------------------------------------------- team, reviews, evaluation
async function addMember(db, tenderId, userId, role, actor) {
  const m = (await db.query(`select id, name from users where id = $1 and kind = 'staff' and active`, [userId])).rows[0];
  if (!m) throw new UserError('Choose an active member of staff.');
  await db.query('insert into tender_members (tender_id, user_id, role) values ($1,$2,$3) on conflict (tender_id, user_id) do update set role = excluded.role', [tenderId, userId, Object.keys(MEMBER_ROLES).includes(role) ? role : 'other']);
  await addEvent(db, tenderId, actor, 'team', `${actor.name} added ${m.name} to the tender team.`);
}
async function removeMember(db, tenderId, userId, actor) {
  const m = (await db.query('delete from tender_members where tender_id = $1 and user_id = $2 returning user_id', [tenderId, userId])).rows[0];
  if (m) await addEvent(db, tenderId, actor, 'team', `${actor.name} removed a member from the tender team.`);
}
async function addReview(db, tenderId, b, actor) {
  const stage = u.oneOf(b.stage, Object.keys(REVIEW_STAGES));
  if (!stage || !stagesFor(actor.role).includes(stage)) throw new UserError('You cannot record that review with your role.', 403);
  const decision = u.oneOf(b.decision, Object.keys(REVIEW_DECISIONS));
  if (!decision) throw new UserError('Choose a decision.');
  const comment = u.str(b.comment, 1000);
  if (decision !== 'approved' && !comment) throw new UserError('Add a comment explaining the decision.');
  if (!(await db.query('select 1 from tenders where id = $1', [tenderId])).rows.length) throw new UserError('Tender not found.', 404);
  await db.query('insert into tender_reviews (tender_id, stage, reviewer_id, decision, comment) values ($1,$2,$3,$4,$5)', [tenderId, stage, actor.id, decision, comment]);
  await addEvent(db, tenderId, actor, 'review', `${actor.name} recorded the ${REVIEW_STAGES[stage].toLowerCase()}: ${REVIEW_DECISIONS[decision].toLowerCase()}${comment ? ` (${comment})` : ''}.`);
}
async function addEvaluation(db, tenderId, b, actor) {
  const kind = u.oneOf(b.kind, Object.keys(EVAL_KINDS), 'stage');
  const title = u.str(b.title, 200);
  if (!title) throw new UserError('Describe the evaluation stage, clarification request or score.');
  const score = u.money(b.score, 1e6);
  if (Number.isNaN(score)) throw new UserError('The score must be a number.');
  await db.query(
    `insert into tender_evaluations (tender_id, kind, title, event_date, due_date, responded_on, score, outcome, notes, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [tenderId, kind, title, u.dateStr(b.event_date), u.dateStr(b.due_date), u.dateStr(b.responded_on), score, u.str(b.outcome, 300), u.str(b.notes, 1000), actor.id]);
  await addEvent(db, tenderId, actor, 'evaluation', `${actor.name} recorded ${EVAL_KINDS[kind].toLowerCase()}: ${title}.`);
}

// ---------------------------------------------------------------- reminders (TM-012)
/** The reminder threshold (days) that applies now: the smallest not yet passed, so a late start sends one reminder, not several. */
function bucket(msLeft, thresholds) {
  if (msLeft < 0) return null;
  const days = Math.ceil(msLeft / 86400000);
  const hit = thresholds.filter((t) => days <= t);
  return hit.length ? Math.min(...hit) : null;
}

function reminderBody(t, extra, timezone) {
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, dateStyle: 'full', timeStyle: 'short' });
  return [`Tender ${t.ref}: ${t.title}`, `Procuring entity: ${t.issuer}`, `Issuer reference: ${t.tender_no || 'n/a'}`, `Type:             ${t.type}`, `Status:           ${STATUS_LABELS[t.status]}`,
    `Submission due:   ${when.format(new Date(t.submission_due))}`, `Open checklist items: ${t.open_tasks}`, '', extra, '', `Open the tender: ${config.baseUrl}/tenders/${t.id}`, ''].join('\n');
}

/** Hourly job; every message has a dedupe key so repeats are harmless. Returns the number of e-mails queued. */
async function runSchedule(db, now = new Date(), timezone = config.timezone) {
  const cfg = await listSettings(db);
  const rows = (await db.query(
    `select t.*, (select count(*)::int from tender_tasks k where k.tender_id = t.id and k.done_at is null) as open_tasks from tenders t where t.status = any($1)`, [PRE_SUBMISSION])).rows;
  const supervisors = (await db.query(`select id, email, name, kind, role from users where kind = 'staff' and active and role in ('service_manager','platform_admin','bid_manager')`)).rows;
  let sent = 0;
  for (const t of rows) {
    const people = new Map();
    const get = async (uid) => (await db.query(`select id, email, name, kind, role from users where id = $1 and active`, [uid])).rows[0];
    const owner = await get(t.owner_id); if (owner) people.set(owner.id, owner);
    for (const m of (await db.query(`select u.id, u.email, u.name, u.kind, u.role from tender_members m join users u on u.id = m.user_id where m.tender_id = $1 and u.active`, [t.id])).rows) people.set(m.id, m);
    for (const a of (await db.query(`select distinct u.id, u.email, u.name, u.kind, u.role from tender_tasks k join users u on u.id = k.assignee_id where k.tender_id = $1 and k.done_at is null and u.active and u.kind = 'staff'`, [t.id])).rows) people.set(a.id, a);
    const dueMs = new Date(t.submission_due).getTime();
    const queue = async (key, subject, text, list) => {
      for (const p of list) if (await notifications.enqueue(db, { kind: 'tender_reminder', tenderId: t.id, to: p, dedupeKey: `tender:${t.id}:${key}:${p.id}`, subject: subject.slice(0, 200), body: reminderBody(t, text, timezone) })) sent++;
    };
    const left = dueMs - now.getTime(); const b = bucket(left, cfg.reminderDays);
    const withSupervisors = [...people.values(), ...supervisors.filter((s) => !people.has(s.id))];
    if (b !== null) await queue(`sub:${dueMs}:${b}`, `Tender deadline in ${b <= 1 ? 'about a day' : `${b} days or less`}: ${t.ref} ${t.title}`, 'The submission deadline is approaching. Check that the bid, the checklist and the internal reviews are complete.', b <= 1 ? withSupervisors : [...people.values()]);
    else if (left < 0) await queue(`passed:${dueMs}`, `Tender deadline passed: ${t.ref} ${t.title}`, 'The submission deadline has passed and the tender is not marked as submitted. Update its status (submitted, withdrawn or cancelled).', withSupervisors);
    if (t.clarification_due) {
      const cb = bucket(new Date(t.clarification_due).getTime() - now.getTime(), [3, 1]);
      if (cb !== null) await queue(`clar:${new Date(t.clarification_due).getTime()}:${cb}`, `Clarification deadline in ${cb} day(s) or less: ${t.ref} ${t.title}`, 'Questions to the issuer must be sent before the clarification deadline.', [...people.values()]);
    }
  }
  // checklist items due within two days or overdue -> their assignee
  const items = (await db.query(
    `select k.id, k.title, k.due_at, t.id as tid, t.ref, t.title as ttitle, k.assignee_id from tender_tasks k join tenders t on t.id = k.tender_id
      where k.done_at is null and k.assignee_id is not null and k.due_at is not null and k.due_at <= $1::timestamptz + interval '2 days' and t.status = any($2)`, [now, ACTIVE])).rows;
  for (const k of items) {
    const p = (await db.query(`select id, email, name, kind, role from users where id = $1 and active`, [k.assignee_id])).rows[0]; if (!p) continue;
    const overdue = new Date(k.due_at).getTime() < now.getTime();
    const day = Math.floor(now.getTime() / 86400000);
    if (await notifications.enqueue(db, { kind: 'tender_task', tenderId: k.tid, to: p, dedupeKey: `ttask:${k.id}:${overdue ? `over:${day}` : 'soon'}:${p.id}`,
      subject: `${overdue ? 'Overdue' : 'Due soon'}: ${k.title} (${k.ref})`.slice(0, 200), body: `The checklist item "${k.title}" on tender ${k.ref} ${k.ttitle} is ${overdue ? 'overdue' : 'due soon'}.\n\nOpen the tender: ${config.baseUrl}/tenders/${k.tid}\n` })) sent++;
  }
  return sent;
}

module.exports = { STATUS_LABELS, STATUSES, PRE_SUBMISSION, AFTER_SUBMISSION, ACTIVE, OUTCOMES, TRANSITIONS, SECTIONS, REVIEW_STAGES, REVIEW_DECISIONS, EVAL_KINDS, MEMBER_ROLES, DEFAULT_TYPES, STANDARD_CHECKLIST,
  stagesFor, listSettings, readFields, create, update, move, reviewSummary, approvedAll, addTask, addStandardChecklist, toggleTask, addMember, removeMember, addReview, addEvaluation,
  addEvent, bucket, runSchedule };
