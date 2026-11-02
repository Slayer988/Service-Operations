'use strict';
// Outgoing mail (SMTP) settings. Saved on the E-mail page, the password encrypted in the database (lib/secrets.js), read again for every
// message so a change applies at once, in the web service and in the background worker, with no restart.
// An install that already has SMTP_* in /etc/itsm/itsm.env keeps working until a mail server is saved here.
const smtp = require('../lib/smtp');
const settings = require('../lib/settings');
const secrets = require('../lib/secrets');
const config = require('../config');

const KEY = 'smtp';

/** What will be used to send right now: { source: 'settings' | 'env' | 'none', options, from, server, port, security, user }. */
async function effective(db) {
  const stored = (await settings.get(db, KEY, null)) || {};
  const c = smtp.derive(stored);
  if (c.server) {
    const password = c.user ? ((stored.password_enc && secrets.decrypt(stored.password_enc)) || '') : '';
    return { source: 'settings', options: smtp.transportOptions(c, password), from: smtp.fromHeader(c), server: c.server, port: c.port, security: c.security, user: c.user, password };
  }
  if (config.smtp.host) {       // an earlier install: the values in the environment file, used exactly as before
    return {
      source: 'env', from: config.smtp.from, server: config.smtp.host, port: config.smtp.port, security: config.smtp.secure ? 'ssl' : 'starttls', user: config.smtp.user, password: config.smtp.pass,
      options: { host: config.smtp.host, port: config.smtp.port, secure: config.smtp.secure, auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined, connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000 },
    };
  }
  return { source: 'none', from: '', server: '', port: 0, security: '', user: '', password: '', options: null };
}

/** For the page: the saved values, never the password. */
async function view(db) {
  const stored = (await settings.get(db, KEY, null)) || {};
  const c = smtp.derive(stored);
  const eff = await effective(db);
  const readable = !stored.password_enc || !!secrets.decrypt(stored.password_enc);
  const counts = Object.fromEntries((await db.query(`select status, count(*)::int as n from notifications where created_at > now() - interval '7 days' group by status`)).rows.map((r) => [r.status, r.n]));
  return {
    source: eff.source, cfg: c, defaultPort: smtp.DEFAULT_PORT[c.security],
    password_saved: !!stored.password_enc && readable, password_lost: !!stored.password_enc && !readable,
    env: { host: config.smtp.host, port: config.smtp.port, from: config.smtp.from },
    last_test: stored.last_test || null, pending: counts.pending || 0, failed: counts.failed || 0,
  };
}

/** Validate and save the form. A blank password keeps the saved one; an empty server switches the saved settings off. Returns { config } or { error }. */
async function saveConfig(db, input) {
  const checked = smtp.validate(input);
  if (checked.error) return checked;
  const old = (await settings.get(db, KEY, null)) || {};
  const stored = { ...checked.config };
  const typed = typeof input.password === 'string' ? input.password : '';
  if (checked.config.user) {
    if (typed) stored.password_enc = secrets.encrypt(typed);
    else if (old.password_enc && old.user === checked.config.user && secrets.decrypt(old.password_enc)) stored.password_enc = old.password_enc;     // same account: keep the password
    else if (checked.config.server) return { error: 'Enter the password for that user name.' };
  }
  if (old.last_test && old.server === stored.server && old.port === stored.port) stored.last_test = old.last_test;
  await settings.set(db, KEY, stored);
  return { config: stored, password_changed: !!typed };
}

/** Remember how the last test went, to show on the page. */
async function recordTest(db, ok, to, message) {
  const stored = (await settings.get(db, KEY, null)) || {};
  stored.last_test = { at: new Date().toISOString(), ok: !!ok, to, message: String(message || '').slice(0, 400) };
  await settings.set(db, KEY, stored);
}

module.exports = { effective, view, saveConfig, recordTest, KEY };
