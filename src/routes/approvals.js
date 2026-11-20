'use strict';
// Approvals: ask for approval of a draft quote or purchase order, approve or decline it, and the list of what is waiting for you.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const u = require('../lib/util');
const A = require('../services/approvals');
const tickets = require('../services/tickets');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const db0 = { query: q };

const back = (req, fallback) => (typeof req.body.back === 'string' && /^\/(approvals|quotes\/\d+|lpo\/\d+|changes\/\d+)(#[a-z]+)?$/.test(req.body.back) ? req.body.back : fallback);
const userError = (req, res, err, to) => { if (!(err instanceof tickets.UserError)) throw err; req.flash('error', err.userMessage); return res.redirect(to); };

router.get('/approvals', requireStaff, wrap(async (req, res) => {
  const waiting = await A.waitingFor(db0, req.user);
  const mine = [];
  for (const a of (await q(`select a.*, dc.name as decided_by_name from approvals a left join users dc on dc.id = a.decided_by
                              where a.requested_by = $1 and a.requested_at > now() - interval '60 days' order by a.id desc limit 100`, [req.user.id])).rows) {
    const item = await A.load(db0, a.entity, a.entity_id); if (item) mine.push({ ...a, item });
  }
  const decided = [];
  for (const a of (await q(`select a.*, rq.name as requested_by_name from approvals a join users rq on rq.id = a.requested_by
                              where a.decided_by = $1 and a.decided_at > now() - interval '60 days' order by a.decided_at desc limit 50`, [req.user.id])).rows) {
    const item = await A.load(db0, a.entity, a.entity_id); if (item) decided.push({ ...a, item });
  }
  res.render('staff/approvals', { title: 'Approvals', waiting, mine, decided, A, roleLabels: perms.ROLE_LABELS, isApprover: await A.isApprover(db0, req.user) });
}));

router.post('/approvals/:id(\\d+)', requireStaff, wrap(async (req, res) => {
  try {
    const decision = req.body.decision === 'approve' ? 'approved' : req.body.decision === 'decline' ? 'rejected' : '';
    const r = await tx((db) => A.decide(db, u.id(req.params.id), req.user, decision, req.body.comment, req.ip));
    req.flash('success', decision === 'approved' ? 'Approved.' : 'Declined. The person who asked can see your reason.');
    return res.redirect(back(req, `${r.href}#approval`));
  } catch (err) { return userError(req, res, err, back(req, '/approvals')); }
}));

for (const [entity, base, perm] of [['quote', '/quotes', 'quote.manage'], ['lpo', '/lpo', 'lpo.manage'], ['change', '/changes', 'change.manage']]) {
  router.post(`${base}/:id(\\d+)/approval`, requireStaff, requirePerm(perm), wrap(async (req, res) => {
    const id = u.id(req.params.id);
    try {
      await tx((db) => A.request(db, entity, id, req.user, req.ip));
      req.flash('success', 'Approval asked for. The approvers see it under Approvals and on their bell.');
    } catch (err) { return userError(req, res, err, `${base}/${id}#approval`); }
    return res.redirect(`${base}/${id}#approval`);
  }));
}

module.exports = router;
