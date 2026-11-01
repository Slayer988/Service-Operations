'use strict';
// Numbers behind the dashboards. Every query is limited by perms.ticketVisibility (a customer only sees their own company's tickets,
// staff without Security access never see the Security queue) and leaves out tickets still waiting for verification.
const perms = require('../lib/perms');
const charts = require('../lib/charts');

const OPEN_LIST = `'new','open','in_progress','pending_customer','pending_vendor','restored'`;
const OPEN = `t.status in (${OPEN_LIST})`;
const BREACHED = `t.paused_at is null and ((t.responded_at is null and t.response_due < now())
   or (t.restored_at is null and t.restoration_due < now()) or (t.resolved_at is null and t.resolution_due < now()))`;
const WARNED = `t.paused_at is null and ((t.responded_at is null and (t.sla_flags->>'response_warned') = 'true')
   or (t.restored_at is null and (t.sla_flags->>'restoration_warned') = 'true')
   or (t.resolved_at is null and (t.sla_flags->>'resolution_warned') = 'true'))`;

/** The day keys (YYYY-MM-DD, oldest first) of the last n days in the given time zone. */
function dayKeys(n, timezone, now = new Date()) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  const base = Date.parse(`${today}T00:00:00Z`);
  const out = [];
  for (let i = n - 1; i >= 0; i--) out.push(new Date(base - i * 86400000).toISOString().slice(0, 10));
  return out;
}
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dayLabel = (key) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${Number(key.slice(8, 10))}`;

/** Top four categories and the rest as "Other". rows: [{ name, n }] */
function topCategories(rows, keep = 4) {
  const sorted = rows.filter((r) => r.n > 0).sort((a, b) => b.n - a.n || String(a.name).localeCompare(String(b.name)));
  const head = sorted.slice(0, keep);
  const rest = sorted.slice(keep).reduce((a, r) => a + r.n, 0);
  if (rest) head.push({ name: 'Other', n: rest });
  const total = head.reduce((a, r) => a + r.n, 0);
  return head.map((r, i) => ({ name: r.name, n: r.n, pct: total ? Math.round((r.n / total) * 100) : 0, cls: `c${i}` }));
}

/** "Time left" for the nearest target that has not been met yet: { text, over } or null. */
function slaRemaining(t, now = new Date()) {
  if (t.paused_at) return { text: 'Paused', over: false };
  const dues = [];
  if (!t.responded_at && t.response_due) dues.push(new Date(t.response_due));
  if (!t.restored_at && t.restoration_due) dues.push(new Date(t.restoration_due));
  if (!t.resolved_at && t.resolution_due) dues.push(new Date(t.resolution_due));
  if (!dues.length) return null;
  const ms = Math.min(...dues.map((d) => d.getTime())) - now.getTime();
  return { text: charts.duration(ms), over: ms < 0 };
}

const pct = (met, missed) => (met + missed > 0 ? Math.round((met / (met + missed)) * 100) : null);
const tone = (p) => (p === null ? 'ok' : p >= 90 ? 'ok' : p >= 75 ? 'warn' : 'bad');

/**
 * The "Request a service" tiles come from the service catalogue (active, featured entries, in catalogue order).
 * An entry is only offered when its ticket category still exists in Settings; "More Services" opens the blank form.
 * `entries`: rows of service_catalogue { name, category, icon, description, request_type }.
 */
function serviceTiles(entries, categories) {
  const have = new Set(categories || []);
  const tiles = (entries || []).filter((e) => have.has(e.category))
    .map((e) => ({ label: e.name, category: e.category, icon: e.icon || 'grid', hint: String(e.description || '').split(/[.:]/)[0].slice(0, 40), type: e.request_type || 'request' }));
  return [...tiles, { label: 'More Services', category: '', icon: 'grid', hint: 'Anything else', type: 'request' }];
}
const CAT_ICONS = { hardware: 'laptop', 'access and accounts': 'lock', email: 'mail', network: 'wifi', printer: 'printer', security: 'shield', server: 'server', storage: 'server', software: 'code' };
const catIcon = (name) => CAT_ICONS[String(name || '').toLowerCase()] || 'pulse';

async function staff(q, user, timezone, tab) {
  const p = []; const vis = perms.ticketVisibility(user, p, 't');
  const base = `from tickets t where ${vis} and not t.needs_verification`;
  const one = async (extra, params = p) => (await q(`select count(*)::int as n ${base} ${extra}`, params)).rows[0].n;
  const open = await one(`and ${OPEN}`);
  const openThen = await one(`and t.created_at <= now() - interval '30 days' and (t.resolved_at is null or t.resolved_at > now() - interval '30 days')
      and (t.closed_at is null or t.closed_at > now() - interval '30 days')`);
  const resolved7 = await one(`and t.resolved_at >= now() - interval '7 days'`);
  const resolvedPrev = await one(`and t.resolved_at >= now() - interval '14 days' and t.resolved_at < now() - interval '7 days'`);
  const k = {
    open, openDelta: charts.delta(open, openThen),
    inProgress: await one(`and t.status = 'in_progress'`),
    atRisk: await one(`and ${OPEN} and not (${BREACHED}) and ${WARNED}`),
    breached: await one(`and ${OPEN} and ${BREACHED}`),
    resolved7, resolvedDelta: charts.delta(resolved7, resolvedPrev),
  };

  // 30-day trend, one point per day in the application's time zone
  const keys = dayKeys(30, timezone);
  const tp = [timezone]; const tv = perms.ticketVisibility(user, tp, 't');
  const created = new Map((await q(`select to_char((t.created_at at time zone $1)::date, 'YYYY-MM-DD') as d, count(*)::int as n from tickets t
     where ${tv} and not t.needs_verification and t.created_at >= now() - interval '32 days' group by 1`, tp)).rows.map((r) => [r.d, r.n]));
  const resolved = new Map((await q(`select to_char((t.resolved_at at time zone $1)::date, 'YYYY-MM-DD') as d, count(*)::int as n from tickets t
     where ${tv} and not t.needs_verification and t.resolved_at >= now() - interval '32 days' group by 1`, tp)).rows.map((r) => [r.d, r.n]));
  const trend = charts.lineChart({
    labels: keys.map(dayLabel), labelEvery: 7, integer: true,
    series: [{ name: 'Created', values: keys.map((d) => created.get(d) || 0), cls: 's0' }, { name: 'Resolved', values: keys.map((d) => resolved.get(d) || 0), cls: 's1' }],
  });

  const catRows = (await q(`select coalesce(nullif(t.category, ''), 'Other') as name, count(*)::int as n ${base} and t.created_at >= now() - interval '30 days' group by 1`, p)).rows;
  const categories = topCategories(catRows);
  const catTotal = categories.reduce((a, c) => a + c.n, 0);
  const catChart = charts.donut(categories.map((c) => ({ value: c.n, cls: c.cls })));

  const slaRow = async (typeCond) => {
    const r = (await q(`select count(*) filter (where t.resolved_at <= t.resolution_due)::int as met, count(*) filter (where t.resolved_at > t.resolution_due)::int as missed
       ${base} and t.resolution_due is not null and t.resolved_at >= now() - interval '30 days' ${typeCond}`, p)).rows[0];
    return pct(r.met, r.missed);
  };
  const respRow = (await q(`select count(*) filter (where t.responded_at <= t.response_due)::int as met, count(*) filter (where t.responded_at > t.response_due)::int as missed
       ${base} and t.response_due is not null and t.responded_at is not null and t.created_at >= now() - interval '30 days'`, p)).rows[0];
  const overall = await slaRow('');
  const sla = [
    { label: 'Incidents', pct: await slaRow(`and t.type = 'incident'`) },
    { label: 'Service Requests', pct: await slaRow(`and t.type = 'request'`) },
    { label: 'Response times', pct: pct(respRow.met, respRow.missed) },
  ].map((r) => ({ ...r, tone: tone(r.pct), bar: charts.bar(r.pct === null ? 0 : r.pct, tone(r.pct)) }));
  k.compliance = overall;

  const mine = await myTickets(q, user, tab, `t.assignee_id = ${Number(user.id)}`, p, vis, true);
  return { k, trend, catChart, categories, catTotal, sla, mine };
}

/** The table at the bottom: tabs Open / In Progress / Resolved with counts. */
async function myTickets(q, user, tab, extraCond, params, vis, withSla) {
  const base = `from tickets t where ${vis} and not t.needs_verification and ${extraCond}`;
  const tabs = {
    open: `t.status in ('new','open','pending_customer','pending_vendor','restored')`,
    in_progress: `t.status = 'in_progress'`,
    resolved: `t.status in ('resolved','closed') and coalesce(t.resolved_at, t.closed_at, t.updated_at) >= now() - interval '30 days'`,
  };
  const counts = {};
  for (const [name, cond] of Object.entries(tabs)) counts[name] = (await q(`select count(*)::int as n ${base} and ${cond}`, params)).rows[0].n;
  const active = tabs[tab] ? tab : 'open';
  const rows = (await q(
    `select t.ref, t.subject, t.status, t.priority, t.category, t.updated_at, t.response_due, t.restoration_due, t.resolution_due,
            t.responded_at, t.restored_at, t.resolved_at, t.paused_at
       ${base} and ${tabs[active]} order by t.priority, t.created_at desc limit 8`, params)).rows;
  const now = new Date();
  return { tab: active, counts, rows: rows.map((r) => ({ ...r, sla: withSla ? slaRemaining(r, now) : null })) };
}

async function customer(q, user, tab) {
  const p = []; const vis = perms.ticketVisibility(user, p, 't');
  const base = `from tickets t where ${vis} and not t.needs_verification`;
  const one = async (extra) => (await q(`select count(*)::int as n ${base} ${extra}`, p)).rows[0].n;
  const k = {
    open: await one(`and ${OPEN}`),
    inProgress: await one(`and t.status = 'in_progress'`),
    waiting: await one(`and t.status = 'pending_customer'`),
    resolved30: await one(`and t.resolved_at >= now() - interval '30 days'`),
  };
  const mine = await myTickets(q, user, tab, 'true', p, vis, false);
  return { k, mine };
}

/** Counts for the bell in the top bar. Failures here must never break a page. */
async function alerts(q, user) {
  const out = { items: [], count: 0 };
  try {
    const p = []; const vis = perms.ticketVisibility(user, p, 't');
    if (user.kind === 'customer') {
      const n = (await q(`select count(*)::int as n from tickets t where ${vis} and t.status = 'pending_customer'`, p)).rows[0].n;
      if (n) out.items.push({ text: `${n} request${n === 1 ? ' is' : 's are'} waiting for your reply`, href: '/portal/tickets' });
    } else {
      if (perms.can(user, 'ticket.view')) {
        if (perms.can(user, 'ticket.verify')) {
          const n = (await q(`select count(*)::int as n from tickets t where t.needs_verification and t.status = 'new' and ${vis}`, p)).rows[0].n;
          out.verification = n;
          if (n) out.items.push({ text: `${n} ticket${n === 1 ? '' : 's'} awaiting verification`, href: '/verification' });
        }
        const b = (await q(`select count(*)::int as n from tickets t where ${vis} and not t.needs_verification and ${OPEN} and ${BREACHED}`, p)).rows[0].n;
        if (b) out.items.push({ text: `${b} ticket${b === 1 ? ' has' : 's have'} breached an SLA target`, href: '/tickets?view=breached' });
      }
      if (perms.can(user, 'mail.view')) {
        const m = (await q(`select address from mailboxes where enabled and alert_state = 'alerted' ${perms.can(user, 'security.view') ? '' : `and queue <> 'security'`} order by id`)).rows;
        if (m.length) out.items.push({ text: `Mailbox not being read: ${m.map((r) => r.address).join(', ')}`, href: '/mail' });
      }
      // business modules
      if (perms.can(user, 'contract.view')) {
        const c = (await q(`select count(*) filter (where status in ('active','expiring_soon','renewal_in_progress') and end_date between current_date and current_date + 30)::int as soon, count(*) filter (where status = 'expired')::int as expired from contracts`)).rows[0];
        if (c.soon) out.items.push({ text: `${c.soon} contract${c.soon === 1 ? ' ends' : 's end'} within 30 days`, href: '/contracts?within=30' });
        if (c.expired) out.items.push({ text: `${c.expired} contract${c.expired === 1 ? ' has' : 's have'} expired and not been closed`, href: '/contracts?status=expired' });
        const o = (await q(`select count(*)::int as n from contract_obligations o join contracts c on c.id = o.contract_id where o.status in ('open','in_progress') and o.due_date < current_date and c.status not in ('terminated','closed')`)).rows[0].n;
        if (o) out.items.push({ text: `${o} contractual obligation${o === 1 ? ' is' : 's are'} overdue`, href: '/contracts/reports/obligations' });
      }
      if (perms.can(user, 'tender.view')) {
        const t = (await q(`select count(*) filter (where submission_due between now() and now() + interval '3 days')::int as soon, count(*) filter (where submission_due < now())::int as late from tenders where status in ('identified','registered','under_review','qualification','bid_preparation','internal_approval')`)).rows[0];
        if (t.soon) out.items.push({ text: `${t.soon} tender${t.soon === 1 ? ' is' : 's are'} due within 3 days`, href: '/tenders?status=active' });
        if (t.late) out.items.push({ text: `${t.late} tender${t.late === 1 ? ' is' : 's are'} past the submission deadline and not submitted`, href: '/tenders?status=active' });
      }
      if (perms.can(user, 'pipeline.view')) {
        const f = (await q(`select count(*)::int as n from opportunities where stage not in ('won','lost') and next_step_date < current_date and coalesce(next_step_owner_id, owner_id) = $1`, [user.id])).rows[0].n;
        if (f) out.items.push({ text: `${f} opportunity follow-up${f === 1 ? ' is' : 's are'} overdue`, href: '/pipeline?view=list&owner=me' });
      }
      if (perms.can(user, 'pipeline.support')) {
        const t = (await q(`select count(*)::int as n from opp_tasks t join opportunities o on o.id = t.opportunity_id where t.assignee_id = $1 and t.status <> 'completed' and t.due_date < current_date and o.stage not in ('won','lost')`, [user.id])).rows[0].n;
        if (t) out.items.push({ text: `${t} of your technical task${t === 1 ? ' is' : 's are'} overdue`, href: '/pipeline/sde' });
      }
    }
  } catch (err) {
    console.error('[alerts]', err && err.message);
  }
  out.count = out.items.length;
  return out;
}

module.exports = { serviceTiles, catIcon, OPEN, OPEN_LIST, BREACHED, WARNED, dayKeys, dayLabel, topCategories, slaRemaining, tone, pct, staff, customer, alerts };
