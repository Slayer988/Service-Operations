'use strict';
// Customers (tenants): one CSID each, sites, services (from the service catalogue, each covered by any number of contracts),
// customer users, and the execution engineers of services.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const password = require('../lib/password');
const audit = require('../lib/audit');
const u = require('../lib/util');
const tickets = require('../services/tickets');
const engineers = require('../services/engineers');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const view = [requireStaff, requirePerm('customer.view')];
const manage = [requireStaff, requirePerm('customer.manage')];
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'Not found.' });

/** A customer has exactly one CSID. Returns it, creating it when the customer has none yet. */
async function ensureCsid(db, customerId, actor, ip) {
  const have = (await db.query('select * from csids where customer_id = $1 order by id limit 1', [customerId])).rows[0];
  if (have) return have;
  const n = (await db.query("select nextval('csid_seq') as n")).rows[0].n;
  const code = `CS-${String(n).padStart(6, '0')}`;
  const r = await db.query('insert into csids (csid, customer_id) values ($1,$2) returning *', [code, customerId]);
  await audit(db, actor, 'csid_created', 'csid', code, '', customerId, ip);
  return r.rows[0];
}

router.get('/customers', ...view, wrap(async (req, res) => {
  const rows = (await q(
    `select c.*, (select csid from csids x where x.customer_id = c.id order by id limit 1) as csid,
            (select count(*)::int from services s where s.customer_id = c.id) as services,
            (select count(*)::int from contracts k where k.customer_id = c.id) as contracts,
            (select count(*)::int from users us where us.customer_id = c.id and us.active) as users
       from customers c order by c.name`)).rows;
  res.render('staff/customers', { title: 'Customers', rows });
}));

router.post('/customers', manage, wrap(async (req, res) => {
  const name = u.str(req.body.name, 120); const code = u.str(req.body.code, 20).toUpperCase();
  if (!name || !/^[A-Z0-9-]{2,20}$/.test(code)) throw new tickets.UserError('Enter a name and a short code (letters, digits, hyphen).');
  let id;
  try {
    await tx(async (db) => {
      const r = await db.query('insert into customers (name, code, industry) values ($1,$2,$3) returning id', [name, code, u.str(req.body.industry, 80)]);
      id = r.rows[0].id;
      await audit(db, req.user, 'customer_created', 'customer', id, name, id, req.ip);
      await ensureCsid(db, id, req.user, req.ip);
    });
  } catch (e) {
    if (e.code === '23505') throw new tickets.UserError('A customer with that name or code already exists.');
    throw e;
  }
  req.flash('success', 'Customer created, with its CSID.');
  return res.redirect(`/customers/${id}`);
}));

async function customerPage(req, res, extra = {}) {
  const id = u.id(req.params.id);
  const customer = id ? (await q('select * from customers where id = $1', [id])).rows[0] : null;
  if (!customer) return notFound(res);
  const sites = (await q('select * from sites where customer_id = $1 order by name', [id])).rows;
  const csid = (await q('select * from csids where customer_id = $1 order by id limit 1', [id])).rows[0] || null;
  const services = (await q(
    `select s.*, o.name as owner_name, p.name as policy_name, cat.name as catalogue_name,
            (select string_agg(c.reference, ', ' order by c.reference) from service_contracts sc join contracts c on c.id = sc.contract_id where sc.service_id = s.id) as contract_refs,
            (select count(*)::int from service_contracts sc where sc.service_id = s.id) as contract_count,
            (select e.name from engineer_assignments a join users e on e.id = a.engineer_id where a.entity = 'service' and a.service_id = s.id
                and a.effective_from <= current_date and (a.effective_to is null or a.effective_to >= current_date) order by a.id desc limit 1) as engineer_name
       from services s left join users o on o.id = s.owner_id left join sla_policies p on p.id = s.sla_policy_id left join service_catalogue cat on cat.id = s.catalogue_id
      where s.customer_id = $1 order by s.name`, [id])).rows;
  const contracts = perms.can(req.user, 'contract.view') ? (await q(
    `select c.id, c.reference, c.title, c.type, c.status, c.start_date, c.end_date, p.name as policy_name,
            (select count(*)::int from service_contracts sc where sc.contract_id = c.id) as services
       from contracts c left join sla_policies p on p.id = c.sla_policy_id where c.customer_id = $1 order by c.end_date nulls last, c.reference`, [id])).rows : [];
  const users = (await q('select id, name, email, role, active, auth_source, last_login_at from users where customer_id = $1 order by name', [id])).rows;
  const staff = (await q(`select id, name from users where kind = 'staff' and active order by name`)).rows;
  const catalogue = (await q('select id, name, description from service_catalogue where active order by sort_order, name')).rows;
  const policies = (await q('select id, name from sla_policies where active order by name')).rows;
  const used = (await q(
    `select (select count(*)::int from tickets where customer_id = $1) as tickets, (select count(*)::int from contracts where customer_id = $1) as contracts,
            (select count(*)::int from services where customer_id = $1) as services, (select count(*)::int from opportunities where customer_id = $1) as opportunities,
            (select count(*)::int from tenders where customer_id = $1) as tenders`, [id])).rows[0];
  const canDelete = !Object.values(used).some((n) => n > 0);
  return res.render('staff/customer', { title: customer.name, customer, sites, csid, services, contracts, users, staff, catalogue, policies, used, canDelete,
    canManage: perms.can(req.user, 'customer.manage'), canContract: perms.can(req.user, 'contract.manage'), canContractView: perms.can(req.user, 'contract.view'), ...extra });
}

router.get('/customers/:id', ...view, wrap(async (req, res) => customerPage(req, res)));

router.post('/customers/:id', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const status = u.oneOf(req.body.status, ['active', 'suspended'], 'active');
  const name = u.str(req.body.name, 120);
  if (!name) throw new tickets.UserError('Enter a customer name.');
  try {
    const r = await q('update customers set name = $2, notes = $3, status = $4, industry = $5 where id = $1 returning id',
      [id, name, u.str(req.body.notes, 2000), status, u.str(req.body.industry, 80)]);
    if (!r.rows[0]) return notFound(res);
  } catch (e) { if (e.code === '23505') throw new tickets.UserError('Another customer already has that name.'); throw e; }
  await audit({ query: q }, req.user, 'customer_updated', 'customer', id, `status ${status}`, id, req.ip);
  req.flash('success', 'Saved. History is kept when a customer is suspended.');
  return res.redirect(`/customers/${id}`);
}));

// Only a customer that nothing refers to can be deleted (a typo, a duplicate). Otherwise suspend it: history is never lost.
router.post('/customers/:id/delete', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const customer = id ? (await q('select * from customers where id = $1', [id])).rows[0] : null;
  if (!customer) return notFound(res);
  if (u.str(req.body.confirm, 40).toUpperCase() !== customer.code) throw new tickets.UserError(`To delete, type the customer code (${customer.code}) exactly.`);
  try {
    await tx(async (db) => {
      await db.query('select 1 from customers where id = $1 for update', [id]);
      const n = (await db.query(
        `select (select count(*) from tickets where customer_id = $1) + (select count(*) from contracts where customer_id = $1) + (select count(*) from services where customer_id = $1)
              + (select count(*) from opportunities where customer_id = $1) + (select count(*) from tenders where customer_id = $1) as n`, [id])).rows[0].n;
      if (Number(n) > 0) throw new tickets.UserError('This customer has tickets, contracts, services, opportunities or tenders. Suspend it instead; history is kept.');
      await db.query('delete from users where customer_id = $1', [id]);
      await db.query('delete from sites where customer_id = $1', [id]);
      await db.query('delete from csids where customer_id = $1', [id]);
      await db.query('delete from customers where id = $1', [id]);
      await audit(db, req.user, 'customer_deleted', 'customer', id, `${customer.name} (${customer.code})`, null, req.ip);
    });
  } catch (e) {
    if (e.code === '23503') throw new tickets.UserError('This customer is still referenced by other records. Suspend it instead; history is kept.');
    throw e;
  }
  req.flash('success', `Customer ${customer.name} deleted.`);
  return res.redirect('/customers');
}));

// ---- sites
router.post('/customers/:id/sites', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id); const name = u.str(req.body.name, 120);
  if (!name) throw new tickets.UserError('Enter a site name.');
  try { await q('insert into sites (customer_id, name, address) values ($1,$2,$3)', [id, name, u.str(req.body.address, 300)]); }
  catch (e) { if (e.code === '23505') throw new tickets.UserError('That site already exists.'); throw e; }
  res.redirect(`/customers/${id}`);
}));

router.post('/sites/:id', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id); const name = u.str(req.body.name, 120);
  if (!name) throw new tickets.UserError('Enter a site name.');
  let r;
  try { r = await q('update sites set name = $2, address = $3 where id = $1 returning customer_id', [id, name, u.str(req.body.address, 300)]); }
  catch (e) { if (e.code === '23505') throw new tickets.UserError('Another site of this customer has that name.'); throw e; }
  if (!r.rows[0]) return notFound(res);
  await audit({ query: q }, req.user, 'site_updated', 'site', id, name, r.rows[0].customer_id, req.ip);
  res.redirect(`/customers/${r.rows[0].customer_id}`);
}));

router.post('/sites/:id/delete', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const s = (await q('select * from sites where id = $1', [id])).rows[0];
  if (!s) return notFound(res);
  try { await q('delete from sites where id = $1', [id]); }
  catch (e) { if (e.code === '23503') throw new tickets.UserError('This site is used by a service or a ticket, so it cannot be removed.'); throw e; }
  await audit({ query: q }, req.user, 'site_deleted', 'site', id, s.name, s.customer_id, req.ip);
  req.flash('success', 'Site removed.');
  res.redirect(`/customers/${s.customer_id}`);
}));

// ---- the customer's single CSID
router.post('/customers/:id/csids', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  await tx(async (db) => {
    if (!(await db.query('select 1 from customers where id = $1 for update', [id])).rows.length) throw new tickets.UserError('Customer not found.', 404);
    const have = (await db.query('select csid from csids where customer_id = $1 limit 1', [id])).rows[0];
    if (have) throw new tickets.UserError(`This customer already has its one CSID (${have.csid}).`);
    const c = await ensureCsid(db, id, req.user, req.ip);
    req.flash('success', `CSID ${c.csid} created.`);
  });
  res.redirect(`/customers/${id}`);
}));

router.post('/csids/:id/status', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const r = await q('update csids set status = $2, description = $3 where id = $1 returning customer_id, csid', [id, u.oneOf(req.body.status, ['active', 'suspended', 'ended'], 'active'), u.str(req.body.description, 300)]);
  if (!r.rows[0]) return notFound(res);
  await audit({ query: q }, req.user, 'csid_status', 'csid', r.rows[0].csid, req.body.status, r.rows[0].customer_id, req.ip);
  return res.redirect(`/customers/${r.rows[0].customer_id}`);
}));

// ---- services (taken from the service catalogue)
router.post('/customers/:id/services', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  if (!(await q('select 1 from customers where id = $1', [id])).rows.length) return notFound(res);
  const cat = u.id(req.body.catalogue_id) ? (await q('select id, name from service_catalogue where id = $1 and active', [u.id(req.body.catalogue_id)])).rows[0] : null;
  if (!cat) throw new tickets.UserError('Choose a service from the catalogue.');
  const name = u.str(req.body.name, 120) || cat.name;
  let newId;
  try {
    await tx(async (db) => {
      const csid = await ensureCsid(db, id, req.user, req.ip);
      const r = await db.query(
        `insert into services (csid_id, customer_id, catalogue_id, service_type, name, description, start_date, end_date, owner_id, sla_policy_id, site_id)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning id`,
        [csid.id, id, cat.id, cat.name, name, u.str(req.body.description, 500), u.dateStr(req.body.start_date), u.dateStr(req.body.end_date),
          u.id(req.body.owner_id), u.id(req.body.sla_policy_id), u.id(req.body.site_id)]);
      newId = r.rows[0].id;
      await audit(db, req.user, 'service_created', 'service', name, cat.name, id, req.ip);
    });
  } catch (e) {
    if (e.code === '23503') throw new tickets.UserError('The site does not belong to this customer.');
    throw e;
  }
  req.flash('success', 'Service added. Link the contracts that cover it on the service page.');
  return res.redirect(`/services/${newId}`);
}));

router.post('/services/:id', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const name = u.str(req.body.name, 120);
  if (!name) throw new tickets.UserError('Enter a service name.');
  const r = await q(
    `update services set name = $2, description = $3, status = $4, start_date = $5, end_date = $6, sla_policy_id = $7, owner_id = $8, site_id = $9 where id = $1 returning customer_id`,
    [id, name, u.str(req.body.description, 500), u.oneOf(req.body.status, ['active', 'suspended', 'ended'], 'active'), u.dateStr(req.body.start_date), u.dateStr(req.body.end_date),
      u.id(req.body.sla_policy_id), u.id(req.body.owner_id), u.id(req.body.site_id)]).catch((e) => {
    if (e.code === '23503') throw new tickets.UserError('The site does not belong to this customer.');
    throw e;
  });
  if (!r.rows[0]) return notFound(res);
  await audit({ query: q }, req.user, 'service_updated', 'service', id, `status ${req.body.status}`, r.rows[0].customer_id, req.ip);
  req.flash('success', 'Service saved.');
  return res.redirect(`/services/${id}`);
}));

router.get('/services/:id', ...view, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const service = id ? (await q(
    `select s.*, c.name as customer_name, cs.csid as csid_code, cat.name as catalogue_name
       from services s join customers c on c.id = s.customer_id join csids cs on cs.id = s.csid_id left join service_catalogue cat on cat.id = s.catalogue_id where s.id = $1`, [id])).rows[0] : null;
  if (!service) return notFound(res);
  const staff = (await q(`select id, name, available from users where kind = 'staff' and active order by name`)).rows;
  const linked = (await q(
    `select c.id, c.reference, c.title, c.type, c.status, c.start_date, c.end_date, p.name as policy_name
       from service_contracts sc join contracts c on c.id = sc.contract_id left join sla_policies p on p.id = c.sla_policy_id where sc.service_id = $1 order by c.start_date desc`, [id])).rows;
  const available = (await q(
    `select id, reference, title from contracts where customer_id = $1 and id not in (select contract_id from service_contracts where service_id = $2) order by reference`,
    [service.customer_id, id])).rows;
  const sites = (await q('select id, name from sites where customer_id = $1 order by name', [service.customer_id])).rows;
  const policies = (await q('select id, name from sla_policies where active order by name')).rows;
  const governing = await tickets.governingContract({ query: q }, id);
  res.render('staff/service', { title: service.name, service, staff, linked, available, sites, policies, governingId: governing ? governing.id : null,
    history: await engineers.history({ query: q }, 'service', id), canManage: perms.can(req.user, 'customer.manage'), canLink: perms.can(req.user, 'contract.manage'),
    canViewContracts: perms.can(req.user, 'contract.view'), canAssign: perms.can(req.user, 'engineer.assign'), today: new Date().toISOString().slice(0, 10) });
}));

// A service may be covered by any number of contracts; each contract must belong to the same customer (enforced by the database too).
router.post('/services/:id/contracts', requireStaff, requirePerm('contract.manage'), wrap(async (req, res) => {
  const id = u.id(req.params.id); const cid = u.id(req.body.contract_id);
  const s = (await q('select id, customer_id from services where id = $1', [id])).rows[0];
  if (!s) return notFound(res);
  if (!cid) throw new tickets.UserError('Choose a contract.');
  try {
    await q('insert into service_contracts (service_id, contract_id, customer_id, linked_by) values ($1,$2,$3,$4) on conflict do nothing', [id, cid, s.customer_id, req.user.id]);
  } catch (e) { if (e.code === '23503') throw new tickets.UserError('That contract does not belong to this customer.'); throw e; }
  await audit({ query: q }, req.user, 'service_contract_linked', 'service', id, `contract ${cid}`, s.customer_id, req.ip);
  res.redirect(`/services/${id}`);
}));

router.post('/services/:id/contracts/:cid/remove', requireStaff, requirePerm('contract.manage'), wrap(async (req, res) => {
  const id = u.id(req.params.id); const cid = u.id(req.params.cid);
  const r = await q('delete from service_contracts where service_id = $1 and contract_id = $2 returning customer_id', [id, cid]);
  if (r.rows[0]) await audit({ query: q }, req.user, 'service_contract_unlinked', 'service', id, `contract ${cid}`, r.rows[0].customer_id, req.ip);
  res.redirect(`/services/${id}`);
}));

router.post('/services/:id/engineer', requireStaff, requirePerm('engineer.assign'), wrap(async (req, res) => {
  const id = u.id(req.params.id);
  await tx((db) => engineers.assignEngineer(db, { entity: 'service', entityId: id, engineerId: u.id(req.body.engineer_id), backupId: u.id(req.body.backup_id),
    effectiveFrom: u.dateStr(req.body.effective_from), reason: u.str(req.body.reason, 500), actor: req.user, ip: req.ip }));
  req.flash('success', 'Execution engineer updated. The change is recorded in the history.');
  res.redirect(`/services/${id}`);
}));

// ---- customer users (created by staff; the customer IT administrator can add more in the portal)
router.post('/customers/:id/users', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const email = u.email(req.body.email); const name = u.str(req.body.name, 120);
  const role = u.oneOf(req.body.role, ['customer_user', 'customer_admin'], 'customer_user');
  if (!email || !name) throw new tickets.UserError('Enter a name and a valid email address.');
  if ((await q('select 1 from users where lower(email) = $1', [email])).rows.length) throw new tickets.UserError('That email address is already registered.');
  const temp = password.randomPassword();
  const r = await q(`insert into users (email, name, kind, role, customer_id, password_hash, password_changed_at) values ($1,$2,'customer',$3,$4,$5,now()) returning id`,
    [email, name, role, id, await password.hash(temp)]);
  await audit({ query: q }, req.user, 'user_created', 'user', r.rows[0].id, `${email} as ${role}`, id, req.ip);
  req.flash('success', `User created. First password (shown once): ${temp}`);
  res.redirect(`/customers/${id}`);
}));

router.post('/customers/:id/users/:uid', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id); const uid = u.id(req.params.uid);
  const target = (await q(`select * from users where id = $1 and customer_id = $2 and kind = 'customer'`, [uid, id])).rows[0];
  if (!target) return notFound(res);
  const name = u.str(req.body.name, 120) || target.name;
  const role = u.oneOf(req.body.role, ['customer_user', 'customer_admin'], target.role);
  const active = req.body.active === 'on';
  await q('update users set name = $2, role = $3, active = $4 where id = $1', [uid, name, role, active]);
  await audit({ query: q }, req.user, 'user_updated', 'user', uid, `${target.email}: role ${role}, ${active ? 'active' : 'inactive'}`, id, req.ip);
  req.flash('success', 'User saved.');
  res.redirect(`/customers/${id}`);
}));

router.post('/customers/:id/users/:uid/reset-password', manage, wrap(async (req, res) => {
  const id = u.id(req.params.id); const uid = u.id(req.params.uid);
  const target = (await q(`select * from users where id = $1 and customer_id = $2 and kind = 'customer' and auth_source = 'local'`, [uid, id])).rows[0];
  if (!target) throw new tickets.UserError('That user cannot have a password reset here.');
  const temp = password.randomPassword();
  await q('update users set password_hash = $2, password_changed_at = now(), failed_logins = 0, locked_until = null where id = $1', [uid, await password.hash(temp)]);
  await audit({ query: q }, req.user, 'password_reset', 'user', uid, target.email, id, req.ip);
  req.flash('success', `Password for ${target.email} reset. New password (shown once): ${temp}`);
  res.redirect(`/customers/${id}`);
}));

module.exports = router;
