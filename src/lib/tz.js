'use strict';
// Date and time as typed in a <input type="datetime-local"> (no zone) <-> an exact moment, in the application's time zone.

function parts(ts, tz) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const o = {};
  for (const p of f.formatToParts(new Date(ts))) o[p.type] = p.value;
  return o;
}
function offsetMs(ts, tz) {
  const p = parts(ts, tz);
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ts / 1000) * 1000;
}

/** "2026-11-30T14:00" typed in zone `tz` -> Date (or null for anything that is not a valid local date-time). */
function localToDate(text, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})$/.exec(String(text || '').trim());
  if (!m) return null;
  const [Y, M, D, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, mi);
  const check = new Date(guess);
  if (check.getUTCFullYear() !== Y || check.getUTCMonth() !== M - 1 || check.getUTCDate() !== D || h > 23 || mi > 59) return null;
  let utc = guess - offsetMs(guess, tz);
  const off2 = offsetMs(utc, tz);
  if (off2 !== guess - utc) utc = guess - off2;
  return new Date(utc);
}

/** Date -> "YYYY-MM-DDTHH:mm" in zone `tz`, for filling a datetime-local input. */
function dateToLocal(d, tz) {
  if (!d) return '';
  const p = parts(new Date(d).getTime(), tz);
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

module.exports = { localToDate, dateToLocal };
