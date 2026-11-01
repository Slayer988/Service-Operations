'use strict';
// Encrypts a small secret (the Active Directory service-account password) before it is stored in the database, so a copy of the
// database alone does not reveal it. AES-256-GCM; the key is derived from SESSION_SECRET, which lives only in /etc/itsm/itsm.env.
// If SESSION_SECRET is ever changed, stored secrets cannot be read any more and must be entered again.
const crypto = require('crypto');
const config = require('../config');

const PREFIX = 'v1:';
let cached = null;
function key() {
  if (!config.sessionSecret) throw new Error('SESSION_SECRET is not set.');
  if (!cached || cached.from !== config.sessionSecret) cached = { from: config.sessionSecret, key: crypto.scryptSync(config.sessionSecret, 'itsm-stored-secret', 32) };
  return cached.key;
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const body = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return PREFIX + Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

/** The original text, or null if the value is missing, damaged, or was encrypted with another SESSION_SECRET. */
function decrypt(stored) {
  if (typeof stored !== 'string' || !stored.startsWith(PREFIX)) return null;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64');
    if (raw.length < 29) return null;
    const d = crypto.createDecipheriv('aes-256-gcm', key(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(12, 28));
    return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
  } catch (_) { return null; }
}

module.exports = { encrypt, decrypt };
