'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const c = require('../../src/lib/charts');

test('niceScale picks round tick steps', () => {
  assert.deepEqual(c.niceScale(47), { top: 50, step: 10 });
  assert.deepEqual(c.niceScale(50), { top: 50, step: 10 });
  assert.deepEqual(c.niceScale(3), { top: 3, step: 1 });
  assert.deepEqual(c.niceScale(0), { top: 10, step: 2.5 });
  assert.deepEqual(c.niceScale(1200), { top: 1250, step: 250 });
});

test('lineChart draws every series, labels the axis, and contains no style attributes or scripts', () => {
  const labels = Array.from({ length: 30 }, (_, i) => `D${i}`);
  const svg = c.lineChart({ labels, series: [{ name: 'Created', values: labels.map((_, i) => i % 7), cls: 's0' }, { name: 'Resolved', values: labels.map(() => 3), cls: 's1' }] });
  assert.match(svg, /^<svg class="chart"/);
  assert.equal((svg.match(/class="line s\d"/g) || []).length, 2);
  assert.match(svg, />D0</); assert.match(svg, />D29</);
  assert.ok(!/style=|<script|onload=/i.test(svg));
  assert.ok(!svg.includes('NaN'));
});

test('lineChart copes with no data', () => {
  const svg = c.lineChart({ labels: ['a'], series: [{ name: 'x', values: [0], cls: 's0' }] });
  assert.ok(!svg.includes('NaN') && !svg.includes('Infinity'));
});

test('donut segments add up to the full circle and skip empty values', () => {
  const svg = c.donut([{ value: 28, cls: 'c0' }, { value: 0, cls: 'c1' }, { value: 72, cls: 'c2' }]);
  assert.equal((svg.match(/stroke-dasharray/g) || []).length, 2);
  assert.match(svg, /stroke-dasharray="28 72"/); assert.match(svg, /stroke-dasharray="72 28"/);
  assert.ok(!c.donut([]).includes('stroke-dasharray'));
});

test('bar clamps and has no style attribute', () => {
  assert.match(c.bar(250), /width="100"/); assert.match(c.bar(-5), /width="0"/); assert.match(c.bar('abc'), /width="0"/);
  assert.ok(!/style=/.test(c.bar(50)));
});

test('duration and delta', () => {
  assert.equal(c.duration(84 * 60000), '1h 24m'); assert.equal(c.duration(-32 * 60000), '- 32m'); assert.equal(c.duration(27 * 3600000), '1d 3h');
  assert.deepEqual(c.delta(42, 51), { pct: -18, text: '-18%', dir: 'down' });
  assert.equal(c.delta(5, 0), null); assert.equal(c.delta(128, 100).text, '+28%');
});

test('hbars scales to the largest value and escapes text', () => {
  const svg = c.hbars([{ label: 'Lead <1>', value: 50, text: '50' }, { label: 'Won', value: 100, text: '100' }, { label: 'None', value: 0, text: '0' }]);
  assert.match(svg, /Lead &lt;1&gt;/);
  assert.match(svg, /viewBox="0 0 100 27"/);
  assert.equal((svg.match(/class="b"/g) || []).length, 2);
  assert.match(svg, /width="48"/);
  assert.doesNotMatch(c.hbars([]), /NaN/);
});
