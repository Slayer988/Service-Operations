'use strict';
// Requests without signing in (/request). See services/guest.js for the rules.
const express = require('express');
const { q, tx } = require('../db');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const u = require('../lib/util');
const tickets = require('../services/tickets');
const G = require('../services/guest');
const { wrap } = require('./util');

const router = express.Router();
const db0 = { query: q };
const SENT = 'If that e-mail address belongs to a customer with that CSID, we have sent a 6-digit code to it.';

// everything here is for people who are not signed in; signed-in customers use the portal
router.use('/request', wrap(async (req, res, next) => {
  if (req.user) return res.redirect(req.user.kind === 'customer' ? '/portal/tickets/new' : '/tickets/new');
  if (!(await G.enabled(db0))) return res.status(404).render('guest/off', { title: 'Not available', reason: 'off' });
  if (!(await G.canSend(db0))) return res.status(503).render('guest/off', { title: 'Not available', reason: 'mail' });
  res.set('Cache-Control', 'no-store');
  return next();
}));

// ---- step 1: e-mail address and CSID
router.get('/request', (req, res) => res.render('guest/start', { title: 'Raise a request', form: {}, error: null }));

router.post('/request', wrap(async (req, res) => {
  const out = await G.requestCode(db0, { email: req.body.email, csid: req.body.csid, ip: req.ip });
  if (out.error) return res.status(400).render('guest/start', { title: 'Raise a request', form: req.body, error: out.error });
  delete req.session.guest;
  req.session.guestPending = { id: out.pendingId, email: out.email, tries: 0, at: Date.now() };
  return res.redirect('/request/code');
}));

// ---- step 2: the code from the e-mail
const pendingOf = (req) => {
  const p = req.session.guestPending;
  return p && Date.now() - p.at < G.CODE_MINUTES * 60000 ? p : null;
};
router.get('/request/code', (req, res) => {
  const p = pendingOf(req);
  if (!p) return res.redirect('/request');
  return res.render('guest/code', { title: 'Enter your code', email: p.email, sent: SENT, minutes: G.CODE_MINUTES, error: null });
});

router.post('/request/code', wrap(async (req, res) => {
  const p = pendingOf(req);
  if (!p) return res.redirect('/request');
  p.tries = (p.tries || 0) + 1;
  const out = p.id ? await tx((db) => G.checkCode(db, p.id, req.body.code)) : await G.checkCode(db0, null, req.body.code);
  if (out.ok) {
    delete req.session.guestPending;
    await new Promise((resolve, reject) => req.session.regenerate((e) => (e ? reject(e) : resolve())));        // a fresh session for the confirmed person
    req.session.guest = { ...out.ok, until: Date.now() + G.SESSION_MINUTES * 60000, count: 0 };
    return res.redirect('/request/new');
  }
  const restart = out.restart || p.tries >= G.MAX_TRIES;
  if (restart) delete req.session.guestPending;
  return res.status(400).render('guest/code', {
    title: 'Enter your code', email: p.email, sent: SENT, minutes: G.CODE_MINUTES,
    error: restart && !out.restart ? 'Too many wrong tries. Ask for a new code.' : out.error, restart,
  });
}));

// ---- step 3: the services on the CSID, and the request form
async function formFor(req) {
  const ctx = await G.context(db0, req.session.guest);
  if (!ctx) { delete req.session.guest; return null; }
  return { ctx, categories: (await settings.get(db0, 'categories', [])) || [], email: req.session.guest.email, left: G.TICKETS_PER_SESSION - (req.session.guest.count || 0) };
}

router.get('/request/new', wrap(async (req, res) => {
  const f = await formFor(req);
  if (!f) return res.redirect('/request');
  return res.render('guest/new', { title: 'Raise a request', ...f, form: { type: req.query.type === 'request' ? 'request' : 'incident' }, error: null });
}));

router.post('/request/new', wrap(async (req, res) => {
  const f = await formFor(req);
  if (!f) return res.redirect('/request');
  const g = req.session.guest;
  if ((g.count || 0) >= G.TICKETS_PER_SESSION) return res.status(400).render('guest/new', { ...f, title: 'Raise a request', form: req.body, error: `You can raise ${G.TICKETS_PER_SESSION} requests at a time. Ask for a new code to raise more.` });
  const b = req.body;
  try {
    const name = u.str(b.name, 120);
    if (!name) throw new tickets.UserError('Enter your name, so the team knows who to contact.');
    const serviceId = u.id(b.service_id);
    if (serviceId && !f.ctx.services.some((s) => Number(s.id) === serviceId)) throw new tickets.UserError('Choose one of the services listed.');
    const phone = u.str(b.phone, 40);
    const type = b.type === 'request' ? 'request' : 'incident';
    const ticket = await tx(async (db) => {
      // a registered contact of this customer with the same address: link the ticket to them, so it is in their portal list too
      const known = (await db.query(`select id, name from users where lower(email) = $1 and customer_id = $2 and kind = 'customer' and active`, [g.email, f.ctx.customer_id])).rows[0];
      const t = await tickets.createTicket(db, {
        type, customerId: f.ctx.customer_id, csidId: f.ctx.csid_id, serviceId,
        requester: { id: known ? known.id : null, email: g.email, name: known ? known.name : name },
        subject: u.str(b.subject, 200), description: [u.str(b.description, 20000), phone ? `\n\nContact phone: ${phone}` : ''].join(''), descriptionFormat: b.description_format === 'rich' ? 'rich' : 'text',
        category: f.categories.includes(b.category) ? b.category : '',
        impact: u.intIn(b.impact, 1, 3) || 2, urgency: u.intIn(b.urgency, 1, 3) || 2,
        source: 'portal', enforceActive: true, queue: b.category === 'Security' ? 'security' : 'it_services',
      });
      await db.query('update tickets set raised_by_guest = true where id = $1', [t.id]);
      await tickets.event(db, t.id, null, 'note', `Raised without signing in by ${name} <${g.email}>. The e-mail address was confirmed with a one-time code.`);
      await audit(db, null, 'guest_ticket_created', 'ticket', t.ref, `${name} <${g.email}>`, f.ctx.customer_id, req.ip);
      return t;
    });
    g.count = (g.count || 0) + 1;
    req.session.guestDone = ticket.ref;
    return res.redirect('/request/done');
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return res.status(400).render('guest/new', { ...f, title: 'Raise a request', form: b, error: err.userMessage });
  }
}));

router.get('/request/done', (req, res) => {
  const ref = req.session.guestDone;
  if (!ref) return res.redirect('/request');
  const g = req.session.guest;
  return res.render('guest/done', { title: 'Request received', ref, email: g ? g.email : '', more: !!(g && g.until > Date.now() && (g.count || 0) < G.TICKETS_PER_SESSION) });
});

router.post('/request/finish', (req, res) => {
  delete req.session.guest; delete req.session.guestPending; delete req.session.guestDone;
  return res.redirect('/login');
});

module.exports = router;
