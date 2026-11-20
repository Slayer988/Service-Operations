'use strict';
// Rating a resolved ticket from the link in the e-mail, without signing in. The link carries a signature for that ticket and that
// address, so it cannot be guessed or used for another ticket. Opening the link only shows the form (mail scanners open links too);
// the rating is recorded when the person presses Send.
const express = require('express');
const { q, tx } = require('../db');
const u = require('../lib/util');
const tickets = require('../services/tickets');
const S = require('../services/satisfaction');
const { wrap } = require('./util');

const router = express.Router();
const find = async (req) => {
  const t = (await q('select id, ref, subject, status, requester_email, requester_name, resolved_at, closed_at, satisfaction, satisfaction_comment from tickets where ref = $1', [u.str(req.params.ref, 20).toUpperCase()])).rows[0];
  return t && S.valid(t, req.params.token) ? t : null;
};
const gone = (res) => res.status(404).render('rate', { title: 'Rate our service', t: null, S, score: null, done: false, error: 'This rating link is not valid. It may have been copied incompletely.' });

router.get('/rate/:ref/:token', wrap(async (req, res) => {
  const t = await find(req); if (!t) return gone(res);
  res.set('Referrer-Policy', 'no-referrer');
  res.render('rate', { title: 'Rate our service', t, S, score: u.intIn(req.query.score, 1, 5) || t.satisfaction || null, done: false, error: S.open(t) ? null : 'This ticket can no longer be rated.' });
}));

router.post('/rate/:ref/:token', wrap(async (req, res) => {
  const t = await find(req); if (!t) return gone(res);
  try {
    const n = await tx((db) => S.rate(db, t, req.body.score, req.body.comment, 'email'));
    return res.render('rate', { title: 'Thank you', t: { ...t, satisfaction: n }, S, score: n, done: true, error: null });
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    return res.status(400).render('rate', { title: 'Rate our service', t, S, score: u.intIn(req.body.score, 1, 5), done: false, error: err.userMessage });
  }
}));

module.exports = router;
