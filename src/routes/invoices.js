'use strict';
// Invoices to customers: list and figures, raise from what is billable (contract instalments, an accepted quote, chargeable time),
// edit while a draft, issue, record payments, cancel, and download as PDF.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const audit = require('../lib/audit');
const u = require('../lib/util');
const reporting = require('../lib/reporting');
const tickets = require('../services/tickets');
const Q = require('../services/quotes');
const INV = require('../services/invoices');
const T = require('../services/time');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();
const db0 = { query: q };
const view = [requireStaff, requirePerm('invoice.view')];
const manage = [requireStaff, requirePerm('invoice.manage')];
const today = () => u.localDay(config.timezone);
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That invoice does not exist.' });
const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

async function formData(customerId) {
  const s = await INV.listSettings(db0);
  return {
    customers: (await q('select id, name, code from customers order by name')).rows,
    contracts: customerId ? (await q(`select id, reference, title from contracts where customer_id = $1 order by id desc`, [customerId])).rows : [],
    projects: customerId ? (await q(`select id, ref, name from projects where customer_id = $1 or customer_id is null order by ref desc limit 300`, [customerId])).rows : [],
    catalogue: (await q('select name from service_catalogue where active order by name')).rows.map((r) => r.name),
    currencies: s.currencies, settings: s,
  };
}

function filters(query, d) {
  const where = ['true']; const params = []; const f = {};
  f.q = u.str(query.q, 100);
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); const n = params.length; where.push(`(i.ref ilike $${n} or i.title ilike $${n} or c.name ilike $${n} or i.customer_ref ilike $${n})`); }
  f.status = u.oneOf(query.status, [...INV.STATUSES, 'open', 'overdue', 'all'], 'all');
  if (f.status === 'open') where.push(`i.status in ('issued','part_paid')`);
  else if (f.status === 'overdue') { params.push(d); where.push(`i.status in ('issued','part_paid') and i.due_date < $${params.length}::date`); }
  else if (f.status !== 'all') { params.push(f.status); where.push(`i.status = $${params.length}`); }
  f.customer = u.id(query.customer) || ''; if (f.customer) { params.push(f.customer); where.push(`i.customer_id = $${params.length}`); }
  params.push(d); const dn = params.length;
  return { where, params, f, dn };
}
const LIST = (where, dn) => `select i.id, i.ref, i.title, i.status, i.currency, i.total, i.paid_total, (i.total - i.paid_total) as balance, i.issue_date, i.due_date, i.customer_ref,
       c.id as customer_id, c.name as customer_name, (i.status in ('issued','part_paid') and i.due_date < $${dn}::date) as overdue, ($${dn}::date - i.due_date) as days_over
  from invoices i join customers c on c.id = i.customer_id where ${where} order by i.id desc limit 1000`;

router.get('/invoices', ...view, wrap(async (req, res) => {
  const d = today();
  const { where, params, f, dn } = filters(req.query, d);
  const rows = (await q(LIST(where.join(' and '), dn), params)).rows;
  res.render('staff/invoices', { title: 'Invoices', rows, f, INV, money: Q.fmtMoney, canManage: perms.can(req.user, 'invoice.manage'),
    customers: (await q('select id, name from customers order by name')).rows, sum: await INV.summary(db0, d, f.customer || null),
    unbilled: await INV.unbilledTime(db0), showTime: T.show });
}));

router.get('/invoices/export', ...view, wrap(async (req, res) => {
  const d = today();
  const { where, params, f, dn } = filters(req.query, d);
  const rows = (await q(LIST(where.join(' and '), dn), params)).rows.map((r) => ({ ...r, status_label: r.overdue ? `${INV.STATUS_LABELS[r.status]} (overdue)` : INV.STATUS_LABELS[r.status] }));
  const columns = [{ key: 'ref', header: 'Invoice', width: 14 }, { key: 'customer_name', header: 'Customer', width: 26, weight: 2 }, { key: 'title', header: 'For', width: 28, weight: 3 },
    { key: 'status_label', header: 'Status', width: 16 }, { key: 'currency', header: 'Cur.', width: 7 }, { key: 'total', header: 'Total', type: 'money', width: 16 },
    { key: 'paid_total', header: 'Paid', type: 'money', width: 16 }, { key: 'balance', header: 'Balance', type: 'money', width: 16 },
    { key: 'issue_date', header: 'Date', type: 'date', width: 12 }, { key: 'due_date', header: 'Due', type: 'date', width: 12 }];
  await audit(db0, req.user, 'report_exported', 'report', 'invoices', `${rows.length} rows`, null, req.ip);
  if (!reporting.send(res, u.oneOf(req.query.format, ['csv', 'xlsx', 'pdf'], 'csv'), { title: f.status === 'overdue' ? 'Overdue invoices' : 'Invoices', subtitle: `${rows.length} invoices`, columns, rows }, req.user)) res.redirect('/invoices');
}));

// New invoice: choose the customer, then what to bill (the page reloads with the customer's billable items)
async function newPage(req, res, form, error, picked = {}) {
  const customerId = u.id(form.customer_id) || null;
  const upto = u.dateStr(req.query.upto || req.body.upto) || today();
  const fd = await formData(customerId);
  const customer = customerId ? (await q('select id, name, hourly_rate, billing_address, tin from customers where id = $1', [customerId])).rows[0] : null;
  res.status(error ? 400 : 200).render('staff/invoice_new', { title: 'New invoice', form, error, customer, upto, picked, money: Q.fmtMoney, showTime: T.show, INV,
    avail: customer ? await INV.billable(db0, customer.id, upto) : null, ...fd });
}

router.get('/invoices/new', ...manage, wrap(async (req, res) => {
  const customerId = u.id(req.query.customer) || '';
  const form = await INV.defaults(db0, customerId, today());
  const picked = {};
  if (req.query.quote) picked.quote = String(u.id(req.query.quote) || '');
  if (req.query.instalment) picked.instalments = [String(u.id(req.query.instalment) || '')];
  return newPage(req, res, form, null, picked);
}));

router.post('/invoices', ...manage, wrap(async (req, res) => {
  const picks = { instalments: arr(req.body.instalment), quote: u.id(req.body.quote) || null, tickets: arr(req.body.ticket), upto: u.dateStr(req.body.upto) || today() };
  try {
    const fd = await formData(null);
    const inv = await tx((db) => INV.create(db, INV.readHeader(req.body, { ...fd, titleOptional: true }), picks, req.user, req.ip, today()));
    req.flash('success', `${inv.ref} raised as a draft. Check the lines, then issue it.${inv.notes && inv.notes.length ? ` ${inv.notes.join(' ')}` : ''}`);
    return res.redirect(`/invoices/${inv.id}`);
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return newPage(req, res, req.body, err.userMessage, { instalments: picks.instalments.map(String), quote: String(picks.quote || ''), tickets: picks.tickets.map(String) });
  }
}));

const load = (fn) => wrap(async (req, res) => {
  const inv = await INV.get(db0, u.id(req.params.id));
  if (!inv) return notFound(res);
  return fn(req, res, inv);
});

router.get('/invoices/:id(\\d+)', ...view, load(async (req, res, inv) => {
  const lines = await INV.lines(db0, inv.id);
  const canManage = perms.can(req.user, 'invoice.manage');
  res.render('staff/invoice', {
    title: inv.ref, inv, lines, INV, canManage, editable: canManage && inv.status === 'draft', money: Q.fmtMoney, showTime: T.show, today: today(),
    pays: await INV.payments(db0, inv.id), events: await INV.events(db0, inv.id), billed: await INV.billed(db0, inv.id),
    blankRows: Math.max(2, 6 - lines.length), ...(await formData(inv.customer_id)),
  });
}));

router.post('/invoices/:id(\\d+)', ...manage, load(async (req, res, inv) => {
  await tx(async (db) => INV.updateHeader(db, inv, INV.readHeader({ ...req.body, customer_id: inv.customer_id }, await INV.listSettings(db)), req.user));
  req.flash('success', 'Invoice details saved.');
  return res.redirect(`/invoices/${inv.id}`);
}));

router.post('/invoices/:id(\\d+)/lines', ...manage, load(async (req, res, inv) => {
  const after = await tx((db) => INV.saveLines(db, inv, Q.readLines(req.body), req.user));
  req.flash('success', `Lines saved. Total ${after.currency} ${Q.fmtMoney(after.total)}.`);
  return res.redirect(`/invoices/${inv.id}#lines`);
}));

router.post('/invoices/:id(\\d+)/issue', ...manage, load(async (req, res, inv) => {
  const after = await tx((db) => INV.issue(db, inv, req.user, req.ip, today()));
  req.flash('success', `${after.ref} issued, dated today. Download the PDF and send it to ${after.customer_name}.`);
  return res.redirect(`/invoices/${inv.id}`);
}));

router.post('/invoices/:id(\\d+)/cancel', ...manage, load(async (req, res, inv) => {
  await tx((db) => INV.cancel(db, inv, req.body.note, req.user, req.ip));
  req.flash('success', `${inv.ref} cancelled. What it billed can be billed again.`);
  return res.redirect(`/invoices/${inv.id}`);
}));

router.post('/invoices/:id(\\d+)/payments', ...manage, load(async (req, res, inv) => {
  const after = await tx((db) => INV.addPayment(db, inv, INV.readPayment(req.body, inv, today()), req.user, req.ip, today()));
  req.flash('success', after.status === 'paid' ? `Payment recorded. ${after.ref} is paid.` : `Payment recorded. Balance ${after.currency} ${Q.fmtMoney(after.balance)}.`);
  return res.redirect(`/invoices/${inv.id}#payments`);
}));

router.post('/invoices/:id(\\d+)/payments/:pid(\\d+)/delete', ...manage, load(async (req, res, inv) => {
  await tx((db) => INV.removePayment(db, inv, u.id(req.params.pid), req.user, req.ip, today()));
  req.flash('success', 'Payment removed.');
  return res.redirect(`/invoices/${inv.id}#payments`);
}));

router.get('/invoices/:id(\\d+)/pdf', ...view, load(async (req, res, inv) => {
  const buf = INV.toPdf(inv, await INV.lines(db0, inv.id), await INV.payments(db0, inv.id), await INV.listSettings(db0), require('../lib/doc_theme').palette(req.user), res.locals.docBrand);
  await audit(db0, req.user, 'invoice_downloaded', 'invoice', inv.ref, 'PDF', null, req.ip);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${inv.ref}.pdf"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  return res.send(buf);
}));

module.exports = router;
