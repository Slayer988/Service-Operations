'use strict';
// Asset register: list, add, change, import from a spreadsheet, export, link to tickets; and the customer's own equipment in the portal.
const express = require('express');
const fs = require('fs');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const audit = require('../lib/audit');
const csrf = require('../lib/csrf');
const storage = require('../lib/storage');
const u = require('../lib/util');
const reporting = require('../lib/reporting');
const config = require('../config');
const tickets = require('../services/tickets');
const S = require('../services/assets');
const { wrap, upload } = require('./util');
const { requireStaff, requireCustomer, requirePerm } = require('../middleware/auth');

const router = express.Router();
const db0 = { query: q };
const view = [requireStaff, requirePerm('asset.view')];
const manage = [requireStaff, requirePerm('asset.manage')];
const today = () => u.localDay(config.timezone);
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That asset does not exist.' });
const userError = (err) => { if (!(err instanceof tickets.UserError)) throw err; return err.userMessage; };

async function choices() {
  return {
    customers: (await q(`select id, name, code from customers where status = 'active' order by name`)).rows,
    sites: (await q('select id, customer_id, name from sites order by name')).rows,
    csids: (await q(`select id, customer_id, csid, description from csids where status = 'active' order by csid`)).rows,
    contracts: (await q(`select id, customer_id, reference, title from contracts where status not in ('closed','terminated') order by id desc limit 500`)).rows,
    suppliers: (await q(`select id, name from suppliers where status = 'active' order by name`)).rows,
    lpos: (await q(`select id, ref, title from purchase_orders where status <> 'cancelled' order by id desc limit 300`)).rows,
  };
}

function filters(query, d) {
  const where = ['true']; const params = []; const f = {};
  const add = (sql, v) => { params.push(v); where.push(sql.replace(/\?/g, `$${params.length}`)); };
  f.q = u.str(query.q, 100);
  if (f.q) add(`(a.tag ilike ? or a.name ilike ? or a.serial_number ilike ? or a.hostname ilike ? or a.ip_address ilike ? or a.model ilike ? or a.manufacturer ilike ? or c.name ilike ?)`, `%${f.q.replace(/[%_\\]/g, '\\$&')}%`);
  f.customer = query.customer === 'none' ? 'none' : (u.id(query.customer) || '');
  if (f.customer === 'none') where.push('a.customer_id is null'); else if (f.customer) add('a.customer_id = ?', f.customer);
  f.csid = u.id(query.csid) || ''; if (f.csid) add('a.csid_id = ?', f.csid);
  f.contract = u.id(query.contract) || ''; if (f.contract) add('a.contract_id = ?', f.contract);
  f.category = u.oneOf(query.category, Object.keys(S.CATEGORIES), '') || ''; if (f.category) add('a.category = ?', f.category);
  f.status = u.oneOf(query.status, [...Object.keys(S.STATUSES), 'live', 'all'], 'live');
  if (f.status === 'live') where.push(`a.status in ('in_stock','active','under_repair')`); else if (f.status !== 'all') add('a.status = ?', f.status);
  f.cover = u.oneOf(query.cover, ['warranty_soon', 'warranty_expired', 'expiry_soon', 'expired', 'no_warranty'], '') || '';
  if (f.cover === 'warranty_soon') add(`a.warranty_until between ?::date and ?::date + 90`, d);
  if (f.cover === 'warranty_expired') add(`a.warranty_until < ?::date`, d);
  if (f.cover === 'expiry_soon') add(`a.expires_on between ?::date and ?::date + 90`, d);
  if (f.cover === 'expired') add(`a.expires_on < ?::date`, d);
  if (f.cover === 'no_warranty') where.push(`a.warranty_until is null and a.category not in ('software','cloud')`);
  return { where: where.join(' and '), params, f };
}
const LIST = (where) => `select a.id, a.tag, a.name, a.category, a.status, a.manufacturer, a.model, a.serial_number, a.hostname, a.ip_address, a.quantity, a.warranty_until, a.expires_on,
       a.purchase_date, c.id as customer_id, c.name as customer_name, s.name as site_name, x.csid, k.reference as contract_reference,
       (select count(*)::int from ticket_assets ta join tickets t on t.id = ta.ticket_id where ta.asset_id = a.id and t.status not in ('resolved','closed','cancelled')) as open_tickets
  from assets a left join customers c on c.id = a.customer_id left join sites s on s.id = a.site_id left join csids x on x.id = a.csid_id left join contracts k on k.id = a.contract_id
 where ${where} order by c.name nulls first, a.category, a.name limit 2000`;

router.get('/assets', ...view, wrap(async (req, res) => {
  const d = today();
  const { where, params, f } = filters(req.query, d);
  const rows = (await q(LIST(where), params)).rows;
  const tiles = (await q(`select count(*) filter (where status in ('in_stock','active','under_repair'))::int as live,
        count(*) filter (where status = 'under_repair')::int as repair,
        count(*) filter (where status in ('in_stock','active','under_repair') and warranty_until between $1::date and $1::date + 90)::int as warranty_soon,
        count(*) filter (where status in ('in_stock','active','under_repair') and warranty_until < $1::date)::int as warranty_expired,
        count(*) filter (where status in ('in_stock','active','under_repair') and expires_on between $1::date and $1::date + 90)::int as expiry_soon,
        count(*) filter (where status in ('in_stock','active','under_repair') and expires_on < $1::date)::int as expired
      from assets a ${f.customer && f.customer !== 'none' ? 'where a.customer_id = $2' : ''}`, f.customer && f.customer !== 'none' ? [d, f.customer] : [d])).rows[0];
  res.render('staff/assets', { title: 'Assets', rows, f, tiles, S, d, canManage: perms.can(req.user, 'asset.manage'), customers: (await q('select id, name from customers order by name')).rows });
}));

router.get('/assets/export', ...view, wrap(async (req, res) => {
  const d = today();
  const { where, params } = filters(req.query, d);
  const rows = (await q(LIST(where), params)).rows.map((r) => ({ ...r, category_label: S.SHORT[r.category], status_label: S.STATUSES[r.status] }));
  const columns = [{ key: 'tag', header: 'Tag', width: 12 }, { key: 'name', header: 'Name', width: 28, weight: 3 }, { key: 'category_label', header: 'Category', width: 12 },
    { key: 'customer_name', header: 'Customer', width: 22, weight: 2 }, { key: 'site_name', header: 'Site', width: 16 }, { key: 'csid', header: 'CSID', width: 13 },
    { key: 'manufacturer', header: 'Make', width: 12 }, { key: 'model', header: 'Model', width: 18 }, { key: 'serial_number', header: 'Serial', width: 16 },
    { key: 'ip_address', header: 'IP', width: 14 }, { key: 'quantity', header: 'Qty', type: 'number', width: 6 }, { key: 'status_label', header: 'Status', width: 11 },
    { key: 'warranty_until', header: 'Warranty end', type: 'date', width: 12 }, { key: 'expires_on', header: 'Expires', type: 'date', width: 12 }];
  await audit(db0, req.user, 'report_exported', 'report', 'assets', `${rows.length} rows`, null, req.ip);
  if (!reporting.send(res, u.oneOf(req.query.format, ['csv', 'xlsx', 'pdf'], 'csv'), { title: 'Asset register', subtitle: `${rows.length} assets, ${d}`, columns, rows }, req.user)) res.redirect('/assets');
}));

router.get('/assets/new', ...manage, wrap(async (req, res) => {
  res.render('staff/asset_new', { title: 'Add an asset', form: { customer_id: u.id(req.query.customer) || '', status: 'active', quantity: 1 }, error: null, S, ...(await choices()) });
}));

router.post('/assets', ...manage, wrap(async (req, res) => {
  try {
    const a = await tx((db) => S.create(db, req.body, req.user, req.ip));
    req.flash('success', `${a.tag} registered.`);
    return res.redirect(`/assets/${a.id}`);
  } catch (err) { return res.status(400).render('staff/asset_new', { title: 'Add an asset', form: req.body, error: userError(err), S, ...(await choices()) }); }
}));

// ---------------------------------------------------------------- import
router.get('/assets/import', ...manage, wrap(async (req, res) => res.render('staff/asset_import', { title: 'Import assets', result: null })));
router.get('/assets/import/template.csv', ...manage, (req, res) => {
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="asset-import-template.csv"', 'X-Content-Type-Options': 'nosniff' });
  res.send(`﻿${S.TEMPLATE}`);
});
router.post('/assets/import', requireStaff, requirePerm('asset.manage'), upload.single('file'), csrf.protect, wrap(async (req, res) => {
  try {
    if (!req.file) return res.status(400).render('staff/asset_import', { title: 'Import assets', result: { errors: ['Choose the CSV file to import.'] } });
    if (req.file.size > 2 * 1048576) return res.status(400).render('staff/asset_import', { title: 'Import assets', result: { errors: ['The file is larger than 2 MB. Split it into smaller files.'] } });
    const text = await fs.promises.readFile(req.file.path, 'utf8');
    let result;
    try { result = await tx((db) => S.importCsv(db, text, req.user, req.ip)); } catch (err) { result = { imported: 0, errors: [userError(err)] }; }
    if (result.imported) { req.flash('success', `${result.imported} assets imported (${result.first} to ${result.last}).`); return res.redirect('/assets?status=all'); }
    return res.status(400).render('staff/asset_import', { title: 'Import assets', result });
  } finally { await storage.removeTmp(req.file ? [req.file] : []); }
}));

// ---------------------------------------------------------------- one asset
const load = (fn) => wrap(async (req, res) => {
  const a = await S.get(db0, u.id(req.params.id));
  if (!a) return notFound(res);
  return fn(req, res, a);
});

router.get('/assets/:id(\\d+)', ...view, load(async (req, res, a) => {
  const linked = (await q(`select t.ref, t.subject, t.status, t.priority, t.created_at from ticket_assets ta join tickets t on t.id = ta.ticket_id where ta.asset_id = $1 order by t.created_at desc limit 100`, [a.id])).rows;
  const events = (await q(`select e.text, e.at, u.name as actor_name from asset_events e left join users u on u.id = e.actor_id where e.asset_id = $1 order by e.at desc, e.id desc limit 200`, [a.id])).rows;
  const canManage = perms.can(req.user, 'asset.manage');
  res.render('staff/asset', { title: `${a.tag} ${a.name}`, a, linked, events, S, d: today(), canManage, canTickets: perms.can(req.user, 'ticket.view'), ...(canManage ? await choices() : {}) });
}));

router.post('/assets/:id(\\d+)', ...manage, load(async (req, res, a) => {
  try {
    await tx((db) => S.update(db, a, req.body, req.user, req.ip));
    req.flash('success', 'Saved.');
  } catch (err) { req.flash('error', userError(err)); }
  return res.redirect(`/assets/${a.id}`);
}));

// ---------------------------------------------------------------- tickets
const ticketFor = async (req, res) => {
  const t = await tickets.getVisible(db0, req.user, req.params.ref);
  if (!t) { res.status(404).render('error', { title: 'Not found', message: 'That ticket does not exist.' }); return null; }
  return t;
};
router.post('/tickets/:ref/assets', requireStaff, requirePerm('ticket.work'), requirePerm('asset.view'), wrap(async (req, res) => {
  const t = await ticketFor(req, res); if (!t) return;
  try {
    let id = u.id(req.body.asset_id);
    const tag = u.str(req.body.tag, 20).toUpperCase();
    if (!id && tag) { const r = (await q('select id from assets where upper(tag) = $1', [tag])).rows[0]; if (!r) throw new tickets.UserError(`There is no asset ${tag}.`); id = r.id; }
    if (!id) throw new tickets.UserError('Choose the equipment, or type its asset tag.');
    const a = await tx((db) => S.linkTicket(db, t, id, req.user));
    req.flash('success', `${a.tag} linked.`);
  } catch (err) { req.flash('error', userError(err)); }
  return res.redirect(`/tickets/${t.ref}#assets`);
}));
router.post('/tickets/:ref/assets/:id(\\d+)/unlink', requireStaff, requirePerm('ticket.work'), requirePerm('asset.view'), wrap(async (req, res) => {
  const t = await ticketFor(req, res); if (!t) return;
  await tx((db) => S.unlinkTicket(db, t, u.id(req.params.id), req.user));
  req.flash('success', 'Unlinked.');
  return res.redirect(`/tickets/${t.ref}#assets`);
}));

// ---------------------------------------------------------------- the customer's own equipment (portal; read only)
router.get('/portal/assets', requireCustomer, wrap(async (req, res) => {
  const rows = (await q(`select a.tag, a.name, a.category, a.status, a.manufacturer, a.model, a.serial_number, a.quantity, a.warranty_until, a.expires_on, s.name as site_name, x.csid
                           from assets a left join sites s on s.id = a.site_id left join csids x on x.id = a.csid_id
                          where a.customer_id = $1 and a.status in ('in_stock','active','under_repair') order by x.csid nulls last, a.category, a.name`, [req.user.customer_id])).rows;
  res.render('portal/assets', { title: 'Our equipment', rows, S, d: today() });
}));

module.exports = router;
