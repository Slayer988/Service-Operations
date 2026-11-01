'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../../src/lib/totp');
const password = require('../../src/lib/password');
const priority = require('../../src/lib/priority');
const u = require('../../src/lib/util');

test('TOTP matches the RFC 6238 SHA-1 test vector', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.code(secret, 59000), '287082');
  assert.equal(totp.code(secret, 1111111109000), '081804');
  assert.ok(totp.verify(secret, '287082', 59000));
  assert.ok(!totp.verify(secret, '000000', 59000));
  assert.ok(!totp.verify(secret, 'abcdef', 59000));
});

test('base32 round trip', () => {
  const b = Buffer.from('hello world');
  assert.equal(totp.base32Decode(totp.base32Encode(b)).toString(), 'hello world');
});

test('password hash and verify', async () => {
  const h = await password.hash('Correct-horse-9!');
  assert.ok(h.startsWith('scrypt$'));
  assert.ok(await password.verify('Correct-horse-9!', h));
  assert.ok(!(await password.verify('wrong', h)));
  assert.ok(!(await password.verify('x', 'garbage')));
});

test('password policy', () => {
  assert.ok(password.policyError('short'));
  assert.ok(password.policyError('aaaaaaaaaaaaaaaa'));
  assert.ok(password.policyError('alllowercaseonly'));
  assert.ok(password.policyError('Contains-kabenge-9', { email: 'kabenge@labs.local' }));
  assert.equal(password.policyError('Correct-horse-9!'), null);
  assert.equal(password.policyError(password.randomPassword()), null);
});

test('priority matrix', () => {
  assert.equal(priority.compute(null, 1, 1), 1);
  assert.equal(priority.compute(null, 3, 3), 4);
  assert.equal(priority.compute(null, 2, 1), 2);
  assert.equal(priority.compute({ 1: { 1: 4 } }, 1, 1), 4);
  assert.equal(priority.compute(null, 9, 9), 3);
});

test('input helpers', () => {
  assert.equal(u.id('42'), 42);
  assert.equal(u.id('0'), null);
  assert.equal(u.id('4 2'), null);
  assert.equal(u.id("1; drop table x"), null);
  assert.equal(u.intIn('3', 1, 3), 3);
  assert.equal(u.intIn('4', 1, 3), null);
  assert.equal(u.dateStr('2026-02-30'), null);
  assert.equal(u.dateStr('2026-02-28'), '2026-02-28');
  assert.equal(u.email('A@B.com'), 'a@b.com');
  assert.equal(u.email('not an email'), null);
  assert.equal(u.safeNext('//evil.com'), '/');
  assert.equal(u.safeNext('https://evil.com'), '/');
  assert.equal(u.safeNext('/tickets?x=1'), '/tickets?x=1');
  assert.equal(u.safeNext('/\\evil'), '/');
});

test('CSV escapes quotes and neutralises formulas', () => {
  const out = u.toCsv([{ a: '=SUM(1)', b: 'he said "hi"' }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }]);
  assert.equal(out, "A,B\r\n'=SUM(1),\"he said \"\"hi\"\"\"\r\n");
});
