'use strict';
// Service catalogue management (staff). Customers see the active entries in the portal.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const settings = require('../lib/settings');
const u = require('../lib/util');
const catalogue = require('../services/catalogue');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const manage = [requireStaff, requirePerm('catalogue.manage')];
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'Not found.' });
const categories = async () => (await settings.get({ query: q }, 'categories', [])) || [];

router.get('/catalogue', requireStaff, wrap(async (req, res) => {
  const rows = (await q(
    `select c.*, p.name as policy_name, (select count(*)::int from services s where s.catalogue_id = c.id) as in_use
       from service_catalogue c left join sla_policies p on p.id = c.sla_policy_id order by c.active desc, c.sort_order, c.name`)).rows;
  const policies = (await q('select id, name from sla_policies where active order by name')).rows;
  res.render('staff/catalogue', { title: 'Service Catalogue', rows, policies, categories: await categories(), icons: catalogue.ICONS, canManage: perms.can(req.user, 'catalogue.manage') });
}));

router.post('/catalogue', ...manage, wrap(async (req, res) => {
  const cats = await categories();
  const id = await tx((db) => catalogue.create(db, req.user, req.ip, req.body, cats));
  req.flash('success', 'Service added to the catalogue.');
  res.redirect(`/catalogue/${id}`);
}));

router.get('/catalogue/:id', requireStaff, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const e = id ? (await q('select c.*, (select count(*)::int from services s where s.catalogue_id = c.id) as in_use from service_catalogue c where c.id = $1', [id])).rows[0] : null;
  if (!e) return notFound(res);
  const customers = (await q(
    `select cu.id, cu.name, s.name as service_name, s.id as service_id, s.status from services s join customers cu on cu.id = s.customer_id where s.catalogue_id = $1 order by cu.name`, [id])).rows;
  const policies = (await q('select id, name from sla_policies where active order by name')).rows;
  res.render('staff/catalogue_entry', { title: e.name, e, customers, policies, categories: await categories(), icons: catalogue.ICONS, canManage: perms.can(req.user, 'catalogue.manage') });
}));

router.post('/catalogue/:id', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id); const cats = await categories();
  await tx((db) => catalogue.update(db, req.user, req.ip, id, req.body, cats));
  req.flash('success', 'Catalogue entry saved.');
  res.redirect(`/catalogue/${id}`);
}));

router.post('/catalogue/:id/delete', ...manage, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const r = await tx((db) => catalogue.remove(db, req.user, req.ip, id));
  req.flash('success', r.deleted ? 'Catalogue entry deleted.' : `It is used by ${r.used} customer service(s), so it was retired instead (hidden from new requests; history is kept).`);
  res.redirect(r.deleted ? '/catalogue' : `/catalogue/${id}`);
}));

module.exports = router;
