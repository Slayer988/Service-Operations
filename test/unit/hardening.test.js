'use strict';
// 1.15.0: pure rules behind the lifecycle, SLA history, local-time e-mail, one-time codes and secret storage.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-secret-0123456789abcdef0123456789';
const test = require('node:test');
const assert = require('node:assert/strict');
const sla = require('../../src/lib/sla');
const util = require('../../src/lib/util');
const totp = require('../../src/lib/totp');
const twofactor = require('../../src/lib/twofactor');
const tickets = require('../../src/services/tickets');

const NOW = new Date('2026-11-02T10:00:00Z');
const ago = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

test('breachRecord: a target met late, or still unmet past its due time, is recorded', () => {
  const r = sla.breachRecord({ type: 'incident', response_due: ago(5), responded_at: ago(1), resolution_due: ago(2), resolved_at: null, restoration_due: ago(1), restored_at: ago(3) }, NOW);
  assert.ok(r.response && r.resolution, 'late response and overdue resolution');
  assert.equal(r.restoration, undefined, 'restored on time');
  assert.equal(r.response.due, ago(5));
});

test('breachRecord: on-time work and a paused clock record nothing', () => {
  assert.deepEqual(sla.breachRecord({ type: 'incident', response_due: ago(-2), responded_at: null, resolution_due: ago(-9), resolved_at: null }, NOW), {});
  assert.deepEqual(sla.breachRecord({ type: 'incident', resolution_due: ago(3), resolved_at: null, paused_at: ago(4) }, NOW), {}, 'waiting for the customer is not a breach');
});

test('breachRecord: requests have no restoration target, and what is on record is never removed', () => {
  assert.equal(sla.breachRecord({ type: 'request', restoration_due: ago(5), restored_at: null }, NOW).restoration, undefined);
  const kept = { resolution: { due: ago(50), at: ago(40) } };
  const r = sla.breachRecord({ type: 'incident', sla_breaches: kept, resolution_due: ago(-100), resolved_at: null }, NOW);   // the due time was moved later by a reopen
  assert.deepEqual(r.resolution, kept.resolution);
});

test('status transitions: working states move freely, nothing closes directly, closed only reopens, cancelled is final', () => {
  assert.deepEqual(tickets.nextStatuses('cancelled'), []);
  assert.ok(!tickets.nextStatuses('new').includes('closed') && !tickets.nextStatuses('new').includes('new'));
  assert.ok(!tickets.nextStatuses('open').includes('closed') && tickets.nextStatuses('open').includes('resolved'));
  assert.ok(tickets.nextStatuses('resolved').includes('closed') && tickets.nextStatuses('resolved').includes('in_progress'));
  assert.deepEqual(tickets.nextStatuses('closed').sort(), ['in_progress', 'open', 'pending_customer', 'pending_vendor', 'restored']);
  for (const s of Object.keys(tickets.TRANSITIONS)) assert.ok(!tickets.nextStatuses(s).includes(s), `${s} does not list itself`);
});

test('localStamp: written in the time zone with its name, and blank values are n/a', () => {
  assert.equal(util.localStamp('2026-11-02T05:00:00Z', 'Africa/Kampala'), '2026-11-02 08:00 (Africa/Kampala)');
  assert.equal(util.localStamp(new Date('2026-11-02T21:30:00Z'), 'Africa/Kampala'), '2026-11-03 00:30 (Africa/Kampala)', 'the date rolls over with the zone');
  assert.equal(util.localStamp(null, 'Africa/Kampala'), 'n/a');
  assert.equal(util.localStamp('not a date', 'Africa/Kampala'), 'n/a');
});

test('two-step codes: matchStep names the 30-second step, so the same step can be refused a second time', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  const t = 1111111109000;
  const step = totp.matchStep(secret, '081804', t);
  assert.equal(step, Math.floor(t / 1000 / 30));
  assert.equal(totp.matchStep(secret, '081 804', t), step, 'spaces are ignored');
  assert.equal(totp.matchStep(secret, '000000', t), null);
  assert.equal(totp.matchStep(secret, 'abcdef', t), null);
  assert.equal(totp.matchStep(null, '081804', t), null);
  assert.equal(totp.matchStep(secret, totp.code(secret, t - 30000), t), step - 1, 'the previous step is still accepted, and reported as that step');
  assert.ok(totp.verify(secret, '081804', t));
});

test('two-step secrets are stored encrypted; an older plain secret is still readable', () => {
  const secret = totp.newSecret();
  const stored = twofactor.protect(secret);
  assert.ok(twofactor.isEncrypted(stored) && !stored.includes(secret));
  assert.equal(twofactor.reveal(stored), secret);
  assert.equal(twofactor.reveal(secret), secret, 'plain, from an earlier version');
  assert.equal(twofactor.isEncrypted(secret), false);
  assert.equal(twofactor.reveal(null), null);
  assert.equal(twofactor.reveal('v1:AAAA:BBBB:CCCC'), null, 'unreadable (another key) is null, not an error');
});

// 1.16.0: the search box
const search = require('../../src/lib/search');
test('search: short or empty text is not searched, wildcards in the text are harmless, a ticket reference is recognised', () => {
  assert.equal(search.term('a'), ''); assert.equal(search.term('   '), ''); assert.equal(search.term(undefined), '');
  assert.equal(search.term('  printer  '), 'printer');
  assert.equal(search.term('x'.repeat(300)).length, 100);
  assert.equal(search.like('50%_off\\'), '%50\\%\\_off\\\\%');
  assert.ok(search.looksLikeRef('INC-000123') && search.looksLikeRef('req-0042a'));
  assert.ok(!search.looksLikeRef('printer jammed') && !search.looksLikeRef('INC') && !search.looksLikeRef('a-b'));
});

test('search: customers never match on internal notes, staff do', () => {
  assert.ok(search.ticketClause(3).includes('not tc.internal'));
  assert.ok(!search.ticketClause(3, { internal: true }).includes('not tc.internal'));
  assert.ok(search.ticketClause(7).includes('$7') && !search.ticketClause(7).includes('$3'));
});
