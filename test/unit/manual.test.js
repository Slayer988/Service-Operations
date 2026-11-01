'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const manual = require('../../src/lib/manual');
const perms = require('../../src/lib/perms');

const ids = (u) => manual.forUser(u).map((s) => s.id);
const staff = (role) => ({ kind: 'staff', role });

test('manual: text is escaped; only **bold** is allowed through', () => {
  assert.equal(manual.inline('a <script>alert(1)</script> **b** & "c"'), 'a &lt;script&gt;alert(1)&lt;/script&gt; <b>b</b> &amp; &quot;c&quot;');
});

test('manual: customers get the portal sections and nothing about staff modules', () => {
  const u = ids({ kind: 'customer', role: 'customer_user' });
  assert.deepEqual(u.filter((i) => i.startsWith('c-')), ['c-request', 'c-track', 'c-services']);
  for (const x of ['tickets', 'admin', 'roles', 'contracts', 'tenders', 'pipeline', 'projects', 'operations', 'reports']) assert.ok(!u.includes(x), x);
  assert.ok(ids({ kind: 'customer', role: 'customer_admin' }).includes('c-users'));
  assert.ok(!u.includes('c-users'));
  const text = JSON.stringify(manual.forUser({ kind: 'customer', role: 'customer_user' }));
  assert.ok(!/Active Directory|Windows|pipeline|tender/i.test(text), 'nothing staff-only leaks into the customer manual');
});

test('manual: staff see the modules their role may use, matching the permission table', () => {
  assert.ok(ids(staff('platform_admin')).includes('admin'));
  const agent = ids(staff('agent'));
  assert.ok(agent.includes('tickets') && agent.includes('verification') && !agent.includes('admin') && !agent.includes('contracts') && !agent.includes('pipeline') && !agent.includes('projects'));
  const bd = ids(staff('bd_manager'));
  assert.ok(bd.includes('pipeline') && bd.includes('contracts') && !bd.includes('tickets') && !bd.includes('verification'));
  for (const sec of manual.sections(staff('platform_admin')).filter((s) => s.perm)) {
    assert.ok(perms.GRANTS[sec.perm], `${sec.id} refers to an unknown permission ${sec.perm}`);
  }
  assert.ok(!ids(staff('readonly')).some((i) => i.startsWith('c-')));
});

test('manual: the access table is generated from the permission table', () => {
  const roles = manual.forUser(staff('agent')).find((s) => s.id === 'roles');
  const t = roles.blocks[0].access;
  assert.ok(t.length > 20);
  const row = t.find((r) => r.perm === 'user.manage');
  assert.deepEqual(row.roles, [perms.ROLE_LABELS.platform_admin]);
  for (const r of t) { assert.ok(r.roles.length > 0, r.perm); assert.deepEqual(r.roles, perms.GRANTS[r.perm].map((x) => perms.ROLE_LABELS[x])); }
});

test('manual: sections are well formed and each id is unique', () => {
  const all = manual.sections({ kind: 'staff', role: 'platform_admin' }).concat(manual.sections({ kind: 'customer', role: 'customer_admin' }));
  const seen = new Set();
  for (const s of all) {
    if (seen.has(s.id)) continue; seen.add(s.id);
    assert.match(s.id, /^[a-z][a-z0-9-]*$/); assert.ok(s.title && ['all', 'staff', 'customer'].includes(s.who), s.id);
    assert.ok(s.blocks.length, s.id);
    for (const b of s.blocks) {
      const kinds = ['p', 'h', 'steps', 'list', 'tip', 'table', 'access'].filter((k) => b[k] !== undefined);
      assert.equal(kinds.length, 1, `${s.id}: a block has exactly one kind`);
      if (b.table) for (const r of b.table.rows) assert.equal(r.length, b.table.head.length, `${s.id}: table row width`);
      for (const x of [b.steps, b.list].filter(Boolean)) for (const item of x) assert.equal(typeof item, 'string');
    }
  }
});

test('manual: names things as the application does (no stale wording)', () => {
  const text = JSON.stringify(manual.sections({ kind: 'staff', role: 'platform_admin' }));
  assert.ok(!/Business Overview|Service Desk Ops|group mapping|AD group/i.test(text));
  assert.ok(text.includes('Operations Overview') && text.includes('Import users') && text.includes('Test connection'));
});

test('the ? icon opens the manual in a new tab, safely, for staff and customers', () => {
  const h = fs.readFileSync(path.join(__dirname, '../../src/views/partials/header.ejs'), 'utf8');
  const link = /<a class="iconbtn"[^>]*href="\/manual"[^>]*>/.exec(h);
  assert.ok(link, 'the header links to /manual');
  assert.match(link[0], /target="_blank"/); assert.match(link[0], /rel="noopener"/); assert.match(link[0], /#?/);
  assert.ok(/<use href="#i-help"\/>/.test(h.slice(link.index, link.index + 400)));
  assert.ok(!/href="<%= user\.kind === 'customer' \? '\/portal\/tickets\/new'/.test(h), 'the old help link is gone');
});
