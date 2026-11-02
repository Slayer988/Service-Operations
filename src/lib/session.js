'use strict';
// Session helpers that do not need the database, so they can be tested on their own.

/** Minutes a session may stay idle before it ends: SESSION_IDLE_MINUTES, default 10, never less than 1 or more than 480. */
function idleMinutes(raw, fallback = 10) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(480, Math.max(1, n));
}

// A small cookie that says "this browser was signed in". When it is present but the session is gone, the session ended
// (idle for too long, or closed by an administrator), and the sign-in page can say so.
const MARKER = 'itsm.in';
const hasMarker = (cookieHeader) => /(?:^|;\s*)itsm\.in=1(?:;|$)/.test(String(cookieHeader || ''));

// The "you were signed out" notice is shown once per time-out: this cookie says it has been shown, so a refresh, a bookmark or an address-bar
// suggestion that still carries ?expired=1 does not bring it back. It is removed at the next sign-in, so a later time-out shows it again.
const SHOWN = 'itsm.exp';
const hasShown = (cookieHeader) => /(?:^|;\s*)itsm\.exp=1(?:;|$)/.test(String(cookieHeader || ''));

/** Where to send someone who is not signed in: the sign-in page, remembering where they were going. */
function loginUrl(originalUrl, ended) {
  return `/login?${ended ? 'expired=1&' : ''}next=${encodeURIComponent(originalUrl || '/')}`;
}

/** Signs a person out everywhere except (optionally) the browser they are using now. */
async function endOtherSessions(db, userId, keepSid = '') {
  await db.query(`delete from session where sess::jsonb ->> 'uid' = $1 and sid <> $2`, [String(userId), String(keepSid || '')]);
}

module.exports = { idleMinutes, MARKER, hasMarker, SHOWN, hasShown, loginUrl, endOtherSessions };
