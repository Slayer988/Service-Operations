'use strict';
// Google Workspace / Gmail through the Gmail API with a service account that has domain-wide delegation, impersonating the
// shared mailbox (a user or delegated mailbox). Scope: gmail.readonly (gmail.modify only if "mark processed mail as read" is on).
// The environment variable named in "secret" holds the PATH of the service-account JSON key file (for example /etc/itsm/google-sa.json).
const fs = require('fs');
const crypto = require('crypto');
const { FIRST_RUN_MAX, BATCH, request, form, b64url, fromB64url } = require('./common');

const TOKEN_URL = 'https://oauth2.googleapis.com/token';   // fixed: never taken from the key file
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const tokens = new Map();
const recent = new Map();   // mailbox id -> Set of Gmail ids handled lately (cheap duplicate skip at the time boundary)

function readKey(mb, env) {
  const file = env[mb.secret_env];
  const k = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!k.client_email || !k.private_key) throw new Error('The key file is not a Google service-account key (client_email / private_key missing).');
  return k;
}

/** Signed assertion for the service account (RS256 JWT bearer grant). Exposed for tests. */
function assertion(key, subject, scope, nowSec = Math.floor(Date.now() / 1000)) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify({ iss: key.client_email, sub: subject, scope, aud: TOKEN_URL, iat: nowSec, exp: nowSec + 3600 }));
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${body}`).sign(key.private_key);
  return `${head}.${body}.${b64url(sig)}`;
}

async function accessToken(mb, ctx) {
  const scope = mb.mark_seen ? 'https://www.googleapis.com/auth/gmail.modify' : 'https://www.googleapis.com/auth/gmail.readonly';
  const ck = `${mb.address}|${scope}`;
  const hit = tokens.get(mb.id);
  if (hit && hit.exp > Date.now() + 60000 && hit.key === ck) return hit.token;
  const j = await request(ctx.fetch, TOKEN_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: assertion(readKey(mb, ctx.env), mb.address, scope) }),
  });
  if (!j.access_token) throw new Error('Google did not return an access token.');
  tokens.set(mb.id, { token: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000, key: ck });
  return j.access_token;
}

const HINTS = {
  400: 'Check that domain-wide delegation is enabled for this service account and the gmail.readonly scope is authorised in the Admin console.',
  401: 'Google rejected the credentials.',
  403: 'Access denied: enable the Gmail API in the Google Cloud project and authorise the scope for this service account.',
};
function hint(err) { return err.status && HINTS[err.status] ? `${err.message} — ${HINTS[err.status]}` : err.message; }

module.exports = {
  label: 'Google Workspace (Gmail API)',
  assertion,
  configError(mb, env) {
    if (!mb.address) return 'The mailbox address (the user to read) must be set.';
    if (!mb.secret_env || !env[mb.secret_env]) return `The key-file variable ${mb.secret_env || '(none named)'} is not set in the server environment file.`;
    if (!fs.existsSync(env[mb.secret_env])) return `The service-account key file ${env[mb.secret_env]} does not exist.`;
    return '';
  },
  secrets() { return []; },

  async poll(mb, ctx) {
    const first = !mb.last_received_at;
    let ids = []; let auth;
    try {
      auth = { Authorization: `Bearer ${await accessToken(mb, ctx)}` };
      const q = first ? 'is:unread newer_than:2d' : `after:${Math.floor(new Date(mb.last_received_at).getTime() / 1000) - 60}`;
      let pageToken = '';
      for (let page = 0; page < 5; page++) {
        const j = await request(ctx.fetch, `${API}/messages?labelIds=INBOX&maxResults=100&q=${encodeURIComponent(q)}${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`, { headers: auth });
        ids = ids.concat((j.messages || []).map((m) => m.id));
        pageToken = j.nextPageToken || '';
        if (!pageToken) break;
      }
    } catch (err) { err.message = hint(err); throw err; }

    ids.reverse();   // Gmail lists newest first; handle the oldest first so the time marker only moves forward
    const done = recent.get(mb.id) || new Set();
    ids = ids.filter((id) => !done.has(id)).slice(0, first ? FIRST_RUN_MAX : BATCH);
    let count = 0; let newest = null;
    for (const id of ids) {
      const m = await request(ctx.fetch, `${API}/messages/${encodeURIComponent(id)}?format=raw`, { headers: auth });
      await ctx.ingestSafe(mb, fromB64url(m.raw), { ref: id });
      if (mb.mark_seen) {
        await request(ctx.fetch, `${API}/messages/${encodeURIComponent(id)}/modify`, {
          method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ removeLabelIds: ['UNREAD'] }), as: 'none',
        }).catch((e) => console.error(`[mail] ${mb.key}: could not mark as read: ${e.message}`));
      }
      done.add(id); count++;
      newest = new Date(Number(m.internalDate) || Date.now());
      await ctx.pool.query(`update mailboxes set last_received_at = greatest(coalesce(last_received_at, '-infinity'), $2) where id = $1`, [mb.id, newest]);
    }
    if (done.size > 500) for (const id of [...done].slice(0, done.size - 300)) done.delete(id);
    recent.set(mb.id, done);
    if (first && !newest) await ctx.pool.query('update mailboxes set last_received_at = $2 where id = $1 and last_received_at is null', [mb.id, new Date(Date.now() - 5 * 60000)]);
    return count;
  },

  async test(mb, ctx) {
    try {
      const auth = { Authorization: `Bearer ${await accessToken(mb, ctx)}` };
      const j = await request(ctx.fetch, `${API}/profile`, { headers: auth });
      return { ok: true, message: `Connected to Gmail as ${j.emailAddress}: ${j.messagesTotal} message(s) in the mailbox.` };
    } catch (err) { err.message = hint(err); throw err; }
  },
};
