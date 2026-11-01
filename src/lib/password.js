'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const scrypt = promisify(crypto.scrypt);

const N = 32768; const R = 8; const P = 1; const KEYLEN = 64;
const OPTS = { N, r: R, p: P, maxmem: 128 * 1024 * 1024 };

async function hash(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEYLEN, OPTS);
  return ['scrypt', N, R, P, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verify(password, stored) {
  try {
    const [alg, n, r, p, salt, key] = String(stored || '').split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(key, 'base64');
    const actual = await scrypt(password, Buffer.from(salt, 'base64'), expected.length,
      { N: +n, r: +r, p: +p, maxmem: 128 * 1024 * 1024 });
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch (_) {
    return false;
  }
}

// Verifying against this when the user does not exist keeps response time similar.
let dummy;
async function dummyVerify(password) {
  if (!dummy) dummy = await hash('not-a-real-password-' + crypto.randomBytes(8).toString('hex'));
  await verify(password, dummy);
}

const COMMON = new Set(['password1234', 'passwordpassword', 'welcome12345', 'changeme1234', 'qwertyuiop12', '123456789012', 'letmein12345']);

/** Returns an error message, or null when the password is acceptable (IAM-003 password policy). */
function policyError(password, context = {}) {
  if (typeof password !== 'string' || password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 200) return 'Use at most 200 characters.';
  if (/^(.)\1+$/.test(password)) return 'Do not repeat a single character.';
  if (COMMON.has(password.toLowerCase())) return 'That password is too common.';
  const local = String(context.email || '').split('@')[0].toLowerCase();
  if (local.length >= 4 && password.toLowerCase().includes(local)) return 'Do not include your email name in the password.';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(password)).length;
  if (classes < 3) return 'Mix at least three of: lower case, upper case, digits, symbols.';
  return null;
}

function randomPassword() {
  return crypto.randomBytes(15).toString('base64').replace(/[+/=]/g, 'x') + 'A1';
}

module.exports = { hash, verify, dummyVerify, policyError, randomPassword };
