'use strict';
// Quotes: list, create (on its own or from an opportunity), edit while a draft, send, record the customer's decision, revise, and download as PDF.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const audit = require('../lib/audit');
const u = require('../lib/util');
const reporting = require('../lib/reporting');
const tickets = require('../services/tickets');
const Q = require('../services/quotes');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();
const db0 = { query: q };
const view = [requireStaff, requirePerm('quote.view')];
const manage = [requireStaff, requirePerm('quote.manage')];
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That quote does not exist.' });
const today = () => u.localDay(config.timezone);

async function formData(extra = {}) {
  const s = await Q.listSettings(db0);
  return {
    customers: (await q('select id, name from customers order by name')).rows,
    opportunities: (await q(`select o.id, o.ref, o.name, coalesce(c.name, o.prospect) as org from opportunities o left join customers c on c.id = o.customer_id
                              where o.stage not in ('won','lost') order by o.ref desc limit 500`)).rows,
    catalogue: (await q('select name from service_catalogue where active order by name')).rows.map((r) => r.name),
    currencies: s.currencies, settings: s, ...extra,
  };
}

// ---------------------------------------------------------------- list
function filters(query) {
  const where = ['true']; const params = []; const f = {};
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  f.q = u.str(query.q, 100);
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); const n = params.length; where.push(`(qu.ref ilike $${n} or qu.title ilike $${n} or qu.prospect ilike $${n} or c.name ilike $${n} or o.ref ilike $${n})`); }
  f.status = u.oneOf(query.status, [...Q.STATUSES, 'open', 'all'], 'open');
  if (f.status === 'open') where.push(`qu.status in ('draft','sent')`); else if (f.status !== 'all') add('qu.status = ?', f.status);
  f.customer = u.id(query.customer) || ''; if (f.customer) add('qu.customer_id = ?', f.customer);
  f.owner = query.owner === 'me' ? 'me' : '';
  f.latest = query.latest === '0' ? '0' : '1';                                  // by default only the newest revision of each quote
  if (f.latest === '1') where.push('not exists (select 1 from quotes nq where nq.ref = qu.ref and nq.revision > qu.revision)');
  return { where, params, f };
}

router.get('/quotes', ...view, wrap(async (req, res) => {
  const { where, params, f } = filters(req.query);
  if (f.owner === 'me') { params.push(req.user.id); where.push(`qu.owner_id = $${params.length}`); }
  const rows = (await q(`select qu.id, qu.ref, qu.revision, qu.title, qu.status, qu.currency, qu.subtotal, qu.total, qu.issue_date, qu.valid_until, coalesce(c.name, nullif(qu.prospect, '')) as org,
                                ow.name as owner_name, o.id as opportunity_id, o.ref as opportunity_ref
                           from quotes qu left join customers c on c.id = qu.customer_id join users ow on ow.id = qu.owner_id left join opportunities o on o.id = qu.opportunity_id
                          where ${where.join(' and ')} order by qu.ref desc, qu.revision desc limit 500`, params)).rows;
  const sums = {};
  for (const r of rows) if (['draft', 'sent'].includes(r.status)) { sums[r.currency] = sums[r.currency] || { n: 0, total: 0 }; sums[r.currency].n += 1; sums[r.currency].total += Number(r.subtotal); }
  res.render('staff/quotes', { title: 'Quotes', rows, f, sums, Q, customers: (await q('select id, name from customers order by name')).rows, canManage: perms.can(req.user, 'quote.manage') });
}));

// ---------------------------------------------------------------- create
router.get('/quotes/new', ...manage, wrap(async (req, res) => {
  const form = await Q.defaults(db0, u.id(req.query.opportunity), today());
  res.render('staff/quote_new', { title: 'New quote', form, ...(await formData()) });
}));

router.post('/quotes', ...manage, wrap(async (req, res) => {
  const fd = await formData();
  try {
    const h = Q.readHeader(req.body, fd);
    const quote = await tx((db) => Q.create(db, h, req.user, req.ip));
    req.flash('success', `Quote ${Q.label(quote)} created. Add its lines below.`);
    return res.redirect(`/quotes/${quote.id}#lines`);
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return res.status(400).render('staff/quote_new', { title: 'New quote', form: req.body, error: err.userMessage, ...fd });
  }
}));

// ---------------------------------------------------------------- one quote
const load = (fn) => wrap(async (req, res) => {
  const quote = await Q.get(db0, u.id(req.params.id));
  if (!quote) return notFound(res);
  return fn(req, res, quote);
});

router.get('/quotes/:id(\\d+)', ...view, load(async (req, res, quote) => {
  const lines = await Q.lines(db0, quote.id);
  const canManage = perms.can(req.user, 'quote.manage');
  res.render('staff/quote', {
    title: Q.label(quote), quote, lines, events: await Q.events(db0, quote.id), revisions: await Q.revisions(db0, quote.ref), Q, canManage,
    editable: canManage && quote.status === 'draft', moves: canManage ? Q.MOVES[quote.status] : [], revisable: canManage && Q.REVISABLE.includes(quote.status),
    blankRows: Math.max(3, 8 - lines.length), money: Q.fmtMoney, ...(await formData()),
  });
}));

router.post('/quotes/:id(\\d+)', ...manage, load(async (req, res, quote) => {
  const h = Q.readHeader(req.body, await Q.listSettings(db0));
  await tx((db) => Q.updateHeader(db, quote, h, req.user));
  req.flash('success', 'Quote details saved.');
  return res.redirect(`/quotes/${quote.id}`);
}));

router.post('/quotes/:id(\\d+)/lines', ...manage, load(async (req, res, quote) => {
  const rows = Q.readLines(req.body);
  const after = await tx((db) => Q.saveLines(db, quote, rows, req.user));
  req.flash('success', `${rows.length} line(s) saved. Total ${after.currency} ${Q.fmtMoney(after.total)}.`);
  return res.redirect(`/quotes/${quote.id}#lines`);
}));

router.post('/quotes/:id(\\d+)/status', ...manage, load(async (req, res, quote) => {
  const to = u.str(req.body.status, 20);
  const after = await tx((db) => Q.setStatus(db, quote, to, req.user, { note: req.body.note, updateOpportunity: req.body.update_opportunity === '1' }, req.ip));
  req.flash('success', `Quote ${Q.label(after)} is now ${Q.STATUS_LABELS[after.status].toLowerCase()}.`);
  return res.redirect(`/quotes/${quote.id}`);
}));

router.post('/quotes/:id(\\d+)/revise', ...manage, load(async (req, res, quote) => {
  const next = await tx((db) => Q.revise(db, quote, req.user, req.ip));
  req.flash('success', `Revision ${Q.label(next)} created as a draft. Change it, then send it.`);
  return res.redirect(`/quotes/${next.id}`);
}));

router.get('/quotes/:id(\\d+)/pdf', ...view, load(async (req, res, quote) => {
  const buf = Q.toPdf(quote, await Q.lines(db0, quote.id), await Q.listSettings(db0), require('../lib/doc_theme').palette(req.user), res.locals.docBrand);
  await audit(db0, req.user, 'quote_downloaded', 'quote', Q.label(quote), 'PDF', quote.customer_id, req.ip);
  const name = `${Q.label(quote).replace(/\s+/g, '-')}.pdf`;
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${name}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  return res.send(buf);
}));

// ---------------------------------------------------------------- the register as a file
router.get('/quotes/export', ...view, wrap(async (req, res) => {
  const { where, params } = filters(req.query);
  const rows = (await q(`select qu.ref, qu.revision, qu.title, qu.status, qu.currency, qu.subtotal, qu.tax_total, qu.total, qu.issue_date, qu.valid_until, coalesce(c.name, nullif(qu.prospect, '')) as org,
                                ow.name as owner_name, o.ref as opportunity_ref
                           from quotes qu left join customers c on c.id = qu.customer_id join users ow on ow.id = qu.owner_id left join opportunities o on o.id = qu.opportunity_id
                          where ${where.join(' and ')} order by qu.ref desc, qu.revision desc limit 5000`, params)).rows
    .map((r) => ({ ...r, number: Q.label(r), status_label: Q.STATUS_LABELS[r.status] }));
  const columns = [{ key: 'number', header: 'Quote', width: 16 }, { key: 'title', header: 'Title', width: 32, weight: 3 }, { key: 'org', header: 'Customer / prospect', width: 26, weight: 2 },
    { key: 'opportunity_ref', header: 'Opportunity', width: 14 }, { key: 'status_label', header: 'Status', width: 12 }, { key: 'currency', header: 'Cur.', width: 7 },
    { key: 'subtotal', header: 'Before tax', type: 'money', width: 16 }, { key: 'total', header: 'Total', type: 'money', width: 16 },
    { key: 'issue_date', header: 'Date', type: 'date', width: 12 }, { key: 'valid_until', header: 'Valid until', type: 'date', width: 12 }, { key: 'owner_name', header: 'Owner', width: 18 }];
  await audit(db0, req.user, 'report_exported', 'report', 'quotes', `${rows.length} rows`, null, req.ip);
  if (!reporting.send(res, u.oneOf(req.query.format, ['csv', 'xlsx', 'pdf'], 'csv'), { title: 'Quotes', subtitle: `${rows.length} quotes`, columns, rows }, req.user)) res.redirect('/quotes');
}));

module.exports = router;
