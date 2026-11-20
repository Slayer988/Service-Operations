'use strict';
// Approval rules: when a quote or a purchase order needs approval, and how the limits are read from Settings.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../src/services/approvals');

const rules = (over = {}) => ({
  quote: { enabled: true, limits: { UGX: 20000000, USD: 5000 }, discountPct: 10, roles: ['finance'], ...(over.quote || {}) },
  lpo: { enabled: true, roles: ['finance', 'dept_head'], l2Limits: { UGX: 50000000, USD: 13000 }, l2Roles: ['management'], ...(over.lpo || {}) },
});

test('approval limits are read as "currency amount" lines; mistakes are explained', () => {
  assert.deepEqual(A.parseLimits('UGX 20,000,000\nusd 5000\n\n KES: 650 000 '), { UGX: 20000000, USD: 5000, KES: 650000 });
  assert.deepEqual(A.parseLimits(''), {});
  assert.throws(() => A.parseLimits('twenty million'), /is not a currency and an amount/);
  assert.equal(A.formatLimits({ UGX: 20000000, USD: 5000 }), 'UGX 20,000,000\nUSD 5,000');
});

test('quotes: approval above the limit for the currency, or for a large discount; a currency without a limit always needs it', () => {
  const q = (currency, total, gross, net) => ({ currency, total, gross: gross ?? total, net: net ?? total });
  assert.deepEqual(A.required(rules(), 'quote', q('UGX', 19999999)), [], 'just under the limit');
  const at = A.required(rules(), 'quote', q('UGX', 20000000));
  assert.equal(at.length, 1); assert.equal(at[0].level, 1); assert.match(at[0].reasons[0], /at or above UGX 20,000,000/);
  assert.match(A.required(rules(), 'quote', q('USD', 1000, 1000 / 0.88, 1000))[0].reasons[0], /discount, 12\.0%/, 'a 12% discount on a small quote');
  assert.deepEqual(A.required(rules(), 'quote', q('USD', 1000, 1000 / 0.95, 1000)), [], 'a 5% discount is fine');
  assert.match(A.required(rules(), 'quote', q('KES', 10))[0].reasons[0], /no approval limit set/);
  assert.equal(A.required(rules(), 'quote', q('USD', 9000, 11000, 9000))[0].reasons.length, 2, 'both reasons are given');
  assert.deepEqual(A.required(rules({ quote: { enabled: false } }), 'quote', q('UGX', 9e9)), [], 'switched off');
  assert.deepEqual(A.required(rules({ quote: { discountPct: 0 } }), 'quote', q('USD', 100, 1000, 100)), [], 'discount check off');
});

test('purchase orders: every order needs a first approval; a large one also a second, from other roles', () => {
  const small = A.required(rules(), 'lpo', { currency: 'USD', total: 500 });
  assert.equal(small.length, 1); assert.deepEqual(small[0].roles, ['finance', 'dept_head']);
  const big = A.required(rules(), 'lpo', { currency: 'USD', total: 13000 });
  assert.deepEqual(big.map((n) => n.level), [1, 2]); assert.deepEqual(big[1].roles, ['management']);
  assert.equal(A.required(rules(), 'lpo', { currency: 'EUR', total: 1 }).length, 2, 'a currency without a second-approval limit needs both');
  assert.equal(A.required(rules({ lpo: { l2Limits: {} } }), 'lpo', { currency: 'USD', total: 9e9 }).length, 1, 'no second approval when its limits are empty');
  assert.deepEqual(A.required(rules({ lpo: { enabled: false } }), 'lpo', { currency: 'USD', total: 9e9 }), []);
});

test('who may decide: the roles named, or a platform administrator; never a customer', () => {
  assert.ok(A.canDecide({ kind: 'staff', role: 'finance' }, ['finance']));
  assert.ok(A.canDecide({ kind: 'staff', role: 'platform_admin' }, ['finance']));
  assert.ok(!A.canDecide({ kind: 'staff', role: 'bd_manager' }, ['finance']));
  assert.ok(!A.canDecide({ kind: 'customer', role: 'finance' }, ['finance']));
});

test('the defaults are the documented ones', () => {
  assert.deepEqual(A.DEFAULTS.approvals_quote_limits, { UGX: 20000000, USD: 5000 });
  assert.equal(A.DEFAULTS.approvals_quote_discount_pct, 10);
  assert.deepEqual(A.DEFAULTS.approvals_lpo_l2_limits, { UGX: 50000000, USD: 13000 });
  assert.deepEqual(A.DEFAULTS.approvals_lpo_l2_roles, ['management']);
});
