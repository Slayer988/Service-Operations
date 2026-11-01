'use strict';
// Customer self-service portal (PORT-001 .. PORT-005). Everything here is scoped to req.user.customer_id,
// which comes from the session, never from the request.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const settings = require('../lib/settings');
const storage = require('../lib/storage');
const password = require('../lib/password');
const audit = require('../lib/audit');
const csrf = require('../lib/csrf');
const u = require('../lib/util');
const tickets = require('../services/tickets');
const dashboard = require('../services/dashboard');
const catalogue = require('../services/catalogue');
const { upload, wrap, saveUploads, ticketTimeline } = require('./util');
const { requireCustomer } = require('../middleware/auth');

const router = express.Router();

async function formData(user) {
  const cs = (await q(`select id, csid, description from csids where customer_id = $1 and status = 'active' order by csid`, [user.customer_id])).rows;
  const sv = (await q(`select id, csid_id, name, service_type from services where customer_id = $1 and status = 'active' order by name`, [user.customer_id])).rows;
  const sites = (await q('select id, name from sites where customer_id = $1 order by name', [user.customer_id])).rows;
  const categories = (await settings.get({ query: q }, 'categories', [])) || [];
  return { csids: cs, services: sv, sites, categories };
}

router.get('/', requireCustomer, wrap(async (req, res) => {
  const d = await dashboard.customer(q, req.user, u.oneOf(req.query.tab, ['open', 'in_progress', 'resolved'], 'open'));
  const categories = (await settings.get({ query: q }, 'categories', [])) || [];
  res.render('portal/home', { title: 'Dashboard', d, tiles: dashboard.serviceTiles(await catalogue.featured(q), categories), catIcon: dashboard.catIcon });
}));

router.get('/tickets', requireCustomer, wrap(async (req, res) => {
  const params = [];
  const vis = perms.ticketVisibility(req.user, params, 't');
  const view = req.query.view === 'closed' ? 'closed' : 'open';
  const cond = view === 'open' ? `t.status not in ('resolved','closed','cancelled')` : `t.status in ('resolved','closed','cancelled')`;
  let search = '';
  const text = u.str(req.query.q, 100);
  if (text) { params.push(`%${text.replace(/[%_\\]/g, '\\$&')}%`); search = ` and (t.subject ilike $${params.length} or t.ref ilike $${params.length})`; }
  const rows = (await q(
    `select t.ref, t.subject, t.status, t.priority, t.created_at, t.updated_at, s.name as service_name
       from tickets t left join services s on s.id = t.service_id
      where ${vis} and ${cond}${search} order by t.updated_at desc limit 200`, params)).rows;
  res.render('portal/tickets', { title: 'My tickets', rows, view, search: text });
}));

router.get('/tickets/new', requireCustomer, wrap(async (req, res) => {
  const data = await formData(req.user);
  res.render('portal/new', { title: 'New ticket', ...data, form: { category: data.categories.includes(req.query.category) ? req.query.category : '', type: req.query.type === 'request' ? 'request' : 'incident' } });
}));

router.post('/tickets/new', requireCustomer, upload.array('files', 5), csrf.protect, wrap(async (req, res) => {
  try {
    const b = req.body;
    const type = b.type === 'request' ? 'request' : 'incident';
    const categories = (await settings.get({ query: q }, 'categories', [])) || [];
    const st = await settings.getAll({ query: q }, ['attachment_blocked_ext', 'attachment_max_mb']);
    const ticket = await tx(async (db) => {
      const t = await tickets.createTicket(db, {
        type, customerId: req.user.customer_id, csidId: u.id(b.csid_id), serviceId: u.id(b.service_id), siteId: u.id(b.site_id),
        requester: { id: req.user.id, email: req.user.email, name: req.user.name },
        subject: u.str(b.subject, 200), description: u.str(b.description, 20000),
        category: categories.includes(b.category) ? b.category : '',
        impact: u.intIn(b.impact, 1, 3) || 2, urgency: u.intIn(b.urgency, 1, 3) || 2,
        source: 'portal', actor: req.user, enforceActive: true,
        queue: b.category === 'Security' ? 'security' : 'it_services',
      });
      const rejected = await saveUploads(db, req, t, req.user, st);
      if (rejected.length) req.flash('error', 'Some files were not attached: ' + rejected.join('; '));
      return t;
    });
    req.flash('success', `Ticket ${ticket.ref} created.`);
    res.redirect(`/portal/tickets/${ticket.ref}`);
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    res.status(400).render('portal/new', { title: 'New ticket', ...(await formData(req.user)), form: req.body, error: err.userMessage });
  } finally {
    await storage.removeTmp(req.files);
  }
}));

router.get('/tickets/:ref', requireCustomer, wrap(async (req, res) => {
  const ticket = await tickets.getVisible({ query: q }, req.user, req.params.ref);
  if (!ticket) return res.status(404).render('error', { title: 'Not found', message: 'That ticket does not exist, or you do not have access to it.' });
  const { timeline, attachments } = await ticketTimeline({ query: q }, req.user, ticket);
  const reopenDays = Number(await settings.get({ query: q }, 'reopen_window_days', 5));
  return res.render('portal/ticket', { title: ticket.ref, ticket, timeline, attachments, reopenDays });
}));

async function withTicket(req, res, fn) {
  const ticket = await tickets.getVisible({ query: q }, req.user, req.params.ref);
  if (!ticket) return res.status(404).render('error', { title: 'Not found', message: 'That ticket does not exist, or you do not have access to it.' });
  await tx((db) => fn(db, ticket));
  return res.redirect(`/portal/tickets/${ticket.ref}`);
}

router.post('/tickets/:ref/comment', requireCustomer, upload.array('files', 5), csrf.protect, wrap(async (req, res) => {
  try {
    const st = await settings.getAll({ query: q }, ['attachment_blocked_ext', 'attachment_max_mb']);
    await withTicket(req, res, async (db, ticket) => {
      if (['closed', 'cancelled'].includes(ticket.status)) throw new tickets.UserError('This ticket is closed. Use "Reopen" or create a new ticket.');
      const t = await tickets.addComment(db, ticket, { author: req.user, body: req.body.body, source: 'portal' });
      const rejected = await saveUploads(db, req, t, req.user, st);
      if (rejected.length) req.flash('error', 'Some files were not attached: ' + rejected.join('; '));
      req.flash('success', 'Comment added.');
    });
  } finally { await storage.removeTmp(req.files); }
}));

router.post('/tickets/:ref/confirm', requireCustomer, wrap(async (req, res) => {
  await withTicket(req, res, async (db, ticket) => {
    if (ticket.status !== 'resolved') throw new tickets.UserError('Only a resolved ticket can be confirmed.');
    const rating = u.intIn(req.body.rating, 1, 5);
    const t = await tickets.setStatus(db, ticket, 'closed', req.user);
    if (rating) await db.query('update tickets set satisfaction = $2, satisfaction_comment = $3 where id = $1', [t.id, rating, u.str(req.body.feedback, 1000)]);
    req.flash('success', 'Thank you. The ticket is closed.');
  });
}));

router.post('/tickets/:ref/reopen', requireCustomer, wrap(async (req, res) => {
  await withTicket(req, res, async (db, ticket) => {
    if (!['resolved', 'closed'].includes(ticket.status)) throw new tickets.UserError('This ticket is not resolved.');
    const reason = u.str(req.body.reason, 2000);
    if (!reason) throw new tickets.UserError('Please tell us what is still wrong.');
    const t = await tickets.setStatus(db, ticket, 'open', req.user);
    await tickets.addComment(db, t, { author: req.user, body: `Reopened by customer: ${reason}`, source: 'portal' });
    req.flash('success', 'Ticket reopened.');
  });
}));

router.post('/tickets/:ref/cancel', requireCustomer, wrap(async (req, res) => {
  await withTicket(req, res, async (db, ticket) => {
    if (ticket.status !== 'new') throw new tickets.UserError('Work has already started. Add a comment to ask the team to cancel it.');
    await tickets.setStatus(db, ticket, 'cancelled', req.user);
    req.flash('success', 'Ticket cancelled.');
  });
}));

// ---- the service catalogue, as customers see it
router.get('/catalogue', requireCustomer, wrap(async (req, res) => {
  const rows = (await q(`select name, description, icon, category, request_type from service_catalogue where active order by sort_order, name`)).rows;
  res.render('portal/catalogue', { title: 'Service Catalogue', rows });
}));

// ---- services and users of the customer's own organisation
router.get('/services', requireCustomer, wrap(async (req, res) => {
  const cs = (await q('select id, csid, description, status from csids where customer_id = $1 order by csid', [req.user.customer_id])).rows;
  const sv = (await q('select id, csid_id, name, service_type, status, start_date, end_date from services where customer_id = $1 order by name', [req.user.customer_id])).rows;
  res.render('portal/services', { title: 'My services', csids: cs, services: sv });
}));

function requireCustomerAdmin(req, res, next) {
  if (!req.user || req.user.role !== 'customer_admin') return res.status(403).render('error', { title: 'Not allowed', message: 'Only your organisation\'s IT administrator can do this.' });
  return next();
}

router.get('/users', requireCustomer, requireCustomerAdmin, wrap(async (req, res) => {
  const rows = (await q('select id, name, email, role, active, last_login_at from users where customer_id = $1 order by name', [req.user.customer_id])).rows;
  res.render('portal/users', { title: 'Our users', rows, newPassword: null });
}));

router.post('/users', requireCustomer, requireCustomerAdmin, wrap(async (req, res) => {
  const email = u.email(req.body.email); const name = u.str(req.body.name, 120);
  const role = u.oneOf(req.body.role, ['customer_user', 'customer_admin'], 'customer_user');
  if (!email || !name) throw new tickets.UserError('Enter a name and a valid email address.');
  const exists = await q('select 1 from users where lower(email) = $1', [email]);
  if (exists.rows.length) throw new tickets.UserError('That email address is already registered.');
  const temp = password.randomPassword();
  const r = await q(`insert into users (email, name, kind, role, customer_id, password_hash, password_changed_at) values ($1,$2,'customer',$3,$4,$5, now()) returning id`,
    [email, name, role, req.user.customer_id, await password.hash(temp)]);
  await audit({ query: q }, req.user, 'user_created', 'user', r.rows[0].id, `${email} as ${role}`, req.user.customer_id, req.ip);
  const rows = (await q('select id, name, email, role, active, last_login_at from users where customer_id = $1 order by name', [req.user.customer_id])).rows;
  res.render('portal/users', { title: 'Our users', rows, newPassword: { email, password: temp } });
}));

router.post('/users/:id/toggle', requireCustomer, requireCustomerAdmin, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  if (id === req.user.id) throw new tickets.UserError('You cannot disable your own account.');
  const r = await q('update users set active = not active where id = $1 and customer_id = $2 returning active, email', [id, req.user.customer_id]);
  if (!r.rows[0]) return res.status(404).render('error', { title: 'Not found', message: 'User not found.' });
  await audit({ query: q }, req.user, r.rows[0].active ? 'user_enabled' : 'user_disabled', 'user', id, r.rows[0].email, req.user.customer_id, req.ip);
  req.flash('success', 'Updated.');
  return res.redirect('/portal/users');
}));

module.exports = router;
