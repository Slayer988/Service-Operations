'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const tz = require('../../src/lib/tz');
const tenders = require('../../src/services/tenders');
const pipeline = require('../../src/services/pipeline');
const { UserError } = require('../../src/services/tickets');

test('tz: local date-times convert to the right moment, including daylight saving', () => {
  assert.equal(tz.localToDate('2026-11-30T14:00', 'Africa/Nairobi').toISOString(), '2026-11-30T11:00:00.000Z');          // UTC+3, no DST
  assert.equal(tz.localToDate('2026-07-01T09:00', 'Europe/London').toISOString(), '2026-07-01T08:00:00.000Z');           // BST
  assert.equal(tz.localToDate('2026-12-01T09:00', 'Europe/London').toISOString(), '2026-12-01T09:00:00.000Z');           // GMT
  assert.equal(tz.localToDate('2026-03-08T12:00', 'America/New_York').toISOString(), '2026-03-08T16:00:00.000Z');       // day DST starts: EDT
  assert.equal(tz.localToDate('2026-03-07T12:00', 'America/New_York').toISOString(), '2026-03-07T17:00:00.000Z');       // EST
  assert.equal(tz.localToDate('2026-02-30T10:00', 'Africa/Nairobi'), null);
  assert.equal(tz.localToDate('nonsense', 'Africa/Nairobi'), null);
  assert.equal(tz.localToDate('2026-11-30T25:00', 'Africa/Nairobi'), null);
});

test('tz: round trip for form fields', () => {
  for (const zone of ['Africa/Nairobi', 'Europe/London', 'America/New_York', 'Asia/Kolkata']) {
    const d = tz.localToDate('2026-10-31T23:30', zone);
    assert.equal(tz.dateToLocal(d, zone), '2026-10-31T23:30');
  }
  assert.equal(tz.dateToLocal(null, 'Africa/Nairobi'), '');
});

test('tender reminders: one bucket at a time, none after the deadline', () => {
  const T = [14, 7, 3, 1]; const day = 86400000;
  assert.equal(tenders.bucket(20 * day, T), null);
  assert.equal(tenders.bucket(13.5 * day, T), 14);
  assert.equal(tenders.bucket(6.2 * day, T), 7);
  assert.equal(tenders.bucket(2 * day, T), 3);
  assert.equal(tenders.bucket(0.4 * day, T), 1);
  assert.equal(tenders.bucket(-1, T), null);
  assert.equal(tenders.bucket(2 * day, []), null);
});

test('tender workflow: allowed and forbidden moves', () => {
  const T = tenders.TRANSITIONS;
  assert.deepEqual(Object.keys(T).sort(), Object.keys(tenders.STATUS_LABELS).sort());
  assert.equal(Object.keys(tenders.STATUS_LABELS).length, 14);
  assert.ok(T.identified.includes('registered') && T.internal_approval.includes('submitted') && T.under_evaluation.includes('awarded') && T.clarification.includes('under_evaluation'));
  assert.ok(!T.bid_preparation.includes('submitted'), 'a bid goes through internal approval before submission');
  assert.ok(!T.registered.includes('awarded') && !T.bid_preparation.includes('awarded'));
  for (const done of ['awarded', 'unsuccessful', 'cancelled', 'withdrawn']) assert.deepEqual(T[done], ['closed']);
  assert.deepEqual(T.closed, []);
  assert.deepEqual(tenders.stagesFor('finance'), ['commercial']); assert.deepEqual(tenders.stagesFor('agent'), []);
});

test('tender reviews: the latest decision per stage counts, all three must approve', () => {
  const rows = [{ id: 1, stage: 'technical', decision: 'changes_requested' }, { id: 2, stage: 'technical', decision: 'approved' }, { id: 3, stage: 'commercial', decision: 'approved' }, { id: 4, stage: 'management', decision: 'approved' }, { id: 5, stage: 'management', decision: 'rejected' }];
  const sum = tenders.reviewSummary(rows);
  assert.equal(sum.technical.decision, 'approved'); assert.equal(sum.management.decision, 'rejected');
  assert.equal(tenders.approvedAll(sum), false);
  assert.equal(tenders.approvedAll(tenders.reviewSummary(rows.slice(0, 4))), true);
});

test('tender form validation', () => {
  const opts = { types: ['RFP', 'RFQ'], currencies: ['UGX', 'USD'], timezone: 'Africa/Nairobi' };
  const ok = { title: ' Network upgrade ', issuer: 'Ministry', submission_due: '2026-12-01T10:00', est_value: '1,250,000.50', currency: 'USD', type: 'RFQ', department: 'Gov' };
  const f = tenders.readFields(ok, opts);
  assert.equal(f.title, 'Network upgrade'); assert.equal(f.est_value, 1250000.5); assert.equal(f.currency, 'USD'); assert.equal(f.type, 'RFQ'); assert.equal(f.department, 'Gov');
  assert.equal(f.submission_due.toISOString(), '2026-12-01T07:00:00.000Z');
  assert.equal(tenders.readFields({ ...ok, type: 'Nonsense', currency: 'XXX' }, opts).type, 'RFP');
  assert.throws(() => tenders.readFields({ ...ok, title: '' }, opts), UserError);
  assert.throws(() => tenders.readFields({ ...ok, submission_due: '' }, opts), /deadline/);
  assert.throws(() => tenders.readFields({ ...ok, est_value: '-5' }, opts), /positive/);
  assert.throws(() => tenders.readFields({ ...ok, clarification_due: 'soon' }, opts), /clarification/i);
});

test('pipeline: ten stages, probabilities follow the stage, won and lost are fixed', () => {
  assert.deepEqual(pipeline.STAGES, ['lead_identification', 'prospecting', 'qualification', 'solution_development', 'proposal_submission', 'negotiation', 'closing', 'won', 'lost', 'on_hold']);
  assert.equal(pipeline.DEFAULT_PROB.won, 100); assert.equal(pipeline.DEFAULT_PROB.lost, 0);
  assert.ok(pipeline.OPEN.every((k, i, a) => i === 0 || pipeline.DEFAULT_PROB[k] > pipeline.DEFAULT_PROB[a[i - 1]]), 'probability rises along the stages');
  assert.ok(!pipeline.OPEN.includes('on_hold') && pipeline.ACTIVE.includes('on_hold'));
});

test('pipeline form validation', () => {
  const opts = { categories: ['Service', 'Solution'], currencies: ['UGX', 'USD'], defaultCurrency: 'UGX' };
  const f = pipeline.readFields({ name: 'ERP support', prospect: 'Acme', value: '12,000', probability: '40', expected_close: '2026-12-31', classification: 'Solution', industry: 'Retail' }, opts);
  assert.equal(f.value, 12000); assert.equal(f.probability, 40); assert.equal(f.currency, 'UGX'); assert.equal(f.classification, 'Solution'); assert.equal(f.industry, 'Retail');
  assert.equal(pipeline.readFields({ name: 'x', prospect: 'y' }, opts).probability, null);
  assert.throws(() => pipeline.readFields({ name: 'x' }, opts), /customer or enter/);
  assert.throws(() => pipeline.readFields({ name: 'x', prospect: 'y', probability: '120' }, opts), /0 to 100/);
  assert.throws(() => pipeline.readFields({ name: 'x', prospect: 'y', value: '-1' }, opts), /positive/);
  assert.throws(() => pipeline.readFields({ name: 'x', prospect: 'y', expected_close: '2026-02-31' }, opts), /not valid/);
  assert.equal(pipeline.readFields({ name: 'x', customer_id: '5', prospect: 'ignored' }, opts).prospect, '');
});

test('pipeline totals are per currency and weighted by probability; closed and held deals are excluded', () => {
  const t = pipeline.totals([
    { stage: 'lead_identification', value: 1000, probability: 10, currency: 'USD' }, { stage: 'proposal_submission', value: '2000.00', probability: 50, currency: 'USD' },
    { stage: 'won', value: 9999, probability: 100, currency: 'USD' }, { stage: 'on_hold', value: 777, probability: 10, currency: 'USD' }, { stage: 'negotiation', value: 500, probability: 75, currency: 'KES' },
  ]);
  assert.equal(t.USD.open, 3000); assert.equal(t.USD.weighted, 1100); assert.equal(t.USD.count, 2); assert.equal(t.USD.stages.proposal_submission.value, 2000);
  assert.equal(t.KES.weighted, 375);
  assert.equal(pipeline.winRate(3, 1), 75); assert.equal(pipeline.winRate(0, 0), null);
});

test('pipeline forecast: months and quarters from expected close; overdue dates fall in the current month', () => {
  const f = pipeline.forecast([
    { stage: 'negotiation', value: 100, probability: 75, currency: 'UGX', expected_close: '2026-12-15' }, { stage: 'prospecting', value: 10, probability: 10, currency: 'UGX', expected_close: '2026-09-01' },
    { stage: 'lead_identification', value: 50, probability: 10, currency: 'UGX', expected_close: null }, { stage: 'lost', value: 999, probability: 0, currency: 'UGX', expected_close: '2026-12-01' },
    { stage: 'closing', value: 40, probability: 90, currency: 'UGX', expected_close: '2029-01-01' },
  ], '2026-11-01', 12).UGX;
  assert.equal(f.months[0].key, '2026-11'); assert.equal(f.months[0].count, 1); assert.equal(f.months[0].weighted, 1);
  assert.equal(f.months[1].key, '2026-12'); assert.equal(f.months[1].weighted, 75);
  assert.equal(f.quarters[0].key, '2026-Q4'); assert.equal(f.quarters[0].count, 2);
  assert.equal(f.unscheduled.count, 1); assert.equal(f.later.count, 1);
});

test('pipeline: engineering progress and overdue tasks', () => {
  assert.equal(pipeline.overallProgress([]), 0);
  assert.equal(pipeline.overallProgress([{ progress: 100 }, { progress: 50 }, { progress: 0 }]), 50);
  assert.equal(pipeline.isOverdue({ status: 'in_progress', due_date: '2026-10-01' }, '2026-11-01'), true);
  assert.equal(pipeline.isOverdue({ status: 'completed', due_date: '2026-10-01' }, '2026-11-01'), false);
  assert.equal(pipeline.isOverdue({ status: 'pending', due_date: null }, '2026-11-01'), false);
});
