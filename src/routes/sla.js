'use strict';
// Business calendars and SLA policies (SLA-002, SLA-003, SLA-004).
const express = require('express');
const { q, tx } = require('../db');
const perms = require('../lib/perms');
const sla = require('../lib/sla');
const audit = require('../lib/audit');
const u = require('../lib/util');
const tickets = require('../services/tickets');
const { wrap } = require('./util');
const { requireStaff, requirePerm } = require('../middleware/auth');

const router = express.Router();
const configure = [requireStaff, requirePerm('sla.configure')];

function validZone(tz) { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch (_) { return false; } }

router.get('/sla', requireStaff, requirePerm('ticket.view'), wrap(async (req, res) => {
  const calendars = (await q('select * from calendars order by name')).rows;
  const holidays = (await q('select * from holidays order by day')).rows;
  const policies = (await q('select p.*, c.name as calendar_name from sla_policies p join calendars c on c.id = p.calendar_id order by p.name')).rows;
  const targets = (await q('select * from sla_targets order by policy_id, priority')).rows;
  res.render('staff/sla', {
    title: 'SLA policies and calendars', calendars, holidays, policies, targets, canConfigure: perms.can(req.user, 'sla.configure'),
    schedules: Object.fromEntries(calendars.map((c) => [c.id, JSON.stringify(c.schedule)])),
  });
}));

router.post('/sla/calendars', configure, wrap(async (req, res) => {
  const name = u.str(req.body.name, 60); const tz = u.str(req.body.timezone, 60);
  if (!name || !validZone(tz)) throw new tickets.UserError('Enter a name and a valid time zone such as Africa/Nairobi.');
  let schedule;
  try { schedule = JSON.parse(req.body.schedule); sla.validateSchedule(schedule); } catch (e) { throw new tickets.UserError(`Schedule problem: ${e.message}`); }
  try { await q('insert into calendars (name, timezone, schedule) values ($1,$2,$3)', [name, tz, JSON.stringify(schedule)]); }
  catch (e) { if (e.code === '23505') throw new tickets.UserError('A calendar with that name exists.'); throw e; }
  await audit({ query: q }, req.user, 'calendar_created', 'calendar', name, '', null, req.ip);
  res.redirect('/sla');
}));

router.post('/sla/calendars/:id', configure, wrap(async (req, res) => {
  const id = u.id(req.params.id); const tz = u.str(req.body.timezone, 60);
  if (!validZone(tz)) throw new tickets.UserError('Invalid time zone.');
  let schedule;
  try { schedule = JSON.parse(req.body.schedule); sla.validateSchedule(schedule); } catch (e) { throw new tickets.UserError(`Schedule problem: ${e.message}`); }
  const r = await q('update calendars set timezone = $2, schedule = $3 where id = $1 returning name', [id, tz, JSON.stringify(schedule)]);
  if (!r.rows[0]) return res.status(404).render('error', { title: 'Not found', message: 'Not found.' });
  await audit({ query: q }, req.user, 'calendar_updated', 'calendar', r.rows[0].name, 'Affects deadlines of tickets created from now on.', null, req.ip);
  req.flash('success', 'Calendar saved. Deadlines of existing tickets are not changed.');
  return res.redirect('/sla');
}));

router.post('/sla/calendars/:id/holidays', configure, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  if (req.body.remove) { await q('delete from holidays where calendar_id = $1 and day = $2', [id, u.dateStr(req.body.remove)]); return res.redirect('/sla'); }
  const day = u.dateStr(req.body.day);
  if (!day) throw new tickets.UserError('Enter the holiday date.');
  await q('insert into holidays (calendar_id, day, name) values ($1,$2,$3) on conflict (calendar_id, day) do update set name = excluded.name', [id, day, u.str(req.body.name, 100)]);
  await audit({ query: q }, req.user, 'holiday_added', 'calendar', id, day, null, req.ip);
  return res.redirect('/sla');
}));

function readTargets(body) {
  const out = [];
  for (const p of [1, 2, 3, 4]) {
    const r = u.intIn(body[`p${p}_response`], 1, 525600); const s = u.intIn(body[`p${p}_restoration`], 1, 525600); const l = u.intIn(body[`p${p}_resolution`], 1, 525600);
    if (!r || !s || !l) throw new tickets.UserError('Every priority needs response, restoration and resolution minutes (numbers above zero).');
    out.push([p, r, s, l]);
  }
  return out;
}

router.post('/sla/policies', configure, wrap(async (req, res) => {
  const name = u.str(req.body.name, 80); const cal = u.id(req.body.calendar_id);
  if (!name || !cal) throw new tickets.UserError('Enter a name and choose a calendar.');
  const targets = readTargets(req.body);
  await tx(async (db) => {
    let id;
    try { id = (await db.query('insert into sla_policies (name, description, calendar_id) values ($1,$2,$3) returning id', [name, u.str(req.body.description, 300), cal])).rows[0].id; }
    catch (e) { if (e.code === '23505') throw new tickets.UserError('A policy with that name exists.'); throw e; }
    for (const t of targets) await db.query('insert into sla_targets (policy_id, priority, response_min, restoration_min, resolution_min) values ($1,$2,$3,$4,$5)', [id, ...t]);
    await audit(db, req.user, 'sla_policy_created', 'sla_policy', name, '', null, req.ip);
  });
  res.redirect('/sla');
}));

router.post('/sla/policies/:id', configure, wrap(async (req, res) => {
  const id = u.id(req.params.id);
  const targets = readTargets(req.body);
  await tx(async (db) => {
    const r = await db.query('update sla_policies set description = $2, calendar_id = coalesce($3, calendar_id), active = $4 where id = $1 returning name', [id, u.str(req.body.description, 300), u.id(req.body.calendar_id), req.body.active === 'on']);
    if (!r.rows[0]) throw new tickets.UserError('Policy not found.', 404);
    for (const t of targets) {
      await db.query(`insert into sla_targets (policy_id, priority, response_min, restoration_min, resolution_min) values ($1,$2,$3,$4,$5)
        on conflict (policy_id, priority) do update set response_min = excluded.response_min, restoration_min = excluded.restoration_min, resolution_min = excluded.resolution_min`, [id, ...t]);
    }
    await audit(db, req.user, 'sla_policy_updated', 'sla_policy', r.rows[0].name, 'Applies to tickets created from now on.', null, req.ip);
  });
  req.flash('success', 'Policy saved. It applies to tickets created from now on.');
  res.redirect('/sla');
}));

module.exports = router;
