'use strict';
// Operations Overview (formerly Business Overview): the weekly executive dashboard, with the earlier pipeline, tender and contract
// detail underneath. /business still works and goes to the new address.
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const charts = require('../lib/charts');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const u = require('../lib/util');
const B = require('../services/business');
const P = require('../services/pipeline');
const T = require('../services/tenders');
const O = require('../services/operations');
const tickets = require('../services/tickets');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const money = (v, c) => `${c} ${Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;

router.get('/business', requireStaff, (req, res) => res.redirect(301, '/operations'));

router.get('/operations', requireStaff, requirePerm('operations.view'), wrap(async (req, res) => {
  const can = (p) => perms.can(req.user, p);
  const cur = (await settings.get({ query: q }, 'default_currency', 'UGX')) || 'UGX';
  const expiringDays = Number(await settings.get({ query: q }, 'contract_expiring_days', 90)) || 90;
  const day = u.dateStr(String(req.query.week || '')) || undefined;
  const o = await O.weekly(q, req.user, day, { currency: cur, expiringDays });

  // the pipeline, tender and contract detail from before, for those allowed to see it
  let detail = null; let stageChart = ''; let pc = cur; let pt = null; let labels = {}; let tlabels = {};
  if (can('business.view')) {
    detail = await B.overview(q, can, cur, new Date().toISOString().slice(0, 10));
    labels = (await P.listSettings({ query: q })).labels; tlabels = (await T.listSettings({ query: q })).labels;
    pc = detail.pipeline ? (detail.pipeline.currencies.includes(cur) ? cur : detail.pipeline.currencies[0] || cur) : cur;
    pt = detail.pipeline && detail.pipeline.totals[pc] ? detail.pipeline.totals[pc] : null;
    stageChart = pt ? charts.hbars(P.OPEN.map((k) => ({ label: labels[k], value: pt.stages[k].value, text: `${pt.stages[k].count}` })), { labelW: 38 }) : '';
  }
  res.render('staff/operations', { title: 'Operations Overview', o, d: detail, money, cur, pc, pt, labels, tlabels, stageChart, can });
}));

router.post('/operations/highlights', requireStaff, requirePerm('operations.manage'), wrap(async (req, res) => {
  const week = u.dateStr(String(req.body.week || ''));
  try {
    await tx((db) => O.saveHighlights(db, week, req.body, req.user));
    await audit({ query: q }, req.user, 'weekly_highlights_saved', 'operations', week, '', null, req.ip);
    req.flash('success', 'Highlights saved.');
  } catch (err) {
    if (!(err instanceof tickets.UserError)) throw err;
    req.flash('error', err.userMessage || err.message);
  }
  res.redirect(`/operations?week=${week || ''}`);
}));

module.exports = router;
