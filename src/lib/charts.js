'use strict';
// Server-rendered SVG charts. The page's Content-Security-Policy forbids inline scripts and inline style attributes, so the charts
// are plain SVG elements whose colours come from CSS classes (see app.css). Every number is formatted here; no user text is inserted.

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n1 = (x) => (Math.round(x * 10) / 10).toString();

/** A "nice" top value and tick step: the smallest round step that needs at most five intervals. */
function niceScale(max) {
  if (!(max > 0)) return { top: 10, step: 2.5 };
  for (let mag = 0.1; mag < 1e12; mag *= 10) {
    for (const m of [1, 2, 2.5, 5]) {
      const step = m * mag;
      if (Math.ceil(max / step - 1e-9) <= 5) return { top: step * Math.ceil(max / step - 1e-9), step };
    }
  }
  return { top: max, step: max / 4 };
}

/**
 * Two-series line chart with soft area fill.
 * labels: array of strings (x axis), series: [{ name, values, cls }]. labelEvery: show every n-th x label.
 */
function lineChart({ labels, series, width = 440, height = 220, labelEvery = 7, integer = false }) {
  const pad = { l: 34, r: 10, t: 10, b: 26 };
  const w = width - pad.l - pad.r; const h = height - pad.t - pad.b;
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  let { top, step } = niceScale(max);
  if (integer && step < 1) { step = 1; top = Math.max(1, Math.ceil(max)); }
  const x = (i) => pad.l + (labels.length < 2 ? w / 2 : (i * w) / (labels.length - 1));
  const y = (v) => pad.t + h - (v / top) * h;
  let out = `<svg class="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Line chart">`;
  for (let v = 0; v <= top + 1e-9; v += step) {
    out += `<line class="grid" x1="${pad.l}" x2="${width - pad.r}" y1="${n1(y(v))}" y2="${n1(y(v))}"/>`;
    out += `<text class="axis" x="${pad.l - 6}" y="${n1(y(v) + 4)}" text-anchor="end">${esc(n1(v))}</text>`;
  }
  labels.forEach((lab, i) => {
    const last = labels.length - 1;
    if ((i % labelEvery === 0 && (last - i >= labelEvery / 2 || i === last)) || i === last) {
      out += `<text class="axis" x="${n1(x(i))}" y="${height - 6}" text-anchor="${i === 0 ? 'start' : i === labels.length - 1 ? 'end' : 'middle'}">${esc(lab)}</text>`;
    }
  });
  for (const s of series) {
    const pts = s.values.map((v, i) => [x(i), y(v)]);
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${n1(p[0])} ${n1(p[1])}`).join(' ');
    out += `<path class="area ${esc(s.cls)}" d="${line} L${n1(pts[pts.length - 1][0])} ${n1(pad.t + h)} L${n1(pts[0][0])} ${n1(pad.t + h)} Z"/>`;
    out += `<path class="line ${esc(s.cls)}" d="${line}"/>`;
  }
  return `${out}</svg>`;
}

/** Donut: segments [{ value, cls }] drawn with stroke-dasharray on a circle of circumference 100. */
function donut(segments, { size = 150, thickness = 4.2 } = {}) {
  const total = segments.reduce((a, s) => a + s.value, 0);
  let out = `<svg class="donut" viewBox="0 0 42 42" width="${size}" height="${size}" role="img" aria-label="Donut chart">`;
  out += `<circle class="donut-bg" cx="21" cy="21" r="15.9155" fill="none" stroke-width="${thickness}"/>`;
  if (total > 0) {
    let offset = 25;   // start at 12 o'clock
    for (const s of segments) {
      if (!(s.value > 0)) continue;
      const pct = (s.value / total) * 100;
      out += `<circle class="${esc(s.cls)}" cx="21" cy="21" r="15.9155" fill="none" stroke-width="${thickness}" stroke-dasharray="${n1(pct)} ${n1(100 - pct)}" stroke-dashoffset="${n1(offset)}"/>`;
      offset -= pct;
    }
  }
  return `${out}</svg>`;
}

/** Horizontal bar (0-100). Width is an SVG attribute, so no style attribute is needed. */
function bar(pct, cls = 'ok') {
  const p = Math.max(0, Math.min(100, Number(pct) || 0));
  return `<svg class="bar" viewBox="0 0 100 6" preserveAspectRatio="none" role="img" aria-label="${n1(p)} percent"><rect class="bar-bg" x="0" y="0" width="100" height="6" rx="3"/><rect class="bar-fill ${esc(cls)}" x="0" y="0" width="${n1(p)}" height="6" rx="3"/></svg>`;
}

/** "1h 24m", "32m", "2d 3h"; negative values (overdue) get a leading minus sign. */
function duration(ms) {
  const neg = ms < 0; let m = Math.round(Math.abs(ms) / 60000);
  const d = Math.floor(m / 1440); m -= d * 1440;
  const h = Math.floor(m / 60); m -= h * 60;
  const s = d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
  return neg ? `- ${s}` : s;
}

/** Percentage change as text and direction, or null when there is nothing to compare with. */
function delta(now, before) {
  if (!(before > 0)) return null;
  const pct = Math.round(((now - before) / before) * 100);
  return { pct, text: `${pct > 0 ? '+' : ''}${pct}%`, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' };
}

/** Horizontal bars with a label on the left and a value text on the right. items: [{ label, value, text }]. Bars are scaled to the largest value. */
function hbars(items, { labelW = 24 } = {}) {
  const rowH = 9; const h = Math.max(rowH, items.length * rowH); const span = 72 - labelW;
  const max = Math.max(0, ...items.map((i) => i.value));
  let out = `<svg class="hbar" viewBox="0 0 100 ${h}" role="img" aria-label="Bar chart">`;
  items.forEach((it, i) => {
    const y = i * rowH; const w = max > 0 ? (it.value / max) * span : 0;
    out += `<text class="lab" x="0" y="${y + 5.6}">${esc(it.label)}</text><rect class="bg" x="${labelW}" y="${y + 1.5}" width="${span}" height="5" rx="1.5"/>`;
    if (w > 0) out += `<rect class="b" x="${labelW}" y="${y + 1.5}" width="${n1(Math.max(1, w))}" height="5" rx="1.5"/>`;
    out += `<text class="val" x="74" y="${y + 5.6}">${esc(it.text)}</text>`;
  });
  return `${out}</svg>`;
}

module.exports = { lineChart, donut, bar, hbars, duration, delta, niceScale };
