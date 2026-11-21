'use strict';
// Suppliers and contractors register (/suppliers): the register, one supplier's page, their documents, and their place on projects and tenders.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const audit = require('../lib/audit');
const storage = require('../lib/storage');
const csrf = require('../lib/csrf');
const u = require('../lib/util');
const reporting = require('../lib/reporting');
const tickets = require('../services/tickets');
const Sup = require('../services/suppliers');
const PO = require('../services/purchase_orders');
const { wrap, upload } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const db0 = { query: q };
const view = [requireStaff, requirePerm('supplier.view')];
const manage = [requireStaff, requirePerm('supplier.manage')];
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That supplier or contractor is not in the register.' });
const backTo = (v, fallback) => u.safeNext(v, fallback);

function filters(query) {
  const where = ['true']; const params = []; const f = {};
  f.q = u.str(query.q, 100);
  if (f.q) { params.push(`%${f.q.replace(/[%_\\]/g, '\\$&')}%`); const n = params.length; where.push(`(s.name ilike $${n} or s.code ilike $${n} or s.services ilike $${n} or s.contact_name ilike $${n} or s.tin ilike $${n})`); }
  f.kind = u.oneOf(query.kind, Object.keys(Sup.KINDS), ''); if (f.kind) { params.push(f.kind); where.push(`s.kind = $${params.length}`); }
  f.status = u.oneOf(query.status, [...Object.keys(Sup.STATUSES), 'all'], 'active'); if (f.status !== 'all') { params.push(f.status); where.push(`s.status = $${params.length}`); }
  return { where, params, f };
}
const LIST = (where) => `select s.*, (select count(*)::int from supplier_links l where l.supplier_id = s.id) as links,
       (select count(*)::int from supplier_documents d where d.supplier_id = s.id) as docs,
       (select count(*)::int from purchase_orders po where po.supplier_id = s.id and po.status in ('issued','received')) as open_lpos
  from suppliers s where ${where} order by s.name limit 1000`;

router.get('/suppliers', ...view, wrap(async (req, res) => {
  const { where, params, f } = filters(req.query);
  const rows = (await q(LIST(where.join(' and ')), params)).rows;
  res.render('staff/suppliers', { canLpoView: perms.can(req.user, 'lpo.view'), title: 'Suppliers & Contractors', rows, f, Sup, canManage: perms.can(req.user, 'supplier.manage') });
}));

// supplier performance: on-time delivery and quality, from the purchase orders (for those who see LPOs)
const SP = require('../services/supplier_performance');
const perfPeriod = (v) => u.oneOf(v, ['90', '365', 'all'], '365');
router.get('/suppliers/performance', ...view, requirePerm('lpo.view'), wrap(async (req, res) => {
  const today = u.localDay(require('../config').timezone);
  const period = perfPeriod(req.query.period);
  const since = period === 'all' ? null : (() => { const d = new Date(`${today}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - Number(period)); return d.toISOString().slice(0, 10); })();
  const rows = await SP.performance(db0, { since, today });
  if (req.query.format) {
    const out = rows.map((r) => ({ ...r, spend_text: Object.keys(r.spend).map((c) => `${c} ${Math.round(r.spend[c]).toLocaleString('en-US')}`).join(', '), watch_text: r.watch ? 'Watch' : '' }));
    const columns = [{ key: 'name', header: 'Supplier / contractor', width: 28, weight: 3 }, { key: 'orders', header: 'Orders', type: 'integer', width: 8 }, { key: 'delivered', header: 'Delivered', type: 'integer', width: 10 },
      { key: 'on_time_pct', header: 'On time %', type: 'integer', width: 10 }, { key: 'avg_days_late', header: 'Avg days late', type: 'integer', width: 12 }, { key: 'open_late', header: 'Late now', type: 'integer', width: 9 },
      { key: 'quality', header: 'Quality (1-5)', type: 'integer', width: 12 }, { key: 'rated', header: 'Rated', type: 'integer', width: 7 }, { key: 'spend_text', header: 'Ordered (before tax)', width: 26, weight: 2 }, { key: 'watch_text', header: '', width: 7 }];
    await audit(db0, req.user, 'report_exported', 'report', 'supplier_performance', `${rows.length} rows`, null, req.ip);
    if (reporting.send(res, u.oneOf(req.query.format, ['csv', 'xlsx', 'pdf'], 'xlsx'), { title: 'Supplier performance', subtitle: since ? `Orders issued from ${since}` : 'All orders', columns, rows: out }, req.user)) return undefined;
  }
  return res.render('staff/supplier_performance', { title: 'Supplier performance', rows, period, since, canLpoView: true, SP });
}));

router.get('/suppliers/export', ...view, wrap(async (req, res) => {
  const { where, params } = filters(req.query);
  const rows = (await q(LIST(where.join(' and ')), params)).rows.map((r) => ({ ...r, kind_label: Sup.KINDS[r.kind], status_label: Sup.STATUSES[r.status] }));
  const columns = [{ key: 'code', header: 'Code', width: 10 }, { key: 'name', header: 'Name', width: 30, weight: 3 }, { key: 'kind_label', header: 'Type', width: 16 }, { key: 'status_label', header: 'Status', width: 10 },
    { key: 'services', header: 'Supplies / does', width: 34, weight: 3 }, { key: 'tin', header: 'TIN', width: 14 }, { key: 'contact_name', header: 'Contact', width: 20 }, { key: 'contact_phone', header: 'Phone', width: 16 },
    { key: 'contact_email', header: 'E-mail', width: 26 }, { key: 'links', header: 'Projects / tenders', width: 10 }, { key: 'open_lpos', header: 'Open LPOs', width: 10 }];
  await audit(db0, req.user, 'report_exported', 'report', 'suppliers', `${rows.length} rows`, null, req.ip);
  if (!reporting.send(res, u.oneOf(req.query.format, ['csv', 'xlsx', 'pdf'], 'csv'), { title: 'Suppliers and contractors', subtitle: `${rows.length} in the register`, columns, rows }, req.user)) res.redirect('/suppliers');
}));

router.get('/suppliers/new', ...manage, (req, res) => res.render('staff/supplier_new', { title: 'Add a supplier or contractor', form: { kind: u.oneOf(req.query.kind, Object.keys(Sup.KINDS), 'contractor'), status: 'active' }, Sup, error: null }));

router.post('/suppliers', ...manage, wrap(async (req, res) => {
  try {
    const s = await tx((db) => Sup.create(db, Sup.readFields(req.body), req.user, req.ip));
    req.flash('success', `${s.name} added to the register as ${s.code}.`);
    return res.redirect(`/suppliers/${s.id}`);
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return res.status(400).render('staff/supplier_new', { title: 'Add a supplier or contractor', form: req.body, Sup, error: err.userMessage });
  }
}));

const load = (fn) => wrap(async (req, res) => {
  const s = await Sup.get(db0, u.id(req.params.id));
  if (!s) return notFound(res);
  return fn(req, res, s);
});

router.get('/suppliers/:id(\\d+)', ...view, load(async (req, res, s) => {
  const canManage = perms.can(req.user, 'supplier.manage');
  const canLpo = perms.can(req.user, 'lpo.manage');
  const links = (await q(`select l.*, p.ref as project_ref, p.name as project_name, p.status as project_status, t.ref as tender_ref, t.title as tender_title, t.status as tender_status, us.name as added_by_name
                            from supplier_links l left join projects p on p.id = l.project_id left join tenders t on t.id = l.tender_id left join users us on us.id = l.added_by
                           where l.supplier_id = $1 order by l.created_at desc`, [s.id])).rows;
  const lpos = perms.can(req.user, 'lpo.view') ? (await q(`select po.id, po.ref, po.title, po.status, po.currency, po.total, po.issue_date, po.delivery_date, p.id as project_id, p.ref as project_ref,
                                                                  (po.status = 'issued' and po.delivery_date < current_date) as late
                                                             from purchase_orders po left join projects p on p.id = po.project_id where po.supplier_id = $1 order by po.id desc limit 200`, [s.id])).rows : null;
  const trk = lpos ? await PO.tracker(db0, s.id) : null;
  const perf = lpos ? (await SP.performance(db0, { supplierId: s.id, today: u.localDay(require('../config').timezone) }))[0] || null : null;
  const settingsQ = await PO.listSettings(db0);
  res.render('staff/supplier', {
    title: `${s.code} ${s.name}`, s, Sup, PO, perf, SP, docs: await Sup.documents(db0, 'd.supplier_id = $1', [s.id]), links, lpos, trk, canManage, canLpo,
    canUpload: canManage || canLpo, events: (await q('select e.*, u.name as actor_name from supplier_events e left join users u on u.id = e.actor_id where e.supplier_id = $1 order by e.id desc limit 200', [s.id])).rows,
    projects: (await q(`select id, ref, name from projects where status not in ('completed','cancelled') order by ref desc limit 500`)).rows,
    tenders: (await q(`select id, ref, title from tenders order by id desc limit 500`)).rows,
    openLpos: lpos ? lpos.filter((x) => ['draft', 'issued', 'received'].includes(x.status)) : [], currencies: settingsQ.currencies, money: (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
    preset: { project_id: u.id(req.query.project) || '', tender_id: u.id(req.query.tender) || '', kind: u.oneOf(req.query.doc, Object.keys(Sup.DOC_KINDS), 'quote') },
  });
}));

router.post('/suppliers/:id(\\d+)', ...manage, load(async (req, res, s) => {
  await tx((db) => Sup.update(db, s, Sup.readFields(req.body), req.user, req.ip));
  req.flash('success', 'Saved.');
  return res.redirect(`/suppliers/${s.id}`);
}));

// documents: their quote, an LPO given to them, an invoice, a delivery note, registration papers ...
router.post('/suppliers/:id(\\d+)/documents', requireStaff, requirePerm('supplier.view'), upload.array('files', 5), csrf.protect, wrap(async (req, res) => {
  try {
    if (!(perms.can(req.user, 'supplier.manage') || perms.can(req.user, 'lpo.manage'))) return res.status(403).render('error', { title: 'Not allowed', message: 'You do not have permission to add supplier documents.' });
    const s = await Sup.get(db0, u.id(req.params.id));
    if (!s) return notFound(res);
    const st = await PO.listSettings(db0);
    const r = await tx((db) => Sup.storeDocuments(db, s, req.files, req.body, req.user, st.currencies));
    if (r.rejected.length) req.flash('error', `Some files were not kept: ${r.rejected.join('; ')}`);
    else req.flash('success', `${r.stored.length} document(s) added.`);
    return res.redirect(backTo(req.body.back, `/suppliers/${s.id}#documents`));
  } finally { await storage.removeTmp(req.files); }
}));

// on a project or a tender: the supplier register's managers, or that project's or tender's managers
function mayLink(user, type) {
  return perms.can(user, 'supplier.manage') || perms.can(user, type === 'project' ? 'project.manage' : 'tender.manage');
}
router.post('/suppliers/links', requireStaff, requirePerm('supplier.view'), wrap(async (req, res) => {
  const projectId = u.id(req.body.project_id); const tenderId = u.id(req.body.tender_id);
  const type = projectId ? 'project' : tenderId ? 'tender' : null;
  if (!type) throw new tickets.UserError('Choose a project or a tender.');
  if (!mayLink(req.user, type)) return res.status(403).render('error', { title: 'Not allowed', message: `You do not have permission to add suppliers to a ${type}.` });
  const s = await Sup.get(db0, u.id(req.body.supplier_id));
  if (!s) throw new tickets.UserError('Choose a supplier or contractor from the register.');
  await tx((db) => Sup.link(db, s, { type, id: projectId || tenderId }, req.body.role, req.user));
  await audit(db0, req.user, 'supplier_linked', 'supplier', s.code, `${type} ${projectId || tenderId}`, null, req.ip);
  req.flash('success', `${s.name} added.`);
  return res.redirect(backTo(req.body.back, `/suppliers/${s.id}#work`));
}));

router.post('/suppliers/links/:lid(\\d+)/delete', requireStaff, requirePerm('supplier.view'), wrap(async (req, res) => {
  const l = (await q('select * from supplier_links where id = $1', [u.id(req.params.lid)])).rows[0];
  if (!l) return res.redirect(backTo(req.body.back, '/suppliers'));
  if (!mayLink(req.user, l.project_id ? 'project' : 'tender')) return res.status(403).render('error', { title: 'Not allowed', message: 'You do not have permission to change this.' });
  const gone = await tx((db) => Sup.unlink(db, l.id, req.user));
  await audit(db0, req.user, 'supplier_unlinked', 'supplier', String(gone.supplier_id), `${gone.project_id ? 'project' : 'tender'} ${gone.project_id || gone.tender_id}`, null, req.ip);
  req.flash('success', `${gone.name} removed.`);
  return res.redirect(backTo(req.body.back, `/suppliers/${l.supplier_id}#work`));
}));

module.exports = router;
