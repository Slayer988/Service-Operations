'use strict';
// Change management: planned work on live services. A normal or emergency change is approved (Settings, Approvals) before it is
// scheduled; a standard change is pre-approved routine work. The plan, back-out plan and window are checked, overlapping work on the
// same customer or equipment is flagged, and the outcome is recorded (completed, or failed and backed out).
const audit = require('../lib/audit');
const u = require('../lib/util');
const tz = require('../lib/tz');
const config = require('../config');
const { UserError } = require('./tickets');

const TYPES = { standard: 'Standard (pre-approved, routine)', normal: 'Normal', emergency: 'Emergency' };
const RISKS = { low: 'Low', medium: 'Medium', high: 'High' };
const STATUS_LABELS = { draft: 'Draft', scheduled: 'Scheduled', in_progress: 'In progress', completed: 'Completed', failed: 'Failed (backed out)', cancelled: 'Cancelled' };
const MOVES = { draft: ['scheduled', 'cancelled'], scheduled: ['in_progress', 'draft', 'cancelled'], in_progress: ['completed', 'failed'], completed: [], failed: [], cancelled: [] };
const MOVE_LABELS = { scheduled: 'Schedule it', in_progress: 'Start the work', completed: 'Completed successfully', failed: 'Failed: backed out', cancelled: 'Cancel', draft: 'Back to draft (re-plan)' };
const EDITABLE = ['draft'];

/** A form date-time in the application's time zone ("2026-11-28T22:00") -> Date; '' -> null; anything else -> undefined. */
function readWhen(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  return tz.localToDate(s, config.timezone) || undefined;
}

function read(b) {
  const v = { title: u.str(b.title, 200), description: u.str(b.description, 8000), type: u.oneOf(b.type, Object.keys(TYPES), 'normal'), risk: u.oneOf(b.risk, Object.keys(RISKS), 'medium'),
    customer_id: u.id(b.customer_id) || null, problem_id: u.id(b.problem_id) || null, owner_id: u.id(b.owner_id) || null, implementer_id: u.id(b.implementer_id) || null,
    impact: u.str(b.impact, 4000), implementation_plan: u.str(b.implementation_plan, 12000), backout_plan: u.str(b.backout_plan, 8000), test_plan: u.str(b.test_plan, 8000) };
  const errors = [];
  if (!v.title) errors.push('Give the change a title, for example "Upgrade the core switch firmware".');
  v.planned_start = readWhen(b.planned_start); v.planned_end = readWhen(b.planned_end);
  if (v.planned_start === undefined) errors.push('The planned start is not a date and time.');
  if (v.planned_end === undefined) errors.push('The planned end is not a date and time.');
  if (v.planned_start && v.planned_end && v.planned_end <= v.planned_start) errors.push('The planned end must be after the start.');
  if (errors.length) throw new UserError(errors.join(' '));
  return v;
}

async function event(db, id, actor, text) { await db.query('insert into change_events (change_id, actor_id, text) values ($1,$2,$3)', [id, actor ? actor.id : null, text]); }

const COLS = ['title', 'description', 'type', 'risk', 'customer_id', 'problem_id', 'owner_id', 'implementer_id', 'impact', 'implementation_plan', 'backout_plan', 'test_plan', 'planned_start', 'planned_end'];
async function create(db, b, actor, ip = '') {
  const v = read(b); v.owner_id = v.owner_id || actor.id;
  const c = (await db.query(`insert into changes (${COLS.join(', ')}, created_by) values (${COLS.map((_, i) => `$${i + 1}`).join(', ')}, $${COLS.length + 1}) returning *`, [...COLS.map((k) => v[k]), actor.id])).rows[0];
  await event(db, c.id, actor, `${actor.name} raised the change (${TYPES[c.type].split(' ')[0].toLowerCase()}, ${c.risk} risk).`);
  await audit(db, actor, 'change_created', 'change', c.ref, c.title, c.customer_id, ip);
  for (const tag of String(b.assets || '').split(/[\s,;]+/).filter(Boolean)) await linkAsset(db, c, tag, actor);
  const t = u.str(b.ticket, 20);
  if (t) { const tk = (await db.query('select id from tickets where upper(ref) = upper($1)', [t])).rows[0]; if (tk) await db.query('insert into change_tickets (change_id, ticket_id) values ($1,$2) on conflict do nothing', [c.id, tk.id]); }
  return c;
}

async function update(db, c, b, actor, ip = '') {
  if (!EDITABLE.includes(c.status)) throw new UserError('Only a draft change is edited. Move a scheduled change back to draft to re-plan it (its approval is withdrawn).');
  const v = read(b);
  const norm = (x) => (x instanceof Date ? x.toISOString() : x === null || x === undefined ? '' : String(x));
  const changed = COLS.filter((k) => norm(c[k]) !== norm(v[k]));
  if (!changed.length) return c;
  const out = (await db.query(`update changes set ${COLS.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`, [c.id, ...COLS.map((k) => v[k])])).rows[0];
  await event(db, c.id, actor, `${actor.name} changed the ${changed.map((k) => k.replace(/_id$/, '').replace(/_/g, ' ')).join(', ')}.`);
  await require('./approvals').withdraw(db, 'change', c.id, actor, 'the change was edited');
  await audit(db, actor, 'change_updated', 'change', c.ref, changed.join(', '), out.customer_id, ip);
  return out;
}

/** Scheduled or running work that overlaps this change's window on the same customer or the same equipment. */
async function conflicts(db, c) {
  if (!c.planned_start || !c.planned_end) return [];
  return (await db.query(`select o.id, o.ref, o.title, o.status, o.planned_start, o.planned_end,
                                 (o.customer_id is not distinct from $3::bigint and $3::bigint is not null) as same_customer,
                                 exists (select 1 from change_assets x join change_assets y on y.asset_id = x.asset_id where x.change_id = o.id and y.change_id = $4) as same_asset
                            from changes o
                           where o.id <> $4 and o.status in ('scheduled','in_progress') and o.planned_start < $2 and o.planned_end > $1
                             and ((o.customer_id = $3) or exists (select 1 from change_assets x join change_assets y on y.asset_id = x.asset_id where x.change_id = o.id and y.change_id = $4))
                           order by o.planned_start`, [c.planned_start, c.planned_end, c.customer_id, c.id])).rows;
}

async function setStatus(db, c, to, actor, note = '', ip = '') {
  if (!(MOVES[c.status] || []).includes(to)) throw new UserError(`A change that is ${STATUS_LABELS[c.status].toLowerCase()} cannot move to ${STATUS_LABELS[to] ? STATUS_LABELS[to].toLowerCase() : to}.`);
  const n = u.str(note, 2000);
  if (to === 'scheduled') {
    const missing = [];
    if (!c.planned_start || !c.planned_end) missing.push('the planned start and end');
    if (!c.implementation_plan.trim()) missing.push('the implementation plan');
    if (c.type !== 'standard' && !c.backout_plan.trim()) missing.push('the back-out plan');
    if (c.type !== 'standard' && !c.impact.trim()) missing.push('the impact on the service');
    if (missing.length) throw new UserError(`Before it is scheduled, write ${missing.join(', ')}.`);
    if (c.type !== 'emergency' && new Date(c.planned_end) < new Date()) throw new UserError('The planned window is in the past. Change the dates.');
    await require('./approvals').assertApproved(db, 'change', c.id);
  }
  if (to === 'failed' && !n) throw new UserError('Say what went wrong and how the service was restored (the back-out).');
  if (to === 'draft') await require('./approvals').withdraw(db, 'change', c.id, actor, 'it was moved back to draft to re-plan');
  const out = (await db.query(`update changes set status = $2, updated_at = now(),
        actual_start = case when $2 = 'in_progress' then now() else actual_start end,
        actual_end = case when $2 in ('completed','failed') then now() else actual_end end,
        outcome = case when $2 in ('completed','failed','cancelled') and $3 <> '' then $3 else outcome end
      where id = $1 returning *`, [c.id, to, n])).rows[0];
  await event(db, c.id, actor, `${actor.name}: ${STATUS_LABELS[to].toLowerCase()}${n ? `. ${n}` : '.'}`);
  await audit(db, actor, 'change_status', 'change', c.ref, `${c.status} -> ${to}`, c.customer_id, ip);
  return out;
}

async function get(db, id) {
  return (await db.query(`select c.*, cu.name as customer_name, o.name as owner_name, i.name as implementer_name, p.ref as problem_ref, p.title as problem_title
                            from changes c left join customers cu on cu.id = c.customer_id left join users o on o.id = c.owner_id left join users i on i.id = c.implementer_id
                            left join problems p on p.id = c.problem_id where c.id = $1`, [id])).rows[0] || null;
}

async function linkAsset(db, c, tag, actor) {
  const a = (await db.query('select id, tag, name, customer_id from assets where upper(tag) = upper($1)', [u.str(tag, 20)])).rows[0];
  if (!a) throw new UserError(`There is no asset ${tag}.`);
  if (c.customer_id && a.customer_id && Number(a.customer_id) !== Number(c.customer_id)) throw new UserError(`${a.tag} belongs to another customer.`);
  const r = await db.query('insert into change_assets (change_id, asset_id) values ($1,$2) on conflict do nothing', [c.id, a.id]);
  if (r.rowCount) {
    await event(db, c.id, actor, `${actor.name} added ${a.tag} (${a.name}).`);
    await require('./assets').event(db, a.id, actor, `${actor.name} included it in change ${c.ref}.`);
  }
  return a;
}
async function unlinkAsset(db, c, assetId, actor) {
  const a = (await db.query('select tag from assets where id = $1', [assetId])).rows[0];
  const r = await db.query('delete from change_assets where change_id = $1 and asset_id = $2', [c.id, assetId]);
  if (r.rowCount && a) await event(db, c.id, actor, `${actor.name} removed ${a.tag}.`);
}

/** For a form: a timestamp as "YYYY-MM-DDTHH:MM" in the application's time zone. */
function forInput(d) { return tz.dateToLocal(d, config.timezone); }

module.exports = { TYPES, RISKS, STATUS_LABELS, MOVES, MOVE_LABELS, read, readWhen, create, update, setStatus, get, conflicts, linkAsset, unlinkAsset, forInput, event };
