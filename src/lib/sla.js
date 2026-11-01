'use strict';
// Calendar-aware SLA arithmetic (SLA-002, SLA-004, SLA-005).
// A calendar is { timezone, schedule, holidays } where schedule maps ISO weekday ("1" = Monday) to
// a list of ["HH:MM","HH:MM"] windows inside one local day. Overnight windows are not supported:
// split them into two days. "24:00" is allowed as an end time.

const fmtCache = new Map();
function dtf(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    fmtCache.set(tz, f);
  }
  return f;
}

function localParts(date, tz) {
  const p = {};
  for (const x of dtf(tz).formatToParts(date)) p[x.type] = x.value;
  return { y: +p.year, mo: +p.month, d: +p.day, h: (+p.hour) % 24, mi: +p.minute, s: +p.second };
}

function tzOffsetMs(date, tz) {
  const l = localParts(date, tz);
  return Date.UTC(l.y, l.mo - 1, l.d, l.h, l.mi, l.s) - Math.floor(date.getTime() / 1000) * 1000;
}

/** Convert a wall-clock time in a time zone to a UTC Date. Hour 24 means midnight at the end of the day. */
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off = tzOffsetMs(new Date(guess), tz);
  let t = guess - off;
  const off2 = tzOffsetMs(new Date(t), tz);
  if (off2 !== off) t = guess - off2;
  return new Date(t);
}

function hm(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`Bad time "${s}"`);
  const v = (+m[1]) * 60 + (+m[2]);
  if (v < 0 || v > 1440) throw new Error(`Bad time "${s}"`);
  return v;
}

function validateSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object') throw new Error('Schedule must be an object');
  for (const [day, wins] of Object.entries(schedule)) {
    if (!/^[1-7]$/.test(day)) throw new Error(`Bad weekday "${day}"`);
    if (!Array.isArray(wins)) throw new Error(`Weekday ${day} must be a list`);
    let last = -1;
    for (const w of wins) {
      if (!Array.isArray(w) || w.length !== 2) throw new Error(`Weekday ${day}: each window needs a start and an end`);
      const s = hm(w[0]); const e = hm(w[1]);
      if (e <= s) throw new Error(`Weekday ${day}: window ${w[0]}-${w[1]} must end after it starts`);
      if (s < last) throw new Error(`Weekday ${day}: windows overlap or are out of order`);
      last = e;
    }
  }
  return true;
}

function makeCalendar(row, holidayDays = []) {
  return {
    timezone: row.timezone,
    schedule: row.schedule,
    holidays: new Set(holidayDays.map((d) => (d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10)))),
  };
}

function windowsForDay(cal, y, mo, d) {
  const key = `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  if (cal.holidays.has(key)) return [];
  const weekday = new Date(Date.UTC(y, mo - 1, d)).getUTCDay() || 7;
  const wins = cal.schedule[String(weekday)] || [];
  return wins.map(([s, e]) => {
    const sm = hm(s); const em = hm(e);
    return [
      zonedToUtc(y, mo, d, Math.floor(sm / 60), sm % 60, cal.timezone).getTime(),
      zonedToUtc(y, mo, d, Math.floor(em / 60), em % 60, cal.timezone).getTime(),
    ];
  }).sort((a, b) => a[0] - b[0]);
}

/** The moment that is `minutes` of supported time after `start`. */
function addBusinessMinutes(start, minutes, cal) {
  let remaining = Math.max(0, Math.round(minutes));
  const startMs = start.getTime();
  if (remaining === 0) return new Date(startMs);
  const l = localParts(start, cal.timezone);
  let dayMs = Date.UTC(l.y, l.mo - 1, l.d);
  for (let i = 0; i < 800; i++) {
    const dd = new Date(dayMs);
    for (const [ws, we] of windowsForDay(cal, dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate())) {
      const from = Math.max(startMs, ws);
      if (from >= we) continue;
      const avail = (we - from) / 60000;
      if (remaining <= avail) return new Date(from + remaining * 60000);
      remaining -= avail;
    }
    dayMs += 86400000;
  }
  throw new Error('The SLA calendar has no supported time in the next 800 days. Check its schedule.');
}

/** Minutes of supported time between a and b (0 if b is not after a). */
function businessMinutesBetween(a, b, cal) {
  const aMs = a.getTime(); const bMs = b.getTime();
  if (bMs <= aMs) return 0;
  const la = localParts(a, cal.timezone);
  const lb = localParts(b, cal.timezone);
  let dayMs = Date.UTC(la.y, la.mo - 1, la.d);
  const lastDay = Date.UTC(lb.y, lb.mo - 1, lb.d);
  let total = 0;
  for (let guard = 0; dayMs <= lastDay && guard < 4000; guard++) {
    const dd = new Date(dayMs);
    for (const [ws, we] of windowsForDay(cal, dd.getUTCFullYear(), dd.getUTCMonth() + 1, dd.getUTCDate())) {
      const from = Math.max(aMs, ws); const to = Math.min(bMs, we);
      if (to > from) total += (to - from) / 60000;
    }
    dayMs += 86400000;
  }
  return total;
}

const TARGETS = ['response', 'restoration', 'resolution'];

module.exports = {
  localParts, zonedToUtc, validateSchedule, makeCalendar, addBusinessMinutes, businessMinutesBetween, TARGETS,
};
