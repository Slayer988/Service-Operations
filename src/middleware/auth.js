'use strict';
const { q } = require('../db');
const perms = require('../lib/perms');
const settings = require('../lib/settings');

let mfaCache = { at: 0, roles: ['platform_admin'] };
async function mfaRoles() {
  if (Date.now() - mfaCache.at > 30000) {
    mfaCache = { at: Date.now(), roles: (await settings.get({ query: q }, 'mfa_required_roles', ['platform_admin'])) || [] };
  }
  return mfaCache.roles;
}

/** Load the signed-in user on every request, so disabling an account or customer takes effect at once (IAM-004, CUS-005). */
async function loadUser(req, res, next) {
  try {
    req.user = null;
    const uid = req.session && req.session.uid;
    if (uid) {
      const r = await q(
        `select u.*, c.status as customer_status, c.name as customer_name
           from users u left join customers c on c.id = u.customer_id where u.id = $1`, [uid]);
      const u = r.rows[0];
      if (u && u.active && u.customer_status !== 'suspended') req.user = u;
      else req.session.uid = null;
    }
    res.locals.user = req.user;
    res.locals.can = (p) => perms.can(req.user, p);
    next();
  } catch (err) { next(err); }
}

function requireLogin(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  return next();
}

/** Staff must have MFA when their role requires it (IAM-003). */
async function enforceMfaEnrolment(req, res, next) {
  try {
    if (!req.user || req.user.totp_enabled) return next();
    if (req.path.startsWith('/account') || req.path === '/logout' || req.path === '/manual') return next();
    if ((await mfaRoles()).includes(req.user.role)) return res.redirect('/account/mfa');
    return next();
  } catch (err) { return next(err); }
}

function requireStaff(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (req.user.kind !== 'staff') return res.redirect('/portal');
  return next();
}
function requireCustomer(req, res, next) {
  if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
  if (req.user.kind !== 'customer') return res.redirect('/');
  return next();
}
function requirePerm(perm) {
  return (req, res, next) => {
    if (!req.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    if (!perms.can(req.user, perm)) return res.status(403).render('error', { title: 'Not allowed', message: 'Your role does not allow this action.' });
    return next();
  };
}

module.exports = { loadUser, requireLogin, requireStaff, requireCustomer, requirePerm, enforceMfaEnrolment };
