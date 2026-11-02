'use strict';
// The search box in the top bar. Staff: tickets (any status), customers and the other areas they may use. Customers: their own tickets and help articles.
const express = require('express');
const { q } = require('../db');
const perms = require('../lib/perms');
const search = require('../lib/search');
const tickets = require('../services/tickets');
const { wrap } = require('./util');
const { requireLogin } = require('../middleware/auth');

const router = express.Router();

// areas with their own search; the link hands the words over to that area, which applies its own access rules
const AREAS = [['/contracts', 'contract.view', 'Contracts'], ['/tenders', 'tender.view', 'Tenders'], ['/pipeline', 'pipeline.view', 'Pipeline (deals)'], ['/projects', 'project.view', 'Projects'], ['/kb', 'kb.view', 'Knowledge Base']];

router.get('/search', requireLogin, wrap(async (req, res) => {
  const text = search.term(req.query.q);
  const staff = req.user.kind === 'staff';
  const out = { text, raw: String(req.query.q || '').trim().slice(0, 100), staff, tickets: [], ticketTotal: 0, customers: [], areas: [] };
  if (text) {
    // a ticket reference opens that ticket, if this person may see it
    if (search.looksLikeRef(text)) {
      const hit = await tickets.getVisible({ query: q }, req.user, text.toUpperCase());
      if (hit && !(staff && hit.needs_verification)) return res.redirect(staff ? `/tickets/${hit.ref}` : `/portal/tickets/${hit.ref}`);
    }
    if (!staff || perms.can(req.user, 'ticket.view')) {
      const params = [];
      const vis = perms.ticketVisibility(req.user, params, 't');
      params.push(search.like(text));
      const where = `${vis} and ${staff ? 'not t.needs_verification and ' : ''}${search.ticketClause(params.length, { internal: staff })}`;
      out.ticketTotal = (await q(`select count(*)::int as n from tickets t where ${where}`, params)).rows[0].n;
      out.tickets = (await q(
        `select t.ref, t.subject, t.status, t.priority, t.created_at, c.name as customer_name
           from tickets t left join customers c on c.id = t.customer_id
          where ${where} order by t.created_at desc limit 25`, params)).rows;
    }
    if (staff && perms.can(req.user, 'customer.view')) {
      out.customers = (await q(
        `select c.id, c.name, c.code, (select string_agg(x.csid, ', ' order by x.csid) from csids x where x.customer_id = c.id) as csids
           from customers c
          where c.name ilike $1 or c.code ilike $1 or exists (select 1 from csids x where x.customer_id = c.id and x.csid ilike $1)
          order by c.name limit 10`, [search.like(text)])).rows;
    }
    out.areas = staff ? AREAS.filter((a) => perms.can(req.user, a[1])).map((a) => ({ href: a[0], label: a[2] })) : [{ href: '/portal/help', label: 'Help articles' }];
  }
  res.render('search', { title: 'Search', ...out });
}));

module.exports = router;
