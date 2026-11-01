'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/services/contracts');
const perms = require('../../src/lib/perms');
const { UserError } = require('../../src/services/tickets');

test('contract lifecycle has exactly the seven statuses, with no draft, review or approved status', () => {
  assert.deepEqual(C.STATUSES.slice().sort(), ['active', 'closed', 'expired', 'expiring_soon', 'renewal_in_progress', 'suspended', 'terminated']);
});

test('contract status follows the end date; manual statuses are never overridden', () => {
  const day = '2026-11-01';
  assert.equal(C.autoStatus({ status: 'active', end_date: '2027-06-01' }, day), 'active');
  assert.equal(C.autoStatus({ status: 'active', end_date: '2027-01-15' }, day), 'expiring_soon');
  assert.equal(C.autoStatus({ status: 'active', end_date: '2026-11-01' }, day), 'expiring_soon');
  assert.equal(C.autoStatus({ status: 'expiring_soon', end_date: '2026-10-31' }, day), 'expired');
  assert.equal(C.autoStatus({ status: 'active', end_date: '2027-01-15' }, day, 30), 'active');
  assert.equal(C.autoStatus({ status: 'renewal_in_progress', end_date: '2026-12-01' }, day), 'renewal_in_progress');
  assert.equal(C.autoStatus({ status: 'renewal_in_progress', end_date: '2026-10-01' }, day), 'expired');
  for (const s of ['suspended', 'terminated', 'closed']) assert.equal(C.autoStatus({ status: s, end_date: '2020-01-01' }, day), s);
  assert.equal(C.autoStatus({ status: 'expired', end_date: '2028-01-01' }, day), 'active', 'an extension brings an expired contract back');
  assert.equal(C.autoStatus({ status: 'active', end_date: null }, day), 'active');
});

test('contract form validation', () => {
  const opts = { types: ['SLA', 'Other'], currencies: ['UGX', 'USD'], defaultCurrency: 'UGX', departments: [] };
  const ok = { title: ' Core support ', counterparty_kind: 'customer', customer_id: '3', type: 'SLA', start_date: '2026-01-01', end_date: '2027-01-01', value: '12,500,000', currency: 'USD', extra_emails: 'a@x.com, nonsense, B@y.com' };
  const f = C.readFields(ok, opts);
  assert.equal(f.title, 'Core support'); assert.equal(f.value, 12500000); assert.equal(f.currency, 'USD'); assert.deepEqual(f.extra_emails, ['a@x.com', 'b@y.com']);
  assert.throws(() => C.readFields({ ...ok, title: '' }, opts), UserError);
  assert.throws(() => C.readFields({ ...ok, customer_id: '' }, opts), /customer/);
  assert.throws(() => C.readFields({ ...ok, counterparty_kind: 'supplier', supplier: '' }, opts), /supplier/);
  assert.throws(() => C.readFields({ ...ok, end_date: '2025-01-01' }, opts), /before/);
  assert.equal(C.readFields({ ...ok, counterparty_kind: 'supplier', supplier: 'Cisco', customer_id: '3' }, opts).customer_id, null, 'a supplier contract has no customer');
});

test('contract review stages depend on the role; the latest decision per stage counts', () => {
  assert.ok(C.stagesFor('legal').length > 0); assert.deepEqual(C.stagesFor('agent'), []);
  const s = C.reviewSummary([{ id: 1, stage: 'legal', decision: 'rejected' }, { id: 2, stage: 'legal', decision: 'approved' }]);
  assert.equal(s.legal.decision, 'approved');
});

test('SLA target is met in the right direction', () => {
  assert.equal(C.met(99.5, 'min', 99.9), true);
  assert.equal(C.met(99.5, 'min', 98), false);
  assert.equal(C.met(4, 'max', 3), true);
  assert.equal(C.met(4, 'max', 5), false);
});

test('roles: SDE sees only assigned opportunities; ticket queues are closed to business-only roles', () => {
  const u = (role) => ({ role, kind: 'staff' });
  assert.ok(perms.can(u('sde'), 'pipeline.support') && !perms.can(u('sde'), 'pipeline.view') && !perms.can(u('sde'), 'pipeline.manage'));
  assert.ok(perms.can(u('bd_manager'), 'pipeline.manage') && perms.can(u('bid_manager'), 'tender.manage') && !perms.can(u('bid_manager'), 'contract.manage'));
  assert.ok(perms.can(u('finance'), 'contract.finance') && !perms.can(u('finance'), 'tender.manage'));
  for (const r of ['bd_manager', 'bid_manager', 'finance', 'legal', 'sde', 'technical_team', 'dept_head']) assert.ok(!perms.can(u(r), 'ticket.work'), `${r} does not work tickets`);
  assert.ok(perms.can(u('platform_admin'), 'settings.manage') && !perms.can(u('management'), 'settings.manage'));
  assert.equal(Object.keys(perms.ROLE_LABELS).length >= 18, true);
});
