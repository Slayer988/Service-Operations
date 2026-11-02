'use strict';
// The secret behind a person's authenticator app is stored encrypted (lib/secrets.js), like every other secret the application keeps.
// Secrets saved by an earlier version are plain base32 text; they are read as they are and encrypted the next time they are touched
// (services/maintenance.js does it for all of them when the worker starts).
const secrets = require('./secrets');

const isEncrypted = (stored) => typeof stored === 'string' && stored.startsWith('v1:');

/** The text to store for a secret. */
const protect = (secret) => secrets.encrypt(secret);

/** The usable secret, or null when there is none or it cannot be decrypted (SESSION_SECRET was changed: an administrator resets it). */
function reveal(stored) {
  if (!stored) return null;
  return isEncrypted(stored) ? secrets.decrypt(stored) : stored;
}

module.exports = { isEncrypted, protect, reveal };
