'use strict';
// Shared pieces of the mailbox providers (IMAP, Microsoft 365 Graph, Gmail).
const FIRST_RUN_DAYS = 2;      // when a mailbox is first connected, only unread mail from the last two days becomes tickets
const BATCH = 50;              // messages handled per check
const FIRST_RUN_MAX = 100;

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** One HTTPS request with a timeout; throws HttpError (status + short provider message) for any non-2xx answer. */
async function request(fetchFn, url, { method = 'GET', headers = {}, body, as = 'json' } = {}) {
  let res;
  try {
    res = await fetchFn(url, { method, headers, body, signal: AbortSignal.timeout(30000) });
  } catch (err) {
    throw new HttpError(0, `Could not reach ${new URL(url).host}: ${err.cause && err.cause.code ? err.cause.code : err.message}`);
  }
  if (!res.ok) {
    let detail = '';
    try {
      const j = await res.json();
      detail = (j.error && (j.error.message || j.error.code || (typeof j.error === 'string' ? j.error : ''))) || j.error_description || '';
      if (j.error_description && j.error && typeof j.error === 'string') detail = `${j.error}: ${j.error_description}`;
    } catch (_) { /* not JSON */ }
    throw new HttpError(res.status, `${new URL(url).host} answered ${res.status}${detail ? `: ${String(detail).replace(/\s+/g, ' ').slice(0, 240)}` : ''}`);
  }
  if (as === 'none') return null;
  if (as === 'buffer') return Buffer.from(await res.arrayBuffer());
  return res.json();
}

function form(obj) { return Object.entries(obj).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&'); }
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function fromB64url(s) { return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64'); }

module.exports = { FIRST_RUN_DAYS, BATCH, FIRST_RUN_MAX, HttpError, request, form, b64url, fromB64url };
