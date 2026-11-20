'use strict';
const express = require('express');
const { q } = require('../db');
const config = require('../config');
const sessionLib = require('../lib/session');
const password = require('../lib/password');
const totp = require('../lib/totp');
const twofactor = require('../lib/twofactor');
const audit = require('../lib/audit');
const settings = require('../lib/settings');
const u = require('../lib/util');
const themes = require('../lib/themes');
const { wrap } = require('./util');
const ldap = require('../lib/ldap');
const directory = require('../services/directory');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

function home(user) { return user.kind === 'customer' ? '/portal' : '/'; }

function regenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((err) => (err ? reject(err) : resolve())));
}

async function completeLogin(req, res, user, ip) {
  await regenerate(req);
  res.clearCookie(sessionLib.SHOWN);                                                            // the next time-out may say so again
  req.session.uid = user.id;
  await q('update users set last_login_at = now(), failed_logins = 0, locked_until = null where id = $1', [user.id]);
  await audit({ query: q }, user, 'login', 'user', user.id, 'signed in', user.customer_id, ip);
}

// the login page offers "raise a request without signing in" when that is switched on
router.use('/login', wrap(async (req, res, next) => {
  try { res.locals.guestEnabled = (await settings.get({ query: q }, 'guest_requests_enabled', true)) !== false; } catch (_) { res.locals.guestEnabled = false; }
  try { const n = await settings.get({ query: q }, 'login_notice', ''); res.locals.loginNotice = typeof n === 'string' ? n.trim() : ''; } catch (_) { res.locals.loginNotice = ''; }
  next();
}));

router.get('/login', (req, res) => {
  if (req.user) return res.redirect(home(req.user));
  res.clearCookie(sessionLib.MARKER);                                                           // the "was signed in" note has been used
  const next = u.safeNext(req.query.next, '');
  let expired = req.query.expired === '1';
  if (expired) {
    // shown once: coming back to the same address (refresh, bookmark, address-bar suggestion) gives the plain sign-in page
    if (sessionLib.hasShown(req.headers.cookie)) return res.redirect(next ? `/login?next=${encodeURIComponent(next)}` : '/login');
    res.cookie(sessionLib.SHOWN, '1', { maxAge: 10 * 60 * 1000, sameSite: 'lax', secure: config.secureCookies, httpOnly: true, path: '/' });
    expired = true;
  }
  return res.render('auth/login', { title: 'Sign in', next, error: req.query.locked === '1' ? LOCKED : null, expired, idleMinutes: config.sessionIdleMinutes });
});

// ---- idle sign-out. The page pings while the person is working (any request keeps the session alive) and goes to /session/expired
// when nothing has happened for the idle time; the server ends an unused session on its own as well.
router.get('/session/ping', (req, res) => {
  res.set('Cache-Control', 'no-store');
  return res.status(req.user ? 204 : 401).end();
});
router.get('/session/expired', (req, res) => {
  if (req.get('sec-fetch-site') === 'cross-site') return res.redirect(req.user ? home(req.user) : '/login');   // another site cannot sign people out
  const finish = () => { res.clearCookie('itsm.sid'); res.clearCookie(sessionLib.MARKER); res.redirect('/login?expired=1'); };
  if (!req.session) return finish();
  return req.session.destroy(finish);
});

/** Counts a failed attempt (wrong password or wrong two-step code: both lead to the same lock). Returns true when the account was just locked. */
async function recordFailure(req, row, why, action = 'login_failed') {
  const attempts = row.failed_logins + 1;
  const lock = attempts >= config.lockoutAttempts;
  await q(`update users set failed_logins = $2, locked_until = case when $3 then now() + ($4 || ' minutes')::interval else locked_until end where id = $1`,
    [row.id, lock ? 0 : attempts, lock, String(config.lockoutMinutes)]);
  await audit({ query: q }, row, lock ? 'account_locked' : action, 'user', row.id, why, row.customer_id, req.ip);
  return lock;
}

/** Accepts a two-step code only once: the 30-second step it belongs to must be newer than the last one used. */
async function claimStep(userId, step) {
  return (await q('update users set totp_last_step = $2 where id = $1 and (totp_last_step is null or totp_last_step < $2) returning id', [userId, step])).rows.length === 1;
}

/** After the password (local or directory) is accepted: second step if enrolled, otherwise sign in. */
async function finishLogin(req, res, row, next) {
  if (row.totp_enabled) {
    await regenerate(req);
    req.session.mfaUser = row.id; req.session.mfaTries = 0; req.session.mfaNext = next;
    return res.redirect('/login/mfa');
  }
  await completeLogin(req, res, row, req.ip);
  return res.redirect(next || home(row));
}

const LOCKED = 'This account is temporarily locked after too many failed attempts. Try again later.';

/** Active Directory sign-in (staff who were imported). The directory decides the password; the role is the one set on the Users page. */
async function directoryLogin(req, res, { cfg, ident, pw, next, row, fail }) {
  if (row && row.locked_until && new Date(row.locked_until) > new Date()) {
    await audit({ query: q }, row, 'login_blocked', 'user', row.id, 'account locked', row.customer_id, req.ip);
    return fail(LOCKED);
  }
  let result;
  try { result = await ldap.authenticate(cfg, directory.bindPassword(cfg), ident, pw); } catch (err) {
    console.error('[directory] sign-in failed:', ldap.scrub(err, directory.bindPassword(cfg), pw));
    await audit({ query: q }, null, 'login_failed', 'user', ident, 'directory unavailable', null, req.ip);
    return fail('The directory server could not be reached. Try again, or ask an administrator.');
  }
  if (!result.ok) {
    if (row) await recordFailure(req, row, `directory: ${result.reason}`);
    else await audit({ query: q }, null, 'login_failed', 'user', ident, `directory: ${result.reason}`, null, req.ip);
    return fail(result.reason === 'no_email' ? 'Your directory account has no e-mail address, so it cannot be used here.' : undefined);
  }
  const out = await directory.signIn({ query: q }, result);
  if (out.denied) {
    await audit({ query: q }, out.row || null, 'login_denied', 'user', ident, `directory: ${out.denied}`, null, req.ip);
    return fail(out.denied === 'not_imported' ? 'Your account has not been set up here yet. Ask an administrator to import it.' : undefined);
  }
  return finishLogin(req, res, out.user, next);
}

router.post('/login', wrap(async (req, res) => {
  const ident = u.str(req.body.email, 254).toLowerCase();   // an e-mail address, or an AD user name when the directory is enabled
  const pw = String(req.body.password || '');
  const next = u.safeNext(req.body.next, '');
  const fail = (msg = 'The user name or password is not correct.') => res.status(401).render('auth/login', { title: 'Sign in', next, error: msg });
  // with a sign-in notice, the box must be ticked (checked here too, not only in the browser); nothing else is looked at before that
  if (res.locals.loginNotice && req.body.agree !== 'on') return res.status(400).render('auth/login', { title: 'Sign in', next, error: 'Tick the box to accept the notice before signing in.' });

  const row = ident ? (await q(
    `select u.*, c.status as customer_status from users u left join customers c on c.id = u.customer_id where lower(u.email) = $1`, [ident])).rows[0] : null;

  // Local accounts (including customers and the break-glass administrator) never go to the directory.
  if (!row || row.auth_source === 'ldap') {
    const cfg = await directory.loadConfig({ query: q });
    if (cfg.enabled && ident) return directoryLogin(req, res, { cfg, ident, pw, next, row, fail });
  }
  if (!row || row.auth_source === 'ldap') { await password.dummyVerify(pw); await audit({ query: q }, null, 'login_failed', 'user', ident, 'unknown account', null, req.ip); return fail(); }
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    await audit({ query: q }, row, 'login_blocked', 'user', row.id, 'account locked', row.customer_id, req.ip);
    return fail(LOCKED);
  }
  const ok = row.active && row.password_hash && await password.verify(pw, row.password_hash);
  if (!ok) { await recordFailure(req, row, 'wrong password'); return fail(); }
  if (row.customer_status === 'suspended') return fail('Your organisation is suspended. Please contact your service provider.');
  return finishLogin(req, res, row, next);
}));

router.get('/login/mfa', (req, res) => {
  if (!req.session.mfaUser) return res.redirect('/login');
  return res.render('auth/mfa', { title: 'Verification code', error: null });
});

router.post('/login/mfa', wrap(async (req, res) => {
  const id = req.session.mfaUser;
  if (!id) return res.redirect('/login');
  const row = (await q('select * from users where id = $1 and active', [id])).rows[0];
  if (!row || (req.session.mfaTries || 0) >= 5) { req.session.destroy(() => res.redirect('/login')); return; }
  if (row.locked_until && new Date(row.locked_until) > new Date()) {
    await audit({ query: q }, row, 'login_blocked', 'user', row.id, 'account locked', row.customer_id, req.ip);
    return req.session.destroy(() => res.redirect('/login?locked=1'));
  }
  const step = totp.matchStep(twofactor.reveal(row.totp_secret), req.body.code);
  if (step === null || !(await claimStep(row.id, step))) {
    req.session.mfaTries = (req.session.mfaTries || 0) + 1;
    // wrong codes count towards the same lock as wrong passwords, so starting a new sign-in does not give five fresh guesses
    const locked = await recordFailure(req, row, step === null ? 'wrong code' : 'code already used', 'mfa_failed');
    if (locked) return req.session.destroy(() => res.redirect('/login?locked=1'));
    return res.status(401).render('auth/mfa', { title: 'Verification code', error: step === null ? 'That code is not correct.' : 'That code was already used. Wait for the next one.' });
  }
  if (row.totp_secret && !twofactor.isEncrypted(row.totp_secret)) await q('update users set totp_secret = $2 where id = $1', [row.id, twofactor.protect(row.totp_secret)]);   // upgrade an older plain secret
  const next = req.session.mfaNext || '';
  await completeLogin(req, res, row, req.ip);
  return res.redirect(next || home(row));
}));

router.post('/logout', (req, res) => {
  const finish = () => { res.clearCookie('itsm.sid'); res.clearCookie(sessionLib.MARKER); res.redirect('/login'); };
  if (!req.session) return finish();
  return req.session.destroy(finish);
});

// ---- account: password and MFA
router.get('/account', requireLogin, (req, res) => res.render('auth/account', { title: 'My account' }));

// ---- appearance: the theme switch next to the notification bell posts here (one of the five themes; remembered for the person and in this browser)
router.post('/account/theme', requireLogin, wrap(async (req, res) => {
  const chosen = themes.valid(String(req.body.theme || ''));
  if (!chosen) { req.flash('error', 'Choose one of the listed themes.'); return res.redirect(themes.safeBack(req.body.back)); }
  await q('update users set theme = $2 where id = $1', [req.user.id, chosen]);
  res.cookie('itsm.theme', chosen, { maxAge: 365 * 86400 * 1000, sameSite: 'lax', secure: config.secureCookies, httpOnly: false, path: '/' });
  return res.redirect(themes.safeBack(req.body.back));
}));

router.post('/account/password', requireLogin, wrap(async (req, res) => {
  if (req.user.auth_source === 'ldap') { req.flash('error', 'Your password is managed in Active Directory.'); return res.redirect('/account'); }
  const { current, next1, next2 } = { current: String(req.body.current || ''), next1: String(req.body.next1 || ''), next2: String(req.body.next2 || '') };
  if (!(await password.verify(current, req.user.password_hash))) { req.flash('error', 'Your current password is not correct.'); return res.redirect('/account'); }
  if (next1 !== next2) { req.flash('error', 'The new passwords do not match.'); return res.redirect('/account'); }
  const problem = password.policyError(next1, { email: req.user.email });
  if (problem) { req.flash('error', problem); return res.redirect('/account'); }
  if (next1 === current) { req.flash('error', 'Choose a password that is different from the current one.'); return res.redirect('/account'); }
  await q('update users set password_hash = $2, password_changed_at = now(), must_change_password = false where id = $1', [req.user.id, await password.hash(next1)]);
  await sessionLib.endOtherSessions({ query: q }, req.user.id, req.sessionID);                 // a changed password signs out every other browser
  await audit({ query: q }, req.user, 'password_changed', 'user', req.user.id, '', req.user.customer_id, req.ip);
  req.flash('success', 'Password changed. Any other place you were signed in has been signed out.');
  return res.redirect(req.user.must_change_password ? home(req.user) : '/account');
}));

router.get('/account/mfa', requireLogin, (req, res) => {
  let secret = null; let uri = null;
  if (!req.user.totp_enabled) {
    if (!req.session.pendingTotp) req.session.pendingTotp = totp.newSecret();
    secret = req.session.pendingTotp;
    uri = totp.otpauthUri(secret, req.user.email);
  }
  return res.render('auth/mfa_setup', { title: 'Two-step verification', secret, uri, enabled: req.user.totp_enabled });
});

router.post('/account/mfa/enable', requireLogin, wrap(async (req, res) => {
  const secret = req.session.pendingTotp;
  const step = secret ? totp.matchStep(secret, req.body.code) : null;
  if (step === null) { req.flash('error', 'That code is not correct. Check the time on your phone and try again.'); return res.redirect('/account/mfa'); }
  await q('update users set totp_secret = $2, totp_enabled = true, totp_last_step = $3 where id = $1', [req.user.id, twofactor.protect(secret), step]);
  req.session.pendingTotp = null;
  await audit({ query: q }, req.user, 'mfa_enabled', 'user', req.user.id, '', req.user.customer_id, req.ip);
  req.flash('success', 'Two-step verification is on.');
  return res.redirect('/account');
}));

router.post('/account/mfa/disable', requireLogin, wrap(async (req, res) => {
  const required = (await settings.get({ query: q }, 'mfa_required_roles', [])) || [];
  if (required.includes(req.user.role)) { req.flash('error', 'Your role requires two-step verification, so it cannot be turned off.'); return res.redirect('/account'); }
  const passwordOk = req.user.auth_source === 'ldap' || await password.verify(String(req.body.current || ''), req.user.password_hash);
  const step = totp.matchStep(twofactor.reveal(req.user.totp_secret), req.body.code);
  if (!passwordOk || step === null || !(await claimStep(req.user.id, step))) {
    req.flash('error', 'Password or code not correct.'); return res.redirect('/account/mfa');
  }
  await q('update users set totp_secret = null, totp_enabled = false, totp_last_step = null where id = $1', [req.user.id]);
  await audit({ query: q }, req.user, 'mfa_disabled', 'user', req.user.id, '', req.user.customer_id, req.ip);
  req.flash('success', 'Two-step verification is off.');
  return res.redirect('/account');
}));

module.exports = router;
