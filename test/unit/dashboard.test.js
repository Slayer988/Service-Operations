'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const d = require('../../src/services/dashboard');

test('dayKeys lists the last n days in the zone, oldest first', () => {
  // 23:30 UTC on 31 Oct is already 1 Nov in Nairobi (UTC+3)
  const keys = d.dayKeys(3, 'Africa/Nairobi', new Date('2026-10-31T23:30:00Z'));
  assert.deepEqual(keys, ['2026-10-30', '2026-10-31', '2026-11-01']);
  assert.equal(d.dayKeys(30, 'UTC', new Date('2026-03-01T12:00:00Z'))[0], '2026-01-31');
  assert.equal(d.dayLabel('2026-11-01'), 'Nov 1');
});

test('topCategories keeps four, groups the rest and sums to the total', () => {
  const rows = [{ name: 'A', n: 10 }, { name: 'B', n: 8 }, { name: 'C', n: 6 }, { name: 'D', n: 4 }, { name: 'E', n: 2 }, { name: 'F', n: 1 }, { name: 'Z', n: 0 }];
  const top = d.topCategories(rows);
  assert.deepEqual(top.map((r) => r.name), ['A', 'B', 'C', 'D', 'Other']);
  assert.equal(top[4].n, 3);
  assert.deepEqual(top.map((r) => r.cls), ['c0', 'c1', 'c2', 'c3', 'c4']);
  assert.equal(d.topCategories([]).length, 0);
});

test('slaRemaining picks the nearest unmet target and flags overdue', () => {
  const now = new Date('2026-11-01T10:00:00Z');
  const t = { response_due: '2026-11-01T09:00:00Z', responded_at: '2026-11-01T08:00:00Z', resolution_due: '2026-11-01T12:30:00Z', resolved_at: null, restoration_due: null, restored_at: null, paused_at: null };
  assert.deepEqual(d.slaRemaining(t, now), { text: '2h 30m', over: false });
  assert.equal(d.slaRemaining({ ...t, resolution_due: '2026-11-01T09:00:00Z' }, now).over, true);
  assert.deepEqual(d.slaRemaining({ ...t, paused_at: now }, now), { text: 'Paused', over: false });
  assert.equal(d.slaRemaining({ response_due: null, resolution_due: null }, now), null);
});

test('service tiles only offer categories that exist in settings; More Services is always last', () => {
  const entries = [{ name: 'Email', category: 'Email', icon: 'mail', description: 'Mailboxes. And more' }, { name: 'Network', category: 'Network', icon: 'wifi', description: '' },
    { name: 'Retired category', category: 'Gone', icon: 'grid', description: '' }];
  const tiles = d.serviceTiles(entries, ['Email', 'Network', 'Other']);
  assert.deepEqual(tiles.map((t) => t.label), ['Email', 'Network', 'More Services']);
  assert.equal(tiles[0].hint, 'Mailboxes');
  assert.equal(d.serviceTiles([], []).length, 1);
  assert.equal(d.catIcon('Printer'), 'printer');
  assert.equal(d.catIcon('Something else'), 'pulse');
  assert.equal(d.tone(95), 'ok'); assert.equal(d.tone(80), 'warn'); assert.equal(d.tone(10), 'bad'); assert.equal(d.pct(3, 1), 75); assert.equal(d.pct(0, 0), null);
});
