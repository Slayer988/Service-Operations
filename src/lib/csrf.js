'use strict';
const crypto = require('crypto');

function token(req) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('base64url');
  return req.session.csrf;
}

/** Reject any state-changing request without the session's CSRF token (NFR-002). */
function protect(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const supplied = (req.body && req.body._csrf) || req.get('x-csrf-token') || '';
  const expected = req.session && req.session.csrf;
  const a = Buffer.from(String(supplied)); const b = Buffer.from(String(expected || ''));
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(403).render('error', { title: 'Request rejected', message: 'The form has expired or is invalid. Go back, reload the page and try again.' });
  }
  return next();
}

module.exports = { token, protect };
