'use strict';
// Contract dashboard figures (spec 4.4) and reports (spec 4.5). All reports share one shape so the exporter can render them as HTML, CSV, Excel or PDF.
const u = require('../lib/util');
const C = require('./contracts');

const LIVE_SQL = `('active','expiring_soon','renewal_in_progress')`;
const WITH = `coalesce(cu.name, c.supplier)`;
// annual value: the figure entered, else the total value spread over the term, else the total value
const ACV = `coalesce(c.annual_value, case when c.value is not null and c.end_date is not null and c.end_date > c.start_date then round(c.value * 365.0 / (c.end_date - c.start_date), 2) else c.value end)`;

async function dashboard(q, defaultCurrency = 'UGX') {
  const counts = (await q(
    `select count(*)::int as total,
            count(*) filter (where status = 'active')::int as active,
            count(*) filter (where status = 'expiring_soon')::int as expiring_soon,
            count(*) filter (where status = 'renewal_in_progress')::int as renewal,
            count(*) filter (where status = 'expired')::int as expired,
            count(*) filter (where status = 'suspended')::int as suspended,
            count(*) filter (where status = 'terminated')::int as terminated,
            count(*) filter (where status = 'closed')::int as closed,
            count(*) filter (where status in ${LIVE_SQL} and end_date between current_date and current_date + 30)::int as d30,
            count(*) filter (where status in ${LIVE_SQL} and end_date between current_date and current_date + 60)::int as d60,
            count(*) filter (where status in ${LIVE_SQL} and end_date between current_date and current_date + 90)::int as d90
       from contracts`)).rows[0];
  const money = (await q(
    `select c.currency, coalesce(sum(c.value), 0) as total, coalesce(sum(${ACV}), 0) as acv, count(*)::int as n
       from contracts c where c.status in ${LIVE_SQL} group by c.currency order by (c.currency = $1) desc, c.currency`, [defaultCurrency])).rows
    .map((r) => ({ currency: r.currency, total: Number(r.total), acv: Number(r.acv), n: r.n }));
  const byCustomer = (await q(
    `select cu.id, cu.name as label, count(*)::int as n, coalesce(sum(c.value) filter (where c.currency = $1), 0) as value
       from contracts c join customers cu on cu.id = c.customer_id where c.status in ${LIVE_SQL} group by cu.id, cu.name order by n desc, value desc, cu.name limit 8`, [defaultCurrency])).rows
    .map((r) => ({ ...r, value: Number(r.value) }));
  const bySupplier = (await q(
    `select c.supplier as label, c.counterparty_kind, count(*)::int as n, coalesce(sum(c.value) filter (where c.currency = $1), 0) as value
       from contracts c where c.status in ${LIVE_SQL} and c.counterparty_kind <> 'customer' and c.supplier <> '' group by c.supplier, c.counterparty_kind order by n desc, value desc, c.supplier limit 8`, [defaultCurrency])).rows
    .map((r) => ({ ...r, value: Number(r.value) }));
  const ob = (await q(
    `select count(*) filter (where o.status in ('open','in_progress'))::int as outstanding,
            count(*) filter (where o.status in ('open','in_progress') and o.due_date < current_date)::int as overdue
       from contract_obligations o join contracts c on c.id = o.contract_id where c.status not in ('terminated','closed')`)).rows[0];
  const sla = (await q(
    `select count(*)::int as n, count(*) filter (where (t.direction = 'min' and p.measured >= t.target) or (t.direction = 'max' and p.measured <= t.target))::int as ok
       from contract_performance p join contract_sla_targets t on t.id = p.sla_target_id join contracts c on c.id = p.contract_id where c.status not in ('terminated','closed')`)).rows[0];
  const renewals = (await q(
    `select c.id, c.reference, c.title, c.status, c.end_date, c.renewal_date, c.auto_renew, ${WITH} as counterparty, (c.end_date - current_date) as days_left
       from contracts c left join customers cu on cu.id = c.customer_id
      where c.status = 'renewal_in_progress' or (c.status in ('active','expiring_soon') and c.end_date between current_date and current_date + 90)
      order by c.end_date limit 10`)).rows;
  return { counts, money, byCustomer, bySupplier, obligations: ob, sla: { n: sla.n, ok: sla.ok, pct: sla.n ? Math.round((sla.ok / sla.n) * 1000) / 10 : null }, renewals };
}

const COL = {
  ref: { key: 'reference', header: 'Reference', width: 15 }, title: { key: 'title', header: 'Title', width: 30, weight: 2 }, with: { key: 'counterparty', header: 'Customer / supplier', width: 26, weight: 2 },
  type: { key: 'type', header: 'Type', width: 18 }, status: { key: 'status_label', header: 'Status', width: 18 }, owner: { key: 'owner', header: 'Owner', width: 18 },
  start: { key: 'start_date', header: 'Start', type: 'date', width: 12 }, end: { key: 'end_date', header: 'End', type: 'date', width: 12 },
  value: { key: 'value', header: 'Value', type: 'money', width: 16 }, acv: { key: 'acv', header: 'Annual value', type: 'money', width: 16 }, cur: { key: 'currency', header: 'Cur.', width: 7 },
  left: { key: 'days_left', header: 'Days left', type: 'integer', width: 10 },
};
const statusLabel = (r) => ({ ...r, status_label: C.STATUS_LABELS[r.status] || r.status });

const BASE = `from contracts c left join customers cu on cu.id = c.customer_id left join users o on o.id = c.owner_id`;
const SEL = `c.id, c.reference, c.title, c.type, c.status, c.start_date, c.end_date, c.renewal_date, c.renewal_terms, c.notice_days, c.auto_renew, c.value, ${ACV} as acv, c.currency, c.counterparty_kind,
             ${WITH} as counterparty, o.name as owner, c.department, (c.end_date - current_date) as days_left`;

const REPORTS = {
  active: {
    title: 'Active contracts', description: 'Every contract in force: active, expiring soon or in renewal.',
    async run(q) {
      const rows = (await q(`select ${SEL} ${BASE} where c.status in ${LIVE_SQL} order by c.end_date nulls last, c.reference`)).rows.map(statusLabel);
      return { columns: [COL.ref, COL.title, COL.with, COL.type, COL.status, COL.owner, COL.start, COL.end, COL.value, COL.cur], rows, summary: [['Contracts in force', String(rows.length)]] };
    },
  },
  expiry: {
    title: 'Contract expiry', description: 'Contracts ending soon (default 90 days), and those already expired but not closed.', params: ['days'],
    async run(q, p) {
      const days = u.intIn(String(p.days || ''), 1, 1095) || 90;
      const rows = (await q(
        `select ${SEL} ${BASE} where (c.status in ${LIVE_SQL} and c.end_date <= current_date + $1::int) or c.status = 'expired' order by c.end_date`, [days])).rows.map(statusLabel);
      return { subtitle: `Next ${days} days`, columns: [COL.ref, COL.title, COL.with, COL.status, COL.owner, COL.end, COL.left, COL.value, COL.cur], rows, summary: [['Window', `${days} days`], ['Contracts', String(rows.length)]] };
    },
  },
  renewals: {
    title: 'Contract renewals', description: 'Renewal dates, terms and notice periods of contracts expiring soon or being renewed.',
    async run(q) {
      const rows = (await q(
        `select ${SEL} ${BASE} where c.status in ('expiring_soon','renewal_in_progress','expired') or (c.status = 'active' and c.end_date <= current_date + 180) order by c.end_date`)).rows
        .map((r) => ({ ...statusLabel(r), auto: r.auto_renew ? 'Yes' : 'No' }));
      return { columns: [COL.ref, COL.title, COL.with, COL.status, COL.end, { key: 'renewal_date', header: 'Renewal date', type: 'date', width: 13 }, { key: 'auto', header: 'Auto-renews', width: 12 },
        { key: 'notice_days', header: 'Notice (days)', type: 'integer', width: 12 }, { key: 'renewal_terms', header: 'Renewal terms', width: 36, weight: 2 }], rows, summary: [['Contracts', String(rows.length)]] };
    },
  },
  value: {
    title: 'Contract value', description: 'Total and annual contract value by customer or supplier, per currency.',
    async run(q) {
      const rows = (await q(
        `select ${WITH} as counterparty, c.counterparty_kind, c.currency, count(*)::int as n, coalesce(sum(c.value), 0) as value, coalesce(sum(${ACV}), 0) as acv
           ${BASE} where c.status in ${LIVE_SQL} group by ${WITH}, c.counterparty_kind, c.currency order by value desc, counterparty`)).rows
        .map((r) => ({ ...r, kind: C.COUNTERPARTIES[r.counterparty_kind] }));
      return { columns: [COL.with, { key: 'kind', header: 'Kind', width: 12 }, COL.cur, { key: 'n', header: 'Contracts', type: 'integer', width: 11 }, COL.value, COL.acv], rows,
        summary: [['Counterparties', String(new Set(rows.map((r) => r.counterparty)).size)], ['Basis', 'Contracts in force']] };
    },
  },
  counterparty: {
    title: 'Customer and supplier contracts', description: 'All contracts of one customer or supplier, or of everyone.', params: ['customer', 'supplier'],
    async run(q, p) {
      const where = ['true']; const params = [];
      const cu = u.id(String(p.customer || '')); if (cu) { params.push(cu); where.push(`c.customer_id = $${params.length}`); }
      const sup = u.str(p.supplier, 100); if (sup) { params.push(`%${sup}%`); where.push(`c.supplier ilike $${params.length}`); }
      const rows = (await q(`select ${SEL} ${BASE} where ${where.join(' and ')} order by ${WITH}, c.end_date nulls last`, params)).rows.map(statusLabel);
      return { columns: [COL.with, COL.ref, COL.title, COL.type, COL.status, COL.start, COL.end, COL.value, COL.cur], rows, summary: [['Contracts', String(rows.length)]] };
    },
  },
  obligations: {
    title: 'Contractual obligations', description: 'Obligations, deliverables and milestones, with who is responsible and when they are due.', params: ['outstanding'],
    async run(q, p) {
      const only = p.outstanding !== '0';
      const rows = (await q(
        `select c.reference, ${WITH} as counterparty, o.kind, o.title, coalesce(nullif(o.responsible, ''), ru.name, '') as responsible, o.due_date, o.status,
                (o.due_date - current_date) as days_left, (o.status in ('open','in_progress') and o.due_date < current_date) as overdue
           from contract_obligations o join contracts c on c.id = o.contract_id left join customers cu on cu.id = c.customer_id left join users ru on ru.id = o.responsible_id
          where ${only ? `o.status in ('open','in_progress')` : 'true'} order by o.due_date nulls last, c.reference`)).rows
        .map((r) => ({ ...r, kind: C.OBLIGATION_KINDS[r.kind], status: r.overdue ? `${r.status.replace('_', ' ')} (overdue)` : r.status.replace('_', ' ') }));
      return { subtitle: only ? 'Outstanding only' : 'All', columns: [COL.ref, COL.with, { key: 'kind', header: 'Kind', width: 13 }, { key: 'title', header: 'Obligation', width: 36, weight: 3 },
        { key: 'responsible', header: 'Responsible', width: 20, weight: 1.5 }, { key: 'due_date', header: 'Due', type: 'date', width: 12 }, { key: 'status', header: 'Status', width: 18 }], rows,
        summary: [['Items', String(rows.length)], ['Overdue', String(rows.filter((r) => r.overdue).length)]] };
    },
  },
  sla: {
    title: 'SLA performance', description: 'Measured performance against each contractual SLA target.',
    async run(q) {
      const rows = (await q(
        `select c.reference, ${WITH} as counterparty, t.label, t.target, t.unit, t.direction, p.period_start, p.period_end, p.measured,
                ((t.direction = 'min' and p.measured >= t.target) or (t.direction = 'max' and p.measured <= t.target)) as ok
           from contract_performance p join contract_sla_targets t on t.id = p.sla_target_id join contracts c on c.id = p.contract_id left join customers cu on cu.id = c.customer_id
          order by c.reference, t.label, p.period_start desc`)).rows
        .map((r) => ({ ...r, target_text: `${r.direction === 'min' ? '>=' : '<='} ${Number(r.target)}${r.unit ? ` ${r.unit}` : ''}`, result: r.ok ? 'Met' : 'Missed', measured: Number(r.measured) }));
      const met = rows.filter((r) => r.ok).length;
      return { columns: [COL.ref, COL.with, { key: 'label', header: 'SLA target', width: 28, weight: 2 }, { key: 'target_text', header: 'Target', width: 14 }, { key: 'period_start', header: 'From', type: 'date', width: 12 },
        { key: 'period_end', header: 'To', type: 'date', width: 12 }, { key: 'measured', header: 'Measured', type: 'number', width: 11 }, { key: 'result', header: 'Result', width: 10 }], rows,
        summary: [['Measurements', String(rows.length)], ['Met', rows.length ? `${met} (${Math.round((met / rows.length) * 100)}%)` : '-']] };
    },
  },
  amendments: {
    title: 'Contract amendment history', description: 'Variations, extensions, amendments and revised values.',
    async run(q) {
      const rows = (await q(
        `select c.reference, ${WITH} as counterparty, a.kind, a.effective_date, a.description, a.old_end_date, a.new_end_date, a.old_value, a.new_value, c.currency, u.name as by
           from contract_amendments a join contracts c on c.id = a.contract_id left join customers cu on cu.id = c.customer_id left join users u on u.id = a.created_by order by a.effective_date desc, a.id desc`)).rows
        .map((r) => ({ ...r, kind: C.AMENDMENT_KINDS[r.kind] }));
      return { columns: [COL.ref, COL.with, { key: 'kind', header: 'Kind', width: 13 }, { key: 'effective_date', header: 'Effective', type: 'date', width: 12 }, { key: 'description', header: 'Change', width: 40, weight: 3 },
        { key: 'old_end_date', header: 'Old end', type: 'date', width: 12 }, { key: 'new_end_date', header: 'New end', type: 'date', width: 12 }, { key: 'old_value', header: 'Old value', type: 'money', width: 15 },
        { key: 'new_value', header: 'New value', type: 'money', width: 15 }, { key: 'by', header: 'Recorded by', width: 18 }], rows, summary: [['Amendments', String(rows.length)]] };
    },
  },
};

async function run(q, id, params = {}) {
  const r = REPORTS[id];
  if (!r) return null;
  const out = await r.run(q, params);
  return { id, title: r.title, ...out };
}

module.exports = { dashboard, REPORTS, run, ACV, WITH };
