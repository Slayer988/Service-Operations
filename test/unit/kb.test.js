'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const markdown = require('../../src/lib/markdown');
const kb = require('../../src/services/kb');
const perms = require('../../src/lib/perms');

test('markdown: headings, lists, notes, code and links become HTML', () => {
  const h = markdown.render('# Reset\n\n1. Open **Settings**\n2. Press `Save`\n\n- one\n- two\n\n> careful\n\n```\nvpn --reset <now>\n```\n\n---\n\nSee [[KB-0012]] and [the page](https://example.com/a?b=1&c=2).');
  assert.ok(h.includes('<h2>Reset</h2>'));
  assert.ok(h.includes('<ol><li>Open <b>Settings</b></li><li>Press <code>Save</code></li></ol>'));
  assert.ok(h.includes('<ul><li>one</li><li>two</li></ul>') && h.includes('<blockquote>careful</blockquote>') && h.includes('<hr>'));
  assert.ok(h.includes('<pre><code>vpn --reset &lt;now&gt;</code></pre>'), 'code is shown exactly as typed, escaped');
  assert.ok(h.includes('<a href="/kb/KB-0012">KB-0012</a>'));
  assert.ok(h.includes('<a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer">the page</a>'));
  assert.ok(markdown.render('See [[KB-0012]]', { base: '/portal/help' }).includes('href="/portal/help/KB-0012"'));
});

test('markdown: nothing in an article can run script or add markup', () => {
  const evil = '<script>alert(1)</script> <img src=x onerror=alert(1)> [x](javascript:alert(1)) [y](data:text/html,hi) [z](//evil.example) **<b>** `<i>` "quoted" \'single\'\n\n```\n</pre><script>alert(2)</script>\n```';
  const h = markdown.render(evil);
  const tags = [...h.matchAll(/<(\/?)([a-z0-9]+)([^>]*)>/gi)];
  for (const [, , name, attrs] of tags) {
    assert.ok(['p', 'br', 'b', 'i', 'a', 'code', 'pre', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'hr'].includes(name), `unexpected tag <${name}>`);
    if (attrs.trim()) assert.ok(name === 'a' && /^( href="[^"]*")?( target="_blank" rel="noopener noreferrer")?$/.test(attrs), `unexpected attributes on <${name}>: ${attrs}`);
  }
  assert.ok(!/<a [^>]*href="(javascript|data|\/\/)/i.test(h), 'no dangerous links');
  assert.ok(h.includes('&lt;script&gt;alert(1)&lt;/script&gt;') && h.includes('&lt;img src=x onerror=alert(1)&gt;'), 'what was typed is shown as text');
  assert.equal(markdown.render(''), '');
});

test('markdown: plain text for search results', () => {
  assert.equal(markdown.plain('## Steps\n\n1. Open **Settings**\n\n```\ncode\n```\nSee [[KB-0003]] and [a page](https://x.co).'), 'Steps 1. Open Settings See KB-0003 and a page.');
  assert.ok(markdown.plain('x'.repeat(500)).length <= 220);
});

test('knowledge base: the form is checked and cleaned', () => {
  const f = kb.readForm({ title: '  Reset   VPN ', body: 'Text\r\nmore', tags: 'VPN, Password; mobile vpn !!x', audience: 'customers', category_id: '3', review_by: '2027-01-31' });
  assert.deepEqual([f.title, f.body, f.tags, f.audience, f.category_id, f.review_by], ['Reset VPN', 'Text\nmore', 'vpn password mobile x', 'customers', 3, '2027-01-31']);
  assert.equal(kb.readForm({ title: 't', body: 'b', audience: 'everyone' }).audience, 'internal');
  assert.throws(() => kb.readForm({ title: '', body: 'b' }), /title/);
  assert.throws(() => kb.readForm({ title: 't', body: '  ' }), /Write the article/);
  assert.throws(() => kb.readForm({ title: 't', body: 'x'.repeat(60001) }), /too long/);
  assert.equal(kb.readForm({ title: 't', body: 'b', tags: Array.from({ length: 30 }, (_, i) => `t${i}`).join(' ') }).tags.split(' ').length, 10);
});

test('knowledge base: article codes, and who may write, publish and change a live customer article', () => {
  assert.ok(kb.CODE_RE.test('KB-0001') && kb.CODE_RE.test('KB-123456') && !kb.CODE_RE.test('KB-1') && !kb.CODE_RE.test('kb-0001; drop'));
  const can = (role, p) => perms.can({ role }, p);
  assert.ok(can('agent', 'kb.write') && !can('agent', 'kb.publish') && can('service_manager', 'kb.publish') && can('platform_admin', 'kb.publish'));
  assert.ok(can('auditor', 'kb.view') && !can('auditor', 'kb.write') && !can('finance', 'kb.write') && can('engineer', 'kb.write'));
  const live = { status: 'published', audience: 'customers' };
  assert.equal(kb.canEdit({ role: 'agent' }, live), false, 'a live customer article is changed by a publisher only');
  assert.equal(kb.canEdit({ role: 'service_manager' }, live), true);
  assert.equal(kb.canEdit({ role: 'agent' }, { status: 'published', audience: 'internal' }), true);
  assert.equal(kb.canEdit({ role: 'agent' }, { status: 'draft', audience: 'customers' }), true);
  assert.equal(kb.canEdit({ role: 'auditor' }, { status: 'draft', audience: 'internal' }), false);
});

test('knowledge base: what each kind of reader may see', () => {
  const vis = (user) => kb.visibility(user, []);
  assert.match(vis({ kind: 'customer', role: 'customer_user' }), /published.*customers/);
  assert.equal(vis({ kind: 'staff', role: 'auditor' }), "a.status = 'published'");
  assert.equal(vis({ kind: 'staff', role: 'agent' }), 'true');
});

test('knowledge base: an article started from a ticket', () => {
  const d = kb.draftFromTicket({ subject: 'Printer offline', description: 'It says offline', resolution_note: 'Restart the spooler' });
  assert.ok(d.title === 'Printer offline' && d.body.includes('## Problem') && d.body.includes('It says offline') && d.body.includes('## Solution') && d.body.includes('Restart the spooler'));
  assert.equal(d.audience, 'internal', 'never public by default');
});
