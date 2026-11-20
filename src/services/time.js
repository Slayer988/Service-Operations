'use strict';
// Time spent on tickets: logged by whoever does the work, chargeable or not (following the ticket by default), and summed into
// timesheets per person and per customer. The figures feed invoicing.
const u = require('../lib/util');
const audit = require('../lib/audit');
const { UserError } = require('./tickets');

/** "90", "1h30", "1h 30m", "1:30", "1.5h", "45m" -> minutes; null when it cannot be read. */
function readDuration(v) {
  const s = String(v === undefined || v === null ? '' : v).trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  let m = /^(\d{1,4})m?(?:in|ins|inutes?)?$/.exec(s); if (m) return Number(m[1]);
  m = /^(\d{1,2}):([0-5]\d)$/.exec(s); if (m) return Number(m[1]) * 60 + Number(m[2]);
  m = /^(\d{1,2}(?:[.,]\d{1,2})?)h(?:rs?|ours?)?$/.exec(s); if (m) return Math.round(Number(m[1].replace(',', '.')) * 60);
  m = /^(\d{1,2})h(?:rs?|ours?)?(\d{1,2})m?(?:in|ins|inutes?)?$/.exec(s); if (m) return Number(m[1]) * 60 + Number(m[2]);
  return null;
}
const show = (min) => { const h = Math.floor(min / 60); const m = min % 60; return h ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`; };

async function log(db, ticket, actor, input, today, ip = '') {
  const minutes = readDuration(input.duration !== undefined ? input.duration : input.minutes);
  if (!minutes || minutes < 1 || minutes > 1440) throw new UserError('Time spent: write it as minutes (45), hours and minutes (1h 30m or 1:30), or hours (1.5h); at most 24 hours in one entry.');
  const day = input.work_date ? u.dateStr(input.work_date) : today;
  if (!day) throw new UserError('The date is not valid.');
  if (day > today) throw new UserError('Time cannot be logged for a future day.');
  if (u.dayDiff(day, today) > 60) throw new UserError('Time older than 60 days cannot be logged here; ask a service manager.');
  const billable = input.billable === undefined || input.billable === null ? !ticket.non_chargeable : (input.billable === true || input.billable === '1' || input.billable === 'on');
  const row = (await db.query(`insert into ticket_time (ticket_id, user_id, work_date, minutes, billable, note) values ($1,$2,$3,$4,$5,$6) returning *`,
    [ticket.id, actor.id, day, minutes, billable, u.str(input.note, 500)])).rows[0];
  await db.query(`insert into ticket_events (ticket_id, actor_id, kind, text, internal) values ($1,$2,'time',$3,true)`,
    [ticket.id, actor.id, `${actor.name} logged ${show(minutes)}${billable ? '' : ' (non-chargeable)'}${row.note ? `: ${row.note}` : ''}.`]);
  return row;
}

/** Only the person who logged it (within 7 days) or a manager removes an entry. */
async function remove(db, entryId, actor, managers, today, ip = '') {
  const e = (await db.query('select tt.*, t.ref from ticket_time tt join tickets t on t.id = tt.ticket_id where tt.id = $1', [entryId])).rows[0];
  if (!e) throw new UserError('That time entry does not exist.');
  const own = Number(e.user_id) === actor.id;
  if (!managers && !(own && u.dayDiff(e.work_date, today) <= 7)) throw new UserError('You can remove only your own time, within 7 days. Ask a service manager.');
  await db.query('delete from ticket_time where id = $1', [entryId]);
  await db.query(`insert into ticket_events (ticket_id, actor_id, kind, text, internal) values ($1,$2,'time',$3,true)`, [e.ticket_id, actor.id, `${actor.name} removed a time entry of ${show(e.minutes)} (${e.work_date}).`]);
  if (!own) await audit(db, actor, 'time_removed', 'ticket', e.ref, `${show(e.minutes)} on ${e.work_date} by user ${e.user_id}`, null, ip);
  return e;
}

async function forTicket(db, ticketId) {
  const rows = (await db.query(`select tt.*, u.name as user_name from ticket_time tt join users u on u.id = tt.user_id where tt.ticket_id = $1 order by tt.work_date desc, tt.id desc`, [ticketId])).rows;
  const total = rows.reduce((a, r) => a + r.minutes, 0); const billable = rows.filter((r) => r.billable).reduce((a, r) => a + r.minutes, 0);
  return { rows, total, billable };
}

/** Monday of the week containing `day` (YYYY-MM-DD). */
function monday(day) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function addDays(day, n) { const d = new Date(`${day}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }

module.exports = { readDuration, show, log, remove, forTicket, monday, addDays };
