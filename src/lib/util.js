'use strict';

/** Positive integer from user input, or null. */
function id(v) {
  if (typeof v === 'number' && Number.isInteger(v) && v > 0) return v;
  if (typeof v !== 'string' || !/^[0-9]{1,15}$/.test(v)) return null;
  const n = parseInt(v, 10);
  return n > 0 ? n : null;
}

/** Integer in a range, or null. */
function intIn(v, min, max) {
  if (typeof v !== 'string' && typeof v !== 'number') return null;
  const s = String(v).trim();
  if (!/^-?[0-9]{1,9}$/.test(s)) return null;
  const n = parseInt(s, 10);
  return n >= min && n <= max ? n : null;
}

function str(v, max = 255) {
  if (v === undefined || v === null) return '';
  return String(v).replace(/\r\n/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
}

function oneOf(v, list, fallback = null) {
  return list.includes(v) ? v : fallback;
}

/** YYYY-MM-DD string or null. */
function dateStr(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + 'T00:00:00Z');
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? null : v;
}

const EMAIL_RE = /^[^\s@<>()]{1,64}@[^\s@<>()]{1,255}\.[^\s@<>()]{2,}$/;
function email(v) {
  const s = str(v, 320).toLowerCase();
  return EMAIL_RE.test(s) ? s : null;
}

/** Only allow redirects to local paths. */
function safeNext(v, fallback = '/') {
  if (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') && !v.includes('\\')) return v;
  return fallback;
}

/** CSV with protection against spreadsheet formula injection. */
function toCsv(rows, columns) {
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    let s = v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(',')];
  for (const r of rows) lines.push(columns.map((c) => cell(r[c.key])).join(','));
  return lines.join('\r\n') + '\r\n';
}

/** Money / quantity from a form: null when blank, NaN when invalid, else a number with at most 2 decimals (thousand separators allowed). */
function money(v, max = 1e13) {
  if (v === undefined || v === null || String(v).trim() === '') return null;
  const s = String(v).replace(/[,\s]/g, '');
  if (!/^\d{1,14}(\.\d{1,3})?$/.test(s)) return NaN;
  const n = Number(s);
  return n <= max ? n : NaN;
}

/** Calendar-day difference (b - a) for YYYY-MM-DD strings or Dates (local calendar days, no time-zone drift). */
function dayDiff(a, b) {
  const d = (x) => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(x instanceof Date ? [x.getFullYear(), String(x.getMonth() + 1).padStart(2, '0'), String(x.getDate()).padStart(2, '0')].join('-') : String(x)); return Date.UTC(+m[1], +m[2] - 1, +m[3]); };
  return Math.round((d(b) - d(a)) / 86400000);
}

/** The calendar date (YYYY-MM-DD) in a time zone, `shift` days from now. The server clock is UTC-based, so toISOString() is a day behind
 *  for the first hours of each local day (Kampala is UTC+3: midnight to 03:00). */
function localDay(tz, shift = 0, now = new Date()) {
  const d = new Date(now.getTime() + shift * 86400000);
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

/** A date and time as read in a time zone, with the zone named: "2026-11-02 08:00 (Africa/Kampala)". 'n/a' when there is none. */
function localStamp(d, tz) {
  if (!d) return 'n/a';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return 'n/a';
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} (${tz})`;
}

module.exports = { id, intIn, str, oneOf, dateStr, email, safeNext, toCsv, money, dayDiff, localDay, localStamp };
