'use strict';
// Reply templates: text an agent inserts into a reply and edits before sending. Personal, or shared with the whole desk.
// Placeholders are filled from the ticket: {{requester_name}}, {{customer_name}}, {{ticket_ref}}, {{ticket_subject}}, {{csid}}, {{agent_name}}.
const u = require('../lib/util');
const { UserError } = require('./tickets');

const TITLES = /^(dr|mr|mrs|ms|miss|mx|prof|eng|engr|hon|rev|fr|sr|sir|madam|mme|capt|col|maj|gen|lt|sgt|pr|pst|dkt|bishop|sheikh|hajji?|hajjat)\.?$/i;
const PLACEHOLDERS = { requester_name: 'the requester\'s first name', customer_name: 'the customer', ticket_ref: 'the ticket reference', ticket_subject: 'the ticket subject', csid: 'the CSID', agent_name: 'your name' };

function read(b) {
  const v = { title: u.str(b.title, 120), body: String(b.body || '').replace(/\r\n?/g, '\n').trim().slice(0, 8000), category: u.str(b.category, 60), shared: b.shared === '1' };
  if (!v.title) throw new UserError('Give the template a short title, for example "Asking for a screenshot".');
  if (!v.body) throw new UserError('Write the template text.');
  const bad = [...v.body.matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]).filter((k) => !PLACEHOLDERS[k]);
  if (bad.length) throw new UserError(`Unknown placeholder${bad.length > 1 ? 's' : ''}: ${[...new Set(bad)].map((k) => `{{${k}}}`).join(', ')}. Use ${Object.keys(PLACEHOLDERS).map((k) => `{{${k}}}`).join(', ')}.`);
  return v;
}

/** Templates this person may use: their own and the shared ones. */
async function usable(db, user) {
  return (await db.query(`select id, title, category, shared, owner_id from reply_templates where shared or owner_id = $1 order by category, use_count desc, title`, [user.id])).rows;
}

const canEdit = (user, t, canShared) => (t.shared ? canShared : Number(t.owner_id) === user.id);

async function save(db, user, b, canShared, existing = null) {
  const v = read(b);
  if (v.shared && !canShared) throw new UserError('Only service managers share templates with the whole desk. Keep it personal, or ask one to share it.');
  if (existing) {
    if (!canEdit(user, existing, canShared)) throw new UserError('You cannot change this template.');
    return (await db.query(`update reply_templates set title=$2, body=$3, category=$4, shared=$5, owner_id = case when $5 then owner_id else coalesce(owner_id, $6) end, updated_at=now() where id=$1 returning *`,
      [existing.id, v.title, v.body, v.category, v.shared, user.id])).rows[0];
  }
  return (await db.query(`insert into reply_templates (title, body, category, shared, owner_id) values ($1,$2,$3,$4,$5) returning *`, [v.title, v.body, v.category, v.shared, user.id])).rows[0];
}

/** The template with the ticket's details filled in, ready to insert. */
function fill(body, ticket, agent) {
  // the first name, skipping a title (Dr. Sarah Achieng -> Sarah)
  const words = String(ticket.requester_name || '').trim().split(/\s+/).filter(Boolean);
  while (words.length > 1 && TITLES.test(words[0])) words.shift();
  const first = words[0] || 'there';
  const values = { requester_name: first, customer_name: ticket.customer_name || 'your organisation', ticket_ref: ticket.ref, ticket_subject: ticket.subject, csid: ticket.csid_code || '', agent_name: agent.name };
  return String(body).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? values[k] : m));
}

module.exports = { PLACEHOLDERS, read, usable, canEdit, save, fill };
