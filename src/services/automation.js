'use strict';
// Automation rules: applied in order to every new ticket, from every channel. Conditions (all must match) on where it came from, its
// type, queue, category, customer, priority, words in the subject or description and the sender's e-mail domain. Actions: set the
// impact and urgency (and so the priority and SLA), move it to a queue or tier, assign it, add an internal note. "Stop" ends the run.
const u = require('../lib/util');
const { UserError } = require('./tickets');

const SOURCES = { email: 'E-mail', portal: 'Customer portal', agent: 'Staff (phone, walk-in)', guest: 'Request without signing in' };

function words(v) { return String(v || '').split(/[,\n;]+/).map((w) => w.trim().toLowerCase()).filter(Boolean).slice(0, 30); }

function read(b, people) {
  const c = {}; const a = {};
  for (const k of ['source', 'type', 'queue']) { const v = String(b[`c_${k}`] || ''); if (v) c[k] = v; }
  if (c.source && !SOURCES[c.source]) delete c.source;
  if (c.type && !['incident', 'request'].includes(c.type)) delete c.type;
  if (c.queue && !['it_services', 'security'].includes(c.queue)) delete c.queue;
  if (u.str(b.c_category, 80)) c.category = u.str(b.c_category, 80);
  if (u.id(b.c_customer_id)) c.customer_id = u.id(b.c_customer_id);
  const pm = u.intIn(b.c_priority_max, 1, 4); if (pm) c.priority_max = pm;
  const w = words(b.c_words); if (w.length) c.words = w;
  const dom = u.str(b.c_domain, 120).toLowerCase().replace(/^@/, ''); if (dom) c.domain = dom;
  const imp = u.intIn(b.a_impact, 1, 3); const urg = u.intIn(b.a_urgency, 1, 3);
  if (imp || urg) { if (!imp || !urg) throw new UserError('To change the priority, set both the impact and the urgency.'); a.impact = imp; a.urgency = urg; }
  if (['it_services', 'security'].includes(b.a_queue)) a.queue = b.a_queue;
  if (['l1', 'l2', 'l3'].includes(b.a_tier)) a.tier = b.a_tier;
  if (u.id(b.a_assignee_id)) { if (people && !people.some((p) => Number(p.id) === Number(b.a_assignee_id))) throw new UserError('Choose an active member of staff to assign to.'); a.assignee_id = u.id(b.a_assignee_id); }
  const note = u.str(b.a_note, 1000); if (note) a.note = note;
  const name = u.str(b.name, 120);
  if (!name) throw new UserError('Give the rule a name, for example "Firewall alerts go to the Security queue".');
  if (!Object.keys(a).length) throw new UserError('Choose at least one thing the rule does.');
  if (!Object.keys(c).length) throw new UserError('Choose at least one condition: a rule with none would act on every ticket.');
  return { name, conditions: c, actions: a, stop: b.stop === '1', active: b.active !== '0' };
}

/** Does a new ticket (what createTicket was given, plus its computed priority) meet the rule's conditions? */
function matches(cond, t) {
  if (cond.source && t.source !== cond.source) return false;
  if (cond.type && t.type !== cond.type) return false;
  if (cond.queue && (t.queue || 'it_services') !== cond.queue) return false;
  if (cond.category && String(t.category || '').toLowerCase() !== cond.category.toLowerCase()) return false;
  if (cond.customer_id && Number(t.customer_id) !== Number(cond.customer_id)) return false;
  if (cond.priority_max && !(Number(t.priority) <= cond.priority_max)) return false;
  if (cond.words && cond.words.length) { const text = `${t.subject || ''}\n${t.description || ''}`.toLowerCase(); if (!cond.words.some((w) => text.includes(w))) return false; }
  if (cond.domain) { const e = String(t.requester_email || '').toLowerCase(); if (!(e.endsWith(`@${cond.domain}`) || e.endsWith(`.${cond.domain}`))) return false; }
  return true;
}

/** The active rules in order. */
async function active(db) { return (await db.query('select * from automation_rules where active order by position, id')).rows; }

/** Applies the matching rules to the input of a new ticket: returns { changes for the insert, after: [{rule, actions}] }. */
async function beforeCreate(db, t) {
  const rules = await active(db);
  const hit = []; const set = {};
  for (const r of rules) {
    if (!matches(r.conditions || {}, { ...t, ...set })) continue;
    hit.push(r);
    const a = r.actions || {};
    if (a.impact && a.urgency) { set.impact = a.impact; set.urgency = a.urgency; set.priority = null; }
    if (a.queue) set.queue = a.queue;
    if (a.tier) set.tier = a.tier;
    if (r.stop) break;
  }
  return { set, hit };
}

/** After the ticket exists: assignments and notes, the record of what each rule did, and the rule counters. */
async function afterCreate(db, ticket, hit) {
  if (!hit.length) return ticket;
  const tickets = require('./tickets');
  let t = ticket;
  for (const r of hit) {
    const a = r.actions || {}; const did = [];
    const robot = { id: null, name: `Rule "${r.name}"`, kind: 'staff', role: 'platform_admin' };
    if (a.impact) did.push(`priority from impact ${a.impact} and urgency ${a.urgency}`);
    if (a.queue) did.push(`queue ${a.queue === 'security' ? 'Security' : 'IT Services'}`);
    if (a.tier) did.push(`tier ${a.tier.toUpperCase()}`);
    if (a.assignee_id) { try { t = await tickets.assign(db, t, a.assignee_id, robot); did.push('assigned'); } catch (e) { did.push(`could not assign (${e.userMessage || e.message})`); } }
    if (a.note) await db.query(`insert into ticket_events (ticket_id, actor_id, kind, text, internal) values ($1,null,'automation',$2,true)`, [t.id, `Note from rule "${r.name}": ${a.note}`]);
    await db.query(`insert into ticket_events (ticket_id, actor_id, kind, text, internal) values ($1,null,'automation',$2,true)`, [t.id, `Automation rule "${r.name}" applied: ${did.join(', ') || 'note added'}.`]);
    await db.query('update automation_rules set run_count = run_count + 1, last_run_at = now() where id = $1', [r.id]);
  }
  return tickets.summary(db, t.id);
}

/** For the rule form: how many of the last `n` tickets the conditions would have matched. */
async function preview(db, conditions, n = 200) {
  const rows = (await db.query(`select ref, subject, description, source, type, queue, category, customer_id, priority, requester_email from tickets order by id desc limit $1`, [n])).rows;
  const hits = rows.filter((t) => matches(conditions, t));
  return { checked: rows.length, matched: hits.length, examples: hits.slice(0, 5).map((t) => `${t.ref} ${t.subject}`) };
}

/** Plain-words summary of a rule, for the list. */
function describe(r, names = {}) {
  const c = r.conditions || {}; const a = r.actions || {}; const when = []; const then = [];
  if (c.source) when.push(`from ${SOURCES[c.source]}`); if (c.type) when.push(`${c.type}s`); if (c.queue) when.push(`in ${c.queue === 'security' ? 'Security' : 'IT Services'}`);
  if (c.category) when.push(`category "${c.category}"`); if (c.customer_id) when.push(`for ${names.customers && names.customers[c.customer_id] || 'a customer'}`);
  if (c.priority_max) when.push(`priority P${c.priority_max} or higher`); if (c.words) when.push(`mentioning ${c.words.map((w) => `"${w}"`).join(' or ')}`); if (c.domain) when.push(`sent from @${c.domain}`);
  if (a.impact) then.push(`set impact ${a.impact} / urgency ${a.urgency}`); if (a.queue) then.push(`move to ${a.queue === 'security' ? 'Security' : 'IT Services'}`); if (a.tier) then.push(`tier ${a.tier.toUpperCase()}`);
  if (a.assignee_id) then.push(`assign to ${names.people && names.people[a.assignee_id] || 'someone'}`); if (a.note) then.push('add a note');
  return { when: when.join(', '), then: then.join(', ') };
}

module.exports = { SOURCES, read, matches, active, beforeCreate, afterCreate, preview, describe, words };
