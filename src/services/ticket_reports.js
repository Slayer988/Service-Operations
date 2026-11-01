'use strict';
// Service Desk reports, grouped into categories. Every report has the same shape ({ columns, rows, summary?, chart? }) so
// src/lib/reporting.js can show it on screen and send it as CSV, Excel or PDF. Visibility follows ticket access: the Security queue
// appears only for people with security.view, and tickets awaiting verification are never counted.
const perms = require('../lib/perms');
const config = require('../config');
const priorityLib = require('../lib/priority');
const charts = require('../lib/charts');
const tickets = require('./tickets');

const CATEGORIES = [
  { id: 'volume', title: 'Ticket volume and trends', text: 'How much work arrives, through which channel, and for what.' },
  { id: 'sla', title: 'SLA and performance', text: 'Response and resolution against target, breaches and times taken.' },
  { id: 'customers', title: 'Customers and services', text: 'Demand per customer, per service and per requester.' },
  { id: 'people', title: 'People and workload', text: 'Work and results per engineer.' },
  { id: 'backlog', title: 'Backlog and ageing', text: 'What is open now, how old it is, and what is at risk.' },
  { id: 'quality', title: 'Resolution and satisfaction', text: 'How tickets were resolved and how customers rated them.' },
  { id: 'security', title: 'Security', text: 'Tickets in the Security queue.', perm: 'security.view' },
];

// A ticket's response / resolution was met (true), missed (false) or is still running (null).
const RESP = `case when t.response_due is null then null when t.responded_at is not null then t.responded_at <= t.response_due when now() > t.response_due then false else null end`;
const RESO = `case when t.resolution_due is null then null when t.resolved_at is not null then t.resolved_at <= t.resolution_due when now() > t.resolution_due then false else null end`;
const OPEN = `('new','open','in_progress','pending_customer','pending_vendor','restored')`;
const hours = (a, b) => `round(avg(extract(epoch from (${b} - ${a})) / 3600) filter (where ${b} is not null)::numeric, 1)`;
const ts = (col, p) => `to_char(${col} at time zone ${p.tz}, 'YYYY-MM-DD HH24:MI')`;

/** Builds the WHERE clause for tickets the person may see. period=false is a snapshot of what is open now. */
function scope(user, p, { period = true, col = 't.created_at' } = {}) {
  const params = []; const where = ['not t.needs_verification'];
  if (period) { params.push(p.from, p.to); where.push(`${col} >= $1::date and ${col} < ($2::date + 1)`); }
  where.push(perms.ticketVisibility(user, params, 't'));
  if (p.customer) { params.push(p.customer); where.push(`t.customer_id = $${params.length}`); }
  // The time-zone parameter is always part of the statement, even when a report does not format times, because PostgreSQL
  // refuses a statement that is sent more parameters than it uses.
  params.push(config.timezone);
  const tz = `$${params.length}::text`;
  where.push(`${tz} is not null`);
  return { params, where: where.join(' and '), tz };
}
const pn = (v) => (v === null || v === undefined ? null : Number(v));
const num = (rows, keys) => rows.map((r) => { const o = { ...r }; for (const k of keys) o[k] = pn(o[k]); return o; });
const prio = (r) => ({ ...r, priority_label: priorityLib.LABELS[r.priority] || `P${r.priority}` });
const statusOf = (r) => ({ ...r, status_label: tickets.STATUS_LABELS[r.status] || r.status });

const C = {
  ref: { key: 'ref', header: 'Ticket', width: 14 }, customer: { key: 'customer', header: 'Customer', width: 24, weight: 2 }, type: { key: 'type', header: 'Type', width: 10 },
  prio: { key: 'priority_label', header: 'Priority', width: 13 }, status: { key: 'status_label', header: 'Status', width: 18 }, subject: { key: 'subject', header: 'Subject', width: 34, weight: 3 },
  int: (key, header, w = 11) => ({ key, header, type: 'integer', width: w }), pct: (key, header) => ({ key, header, type: 'percent', width: 11 }), hrs: (key, header) => ({ key, header, type: 'number', width: 12 }),
};

const REPORTS = {
  // ------------------------------------------------------------------ ticket volume and trends
  tickets: {
    category: 'volume', title: 'Ticket register', description: 'Every ticket in the period with its SLA result: the full ticket-level export.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = (await q(
        `select t.ref, coalesce(c.name, '(unverified)') as customer, t.type, t.queue, t.category, t.priority, t.status, ${ts('t.created_at', s)} as created,
                ${ts('t.response_due', s)} as response_due, ${ts('t.responded_at', s)} as responded, case ${RESP} when true then 'Met' when false then 'Missed' else '' end as response_result,
                ${ts('t.resolution_due', s)} as resolution_due, ${ts('t.resolved_at', s)} as resolved, case ${RESO} when true then 'Met' when false then 'Missed' else '' end as resolution_result,
                t.satisfaction, t.breach_cause, t.breach_action
           from tickets t left join customers c on c.id = t.customer_id where ${s.where} order by t.created_at limit 20000`, s.params)).rows.map((r) => statusOf(prio(r)));
      return { subtitle: `Created ${p.from} to ${p.to}`, summary: [['Tickets', rows.length]], rows,
        columns: [C.ref, C.customer, C.type, { key: 'queue', header: 'Queue', width: 12 }, { key: 'category', header: 'Category', width: 16 }, C.prio, C.status, { key: 'created', header: 'Created', width: 16 },
          { key: 'response_due', header: 'Response due', width: 16 }, { key: 'responded', header: 'Responded', width: 16 }, { key: 'response_result', header: 'Response', width: 10 },
          { key: 'resolution_due', header: 'Resolution due', width: 16 }, { key: 'resolved', header: 'Resolved', width: 16 }, { key: 'resolution_result', header: 'Resolution', width: 10 },
          C.int('satisfaction', 'Rating', 8), { key: 'breach_cause', header: 'Breach cause', width: 24 }, { key: 'breach_action', header: 'Corrective action', width: 24 }] };
    },
  },
  trend: {
    category: 'volume', title: 'Tickets created and resolved over time', description: 'Daily (or weekly for long periods) volume, with a chart.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const days = Math.round((Date.parse(p.to) - Date.parse(p.from)) / 86400000) + 1;
      const unit = days > 92 ? 'week' : 'day';
      const key = (col) => `to_char(date_trunc('${unit}', ${col} at time zone ${s.tz}), 'YYYY-MM-DD')`;
      const created = (await q(`select ${key('t.created_at')} as d, count(*)::int as n, count(*) filter (where t.type = 'incident')::int as inc, count(*) filter (where t.type = 'request')::int as req from tickets t where ${s.where} group by 1`, s.params)).rows;
      const sr = scope(user, p, { col: 't.resolved_at' });    // resolved in the period, whenever the ticket was created
      const resolved = (await q(`select to_char(date_trunc('${unit}', t.resolved_at at time zone ${sr.tz}), 'YYYY-MM-DD') as d, count(*)::int as n from tickets t where ${sr.where} group by 1`, sr.params)).rows;
      const cm = new Map(created.map((r) => [r.d, r])); const rm = new Map(resolved.map((r) => [r.d, r.n]));
      // every day (or week) of the period, so quiet days show as zero
      const keys = []; const step = unit === 'week' ? 7 : 1;
      const d0 = new Date(`${p.from}T00:00:00Z`); if (unit === 'week') d0.setUTCDate(d0.getUTCDate() - ((d0.getUTCDay() + 6) % 7));
      for (let d = d0; d <= new Date(`${p.to}T00:00:00Z`); d = new Date(d.getTime() + step * 86400000)) keys.push(d.toISOString().slice(0, 10));
      const rows = keys.map((k) => ({ period: k, created: cm.get(k)?.n || 0, incidents: cm.get(k)?.inc || 0, requests: cm.get(k)?.req || 0, resolved: rm.get(k) || 0 }));
      const chart = rows.length > 1 ? charts.lineChart({ labels: rows.map((r) => r.period.slice(5)), series: [{ name: 'Created', values: rows.map((r) => r.created), cls: 's0' }, { name: 'Resolved', values: rows.map((r) => r.resolved), cls: 's1' }], width: 760, height: 240, labelEvery: Math.max(1, Math.ceil(rows.length / 12)), integer: true }) : '';
      return { subtitle: `Created ${p.from} to ${p.to}, by ${unit}`, chart, chartLegend: [['s0i', 'Created'], ['s1i', 'Resolved']],
        summary: [['Created', rows.reduce((a, r) => a + r.created, 0)], ['Resolved', rows.reduce((a, r) => a + r.resolved, 0)]], rows,
        columns: [{ key: 'period', header: unit === 'week' ? 'Week starting' : 'Day', width: 14 }, C.int('created', 'Created'), C.int('incidents', 'Incidents'), C.int('requests', 'Requests'), C.int('resolved', 'Resolved')] };
    },
  },
  category: {
    category: 'volume', title: 'Tickets by category and type', description: 'Incidents and service requests per category.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = num((await q(`select coalesce(nullif(t.category, ''), '(none)') as category, count(*) filter (where t.type = 'incident') as incidents, count(*) filter (where t.type = 'request') as requests, count(*) as total
        from tickets t where ${s.where} group by 1 order by total desc, 1`, s.params)).rows, ['incidents', 'requests', 'total']);
      const all = rows.reduce((a, r) => a + r.total, 0);
      rows.forEach((r) => { r.share = all ? Math.round((1000 * r.total) / all) / 10 : null; });
      return { subtitle: `Created ${p.from} to ${p.to}`, rows, summary: [['Tickets', all]],
        chart: charts.hbars(rows.slice(0, 10).map((r) => ({ label: r.category, value: r.total, text: String(r.total) })), { labelW: 30 }),
        columns: [{ key: 'category', header: 'Category', width: 24, weight: 2 }, C.int('incidents', 'Incidents'), C.int('requests', 'Requests'), C.int('total', 'Total'), C.pct('share', 'Share')] };
    },
  },
  channel: {
    category: 'volume', title: 'Tickets by channel and queue', description: 'Portal, e-mail, agent-created and API tickets, by queue.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const labels = { portal: 'Customer portal', email: 'E-mail', agent: 'Created by staff', api: 'API' };
      const rows = num((await q(`select t.source, count(*) filter (where t.queue = 'it_services') as it_services, count(*) filter (where t.queue = 'security') as security, count(*) as total
        from tickets t where ${s.where} group by 1 order by total desc`, s.params)).rows, ['it_services', 'security', 'total']).map((r) => ({ ...r, channel: labels[r.source] || r.source }));
      return { subtitle: `Created ${p.from} to ${p.to}`, rows, columns: [{ key: 'channel', header: 'Channel', width: 24, weight: 2 }, C.int('it_services', 'IT Services'), C.int('security', 'Security'), C.int('total', 'Total')] };
    },
  },

  // ------------------------------------------------------------------ SLA and performance
  sla_customer: {
    category: 'sla', title: 'SLA compliance by customer', description: 'Response and resolution met and missed per customer, with the customer rating.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = num((await q(`select coalesce(c.name, '(unverified)') as customer, count(*) as total, count(*) filter (where t.status in ('resolved','closed')) as resolved,
          count(*) filter (where ${RESP} is true) as rm, count(*) filter (where ${RESP} is false) as rx, count(*) filter (where ${RESO} is true) as om, count(*) filter (where ${RESO} is false) as ox,
          round(avg(t.satisfaction)::numeric, 2) as rating
        from tickets t left join customers c on c.id = t.customer_id where ${s.where} group by c.name order by total desc, 1`, s.params)).rows, ['total', 'resolved', 'rm', 'rx', 'om', 'ox', 'rating'])
        .map((r) => ({ ...r, resp_pct: r.rm + r.rx ? Math.round((1000 * r.rm) / (r.rm + r.rx)) / 10 : null, reso_pct: r.om + r.ox ? Math.round((1000 * r.om) / (r.om + r.ox)) / 10 : null }));
      return { subtitle: `Created ${p.from} to ${p.to}. Tickets still inside their target are not counted yet.`, rows,
        columns: [C.customer, C.int('total', 'Tickets'), C.int('resolved', 'Resolved'), C.int('rm', 'Response met'), C.int('rx', 'Response missed'), C.pct('resp_pct', 'Response %'), C.int('om', 'Resolution met'), C.int('ox', 'Resolution missed'), C.pct('reso_pct', 'Resolution %'), { key: 'rating', header: 'Rating', type: 'number', width: 9 }] };
    },
  },
  sla_priority: {
    category: 'sla', title: 'SLA and times by priority', description: 'Compliance and average elapsed response and resolution times per priority.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = num((await q(`select t.priority, count(*) as total, count(*) filter (where ${RESP} is true) as rm, count(*) filter (where ${RESP} is false) as rx, count(*) filter (where ${RESO} is true) as om, count(*) filter (where ${RESO} is false) as ox,
          ${hours('t.created_at', 't.responded_at')} as avg_resp, ${hours('t.created_at', 't.resolved_at')} as avg_reso
        from tickets t where ${s.where} group by t.priority order by t.priority`, s.params)).rows, ['total', 'rm', 'rx', 'om', 'ox', 'avg_resp', 'avg_reso']).map(prio)
        .map((r) => ({ ...r, resp_pct: r.rm + r.rx ? Math.round((1000 * r.rm) / (r.rm + r.rx)) / 10 : null, reso_pct: r.om + r.ox ? Math.round((1000 * r.om) / (r.om + r.ox)) / 10 : null }));
      return { subtitle: `Created ${p.from} to ${p.to}. Times are elapsed hours (not business hours).`, rows,
        columns: [C.prio, C.int('total', 'Tickets'), C.int('rm', 'Response met'), C.int('rx', 'Response missed'), C.pct('resp_pct', 'Response %'), C.int('om', 'Resolution met'), C.int('ox', 'Resolution missed'), C.pct('reso_pct', 'Resolution %'), C.hrs('avg_resp', 'Avg. hours to respond'), C.hrs('avg_reso', 'Avg. hours to resolve')] };
    },
  },
  breaches: {
    category: 'sla', title: 'SLA breaches', description: 'Tickets that missed a response or resolution target, with the recorded cause and corrective action.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = (await q(`select t.ref, coalesce(c.name, '(unverified)') as customer, t.priority, t.status, t.subject, case ${RESP} when false then 'Missed' else '' end as response_result, case ${RESO} when false then 'Missed' else '' end as resolution_result,
          ${ts('t.resolution_due', s)} as resolution_due, ${ts('t.resolved_at', s)} as resolved, t.breach_cause, t.breach_action
        from tickets t left join customers c on c.id = t.customer_id where ${s.where} and (${RESP} is false or ${RESO} is false) order by t.created_at desc limit 5000`, s.params)).rows.map((r) => statusOf(prio(r)));
      return { subtitle: `Created ${p.from} to ${p.to}`, summary: [['Breached tickets', rows.length], ['Without a recorded cause', rows.filter((r) => !r.breach_cause).length]], rows,
        columns: [C.ref, C.customer, C.prio, C.status, C.subject, { key: 'response_result', header: 'Response', width: 10 }, { key: 'resolution_result', header: 'Resolution', width: 10 }, { key: 'resolution_due', header: 'Resolution due', width: 16 }, { key: 'resolved', header: 'Resolved', width: 16 },
          { key: 'breach_cause', header: 'Cause', width: 26, weight: 2 }, { key: 'breach_action', header: 'Corrective action', width: 26, weight: 2 }] };
    },
  },

  // ------------------------------------------------------------------ customers and services
  by_customer: {
    category: 'customers', title: 'Tickets by customer', description: 'Volume per customer: incidents, requests, still open, average time to resolve and rating.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = num((await q(`select coalesce(c.name, '(unverified)') as customer, count(*) filter (where t.type = 'incident') as incidents, count(*) filter (where t.type = 'request') as requests, count(*) as total,
          count(*) filter (where t.status in ${OPEN}) as open, ${hours('t.created_at', 't.resolved_at')} as avg_reso, round(avg(t.satisfaction)::numeric, 2) as rating
        from tickets t left join customers c on c.id = t.customer_id where ${s.where} group by c.name order by total desc, 1`, s.params)).rows, ['incidents', 'requests', 'total', 'open', 'avg_reso', 'rating']);
      return { subtitle: `Created ${p.from} to ${p.to}`, rows, chart: charts.hbars(rows.slice(0, 10).map((r) => ({ label: r.customer, value: r.total, text: String(r.total) })), { labelW: 38 }),
        columns: [C.customer, C.int('incidents', 'Incidents'), C.int('requests', 'Requests'), C.int('total', 'Total'), C.int('open', 'Open now'), C.hrs('avg_reso', 'Avg. hours to resolve'), { key: 'rating', header: 'Rating', type: 'number', width: 9 }] };
    },
  },
  by_service: {
    category: 'customers', title: 'Tickets by service', description: 'Which customer services generate the most tickets.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = num((await q(`select coalesce(c.name, '(unverified)') as customer, coalesce(sv.name, '(no service chosen)') as service, count(*) filter (where t.type = 'incident') as incidents, count(*) as total, count(*) filter (where t.status in ${OPEN}) as open
        from tickets t left join customers c on c.id = t.customer_id left join services sv on sv.id = t.service_id where ${s.where} group by c.name, sv.name order by total desc, 1, 2 limit 500`, s.params)).rows, ['incidents', 'total', 'open']);
      return { subtitle: `Created ${p.from} to ${p.to}`, rows, columns: [C.customer, { key: 'service', header: 'Service', width: 26, weight: 2 }, C.int('incidents', 'Incidents'), C.int('total', 'Total'), C.int('open', 'Open now')] };
    },
  },
  requesters: {
    category: 'customers', title: 'Top requesters', description: 'The 25 people who raised the most tickets.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = num((await q(`select coalesce(nullif(t.requester_name, ''), t.requester_email, '(unknown)') as requester, t.requester_email as email, coalesce(c.name, '(unverified)') as customer, count(*) as total, count(*) filter (where t.type = 'incident') as incidents
        from tickets t left join customers c on c.id = t.customer_id where ${s.where} group by 1, 2, c.name order by total desc, 1 limit 25`, s.params)).rows, ['total', 'incidents']);
      return { subtitle: `Created ${p.from} to ${p.to}`, rows, columns: [{ key: 'requester', header: 'Requester', width: 24, weight: 2 }, { key: 'email', header: 'E-mail', width: 28, weight: 2 }, C.customer, C.int('total', 'Tickets'), C.int('incidents', 'Incidents')] };
    },
  },

  // ------------------------------------------------------------------ people and workload
  by_engineer: {
    category: 'people', title: 'Workload by assignee', description: 'Tickets assigned to each person: received, resolved, still open, average time to resolve and missed resolutions.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = num((await q(`select coalesce(u.name, '(unassigned)') as person, count(*) as total, count(*) filter (where t.status in ('resolved','closed')) as resolved, count(*) filter (where t.status in ${OPEN}) as open,
          ${hours('t.created_at', 't.resolved_at')} as avg_reso, count(*) filter (where ${RESO} is false) as missed
        from tickets t left join users u on u.id = t.assignee_id where ${s.where} group by u.name order by total desc, 1`, s.params)).rows, ['total', 'resolved', 'open', 'avg_reso', 'missed']);
      return { subtitle: `Created ${p.from} to ${p.to}`, rows, chart: charts.hbars(rows.slice(0, 10).map((r) => ({ label: r.person, value: r.total, text: `${r.resolved}/${r.total}` })), { labelW: 30 }),
        columns: [{ key: 'person', header: 'Assignee', width: 24, weight: 2 }, C.int('total', 'Assigned'), C.int('resolved', 'Resolved'), C.int('open', 'Open now'), C.hrs('avg_reso', 'Avg. hours to resolve'), C.int('missed', 'Resolution missed', 14)] };
    },
  },
  exec_engineer: {
    category: 'people', title: 'Tickets by execution engineer', description: 'Tickets routed to each service execution engineer (the person notified for the service).', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = num((await q(`select coalesce(u.name, '(none: engineer and backup unavailable)') as person, count(*) as total, count(*) filter (where t.status in ${OPEN}) as open, count(*) filter (where ${RESO} is false) as missed
        from tickets t left join users u on u.id = t.exec_engineer_id where ${s.where} group by u.name order by total desc, 1`, s.params)).rows, ['total', 'open', 'missed']);
      return { subtitle: `Created ${p.from} to ${p.to}`, rows, columns: [{ key: 'person', header: 'Execution engineer', width: 30, weight: 2 }, C.int('total', 'Tickets'), C.int('open', 'Open now'), C.int('missed', 'Resolution missed', 14)] };
    },
  },

  // ------------------------------------------------------------------ backlog and ageing
  backlog_age: {
    category: 'backlog', title: 'Open backlog by age and priority', description: 'Everything open right now, by how long it has been open.', period: false,
    async run(q, user, p) {
      const s = scope(user, p, { period: false });
      const rows = num((await q(`select t.priority, count(*) filter (where age < interval '1 day') as d1, count(*) filter (where age >= interval '1 day' and age < interval '3 days') as d3,
          count(*) filter (where age >= interval '3 days' and age < interval '7 days') as d7, count(*) filter (where age >= interval '7 days') as d7p, count(*) as total
        from (select t.*, now() - t.created_at as age from tickets t) t where ${s.where} and t.status in ${OPEN} group by t.priority order by t.priority`, s.params)).rows, ['d1', 'd3', 'd7', 'd7p', 'total']).map(prio);
      const t = rows.reduce((a, r) => a + r.total, 0);
      return { subtitle: 'Open tickets now (New, Open, In progress, Waiting, Restored)', summary: [['Open tickets', t]], rows,
        columns: [C.prio, C.int('d1', 'Under 1 day'), C.int('d3', '1 to 3 days'), C.int('d7', '3 to 7 days'), C.int('d7p', 'Over 7 days'), C.int('total', 'Total')] };
    },
  },
  open_tickets: {
    category: 'backlog', title: 'Open tickets, oldest first', description: 'The open queue with age, assignee and SLA state: what needs attention.', period: false,
    async run(q, user, p) {
      const s = scope(user, p, { period: false });
      const rows = (await q(`select t.ref, coalesce(c.name, '(unverified)') as customer, t.priority, t.status, t.subject, coalesce(u.name, '(unassigned)') as assignee, extract(day from now() - t.created_at)::int as age_days,
          ${ts('t.resolution_due', s)} as resolution_due,
          case when t.paused_at is not null then 'Paused' when t.resolution_due is not null and now() > t.resolution_due then 'Breached' when t.response_due is not null and t.responded_at is null and now() > t.response_due then 'Response overdue' else 'Running' end as sla
        from tickets t left join customers c on c.id = t.customer_id left join users u on u.id = t.assignee_id where ${s.where} and t.status in ${OPEN} order by t.created_at limit 2000`, s.params)).rows.map((r) => statusOf(prio(r)));
      return { subtitle: 'Open tickets now', summary: [['Open tickets', rows.length], ['Breached or overdue', rows.filter((r) => r.sla === 'Breached' || r.sla === 'Response overdue').length]], rows,
        columns: [C.ref, C.customer, C.prio, C.status, C.subject, { key: 'assignee', header: 'Assignee', width: 18 }, C.int('age_days', 'Age (days)', 10), { key: 'resolution_due', header: 'Resolution due', width: 16 }, { key: 'sla', header: 'SLA', width: 16 }] };
    },
  },
  by_status: {
    category: 'backlog', title: 'Tickets by status', description: 'Where tickets are right now, incidents against requests.', period: false,
    async run(q, user, p) {
      const s = scope(user, p, { period: false });
      const rows = num((await q(`select t.status, count(*) filter (where t.type = 'incident') as incidents, count(*) filter (where t.type = 'request') as requests, count(*) as total
        from tickets t where ${s.where} group by t.status order by total desc`, s.params)).rows, ['incidents', 'requests', 'total']).map(statusOf);
      return { subtitle: 'All tickets, by current status', rows, columns: [C.status, C.int('incidents', 'Incidents'), C.int('requests', 'Requests'), C.int('total', 'Total')] };
    },
  },

  // ------------------------------------------------------------------ resolution and satisfaction
  resolution_codes: {
    category: 'quality', title: 'Resolution codes', description: 'How incidents were resolved, and how long each kind took.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = num((await q(`select coalesce(nullif(t.resolution_code, ''), '(none recorded)') as code, count(*) as total, ${hours('t.created_at', 't.resolved_at')} as avg_reso
        from tickets t where ${s.where} and t.resolved_at is not null group by 1 order by total desc, 1`, s.params)).rows, ['total', 'avg_reso']);
      return { subtitle: `Created ${p.from} to ${p.to}, resolved tickets only`, rows, columns: [{ key: 'code', header: 'Resolution code', width: 26, weight: 2 }, C.int('total', 'Tickets'), C.hrs('avg_reso', 'Avg. hours to resolve')] };
    },
  },
  satisfaction: {
    category: 'quality', title: 'Customer satisfaction', description: 'Ratings given by customers, per customer, with the share of happy and unhappy ratings.', period: true,
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = num((await q(`select coalesce(c.name, '(unverified)') as customer, count(t.satisfaction) as rated, round(avg(t.satisfaction)::numeric, 2) as rating,
          count(*) filter (where t.satisfaction <= 2) as unhappy, count(*) filter (where t.satisfaction >= 4) as happy
        from tickets t left join customers c on c.id = t.customer_id where ${s.where} group by c.name having count(t.satisfaction) > 0 order by rating, 1`, s.params)).rows, ['rated', 'rating', 'unhappy', 'happy']);
      const all = (await q(`select count(t.satisfaction)::int as n, round(avg(t.satisfaction)::numeric, 2) as avg from tickets t where ${s.where}`, s.params)).rows[0];
      return { subtitle: `Created ${p.from} to ${p.to}. 1 is worst, 5 is best.`, summary: [['Ratings', all.n], ['Average', all.avg || '—']], rows,
        columns: [C.customer, C.int('rated', 'Ratings'), { key: 'rating', header: 'Average', type: 'number', width: 10 }, C.int('unhappy', '1 to 2 stars'), C.int('happy', '4 to 5 stars')] };
    },
  },

  // ------------------------------------------------------------------ security (security.view only)
  security: {
    category: 'security', title: 'Security queue tickets', description: 'Tickets in the Security queue in the period.', period: true, perm: 'security.view',
    async run(q, user, p) {
      const s = scope(user, p);
      const rows = (await q(`select t.ref, coalesce(c.name, '(unverified)') as customer, t.category, t.priority, t.status, t.subject, ${ts('t.created_at', s)} as created, ${ts('t.resolved_at', s)} as resolved,
          case ${RESO} when true then 'Met' when false then 'Missed' else '' end as resolution_result
        from tickets t left join customers c on c.id = t.customer_id where ${s.where} and t.queue = 'security' order by t.created_at desc limit 5000`, s.params)).rows.map((r) => statusOf(prio(r)));
      return { subtitle: `Created ${p.from} to ${p.to}`, summary: [['Security tickets', rows.length]], rows,
        columns: [C.ref, C.customer, { key: 'category', header: 'Category', width: 16 }, C.prio, C.status, C.subject, { key: 'created', header: 'Created', width: 16 }, { key: 'resolved', header: 'Resolved', width: 16 }, { key: 'resolution_result', header: 'Resolution', width: 10 }] };
    },
  },
};

const allowed = (user, r) => !r.perm || perms.can(user, r.perm);

/** Categories with the reports this person may run. */
function catalogue(user) {
  return CATEGORIES.filter((c) => !c.perm || perms.can(user, c.perm)).map((c) => ({ ...c, reports: Object.entries(REPORTS).filter(([, r]) => r.category === c.id && allowed(user, r)).map(([id, r]) => ({ id, title: r.title, description: r.description, period: r.period })) }))
    .filter((c) => c.reports.length);
}

async function run(q, user, id, params) {
  const r = REPORTS[id];
  if (!r || !allowed(user, r)) return null;
  const out = await r.run(q, user, params);
  return { id, title: r.title, category: r.category, period: r.period, ...out };
}

module.exports = { CATEGORIES, REPORTS, catalogue, run };
