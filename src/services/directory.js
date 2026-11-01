'use strict';
// Active Directory, kept deliberately small:
//   * the settings (server, domain, service account) and the encrypted service-account password;
//   * importing people the administrator picks (they become staff users, with a role chosen in this application);
//   * checking a typed password against the directory at sign-in;
//   * an hourly check that switches off people who were deleted or disabled in AD.
// Roles are never taken from AD groups: the role set on the Users page is the role. Only imported people can sign in with AD.
// An administrator's decision to disable an account is never reversed by the directory; nobody is switched off because the
// directory is unreachable.
const ldap = require('../lib/ldap');
const settings = require('../lib/settings');
const secrets = require('../lib/secrets');
const audit = require('../lib/audit');
const perms = require('../lib/perms');
const { UserError } = require('./tickets');

/** The working configuration (see ldap.derive). `enabled` is true only when sign-in is switched on and the essentials are present. */
async function loadConfig(db) {
  const raw = (await settings.get(db, 'ldap', null)) || {};
  const cfg = ldap.derive(raw);
  cfg.enabled = raw.enabled === true && ldap.isConfigured(cfg);
  cfg.password_saved = !!bindPassword(cfg);
  return cfg;
}

/** The service-account password: the one saved on the settings page, else the LDAP_BIND_PASSWORD variable of an earlier install. */
function bindPassword(cfg) {
  return (cfg.password_enc && secrets.decrypt(cfg.password_enc)) || process.env[cfg.bind_secret_env || 'LDAP_BIND_PASSWORD'] || '';
}

/** Validate and save the form. A blank password keeps the saved one. Returns { config } or { error }. */
async function saveConfig(db, input) {
  const checked = ldap.validateConfig(input);
  if (checked.error) return checked;
  const old = (await settings.get(db, 'ldap', null)) || {};
  const stored = { ...checked.config };
  const typed = typeof input.password === 'string' ? input.password : '';
  if (typed) stored.password_enc = secrets.encrypt(typed);
  else if (old.password_enc) stored.password_enc = old.password_enc;
  if (old.bind_secret_env && !stored.password_enc) stored.bind_secret_env = old.bind_secret_env;     // an earlier install's variable keeps working
  const probe = ldap.derive(stored);
  if (stored.enabled && !bindPassword(probe)) return { error: 'Enter the service account password before switching Active Directory sign-in on.' };
  await settings.set(db, 'ldap', stored);
  return { config: stored };
}

async function otherActiveAdmins(db, exceptId) {
  return (await db.query(`select count(*)::int as n from users where role = 'platform_admin' and active and id <> $1`, [exceptId])).rows[0].n;
}

/** Called after the directory accepted the password. Only people who were imported (or marked as Active Directory users) may sign in. */
async function signIn(db, result) {
  const d = result.user;
  let row = (await db.query('select * from users where lower(ldap_dn) = lower($1)', [d.dn])).rows[0];
  if (!row) row = (await db.query('select * from users where lower(email) = $1', [d.email])).rows[0];
  if (!row) return { denied: 'not_imported' };
  if (row.auth_source !== 'ldap') return { denied: 'local_account', row };
  if (!row.active) return { denied: 'inactive', row };
  const r = await db.query(
    `update users set name = $2, ldap_dn = $3, directory_synced_at = now(),
            email = case when exists (select 1 from users o where lower(o.email) = $4 and o.id <> $1) then email else $4 end
      where id = $1 returning *`, [row.id, d.name || row.name, d.dn, d.email]);
  return { user: r.rows[0] };
}

/**
 * Create staff users from directory accounts the administrator ticked. `results` come from ldap.recheck (details read from the
 * directory, never from the browser). Everyone gets the same role; it can be changed per person afterwards.
 * Returns { imported: [name], skipped: [{ name, why }] }.
 */
async function importUsers(db, results, role, actor, ip) {
  if (!perms.STAFF_ROLES.includes(role)) throw new UserError('Choose a role for the people you import.');
  const imported = []; const skipped = [];
  for (const r of results) {
    const label = r.user ? (r.user.name || r.user.login || r.dn) : r.dn;
    if (r.state === 'gone') { skipped.push({ name: label, why: 'is no longer in the directory' }); continue; }
    if (r.state === 'disabled') { skipped.push({ name: label, why: 'is disabled in Active Directory' }); continue; }
    const d = r.user;
    if (!d.email) { skipped.push({ name: label, why: 'has no e-mail address in Active Directory' }); continue; }
    const existing = (await db.query('select id, auth_source from users where lower(email) = $1 or lower(ldap_dn) = lower($2) limit 1', [d.email, d.dn])).rows[0];
    if (existing) { skipped.push({ name: label, why: existing.auth_source === 'ldap' ? 'is already imported' : 'already has a local account here' }); continue; }
    const ins = await db.query(
      `insert into users (email, name, kind, role, auth_source, ldap_dn, role_locked, directory_synced_at) values ($1,$2,'staff',$3,'ldap',$4,true,now()) returning id`,
      [d.email, d.name || d.email, role, d.dn]);
    await audit(db, actor, 'user_imported_from_directory', 'user', ins.rows[0].id, `${d.email} as ${role}`, null, ip);
    imported.push(label);
  }
  return { imported, skipped };
}

async function deactivate(db, row, why) {
  await db.query('update users set active = false where id = $1', [row.id]);
  await db.query(`delete from session where sess::jsonb ->> 'uid' = $1`, [String(row.id)]);
  await audit(db, null, 'user_deactivated_by_directory', 'user', row.id, `${row.email}: ${why}`, null, null);
}

/** Hourly job. Returns { checked, deactivated } or null when directory sign-in is switched off. */
async function syncAll(db) {
  const cfg = await loadConfig(db);
  if (!cfg.enabled) return null;
  const users = (await db.query(`select id, email, role, name, ldap_dn from users where auth_source = 'ldap' and active and ldap_dn is not null`)).rows;
  if (!users.length) return { checked: 0, deactivated: 0 };
  const results = await ldap.recheck(cfg, bindPassword(cfg), users.map((u) => u.ldap_dn));   // throws if unreachable: nobody is changed
  const byDn = new Map(results.map((r) => [r.dn.toLowerCase(), r]));
  let deactivated = 0;
  for (const u of users) {
    const r = byDn.get(u.ldap_dn.toLowerCase());
    if (!r) continue;
    if (r.state === 'ok') { await db.query('update users set name = $2, directory_synced_at = now() where id = $1', [u.id, r.user.name || u.name]); continue; }
    if (u.role === 'platform_admin' && !(await otherActiveAdmins(db, u.id))) {
      console.error(`[directory] ${u.email} is the last active platform administrator and is ${r.state} in the directory; left active`);
      continue;
    }
    await deactivate(db, u, r.state === 'gone' ? 'no longer in the directory' : 'disabled in the directory');
    deactivated++;
  }
  return { checked: users.length, deactivated };
}

module.exports = { loadConfig, bindPassword, saveConfig, signIn, importUsers, syncAll };
