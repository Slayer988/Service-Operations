'use strict';
// Pipeline dashboard, SDE dashboard (spec 5.x), pipeline reports and the Opportunity Support Report as PDF / Excel.
const u = require('../lib/util');
const xlsx = require('../lib/xlsx');
const pdf = require('../lib/pdf');
const config = require('../config');
const P = require('./pipeline');

const OPEN_SQL = `(${P.OPEN.map((s) => `'${s}'`).join(',')})`;
const ACTIVE_SQL = `(${P.ACTIVE.map((s) => `'${s}'`).join(',')})`;
const WITH = `coalesce(c.name, nullif(o.prospect, ''), '-')`;
const rate = (w, l) => (w + l > 0 ? Math.round((w / (w + l)) * 1000) / 10 : null);

async function dashboard(q, today, defaultCurrency = 'UGX') {
  const rows = (await q(`select stage, value, probability, currency, expected_close from opportunities where stage = any($1)`, [P.ACTIVE])).rows;
  const totals = P.totals(rows);
  const forecast = P.forecast(rows, today, 12);
  const currencies = Object.keys(totals).sort((a, b) => (b === defaultCurrency) - (a === defaultCurrency) || a.localeCompare(b));
  const counts = (await q(
    `select count(*) filter (where stage = any($1))::int as open, count(*) filter (where stage = 'on_hold')::int as on_hold,
            count(*) filter (where stage = 'won')::int as won, count(*) filter (where stage = 'lost')::int as lost,
            count(*) filter (where stage = 'won' and closed_at >= date_trunc('year', current_date))::int as won_ytd, count(*) filter (where stage = 'lost' and closed_at >= date_trunc('year', current_date))::int as lost_ytd,
            count(*) filter (where stage = any($2) and next_step_date < current_date)::int as overdue_followups,
            count(*) filter (where stage = any($2) and next_step_date between current_date and current_date + 7)::int as due_followups from opportunities`, [P.OPEN, P.ACTIVE])).rows[0];
  const byCustomer = (await q(
    `select ${WITH} as label, o.currency, count(*)::int as n, coalesce(sum(o.value), 0) as value, coalesce(sum(o.value * o.probability / 100.0), 0) as weighted
       from opportunities o left join customers c on c.id = o.customer_id where o.stage = any($1) group by 1, o.currency order by weighted desc, label limit 8`, [P.OPEN])).rows
    .map((r) => ({ ...r, value: Number(r.value), weighted: Number(r.weighted) }));
  const lostReasons = (await q(`select coalesce(nullif(lost_reason, ''), 'No reason recorded') as label, count(*)::int as n from opportunities where stage = 'lost' group by 1 order by n desc, label limit 8`)).rows;
  const tasks = (await q(
    `select count(*)::int as total, count(*) filter (where status = 'completed')::int as done, count(*) filter (where status = 'in_progress')::int as in_progress, count(*) filter (where status = 'pending')::int as pending,
            count(*) filter (where status <> 'completed' and due_date < current_date)::int as overdue from opp_tasks t join opportunities o on o.id = t.opportunity_id where o.stage = any($1)`, [P.ACTIVE])).rows[0];
  const workload = (await q(
    `select u.id, u.name, count(distinct e.opportunity_id)::int as opportunities,
            count(t.id) filter (where t.status <> 'completed')::int as open_tasks, count(t.id) filter (where t.status <> 'completed' and t.due_date < current_date)::int as overdue,
            count(t.id) filter (where t.status = 'completed')::int as done
       from opportunity_engineers e join users u on u.id = e.user_id join opportunities o on o.id = e.opportunity_id and o.stage = any($1)
       left join opp_tasks t on t.opportunity_id = o.id and t.assignee_id = u.id group by u.id, u.name order by open_tasks desc, u.name limit 12`, [P.ACTIVE])).rows;
  const stageRows = P.OPEN.map((k) => ({ stage: k, per: Object.fromEntries(currencies.map((c) => [c, totals[c].stages[k]])), count: currencies.reduce((a, c) => a + totals[c].stages[k].count, 0) }));
  return { totals, currencies, forecast, counts, winRate: rate(counts.won, counts.lost), winRateYtd: rate(counts.won_ytd, counts.lost_ytd), byCustomer, lostReasons, tasks, workload, stageRows,
    taskCompletion: tasks.total ? Math.round((tasks.done / tasks.total) * 100) : null };
}

/** SDE dashboard (PT-024): scoped to one engineer, or every engineer (managers) when userId is null. */
async function sdeDashboard(q, userId) {
  const scope = userId ? 'and e.user_id = $2' : '';
  const params = userId ? [P.ACTIVE, userId] : [P.ACTIVE];
  const opps = (await q(
    `select o.id, o.ref, o.name, o.stage, ${WITH} as customer, o.expected_close,
            (select count(*)::int from opp_tasks t where t.opportunity_id = o.id and t.status <> 'completed' ${userId ? 'and t.assignee_id = $2' : ''}) as open_tasks,
            (select count(*)::int from opp_tasks t where t.opportunity_id = o.id and t.status <> 'completed' and t.due_date < current_date ${userId ? 'and t.assignee_id = $2' : ''}) as overdue_tasks,
            (select coalesce(round(avg(t.progress)), 0)::int from opp_tasks t where t.opportunity_id = o.id) as progress
       from opportunities o left join customers c on c.id = o.customer_id
      where o.stage = any($1) and o.id in (select e.opportunity_id from opportunity_engineers e where true ${scope}) order by o.expected_close nulls last, o.ref`, params)).rows;
  const tp = userId ? [userId] : [];
  const tasks = (await q(
    `select t.id, t.ref, t.title, t.status, t.priority, t.progress, t.due_date, t.opportunity_id, o.ref as oref, o.name as oname, u.name as assignee,
            (t.status <> 'completed' and t.due_date < current_date) as overdue
       from opp_tasks t join opportunities o on o.id = t.opportunity_id left join users u on u.id = t.assignee_id
      where t.status <> 'completed' ${userId ? 'and t.assignee_id = $1' : ''} order by overdue desc, t.due_date nulls last, t.id limit 25`, tp)).rows;
  const c = (await q(
    `select count(*) filter (where status = 'pending')::int as pending, count(*) filter (where status = 'in_progress')::int as in_progress, count(*) filter (where status = 'completed')::int as completed,
            count(*) filter (where status <> 'completed' and due_date < current_date)::int as overdue,
            count(*) filter (where status <> 'completed' and due_date between current_date and current_date + 7)::int as due_week from opp_tasks t ${userId ? 'where t.assignee_id = $1' : ''}`, tp)).rows[0];
  const activity = (await q(
    `select a.activity_date, a.kind, a.description, o.id as oid, o.ref from opportunity_activities a join opportunities o on o.id = a.opportunity_id
      where a.technical ${userId ? 'and a.created_by = $1' : ''} order by a.activity_date desc, a.id desc limit 8`, tp)).rows;
  return { opportunities: opps, tasks, counts: c, activity };
}

const COL = {
  ref: { key: 'ref', header: 'Reference', width: 14 }, name: { key: 'name', header: 'Opportunity', width: 32, weight: 3 }, cust: { key: 'customer', header: 'Customer / prospect', width: 26, weight: 2 },
  stage: { key: 'stage_label', header: 'Stage', width: 20 }, owner: { key: 'owner', header: 'Owner', width: 18 }, value: { key: 'value', header: 'Value', type: 'money', width: 16 }, cur: { key: 'currency', header: 'Cur.', width: 7 },
  prob: { key: 'probability', header: 'Prob. %', type: 'integer', width: 9 }, weighted: { key: 'weighted', header: 'Weighted value', type: 'money', width: 16 }, close: { key: 'expected_close', header: 'Expected close', type: 'date', width: 14 },
};
const BASE = `from opportunities o left join customers c on c.id = o.customer_id join users ow on ow.id = o.owner_id`;
const SEL = `o.id, o.ref, o.name, ${WITH} as customer, o.stage, ow.name as owner, o.value, o.currency, o.probability, round(o.value * o.probability / 100.0, 2) as weighted, o.expected_close, o.industry, o.classification, o.lost_reason, o.closed_at::date as closed_on`;
const stageLabeller = (labels) => (r) => ({ ...r, stage_label: (labels || P.STAGE_LABELS)[r.stage] || r.stage });

const REPORTS = {
  pipeline: {
    title: 'Pipeline summary', description: 'Every active opportunity with stage, value, probability and weighted value.',
    async run(q, p, labels) {
      const rows = (await q(`select ${SEL} ${BASE} where o.stage = any($1) order by o.expected_close nulls last, o.ref`, [P.ACTIVE])).rows.map(stageLabeller(labels));
      return { columns: [COL.ref, COL.name, COL.cust, COL.stage, COL.owner, COL.value, COL.cur, COL.prob, COL.weighted, COL.close], rows, summary: [['Opportunities', String(rows.length)]] };
    },
  },
  forecast: {
    title: 'Revenue forecast', description: 'Weighted expected revenue by month and by quarter, from expected close dates.',
    async run(q) {
      const today = new Date().toISOString().slice(0, 10);
      const rows0 = (await q(`select stage, value, probability, currency, expected_close from opportunities where stage = any($1)`, [P.OPEN])).rows;
      const f = P.forecast(rows0, today, 12); const rows = [];
      for (const [cur, x] of Object.entries(f)) {
        for (const m of x.months) rows.push({ period: m.key, kind: 'Month', currency: cur, n: m.count, value: m.value, weighted: m.weighted });
        for (const m of x.quarters) rows.push({ period: m.key, kind: 'Quarter', currency: cur, n: m.count, value: m.value, weighted: m.weighted });
        rows.push({ period: 'Later', kind: 'Beyond 12 months', currency: cur, n: x.later.count, value: x.later.value, weighted: x.later.weighted });
        rows.push({ period: 'No date', kind: 'Unscheduled', currency: cur, n: x.unscheduled.count, value: x.unscheduled.value, weighted: x.unscheduled.weighted });
      }
      return { columns: [{ key: 'period', header: 'Period', width: 14 }, { key: 'kind', header: 'Kind', width: 18 }, COL.cur, { key: 'n', header: 'Opportunities', type: 'integer', width: 14 }, COL.value, COL.weighted], rows,
        summary: [['Basis', 'Open opportunities (on hold excluded); overdue close dates count in the current month']] };
    },
  },
  winloss: {
    title: 'Win / loss and conversion', description: 'Closed opportunities, conversion rate and reasons for loss.', params: ['from', 'to'],
    async run(q, p, labels) {
      const where = [`o.stage in ('won','lost')`]; const params = [];
      const from = u.dateStr(p.from); const to = u.dateStr(p.to);
      if (from) { params.push(from); where.push(`o.closed_at::date >= $${params.length}::date`); }
      if (to) { params.push(to); where.push(`o.closed_at::date <= $${params.length}::date`); }
      const rows = (await q(`select ${SEL} ${BASE} where ${where.join(' and ')} order by o.closed_at desc`, params)).rows.map(stageLabeller(labels));
      const won = rows.filter((r) => r.stage === 'won').length; const lost = rows.length - won; const r = rate(won, lost);
      return { subtitle: from || to ? `${from || 'start'} to ${to || 'today'}` : 'All time', columns: [COL.ref, COL.name, COL.cust, COL.stage, COL.owner, COL.value, COL.cur, { key: 'closed_on', header: 'Closed', type: 'date', width: 12 }, { key: 'lost_reason', header: 'Reason for loss', width: 30, weight: 2 }], rows,
        summary: [['Won', String(won)], ['Lost', String(lost)], ['Conversion rate', r === null ? '-' : `${r}%`]] };
    },
  },
  customers: {
    title: 'Pipeline by customer', description: 'Open pipeline value and weighted value for each customer or prospect.',
    async run(q) {
      const rows = (await q(
        `select ${WITH} as customer, o.currency, count(*)::int as n, coalesce(sum(o.value), 0) as value, coalesce(sum(o.value * o.probability / 100.0), 0) as weighted ${BASE} where o.stage = any($1) group by 1, o.currency order by weighted desc, customer`, [P.OPEN])).rows
        .map((r) => ({ ...r, value: Number(r.value), weighted: Number(r.weighted) }));
      return { columns: [COL.cust, COL.cur, { key: 'n', header: 'Opportunities', type: 'integer', width: 14 }, COL.value, COL.weighted], rows, summary: [['Customers / prospects', String(new Set(rows.map((r) => r.customer)).size)]] };
    },
  },
  workload: {
    title: 'Engineering workload', description: 'Assigned opportunities and tasks (open, overdue, completed) for each Service Delivery Engineer.',
    async run(q) {
      const rows = (await q(
        `select u.name, count(distinct e.opportunity_id)::int as opportunities, count(t.id)::int as tasks, count(t.id) filter (where t.status = 'completed')::int as done,
                count(t.id) filter (where t.status <> 'completed')::int as open, count(t.id) filter (where t.status <> 'completed' and t.due_date < current_date)::int as overdue,
                coalesce(sum(r.planned), 0) as planned_hours, coalesce(sum(r.actual), 0) as actual_hours
           from opportunity_engineers e join users u on u.id = e.user_id join opportunities o on o.id = e.opportunity_id and o.stage = any($1)
           left join opp_tasks t on t.opportunity_id = o.id and t.assignee_id = u.id
           left join lateral (select sum(planned_hours) as planned, sum(actual_hours) as actual from opportunity_resources rr where rr.opportunity_id = o.id and rr.user_id = u.id) r on true
          group by u.name order by open desc, u.name`, [P.ACTIVE])).rows.map((r) => ({ ...r, planned_hours: Number(r.planned_hours), actual_hours: Number(r.actual_hours), completion: r.tasks ? Math.round((r.done / r.tasks) * 100) : null }));
      return { columns: [{ key: 'name', header: 'Engineer', width: 24, weight: 2 }, { key: 'opportunities', header: 'Opportunities', type: 'integer', width: 14 }, { key: 'tasks', header: 'Tasks', type: 'integer', width: 9 },
        { key: 'done', header: 'Completed', type: 'integer', width: 11 }, { key: 'open', header: 'Open', type: 'integer', width: 8 }, { key: 'overdue', header: 'Overdue', type: 'integer', width: 10 },
        { key: 'completion', header: 'Completion', type: 'percent', width: 12 }, { key: 'planned_hours', header: 'Planned hours', type: 'number', width: 14 }, { key: 'actual_hours', header: 'Actual hours', type: 'number', width: 13 }], rows,
        summary: [['Engineers', String(rows.length)]] };
    },
  },
  technical: {
    title: 'Technical engagements', description: 'Technical meetings, site assessments, solution reviews and consultations by engineers.', params: ['from', 'to'],
    async run(q, p) {
      const where = ['a.technical']; const params = [];
      const from = u.dateStr(p.from); const to = u.dateStr(p.to);
      if (from) { params.push(from); where.push(`a.activity_date >= $${params.length}::date`); }
      if (to) { params.push(to); where.push(`a.activity_date <= $${params.length}::date`); }
      const rows = (await q(
        `select o.ref, o.name, ${WITH} as customer, a.activity_date, a.kind, a.description, a.outcome, u.name as by
           from opportunity_activities a join opportunities o on o.id = a.opportunity_id left join customers c on c.id = o.customer_id left join users u on u.id = a.created_by where ${where.join(' and ')} order by a.activity_date desc, a.id desc`, params)).rows
        .map((r) => ({ ...r, kind: P.ACTIVITY_KINDS[r.kind] || r.kind }));
      return { subtitle: from || to ? `${from || 'start'} to ${to || 'today'}` : 'All time', columns: [COL.ref, { key: 'name', header: 'Opportunity', width: 26, weight: 2 }, COL.cust, { key: 'activity_date', header: 'Date', type: 'date', width: 12 }, { key: 'kind', header: 'Kind', width: 18 },
        { key: 'description', header: 'Description', width: 40, weight: 3 }, { key: 'outcome', header: 'Outcome', width: 28, weight: 2 }, { key: 'by', header: 'By', width: 16 }], rows, summary: [['Engagements', String(rows.length)]] };
    },
  },
};

async function run(q, id, params = {}, labels) {
  const r = REPORTS[id];
  if (!r) return null;
  const out = await r.run(q, params, labels);
  return { id, title: r.title, ...out };
}

// ---------------------------------------------------------------- Opportunity Support Report (PDF / Excel)
const d10 = (v) => (v === null || v === undefined ? '' : v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));
const money = (v, cur) => (v === null || v === undefined ? '' : `${cur} ${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);

/** The report as ordered sections [{ title, kv?: [[k,v]], table?: { columns, rows } , text? }] used by both the PDF and the workbook. */
function supportSections(r, labels) {
  const o = r.opportunity; const L = labels || P.STAGE_LABELS;
  return [
    { title: 'Opportunity overview', kv: [['Reference', o.ref], ['Opportunity', o.name], ['Customer / prospect', o.customer_name || ''], ['Industry', o.industry || o.customer_industry || ''], ['Category', o.classification || ''],
      ['Stage', L[o.stage] || o.stage], ['Estimated value', money(o.value, o.currency)], ['Probability', `${o.probability}%`], ['Expected close', d10(o.expected_close)], ['Owner (business development)', o.owner_name],
      ['Customer contacts', r.contacts.map((c) => `${c.name}${c.title ? ` (${c.title})` : ''}`).join('; ')], ['Assigned engineers', r.engineers.map((e) => e.name).join('; ') || 'None'],
      ['Reporting period', r.from || r.to ? `${r.from || 'start'} to ${r.to || 'today'}` : 'All activity'], ['Generated', r.generated], ['Overall engineering progress', `${r.progress}% (${r.done} of ${r.tasks.length} tasks completed)`]] },
    { title: 'Technical activities performed', table: { columns: [{ header: 'Date', key: 'date', type: 'date', weight: 1 }, { header: 'Kind', key: 'kind', weight: 1.4 }, { header: 'Activity', key: 'description', weight: 4 }, { header: 'Outcome', key: 'outcome', weight: 2.5 }, { header: 'By', key: 'by', weight: 1.2 }],
      rows: r.activities.map((a) => ({ date: d10(a.activity_date), kind: P.ACTIVITY_KINDS[a.kind] || a.kind, description: a.description, outcome: a.outcome, by: a.by || '' })) } },
    { title: 'Tasks completed in the period', table: { columns: [{ header: 'Task', key: 'ref', weight: 1 }, { header: 'Title', key: 'title', weight: 4 }, { header: 'Engineer', key: 'assignee', weight: 1.5 }, { header: 'Completed', key: 'completed', type: 'date', weight: 1.2 }, { header: 'Work performed', key: 'notes', weight: 4 }],
      rows: r.completedInPeriod.map((t) => ({ ref: t.ref, title: t.title, assignee: t.assignee_name || '', completed: d10(t.completed_at), notes: t.work_notes })) } },
    { title: 'Outstanding tasks', table: { columns: [{ header: 'Task', key: 'ref', weight: 1 }, { header: 'Title', key: 'title', weight: 4 }, { header: 'Engineer', key: 'assignee', weight: 1.5 }, { header: 'Status', key: 'status', weight: 1.2 }, { header: 'Progress', key: 'progress', weight: 1 },
      { header: 'Target date', key: 'due', type: 'date', weight: 1.2 }], rows: r.outstanding.map((t) => ({ ref: t.ref, title: t.title, assignee: t.assignee_name || '', status: `${P.TASK_STATUSES[t.status]}${t.overdue ? ' (overdue)' : ''}`, progress: `${t.progress}%`, due: d10(t.due_date) })) } },
    { title: 'Solution design and technical contributions', table: { columns: [{ header: 'Kind', key: 'kind', weight: 1.5 }, { header: 'Contribution', key: 'title', weight: 3 }, { header: 'Details', key: 'description', weight: 4 }, { header: 'Status', key: 'status', weight: 1.2 }, { header: 'By', key: 'author', weight: 1.4 }],
      rows: r.solution.map((s) => ({ kind: P.SOLUTION_KINDS[s.kind] || s.kind, title: s.title, description: s.description, status: s.status === 'completed' ? 'Completed' : 'In progress', author: s.author || '' })) } },
    { title: 'Resources and effort', table: { columns: [{ header: 'Resource', key: 'name', weight: 2 }, { header: 'Skill', key: 'skill', weight: 2 }, { header: 'Planned hours', key: 'planned', weight: 1.2 }, { header: 'Actual hours', key: 'actual', weight: 1.2 }, { header: 'Notes', key: 'notes', weight: 3 }],
      rows: r.resources.map((x) => ({ name: x.person || x.name, skill: x.skill, planned: String(Number(x.planned_hours)), actual: String(Number(x.actual_hours)), notes: x.notes })) } },
    { title: 'Supporting documents', table: { columns: [{ header: 'Document', key: 'filename', weight: 4 }, { header: 'Kind', key: 'kind', weight: 1.5 }, { header: 'Version', key: 'version', weight: 0.8 }, { header: 'Added', key: 'added', type: 'date', weight: 1.2 }, { header: 'By', key: 'by', weight: 1.5 }],
      rows: r.documents.map((x) => ({ filename: x.filename, kind: x.doc_kind || '', version: String(x.version || 1), added: d10(x.created_at), by: x.uploader || '' })) } },
    { title: 'Challenges encountered', text: o.support_challenges || 'None recorded.' },
    { title: 'Recommendations', text: o.support_recommendations || 'None recorded.' },
  ];
}

function supportPdf(r, labels) {
  const o = r.opportunity; const blocks = [];
  for (const s of supportSections(r, labels)) {
    blocks.push({ type: 'heading', text: s.title });
    if (s.kv) blocks.push({ type: 'kv', rows: s.kv });
    if (s.text) blocks.push({ type: 'p', text: s.text });
    if (s.table) blocks.push({ type: 'table', columns: s.table.columns, rows: s.table.rows, empty: 'None.' });
  }
  return pdf.document({ title: `Opportunity Support Report - ${o.ref}`, subtitle: o.name, appName: config.appName, blocks });
}

function supportXlsx(r, user, labels) {
  const secs = supportSections(r, labels);
  const sheets = secs.filter((s) => s.table).map((s) => ({ name: s.title.slice(0, 28), title: `${r.opportunity.ref} - ${s.title}`, columns: s.table.columns.map((c) => ({ header: c.header, key: c.key, type: c.type, width: Math.round((c.weight || 1) * 10) + 8, wrap: c.key === 'description' || c.key === 'notes' || c.key === 'outcome' })), rows: s.table.rows }));
  const text = secs.filter((s) => s.text).map((s) => ({ section: s.title, text: s.text }));
  sheets.unshift({ name: 'Overview', title: `Opportunity Support Report - ${r.opportunity.ref}`, columns: [{ header: 'Item', key: 'k', width: 34 }, { header: 'Value', key: 'v', width: 80, wrap: true }],
    rows: [...secs[0].kv.map(([k, v]) => ({ k, v })), ...text.map((t) => ({ k: t.section, v: t.text }))] });
  return xlsx.workbook(sheets, { title: `Opportunity Support Report ${r.opportunity.ref}`, creator: user ? user.name : undefined });
}

module.exports = { dashboard, sdeDashboard, REPORTS, run, supportSections, supportPdf, supportXlsx, rate };
