'use strict';
// Tender dashboard figures (spec 3.3) and reports (spec 3.4). Reports share one shape so reporting.send can render HTML, CSV, Excel or PDF.
const u = require('../lib/util');
const T = require('./tenders');

const ACTIVE_SQL = `(${T.ACTIVE.map((s) => `'${s}'`).join(',')})`;
const WITH = `coalesce(cu.name, t.issuer)`;
const statusLabel = (labels) => (r) => ({ ...r, status_label: (labels || T.STATUS_LABELS)[r.status] || r.status });
const rate = (won, lost) => (won + lost > 0 ? Math.round((won / (won + lost)) * 1000) / 10 : null);

async function dashboard(q, defaultCurrency = 'UGX') {
  const c = (await q(
    `select count(*) filter (where status = any($1))::int as active,
            count(*) filter (where status = 'under_evaluation')::int as evaluating,
            count(*) filter (where status = 'internal_approval')::int as awaiting_review,
            count(*) filter (where status = any($2) and submission_due between now() and now() + interval '14 days')::int as soon,
            count(*) filter (where status = any($2) and submission_due < now())::int as overdue,
            count(*) filter (where status = 'submitted')::int as submitted,
            count(*) filter (where status = 'awarded')::int as awarded,
            count(*) filter (where status = 'unsuccessful')::int as unsuccessful,
            count(*) filter (where status = 'awarded' and awarded_on >= date_trunc('year', current_date))::int as awarded_ytd,
            count(*) filter (where status = 'unsuccessful' and coalesce(awarded_on, updated_at::date) >= date_trunc('year', current_date))::int as lost_ytd,
            count(*)::int as total from tenders`, [T.ACTIVE, T.PRE_SUBMISSION])).rows[0];
  const money = (await q(
    `select currency, coalesce(sum(est_value), 0) as active_value, count(*)::int as n from tenders where status = any($1) group by currency order by (currency = $2) desc, currency`, [T.ACTIVE, defaultCurrency])).rows
    .map((r) => ({ currency: r.currency, value: Number(r.active_value), n: r.n }));
  const awardedValue = (await q(`select currency, coalesce(sum(award_value), 0) as v from tenders where award_value is not null and (status = 'awarded' or (status = 'closed' and awarded_on is not null)) group by currency order by (currency = $1) desc, currency`, [defaultCurrency])).rows
    .map((r) => ({ currency: r.currency, value: Number(r.v) }));
  const byStatus = (await q(`select status, count(*)::int as n from tenders group by status`)).rows;
  const byType = (await q(`select type as label, count(*)::int as n from tenders group by type order by n desc, type`)).rows;
  const byClient = (await q(
    `select ${WITH} as label, count(*) filter (where t.status = 'awarded')::int as won, count(*) filter (where t.status = 'unsuccessful')::int as lost, count(*)::int as n
       from tenders t left join customers cu on cu.id = t.customer_id group by ${WITH} having count(*) filter (where t.status in ('awarded','unsuccessful')) > 0 order by won desc, lost, label limit 8`)).rows
    .map((r) => ({ ...r, rate: rate(r.won, r.lost) }));
  const byUnit = (await q(
    `select coalesce(nullif(t.business_unit, ''), nullif(t.department, ''), 'Unassigned') as label, count(*) filter (where t.status = 'awarded')::int as won, count(*) filter (where t.status = 'unsuccessful')::int as lost, count(*)::int as n
       from tenders t group by 1 having count(*) filter (where t.status in ('awarded','unsuccessful')) > 0 order by won desc, lost, label limit 8`)).rows
    .map((r) => ({ ...r, rate: rate(r.won, r.lost) }));
  const upcoming = (await q(
    `select t.id, t.ref, t.title, t.status, t.submission_due, ${WITH} as client, o.name as owner,
            (select count(*)::int from tender_tasks k where k.tender_id = t.id and k.done_at is null) as open_tasks
       from tenders t left join customers cu on cu.id = t.customer_id join users o on o.id = t.owner_id
      where t.status = any($1) order by t.submission_due limit 8`, [T.PRE_SUBMISSION])).rows;
  return { counts: c, money, awardedValue, byStatus, byType, byClient, byUnit, upcoming, winRate: rate(c.awarded, c.unsuccessful), winRateYtd: rate(c.awarded_ytd, c.lost_ytd) };
}

const COL = {
  ref: { key: 'ref', header: 'Reference', width: 15 }, title: { key: 'title', header: 'Tender', width: 34, weight: 3 }, client: { key: 'client', header: 'Client / procuring entity', width: 26, weight: 2 },
  type: { key: 'type', header: 'Type', width: 10 }, status: { key: 'status_label', header: 'Status', width: 18 }, owner: { key: 'owner', header: 'Owner', width: 18 },
  dept: { key: 'department', header: 'Department', width: 16 }, unit: { key: 'business_unit', header: 'Business unit', width: 16 },
  due: { key: 'submission_due', header: 'Deadline', type: 'date', width: 13 }, est: { key: 'est_value', header: 'Estimated value', type: 'money', width: 16 }, cur: { key: 'currency', header: 'Cur.', width: 7 },
  award: { key: 'award_value', header: 'Award value', type: 'money', width: 16 },
};
const BASE = `from tenders t left join customers cu on cu.id = t.customer_id join users o on o.id = t.owner_id`;
const SEL = `t.id, t.ref, t.title, ${WITH} as client, t.type, t.status, o.name as owner, t.department, t.business_unit, t.submission_due::date as submission_due, t.submitted_at::date as submitted_on, t.submission_method,
             t.submission_reference, t.est_value, t.award_value, t.currency, t.awarded_to, t.awarded_on, t.outcome_note, t.decision_reason`;

function between(p, col, params, where) {
  const from = u.dateStr(p.from); const to = u.dateStr(p.to);
  if (from) { params.push(from); where.push(`${col} >= $${params.length}::date`); }
  if (to) { params.push(to); where.push(`${col} <= $${params.length}::date`); }
  return [from, to];
}
const period = (from, to) => (from || to ? `${from || 'start'} to ${to || 'today'}` : 'All time');

const REPORTS = {
  active: {
    title: 'Active tenders', description: 'Tenders being identified, prepared, submitted or evaluated.',
    async run(q, p, labels) {
      const rows = (await q(`select ${SEL} ${BASE} where t.status = any($1) order by t.submission_due`, [T.ACTIVE])).rows.map(statusLabel(labels));
      return { columns: [COL.ref, COL.title, COL.client, COL.type, COL.status, COL.owner, COL.dept, COL.due, COL.est, COL.cur], rows, summary: [['Active tenders', String(rows.length)]] };
    },
  },
  submissions: {
    title: 'Tender submissions', description: 'Bids submitted in a period, with the method and reference used.', params: ['from', 'to'],
    async run(q, p, labels) {
      const where = ['t.submitted_at is not null']; const params = []; const [from, to] = between(p, 't.submitted_at::date', params, where);
      const rows = (await q(`select ${SEL} ${BASE} where ${where.join(' and ')} order by t.submitted_at desc`, params)).rows.map(statusLabel(labels));
      return { subtitle: period(from, to), columns: [COL.ref, COL.title, COL.client, COL.type, { key: 'submitted_on', header: 'Submitted', type: 'date', width: 12 }, { key: 'submission_method', header: 'Method', width: 16 },
        { key: 'submission_reference', header: 'Reference', width: 20 }, COL.status, COL.est, COL.cur], rows, summary: [['Period', period(from, to)], ['Bids submitted', String(rows.length)]] };
    },
  },
  evaluations: {
    title: 'Tender evaluations', description: 'Evaluation stages, clarification requests and scores for submitted tenders.',
    async run(q) {
      const rows = (await q(
        `select t.ref, t.title, ${WITH} as client, e.kind, e.title as stage, e.event_date, e.due_date, e.responded_on, e.score, e.outcome, e.notes, t.status
           from tender_evaluations e join tenders t on t.id = e.tender_id left join customers cu on cu.id = t.customer_id order by t.ref, e.event_date nulls last, e.id`)).rows
        .map((r) => ({ ...r, kind: T.EVAL_KINDS[r.kind], score: r.score === null ? null : Number(r.score), status_label: T.STATUS_LABELS[r.status] }));
      return { columns: [COL.ref, { key: 'title', header: 'Tender', width: 30, weight: 2 }, COL.client, { key: 'kind', header: 'Kind', width: 16 }, { key: 'stage', header: 'Stage / request', width: 30, weight: 2 },
        { key: 'event_date', header: 'Date', type: 'date', width: 12 }, { key: 'due_date', header: 'Due', type: 'date', width: 12 }, { key: 'responded_on', header: 'Responded', type: 'date', width: 12 },
        { key: 'score', header: 'Score', type: 'number', width: 9 }, { key: 'outcome', header: 'Outcome', width: 24 }], rows, summary: [['Records', String(rows.length)]] };
    },
  },
  awards: {
    title: 'Tender awards', description: 'Awarded tenders, who won, the award value and date.', params: ['from', 'to'],
    async run(q, p, labels) {
      const where = [`t.status in ('awarded','unsuccessful') or (t.status = 'closed' and t.awarded_on is not null)`]; const params = []; const [from, to] = between(p, 't.awarded_on', params, []);
      const extra = []; if (from) extra.push(`t.awarded_on >= $1::date`); if (to) extra.push(`t.awarded_on <= $${params.length}::date`);
      const rows = (await q(`select ${SEL}, (t.status = 'awarded' or (t.status = 'closed' and t.award_value is not null)) as won ${BASE} where (${where[0]}) ${extra.length ? `and ${extra.join(' and ')}` : ''} order by t.awarded_on desc nulls last, t.ref`, params)).rows
        .map(statusLabel(labels)).map((r) => ({ ...r, result: r.status === 'unsuccessful' ? 'Lost' : 'Awarded to us' }));
      const won = rows.filter((r) => r.status === 'awarded');
      return { subtitle: period(from, to), columns: [COL.ref, COL.title, COL.client, { key: 'result', header: 'Result', width: 14 }, { key: 'awarded_to', header: 'Awarded to', width: 24 }, { key: 'awarded_on', header: 'Date', type: 'date', width: 12 }, COL.award, COL.cur], rows,
        summary: [['Period', period(from, to)], ['Awarded to us', String(won.length)], ['Lost', String(rows.length - won.length)]] };
    },
  },
  winloss: {
    title: 'Win / loss analysis', description: 'Success rate overall, by client, by tender type and by business unit.', params: ['from', 'to'],
    async run(q, p) {
      const where = [`t.status in ('awarded','unsuccessful')`]; const params = []; const [from, to] = between(p, `coalesce(t.awarded_on, t.updated_at::date)`, params, where);
      const group = async (expr, label) => (await q(
        `select ${expr} as name, count(*) filter (where t.status = 'awarded')::int as won, count(*) filter (where t.status = 'unsuccessful')::int as lost
           from tenders t left join customers cu on cu.id = t.customer_id where ${where.join(' and ')} group by 1 order by 2 desc, 3, 1`, params)).rows.map((r) => ({ dimension: label, ...r, total: r.won + r.lost, rate: rate(r.won, r.lost) }));
      const rows = [...await group(WITH, 'Client'), ...await group('t.type', 'Tender type'), ...await group(`coalesce(nullif(t.business_unit, ''), nullif(t.department, ''), 'Unassigned')`, 'Business unit')];
      const won = (await q(`select count(*) filter (where t.status = 'awarded')::int as won, count(*) filter (where t.status = 'unsuccessful')::int as lost from tenders t where ${where.join(' and ')}`, params)).rows[0];
      return { subtitle: period(from, to), columns: [{ key: 'dimension', header: 'Analysed by', width: 14 }, { key: 'name', header: 'Name', width: 30, weight: 2 }, { key: 'won', header: 'Won', type: 'integer', width: 8 }, { key: 'lost', header: 'Lost', type: 'integer', width: 8 },
        { key: 'total', header: 'Decided', type: 'integer', width: 9 }, { key: 'rate', header: 'Success rate', type: 'percent', width: 13 }], rows,
        summary: [['Period', period(from, to)], ['Won', String(won.won)], ['Lost', String(won.lost)], ['Success rate', rate(won.won, won.lost) === null ? '-' : `${rate(won.won, won.lost)}%`]] };
    },
  },
  value: {
    title: 'Tender value', description: 'Estimated value of live tenders and value awarded, per currency and status.',
    async run(q) {
      const rows = (await q(`select t.status, t.currency, count(*)::int as n, coalesce(sum(t.est_value), 0) as est, coalesce(sum(t.award_value), 0) as award from tenders t group by t.status, t.currency order by t.currency, t.status`)).rows
        .map((r) => ({ status_label: T.STATUS_LABELS[r.status], currency: r.currency, n: r.n, est: Number(r.est), award: Number(r.award) }));
      return { columns: [COL.status, COL.cur, { key: 'n', header: 'Tenders', type: 'integer', width: 10 }, { key: 'est', header: 'Estimated value', type: 'money', width: 18 }, { key: 'award', header: 'Awarded value', type: 'money', width: 18 }], rows, summary: [['Rows', String(rows.length)]] };
    },
  },
  performance: {
    title: 'Tender performance', description: 'Tenders owned, submitted and won by department and by person.', params: ['from', 'to'],
    async run(q, p) {
      const where = ['true']; const params = []; const [from, to] = between(p, 't.created_at::date', params, where);
      const run = async (expr, label) => (await q(
        `select ${expr} as name, count(*)::int as total, count(*) filter (where t.submitted_at is not null)::int as submitted, count(*) filter (where t.status = 'awarded')::int as won,
                count(*) filter (where t.status = 'unsuccessful')::int as lost from tenders t join users o on o.id = t.owner_id where ${where.join(' and ')} group by 1 order by total desc, 1`, params)).rows
        .map((r) => ({ dimension: label, ...r, rate: rate(r.won, r.lost) }));
      const rows = [...await run(`coalesce(nullif(t.department, ''), 'Unassigned')`, 'Department'), ...await run('o.name', 'Owner / bid manager')];
      return { subtitle: `Tenders registered ${period(from, to).toLowerCase()}`, columns: [{ key: 'dimension', header: 'Analysed by', width: 18 }, { key: 'name', header: 'Name', width: 28, weight: 2 }, { key: 'total', header: 'Tenders', type: 'integer', width: 10 },
        { key: 'submitted', header: 'Submitted', type: 'integer', width: 11 }, { key: 'won', header: 'Won', type: 'integer', width: 8 }, { key: 'lost', header: 'Lost', type: 'integer', width: 8 }, { key: 'rate', header: 'Success rate', type: 'percent', width: 13 }], rows,
        summary: [['Period', period(from, to)]] };
    },
  },
};

async function run(q, id, params = {}, labels) {
  const r = REPORTS[id];
  if (!r) return null;
  const out = await r.run(q, params, labels);
  return { id, title: r.title, ...out };
}

module.exports = { dashboard, REPORTS, run, rate };
