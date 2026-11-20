'use strict';
// Purchase orders (LPOs): list, raise (on its own or against a supplier quote, contract, project, tender or customer quote), edit while a
// draft, issue, record receipt, close or cancel, attach signed copies and delivery notes, and download as PDF.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const audit = require('../lib/audit');
const storage = require('../lib/storage');
const csrf = require('../lib/csrf');
const u = require('../lib/util');
const reporting = require('../lib/reporting');
const tickets = require('../services/tickets');
const Q = require('../services/quotes');
const PO = require('../services/purchase_orders');
const Sup = require('../services/suppliers');
const A = require('../services/approvals');
const { wrap, upload } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');
const config = require('../config');

const router = express.Router();
const db0 = { query: q };
const view = [requireStaff, requirePerm('lpo.view')];
const manage = [requireStaff, requirePerm('lpo.manage')];
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That purchase order does not exist.' });

async function formData(extra = {}) {
  const s = await PO.listSettings(db0);
  return {
    suppliers: (await q(`select id, code, name, kind from suppliers where status = 'active' order by name`)).rows,
    supplierQuotes: (await q(`select d.id, d.supplier_id, d.reference, d.amount, d.currency, d.doc_date, a.filename, s.name as supplier_name from supplier_documents d
                                join attachments a on a.id = d.attachment_id join suppliers s on s.id = d.supplier_id where d.kind = 'quote' order by d.id desc limit 500`)).rows,
    contracts: (await q(`select id, reference, title from contracts where status not in ('closed','terminated','expired') order by id desc limit 500`)).rows,
    projects: (await q(`select id, ref, name from projects where status not in ('completed','cancelled') order by ref desc limit 500`)).rows,
    tenders: (await q(`select id, ref, title from tenders order by id desc limit 500`)).rows,
    customerQuotes: (await q(`select id, ref, revision, title from quotes where status in ('sent','accepted') order by id desc limit 500`)).rows,
    catalogue: (await q('select name from service_catalogue where active order by name')).rows.map((r) => r.name),
    currencies: s.currencies, settings: s, ...extra,
  };
}

function filters(query) {
  const where = ['true']; const params = []; const f = {};
  f.q = u.str(query.q, 100);
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); const n = params.length; where.push(`(po.ref ilike $${n} or po.title ilike $${n} or s.name ilike $${n})`); }
  f.status = u.oneOf(query.status, [...PO.STATUSES, 'open', 'late', 'all'], 'open');
  if (f.status === 'open') where.push(`po.status in ('draft','issued','received')`);
  else if (f.status === 'late') where.push(`po.status = 'issued' and po.delivery_date < current_date`);
  else if (f.status !== 'all') { params.push(f.status); where.push(`po.status = $${params.length}`); }
  f.supplier = u.id(query.supplier) || ''; if (f.supplier) { params.push(f.supplier); where.push(`po.supplier_id = $${params.length}`); }
  f.project = u.id(query.project) || ''; if (f.project) { params.push(f.project); where.push(`po.project_id = $${params.length}`); }
  return { where, params, f };
}
const LIST = (where) => `select po.id, po.ref, po.title, po.status, po.currency, po.subtotal, po.total, po.issue_date, po.delivery_date, s.id as supplier_id, s.name as supplier_name,
       p.ref as project_ref, p.id as project_id, ow.name as owner_name,
       (po.status = 'issued' and po.delivery_date < current_date) as late
  from purchase_orders po join suppliers s on s.id = po.supplier_id left join projects p on p.id = po.project_id join users ow on ow.id = po.owner_id
 where ${where} order by po.id desc limit 1000`;

router.get('/lpo', ...view, wrap(async (req, res) => {
  const { where, params, f } = filters(req.query);
  const rows = (await q(LIST(where.join(' and ')), params)).rows;
  const sums = {};
  for (const r of rows) if (['issued', 'received'].includes(r.status)) { sums[r.currency] = sums[r.currency] || { n: 0, total: 0 }; sums[r.currency].n += 1; sums[r.currency].total += Number(r.total); }
  res.render('staff/lpos', { title: 'Purchase orders (LPO)', rows, f, sums, PO, money: Q.fmtMoney, canManage: perms.can(req.user, 'lpo.manage'),
    suppliers: (await q('select id, name from suppliers order by name')).rows, trk: await PO.tracker(db0, f.supplier || null) });
}));

router.get('/lpo/export', ...view, wrap(async (req, res) => {
  const { where, params, f } = filters(req.query);
  const rows = (await q(LIST(where.join(' and ')), params)).rows.map((r) => ({ ...r, status_label: PO.STATUS_LABELS[r.status] }));
  const columns = [{ key: 'ref', header: 'LPO', width: 14 }, { key: 'title', header: 'For', width: 30, weight: 3 }, { key: 'supplier_name', header: 'Supplier / contractor', width: 28, weight: 2 },
    { key: 'project_ref', header: 'Project', width: 12 }, { key: 'status_label', header: 'Status', width: 11 }, { key: 'currency', header: 'Cur.', width: 7 },
    { key: 'subtotal', header: 'Before tax', type: 'money', width: 16 }, { key: 'total', header: 'Total', type: 'money', width: 16 },
    { key: 'issue_date', header: 'Date', type: 'date', width: 12 }, { key: 'delivery_date', header: 'Deliver by', type: 'date', width: 12 }, { key: 'owner_name', header: 'Raised by', width: 18 }];
  await audit(db0, req.user, 'report_exported', 'report', 'lpo', `${rows.length} rows`, null, req.ip);
  if (!reporting.send(res, u.oneOf(req.query.format, ['csv', 'xlsx', 'pdf'], 'csv'), { title: f.status === 'late' ? 'Late purchase orders' : 'Purchase orders', subtitle: `${rows.length} orders`, columns, rows }, req.user)) res.redirect('/lpo');
}));

router.get('/lpo/new', ...manage, wrap(async (req, res) => {
  const from = {};
  for (const k of ['supplier', 'supplier_doc', 'contract', 'project', 'tender', 'customer_quote']) from[k] = u.id(req.query[k]) || '';
  const form = await PO.defaults(db0, from, u.localDay(config.timezone));
  res.render('staff/lpo_new', { title: 'New purchase order', form, error: null, ...(await formData()) });
}));

router.post('/lpo', ...manage, wrap(async (req, res) => {
  const fd = await formData();
  try {
    const po = await tx((db) => PO.create(db, PO.readHeader(req.body, fd), req.user, req.ip));
    req.flash('success', `${po.ref} raised as a draft. Add its lines below.`);
    return res.redirect(`/lpo/${po.id}#lines`);
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return res.status(400).render('staff/lpo_new', { title: 'New purchase order', form: req.body, error: err.userMessage, ...fd });
  }
}));

const load = (fn) => wrap(async (req, res) => {
  const po = await PO.get(db0, u.id(req.params.id));
  if (!po) return notFound(res);
  return fn(req, res, po);
});

router.get('/lpo/:id(\\d+)', ...view, load(async (req, res, po) => {
  const lines = await PO.lines(db0, po.id);
  const canManage = perms.can(req.user, 'lpo.manage');
  const ap = po.status === 'draft' ? await A.state(db0, 'lpo', await A.load(db0, 'lpo', po.id)) : null;
  let moves = canManage ? PO.MOVES[po.status] : [];
  if (ap && ap.needed.length && !ap.complete) moves = moves.filter((m) => m !== 'issued');
  const apDecider = !!(ap && ap.pending && A.canDecide(req.user, ap.pending.record.roles) && req.user.id !== Number(ap.pending.record.requested_by) && req.user.id !== Number(po.owner_id));
  res.render('staff/lpo', {
    title: po.ref, po, lines, PO, Sup, canManage, editable: canManage && po.status === 'draft', moves, ap, apDecider, A, roleLabels: perms.ROLE_LABELS, money: Q.fmtMoney,
    events: await PO.events(db0, po.id), docs: await Sup.documents(db0, 'd.purchase_order_id = $1', [po.id]),
    blankRows: Math.max(3, 8 - lines.length), ...(await formData()),
  });
}));

router.post('/lpo/:id(\\d+)', ...manage, load(async (req, res, po) => {
  await tx(async (db) => PO.updateHeader(db, po, PO.readHeader(req.body, await PO.listSettings(db)), req.user));
  req.flash('success', 'Order details saved.');
  return res.redirect(`/lpo/${po.id}`);
}));

router.post('/lpo/:id(\\d+)/lines', ...manage, load(async (req, res, po) => {
  const after = await tx((db) => PO.saveLines(db, po, Q.readLines(req.body), req.user));
  req.flash('success', `Lines saved. Total ${after.currency} ${Q.fmtMoney(after.total)}.`);
  return res.redirect(`/lpo/${po.id}#lines`);
}));

router.post('/lpo/:id(\\d+)/status', ...manage, load(async (req, res, po) => {
  const after = await tx((db) => PO.setStatus(db, po, u.str(req.body.status, 20), req.user, { note: req.body.note }, req.ip));
  req.flash('success', `${after.ref} is now ${PO.STATUS_LABELS[after.status].toLowerCase()}.`);
  return res.redirect(`/lpo/${po.id}`);
}));

router.get('/lpo/:id(\\d+)/pdf', ...view, load(async (req, res, po) => {
  const buf = PO.toPdf(po, await PO.lines(db0, po.id), await PO.listSettings(db0), require('../lib/doc_theme').palette(req.user), res.locals.docBrand);
  await audit(db0, req.user, 'lpo_downloaded', 'lpo', po.ref, 'PDF', null, req.ip);
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${po.ref}.pdf"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  return res.send(buf);
}));

// signed copy, delivery note, invoice: kept with the supplier's documents and linked to this order
router.post('/lpo/:id(\\d+)/files', requireStaff, requirePerm('lpo.manage'), upload.array('files', 5), csrf.protect, wrap(async (req, res) => {
  try {
    const po = await PO.get(db0, u.id(req.params.id));
    if (!po) return notFound(res);
    const s = await Sup.get(db0, po.supplier_id);
    const st = await PO.listSettings(db0);
    const kind = u.oneOf(req.body.kind, ['lpo', 'delivery_note', 'invoice', 'other'], 'other');
    const r = await tx(async (db) => {
      const out = await Sup.storeDocuments(db, s, req.files, { ...req.body, kind, purchase_order_id: po.id, project_id: po.project_id, tender_id: po.tender_id }, req.user, st.currencies);
      if (out.stored.length) await PO.addEvent(db, po.id, req.user, `${req.user.name} attached ${Sup.DOC_KINDS[kind].toLowerCase()}: ${out.stored.join(', ')}.`);
      return out;
    });
    if (r.rejected.length) req.flash('error', `Some files were not kept: ${r.rejected.join('; ')}`); else req.flash('success', 'Document attached.');
    return res.redirect(`/lpo/${po.id}#documents`);
  } finally { await storage.removeTmp(req.files); }
}));

module.exports = router;
