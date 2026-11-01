'use strict';
// Background SLA watch (SLA-006) and automatic closure of resolved tickets.
const sla = require('../lib/sla');
const settings = require('../lib/settings');
const tickets = require('./tickets');
const notifications = require('./notifications');
const priorityLib = require('../lib/priority');

const NEXT_TIER = { l1: 'l2', l2: 'l3', l3: 'l3' };
const LABEL = { response: 'response', restoration: 'restoration', resolution: 'resolution' };

async function slaWatch(db) {
  const st = await settings.getAll(db, ['sla_warn_percent']);
  const warnPct = Number(st.sla_warn_percent || 20);
  const open = await db.query(
    `select id from tickets where status in ('new','open','in_progress','pending_vendor','restored')
        and paused_at is null and not needs_verification and sla_policy_id is not null`);
  const policies = new Map();
  let touched = 0;
  for (const { id } of open.rows) {
    const t = await tickets.summary(db, id);
    if (!t) continue;
    if (!policies.has(t.sla_policy_id)) policies.set(t.sla_policy_id, await tickets.loadPolicy(db, t.sla_policy_id));
    const policy = policies.get(t.sla_policy_id);
    if (!policy) continue;
    const targets = policy.targets[t.priority];
    const flags = { ...(t.sla_flags || {}) };
    const newFlags = {};
    const now = new Date();
    for (const k of sla.TARGETS) {
      const due = t[`${k}_due`];
      const met = k === 'response' ? t.responded_at : k === 'restoration' ? t.restored_at : t.resolved_at;
      if (!due || met || !targets) continue;
      const dueD = new Date(due);
      if (dueD <= now) {
        if (!flags[`${k}_breached`]) newFlags[`${k}_breached`] = true;
      } else if (!flags[`${k}_warned`]) {
        const remaining = sla.businessMinutesBetween(now, dueD, policy.calendar);
        if (remaining <= Math.max(15, (targets[k] * warnPct) / 100)) newFlags[`${k}_warned`] = true;
      }
    }
    if (!Object.keys(newFlags).length) continue;
    touched++;
    await db.query(`update tickets set sla_flags = sla_flags || $2::jsonb where id = $1`, [t.id, JSON.stringify(newFlags)]);
    const recipients = new Map();
    for (const uid of [t.exec_engineer_id, t.assignee_id].filter(Boolean)) {
      const u = (await db.query('select id, email, name, kind, role from users where id = $1 and active', [uid])).rows[0];
      if (u) recipients.set(u.id, u);
    }
    for (const key of Object.keys(newFlags)) {
      const [target, kind] = key.split('_');
      const breached = kind === 'breached';
      await tickets.event(db, t.id, null, 'sla', `SLA ${LABEL[target]} target ${breached ? 'was breached' : 'is at risk'}.`, true);
      const people = breached ? [...recipients.values(), ...(await notifications.supervisors(db, t.queue))] : [...recipients.values()];
      const seen = new Set();
      for (const u of people) {
        if (seen.has(u.id)) continue; seen.add(u.id);
        await notifications.enqueue(db, {
          kind: breached ? 'sla_breach' : 'sla_warning', ticketId: t.id, to: u, dedupeKey: `sla:${t.id}:${key}:${t.created_at.getTime()}:${u.id}:${t[`${target}_due`] && new Date(t[`${target}_due`]).getTime()}`,
          subject: `[${t.ref}] SLA ${LABEL[target]} ${breached ? 'BREACHED' : 'at risk'}: ${t.subject}`.slice(0, 200),
          body: `The ${LABEL[target]} target for ${t.ref} ${breached ? 'has been missed' : 'is about to be missed'}.\n\nCustomer: ${t.customer_name || 'n/a'}\nService: ${t.service_name || 'n/a'}\nPriority: ${priorityLib.LABELS[t.priority]}\nDue: ${new Date(t[`${target}_due`]).toISOString()}\n\n${notifications.link(u, t.ref)}\n`,
        });
      }
      if (breached && t.tier !== 'l3') {
        await tickets.escalate(db, await tickets.summary(db, t.id), NEXT_TIER[t.tier], null, 'automatic escalation after SLA breach');
      }
    }
  }
  return touched;
}

/** Resolved tickets are closed automatically after `auto_close_days` without a reply. */
async function autoClose(db) {
  const days = Number((await settings.get(db, 'auto_close_days', 3)) || 3);
  const r = await db.query(
    `select id from tickets where status = 'resolved' and resolved_at < now() - ($1 || ' days')::interval`, [String(days)]);
  for (const { id } of r.rows) {
    const t = await tickets.summary(db, id);
    await tickets.setStatus(db, t, 'closed', null);
  }
  return r.rows.length;
}

module.exports = { slaWatch, autoClose };
