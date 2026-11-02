'use strict';
// Knowledge Base. Staff read, search and write articles under /kb; customers read the published customer articles under /portal/help.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const u = require('../lib/util');
const markdown = require('../lib/markdown');
const kb = require('../services/kb');
const tickets = require('../services/tickets');
const { wrap } = require('./util');
const { requireStaff, requireCustomer, requirePerm } = require('../middleware/auth');

const router = express.Router();
const db0 = { query: q };
const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'That article does not exist, or you do not have access to it.' });
const view = [requireStaff, requirePerm('kb.view')];
const write = [requireStaff, requirePerm('kb.write')];
const publish = [requireStaff, requirePerm('kb.publish')];

const emptyForm = { title: '', summary: '', body: '', tags: '', category_id: '', audience: 'internal', review_by: '' };
const asForm = (a) => ({ title: a.title, summary: a.summary, body: a.body, tags: a.tags, category_id: a.category_id || '', audience: a.audience, review_by: a.review_by ? String(a.review_by).slice(0, 10) : '' });

// ================================================================ staff
router.get('/kb', ...view, wrap(async (req, res) => {
  const opts = { text: u.str(req.query.q, 100), category: req.query.category, status: req.query.status, mine: req.query.view === 'mine', due: req.query.view === 'due', archived: req.query.view === 'archived' };
  const rows = await kb.search(q, req.user, opts);
  res.render('staff/kb', {
    title: 'Knowledge Base', rows, categories: await kb.categories(q), opts, text: opts.text, plain: markdown.plain,
    canWrite: perms.can(req.user, 'kb.write'), canPublish: perms.can(req.user, 'kb.publish'), labels: kb.STATUS_LABELS, audiences: kb.AUDIENCE_LABELS,
  });
}));

router.post('/kb/categories', ...publish, wrap(async (req, res) => {
  await tx((db) => kb.addCategory(db, req.user, req.ip, req.body.name));
  req.flash('success', 'Category added.');
  res.redirect('/kb');
}));
router.post('/kb/categories/:id/delete', ...publish, wrap(async (req, res) => {
  await tx((db) => kb.removeCategory(db, req.user, req.ip, u.id(req.params.id)));
  req.flash('success', 'Category removed. Its articles stay, without a category.');
  res.redirect('/kb');
}));

// from a ticket page: the person types an article code
router.post('/kb/link', ...view, wrap(async (req, res) => {
  if (!perms.can(req.user, 'ticket.work')) return res.status(403).render('error', { title: 'Not allowed', message: 'Your role does not allow this action.' });
  const t = await tickets.getVisible(db0, req.user, u.str(req.body.ref, 40));
  if (!t) return notFound(res);
  const code = u.str(req.body.code, 20).toUpperCase();
  const a = await kb.get(q, req.user, code);
  if (!a || a.status === 'archived') { req.flash('error', `There is no article ${code || ''} you can use. Search the Knowledge Base to find its code (it looks like KB-0012).`); return res.redirect(`/tickets/${t.ref}`); }
  const added = await tx((db) => kb.linkTicket(db, req.user, req.ip, a, t));
  req.flash('success', added ? `${a.code} linked to this ticket.` : `${a.code} was already linked.`);
  return res.redirect(`/tickets/${t.ref}`);
}));

router.get('/kb/new', ...write, wrap(async (req, res) => {
  let form = { ...emptyForm }; let from = null;
  if (req.query.from) {                                                         // an article written from a solved ticket
    const t = await tickets.getVisible(db0, req.user, req.query.from);
    if (t) { form = kb.draftFromTicket(t); from = t.ref; }
  }
  res.render('staff/kb_form', { title: 'New article', a: null, form, from, categories: await kb.categories(q), canPublish: perms.can(req.user, 'kb.publish'), audiences: kb.AUDIENCE_LABELS });
}));

router.post('/kb', ...write, wrap(async (req, res) => {
  let fromId = null;
  if (req.body.from_ticket) { const t = await tickets.getVisible(db0, req.user, req.body.from_ticket); fromId = t ? t.id : null; }
  const a = await tx((db) => kb.create(db, req.user, req.ip, req.body, { fromTicketId: fromId }));
  req.flash('success', `Saved as a draft (${a.code}). ${perms.can(req.user, 'kb.publish') ? 'Publish it when it is ready.' : 'A service delivery manager publishes it when it has been checked.'}`);
  res.redirect(`/kb/${a.code}`);
}));

router.get('/kb/:code', ...view, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  if (a.status === 'published') await kb.countView(db0, a);
  const linked = await kb.ticketsOf(q, a, req.user);
  res.render('staff/kb_article', {
    title: a.title, a, html: markdown.render(a.body, { base: '/kb' }), linked, labels: kb.STATUS_LABELS, audiences: kb.AUDIENCE_LABELS,
    canEdit: kb.canEdit(req.user, a), canPublish: perms.can(req.user, 'kb.publish'), canLink: perms.can(req.user, 'ticket.work'),
  });
}));

router.get('/kb/:code/edit', ...write, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  if (!kb.canEdit(req.user, a)) { req.flash('error', 'This article is live for customers, so only a publisher can change it.'); return res.redirect(`/kb/${a.code}`); }
  return res.render('staff/kb_form', { title: `Edit ${a.code}`, a, form: asForm(a), from: null, categories: await kb.categories(q), canPublish: perms.can(req.user, 'kb.publish'), audiences: kb.AUDIENCE_LABELS });
}));

router.post('/kb/:code/status', ...publish, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  await tx((db) => kb.setStatus(db, req.user, req.ip, a, req.body.action));
  req.flash('success', { publish: 'Published.', draft: 'Taken back to draft: it is no longer visible to readers.', archive: 'Archived.' }[req.body.action] || 'Saved.');
  return res.redirect(`/kb/${a.code}`);
}));

router.post('/kb/:code/vote', ...view, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  await tx((db) => kb.vote(db, req.user, a, req.body.helpful === 'yes'));
  req.flash('success', 'Thank you for the feedback.');
  return res.redirect(`/kb/${a.code}`);
}));

router.post('/kb/:code/link', ...view, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  if (!perms.can(req.user, 'ticket.work')) return res.status(403).render('error', { title: 'Not allowed', message: 'Your role does not allow this action.' });
  const t = await tickets.getVisible(db0, req.user, u.str(req.body.ref, 40));
  if (!t) throw new tickets.UserError('Enter the reference of a ticket you can see, such as INC-000123.');
  const added = await tx((db) => kb.linkTicket(db, req.user, req.ip, a, t));
  req.flash('success', added ? `Linked to ${t.ref}.` : `${t.ref} was already linked.`);
  return res.redirect(req.body.back === 'ticket' ? `/tickets/${t.ref}` : `/kb/${a.code}`);
}));

router.post('/kb/:code/unlink', ...view, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  if (!perms.can(req.user, 'ticket.work')) return res.status(403).render('error', { title: 'Not allowed', message: 'Your role does not allow this action.' });
  const t = await tickets.getVisible(db0, req.user, u.str(req.body.ref, 40));
  if (t) await tx((db) => kb.unlinkTicket(db, req.user, req.ip, a, t));
  return res.redirect(req.body.back === 'ticket' && t ? `/tickets/${t.ref}` : `/kb/${a.code}`);
}));

router.post('/kb/:code', ...write, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  const v = await tx((db) => kb.update(db, req.user, req.ip, a, req.body, req.body.note));
  req.flash('success', `Saved (version ${v}).`);
  return res.redirect(`/kb/${a.code}`);
}));

router.get('/kb/:code/history', ...write, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  res.render('staff/kb_history', { title: `History of ${a.code}`, a, rows: await kb.versions(q, a), shown: null, html: '', canEdit: kb.canEdit(req.user, a) });
}));

router.get('/kb/:code/versions/:n', ...write, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  const v = await kb.getVersion(q, a, req.params.n);
  if (!v) return notFound(res);
  return res.render('staff/kb_history', { title: `History of ${a.code}`, a, rows: await kb.versions(q, a), shown: v, html: markdown.render(v.body, { base: '/kb' }), canEdit: kb.canEdit(req.user, a) });
}));

router.post('/kb/:code/restore/:n', ...write, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  const v = await kb.getVersion(q, a, req.params.n);
  if (!v) return notFound(res);
  const n = await tx((db) => kb.update(db, req.user, req.ip, a, { ...asForm(a), title: v.title, summary: v.summary, body: v.body }, `Restored version ${v.version}`));
  req.flash('success', `Version ${v.version} restored as version ${n}.`);
  return res.redirect(`/kb/${a.code}`);
}));

// ================================================================ customers
router.get('/portal/help', requireCustomer, wrap(async (req, res) => {
  const text = u.str(req.query.q, 100); const category = req.query.category;
  const rows = await kb.search(q, req.user, { text, category });
  res.render('portal/help', { title: 'Help Articles', rows, categories: (await kb.categories(q)).filter((c) => c.published), text, category: u.id(category) || '', plain: markdown.plain });
}));

router.get('/portal/help/:code', requireCustomer, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  await kb.countView(db0, a);
  res.render('portal/help_article', { title: a.title, a, html: markdown.render(a.body, { base: '/portal/help' }) });
}));

router.post('/portal/help/:code/vote', requireCustomer, wrap(async (req, res) => {
  const a = await kb.get(q, req.user, req.params.code);
  if (!a) return notFound(res);
  await tx((db) => kb.vote(db, req.user, a, req.body.helpful === 'yes'));
  req.flash('success', 'Thank you for the feedback.');
  return res.redirect(`/portal/help/${a.code}`);
}));

module.exports = router;
