'use strict';
// Asset register: how the form, dates, categories and spreadsheets are read, and how warranty dates are judged.
const test = require('node:test');
const assert = require('node:assert/strict');
const A = require('../../src/services/assets');

test('the form is cleaned and checked; mistakes are explained in words', () => {
  const ok = A.read({ name: ' Core switch ', category: 'network', quantity: '1', ip_address: ' 10.1.0.2 ', warranty_until: '31/12/2027', purchase_date: '2024-03-15' });
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.values.name, 'Core switch'); assert.equal(ok.values.ip_address, '10.1.0.2'); assert.equal(ok.values.warranty_until, '2027-12-31'); assert.equal(ok.values.status, 'active');
  const bad = A.read({ name: '', category: 'spaceship', ip_address: '999.1.1.1', quantity: '0', warranty_until: '2027-02-30', purchase_date: '' });
  assert.equal(bad.errors.length, 5);
  assert.match(bad.errors.join(' '), /Give it a name/); assert.match(bad.errors.join(' '), /"spaceship" is not one/); assert.match(bad.errors.join(' '), /999\.1\.1\.1/);
  assert.match(bad.errors.join(' '), /Quantity/); assert.match(bad.errors.join(' '), /2027-02-30.*is not a date/);
  assert.match(A.read({ name: 'x', category: 'server', purchase_date: '2025-01-10', warranty_until: '2024-01-10' }).errors[0], /cannot end before the purchase/);
  assert.deepEqual(A.read({ name: 'x', category: 'server', ip_address: 'fe80::1' }).errors, [], 'IPv6 is fine');
});

test('categories: the keys, the labels and the words people use', () => {
  for (const [w, k] of [['network', 'network'], ['Switch', 'network'], ['Access Point', 'network'], ['FIREWALL', 'security'], ['laptop', 'end_user'], ['UPS', 'power'], ['License', 'software'], ['Licence', 'software'], ['SaaS', 'cloud'], ['Server', 'server']]) {
    assert.equal(A.readCategory(w), k, w);
  }
  assert.equal(A.readCategory('Laptop or desktop'), 'end_user');
  assert.equal(A.readCategory('banana'), null);
});

test('dates: ISO and day/month/year; impossible dates are refused', () => {
  assert.equal(A.readDate('2026-12-31'), '2026-12-31'); assert.equal(A.readDate('1/2/2026'), '2026-02-01'); assert.equal(A.readDate('31.12.2026'), '2026-12-31');
  assert.equal(A.readDate(''), null); assert.equal(A.readDate(undefined), null);
  assert.equal(A.readDate('31/02/2026'), undefined); assert.equal(A.readDate('next week'), undefined);
});

test('warranty and expiry: ended, within 90 days, or fine', () => {
  assert.deepStrictEqual({ ...A.dateState('2026-11-19', '2026-11-20') }, { state: 'expired', days: -1, date: '2026-11-19' });
  assert.equal(A.dateState('2026-11-20', '2026-11-20').state, 'soon', 'ends today');
  assert.equal(A.dateState('2027-02-18', '2026-11-20').state, 'soon', '90 days');
  assert.equal(A.dateState('2027-02-19', '2026-11-20').state, 'ok', '91 days');
  assert.equal(A.dateState(null, '2026-11-20').state, 'none');
  assert.equal(A.dateState('2026-12-15', '2026-11-20', 30).state, 'soon', '25 days: inside the 30-day window of the bell');
  assert.equal(A.dateState('2027-01-05', '2026-11-20', 30).state, 'ok', '46 days: outside it');
});

test('CSV: quotes, commas inside quotes, doubled quotes, semicolons, a byte-order mark and blank lines', () => {
  assert.deepEqual(A.parseCsv('﻿name,notes\r\n"Switch, rack 2","He said ""ok"""\r\n\r\nUPS,\n'), [['name', 'notes'], ['Switch, rack 2', 'He said "ok"'], ['UPS', '']]);
  assert.deepEqual(A.parseCsv('name;category\nCore;network'), [['name', 'category'], ['Core', 'network']], 'Excel in some regions saves with semicolons');
  assert.deepEqual(A.parseCsv('a,b\n"line one\nline two",x'), [['a', 'b'], ['line one\nline two', 'x']], 'a line break inside quotes stays in the field');
  const t = A.parseCsv(A.TEMPLATE);
  assert.equal(t.length, 3); assert.equal(t[0][0], 'name'); assert.ok(t[0].includes('warranty_until'));
});
