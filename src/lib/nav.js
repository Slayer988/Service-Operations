'use strict';
// Sidebar menus. Only modules that exist and that the person may use are listed; no dead links.
const perms = require('./perms');

/** ctx: { path, query } of the current request; counts: { verification }. Returns groups of items { label, href, icon, badge, on }. */
function build(user, ctx, counts = {}) {
  if (!user) return [];
  const path = ctx.path || '/'; const query = ctx.query || {};
  const starts = (...p) => p.some((x) => path === x || path.startsWith(`${x}/`));
  const can = (p) => perms.can(user, p);

  if (user.kind === 'customer') {
    const items = [
      { label: 'Dashboard', href: '/portal', icon: 'home', on: path === '/portal' },
      { label: 'My Requests', href: '/portal/tickets', icon: 'doc', on: path === '/portal/tickets' || /^\/portal\/tickets\/(?!new$)/.test(path) },
      { label: 'Submit Request', href: '/portal/tickets/new', icon: 'plus', on: path === '/portal/tickets/new' },
      { label: 'My Services', href: '/portal/services', icon: 'grid', on: path === '/portal/services' },
      { label: 'Service Catalogue', href: '/portal/catalogue', icon: 'clipboard', on: path === '/portal/catalogue' },
    ];
    if (user.role === 'customer_admin') items.push({ label: 'Our Users', href: '/portal/users', icon: 'users', on: path === '/portal/users' });
    return [items];
  }

  const onList = path === '/tickets';
  const mine = onList && query.view === 'mine';
  const inc = onList && query.type === 'incident' && !mine;
  const req = onList && query.type === 'request' && !mine;
  const main = [
    { label: 'Dashboard', href: '/', icon: 'home', on: path === '/' },
    can('ticket.view') && { label: 'My Requests', href: '/tickets?view=mine', icon: 'doc', on: mine },
    can('ticket.create_for_customer') && { label: 'Submit Request', href: '/tickets/new', icon: 'plus', on: path === '/tickets/new' },
    can('ticket.verify') && { label: 'Verification', href: '/verification', icon: 'check', on: path === '/verification', badge: counts.verification || 0 },
    can('ticket.view') && { label: 'Incidents', href: '/tickets?type=incident', icon: 'alert', on: inc },
    can('ticket.view') && { label: 'Service Requests', href: '/tickets?type=request', icon: 'shield', on: req },
    can('ticket.view') && { label: 'All Tickets', href: '/tickets', icon: 'list', on: starts('/tickets') && path !== '/tickets/new' && !mine && !inc && !req },
    can('customer.view') && { label: 'Customers', href: '/customers', icon: 'building', on: starts('/customers', '/services', '/customer-contracts') },
    { label: 'Reports', href: '/reports', icon: 'chart', on: starts('/reports') },
  ].filter(Boolean);
  const business = [
    can('operations.view') && { label: 'Operations Overview', href: '/operations', icon: 'pulse', on: starts('/operations', '/business') },
    can('project.view') && { label: 'Projects', href: '/projects', icon: 'project', on: starts('/projects') },
    can('contract.view') && { label: 'Contracts', href: '/contracts', icon: 'file', on: starts('/contracts') },
    can('tender.view') && { label: 'Tender Management', href: '/tenders', icon: 'clipboard', on: starts('/tenders') },
    (can('pipeline.view') || can('pipeline.support')) && { label: can('pipeline.view') ? 'Pipeline Tracker' : 'My Opportunities', href: '/pipeline', icon: 'funnel', on: starts('/pipeline') },
  ].filter(Boolean);
  return [main, business].filter((g) => g.length);
}

module.exports = { build };
