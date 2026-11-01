'use strict';
// Active Directory / LDAP access. The directory is only ever contacted over TLS (ldaps:// or STARTTLS) with certificate
// checking switched on; an internal CA is trusted through the "ca_file" setting, never by disabling verification.
// The `ldapts` package is loaded on first use so that the rest of the application (and the unit tests) work without it.
const fs = require('fs');
const perms = require('./perms');

const DEFAULT_FILTER = '(&(objectCategory=person)(objectClass=user)(|(userPrincipalName={{u}})(sAMAccountName={{u}})(mail={{u}})))';

/** RFC 4515 escaping: a typed user name can never change the structure of the search filter. */
function escapeFilter(value) {
  return String(value).replace(/[\\*()\u0000]/g, (c) => `\\${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

function buildUserFilter(template, ident) {
  if (typeof template !== 'string' || !template.includes('{{u}}')) throw new Error('The user filter must contain {{u}}.');
  return template.split('{{u}}').join(escapeFilter(ident));
}

const STAFF_ROLES = perms.STAFF_ROLES;

/** "corp.local" -> "DC=corp,DC=local" */
const domainToBase = (domain) => String(domain || '').split('.').filter(Boolean).map((p) => `DC=${p}`).join(',');
/** "DC=corp,DC=local" -> "corp.local" (used to read configurations saved by earlier versions) */
const baseToDomain = (base) => String(base || '').split(',').map((p) => /^DC=(.+)$/i.exec(p.trim())).filter(Boolean).map((m) => m[1]).join('.');

/**
 * What an administrator types: the server, the domain and a service account. Everything else is worked out:
 *   port 636 -> ldaps://server:636 (the normal, encrypted way); port 389 -> STARTTLS; the search base comes from the domain.
 * Returns { config } in the stored shape (no password, no derived values) or { error } in plain words.
 */
function validateConfig(input) {
  let server = String(input.server || '').trim().replace(/^ldaps?:\/\//i, '');
  let port = input.port === undefined || input.port === '' || input.port === null ? 636 : Number(input.port);
  const m = /^([^:/]+):(\d{1,5})\/?$/.exec(server);               // someone pasted "dc1.corp.local:636"
  if (m) { server = m[1]; if (input.port === undefined || input.port === '') port = Number(m[2]); }
  server = server.replace(/\/+$/, '');
  const c = {
    enabled: input.enabled === true || input.enabled === 'on',
    server, port,
    domain: String(input.domain || '').trim().toLowerCase(),
    service_user: String(input.service_user || '').trim().slice(0, 300),
    base_dn: String(input.base_dn || '').trim().slice(0, 500),
    ca_file: String(input.ca_file || '').trim(),
    default_role: STAFF_ROLES.includes(input.default_role) ? input.default_role : 'agent',
  };
  if (c.server && !/^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(c.server)) return { error: 'The server must be a name or address such as dc1.corp.local, with no "ldap://" or slashes.' };
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return { error: 'The port must be a number from 1 to 65535 (636 is normal).' };
  if (c.domain && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(c.domain)) return { error: 'The domain must look like corp.local.' };
  if (c.service_user && /[\u0000-\u001f]/.test(c.service_user)) return { error: 'The service account contains characters that are not allowed.' };
  if (c.base_dn && !/^[A-Za-z]+=.+/.test(c.base_dn)) return { error: 'The search base must look like DC=corp,DC=local.' };
  if (c.ca_file && !/^\/[A-Za-z0-9_./-]{1,200}\.(pem|crt|cer)$/.test(c.ca_file)) return { error: 'The certificate file must be an absolute path ending in .pem, .crt or .cer.' };
  if (c.enabled && (!c.server || !c.domain || !c.service_user)) return { error: 'Enter the server, the domain and the service account before switching Active Directory sign-in on.' };
  return { config: c };
}

/** The service account name as the directory wants it: "svc-itsm" becomes svc-itsm@corp.local; a full UPN or DN is used as typed. */
const bindName = (c) => (/[@=\\]/.test(c.service_user) ? c.service_user : `${c.service_user}@${c.domain}`);

/** Add the working values the connection code needs. Also reads configurations saved by earlier versions. */
function derive(stored) {
  const c = { ...(stored || {}) };
  if (!c.server && c.url) { const m = /^ldaps?:\/\/([^:/]+)(?::(\d+))?$/.exec(c.url); if (m) { c.server = m[1]; c.port = Number(m[2]) || (c.url.startsWith('ldaps') ? 636 : 389); } }
  if (!c.service_user && c.bind_dn) c.service_user = c.bind_dn;
  if (!c.domain && c.base_dn) c.domain = baseToDomain(c.base_dn);
  c.port = Number(c.port) || 636;
  c.base_dn = c.base_dn || domainToBase(c.domain);
  c.default_role = STAFF_ROLES.includes(c.default_role) ? c.default_role : 'agent';
  c.starttls = c.port === 389;
  c.url = c.server ? `${c.starttls ? 'ldap' : 'ldaps'}://${c.server}:${c.port}` : '';
  c.bind_dn = c.service_user ? bindName(c) : '';
  c.user_filter = DEFAULT_FILTER; c.email_attr = 'mail'; c.name_attr = 'displayName';
  return c;
}
const isConfigured = (c) => !!(c && c.server && c.service_user && c.base_dn);

/** AD userAccountControl bit 2 = account disabled. */
function isDisabled(uac) { const n = parseInt(Array.isArray(uac) ? uac[0] : uac, 10); return Number.isFinite(n) && (n & 2) !== 0; }

function first(v) {
  if (Array.isArray(v)) return first(v[0]);
  if (Buffer.isBuffer(v)) return v.toString('utf8');
  return v === undefined || v === null ? '' : String(v);
}
function isNoSuchObject(e) { return !!e && (e.code === 32 || e.name === 'NoSuchObjectError'); }
function isBadCredentials(e) { return !!e && (e.code === 49 || e.name === 'InvalidCredentialsError'); }

function scrub(err, ...secrets) {
  let m = String((err && err.message) || err || 'unknown error');
  for (const s of secrets) if (s) m = m.split(s).join('***');
  return m.slice(0, 300);
}

let clientFactory = null;   // tests only: replaces the real LDAP client
async function newClient(cfg) {
  if (clientFactory) return clientFactory(cfg);
  const { Client } = await import('ldapts');
  const tlsOptions = { rejectUnauthorized: true };
  if (cfg.ca_file) tlsOptions.ca = [fs.readFileSync(cfg.ca_file)];
  const client = new Client({ url: cfg.url, timeout: 10000, connectTimeout: 5000, tlsOptions });
  if (cfg.url.startsWith('ldap://') && cfg.starttls) await client.startTLS(tlsOptions);
  return client;
}

async function serviceClient(cfg, svcPassword) {
  if (!svcPassword) throw new Error(`The service account password is not set. Enter it in the Active Directory settings.`);
  const client = await newClient(cfg);
  try { await client.bind(cfg.bind_dn, svcPassword); } catch (e) { await close(client); throw e; }
  return client;
}
async function close(client) { try { await client.unbind(); } catch (_) { /* ignore */ } }

function attrsOf(cfg) { return ['dn', cfg.email_attr, cfg.name_attr, 'userPrincipalName', 'sAMAccountName', 'userAccountControl']; }

function describe(cfg, entry) {
  return {
    dn: entry.dn,
    email: (first(entry[cfg.email_attr]) || first(entry.userPrincipalName)).trim().toLowerCase(),
    name: (first(entry[cfg.name_attr]) || first(entry.sAMAccountName) || '').trim(),
    login: first(entry.sAMAccountName),
    disabled: isDisabled(entry.userAccountControl),
  };
}

async function findUser(svc, cfg, ident) {
  const { searchEntries } = await svc.search(cfg.base_dn, { scope: 'sub', filter: buildUserFilter(cfg.user_filter, ident), attributes: attrsOf(cfg) });
  return searchEntries;
}

/**
 * Check a typed name and password against the directory.
 * Returns { ok: true, user: {dn,email,name,login,disabled} } or { ok: false, reason }.
 * Throws when the directory cannot be reached (the caller shows "directory unavailable", never "wrong password").
 * An empty password is refused here because many servers treat bind-with-empty-password as an anonymous success.
 */
async function authenticate(cfg, svcPassword, ident, password) {
  if (!password || !ident || ident.length > 254) return { ok: false, reason: 'bad_password' };
  let entry;
  const svc = await serviceClient(cfg, svcPassword);
  try {
    const found = await findUser(svc, cfg, ident);
    if (found.length !== 1) return { ok: false, reason: found.length ? 'ambiguous' : 'unknown' };
    entry = describe(cfg, found[0]);
  } finally { await close(svc); }
  if (entry.disabled) return { ok: false, reason: 'disabled', user: entry };

  const uc = await newClient(cfg);
  try { await uc.bind(entry.dn, password); } catch (e) {
    if (isBadCredentials(e)) return { ok: false, reason: 'bad_password' };
    throw e;
  } finally { await close(uc); }
  if (!entry.email) return { ok: false, reason: 'no_email', user: entry };
  return { ok: true, user: entry };
}

const SIZE_LIMIT = 100;
const isTooMany = (e) => !!e && (e.code === 4 || e.name === 'SizeLimitExceededError');
const PEOPLE = '(objectCategory=person)(objectClass=user)';

/**
 * Search the directory for people to import: part of a name, user name or e-mail address (empty = everyone, up to 100).
 * Returns { users, tooMany }. Accounts that are disabled in AD are listed but marked.
 */
async function searchUsers(cfg, svcPassword, term) {
  const t = String(term || '').trim().slice(0, 100);
  const part = escapeFilter(t);
  const filter = t ? `(&${PEOPLE}(|(displayName=*${part}*)(sAMAccountName=*${part}*)(mail=*${part}*)(userPrincipalName=*${part}*)(cn=*${part}*)))` : `(&${PEOPLE})`;
  const svc = await serviceClient(cfg, svcPassword);
  try {
    let entries;
    try { entries = (await svc.search(cfg.base_dn, { scope: 'sub', filter, attributes: attrsOf(cfg), sizeLimit: SIZE_LIMIT })).searchEntries; } catch (e) {
      if (isTooMany(e)) return { users: [], tooMany: true };
      throw e;
    }
    const users = entries.map((e) => describe(cfg, e)).filter((u) => u.dn).sort((a, b) => a.name.localeCompare(b.name));
    return { users, tooMany: users.length >= SIZE_LIMIT };
  } finally { await close(svc); }
}

/** For the settings page: can we sign in as the service account, read the search base, and how many people are there? */
async function testConnection(cfg, svcPassword) {
  const svc = await serviceClient(cfg, svcPassword);
  try {
    await svc.search(cfg.base_dn, { scope: 'base', filter: '(objectClass=*)', attributes: ['dn'] });
    let people = 0; let more = false;
    try { people = (await svc.search(cfg.base_dn, { scope: 'sub', filter: `(&${PEOPLE})`, attributes: ['dn'], sizeLimit: 1000 })).searchEntries.length; more = people >= 1000; } catch (e) { if (isTooMany(e)) more = true; else throw e; }
    return { ok: true, people, more };
  } finally { await close(svc); }
}

/**
 * Re-read directory accounts by distinguished name. One result per DN: { dn, state: 'ok'|'gone'|'disabled', user }.
 * Used to import the people an administrator ticked (so the details come from the directory, not from the browser) and for
 * the hourly check. Throws if the directory is unreachable so that nobody is switched off because of a network problem.
 */
async function recheck(cfg, svcPassword, dns) {
  const svc = await serviceClient(cfg, svcPassword);
  const results = [];
  try {
    for (const dn of dns) {
      let found = [];
      try { found = (await svc.search(dn, { scope: 'base', filter: '(objectClass=*)', attributes: attrsOf(cfg) })).searchEntries; } catch (e) { if (!isNoSuchObject(e)) throw e; }
      if (!found.length) { results.push({ dn, state: 'gone' }); continue; }
      const user = describe(cfg, found[0]);
      results.push({ dn, state: user.disabled ? 'disabled' : 'ok', user });
    }
  } finally { await close(svc); }
  return results;
}

module.exports = {
  _useClientFactory: (f) => { clientFactory = f; },
  DEFAULT_FILTER, escapeFilter, buildUserFilter, validateConfig, derive, bindName, isConfigured, domainToBase, baseToDomain, isDisabled,
  authenticate, searchUsers, testConnection, recheck, scrub,
};
