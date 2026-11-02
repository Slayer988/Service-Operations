'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const demo = require('../../src/services/demo');

test('demo data: every demo person and customer can be recognised for removal', () => {
  assert.ok(demo.DEMO_DOMAIN === 'demo.invalid' && demo.TAG === '[DEMO]');
  assert.ok(demo.CUSTOMERS.every((c) => /^DEMO/.test(c.code) && /\(Demo\)$/.test(c.name)), 'every demo customer code starts with DEMO');
  const keys = [...demo.STAFF.map((s) => s[0]), ...demo.CUSTOMERS.flatMap((c) => c.users.map((u) => u[0]))];
  assert.equal(new Set(keys).size, keys.length, 'no two demo people share an address');
  assert.ok(demo.CUSTOMERS.every((c) => c.users.some((u) => u[2] === 'customer_admin') && c.users.some((u) => u[2] === 'customer_user')));
  assert.ok(demo.STAFF.length >= 10);
});

test('demo data: isEmpty tells an empty status from a loaded one', () => {
  assert.equal(demo.isEmpty({ customers: 0, users: 0, tickets: 0 }), true);
  assert.equal(demo.isEmpty({ customers: 0, users: 1, tickets: 0 }), false);
});

test('demo data: the removal script and the loader are wired, and the old seed script now loads the same data', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const cli = fs.readFileSync(path.join(__dirname, '../../scripts/demo-data.js'), 'utf8');
  for (const w of ['load', 'remove', 'status']) assert.ok(cli.includes(`'${w}'`), w);
  assert.match(fs.readFileSync(path.join(__dirname, '../../scripts/seed-demo.js'), 'utf8'), /demo-data/);
});
