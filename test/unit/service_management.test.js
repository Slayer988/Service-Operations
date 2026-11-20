'use strict';
// 1.25.0: problem and change rules, change approval, and service notices.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.APP_TIMEZONE = process.env.APP_TIMEZONE || 'Africa/Kampala';
const P = require('../../src/services/problems');
const C = require('../../src/services/changes');
const N = require('../../src/services/notices');
const A = require('../../src/services/approvals');

test('problems: a title is needed; the allowed moves; a closed problem can be reopened', () => {
  assert.throws(() => P.read({ title: '' }), /short title/);
  assert.equal(P.read({ title: 'x', priority: '9' }).priority, 3, 'a bad priority falls back to P3');
  assert.deepEqual(P.MOVES.known_error, ['investigating', 'resolved']);
  assert.ok(P.MOVES.closed.includes('investigating'));
  assert.ok(!P.MOVES.open.includes('open'));
});

test('changes: dates are read in the application time zone; the end must follow the start', () => {
  const v = C.read({ title: 'Firmware', planned_start: '2026-12-01T22:00', planned_end: '2026-12-01T23:30' });
  assert.equal(v.planned_start.toISOString(), '2026-12-01T19:00:00.000Z', '22:00 in Kampala is 19:00 UTC');
  assert.equal(C.forInput(v.planned_start), '2026-12-01T22:00');
  assert.throws(() => C.read({ title: 'x', planned_start: '2026-12-01T22:00', planned_end: '2026-12-01T21:00' }), /end must be after the start/);
  assert.throws(() => C.read({ title: 'x', planned_start: 'tomorrow' }), /not a date and time/);
  assert.throws(() => C.read({ title: '' }), /Give the change a title/);
  assert.equal(C.read({ title: 'x', type: 'weird', risk: 'huge' }).type, 'normal');
});

test('changes: the moves; finished changes are final', () => {
  assert.deepEqual(C.MOVES.draft, ['scheduled', 'cancelled']);
  assert.deepEqual(C.MOVES.in_progress, ['completed', 'failed']);
  for (const s of ['completed', 'failed', 'cancelled']) assert.deepEqual(C.MOVES[s], []);
});

test('change approval: standard changes are pre-approved; normal and emergency need it; high risk needs a second approver', () => {
  const r = { change: { enabled: true, roles: ['service_manager', 'dept_head'], l2Roles: ['management'] }, quote: {}, lpo: {} };
  assert.deepEqual(A.required(r, 'change', { type: 'standard', risk: 'high' }), []);
  const normal = A.required(r, 'change', { type: 'normal', risk: 'medium' });
  assert.equal(normal.length, 1); assert.deepEqual(normal[0].roles, ['service_manager', 'dept_head']);
  assert.match(A.required(r, 'change', { type: 'emergency', risk: 'low' })[0].reasons[0], /emergency/);
  assert.deepEqual(A.required(r, 'change', { type: 'normal', risk: 'high' }).map((n) => n.level), [1, 2]);
  assert.deepEqual(A.required({ ...r, change: { ...r.change, enabled: false } }, 'change', { type: 'normal', risk: 'high' }), []);
  assert.equal(A.DONE_VERB.change, 'scheduled');
});

test('notices: what customers are told is checked first', () => {
  assert.throws(() => N.read({ title: '', text: '' }), /title customers will understand.*Choose the customers.*first message/);
  assert.throws(() => N.read({ title: 'x', text: 'y', customer_ids: ['1'] }, 'maintenance'), /needs its start and end/);
  const ok = N.read({ title: 'Down', text: 'We are on it', customer_ids: ['4', 'x', '7'], severity: 'outage' });
  assert.deepEqual(ok.customer_ids, [4, 7]); assert.equal(ok.status, 'investigating'); assert.equal(ok.kind, 'incident');
  assert.equal(N.read({ title: 'x', text: 'y', all_customers: '1', starts_at: '2026-12-01T22:00', ends_at: '2026-12-01T23:00' }, 'maintenance').status, 'scheduled');
  assert.equal(N.label({ kind: 'incident', status: 'monitoring' }), 'Fixed, monitoring');
});
