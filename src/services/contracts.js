'use strict';
// Contracts register (CM-001 .. CM-018): customer, supplier and partner contracts; lifecycle, renewals, obligations,
// payments, SLA targets and performance, amendments, reviews and a full history.
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const u = require('../lib/util');
const notifications = require('./notifications');
const { UserError } = require('./tickets');

// The lifecycle has exactly these statuses. Draft / under review / pending approval / approved are deliberately NOT statuses (spec 4.3):
// review and authorisation are recorded separately (contract_reviews).
const STATUS_LABELS = { active: 'Active', expiring_soon: 'Expiring Soon', renewal_in_progress: 'Renewal in Progress', expired: 'Expired', suspended: 'Suspended', terminated: 'Terminated', closed: 'Closed' };
const STATUSES = Object.keys(STATUS_LABELS);
const LIVE = ['active', 'expiring_soon', 'renewal_in_progress'];           // in force
const MANUAL = ['suspended', 'terminated', 'closed'];                      // only a person moves a contract into or out of these
const REVIEW_STAGES = { legal: 'Legal / compliance', finance: 'Finance', management: 'Management', department: 'Department head' };
const REVIEW_DECISIONS = { approved: 'Approved', changes_requested: 'Changes requested', rejected: 'Rejected' };
const OBLIGATION_KINDS = { obligation: 'Obligation', deliverable: 'Deliverable', milestone: 'Milestone' };
const AMENDMENT_KINDS = { variation: 'Variation', extension: 'Extension', amendment: 'Amendment', revision: 'Revised value' };
const SLA_METRICS = { availability: 'Service availability', response_time: 'Response time', resolution_time: 'Resolution time', other: 'Other' };
const COUNTERPARTIES = { customer: 'Customer', supplier: 'Supplier', partner: 'Partner' };
const DEFAULT_TYPES = ['Service agreement', 'Maintenance contract', 'Support contract', 'Supplier agreement', 'SLA', 'Software licence', 'Subscription', 'Lease / rental', 'Other'];

/** Which review stages a role may record (a platform administrator or contract manager may record any). */
const STAGE_BY_ROLE = { legal: ['legal'], finance: ['finance'], management: ['management'], dept_head: ['department'], platform_admin: Object.keys(REVIEW_STAGES), contract_manager: Object.keys(REVIEW_STAGES) };
const stagesFor = (role) => STAGE_BY_ROLE[role] || [];

/**
 * The status a contract should have today (CM-015). Suspended / terminated / closed are only changed by a person; "Renewal in Progress"
 * is set by a person and kept until the contract expires or is extended; everything else follows the end date.
 */
function autoStatus(c, today, expiringDays = 90) {
  if (MANUAL.includes(c.status)) return c.status;
  const end = c.end_date ? norm(c.end_date) : null;
  if (!end) return c.status === 'renewal_in_progress' ? c.status : 'active';
  const left = u.dayDiff(today, end);
  if (left < 0) return 'expired';
  if (c.status === 'renewal_in_progress') return c.status;
  return left <= expiringDays ? 'expiring_soon' : 'active';
}

async function addEvent(db, contractId, actor, kind, text) {
  await db.query('insert into contract_events (contract_id, actor_id, kind, text) values ($1,$2,$3,$4)', [contractId, actor ? actor.id : null, kind, String(text).slice(0, 2000)]);
}

async function listSettings(db) {
  const st = await settings.getAll(db, ['contract_types', 'currencies', 'departments', 'default_currency', 'contract_reminder_days', 'contract_expiring_days']);
  return {
    types: Array.isArray(st.contract_types) && st.contract_types.length ? st.contract_types : DEFAULT_TYPES,
    currencies: Array.isArray(st.currencies) && st.currencies.length ? st.currencies : ['UGX', 'USD'],
    departments: Array.isArray(st.departments) ? st.departments : [],
    defaultCurrency: st.default_currency || 'UGX',
    reminderDays: (Array.isArray(st.contract_reminder_days) ? st.contract_reminder_days : [90, 60, 30, 14, 7]).map(Number).filter((n) => n > 0).sort((a, b) => b - a),
    expiringDays: Number(st.contract_expiring_days) > 0 ? Number(st.contract_expiring_days) : 90,
  };
}

/** Validate the form. Throws UserError with a plain message. `opts`: { types, currencies } */
function readFields(b, opts) {
  const f = {};
  f.title = u.str(b.title, 200);
  if (!f.title) throw new UserError('Enter a contract title.');
  f.counterparty_kind = u.oneOf(b.counterparty_kind, Object.keys(COUNTERPARTIES), 'customer');
  f.customer_id = u.id(b.customer_id);
  f.supplier = u.str(b.supplier, 200);
  if (f.counterparty_kind === 'customer' && !f.customer_id) throw new UserError('Choose the customer this contract is with.');
  if (f.counterparty_kind !== 'customer' && !f.supplier) throw new UserError(`Enter the ${f.counterparty_kind}'s name.`);
  if (f.counterparty_kind !== 'customer') f.customer_id = null;   // supplier and partner contracts are not tied to a customer
  f.type = opts.types.includes(b.type) ? b.type : opts.types[0];
  f.description = u.str(b.description, 4000);
  f.value = u.money(b.value); f.annual_value = u.money(b.annual_value);
  if (Number.isNaN(f.value) || Number.isNaN(f.annual_value)) throw new UserError('Contract values must be positive numbers, for example 12500000 or 1250.50.');
  f.currency = opts.currencies.includes(b.currency) ? b.currency : opts.currencies[0];
  f.owner_id = u.id(b.owner_id);
  f.department = u.str(b.department, 100);
  f.start_date = u.dateStr(b.start_date); f.end_date = u.dateStr(b.end_date); f.renewal_date = u.dateStr(b.renewal_date);
  if (!f.start_date) throw new UserError('Enter the commencement (start) date.');
  if (f.end_date && f.end_date < f.start_date) throw new UserError('The end date cannot be before the start date.');
  f.renewal_terms = u.str(b.renewal_terms, 2000);
  f.notice_days = u.intIn(b.notice_days, 0, 730); if (f.notice_days === null) f.notice_days = 60;
  f.auto_renew = b.auto_renew === 'on';
  f.sla_policy_id = u.id(b.sla_policy_id);
  f.exclusions = u.str(b.exclusions, 2000);
  f.notes = u.str(b.notes, 4000);
  f.extra_emails = u.str(b.extra_emails, 1000).split(/[,;\s]+/).map((x) => u.email(x)).filter(Boolean).slice(0, 10);
  f.reference = u.str(b.reference, 60);
  return f;
}

const COLS = ['title', 'type', 'counterparty_kind', 'customer_id', 'supplier', 'description', 'value', 'annual_value', 'currency', 'owner_id', 'department', 'start_date', 'end_date',
  'renewal_date', 'renewal_terms', 'notice_days', 'auto_renew', 'sla_policy_id', 'exclusions', 'notes', 'extra_emails'];
const LABELS = { title: 'title', type: 'type', counterparty_kind: 'counterparty', customer_id: 'customer', supplier: 'supplier / partner', description: 'description', value: 'contract value', annual_value: 'annual value',
  currency: 'currency', owner_id: 'owner', department: 'department', start_date: 'start date', end_date: 'end date', renewal_date: 'renewal date', renewal_terms: 'renewal terms', notice_days: 'notice period',
  auto_renew: 'auto-renewal', sla_policy_id: 'SLA policy', exclusions: 'exclusions', notes: 'notes', extra_emails: 'extra e-mail recipients' };

const norm = (v) => (v === null || v === undefined ? '' : Array.isArray(v) ? v.join(',') : v instanceof Date ? [v.getFullYear(), String(v.getMonth() + 1).padStart(2, '0'), String(v.getDate()).padStart(2, '0')].join('-') : String(v));

async function create(db, actor, f, ip, extra = {}) {
  let csid = null;
  if (f.customer_id) csid = (await db.query('select id from csids where customer_id = $1 order by id limit 1', [f.customer_id])).rows[0] || null;
  const cols = [...COLS, 'csid_id', 'created_by', 'tender_id', 'opportunity_id']; const vals = [...COLS.map((k) => f[k]), csid ? csid.id : null, actor.id, extra.tender_id || null, extra.opportunity_id || null];
  if (f.reference) { cols.push('reference'); vals.push(f.reference); }
  let row;
  try {
    row = (await db.query(`insert into contracts (${cols.join(',')}) values (${cols.map((_, i) => `$${i + 1}`).join(',')}) returning id, reference, end_date, status`, vals)).rows[0];
  } catch (e) {
    if (e.code === '23505') throw new UserError('That contract reference already exists. Leave it blank to get the next number automatically.');
    if (e.code === '23503') throw new UserError('Choose a valid customer, owner or SLA policy.');
    throw e;
  }
  const { expiringDays } = await listSettings(db);
  const status = autoStatus({ status: 'active', end_date: row.end_date }, new Date().toISOString().slice(0, 10), expiringDays);
  if (status !== 'active') await db.query('update contracts set status = $2 where id = $1', [row.id, status]);
  row.status = status;
  await addEvent(db, row.id, actor, 'created', `${actor.name} registered the contract ${row.reference}.`);
  await audit(db, actor, 'contract_created', 'contract', row.reference, f.title, f.customer_id, ip || '');
  return row;
}

async function update(db, actor, id, f, ip) {
  const before = (await db.query('select * from contracts where id = $1 for update', [id])).rows[0];
  if (!before) throw new UserError('Contract not found.', 404);
  const sets = COLS.map((k, i) => `${k} = $${i + 2}`).join(', ');
  let csid = before.csid_id;
  if (f.customer_id !== before.customer_id) csid = f.customer_id ? ((await db.query('select id from csids where customer_id = $1 order by id limit 1', [f.customer_id])).rows[0] || {}).id || null : null;
  try {
    await db.query(`update contracts set ${sets}, csid_id = $${COLS.length + 2}, updated_at = now() where id = $1`, [id, ...COLS.map((k) => f[k]), csid]);
  } catch (e) {
    if (e.code === '23503') throw new UserError('Choose a valid customer, owner or SLA policy.');
    if (e.code === '23514') throw new UserError('A customer contract needs a customer.');
    throw e;
  }
  const changed = COLS.filter((k) => norm(before[k]) !== norm(f[k])).map((k) => LABELS[k]);
  if (changed.length) await addEvent(db, id, actor, 'updated', `${actor.name} changed: ${changed.join(', ')}.`);
  if (f.customer_id !== before.customer_id) {
    // services of the old customer can no longer be covered by this contract
    await db.query('delete from service_contracts where contract_id = $1', [id]);
  }
  await refreshOne(db, id, actor);
  await audit(db, actor, 'contract_updated', 'contract', before.reference, changed.join(', '), f.customer_id, ip || '');
  return changed;
}

/** Recompute one contract's status after a change (dates, amendment). Returns the status. */
async function refreshOne(db, id, actor = null, today = new Date().toISOString().slice(0, 10)) {
  const { expiringDays } = await listSettings(db);
  const c = (await db.query('select id, status, end_date from contracts where id = $1', [id])).rows[0];
  if (!c) return null;
  const next = autoStatus(c, today, expiringDays);
  if (next !== c.status) {
    await db.query('update contracts set status = $2, updated_at = now() where id = $1', [id, next]);
    await addEvent(db, id, actor, 'status', `Status changed ${actor ? '' : 'automatically '}from ${STATUS_LABELS[c.status]} to ${STATUS_LABELS[next]}.`);
  }
  return next;
}

/** A person changes the lifecycle status (CM-015). */
async function setStatus(db, actor, id, status, reason, ip) {
  if (!STATUSES.includes(status)) throw new UserError('Unknown status.');
  const c = (await db.query('select * from contracts where id = $1 for update', [id])).rows[0];
  if (!c) throw new UserError('Contract not found.', 404);
  if (status === c.status) return c.status;
  if (['suspended', 'terminated', 'closed'].includes(status) && !reason) throw new UserError('Give a reason.');
  let next = status;
  if (status === 'active') { // reinstate: follow the dates
    next = autoStatus({ status: 'active', end_date: c.end_date }, new Date().toISOString().slice(0, 10), (await listSettings(db)).expiringDays);
  }
  if (status === 'renewal_in_progress' && !LIVE.includes(c.status) && c.status !== 'expired') throw new UserError('Only an active, expiring or expired contract can go into renewal.');
  if (status === 'expired') throw new UserError('Expired is set automatically from the end date. Amend the end date, or choose Closed or Terminated.');
  if (status === 'expiring_soon') throw new UserError('Expiring Soon is set automatically from the end date.');
  await db.query('update contracts set status = $2, updated_at = now() where id = $1', [id, next]);
  await addEvent(db, id, actor, 'status', `${actor.name} changed the status from ${STATUS_LABELS[c.status]} to ${STATUS_LABELS[next]}${reason ? `: ${reason}` : ''}.`);
  await audit(db, actor, 'contract_status', 'contract', c.reference, `${c.status} -> ${next}${reason ? `; ${reason}` : ''}`, c.customer_id, ip || '');
  return next;
}

// ---------------------------------------------------------------- obligations (CM-010)
async function addObligation(db, actor, contractId, b) {
  const title = u.str(b.title, 200);
  if (!title) throw new UserError('Describe the obligation, deliverable or milestone.');
  await db.query(
    `insert into contract_obligations (contract_id, kind, title, description, responsible, responsible_id, due_date) values ($1,$2,$3,$4,$5,$6,$7)`,
    [contractId, u.oneOf(b.kind, Object.keys(OBLIGATION_KINDS), 'obligation'), title, u.str(b.description, 1000), u.str(b.responsible, 120), u.id(b.responsible_id), u.dateStr(b.due_date)]);
  await addEvent(db, contractId, actor, 'obligation', `${actor.name} added: ${title}.`);
}
async function setObligation(db, actor, contractId, obId, status) {
  if (!['open', 'in_progress', 'done', 'waived'].includes(status)) throw new UserError('Unknown status.');
  const r = await db.query(
    `update contract_obligations set status = $3, completed_at = case when $3 in ('done','waived') then now() else null end where id = $2 and contract_id = $1 returning title`, [contractId, obId, status]);
  if (!r.rows[0]) throw new UserError('Not found.', 404);
  await addEvent(db, contractId, actor, 'obligation', `${actor.name} marked "${r.rows[0].title}" as ${status.replace('_', ' ')}.`);
}

// ---------------------------------------------------------------- payments (CM-007)
async function addPayment(db, actor, contractId, b) {
  const amount = u.money(b.amount); const due = u.dateStr(b.due_date);
  if (amount === null || Number.isNaN(amount) || !due) throw new UserError('Enter a due date and an amount.');
  await db.query('insert into contract_payments (contract_id, due_date, description, amount) values ($1,$2,$3,$4)', [contractId, due, u.str(b.description, 200), amount]);
  await addEvent(db, contractId, actor, 'payment', `${actor.name} scheduled a payment of ${amount} due ${due}.`);
}
async function setPayment(db, actor, contractId, payId, status, paidOn) {
  if (!['scheduled', 'invoiced', 'paid'].includes(status)) throw new UserError('Unknown status.');
  const r = await db.query(
    `update contract_payments set status = $3, paid_on = case when $3 = 'paid' then coalesce($4::date, current_date) else null end where id = $2 and contract_id = $1 returning amount, due_date`,
    [contractId, payId, status, paidOn || null]);
  if (!r.rows[0]) throw new UserError('Not found.', 404);
  await addEvent(db, contractId, actor, 'payment', `${actor.name} marked the payment due ${String(r.rows[0].due_date).slice(0, 10)} as ${status}.`);
}

// ---------------------------------------------------------------- SLA targets and performance (CM-011, CM-012)
async function addSlaTarget(db, actor, contractId, b) {
  const label = u.str(b.label, 120); const target = u.money(b.target, 1e9);
  if (!label || target === null || Number.isNaN(target)) throw new UserError('Enter a name and a target value.');
  const metric = u.oneOf(b.metric, Object.keys(SLA_METRICS), 'other');
  const direction = u.oneOf(b.direction, ['min', 'max'], metric === 'availability' ? 'min' : 'max');
  await db.query('insert into contract_sla_targets (contract_id, metric, label, target, unit, direction, notes) values ($1,$2,$3,$4,$5,$6,$7)',
    [contractId, metric, label, target, u.str(b.unit, 20), direction, u.str(b.notes, 300)]);
  await addEvent(db, contractId, actor, 'sla', `${actor.name} added the SLA target "${label}".`);
}
async function recordPerformance(db, actor, contractId, b) {
  const t = u.id(b.sla_target_id) ? (await db.query('select id, label from contract_sla_targets where id = $1 and contract_id = $2', [u.id(b.sla_target_id), contractId])).rows[0] : null;
  const measured = u.money(b.measured, 1e9); const ps = u.dateStr(b.period_start); const pe = u.dateStr(b.period_end);
  if (!t) throw new UserError('Choose the SLA target.');
  if (measured === null || Number.isNaN(measured) || !ps || !pe) throw new UserError('Enter the period and the measured value.');
  if (pe < ps) throw new UserError('The period end cannot be before its start.');
  await db.query('insert into contract_performance (contract_id, sla_target_id, period_start, period_end, measured, note, recorded_by) values ($1,$2,$3,$4,$5,$6,$7)',
    [contractId, t.id, ps, pe, measured, u.str(b.note, 300), actor.id]);
  await addEvent(db, contractId, actor, 'performance', `${actor.name} recorded performance for "${t.label}": ${measured}.`);
}
/** Did a measurement meet its target? */
const met = (target, direction, measured) => (direction === 'min' ? Number(measured) >= Number(target) : Number(measured) <= Number(target));

// ---------------------------------------------------------------- amendments (CM-013)
async function addAmendment(db, actor, contractId, b, ip) {
  const c = (await db.query('select * from contracts where id = $1 for update', [contractId])).rows[0];
  if (!c) throw new UserError('Contract not found.', 404);
  const description = u.str(b.description, 2000); const eff = u.dateStr(b.effective_date);
  if (!description || !eff) throw new UserError('Enter the effective date and describe the change.');
  const kind = u.oneOf(b.kind, Object.keys(AMENDMENT_KINDS), 'amendment');
  const newEnd = u.dateStr(b.new_end_date); const newValue = u.money(b.new_value);
  if (Number.isNaN(newValue)) throw new UserError('The revised value must be a positive number.');
  if (newEnd && newEnd < norm(c.start_date)) throw new UserError('The new end date is before the contract start date.');
  const oldEnd = c.end_date; const oldValue = c.value;
  await db.query(
    `insert into contract_amendments (contract_id, kind, effective_date, description, old_end_date, new_end_date, old_value, new_value, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [contractId, kind, eff, description, oldEnd, newEnd, oldValue, newValue, actor.id]);
  if (newEnd) await db.query('update contracts set end_date = $2, updated_at = now() where id = $1', [contractId, newEnd]);
  if (newValue !== null) await db.query('update contracts set value = $2, updated_at = now() where id = $1', [contractId, newValue]);
  await addEvent(db, contractId, actor, 'amendment', `${actor.name} recorded a ${AMENDMENT_KINDS[kind].toLowerCase()}: ${description}${newEnd ? ` (new end date ${newEnd})` : ''}${newValue !== null ? ` (revised value ${newValue})` : ''}.`);
  await refreshOne(db, contractId, actor);
  await audit(db, actor, 'contract_amended', 'contract', c.reference, `${kind}: ${description}`.slice(0, 300), c.customer_id, ip || '');
}

// ---------------------------------------------------------------- review and authorisation (CM-014)
async function addReview(db, actor, contractId, b, ip) {
  const stage = u.oneOf(b.stage, Object.keys(REVIEW_STAGES));
  if (!stage || !stagesFor(actor.role).includes(stage)) throw new UserError('You cannot record that review stage with your role.', 403);
  const decision = u.oneOf(b.decision, Object.keys(REVIEW_DECISIONS));
  if (!decision) throw new UserError('Choose a decision.');
  const comment = u.str(b.comment, 1000);
  if (decision !== 'approved' && !comment) throw new UserError('Add a comment explaining the decision.');
  const c = (await db.query('select reference, customer_id from contracts where id = $1', [contractId])).rows[0];
  if (!c) throw new UserError('Contract not found.', 404);
  await db.query('insert into contract_reviews (contract_id, stage, reviewer_id, decision, comment) values ($1,$2,$3,$4,$5)', [contractId, stage, actor.id, decision, comment]);
  await addEvent(db, contractId, actor, 'review', `${actor.name} recorded the ${REVIEW_STAGES[stage].toLowerCase()} review: ${REVIEW_DECISIONS[decision].toLowerCase()}${comment ? ` (${comment})` : ''}.`);
  await audit(db, actor, 'contract_review', 'contract', c.reference, `${stage}: ${decision}`, c.customer_id, ip || '');
}
/** Latest decision per stage. */
function reviewSummary(rows) {
  const latest = {};
  for (const r of rows) if (!latest[r.stage] || r.id > latest[r.stage].id) latest[r.stage] = r;
  return latest;
}

// ---------------------------------------------------------------- notifications and the daily job (CM-009)
async function recipients(db, c) {
  const out = new Map();
  if (c.owner_id) { const o = (await db.query('select id, email, name, kind, role from users where id = $1 and active', [c.owner_id])).rows[0]; if (o) out.set(o.email.toLowerCase(), o); }
  for (const x of (await db.query(`select u.id, u.email, u.name, u.kind, u.role from contract_contacts cc join users u on u.id = cc.user_id where cc.contract_id = $1 and u.active and u.kind = 'staff'`, [c.id])).rows) out.set(x.email.toLowerCase(), x);
  for (const e of c.extra_emails || []) if (!out.has(e.toLowerCase())) out.set(e.toLowerCase(), { email: e, name: e, kind: 'staff' });
  return [...out.values()];
}
const managers = async (db) => (await db.query(`select id, email, name, kind, role from users where kind = 'staff' and active and role in ('platform_admin','contract_manager')`)).rows;

function mailBody(c, left, extra) {
  const cfg = require('../config');
  const d = (x) => (x ? String(x).slice(0, 10) : 'not set');
  return [`Contract ${c.reference}: ${c.title}`, `With:           ${c.customer_name || c.supplier || 'n/a'}`, `Type:           ${c.type}`, `Status:         ${STATUS_LABELS[c.status] || c.status}`,
    `End date:       ${d(c.end_date)}${left === null ? '' : left >= 0 ? ` (${left} days left)` : ` (expired ${-left} days ago)`}`, `Renewal date:   ${d(c.renewal_date)}`,
    `Auto-renewal:   ${c.auto_renew ? 'yes' : 'no'}`, '', extra, '', `Open the contract: ${cfg.baseUrl}/contracts/${c.id}`, ''].join('\n');
}

/** Daily: refresh statuses, expiry reminders at the configured intervals, escalation of expired / imminent contracts, obligations and payments due. Idempotent. */
async function runSchedule(db, today = new Date()) {
  const day = today.toISOString().slice(0, 10);
  const cfg = await listSettings(db);
  let sent = 0;
  const rows = (await db.query(
    `select c.*, cu.name as customer_name from contracts c left join customers cu on cu.id = c.customer_id where c.status not in ('terminated','closed')`)).rows;
  const mgrs = await managers(db);
  const week = Math.floor(today.getTime() / (7 * 86400000));
  for (const c of rows) {
    const status = autoStatus(c, day, cfg.expiringDays);
    if (status !== c.status) {
      await db.query('update contracts set status = $2, updated_at = now() where id = $1', [c.id, status]);
      await addEvent(db, c.id, null, 'status', `Status changed automatically from ${STATUS_LABELS[c.status]} to ${STATUS_LABELS[status]}.`);
      c.status = status;
    }
    if (c.status === 'suspended' || !c.end_date) continue;
    const left = u.dayDiff(day, c.end_date);
    const people = await recipients(db, c);
    if (left >= 0) {
      const due = cfg.reminderDays.filter((d) => left <= d);
      if (due.length) {
        const threshold = Math.min(...due); let any = false;
        for (const p of people) {
          const id = await notifications.enqueue(db, { kind: 'contract_reminder', contractId: c.id, to: p, dedupeKey: `contract:${c.id}:${String(c.end_date).slice(0, 10)}:${threshold}:${p.email.toLowerCase()}`,
            subject: `Contract ${c.reference} expires in ${left} days`, body: mailBody(c, left, c.auto_renew ? 'This contract renews automatically. Confirm that is still what you want, and check the notice period.' : 'Decide whether to renew, extend or close this contract, and update the record.') });
          if (id) { any = true; sent++; }
        }
        if (any) await addEvent(db, c.id, null, 'reminder', `Expiry reminder queued (${threshold}-day interval, ${left} days left).`);
      }
    }
    if (c.status === 'expired' || (left >= 0 && left <= 7 && c.status !== 'renewal_in_progress')) {
      for (const m of mgrs) {
        const id = await notifications.enqueue(db, { kind: 'contract_escalation', contractId: c.id, to: m, dedupeKey: `contract-esc:${c.id}:${week}:${m.id}`,
          subject: `${c.status === 'expired' ? 'EXPIRED' : 'Expires within 7 days'}: contract ${c.reference}`, body: mailBody(c, left, 'This contract needs management attention.') });
        if (id) sent++;
      }
    }
  }
  // obligations due within 7 days or overdue -> the responsible person, else the contract owner
  const obs = (await db.query(
    `select o.*, c.reference, c.title as ctitle, c.owner_id, c.id as cid from contract_obligations o join contracts c on c.id = o.contract_id
      where o.status in ('open','in_progress') and o.due_date is not null and o.due_date <= $1::date + 7 and c.status not in ('terminated','closed')`, [day])).rows;
  for (const o of obs) {
    const uid = o.responsible_id || o.owner_id; if (!uid) continue;
    const p = (await db.query('select id, email, name, kind, role from users where id = $1 and active', [uid])).rows[0]; if (!p) continue;
    const overdue = u.dayDiff(day, o.due_date) < 0;
    const id = await notifications.enqueue(db, { kind: 'contract_obligation', contractId: o.cid, to: p, dedupeKey: `ob:${o.id}:${overdue ? 'over' : 'soon'}:${overdue ? week : ''}:${p.id}`,
      subject: `${overdue ? 'Overdue' : 'Due soon'}: ${o.title} (${o.reference})`, body: `${OBLIGATION_KINDS[o.kind]} "${o.title}" on contract ${o.reference} is ${overdue ? 'overdue' : 'due'} (${String(o.due_date).slice(0, 10)}).\n\nOpen the contract: ${require('../config').baseUrl}/contracts/${o.cid}\n` });
    if (id) sent++;
  }
  // payments due within 7 days or overdue -> contract owner
  const pays = (await db.query(
    `select p.*, c.reference, c.owner_id, c.id as cid, c.currency from contract_payments p join contracts c on c.id = p.contract_id
      where p.status <> 'paid' and p.due_date <= $1::date + 7 and c.status not in ('terminated','closed') and c.owner_id is not null`, [day])).rows;
  for (const p of pays) {
    const o = (await db.query('select id, email, name, kind, role from users where id = $1 and active', [p.owner_id])).rows[0]; if (!o) continue;
    const overdue = u.dayDiff(day, p.due_date) < 0;
    const id = await notifications.enqueue(db, { kind: 'contract_payment', contractId: p.cid, to: o, dedupeKey: `pay:${p.id}:${overdue ? week : 'soon'}:${o.id}`,
      subject: `Payment ${overdue ? 'overdue' : 'due'}: ${p.reference} ${p.currency} ${p.amount}`, body: `A payment of ${p.currency} ${p.amount} on contract ${p.reference} is ${overdue ? 'overdue' : 'due'} (${String(p.due_date).slice(0, 10)}).\n\nOpen the contract: ${require('../config').baseUrl}/contracts/${p.cid}\n` });
    if (id) sent++;
  }
  return sent;
}

module.exports = { STATUS_LABELS, STATUSES, LIVE, MANUAL, REVIEW_STAGES, REVIEW_DECISIONS, OBLIGATION_KINDS, AMENDMENT_KINDS, SLA_METRICS, COUNTERPARTIES, DEFAULT_TYPES,
  autoStatus, stagesFor, addEvent, listSettings, readFields, create, update, refreshOne, setStatus, addObligation, setObligation, addPayment, setPayment, addSlaTarget, recordPerformance,
  met, addAmendment, addReview, reviewSummary, recipients, runSchedule };
