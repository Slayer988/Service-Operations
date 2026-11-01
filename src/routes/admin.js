'use strict';
// Users, settings, audit log and reports.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const settings = require('../lib/settings');
const password = require('../lib/password');
const audit = require('../lib/audit');
const u = require('../lib/util');
const tickets = require('../services/tickets');
const directory = require('../services/directory');
const contracts = require('../services/contracts');
const tenders = require('../services/tenders');
const pipeline = require('../services/pipeline');
const ldap = require('../lib/ldap');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();

// ---------------------------------------------------------------- administration hub
// Settings, users, directory and audit are kept off the sidebar; they are reached from here (user menu, top right).
const adminTiles = require('../lib/admin_tiles').tiles;
router.get('/admin', requireStaff, wrap(async (req, res) => {
  const tiles = adminTiles(req.user);
  if (!tiles.length) throw new tickets.UserError('You do not have access to any administration functions.', 403);
  res.render('admin/index', { title: 'Administration', tiles });
}));

// ---------------------------------------------------------------- users
router.get('/admin/users', requireStaff, requirePerm('user.manage'), wrap(async (req, res) => {
  await usersPage(req, res);
}));

const userRows = async () => (await q(`select u.id, u.name, u.email, u.auth_source, u.kind, u.role, u.role_locked, u.active, u.available, u.totp_enabled, u.last_login_at, c.name as customer_name from users u left join customers c on c.id = u.customer_id order by u.kind, u.name`)).rows;

router.post('/admin/users', requireStaff, requirePerm('user.manage'), wrap(async (req, res) => {
  const email = u.email(req.body.email); const name = u.str(req.body.name, 120);
  const role = u.oneOf(req.body.role, perms.STAFF_ROLES);
  if (!email || !name || !role) throw new tickets.UserError('Enter a name, a valid email address and a role.');
  if ((await q('select 1 from users where lower(email) = $1', [email])).rows.length) throw new tickets.UserError('That email address is already registered.');
  const temp = password.randomPassword();
  const r = await q(`insert into users (email, name, kind, role, password_hash, password_changed_at) values ($1,$2,'staff',$3,$4,now()) returning id`, [email, name, role, await password.hash(temp)]);
  await audit({ query: q }, req.user, 'user_created', 'user', r.rows[0].id, `${email} as ${role}`, null, req.ip);
  await usersPage(req, res, { newPassword: { email, password: temp } });
}));

router.post('/admin/users/:id(\\d+)', requireStaff, requirePerm('user.manage'), wrap(async (req, res) => {
  const id = u.id(req.params.id);
  await tx(async (db) => {
    const target = (await db.query('select * from users where id = $1 for update', [id])).rows[0];
    if (!target) throw new tickets.UserError('User not found.', 404);
    const active = req.body.active === 'on'; const available = req.body.available === 'on';
    const role = target.kind === 'staff' ? u.oneOf(req.body.role, perms.STAFF_ROLES, target.role) : target.role;
    if (target.id === req.user.id && (!active || role !== 'platform_admin')) throw new tickets.UserError('You cannot disable or demote your own account.');
    if (target.role === 'platform_admin' && (!active || role !== 'platform_admin')) {
      const others = (await db.query(`select count(*)::int as n from users where role = 'platform_admin' and active and id <> $1`, [id])).rows[0].n;
      if (!others) throw new tickets.UserError('There must be at least one active platform administrator.');
    }
    await db.query('update users set active = $2, available = $3, role = $4 where id = $1', [id, active, available, role]);
    if (!active) await db.query(`delete from session where sess::jsonb ->> 'uid' = $1`, [String(id)]);   // end open sessions at once
    await audit(db, req.user, 'user_updated', 'user', id, `${target.email}: role ${role}, active ${active}, available ${available}`, target.customer_id, req.ip);
  });
  req.flash('success', 'Saved.');
  res.redirect('/admin/users');
}));

router.post('/admin/users/:id(\\d+)/reset-password', requireStaff, requirePerm('user.manage'), wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const temp = password.randomPassword();
  const r = await q(`update users set password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = null where id = $1 and auth_source = 'local' returning email, customer_id`, [id, await password.hash(temp)]);
  if (!r.rows[0]) throw new tickets.UserError('User not found, or the password is managed in Active Directory.', 404);
  await q(`delete from session where sess::jsonb ->> 'uid' = $1`, [String(id)]);
  await audit({ query: q }, req.user, 'password_reset', 'user', id, r.rows[0].email, r.rows[0].customer_id, req.ip);
  await usersPage(req, res, { newPassword: { email: r.rows[0].email, password: temp } });
}));

// ---------------------------------------------------------------- settings
const SETTING_KEYS = ['priority_matrix', 'categories', 'resolution_codes', 'sla_pause_statuses', 'reopen_window_days', 'auto_close_days', 'mfa_required_roles', 'attachment_blocked_ext', 'attachment_max_mb', 'sla_warn_percent', 'email_ack_per_sender_per_hour', 'default_sla_policy', 'default_currency', 'tender_reminder_days', 'contract_types', 'contract_reminder_days', 'contract_expiring_days', 'tender_types', 'tender_require_reviews', 'tender_status_labels', 'pipeline_probabilities', 'pipeline_stage_labels', 'opportunity_categories', 'currencies', 'departments'];

router.get('/admin/settings', requireStaff, requirePerm('settings.manage'), wrap(async (req, res) => {
  const s = await settings.getAll({ query: q }, SETTING_KEYS);
  const policies = (await q('select id, name from sla_policies where active order by name')).rows;
  res.render('admin/settings', { title: 'Settings', s, policies, tenderStatuses: tenders.STATUS_LABELS, pipelineStages: pipeline.STAGE_LABELS, pipelineDefaults: pipeline.DEFAULT_PROB, contractTypes: contracts.DEFAULT_TYPES, tenderTypes: tenders.DEFAULT_TYPES, roles: [...perms.STAFF_ROLES, ...perms.CUSTOMER_ROLES], statuses: tickets.ALL_STATUSES });
}));

const lines = (v, max = 60) => String(v || '').split(/\r?\n/).map((x) => u.str(x, max)).filter(Boolean);

router.post('/admin/settings', requireStaff, requirePerm('settings.manage'), wrap(async (req, res) => {
  const b = req.body;
  const matrix = {};
  for (const i of [1, 2, 3]) { matrix[i] = {}; for (const g of [1, 2, 3]) { const p = u.intIn(b[`m_${i}_${g}`], 1, 4); if (!p) throw new tickets.UserError('Every impact and urgency combination needs a priority from 1 to 4.'); matrix[i][g] = p; } }
  const cats = lines(b.categories); const codes = lines(b.resolution_codes).map((c) => c.toLowerCase().replace(/[^a-z0-9_]+/g, '_'));
  if (!cats.length || !codes.length) throw new tickets.UserError('Categories and resolution codes cannot be empty.');
  const arr = (v) => (Array.isArray(v) ? v : v ? [v] : []);
  await tx(async (db) => {
    const set = (k, v) => settings.set(db, k, v);
    await set('priority_matrix', matrix);
    await set('categories', cats); await set('resolution_codes', codes);
    await set('sla_pause_statuses', arr(b.sla_pause_statuses).filter((x) => tickets.ALL_STATUSES.includes(x)));
    await set('mfa_required_roles', arr(b.mfa_required_roles).filter((x) => [...perms.STAFF_ROLES, ...perms.CUSTOMER_ROLES].includes(x)));
    await set('reopen_window_days', u.intIn(b.reopen_window_days, 0, 365) ?? 5);
    await set('auto_close_days', u.intIn(b.auto_close_days, 1, 365) ?? 3);
    await set('attachment_max_mb', u.intIn(b.attachment_max_mb, 1, 25) ?? 10);
    await set('attachment_blocked_ext', String(b.attachment_blocked_ext || '').split(/[,\s]+/).map((x) => x.toLowerCase().replace(/[^a-z0-9]/g, '')).filter(Boolean));
    await set('sla_warn_percent', u.intIn(b.sla_warn_percent, 1, 90) ?? 20);
    await set('email_ack_per_sender_per_hour', u.intIn(b.email_ack_per_sender_per_hour, 1, 50) ?? 3);
    await set('default_sla_policy', u.id(b.default_sla_policy));
    const currencies = [...new Set(String(b.currencies || '').split(/[,\s]+/).map((x) => x.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 8)).filter(Boolean))];
    const defCur = (u.str(b.default_currency, 8) || 'UGX').toUpperCase();
    if (!currencies.includes(defCur)) currencies.unshift(defCur);
    await set('default_currency', defCur); await set('currencies', currencies);
    const days = (v, fallback, max = 3650) => { const d = [...new Set(String(v || '').split(/[,\s]+/).map((x) => u.intIn(x, 1, max)).filter(Boolean))].sort((x, y) => y - x); return d.length ? d : fallback; };
    await set('tender_reminder_days', days(b.tender_reminder_days, [14, 7, 3, 1], 365));
    await set('contract_reminder_days', days(b.contract_reminder_days, [90, 60, 30, 14, 7]));
    await set('contract_expiring_days', u.intIn(b.contract_expiring_days, 1, 365) ?? 90);
    await set('tender_require_reviews', b.tender_require_reviews === 'on');
    const list = (v, fallback) => { const l = lines(v, 60); return l.length ? [...new Set(l)] : fallback; };
    await set('contract_types', list(b.contract_types, contracts.DEFAULT_TYPES)); await set('tender_types', list(b.tender_types, tenders.DEFAULT_TYPES));
    await set('opportunity_categories', list(b.opportunity_categories, ['Service', 'Solution', 'Product', 'Other']));
    await set('departments', lines(b.departments, 60));
    const probs = {}; const plabels = {}; const tlabels = {};
    for (const k of pipeline.STAGES) {
      const n = u.intIn(b[`prob_${k}`], 0, 100); if (n !== null && k !== 'won' && k !== 'lost') probs[k] = n;
      const l = u.str(b[`plabel_${k}`], 40); if (l && l !== pipeline.STAGE_LABELS[k]) plabels[k] = l;
    }
    for (const k of tenders.STATUSES) { const l = u.str(b[`tlabel_${k}`], 40); if (l && l !== tenders.STATUS_LABELS[k]) tlabels[k] = l; }
    await set('pipeline_probabilities', probs); await set('pipeline_stage_labels', plabels); await set('tender_status_labels', tlabels);
    await audit(db, req.user, 'settings_changed', 'settings', '', 'Settings were saved.', null, req.ip);
  });
  req.flash('success', 'Settings saved.');
  res.redirect('/admin/settings');
}));

// ---------------------------------------------------------------- audit log
router.get('/audit', requireStaff, requirePerm('audit.view'), wrap(async (req, res) => {
  const params = []; const where = ['true'];
  const action = u.str(req.query.action, 60); if (action) { params.push(action); where.push(`action = $${params.length}`); }
  const who = u.str(req.query.actor, 120).toLowerCase(); if (who) { params.push(`%${who.replace(/[%_\\]/g, '\\$&')}%`); where.push(`lower(actor_email) like $${params.length}`); }
  const page = Math.max(1, u.intIn(req.query.page, 1, 100000) || 1);
  const rows = (await q(`select * from audit_log where ${where.join(' and ')} order by id desc limit 100 offset ${(page - 1) * 100}`, params)).rows;
  const actions = (await q('select distinct action from audit_log order by action')).rows.map((r) => r.action);
  res.render('admin/audit', { title: 'Audit log', rows, actions, f: { action, actor: who }, page });
}));

// ---------------------------------------------------------------- Active Directory (part of User management)
const MAX_IMPORT = 200;
async function usersPage(req, res, extra = {}) {
  const cfg = await directory.loadConfig({ query: q });
  const counts = (await q(`select count(*) filter (where active)::int as active, count(*)::int as total from users where auth_source = 'ldap'`)).rows[0];
  res.render('admin/users', {
    title: 'Users', rows: await userRows(), staffRoles: perms.STAFF_ROLES, newPassword: null, info: null,
    ad: { cfg, counts, canConfigure: perms.can(req.user, 'settings.manage'), configured: ldap.isConfigured(cfg), roleLabels: perms.ROLE_LABELS }, ...extra,
  });
}

router.post('/admin/users/directory', requireStaff, requirePerm('settings.manage'), wrap(async (req, res) => {
  const b = req.body;
  const saved = await directory.saveConfig({ query: q }, { enabled: b.enabled, server: b.server, port: b.port, domain: b.domain, service_user: b.service_user, password: b.password, base_dn: b.base_dn, ca_file: b.ca_file, default_role: b.default_role });
  if (saved.error) throw new tickets.UserError(saved.error);
  await audit({ query: q }, req.user, 'directory_settings_saved', 'settings', 'ldap', `enabled=${saved.config.enabled}${b.password ? ', password changed' : ''}`, null, req.ip);
  req.flash('success', saved.config.enabled ? 'Saved. Use "Test connection" to check it, then import people.' : 'Saved. Active Directory sign-in is switched off.');
  res.redirect('/admin/users#directory');
}));

/** The saved settings, ready to connect with; sends the person back with a message when something is missing. */
async function connectable(req, res) {
  const cfg = await directory.loadConfig({ query: q });
  if (!ldap.isConfigured(cfg)) { req.flash('error', 'Enter and save the server, domain and service account first.'); res.redirect('/admin/users#directory'); return null; }
  if (!directory.bindPassword(cfg)) { req.flash('error', 'Enter and save the service account password first.'); res.redirect('/admin/users#directory'); return null; }
  return cfg;
}

router.post('/admin/users/directory/test', requireStaff, requirePerm('settings.manage'), wrap(async (req, res) => {
  const cfg = await connectable(req, res); if (!cfg) return;
  try {
    const r = await ldap.testConnection(cfg, directory.bindPassword(cfg));
    await audit({ query: q }, req.user, 'directory_tested', 'settings', 'ldap', 'ok', null, req.ip);
    req.flash('success', `Connected to ${cfg.server}. ${r.more ? 'Over 1000' : r.people} people found. You can now import users.`);
  } catch (err) {
    await audit({ query: q }, req.user, 'directory_tested', 'settings', 'ldap', 'failed', null, req.ip);
    req.flash('error', `Could not connect: ${ldap.scrub(err, directory.bindPassword(cfg))}`);
  }
  res.redirect('/admin/users#directory');
}));

router.get('/admin/users/import', requireStaff, requirePerm('user.manage'), wrap(async (req, res) => {
  const cfg = await connectable(req, res); if (!cfg) return;
  const term = u.str(req.query.q, 100);
  let found = { users: [], tooMany: false }; let error = '';
  if (req.query.go !== undefined || term) {
    try { found = await ldap.searchUsers(cfg, directory.bindPassword(cfg), term); } catch (err) { error = `Could not search the directory: ${ldap.scrub(err, directory.bindPassword(cfg))}`; }
  }
  const known = new Map((await q('select lower(email) as email, lower(ldap_dn) as dn, auth_source from users')).rows.flatMap((r) => [[r.email, r.auth_source], [r.dn, r.auth_source]]));
  const users = found.users.map((x) => ({ ...x, status: x.disabled ? 'disabled' : (known.get(x.dn.toLowerCase()) || known.get(x.email)) ? ((known.get(x.dn.toLowerCase()) || known.get(x.email)) === 'ldap' ? 'imported' : 'local') : 'new' }));
  res.render('admin/directory_import', { title: 'Import from Active Directory', cfg, term, users, tooMany: found.tooMany, error, searched: req.query.go !== undefined || !!term, staffRoles: perms.STAFF_ROLES, roleLabels: perms.ROLE_LABELS, max: MAX_IMPORT });
}));

router.post('/admin/users/import', requireStaff, requirePerm('user.manage'), wrap(async (req, res) => {
  const cfg = await connectable(req, res); if (!cfg) return;
  const raw = [].concat(req.body.dn || []).map((x) => u.str(x, 500)).filter(Boolean);
  const dns = [...new Set(raw)].slice(0, MAX_IMPORT);
  if (!dns.length) throw new tickets.UserError('Tick at least one person to import.');
  const role = u.oneOf(req.body.role, perms.STAFF_ROLES);
  if (!role) throw new tickets.UserError('Choose a role for the people you import.');
  const results = await ldap.recheck(cfg, directory.bindPassword(cfg), dns);          // the details come from the directory, not from the form
  const out = await tx((db) => directory.importUsers(db, results, role, req.user, req.ip));
  const parts = [];
  if (out.imported.length) parts.push(`Imported ${out.imported.length} ${out.imported.length === 1 ? 'person' : 'people'} as ${perms.ROLE_LABELS[role]}: ${out.imported.join(', ')}.`);
  if (out.skipped.length) parts.push(`Skipped: ${out.skipped.map((x) => `${x.name} ${x.why}`).join('; ')}.`);
  req.flash(out.imported.length ? 'success' : 'error', parts.join(' '));
  res.redirect('/admin/users');
}));

// the earlier separate page
router.get('/admin/directory', requireStaff, (req, res) => res.redirect(301, '/admin/users#directory'));

module.exports = router;
