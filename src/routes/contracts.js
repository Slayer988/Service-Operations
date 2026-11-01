'use strict';
// Contracts register (CM-001 .. CM-018) for customer, supplier and partner contracts.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const csrf = require('../lib/csrf');
const u = require('../lib/util');
const charts = require('../lib/charts');
const reporting = require('../lib/reporting');
const audit = require('../lib/audit');
const tickets = require('../services/tickets');
const C = require('../services/contracts');
const CR = require('../services/contract_reports');
const docs = require('../services/documents');
const engineers = require('../services/engineers');
const { upload, wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const view = [requireStaff, requirePerm('contract.view')];
const manage = [requireStaff, requirePerm('contract.manage')];
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'Not found.' });
const db0 = { query: q };

// Links in e-mails sent by 1.0 / 1.1 point at /renewals/<id>.
router.get(/^\/renewals(?:\/(\d+))?$/, requireStaff, wrap(async (req, res) => {
  const old = u.id(req.params[0]);
  const c = old ? (await q('select id from contracts where legacy_renewal_id = $1', [old])).rows[0] : null;
  res.redirect(301, c ? `/contracts/${c.id}` : '/contracts');
}));

async function formData(extra = {}) {
  const s = await C.listSettings(db0);
  return {
    customers: (await q('select id, name from customers order by name')).rows,
    staff: (await q(`select id, name from users where kind = 'staff' and active order by name`)).rows,
    policies: (await q('select id, name from sla_policies where active order by name')).rows,
    ...s, counterparties: C.COUNTERPARTIES, statusLabels: C.STATUS_LABELS, ...extra,
  };
}

// ---------------------------------------------------------------- register and dashboard
function filters(query) {
  const where = ['true']; const params = []; const f = {};
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
  f.q = u.str(query.q, 100);
  if (f.q) { params.push(`%${f.q}%`); const n = params.length; where.push(`(c.reference ilike $${n} or c.title ilike $${n} or c.supplier ilike $${n} or cu.name ilike $${n})`); }
  f.status = u.oneOf(query.status, [...C.STATUSES, 'live']) || ''; if (f.status === 'live') where.push(`c.status in ('active','expiring_soon','renewal_in_progress')`); else if (f.status) add('c.status = ?', f.status);
  f.type = u.str(query.type, 60); if (f.type) add('c.type = ?', f.type);
  f.kind = u.oneOf(query.kind, Object.keys(C.COUNTERPARTIES)) || ''; if (f.kind) add('c.counterparty_kind = ?', f.kind);
  f.customer = u.id(query.customer) || ''; if (f.customer) add('c.customer_id = ?', f.customer);
  f.supplier = u.str(query.supplier, 100); if (f.supplier) add('c.supplier ilike ?', `%${f.supplier}%`);
  f.owner = u.id(query.owner) || ''; if (f.owner) add('c.owner_id = ?', f.owner);
  const vmin = u.money(query.value_min); const vmax = u.money(query.value_max);
  f.value_min = vmin === null || Number.isNaN(vmin) ? '' : vmin; f.value_max = vmax === null || Number.isNaN(vmax) ? '' : vmax;
  if (f.value_min !== '') add('c.value >= ?', f.value_min); if (f.value_max !== '') add('c.value <= ?', f.value_max);
  f.from = u.dateStr(query.from) || ''; f.to = u.dateStr(query.to) || '';
  if (f.from) add('c.end_date >= ?::date', f.from); if (f.to) add('c.end_date <= ?::date', f.to);
  f.within = u.intIn(query.within, 1, 3650) || ''; if (f.within) add(`c.end_date between current_date and current_date + ?::int`, f.within);
  return { where, params, f };
}

const LIST_SQL = `select c.id, c.reference, c.title, c.type, c.status, c.start_date, c.end_date, c.value, c.currency, c.counterparty_kind, coalesce(cu.name, c.supplier) as counterparty,
                         o.name as owner, c.department, (c.end_date - current_date) as days_left
                    from contracts c left join customers cu on cu.id = c.customer_id left join users o on o.id = c.owner_id`;

router.get('/contracts', ...view, wrap(async (req, res) => {
  const { where, params, f } = filters(req.query);
  const rows = (await q(`${LIST_SQL} where ${where.join(' and ')} order by c.end_date nulls last, c.reference limit 500`, params)).rows;
  const fd = await formData();
  const d = await CR.dashboard(q, fd.defaultCurrency);
  const statusSegs = [['active', 'c0'], ['expiring_soon', 'c1'], ['renewal_in_progress', 'c2'], ['expired', 'c3'], ['suspended', 'c4']].map(([k, cls]) => ({ key: k, value: d.counts[k === 'renewal_in_progress' ? 'renewal' : k], cls }));
  const donutSegs = statusSegs.filter((s) => s.value > 0);
  res.render('staff/contracts', { title: 'Contracts', rows, f, d, ...fd, types: fd.types, statusChart: charts.donut(donutSegs), statusSegs, canManage: perms.can(req.user, 'contract.manage'),
    byCustomerChart: charts.hbars(d.byCustomer.map((x) => ({ label: x.label, value: x.n, text: `${x.n}` })), { labelW: 38 }),
    bySupplierChart: charts.hbars(d.bySupplier.map((x) => ({ label: x.label, value: x.n, text: `${x.n}` })), { labelW: 38 }),
    qs: new URLSearchParams(Object.entries(req.query).filter(([, v]) => typeof v === 'string' && v)).toString() });
}));

// Filtered register as a report (CSV, Excel or PDF)
router.get('/contracts/export', ...view, wrap(async (req, res) => {
  const { where, params } = filters(req.query);
  const rows = (await q(`${LIST_SQL} where ${where.join(' and ')} order by c.end_date nulls last, c.reference limit 5000`, params)).rows.map((r) => ({ ...r, status_label: C.STATUS_LABELS[r.status] }));
  const columns = [{ key: 'reference', header: 'Reference', width: 15 }, { key: 'title', header: 'Title', width: 30, weight: 2 }, { key: 'counterparty', header: 'Customer / supplier', width: 26, weight: 2 }, { key: 'type', header: 'Type', width: 18 },
    { key: 'status_label', header: 'Status', width: 18 }, { key: 'owner', header: 'Owner', width: 18 }, { key: 'start_date', header: 'Start', type: 'date', width: 12 }, { key: 'end_date', header: 'End', type: 'date', width: 12 },
    { key: 'value', header: 'Value', type: 'money', width: 16 }, { key: 'currency', header: 'Cur.', width: 7 }];
  await audit(db0, req.user, 'report_exported', 'report', 'contracts', `${rows.length} rows`, null, req.ip);
  if (!reporting.send(res, u.oneOf(req.query.format, ['csv', 'xlsx', 'pdf'], 'csv'), { title: 'Contract register', subtitle: `${rows.length} contracts`, columns, rows }, req.user)) res.redirect('/contracts');
}));

// ---------------------------------------------------------------- reports
router.get('/contracts/reports', ...view, wrap(async (req, res) => {
  const fd = await formData();
  res.render('staff/contract_reports', { title: 'Contract reports', reports: Object.entries(CR.REPORTS).map(([id, r]) => ({ id, title: r.title, description: r.description, params: r.params || [] })), ...fd });
}));

router.get('/contracts/reports/:id', ...view, wrap(async (req, res) => {
  const report = await CR.run(q, req.params.id, req.query);
  if (!report) return notFound(res);
  const format = u.oneOf(req.query.format, reporting.FORMATS, 'html');
  if (format !== 'html') await audit(db0, req.user, 'report_exported', 'report', `contracts:${report.id}`, format, null, req.ip);
  if (reporting.send(res, format, report, req.user)) return undefined;
  const fd = await formData();
  return res.render('staff/contract_report', { title: report.title, report, cell: reporting.cell, qs: new URLSearchParams(Object.entries(req.query).filter(([k, v]) => k !== 'format' && typeof v === 'string' && v)).toString(), ...fd, query: req.query });
}));

// ---------------------------------------------------------------- create
router.get('/contracts/new', ...manage, wrap(async (req, res) => {
  const form = { start_date: new Date().toISOString().slice(0, 10), notice_days: 60, counterparty_kind: 'customer' };
  const customer = u.id(req.query.customer_id);
  if (customer) form.customer_id = customer;
  let from = null;
  // a won tender or opportunity carries its details into the new contract (spec 6.2, 6.3)
  const tid = u.id(req.query.tender_id); const oid = u.id(req.query.opportunity_id);
  if (tid) {
    const t = (await q(`select t.id, t.ref, t.title, t.customer_id, t.issuer, t.award_value, t.est_value, t.currency, t.owner_id, t.description from tenders t where t.id = $1`, [tid])).rows[0];
    if (t) { from = { type: 'tender', id: t.id, ref: t.ref }; Object.assign(form, { title: t.title, customer_id: t.customer_id || form.customer_id, value: t.award_value || t.est_value || '', currency: t.currency, owner_id: t.owner_id, description: t.description || '', notes: `Awarded tender ${t.ref}${t.issuer ? ` (${t.issuer})` : ''}.` }); if (!t.customer_id) Object.assign(form, { counterparty_kind: 'customer', notes: `${form.notes} Issuer: ${t.issuer}. Choose the customer.` }); }
  } else if (oid) {
    const o = (await q(`select o.id, o.ref, o.name, o.customer_id, o.value, o.currency, o.owner_id, o.notes from opportunities o where o.id = $1`, [oid])).rows[0];
    if (o) { from = { type: 'opportunity', id: o.id, ref: o.ref }; Object.assign(form, { title: o.name, customer_id: o.customer_id || form.customer_id, value: o.value || '', currency: o.currency, owner_id: o.owner_id, notes: `Won opportunity ${o.ref}.` }); }
  }
  res.render('staff/contract_new', { title: 'Register a contract', form, from, ...(await formData()) });
}));

router.post('/contracts', ...manage, wrap(async (req, res) => {
  const fd = await C.listSettings(db0);
  const f = C.readFields(req.body, fd);
  const extra = {};
  const tid = u.id(req.body.tender_id); const oid = u.id(req.body.opportunity_id);
  if (tid && (await q('select 1 from tenders where id = $1', [tid])).rows.length) extra.tender_id = tid;
  if (oid && (await q('select 1 from opportunities where id = $1', [oid])).rows.length) extra.opportunity_id = oid;
  const row = await tx(async (db) => {
    const r = await C.create(db, req.user, f, req.ip, extra);
    for (const cid of String(req.body.contact_ids || '').split(',').map((x) => u.id(x.trim())).filter(Boolean)) {
      await db.query(`insert into contract_contacts (contract_id, user_id) select $1, id from users where id = $2 and kind = 'staff' on conflict do nothing`, [r.id, cid]);
    }
    if (extra.tender_id) { await db.query('insert into tender_events (tender_id, actor_id, kind, text) values ($1,$2,$3,$4)', [extra.tender_id, req.user.id, 'contract', `${req.user.name} created contract ${r.reference} from this tender.`]); await C.addEvent(db, r.id, req.user, 'link', `Created from tender (traceable on the tender page).`); }
    if (extra.opportunity_id) { await db.query('insert into opportunity_events (opportunity_id, actor_id, kind, text) values ($1,$2,$3,$4)', [extra.opportunity_id, req.user.id, 'contract', `${req.user.name} created contract ${r.reference} from this opportunity.`]); await C.addEvent(db, r.id, req.user, 'link', `Created from opportunity (traceable on the opportunity page).`); }
    return r;
  });
  req.flash('success', `Contract ${row.reference} registered.`);
  res.redirect(`/contracts/${row.id}`);
}));

// ---------------------------------------------------------------- detail
async function load(id) {
  return id ? (await q(
    `select c.*, cu.name as customer_name, cs.csid as csid_code, o.name as owner_name, p.name as policy_name, t.ref as tender_ref, op.ref as opportunity_ref,
            (c.end_date - current_date) as days_left, (c.end_date - c.start_date) as duration_days
       from contracts c left join customers cu on cu.id = c.customer_id left join csids cs on cs.id = c.csid_id left join users o on o.id = c.owner_id
       left join sla_policies p on p.id = c.sla_policy_id left join tenders t on t.id = c.tender_id left join opportunities op on op.id = c.opportunity_id where c.id = $1`, [id])).rows[0] : null;
}

router.get('/contracts/:id', ...view, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const c = await load(id);
  if (!c) return notFound(res);
  const canManage = perms.can(req.user, 'contract.manage'); const canFin = canManage || perms.can(req.user, 'contract.finance');
  const events = (await q('select e.*, u.name as actor_name from contract_events e left join users u on u.id = e.actor_id where contract_id = $1 order by e.id desc limit 200', [id])).rows;
  const contacts = (await q('select u.id, u.name from contract_contacts cc join users u on u.id = cc.user_id where cc.contract_id = $1 order by u.name', [id])).rows;
  const payments = (await q('select * from contract_payments where contract_id = $1 order by due_date, id', [id])).rows;
  const obligations = (await q(`select o.*, u.name as responsible_name, (o.status in ('open','in_progress') and o.due_date < current_date) as overdue from contract_obligations o left join users u on u.id = o.responsible_id where o.contract_id = $1 order by o.due_date nulls last, o.id`, [id])).rows;
  const targets = (await q('select * from contract_sla_targets where contract_id = $1 order by id', [id])).rows;
  const perf = (await q(`select p.*, t.target, t.direction, t.label, t.unit, ((t.direction = 'min' and p.measured >= t.target) or (t.direction = 'max' and p.measured <= t.target)) as ok
                           from contract_performance p join contract_sla_targets t on t.id = p.sla_target_id where p.contract_id = $1 order by p.period_start desc, p.id desc limit 100`, [id])).rows;
  const amendments = (await q('select a.*, u.name as by from contract_amendments a left join users u on u.id = a.created_by where a.contract_id = $1 order by a.effective_date desc, a.id desc', [id])).rows;
  const reviews = (await q('select r.*, u.name as reviewer_name from contract_reviews r join users u on u.id = r.reviewer_id where r.contract_id = $1 order by r.id desc', [id])).rows;
  const linked = c.customer_id ? (await q(`select s.id, s.name, s.status, cat.name as catalogue_name from service_contracts sc join services s on s.id = sc.service_id left join service_catalogue cat on cat.id = s.catalogue_id where sc.contract_id = $1 order by s.name`, [id])).rows : [];
  const availableServices = c.customer_id && canManage ? (await q(`select id, name from services where customer_id = $1 and id not in (select service_id from service_contracts where contract_id = $2) order by name`, [c.customer_id, id])).rows : [];
  const mail = (await q(`select kind, recipient_email, status, attempts, last_error, created_at, sent_at from notifications where contract_id = $1 order by id desc limit 20`, [id])).rows;
  const engineerHistory = c.customer_id ? await engineers.history(db0, 'contract', id) : [];
  const staff = (await q(`select id, name, available from users where kind = 'staff' and active order by name`)).rows;
  const paid = payments.filter((p) => p.status === 'paid').reduce((a, p) => a + Number(p.amount), 0);
  const scheduled = payments.reduce((a, p) => a + Number(p.amount), 0);
  const met = perf.filter((p) => p.ok).length;
  const fd = await formData();
  res.render('staff/contract', {
    title: c.title, c, events, contacts, payments, obligations, targets, perf, amendments, reviews, review: C.reviewSummary(reviews), linked, availableServices, mail, engineerHistory, staff,
    files: await docs.list(db0, 'contract', id), docKinds: docs.KINDS.contract, totals: { paid, scheduled, outstanding: scheduled - paid }, compliance: perf.length ? Math.round((met / perf.length) * 1000) / 10 : null,
    canManage, canFin, canReview: perms.can(req.user, 'contract.review'), canAssign: perms.can(req.user, 'engineer.assign'), myStages: C.stagesFor(req.user.role),
    today: new Date().toISOString().slice(0, 10), C, ...fd,
  });
}));

router.post('/contracts/:id', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const fd = await C.listSettings(db0);
  const f = C.readFields(req.body, fd);
  const changed = await tx(async (db) => {
    const ch = await C.update(db, req.user, id, f, req.ip);
    await db.query('delete from contract_contacts where contract_id = $1', [id]);
    for (const cid of String(req.body.contact_ids || '').split(',').map((x) => u.id(x.trim())).filter(Boolean)) {
      await db.query(`insert into contract_contacts (contract_id, user_id) select $1, id from users where id = $2 and kind = 'staff' on conflict do nothing`, [id, cid]);
    }
    return ch;
  });
  req.flash('success', changed.length ? 'Contract updated.' : 'Nothing changed.');
  res.redirect(`/contracts/${id}`);
}));

router.post('/contracts/:id/status', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const next = await tx((db) => C.setStatus(db, req.user, id, req.body.status, u.str(req.body.reason, 500), req.ip));
  req.flash('success', `Status is now ${C.STATUS_LABELS[next]}.`);
  res.redirect(`/contracts/${id}`);
}));

// small sub-resource actions: each loads the contract's existence through the service (404 on mismatch)
const action = (fn, message) => wrap(async (req, res) => {
  const id = u.id(req.params.id);
  if (!id || !(await q('select 1 from contracts where id = $1', [id])).rows.length) return notFound(res);
  await tx((db) => fn(db, req, id));
  if (message) req.flash('success', message);
  return res.redirect(`/contracts/${id}#${req.body._anchor || ''}`.replace(/#$/, ''));
});
const finance = [requireStaff, (req, res, next) => (perms.can(req.user, 'contract.manage') || perms.can(req.user, 'contract.finance') ? next() : res.status(403).render('error', { title: 'Not allowed', message: 'You do not have permission to do that.' }))];

router.post('/contracts/:id/obligations', ...manage, action((db, req, id) => C.addObligation(db, req.user, id, req.body), 'Added.'));
router.post('/contracts/:id/obligations/:oid', ...manage, action((db, req, id) => C.setObligation(db, req.user, id, u.id(req.params.oid), req.body.status)));
router.post('/contracts/:id/payments', ...finance, action((db, req, id) => C.addPayment(db, req.user, id, req.body), 'Payment scheduled.'));
router.post('/contracts/:id/payments/:pid', ...finance, action((db, req, id) => C.setPayment(db, req.user, id, u.id(req.params.pid), req.body.status, u.dateStr(req.body.paid_on))));
router.post('/contracts/:id/sla', ...manage, action((db, req, id) => C.addSlaTarget(db, req.user, id, req.body), 'SLA target added.'));
router.post('/contracts/:id/sla/:tid/delete', ...manage, action(async (db, req, id) => { await db.query('delete from contract_sla_targets where id = $1 and contract_id = $2', [u.id(req.params.tid), id]); await C.addEvent(db, id, req.user, 'sla', `${req.user.name} removed an SLA target.`); }));
router.post('/contracts/:id/performance', ...manage, action((db, req, id) => C.recordPerformance(db, req.user, id, req.body), 'Performance recorded.'));
router.post('/contracts/:id/amendments', ...manage, action((db, req, id) => C.addAmendment(db, req.user, id, req.body, req.ip), 'Amendment recorded.'));
router.post('/contracts/:id/reviews', requireStaff, requirePerm('contract.review'), action((db, req, id) => C.addReview(db, req.user, id, req.body, req.ip), 'Review recorded.'));

router.post('/contracts/:id/services', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id); const sid = u.id(req.body.service_id);
  const c = (await q('select customer_id from contracts where id = $1', [id])).rows[0];
  if (!c) return notFound(res);
  if (!c.customer_id || !sid) throw new tickets.UserError('Only a customer contract can cover a service. Choose a service.');
  try { await q('insert into service_contracts (service_id, contract_id, customer_id, linked_by) values ($1,$2,$3,$4) on conflict do nothing', [sid, id, c.customer_id, req.user.id]); }
  catch (e) { if (e.code === '23503') throw new tickets.UserError('That service does not belong to this customer.'); throw e; }
  await C.addEvent(db0, id, req.user, 'service', `${req.user.name} linked a service to this contract.`);
  res.redirect(`/contracts/${id}`);
}));
router.post('/contracts/:id/services/:sid/remove', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  await q('delete from service_contracts where contract_id = $1 and service_id = $2', [id, u.id(req.params.sid)]);
  await C.addEvent(db0, id, req.user, 'service', `${req.user.name} unlinked a service from this contract.`);
  res.redirect(`/contracts/${id}`);
}));

router.post('/contracts/:id/engineer', requireStaff, requirePerm('engineer.assign'), wrap(async (req, res) => {
  const id = u.id(req.params.id);
  await tx((db) => engineers.assignEngineer(db, { entity: 'contract', entityId: id, engineerId: u.id(req.body.engineer_id), backupId: u.id(req.body.backup_id),
    effectiveFrom: u.dateStr(req.body.effective_from), reason: u.str(req.body.reason, 500), actor: req.user, ip: req.ip }));
  req.flash('success', 'Contract engineer updated.');
  res.redirect(`/contracts/${id}`);
}));

router.post('/contracts/:id/resend', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const c = await load(id);
  if (!c) return notFound(res);
  const notifications = require('../services/notifications');
  let n = 0;
  await tx(async (db) => {
    for (const p of await C.recipients(db, c)) {
      await notifications.enqueue(db, { kind: 'contract_reminder', contractId: id, to: p, subject: `Contract reminder (resent): ${c.reference} ${c.title}`.slice(0, 200),
        body: `Contract ${c.reference}: ${c.title}\nStatus: ${C.STATUS_LABELS[c.status]}\nEnd date: ${c.end_date || 'not set'}\n\nOpen the contract: ${require('../config').baseUrl}/contracts/${id}\n` });
      n++;
    }
    await C.addEvent(db, id, req.user, 'resend', `${req.user.name} resent the reminder to ${n} recipient(s).`);
  });
  req.flash('success', `Reminder queued for ${n} recipient(s).`);
  res.redirect(`/contracts/${id}`);
}));

// documents (versioned)
router.post('/contracts/:id/files', requireStaff, requirePerm('contract.view'), upload.array('files', 5), csrf.protect, wrap(async (req, res) => {
  const storage = require('../lib/storage');
  const id = u.id(req.params.id);
  try {
    if (!(perms.can(req.user, 'contract.manage') || perms.can(req.user, 'contract.review') || perms.can(req.user, 'contract.finance'))) return res.status(403).render('error', { title: 'Not allowed', message: 'You do not have permission to add documents.' });
    const c = await load(id);
    if (!c) return notFound(res);
    const r = await docs.store(db0, req.files, { type: 'contract', id, customerId: c.customer_id, kind: req.body.kind, user: req.user });
    for (const s of r.stored) await C.addEvent(db0, id, req.user, 'document', `${req.user.name} added "${s.filename}" (${docs.KINDS.contract[s.kind]}, version ${s.version}).`);
    if (r.rejected.length) req.flash('error', `Some files were not kept: ${r.rejected.join('; ')}`);
    else if (r.stored.length) req.flash('success', 'Document added.');
    res.redirect(`/contracts/${id}#documents`);
  } finally { await storage.removeTmp(req.files); }
}));

module.exports = router;
