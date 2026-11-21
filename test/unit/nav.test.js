'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const nav = require('../../src/lib/nav');

const flat = (g) => g.flat();
const labels = (g) => flat(g).map((i) => i.label);
const active = (g) => flat(g).filter((i) => i.on).map((i) => i.label);

test('platform admin sees every module; links are never dead', () => {
  const g = nav.build({ kind: 'staff', role: 'platform_admin' }, { path: '/', query: {} }, { verification: 3 });
  for (const l of ['Dashboard', 'Incidents', 'Knowledge Base', 'Operations Overview', 'Projects', 'Contracts', 'Tender Management', 'Pipeline Tracker']) assert.ok(labels(g).includes(l), l);
  // Settings, Users, Directory and Audit live on the Administration page, not in the menu
  assert.ok(!labels(g).includes('Business Overview'));
  for (const l of ['Settings', 'Directory', 'Audit', 'Users', 'E-mail', 'Mailboxes', 'SLA', 'Service Catalogue']) assert.ok(!labels(g).includes(l), l);
  for (const l of ['Assets', 'Problems', 'Changes', 'Service Notices']) assert.ok(labels(g).includes(l), `${l} (1.24-1.25)`);
  assert.ok(labels(g).includes('Approvals'), 'administrators approve quotes and orders (1.23.0)');
  assert.equal(flat(g).find((i) => i.label === 'Verification').badge, 3);
});

test('roles only see what they may use', () => {
  const agent = labels(nav.build({ kind: 'staff', role: 'agent' }, { path: '/', query: {} }));
  for (const l of ['Contracts', 'Tender Management', 'Pipeline Tracker', 'Projects', 'Settings', 'Users', 'E-mail']) assert.ok(!agent.includes(l), l);
  assert.ok(agent.includes('Operations Overview'), 'everyone with tickets sees the ticket tiles');
  const auditor = labels(nav.build({ kind: 'staff', role: 'auditor' }, { path: '/', query: {} }));
  assert.ok(auditor.includes('Tender Management') && !auditor.includes('Audit') && !auditor.includes('Submit Request'));
  const bd = labels(nav.build({ kind: 'staff', role: 'bd_manager' }, { path: '/', query: {} }));
  assert.ok(bd.includes('Pipeline Tracker') && bd.includes('Contracts') && !bd.includes('Incidents') && !bd.includes('All Tickets'));
  const sde = labels(nav.build({ kind: 'staff', role: 'sde' }, { path: '/', query: {} }));
  assert.ok(sde.includes('My Opportunities') && sde.includes('Tender Management') && !sde.includes('Contracts') && !sde.includes('Pipeline Tracker'));
});

test('exactly one place is highlighted', () => {
  const u = { kind: 'staff', role: 'platform_admin' };
  const cases = [
    ['/', {}, 'Dashboard'], ['/tickets', {}, 'All Tickets'], ['/tickets', { view: 'mine' }, 'My Requests'], ['/tickets', { type: 'incident' }, 'Incidents'],
    ['/tickets', { type: 'request' }, 'Service Requests'], ['/tickets/new', {}, 'Submit Request'], ['/tickets/INC-000012', {}, 'All Tickets'], ['/customers/4', {}, 'Customers'],
    ['/services/9', {}, 'Customers'], ['/contracts/3', {}, 'Contracts'], ['/tenders/new', {}, 'Tender Management'], ['/pipeline', {}, 'Pipeline Tracker'], ['/operations', {}, 'Operations Overview'], ['/projects/4', {}, 'Projects'],
  ];
  for (const [path, query, want] of cases) assert.deepEqual(active(nav.build(u, { path, query })), [want], `${path} ${JSON.stringify(query)}`);
});

test('customer portal menu', () => {
  const g = nav.build({ kind: 'customer', role: 'customer_user' }, { path: '/portal/tickets/INC-000001', query: {} });
  assert.deepEqual(labels(g), ['Dashboard', 'My Requests', 'Submit Request', 'My Services', 'Our Equipment', 'Service Status', 'Service Catalogue', 'Help Articles']);
  assert.deepEqual(active(g), ['My Requests']);
  assert.ok(labels(nav.build({ kind: 'customer', role: 'customer_admin' }, { path: '/portal' })).includes('Our Users'));
  assert.deepEqual(nav.build(null, {}), []);
});

test('1.27.0 the menu is grouped; folded groups come from the cookie, but the open page keeps its group unfolded', () => {
  const nav = require('../../src/lib/nav');
  const fin = { kind: 'staff', role: 'finance' };
  const g = nav.build(fin, { path: '/reports', query: {}, folded: ['customers', 'insight'] }, {});
  const titles = g.map((x) => x.title);
  assert.equal(titles[0], '', 'the Dashboard has no heading');
  assert.ok(titles.includes('Customers & Sales'));
  const cs = g.find((x) => x.id === 'customers');
  assert.ok(cs.some((it) => it.href === '/invoices'), 'finance sees Invoices');
  assert.equal(cs.open, false, 'folded by the person');
  assert.equal(g.find((x) => x.id === 'insight').open, true, 'Reports is open now, so its group is unfolded');
  assert.ok(g.every((x) => x.length > 0), 'empty groups are left out');
  assert.deepEqual(nav.foldedFrom('a=1; itsm.navg=desk.itsm; b=2'), ['desk', 'itsm']);
  assert.deepEqual(nav.foldedFrom('itsm.navg=<script>'), []);
  assert.deepEqual(nav.foldedFrom(''), []);
  const eng = nav.build({ kind: 'staff', role: 'engineer' }, { path: '/', query: {} }, {});
  assert.ok(!eng.flat().some((it) => it.href === '/invoices'), 'engineers do not');
});
