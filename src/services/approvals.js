'use strict';
// Approvals: a quote above a set amount or discount needs approval before it is sent; a purchase order needs approval before it is issued,
// and a second approver above a set amount. The rules live in Settings (Approvals) with defaults below. Nobody approves their own
// quote or order, a change after approval withdraws it, and every request and decision is in the item's history and the audit log.
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const perms = require('../lib/perms');
const u = require('../lib/util');
const { UserError } = require('./tickets');

const DEFAULTS = {
  approvals_quote_enabled: true,
  approvals_quote_limits: { UGX: 20000000, USD: 5000 },
  approvals_quote_discount_pct: 10,
  approvals_quote_roles: ['finance', 'management', 'dept_head'],
  approvals_lpo_enabled: true,
  approvals_lpo_roles: ['finance', 'dept_head'],
  approvals_lpo_l2_limits: { UGX: 50000000, USD: 13000 },
  approvals_lpo_l2_roles: ['management'],
};
const KEYS = Object.keys(DEFAULTS);
const ENTITY_LABEL = { quote: 'quote', lpo: 'purchase order' };
const STATUS_LABELS = { pending: 'Waiting', approved: 'Approved', rejected: 'Not approved', withdrawn: 'Withdrawn' };
const APPROVER_ROLES = ['finance', 'management', 'dept_head', 'service_manager', 'contract_manager', 'bd_manager', 'procurement'];

/** "UGX 20,000,000\nUSD 5000" -> { UGX: 20000000, USD: 5000 }; throws on a line it cannot read. */
function parseLimits(text) {
  const out = {};
  for (const raw of String(text || '').split(/[\n;]+/)) {
    const line = raw.trim(); if (!line) continue;
    const m = /^([A-Za-z]{3,8})\s*[:=]?\s*([\d][\d,\s]*(?:\.\d+)?)$/.exec(line);
    if (!m) throw new UserError(`"${line}" is not a currency and an amount, for example "UGX 20,000,000".`);
    out[m[1].toUpperCase()] = Number(m[2].replace(/[,\s]/g, ''));
  }
  return out;
}
const formatLimits = (o) => Object.entries(o || {}).map(([c, v]) => `${c} ${Number(v).toLocaleString('en-US')}`).join('\n');
const fmt = (c, v) => `${c} ${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;

async function rules(db) {
  const s = await settings.getAll(db, KEYS);
  const r = {}; for (const k of KEYS) r[k] = s[k] === undefined || s[k] === null ? DEFAULTS[k] : s[k];
  const roles = (v) => (Array.isArray(v) ? v.filter((x) => APPROVER_ROLES.includes(x) || x === 'platform_admin') : []);
  return {
    quote: { enabled: r.approvals_quote_enabled !== false, limits: r.approvals_quote_limits || {}, discountPct: Number(r.approvals_quote_discount_pct) || 0, roles: roles(r.approvals_quote_roles) },
    lpo: { enabled: r.approvals_lpo_enabled !== false, roles: roles(r.approvals_lpo_roles), l2Limits: r.approvals_lpo_l2_limits || {}, l2Roles: roles(r.approvals_lpo_l2_roles) },
  };
}

/** The item as approvals see it: { id, ref, title, status, currency, total, owner_id, gross, net } */
async function load(db, entity, id) {
  if (entity === 'quote') {
    const d = (await db.query(`select id, ref, revision, title, status, currency, total, subtotal, owner_id, customer_id from quotes where id = $1`, [id])).rows[0];
    if (!d) return null;
    const l = (await db.query(`select coalesce(sum(quantity * unit_price), 0) as gross, coalesce(sum(line_total), 0) as net from quote_lines where quote_id = $1`, [id])).rows[0];
    return { ...d, label: d.revision > 1 ? `${d.ref} R${d.revision}` : d.ref, gross: Number(l.gross), net: Number(l.net), href: `/quotes/${d.id}` };
  }
  const d = (await db.query(`select po.id, po.ref, po.title, po.status, po.currency, po.total, po.subtotal, po.owner_id, s.name as supplier_name from purchase_orders po join suppliers s on s.id = po.supplier_id where po.id = $1`, [id])).rows[0];
  return d ? { ...d, label: d.ref, href: `/lpo/${d.id}` } : null;
}

/** What approval this item needs now: [{ level, roles, reasons: [] }] (empty when none). */
function required(r, entity, d) {
  const out = [];
  if (entity === 'quote') {
    if (!r.quote.enabled) return out;
    const reasons = [];
    const limit = r.quote.limits[d.currency];
    if (limit === undefined && Object.keys(r.quote.limits).length) reasons.push(`it is in ${d.currency}, which has no approval limit set`);
    else if (limit !== undefined && Number(d.total) >= limit) reasons.push(`the total, ${fmt(d.currency, d.total)}, is at or above ${fmt(d.currency, limit)}`);
    const pct = d.gross > 0 ? ((d.gross - d.net) / d.gross) * 100 : 0;
    if (r.quote.discountPct > 0 && pct >= r.quote.discountPct - 1e-9) reasons.push(`the discount, ${pct.toFixed(1)}%, is at or above ${r.quote.discountPct}%`);
    if (reasons.length) out.push({ level: 1, roles: r.quote.roles, reasons });
    return out;
  }
  if (!r.lpo.enabled) return out;
  out.push({ level: 1, roles: r.lpo.roles, reasons: ['every purchase order is approved before it is issued'] });
  const l2 = r.lpo.l2Limits[d.currency];
  if (Object.keys(r.lpo.l2Limits).length && (l2 === undefined || Number(d.total) >= l2)) {
    out.push({ level: 2, roles: r.lpo.l2Roles, reasons: [l2 === undefined ? `it is in ${d.currency}, which has no second-approval limit set` : `the total, ${fmt(d.currency, d.total)}, is at or above ${fmt(d.currency, l2)}`] });
  }
  return out;
}

const canDecide = (user, roles) => user && user.kind === 'staff' && (user.role === 'platform_admin' || (roles || []).includes(user.role));

/** Where the item stands: { needed: [{ level, roles, reasons, record }], complete, next, pending, rejected } */
async function state(db, entity, d, r = null) {
  r = r || (await rules(db));
  const needed = required(r, entity, d);
  const rows = (await db.query(`select a.*, rq.name as requested_by_name, dc.name as decided_by_name from approvals a join users rq on rq.id = a.requested_by left join users dc on dc.id = a.decided_by
                                 where a.entity = $1 and a.entity_id = $2 order by a.id desc`, [entity, d.id])).rows;
  const live = rows.filter((x) => x.status !== 'withdrawn');
  for (const n of needed) {
    const rec = live.find((x) => x.level === n.level) || null;
    // an approval counts only for the amount that was approved
    n.record = rec && rec.status === 'approved' && (Number(rec.amount) !== Number(d.total) || rec.currency !== d.currency) ? null : rec;
  }
  const complete = needed.every((n) => n.record && n.record.status === 'approved');
  const pending = needed.find((n) => n.record && n.record.status === 'pending') || null;
  const rejected = needed.find((n) => n.record && n.record.status === 'rejected') || null;
  const next = complete || pending ? null : needed.find((n) => !n.record || n.record.status !== 'approved') || null;
  return { needed, complete, pending, rejected, next, history: rows };
}

async function event(db, entity, d, actor, text) {
  if (entity === 'quote') await db.query('insert into quote_events (quote_id, actor_id, text) values ($1,$2,$3)', [d.id, actor.id, text]);
  else await db.query('insert into purchase_order_events (purchase_order_id, actor_id, text) values ($1,$2,$3)', [d.id, actor.id, text]);
}

/** Ask for the next approval the item needs. */
async function request(db, entity, id, actor, ip = '') {
  const d = await load(db, entity, id);
  if (!d) throw new UserError(`That ${ENTITY_LABEL[entity]} does not exist.`);
  if (d.status !== 'draft') throw new UserError(`Only a draft ${ENTITY_LABEL[entity]} is sent for approval.`);
  if (!Number(d.total)) throw new UserError('Add the lines first: there is nothing to approve yet.');
  const st = await state(db, entity, d);
  if (!st.needed.length) throw new UserError(`This ${ENTITY_LABEL[entity]} does not need approval.`);
  if (st.complete) throw new UserError('It is already approved.');
  if (st.pending) throw new UserError('Approval has already been asked for and is waiting for a decision.');
  const n = st.next;
  if (!n.roles.length) throw new UserError('No role is set to approve this. An administrator chooses the approvers in Settings, Approvals.');
  if (n.record && n.record.status === 'rejected') await db.query(`update approvals set status = 'withdrawn' where id = $1`, [n.record.id]);
  await db.query(`insert into approvals (entity, entity_id, level, roles, reasons, amount, currency, requested_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [entity, d.id, n.level, n.roles, n.reasons.join('; '), d.total, d.currency, actor.id]);
  await event(db, entity, d, actor, `${actor.name} asked for approval${n.level === 2 ? ' (second approver)' : ''}: ${n.reasons.join('; ')}.`);
  await audit(db, actor, 'approval_requested', entity, d.label, `${fmt(d.currency, d.total)}; level ${n.level}`, d.customer_id || null, ip);
}

/** Approve or decline one waiting request. Approving level 1 of an order that also needs level 2 asks for level 2 at once. */
async function decide(db, approvalId, actor, decision, comment, ip = '') {
  const a = (await db.query(`select * from approvals where id = $1 for update`, [approvalId])).rows[0];
  if (!a) throw new UserError('That approval request does not exist.');
  if (a.status !== 'pending') throw new UserError(`This request was already ${STATUS_LABELS[a.status].toLowerCase()}.`);
  if (!['approved', 'rejected'].includes(decision)) throw new UserError('Choose approve or decline.');
  const d = await load(db, a.entity, a.entity_id);
  if (!d || d.status !== 'draft') throw new UserError(`The ${ENTITY_LABEL[a.entity]} is no longer a draft.`);
  if (!canDecide(actor, a.roles)) throw new UserError('Your role cannot approve this.');
  if (actor.id === Number(a.requested_by) || actor.id === Number(d.owner_id)) throw new UserError(`You cannot approve your own ${ENTITY_LABEL[a.entity]}: someone else must decide.`);
  const note = u.str(comment, 1000);
  if (decision === 'rejected' && !note) throw new UserError('Say why it is not approved, so it can be put right.');
  if (Number(a.amount) !== Number(d.total) || a.currency !== d.currency) throw new UserError('The amount changed after approval was asked for. Ask for approval again.');
  await db.query(`update approvals set status = $2, decided_by = $3, decided_at = now(), comment = $4 where id = $1`, [a.id, decision, actor.id, note]);
  const word = decision === 'approved' ? 'approved' : 'did not approve';
  await event(db, a.entity, d, actor, `${actor.name} ${word} it${a.level === 2 ? ' (second approver)' : ''}${note ? `: ${note}` : '.'}`);
  await audit(db, actor, decision === 'approved' ? 'approval_granted' : 'approval_declined', a.entity, d.label, `${fmt(d.currency, d.total)}; level ${a.level}${note ? `; ${note}` : ''}`, d.customer_id || null, ip);
  if (decision === 'approved') {
    const st = await state(db, a.entity, d);
    if (st.next) {
      const requester = (await db.query('select id, name from users where id = $1', [a.requested_by])).rows[0];
      await db.query(`insert into approvals (entity, entity_id, level, roles, reasons, amount, currency, requested_by) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [a.entity, d.id, st.next.level, st.next.roles, st.next.reasons.join('; '), d.total, d.currency, requester.id]);
      await event(db, a.entity, d, actor, `Sent on for the second approval: ${st.next.reasons.join('; ')}.`);
    }
  }
  return { entity: a.entity, id: d.id, href: d.href };
}

/** Called when a draft changes: its approvals no longer cover it. */
async function withdraw(db, entity, id, actor, why = 'it was changed') {
  const r = await db.query(`update approvals set status = 'withdrawn', comment = case when comment = '' then $3 else comment end where entity = $1 and entity_id = $2 and status in ('pending','approved') returning id`, [entity, id, `Withdrawn: ${why}.`]);
  if (r.rowCount && actor) {
    const d = await load(db, entity, id);
    if (d) await event(db, entity, d, actor, `Approval withdrawn because ${why}. Ask for approval again when it is ready.`);
  }
  return r.rowCount;
}

/** Before a quote is sent or an order issued. */
async function assertApproved(db, entity, id) {
  const d = await load(db, entity, id);
  const st = await state(db, entity, d);
  if (st.complete) return;
  const what = entity === 'quote' ? 'sent' : 'issued';
  if (st.pending) throw new UserError(`This ${ENTITY_LABEL[entity]} is waiting for approval and cannot be ${what} yet.`);
  if (st.rejected) throw new UserError(`This ${ENTITY_LABEL[entity]} was not approved${st.rejected.record.comment ? ` (${st.rejected.record.comment})` : ''}. Change it and ask again.`);
  throw new UserError(`This ${ENTITY_LABEL[entity]} needs approval before it is ${what}: ${st.next.reasons.join('; ')}. Press "Ask for approval".`);
}

/** Requests waiting for this person (not their own). */
async function waitingFor(db, user) {
  if (!user || user.kind !== 'staff') return [];
  const rows = (await db.query(`select a.*, rq.name as requested_by_name from approvals a join users rq on rq.id = a.requested_by where a.status = 'pending' order by a.requested_at`)).rows;
  const out = [];
  for (const a of rows) {
    if (!canDecide(user, a.roles) || Number(a.requested_by) === user.id) continue;
    const d = await load(db, a.entity, a.entity_id);
    if (!d || Number(d.owner_id) === user.id) continue;
    out.push({ ...a, item: d });
  }
  return out;
}

/** Is this person an approver under the current rules (for the menu)? */
async function isApprover(db, user) {
  if (!user || user.kind !== 'staff') return false;
  if (user.role === 'platform_admin') return true;
  const r = await rules(db);
  return [...r.quote.roles, ...r.lpo.roles, ...r.lpo.l2Roles].includes(user.role);
}

module.exports = { DEFAULTS, KEYS, APPROVER_ROLES, STATUS_LABELS, ENTITY_LABEL, parseLimits, formatLimits, rules, required, state, load, request, decide, withdraw, assertApproved, waitingFor, isApprover, canDecide };
