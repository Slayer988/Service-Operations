'use strict';
// Service Desk Reports: a hub of report categories, each report viewable on screen and downloadable as Excel, PDF or CSV.
const express = require('express');
const { q } = require('../db');
const audit = require('../lib/audit');
const reporting = require('../lib/reporting');
const u = require('../lib/util');
const R = require('../services/ticket_reports');
const { requireStaff, requirePerm } = require('../middleware/auth');
const { wrap } = require('./util');
const router = express.Router();

const view = [requireStaff, requirePerm('report.view')];
const today = () => new Date().toISOString().slice(0, 10);

function params(req) {
  let from = u.dateStr(req.query.from) || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  let to = u.dateStr(req.query.to) || today();
  if (from > to) [from, to] = [to, from];
  if (Date.parse(to) - Date.parse(from) > 800 * 86400000) from = new Date(Date.parse(to) - 800 * 86400000).toISOString().slice(0, 10);
  return { from, to, customer: u.id(req.query.customer) || null };
}
const qsOf = (p) => new URLSearchParams({ from: p.from, to: p.to, ...(p.customer ? { customer: String(p.customer) } : {}) }).toString();

router.get('/reports', ...view, wrap(async (req, res) => {
  // links from before 1.6.0: /reports?format=csv was the ticket-level export
  if (req.query.format === 'csv') return res.redirect(301, `/reports/tickets?format=csv&${qsOf(params(req))}`);
  const p = params(req);
  const customers = (await q('select id, name from customers order by name')).rows;
  res.render('staff/reports', { title: 'Service Desk Reports', categories: R.catalogue(req.user), customers, f: p, qs: qsOf(p) });
}));

router.get('/reports/:id', ...view, wrap(async (req, res) => {
  const p = params(req);
  const report = await R.run(q, req.user, req.params.id, p);
  if (!report) return res.status(404).render('error', { title: 'Not found', message: 'That report does not exist, or you do not have access to it.' });
  const format = u.oneOf(req.query.format, reporting.FORMATS, 'html');
  if (format !== 'html') await audit({ query: q }, req.user, 'report_exported', 'report', `tickets:${report.id}`, `${format} ${p.from}..${p.to}`, p.customer, req.ip);
  if (reporting.send(res, format, report, req.user)) return undefined;
  const customers = (await q('select id, name from customers order by name')).rows;
  return res.render('staff/ticket_report', { title: report.title, report, customers, f: p, qs: qsOf(p), cell: reporting.cell, category: R.CATEGORIES.find((c) => c.id === report.category) });
}));

module.exports = router;
