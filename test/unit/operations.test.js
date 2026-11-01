'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../../src/services/operations');
const PJ = require('../../src/services/projects');
const perms = require('../../src/lib/perms');

test('weeks start on Monday and carry the ISO week number', () => {
  assert.equal(O.weekStart('2026-10-28'), '2026-10-26');     // a Wednesday
  assert.equal(O.weekStart('2026-10-26'), '2026-10-26');     // the Monday itself
  assert.equal(O.weekStart('2026-11-01'), '2026-10-26');     // the Sunday belongs to the week before
  assert.equal(O.weekStart('2026-09-28'), '2026-09-28');
  assert.equal(O.isoWeek('2026-09-28'), 40);                 // the report cover: "W 40", 28 Sept to 2 Oct 2026
  assert.equal(O.isoWeek('2026-10-26'), 44);
  assert.equal(O.isoWeek('2026-01-01'), 1); assert.equal(O.isoWeek('2021-01-03'), 53); assert.equal(O.isoWeek('2024-12-30'), 1);
  assert.equal(O.addDays('2026-10-26', -7), '2026-10-19'); assert.equal(O.addDays('2026-12-28', 7), '2027-01-04');
});

test('compact money', () => {
  assert.equal(O.compact(0), '0'); assert.equal(O.compact(950), '950'); assert.equal(O.compact(12500), '12.5K'); assert.equal(O.compact(5500000), '5.5M');
  assert.equal(O.compact(2000000), '2M'); assert.equal(O.compact(3100000000), '3.1B'); assert.equal(O.compact(null), '0'); assert.equal(O.compact(-2500000), '-2.5M');
});

test('change against last week, and which direction is good news', () => {
  assert.deepEqual(O.change(12, 10), { dir: 'up', abs: 2, pct: 20 });
  assert.deepEqual(O.change(5, 10), { dir: 'down', abs: -5, pct: -50 });
  assert.deepEqual(O.change(0, 0), { dir: 'flat', abs: 0, pct: 0 });
  assert.equal(O.change(4, 0).pct, null);                    // nothing last week to compare with
  const up = O.delta(O.change(12, 10)); assert.equal(up.pct, '+20%'); assert.equal(up.tone, 'good');
  const worse = O.delta(O.change(12, 10), 'down'); assert.equal(worse.tone, 'worse');                  // more breaches is bad
  assert.equal(O.delta(O.change(5, 10), 'down').tone, 'good'); assert.equal(O.delta(O.change(5, 5)).tone, 'flat');
  assert.equal(O.delta(O.change(4, 0), 'down').pct, '+4'); assert.equal(O.delta(O.change(5500000, 0)).pct, '+5.5M');
  assert.equal(O.delta(O.change(5, 10)).pct, '−50%');
});

test('SLA compliance and its colour', () => {
  assert.equal(O.pctMet(9, 1), 90); assert.equal(O.pctMet(0, 0), null); assert.equal(O.pctMet(2, 1), 66.7);
  assert.equal(O.slaTone(97), 'ok'); assert.equal(O.slaTone(90), 'warn'); assert.equal(O.slaTone(60), 'bad'); assert.equal(O.slaTone(null), '');
});

test('project progress is the share of tasks done; cancelled work does not count', () => {
  assert.equal(PJ.progress([]), null);
  assert.equal(PJ.progress([{ status: 'done' }, { status: 'open' }]), 50);
  assert.equal(PJ.progress([{ status: 'done' }, { status: 'cancelled' }]), 100);
  assert.equal(PJ.progress([{ status: 'cancelled' }]), null);
  assert.equal(PJ.progress([{ status: 'done' }, { status: 'in_progress' }, { status: 'open' }]), 33);
});

test('project form validation', () => {
  const opts = { currencies: ['UGX', 'USD'], defaultCurrency: 'UGX' };
  assert.throws(() => PJ.readFields({ name: '', manager_id: '1' }, opts), /name/);
  assert.throws(() => PJ.readFields({ name: 'A' }, opts), /manager/);
  assert.throws(() => PJ.readFields({ name: 'A', manager_id: '1', start_date: '2026-13-01' }, opts), /start date/);
  assert.throws(() => PJ.readFields({ name: 'A', manager_id: '1', start_date: '2026-12-01', end_date: '2026-11-01' }, opts), /before the start/);
  assert.throws(() => PJ.readFields({ name: 'A', manager_id: '1', budget: '-5' }, opts), /budget/);
  const f = PJ.readFields({ name: ' Rollout ', manager_id: '3', status: 'bogus', health: 'amber', budget: '1500', currency: 'EUR', customer_id: '' }, opts);
  assert.equal(f.name, 'Rollout'); assert.equal(f.status, 'planning'); assert.equal(f.health, 'amber'); assert.equal(f.currency, 'UGX'); assert.equal(f.customer_id, null); assert.equal(Number(f.budget), 1500);
  assert.deepEqual(PJ.OPEN, ['planning', 'active', 'on_hold']); assert.deepEqual(PJ.CLOSED, ['completed', 'cancelled']);
  assert.throws(() => PJ.readTask({ title: '' }), /what needs/); assert.throws(() => PJ.readTask({ title: 'x', due_date: 'tomorrow' }), /due date/);
  assert.equal(PJ.readTask({ title: 'x', kind: 'milestone' }).kind, 'milestone'); assert.equal(PJ.readTask({ title: 'x', kind: 'bogus' }).kind, 'task');
});

test('who may see and change what on the Operations Overview and Projects', () => {
  const as = (role) => ({ kind: 'staff', role });
  for (const r of ['platform_admin', 'service_manager', 'agent', 'engineer', 'sde', 'finance', 'management', 'bd_manager', 'readonly', 'security_analyst', 'auditor']) assert.ok(perms.can(as(r), 'operations.view'), r);
  assert.ok(!perms.can(as('customer_admin'), 'operations.view'));
  assert.ok(perms.can(as('engineer'), 'project.view') && !perms.can(as('agent'), 'project.view') && !perms.can(as('finance'), 'project.view'));
  assert.ok(perms.can(as('service_manager'), 'project.manage') && !perms.can(as('engineer'), 'project.manage') && !perms.can(as('management'), 'project.manage'));
  assert.ok(perms.can(as('sde'), 'project.contribute') && !perms.can(as('readonly'), 'project.contribute'));
  assert.ok(perms.can(as('dept_head'), 'operations.manage') && !perms.can(as('agent'), 'operations.manage'));
  assert.ok(perms.can(as('bd_manager'), 'pipeline.escalate') && !perms.can(as('sde'), 'pipeline.escalate'));
});
