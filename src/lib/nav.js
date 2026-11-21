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
      { label: 'Our Equipment', href: '/portal/assets', icon: 'server', on: path === '/portal/assets' },
      { label: 'Service Status', href: '/portal/status', icon: 'pulse', on: path === '/portal/status' },
      { label: 'Service Catalogue', href: '/portal/catalogue', icon: 'clipboard', on: path === '/portal/catalogue' },
      { label: 'Help Articles', href: '/portal/help', icon: 'book', on: starts('/portal/help') },
    ];
    if (user.role === 'customer_admin') items.push({ label: 'Our Users', href: '/portal/users', icon: 'users', on: path === '/portal/users' });
    return [items];
  }

  const onList = path === '/tickets';
  const mine = onList && query.view === 'mine';
  const inc = onList && query.type === 'incident' && !mine;
  const req = onList && query.type === 'request' && !mine;
  const sections = [
    ['home', '', [
      { label: 'Dashboard', href: '/', icon: 'home', on: path === '/' },
    ]],
    ['desk', 'Service Desk', [
      can('ticket.view') && { label: 'My Requests', href: '/tickets?view=mine', icon: 'doc', on: mine },
      can('ticket.create_for_customer') && { label: 'Submit Request', href: '/tickets/new', icon: 'plus', on: path === '/tickets/new' },
      can('ticket.verify') && { label: 'Verification', href: '/verification', icon: 'check', on: path === '/verification', badge: counts.verification || 0 },
      can('ticket.view') && { label: 'Incidents', href: '/tickets?type=incident', icon: 'alert', on: inc },
      can('ticket.view') && { label: 'Service Requests', href: '/tickets?type=request', icon: 'shield', on: req },
      can('ticket.view') && { label: 'All Tickets', href: '/tickets', icon: 'list', on: starts('/tickets') && path !== '/tickets/new' && !mine && !inc && !req },
      can('ticket.view') && { label: 'Service Notices', href: '/notices', icon: 'bell', on: starts('/notices'), badge: counts.incidents || 0 },
      can('ticket.work') && { label: 'Timesheet', href: '/time', icon: 'clock', on: starts('/time') },
      can('ticket.work') && { label: 'Reply Templates', href: '/templates', icon: 'file', on: starts('/templates') },
    ]],
    ['itsm', 'Service Management', [
      can('problem.view') && { label: 'Problems', href: '/problems', icon: 'search', on: starts('/problems') },
      can('change.view') && { label: 'Changes', href: '/changes', icon: 'refresh', on: starts('/changes') },
      can('asset.view') && { label: 'Assets', href: '/assets', icon: 'server', on: starts('/assets') },
      can('kb.view') && { label: 'Knowledge Base', href: '/kb', icon: 'book', on: starts('/kb') },
    ]],
    ['customers', 'Customers & Sales', [
      can('customer.view') && { label: 'Customers', href: '/customers', icon: 'building', on: starts('/customers', '/services', '/customer-contracts') },
      can('contract.view') && { label: 'Contracts', href: '/contracts', icon: 'file', on: starts('/contracts') },
      (can('pipeline.view') || can('pipeline.support')) && { label: can('pipeline.view') ? 'Pipeline Tracker' : 'My Opportunities', href: '/pipeline', icon: 'funnel', on: starts('/pipeline') },
      can('tender.view') && { label: 'Tender Management', href: '/tenders', icon: 'clipboard', on: starts('/tenders') },
      can('quote.view') && { label: 'Quotes', href: '/quotes', icon: 'dollar', on: starts('/quotes') },
      can('invoice.view') && { label: 'Invoices', href: '/invoices', icon: 'receipt', on: starts('/invoices') },
    ]],
    ['delivery', 'Projects & Procurement', [
      can('project.view') && { label: 'Projects', href: '/projects', icon: 'project', on: starts('/projects') },
      // the register, the purchase orders (LPO tracker) and supplier performance are one module, with tabs
      (can('supplier.view') || can('lpo.view')) && { label: 'Suppliers & Contractors', href: can('supplier.view') ? '/suppliers' : '/lpo', icon: 'users', on: starts('/suppliers', '/lpo') },
      // approvers, and those who ask for approval (counts.approvals: what is waiting for this person)
      (counts.approver || can('quote.manage') || can('lpo.manage')) && { label: 'Approvals', href: '/approvals', icon: 'check', on: starts('/approvals'), badge: counts.approvals || 0 },
    ]],
    ['insight', 'Insights', [
      can('operations.view') && { label: 'Operations Overview', href: '/operations', icon: 'pulse', on: starts('/operations', '/business') },
      { label: 'Reports', href: '/reports', icon: 'chart', on: starts('/reports') },
    ]],
  ];
  // A group is an array of items with an id and a title. Folded groups (ids in ctx.folded, from a cookie) stay folded
  // unless the page open now is in them; a folded group shows the sum of its badges on its heading.
  const folded = new Set(ctx.folded || []);
  return sections.map(([id, title, items]) => {
    const g = items.filter(Boolean);
    g.id = id; g.title = title; g.active = g.some((it) => it.on);
    g.open = !title || g.active || !folded.has(id);
    g.badge = g.reduce((a, it) => a + (Number(it.badge) || 0), 0);
    return g;
  }).filter((g) => g.length);
}

/** The folded menu groups, from the itsm.navg cookie (ids separated by '.'). */
function foldedFrom(cookie) {
  const m = /(?:^|;\s*)itsm\.navg=([a-z.]*)(?:;|$)/.exec(cookie || '');
  return m ? m[1].split('.').filter(Boolean) : [];
}

module.exports = { build, foldedFrom };
