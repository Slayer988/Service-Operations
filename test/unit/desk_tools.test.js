'use strict';
// 1.26.0: time, reply templates, automation rules and rating links.
const test = require('node:test');
const assert = require('node:assert/strict');
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-secret-unit-test-secret-1234';
const T = require('../../src/services/time');
const TPL = require('../../src/services/templates');
const AU = require('../../src/services/automation');
const S = require('../../src/services/satisfaction');

test('time: the ways people write durations', () => {
  for (const [v, m] of [['45', 45], ['45m', 45], ['45 min', 45], ['1h30', 90], ['1h 30m', 90], ['1:30', 90], ['1.5h', 90], ['1,5h', 90], ['2h', 120], ['2 hours', 120]]) assert.equal(T.readDuration(v), m, v);
  for (const v of ['', 'soon', '1:75', '-5', 'h']) assert.equal(T.readDuration(v), null, v);
  assert.equal(T.show(90), '1h 30m'); assert.equal(T.show(45), '45m'); assert.equal(T.show(120), '2h');
  assert.equal(T.monday('2026-11-20'), '2026-11-16', 'weeks start on Monday'); assert.equal(T.monday('2026-11-16'), '2026-11-16'); assert.equal(T.monday('2026-11-22'), '2026-11-16');
});

test('templates: placeholders are filled from the ticket; unknown ones are refused', () => {
  const out = TPL.fill('Hello {{requester_name}}, about {{ticket_ref}} ({{ticket_subject}}) for {{customer_name}}. {{agent_name}}', { requester_name: 'Grace Nansubuga', ref: 'INC-000042', subject: 'VPN', customer_name: 'Alpha Bank' }, { name: 'Brian' });
  assert.equal(out, 'Hello Grace, about INC-000042 (VPN) for Alpha Bank. Brian');
  assert.equal(TPL.fill('Hi {{requester_name}}', { ref: 'X' }, { name: 'B' }), 'Hi there', 'no name: a friendly greeting');
  assert.equal(TPL.fill('Hi {{requester_name}}', { requester_name: 'Dr. Sarah Achieng', ref: 'X' }, { name: 'B' }), 'Hi Sarah', 'a title is skipped');
  assert.equal(TPL.fill('Hi {{requester_name}}', { requester_name: 'Eng Peter Okello', ref: 'X' }, { name: 'B' }), 'Hi Peter');
  assert.throws(() => TPL.read({ title: 'x', body: 'Dear {{first_name}}' }), /Unknown placeholder.*first_name/);
  assert.throws(() => TPL.read({ title: '', body: 'x' }), /short title/);
  assert.equal(TPL.canEdit({ id: 5 }, { shared: false, owner_id: 5 }, false), true);
  assert.equal(TPL.canEdit({ id: 5 }, { shared: true, owner_id: 5 }, false), false, 'a shared template is changed by service managers only');
});

test('automation: conditions all have to match; words and domains are matched carefully', () => {
  const t = { source: 'email', type: 'incident', queue: 'it_services', category: 'Network', customer_id: 7, priority: 2, subject: 'Possible PHISHING e-mail', description: '', requester_email: 'ann@mail.bank.co.ug' };
  assert.ok(AU.matches({ words: ['phishing'] }, t), 'words ignore case');
  assert.ok(AU.matches({ domain: 'bank.co.ug' }, t), 'a sub-domain counts');
  assert.ok(!AU.matches({ domain: 'ank.co.ug' }, t), 'but not a different domain ending the same way');
  assert.ok(AU.matches({ source: 'email', customer_id: 7, priority_max: 2 }, t));
  assert.ok(!AU.matches({ source: 'email', priority_max: 1 }, t), 'P2 is not P1 or higher');
  assert.ok(!AU.matches({ category: 'Printers' }, t));
  assert.throws(() => AU.read({ name: 'x', a_note: 'n' }), /at least one condition/);
  assert.throws(() => AU.read({ name: 'x', c_words: 'a' }), /at least one thing the rule does/);
  assert.throws(() => AU.read({ name: 'x', c_words: 'a', a_impact: '1' }), /both the impact and the urgency/);
  const r = AU.read({ name: 'Sec', c_words: 'phishing, malware', a_queue: 'security', stop: '1' });
  assert.deepEqual(r.conditions, { words: ['phishing', 'malware'] }); assert.deepEqual(r.actions, { queue: 'security' }); assert.equal(r.stop, true);
  assert.match(AU.describe(r).when, /mentioning "phishing" or "malware"/);
});

test('rating links: signed for that ticket and that address only', () => {
  const t = { id: 42, ref: 'INC-000042', requester_email: 'Ann@Alpha.test' };
  const tok = S.sign(t);
  assert.equal(tok.length, 32);
  assert.ok(S.valid(t, tok)); assert.ok(S.valid({ ...t, requester_email: 'ann@alpha.test' }, tok), 'the address case does not matter');
  assert.ok(!S.valid({ ...t, id: 43 }, tok), 'not for another ticket'); assert.ok(!S.valid({ ...t, requester_email: 'eve@alpha.test' }, tok), 'not for another person');
  assert.ok(!S.valid(t, tok.slice(0, 31) + (tok[31] === 'A' ? 'B' : 'A')));
  const block = S.emailBlock(t);
  assert.equal((block.match(/\/rate\/INC-000042\//g) || []).length, 5); assert.match(block, /\?score=1/);
  assert.ok(S.open({ status: 'resolved', resolved_at: new Date() })); assert.ok(!S.open({ status: 'open' })); assert.ok(!S.open({ status: 'closed', resolved_at: new Date(Date.now() - 40 * 86400000) }));
});
