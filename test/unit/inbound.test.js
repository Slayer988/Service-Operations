'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const inbound = require('../../src/services/inbound');

test('automatic mail is recognised (loop protection)', () => {
  assert.ok(inbound.isAutomated({ 'auto-submitted': 'auto-replied' }, 'a@b.com'));
  assert.ok(inbound.isAutomated({ precedence: 'bulk' }, 'a@b.com'));
  assert.ok(inbound.isAutomated({ 'x-itsm-notification': '1' }, 'a@b.com'));
  assert.ok(inbound.isAutomated({}, 'noreply@vendor.com'));
  assert.ok(inbound.isAutomated({}, 'mailer-daemon@x.com'));
  assert.ok(inbound.isAutomated({}, 'support@labs.local', ['Support@labs.local']));
  assert.equal(inbound.isAutomated({ 'auto-submitted': 'no' }, 'person@x.com'), null);
  assert.equal(inbound.isAutomated({}, 'person@x.com'), null);
});

test('failed sender checks are detected', () => {
  assert.ok(inbound.authFailed({ 'authentication-results': 'mx.x; spf=pass; dkim=fail header.d=x.com' }));
  assert.ok(inbound.authFailed({ 'received-spf': 'Fail (domain does not designate)' }));
  assert.ok(!inbound.authFailed({ 'authentication-results': 'mx.x; spf=pass; dkim=pass; dmarc=pass' }));
  assert.ok(!inbound.authFailed({}));
});

test('ticket references are found in subjects', () => {
  assert.equal(inbound.extractRef('Re: [INC-000123] Server down'), 'INC-000123');
  assert.equal(inbound.extractRef('req-000007 please'), 'REQ-000007');
  assert.equal(inbound.extractRef('INC-12 short'), null);
  assert.equal(inbound.extractRef('nothing here'), null);
});

test('subjects are cleaned', () => {
  assert.equal(inbound.cleanSubject('RE: Fwd: Re: Printer  broken'), 'Printer broken');
  assert.equal(inbound.cleanSubject(''), '(no subject)');
});

test('quoted text is removed from replies', () => {
  const t = 'Thanks, it works now.\n\nOn Mon, 2 Nov 2026 at 09:00, Support <s@x.com> wrote:\n> please try again\n> thanks';
  assert.equal(inbound.stripQuoted(t), 'Thanks, it works now.');
  assert.equal(inbound.stripQuoted('line one\n> quoted\nline two'), 'line one\nline two');
  assert.equal(inbound.stripQuoted('> only quoted'), '> only quoted');
});

test('html bodies are reduced to text', () => {
  const t = inbound.bodyText({ html: '<p>Hello <b>there</b></p><script>x()</script><br>bye' });
  assert.match(t, /Hello\s+there/);
  assert.ok(!t.includes('x()'));
});
