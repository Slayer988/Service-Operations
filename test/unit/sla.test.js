'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const sla = require('../../src/lib/sla');

const wk = (a, b) => Object.fromEntries([1, 2, 3, 4, 5].map((d) => [String(d), [[a, b]]]).concat([['6', []], ['7', []]]));
const std = sla.makeCalendar({ timezone: 'Africa/Nairobi', schedule: wk('08:00', '17:00') });
const all = sla.makeCalendar({ timezone: 'Africa/Nairobi', schedule: Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [String(d), [['00:00', '24:00']]])) });
const iso = (d) => d.toISOString();

test('zonedToUtc handles a fixed offset zone', () => {
  assert.equal(iso(sla.zonedToUtc(2026, 10, 30, 8, 0, 'Africa/Nairobi')), '2026-10-30T05:00:00.000Z');
});

test('zonedToUtc handles daylight saving changes', () => {
  assert.equal(iso(sla.zonedToUtc(2026, 3, 7, 8, 0, 'America/New_York')), '2026-03-07T13:00:00.000Z');
  assert.equal(iso(sla.zonedToUtc(2026, 3, 8, 8, 0, 'America/New_York')), '2026-03-08T12:00:00.000Z');
});

test('24x7 adds plain elapsed minutes', () => {
  const d = sla.addBusinessMinutes(new Date('2026-10-30T13:30:00Z'), 90, all);
  assert.equal(iso(d), '2026-10-30T15:00:00.000Z');
});

test('8x5 rolls over the weekend', () => {
  // Fri 16:30 local = 13:30Z. 30 min left on Friday, then 30 min on Monday: Mon 08:30 local = 05:30Z
  const d = sla.addBusinessMinutes(new Date('2026-10-30T13:30:00Z'), 60, std);
  assert.equal(iso(d), '2026-11-02T05:30:00.000Z');
});

test('start outside hours begins at the next window', () => {
  // Sat 10:00 local -> Mon 08:00 + 15 min
  const d = sla.addBusinessMinutes(new Date('2026-10-31T07:00:00Z'), 15, std);
  assert.equal(iso(d), '2026-11-02T05:15:00.000Z');
});

test('holidays are skipped', () => {
  const cal = sla.makeCalendar({ timezone: 'Africa/Nairobi', schedule: wk('08:00', '17:00') }, ['2026-11-02']);
  const d = sla.addBusinessMinutes(new Date('2026-10-30T13:30:00Z'), 60, cal);
  assert.equal(iso(d), '2026-11-03T05:30:00.000Z');
});

test('businessMinutesBetween matches addBusinessMinutes', () => {
  const a = new Date('2026-10-30T13:30:00Z');
  const b = new Date('2026-11-02T06:00:00Z'); // Mon 09:00 local
  assert.equal(sla.businessMinutesBetween(a, b, std), 90);
  assert.equal(sla.businessMinutesBetween(b, a, std), 0);
  const due = sla.addBusinessMinutes(a, 90, std);
  assert.equal(iso(due), iso(b));
});

test('pause and resume preserves the remaining supported time', () => {
  const start = new Date('2026-10-28T06:00:00Z');           // Wed 09:00 local
  const due = sla.addBusinessMinutes(start, 240, std);      // Wed 13:00 local
  const pausedAt = new Date('2026-10-28T08:00:00Z');        // Wed 11:00 local
  const remaining = sla.businessMinutesBetween(pausedAt, due, std);
  assert.equal(remaining, 120);
  const resumedAt = new Date('2026-10-30T10:00:00Z');       // Fri 13:00 local
  assert.equal(iso(sla.addBusinessMinutes(resumedAt, remaining, std)), '2026-10-30T12:00:00.000Z'); // Fri 15:00 local
});

test('validateSchedule rejects bad input', () => {
  assert.ok(sla.validateSchedule({ 1: [['08:00', '17:00']] }));
  assert.throws(() => sla.validateSchedule({ 8: [] }));
  assert.throws(() => sla.validateSchedule({ 1: [['17:00', '08:00']] }));
  assert.throws(() => sla.validateSchedule({ 1: [['08:00', '12:00'], ['11:00', '13:00']] }));
  assert.throws(() => sla.validateSchedule({ 1: [['8am', '5pm']] }));
});

test('an empty calendar fails loudly instead of looping', () => {
  const none = sla.makeCalendar({ timezone: 'Africa/Nairobi', schedule: {} });
  assert.throws(() => sla.addBusinessMinutes(new Date(), 30, none), /no supported time/);
});
