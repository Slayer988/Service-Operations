'use strict';
// Operations Overview: the weekly executive page. Twelve tiles across pre-sales, delivery, SLA and support, each compared with the
// week before, plus the week's highlights and a status summary. Every figure comes from the records in the system; the only typed
// text is the two highlight sentences. A tile appears only if the viewer may see the records behind it.
//
// "This week" is Monday to Sunday in the application's time zone. Counts such as "open now" are measured at the end of the week
// (or now, for the current week) and compared with the same count at the start of the week, rebuilt from created / closed dates.
const config = require('../config');
const perms = require('../lib/perms');
const P = require('./pipeline');
const u = require('../lib/util');
const { UserError } = require('./tickets');

const LIVE_CONTRACT_END = `('terminated','closed','suspended')`;

// ---------------------------------------------------------------- weeks
const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => iso(new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000));
/** The Monday of the week that contains the given YYYY-MM-DD day. */
function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`);
  return addDays(day, -((d.getUTCDay() + 6) % 7));
}
/** ISO week number (1-53) of a day. */
function isoWeek(day) {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;                       // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow + 3);                    // the Thursday of this week decides the year
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((d - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
}
const todayIn = (tz) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());

// ---------------------------------------------------------------- formatting
/** 1234 -> "1.2K", 2500000 -> "2.5M", 3100000000 -> "3.1B". */
function compact(n) {
  const v = Number(n) || 0; const a = Math.abs(v);
  const f = (x, s) => `${(Math.round(x * 10) / 10).toString().replace(/\.0$/, '')}${s}`;
  if (a >= 1e9) return f(v / 1e9, 'B');
  if (a >= 1e6) return f(v / 1e6, 'M');
  if (a >= 1e4) return f(v / 1e3, 'K');
  return Math.round(v).toLocaleString('en-US');
}
/** Change between two counts: { dir: 'up'|'down'|'flat', abs, pct } (pct is null when there was nothing to compare with). */
function change(now, before) {
  const abs = (Number(now) || 0) - (Number(before) || 0);
  const pct = Number(before) > 0 ? Math.round((100 * abs) / Number(before)) : (abs === 0 ? 0 : null);
  return { dir: abs > 0 ? 'up' : abs < 0 ? 'down' : 'flat', abs, pct };
}
const signed = (n) => `${n > 0 ? '+' : n < 0 ? '−' : '+'}${Math.abs(n)}`;
/** A tile's comparison text. `good` is the direction that is good news. */
function delta(ch, good = 'up') {
  const tone = ch.dir === 'flat' ? 'flat' : (ch.dir === good ? 'good' : 'worse');
  return { tone, dir: ch.dir, pct: ch.pct === null ? `${ch.abs < 0 ? '−' : '+'}${compact(Math.abs(ch.abs))}` : `${ch.pct > 0 ? '+' : ch.pct < 0 ? '−' : '+'}${Math.abs(ch.pct)}%`, abs: signed(ch.abs) };
}
const slaTone = (pct) => (pct === null ? '' : pct >= 95 ? 'ok' : pct >= 85 ? 'warn' : 'bad');

// ---------------------------------------------------------------- the figures
/** The SQL window for a week: instants t0 (start of last week), t1 (start of this week), t2 (end of this week, or now if it is still running). */
const WINDOW = `($1::date - 7)::timestamp at time zone $2::text as t0, $1::date::timestamp at time zone $2::text as t1,
                least(now(), ($1::date + 7)::timestamp at time zone $2::text) as t2`;

async function pipelineFigures(q, ws, tz, cur) {
  const r = (await q(
    `with w as (select ${WINDOW})
     select
       count(*) filter (where created_at < w.t2 and ((closed_at is null and stage = any($3)) or closed_at >= w.t2))::int as open_now,
       count(*) filter (where created_at < w.t1 and ((closed_at is null and stage = any($3)) or closed_at >= w.t1))::int as open_prev,
       coalesce(sum(value) filter (where currency = $4 and created_at < w.t2 and ((closed_at is null and stage = any($3)) or closed_at >= w.t2)), 0) as value_now,
       coalesce(sum(value) filter (where currency = $4 and created_at < w.t1 and ((closed_at is null and stage = any($3)) or closed_at >= w.t1)), 0) as value_prev,
       count(*) filter (where created_at >= w.t1 and created_at < w.t2)::int as new_now,
       count(*) filter (where stage = 'won' and closed_at >= w.t1 and closed_at < w.t2)::int as won_now,
       count(*) filter (where stage = 'won' and closed_at >= w.t0 and closed_at < w.t1)::int as won_prev,
       coalesce(sum(value) filter (where stage = 'won' and currency = $4 and closed_at >= w.t1 and closed_at < w.t2), 0) as won_value_now,
       coalesce(sum(value) filter (where stage = 'won' and currency = $4 and closed_at >= w.t0 and closed_at < w.t1), 0) as won_value_prev,
       count(*) filter (where escalated_at < w.t2 and (escalation_cleared_at is null or escalation_cleared_at >= w.t2) and (closed_at is null or closed_at >= w.t2))::int as esc_now,
       count(*) filter (where escalated_at < w.t1 and (escalation_cleared_at is null or escalation_cleared_at >= w.t1) and (closed_at is null or closed_at >= w.t1))::int as esc_prev,
       count(*) filter (where created_at < w.t2 and ((closed_at is null and stage = any($3)) or closed_at >= w.t2) and currency <> $4)::int as other_currency
     from opportunities, w`, [ws, tz, P.OPEN, cur])).rows[0];
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

async function projectFigures(q, ws, tz) {
  const r = (await q(
    `with w as (select ${WINDOW})
     select
       count(*) filter (where created_at < w.t2 and (closed_at is null or closed_at >= w.t2))::int as open_now,
       count(*) filter (where created_at < w.t1 and (closed_at is null or closed_at >= w.t1))::int as open_prev,
       count(*) filter (where created_at >= w.t1 and created_at < w.t2)::int as new_now,
       count(*) filter (where closed_at is null and status = 'active')::int as active_now,
       count(*) filter (where closed_at is null and (health = 'red' or escalated))::int as at_risk,
       count(*) filter (where closed_at is null and escalated)::int as escalated
     from projects, w`, [ws, tz])).rows[0];
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}

const RESP = `case when t.response_due is null then null when t.responded_at is not null then t.responded_at <= t.response_due when now() > t.response_due then false else null end`;
const RESO = `case when t.resolution_due is null then null when t.resolved_at is not null then t.resolved_at <= t.resolution_due when now() > t.resolution_due then false else null end`;

async function ticketFigures(q, user, ws, tz) {
  const params = [ws, tz];
  const vis = perms.ticketVisibility(user, params, 't');
  const r = (await q(
    `with w as (select ${WINDOW})
     select
       count(*) filter (where t.status in ('new','open','in_progress','pending_customer','pending_vendor','restored') and t.created_at < w.t2)::int as open_now,
       count(*) filter (where t.created_at < w.t1 and (t.resolved_at is null or t.resolved_at >= w.t1) and (t.closed_at is null or t.closed_at >= w.t1) and not (t.status = 'cancelled' and t.updated_at < w.t1))::int as open_prev,
       count(*) filter (where t.created_at >= w.t1 and t.created_at < w.t2)::int as new_now,
       count(*) filter (where t.created_at >= w.t1 and t.created_at < w.t2 and (${RESP}) is true)::int as rm_now,
       count(*) filter (where t.created_at >= w.t1 and t.created_at < w.t2 and (${RESP}) is false)::int as rx_now,
       count(*) filter (where t.created_at >= w.t1 and t.created_at < w.t2 and (${RESO}) is true)::int as om_now,
       count(*) filter (where t.created_at >= w.t1 and t.created_at < w.t2 and (${RESO}) is false)::int as ox_now,
       count(*) filter (where t.created_at >= w.t0 and t.created_at < w.t1 and (${RESP}) is true)::int as rm_prev,
       count(*) filter (where t.created_at >= w.t0 and t.created_at < w.t1 and (${RESP}) is false)::int as rx_prev,
       count(*) filter (where t.created_at >= w.t0 and t.created_at < w.t1 and (${RESO}) is true)::int as om_prev,
       count(*) filter (where t.created_at >= w.t0 and t.created_at < w.t1 and (${RESO}) is false)::int as ox_prev,
       count(*) filter (where (t.response_due >= w.t1 and t.response_due < w.t2 and (${RESP}) is false) or (t.resolution_due >= w.t1 and t.resolution_due < w.t2 and (${RESO}) is false))::int as breach_now,
       count(*) filter (where (t.response_due >= w.t0 and t.response_due < w.t1 and (${RESP}) is false) or (t.resolution_due >= w.t0 and t.resolution_due < w.t1 and (${RESO}) is false))::int as breach_prev,
       count(*) filter (where t.type = 'incident' and t.sla_policy_id is null and t.created_at >= w.t1 and t.created_at < w.t2)::int as nonsla_now,
       count(*) filter (where t.type = 'incident' and t.sla_policy_id is null and t.created_at >= w.t0 and t.created_at < w.t1)::int as nonsla_prev,
       count(*) filter (where t.type = 'incident' and t.sla_policy_id is null and t.non_chargeable and t.created_at >= w.t1 and t.created_at < w.t2)::int as nc_now,
       count(*) filter (where t.type = 'incident' and t.sla_policy_id is null and t.non_chargeable and t.created_at >= w.t0 and t.created_at < w.t1)::int as nc_prev
     from tickets t, w where not t.needs_verification and (${vis})`, params)).rows[0];
  return Object.fromEntries(Object.entries(r).map(([k, v]) => [k, Number(v)]));
}
const pctMet = (m, x) => (m + x > 0 ? Math.round((1000 * m) / (m + x)) / 10 : null);

async function slaAccounts(q, ws, tz) {
  const r = (await q(
    `with w as (select ${WINDOW}),
          d as (select (w.t1 at time zone $2::text)::date as d1, (w.t2 at time zone $2::text)::date as d2 from w)
     select count(distinct c.customer_id) filter (where c.start_date <= d.d2 and (c.end_date is null or c.end_date >= d.d2))::int as now,
            count(distinct c.customer_id) filter (where c.start_date <= d.d1 and (c.end_date is null or c.end_date >= d.d1))::int as prev
       from contracts c, d where c.sla_policy_id is not null and c.customer_id is not null and c.status not in ${LIVE_CONTRACT_END}`, [ws, tz])).rows[0];
  return { now: Number(r.now), prev: Number(r.prev) };
}

async function renewalAccounts(q, ws, tz, days) {
  const r = (await q(
    `with w as (select ${WINDOW}),
          d as (select (w.t1 at time zone $2::text)::date as d1, (w.t2 at time zone $2::text)::date as d2 from w)
     select count(distinct c.customer_id) filter (where c.start_date <= d.d2 and c.end_date between d.d2 and d.d2 + $3::int)::int as now,
            count(distinct c.customer_id) filter (where c.start_date <= d.d1 and c.end_date between d.d1 and d.d1 + $3::int)::int as prev,
            count(*) filter (where c.start_date <= d.d2 and c.end_date between d.d2 and d.d2 + $3::int)::int as contracts_now
       from contracts c, d where c.customer_id is not null and c.counterparty_kind = 'customer' and c.status not in ${LIVE_CONTRACT_END}`, [ws, tz, days])).rows[0];
  return { now: Number(r.now), prev: Number(r.prev), contracts: Number(r.contracts_now) };
}

// ---------------------------------------------------------------- the page
/**
 * Everything the page needs for the week that contains `day`. Returns { week, tiles, summary, highlights, escalated, canEdit }.
 * opts: { today?, tz?, currency, expiringDays }
 */
async function weekly(q, user, day, opts = {}) {
  const tz = opts.tz || config.timezone;
  const today = opts.today || todayIn(tz);
  const ws = weekStart(u.dateStr(day) || today);
  const cur = opts.currency || 'UGX';
  const can = (p) => perms.can(user, p);
  const thisWeek = ws === weekStart(today);
  const week = { start: ws, end: addDays(ws, 6), number: isoWeek(ws), prev: addDays(ws, -7), next: addDays(ws, 7), current: thisWeek, future: ws > weekStart(today), today };

  const tiles = []; const add = (t) => tiles.push(t);
  const money = (n) => `${cur} ${compact(n)}`;
  let pf = null; let pj = null; let tk = null; let slaAcc = null; let ren = null;
  if (can('pipeline.view')) pf = await pipelineFigures(q, ws, tz, cur);
  if (can('project.view')) pj = await projectFigures(q, ws, tz);
  if (can('ticket.view')) tk = await ticketFigures(q, user, ws, tz);
  if (can('customer.view')) slaAcc = await slaAccounts(q, ws, tz);
  if (can('contract.view')) ren = await renewalAccounts(q, ws, tz, opts.expiringDays || 90);

  // row 1: pre-sales and delivery
  if (pf) {
    add({ key: 'deals', label: 'Total Active Pre-Sales Deals', icon: 'funnel', href: '/pipeline?view=list&stage=open', value: String(pf.open_now), note: `${pf.new_now} new this week`, delta: delta(change(pf.open_now, pf.open_prev)), help: 'Open opportunities at the end of the week, against the start of the week.' });
    add({ key: 'value', label: 'Pre-Sales Pipeline Value', icon: 'dollar', href: '/pipeline', value: money(pf.value_now), note: pf.other_currency ? `${cur} only; ${pf.other_currency} deal(s) in other currencies` : `${money(pf.value_prev)} last week`, delta: delta(change(pf.value_now, pf.value_prev)), help: `Value of open opportunities in ${cur}.` });
  }
  if (pj) add({ key: 'projects', label: 'Active Delivery Projects', icon: 'project', href: '/projects?status=open', value: String(pj.open_now), note: `${pj.new_now} new this week`, delta: delta(change(pj.open_now, pj.open_prev)), help: 'Projects that are planning, active or on hold, at the end of the week against the start.' });
  if (pf) add({ key: 'closed', label: 'Closed Pipeline', icon: 'trophy', href: '/pipeline/reports/winloss', value: money(pf.won_value_now), note: `${pf.won_now} deal${pf.won_now === 1 ? '' : 's'} won this week`, delta: delta(change(pf.won_value_now, pf.won_value_prev)), help: 'Value of deals won in the week, against last week.' });
  // row 2: SLA and support
  if (slaAcc) add({ key: 'slaaccounts', label: 'Active SLA Accounts', icon: 'shield', href: '/customers', value: String(slaAcc.now), note: `${signed(slaAcc.now - slaAcc.prev)} from last week`, delta: delta(change(slaAcc.now, slaAcc.prev)), help: 'Customers with a contract in force that carries an SLA.' });
  if (tk) {
    const cNow = pctMet(tk.rm_now + tk.om_now, tk.rx_now + tk.ox_now); const cPrev = pctMet(tk.rm_prev + tk.om_prev, tk.rx_prev + tk.ox_prev);
    const pts = cNow !== null && cPrev !== null ? Math.round((cNow - cPrev) * 10) / 10 : null;
    add({ key: 'compliance', label: 'Avg SLA Compliance %', icon: 'percent', href: '/reports/sla_customer', value: cNow === null ? '–' : `${cNow}%`, tone: slaTone(cNow), note: cPrev === null ? 'no SLA tickets last week' : `${cPrev}% last week`,
      delta: pts === null ? { tone: 'flat', dir: 'flat', pct: '–', abs: '' } : { ...delta({ dir: pts > 0 ? 'up' : pts < 0 ? 'down' : 'flat', abs: pts, pct: pts }, 'up'), pct: `${pts > 0 ? '+' : pts < 0 ? '−' : '+'}${Math.abs(pts)} pts` }, help: 'Response and resolution targets met, for tickets raised in the week. Tickets still inside their target are not counted.' });
    add({ key: 'breaches', label: 'SLA Breaches This Week', icon: 'alert', href: '/reports/breaches', value: String(tk.breach_now), tone: tk.breach_now ? 'bad' : '', note: `${tk.breach_prev} last week`, delta: delta(change(tk.breach_now, tk.breach_prev), 'down'), help: 'Tickets whose response or resolution target fell due in the week and was missed.' });
    add({ key: 'open', label: 'Open Support Tickets', icon: 'ticket', href: '/reports/open_tickets', value: String(tk.open_now), note: `${tk.new_now} raised this week`, delta: delta(change(tk.open_now, tk.open_prev), 'down'), help: 'Tickets not yet resolved.' });
  }
  // row 3: non-SLA work, renewals, escalation
  if (tk) add({ key: 'nonsla', label: 'Post-Sale Support Incidents (Non-SLA)', icon: 'headset', href: '/tickets?type=incident', value: String(tk.nonsla_now), note: `${tk.nonsla_prev} last week`, delta: delta(change(tk.nonsla_now, tk.nonsla_prev), 'down'), help: 'Incidents raised in the week for customers or services with no SLA.' });
  if (ren) add({ key: 'renewals', label: 'B2B Renewal Accounts', icon: 'refresh', href: '/contracts?within=90', value: String(ren.now), note: `${ren.contracts} contract${ren.contracts === 1 ? '' : 's'} ending within ${opts.expiringDays || 90} days`, delta: delta(change(ren.now, ren.prev), 'down'), help: 'Customers with a contract that ends within the renewal window.' });
  if (tk) add({ key: 'nonchargeable', label: 'Non-Chargeable Incidents (Non-SLA)', icon: 'clock', href: '/tickets?type=incident', value: String(tk.nc_now), note: `${tk.nc_prev} last week`, delta: delta(change(tk.nc_now, tk.nc_prev), 'down'), help: 'Non-SLA incidents the team marked as non-chargeable.' });
  if (pf) add({ key: 'escalated', label: 'Deals Requiring Escalation', icon: 'arrowup', href: '/pipeline', value: String(pf.esc_now), tone: pf.esc_now ? 'hot' : '', note: `${signed(pf.esc_now - pf.esc_prev)} from last week`, delta: delta(change(pf.esc_now, pf.esc_prev), 'down'), help: 'Open deals flagged as needing leadership support.' });

  // status summary
  const compliance = tk ? pctMet(tk.rm_now + tk.om_now, tk.rx_now + tk.ox_now) : null;
  const summary = [];
  if (pf) summary.push({ label: 'Pre-sales Deals', value: String(pf.open_now), tone: '' });
  if (pj) summary.push({ label: 'Delivery', value: `${pj.active_now} Active`, tone: '' });
  if (tk) summary.push({ label: 'SLA', value: compliance === null ? '–' : `${compliance}%`, tone: slaTone(compliance) });
  if (tk) summary.push({ label: 'Support', value: `${tk.open_now} open`, tone: tk.open_now ? 'warn' : '' });

  // highlights: two sentences typed for the week, two counts from the records
  const hl = (await q('select top_presales, major_delivery, updated_at, (select name from users where id = updated_by) as updated_by_name from weekly_highlights where week_start = $1', [ws])).rows[0] || { top_presales: '', major_delivery: '' };
  const escalatedItems = [];
  if (pf) escalatedItems.push(...(await q(`select 'deal' as kind, id, ref, name, escalation_note as note from opportunities where escalated and stage = any($1) order by escalated_at limit 12`, [P.ACTIVE])).rows);
  if (pj) escalatedItems.push(...(await q(`select 'project' as kind, id, ref, name, escalation_note as note from projects where escalated and closed_at is null order by updated_at desc limit 12`)).rows);
  const riskProjects = pj ? pj.at_risk : 0;
  const leadership = (pf ? pf.esc_now : 0) + (pj ? pj.escalated : 0);

  return { week, tiles, summary, highlights: { top_presales: hl.top_presales, major_delivery: hl.major_delivery, updated_at: hl.updated_at || null, updated_by: hl.updated_by_name || '', risk: riskProjects, leadership, showRisk: !!pj, showLeadership: !!(pf || pj) },
    escalated: escalatedItems, canEdit: can('operations.manage') };
}

async function saveHighlights(db, ws, b, actor) {
  const day = u.dateStr(ws);
  if (!day || weekStart(day) !== day) throw new UserError('That is not the start of a week.');
  await db.query(
    `insert into weekly_highlights (week_start, top_presales, major_delivery, updated_by, updated_at) values ($1,$2,$3,$4,now())
     on conflict (week_start) do update set top_presales = excluded.top_presales, major_delivery = excluded.major_delivery, updated_by = excluded.updated_by, updated_at = now()`,
    [day, u.str(b.top_presales, 300), u.str(b.major_delivery, 300), actor.id]);
}

module.exports = { weekly, saveHighlights, weekStart, isoWeek, addDays, todayIn, compact, change, delta, slaTone, pctMet };
