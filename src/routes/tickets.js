'use strict';
// Staff workspace: dashboard, ticket queue, ticket handling, verification queue, attachments.
const express = require('express');
const fs = require('fs');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const settings = require('../lib/settings');
const storage = require('../lib/storage');
const audit = require('../lib/audit');
const csrf = require('../lib/csrf');
const u = require('../lib/util');
const tickets = require('../services/tickets');
const dashboard = require('../services/dashboard');
const catalogue = require('../services/catalogue');
const config = require('../config');
const { upload, wrap, saveUploads, ticketTimeline } = require('./util');
const { requireStaff, requireLogin, requirePerm } = require('../middleware/auth');

const router = express.Router();
const { BREACHED, OPEN } = dashboard;

router.get('/', requireStaff, wrap(async (req, res, next) => {
  // business-only roles (BD, bid, finance, legal, SDE ...) have no ticket queue: their home is the business overview
  if (!perms.can(req.user, 'ticket.view')) return res.redirect(perms.can(req.user, 'operations.view') ? '/operations' : '/account');
  const d = await dashboard.staff(q, req.user, config.timezone, u.oneOf(req.query.tab, ['open', 'in_progress', 'resolved'], 'open'));
  const categories = (await settings.get({ query: q }, 'categories', [])) || [];
  const extra = {};
  if (perms.can(req.user, 'mail.view')) {
    extra.mailDown = (await q(`select address from mailboxes where enabled and alert_state = 'alerted' ${perms.can(req.user, 'security.view') ? '' : `and queue <> 'security'`} order by id`)).rows.map((r) => r.address);
  }
  if (perms.can(req.user, 'mail.manage')) {
    extra.failedMail = (await q(`select count(*)::int as n from notifications where status = 'failed' and created_at > now() - interval '7 days'`)).rows[0].n;
  }
  res.render('staff/dashboard', { title: 'Dashboard', d, extra, tiles: dashboard.serviceTiles(await catalogue.featured(q), categories), catIcon: dashboard.catIcon });
}));

router.get('/tickets', requireStaff, requirePerm('ticket.view'), wrap(async (req, res) => {
  const params = [];
  const vis = perms.ticketVisibility(req.user, params, 't');
  const where = [vis, 'not t.needs_verification'];
  const view = u.oneOf(req.query.view, ['open', 'all', 'mine', 'unassigned', 'breached', 'closed'], 'open');
  if (view === 'open') where.push(OPEN);
  if (view === 'closed') where.push(`not (${OPEN})`);
  if (view === 'mine') { params.push(req.user.id); where.push(`${OPEN} and t.assignee_id = $${params.length}`); }
  if (view === 'unassigned') where.push(`${OPEN} and t.assignee_id is null`);
  if (view === 'breached') where.push(`${OPEN} and ${BREACHED}`);
  const type = u.oneOf(req.query.type, ['incident', 'request']); if (type) { params.push(type); where.push(`t.type = $${params.length}`); }
  const pr = u.intIn(req.query.priority, 1, 4); if (pr) { params.push(pr); where.push(`t.priority = $${params.length}`); }
  const cu = u.id(req.query.customer); if (cu) { params.push(cu); where.push(`t.customer_id = $${params.length}`); }
  const queue = u.oneOf(req.query.queue, ['it_services', 'security']); if (queue) { params.push(queue); where.push(`t.queue = $${params.length}`); }
  const text = u.str(req.query.q, 100);
  if (text) { params.push(`%${text.replace(/[%_\\]/g, '\\$&')}%`); where.push(`(t.subject ilike $${params.length} or t.ref ilike $${params.length} or t.requester_email ilike $${params.length})`); }
  const page = Math.max(1, u.intIn(req.query.page, 1, 100000) || 1);
  const total = (await q(`select count(*)::int as n from tickets t where ${where.join(' and ')}`, params)).rows[0].n;
  const rows = (await q(
    `select t.ref, t.subject, t.status, t.priority, t.queue, t.tier, t.created_at, t.response_due, t.resolution_due, t.responded_at, t.resolved_at, t.paused_at,
            c.name as customer_name, a.name as assignee_name
       from tickets t left join customers c on c.id = t.customer_id left join users a on a.id = t.assignee_id
      where ${where.join(' and ')} order by t.priority, t.created_at desc limit 50 offset ${(page - 1) * 50}`, params)).rows;
  const customers = (await q('select id, name from customers order by name')).rows;
  res.render('staff/tickets', { title: 'Tickets', rows, view, page, pages: Math.max(1, Math.ceil(total / 50)), total, customers,
    f: { type: type || '', priority: pr || '', customer: cu || '', queue: queue || '', q: text } });
}));

// ---- create on behalf of a customer
async function newTicketData() {
  const customers = (await q(`select id, name from customers where status = 'active' order by name`)).rows;
  const categories = (await settings.get({ query: q }, 'categories', [])) || [];
  return { customers, categories };
}

router.get('/api/customers/:id/structure', requireStaff, wrap(async (req, res) => {
  if (!['ticket.create_for_customer', 'ticket.verify', 'renewal.manage'].some((p) => perms.can(req.user, p))) return res.status(403).json({ error: 'forbidden' });
  const id = u.id(req.params.id);
  if (!id) return res.status(400).json({ error: 'bad id' });
  const csids = (await q('select id, csid from csids where customer_id = $1 order by csid', [id])).rows;
  const services = (await q('select id, csid_id, name from services where customer_id = $1 order by name', [id])).rows;
  const sites = (await q('select id, name from sites where customer_id = $1 order by name', [id])).rows;
  const contacts = (await q(`select id, name, email from users where customer_id = $1 and active order by name`, [id])).rows;
  const contracts = (await q('select id, reference from contracts where customer_id = $1 order by reference', [id])).rows;
  return res.json({ csids, services, sites, contacts, contracts });
}));

router.get('/tickets/new', requireStaff, requirePerm('ticket.create_for_customer'), wrap(async (req, res) => {
  const data = await newTicketData();
  res.render('staff/new', { title: 'New ticket', ...data, form: { category: data.categories.includes(req.query.category) ? req.query.category : '', type: req.query.type === 'request' ? 'request' : 'incident' } });
}));

router.post('/tickets/new', requireStaff, requirePerm('ticket.create_for_customer'), upload.array('files', 5), csrf.protect, wrap(async (req, res) => {
  try {
    const b = req.body;
    const categories = (await settings.get({ query: q }, 'categories', [])) || [];
    const st = await settings.getAll({ query: q }, ['attachment_blocked_ext', 'attachment_max_mb']);
    const customerId = u.id(b.customer_id);
    if (!customerId) throw new tickets.UserError('Choose the customer.');
    const ticket = await tx(async (db) => {
      let requester = null;
      const rid = u.id(b.requester_id);
      if (rid) requester = (await db.query(`select id, name, email from users where id = $1 and customer_id = $2 and kind = 'customer' and active`, [rid, customerId])).rows[0];
      if (rid && !requester) throw new tickets.UserError('That contact does not belong to this customer.');
      const queue = b.queue === 'security' && perms.can(req.user, 'security.view') ? 'security' : 'it_services';
      const t = await tickets.createTicket(db, {
        type: b.type === 'request' ? 'request' : 'incident', queue, customerId, csidId: u.id(b.csid_id), serviceId: u.id(b.service_id), siteId: u.id(b.site_id),
        requester: requester || { email: '', name: '' }, subject: u.str(b.subject, 200), description: u.str(b.description, 20000),
        category: categories.includes(b.category) ? b.category : '', impact: u.intIn(b.impact, 1, 3) || 2, urgency: u.intIn(b.urgency, 1, 3) || 2,
        source: 'agent', actor: req.user, enforceActive: false,
      });
      const rejected = await saveUploads(db, req, t, req.user, st);
      if (rejected.length) req.flash('error', 'Some files were not attached: ' + rejected.join('; '));
      return t;
    });
    req.flash('success', `Ticket ${ticket.ref} created.`);
    res.redirect(`/tickets/${ticket.ref}`);
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    res.status(400).render('staff/new', { title: 'New ticket', ...(await newTicketData()), form: req.body, error: err.userMessage });
  } finally { await storage.removeTmp(req.files); }
}));

// ---- verification queue
router.get('/verification', requireStaff, requirePerm('ticket.verify'), wrap(async (req, res) => {
  const params = []; const vis = perms.ticketVisibility(req.user, params, 't');
  const rows = (await q(
    `select t.ref, t.subject, t.queue, t.requester_email, t.requester_name, t.created_at from tickets t
      where t.needs_verification and t.status = 'new' and ${vis} order by t.created_at`, params)).rows;
  res.render('staff/verification', { title: 'Verification queue', rows });
}));

// ---- ticket detail and actions
router.get('/tickets/:ref', requireStaff, requirePerm('ticket.view'), wrap(async (req, res) => {
  const ticket = await tickets.getVisible({ query: q }, req.user, req.params.ref);
  if (!ticket) return res.status(404).render('error', { title: 'Not found', message: 'That ticket does not exist, or you do not have access to it.' });
  if (ticket.queue === 'security') await audit({ query: q }, req.user, 'security_ticket_viewed', 'ticket', ticket.ref, '', ticket.customer_id, req.ip);
  const { timeline, attachments } = await ticketTimeline({ query: q }, req.user, ticket);
  const st = await settings.getAll({ query: q }, ['resolution_codes']);
  const staff = (await q(`select id, name, role from users where kind = 'staff' and active order by name`)).rows
    .filter((s) => ticket.queue !== 'security' || perms.can(s, 'security.view'));
  const customers = ticket.needs_verification ? (await q(`select id, name from customers where status = 'active' order by name`)).rows : [];
  res.render('staff/ticket', { title: ticket.ref, ticket, timeline, attachments, staff, customers, resolutionCodes: st.resolution_codes || [],
    canWork: perms.can(req.user, 'ticket.work'), canVerify: perms.can(req.user, 'ticket.verify'), canSla: perms.can(req.user, 'ticket.sla_note') });
}));

async function act(req, res, perm, fn) {
  if (!perms.can(req.user, perm)) return res.status(403).render('error', { title: 'Not allowed', message: 'Your role does not allow this action.' });
  const ticket = await tickets.getVisible({ query: q }, req.user, req.params.ref);
  if (!ticket) return res.status(404).render('error', { title: 'Not found', message: 'That ticket does not exist, or you do not have access to it.' });
  await tx((db) => fn(db, ticket));
  return res.redirect(`/tickets/${ticket.ref}`);
}

router.post('/tickets/:ref/comment', requireStaff, upload.array('files', 5), csrf.protect, wrap(async (req, res) => {
  try {
    const st = await settings.getAll({ query: q }, ['attachment_blocked_ext', 'attachment_max_mb']);
    await act(req, res, 'ticket.work', async (db, ticket) => {
      const t = await tickets.addComment(db, ticket, { author: req.user, body: req.body.body, internal: req.body.internal === 'on', source: 'agent' });
      const rejected = await saveUploads(db, req, t, req.user, st);
      if (rejected.length) req.flash('error', 'Some files were not attached: ' + rejected.join('; '));
      req.flash('success', 'Comment added.');
    });
  } finally { await storage.removeTmp(req.files); }
}));

router.post('/tickets/:ref/status', requireStaff, wrap(async (req, res) => {
  await act(req, res, 'ticket.work', async (db, ticket) => {
    const status = u.oneOf(req.body.status, tickets.ALL_STATUSES);
    if (!status || status === 'new') throw new tickets.UserError('Choose a status.');
    await tickets.setStatus(db, ticket, status, req.user, { resolutionCode: req.body.resolution_code, resolutionNote: u.str(req.body.resolution_note, 5000) });
    req.flash('success', 'Status updated.');
  });
}));

router.post('/tickets/:ref/assign', requireStaff, wrap(async (req, res) => {
  await act(req, res, 'ticket.assign', async (db, ticket) => {
    await tickets.assign(db, ticket, u.id(req.body.assignee_id), req.user);
    req.flash('success', 'Assignment updated.');
  });
}));

router.post('/tickets/:ref/priority', requireStaff, wrap(async (req, res) => {
  await act(req, res, 'ticket.work', async (db, ticket) => {
    const impact = u.intIn(req.body.impact, 1, 3); const urgency = u.intIn(req.body.urgency, 1, 3);
    if (!impact || !urgency) throw new tickets.UserError('Choose impact and urgency.');
    await tickets.reprioritise(db, ticket, impact, urgency, req.user);
    req.flash('success', 'Priority updated.');
  });
}));

router.post('/tickets/:ref/billing', requireStaff, wrap(async (req, res) => {
  await act(req, res, 'ticket.work', async (db, ticket) => {
    const nc = req.body.non_chargeable === '1';
    if (nc !== !!ticket.non_chargeable) {
      await db.query('update tickets set non_chargeable = $2, updated_at = now() where id = $1', [ticket.id, nc]);
      await db.query('insert into ticket_events (ticket_id, actor_id, kind, text, internal) values ($1,$2,$3,$4,true)', [ticket.id, req.user.id, 'billing', nc ? `${req.user.name} marked the ticket as non-chargeable.` : `${req.user.name} marked the ticket as chargeable.`]);
      await audit(db, req.user, 'ticket_billing', 'ticket', ticket.ref, nc ? 'non-chargeable' : 'chargeable', ticket.customer_id, req.ip);
    }
    req.flash('success', 'Billing updated.');
  });
}));

router.post('/tickets/:ref/escalate', requireStaff, wrap(async (req, res) => {
  await act(req, res, 'ticket.work', async (db, ticket) => {
    await tickets.escalate(db, ticket, req.body.tier, req.user, u.str(req.body.reason, 300));
    req.flash('success', 'Ticket escalated.');
  });
}));

router.post('/tickets/:ref/sla-note', requireStaff, wrap(async (req, res) => {
  await act(req, res, 'ticket.sla_note', async (db, ticket) => {
    await db.query('update tickets set breach_cause = $2, breach_action = $3 where id = $1', [ticket.id, u.str(req.body.breach_cause, 1000), u.str(req.body.breach_action, 1000)]);
    await audit(db, req.user, 'sla_breach_note', 'ticket', ticket.ref, '', ticket.customer_id, req.ip);
    req.flash('success', 'SLA note saved.');
  });
}));

router.post('/tickets/:ref/verify', requireStaff, wrap(async (req, res) => {
  await act(req, res, 'ticket.verify', async (db, ticket) => {
    if (req.body.action === 'reject') {
      await tickets.setStatus(db, ticket, 'cancelled', req.user);
      await tickets.event(db, ticket.id, req.user, 'verification', `${req.user.name} rejected the message as not a valid request.`, true);
      req.flash('success', 'Rejected.');
      return;
    }
    await tickets.verifyTicket(db, ticket, {
      customerId: u.id(req.body.customer_id), csidId: u.id(req.body.csid_id), serviceId: u.id(req.body.service_id),
      siteId: u.id(req.body.site_id), requesterId: u.id(req.body.requester_id),
    }, req.user);
    await audit(db, req.user, 'ticket_verified', 'ticket', ticket.ref, '', u.id(req.body.customer_id), req.ip);
    req.flash('success', 'Verified and routed.');
  });
}));

// ---- attachment download: same visibility rules as the ticket itself, for staff and customers
router.get('/attachments/:id', requireLogin, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const a = id ? (await q('select a.* from attachments a where a.id = $1 and a.ticket_id is not null', [id])).rows[0] : null;
  const ticketRow = a ? (await q('select ref from tickets where id = $1', [a.ticket_id])).rows[0] : null;
  const ticket = ticketRow ? await tickets.getVisible({ query: q }, req.user, ticketRow.ref) : null;
  if (!a || !ticket) return res.status(404).render('error', { title: 'Not found', message: 'File not found.' });
  if (ticket.queue === 'security') await audit({ query: q }, req.user, 'security_attachment_downloaded', 'attachment', a.id, a.filename, ticket.customer_id, req.ip);
  const file = storage.attachmentPath(a.storage_name);
  if (!fs.existsSync(file)) return res.status(404).render('error', { title: 'Not found', message: 'The stored file is missing.' });
  res.set({
    'Content-Type': 'application/octet-stream', 'X-Content-Type-Options': 'nosniff',
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(a.filename)}`, 'Content-Security-Policy': "default-src 'none'",
  });
  return res.sendFile(file);
}));

module.exports = router;
