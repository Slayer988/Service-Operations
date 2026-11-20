'use strict';
// Problem management: the cause behind one or more incidents. A problem is investigated, recorded as a known error with its root cause
// and workaround (which can become a Knowledge Base article), and resolved by a permanent fix (often a change).
const audit = require('../lib/audit');
const u = require('../lib/util');
const { UserError } = require('./tickets');

const STATUSES = ['open', 'investigating', 'known_error', 'resolved', 'closed'];
const STATUS_LABELS = { open: 'Open', investigating: 'Investigating', known_error: 'Known error', resolved: 'Resolved', closed: 'Closed' };
const MOVES = { open: ['investigating', 'known_error', 'resolved', 'closed'], investigating: ['known_error', 'resolved', 'closed'], known_error: ['investigating', 'resolved'], resolved: ['closed', 'investigating'], closed: ['investigating'] };
const PRIORITY_LABELS = { 1: 'P1 critical', 2: 'P2 high', 3: 'P3 medium', 4: 'P4 low' };

function read(b) {
  const v = { title: u.str(b.title, 200), description: u.str(b.description, 8000), priority: u.intIn(b.priority, 1, 4) || 3,
    customer_id: u.id(b.customer_id) || null, owner_id: u.id(b.owner_id) || null,
    root_cause: u.str(b.root_cause, 8000), workaround: u.str(b.workaround, 8000), permanent_fix: u.str(b.permanent_fix, 8000) };
  if (!v.title) throw new UserError('Give the problem a short title, for example "Branch VPN drops several times a day".');
  return v;
}

async function event(db, id, actor, text) { await db.query('insert into problem_events (problem_id, actor_id, text) values ($1,$2,$3)', [id, actor ? actor.id : null, text]); }

async function create(db, b, actor, ip = '') {
  const v = read(b);
  const p = (await db.query(`insert into problems (title, description, priority, customer_id, owner_id, root_cause, workaround, permanent_fix, created_by)
                              values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`, [v.title, v.description, v.priority, v.customer_id, v.owner_id || actor.id, v.root_cause, v.workaround, v.permanent_fix, actor.id])).rows[0];
  await event(db, p.id, actor, `${actor.name} opened the problem.`);
  await audit(db, actor, 'problem_created', 'problem', p.ref, p.title, p.customer_id, ip);
  const ticket = u.str(b.ticket, 20);
  if (ticket) await linkTicket(db, p, ticket, actor);
  return p;
}

async function update(db, p, b, actor, ip = '') {
  const v = read(b);
  const changed = Object.keys(v).filter((k) => String(p[k] === null ? '' : p[k]) !== String(v[k] === null ? '' : v[k]));
  if (!changed.length) return p;
  const out = (await db.query(`update problems set title=$2, description=$3, priority=$4, customer_id=$5, owner_id=$6, root_cause=$7, workaround=$8, permanent_fix=$9, updated_at=now() where id=$1 returning *`,
    [p.id, v.title, v.description, v.priority, v.customer_id, v.owner_id, v.root_cause, v.workaround, v.permanent_fix])).rows[0];
  const names = { title: 'title', description: 'description', priority: 'priority', customer_id: 'customer', owner_id: 'owner', root_cause: 'root cause', workaround: 'workaround', permanent_fix: 'permanent fix' };
  await event(db, p.id, actor, `${actor.name} updated the ${changed.map((k) => names[k]).join(', ')}.`);
  await audit(db, actor, 'problem_updated', 'problem', p.ref, changed.join(', '), out.customer_id, ip);
  return out;
}

async function setStatus(db, p, to, actor, note = '', ip = '') {
  if (!(MOVES[p.status] || []).includes(to)) throw new UserError(`A problem that is ${STATUS_LABELS[p.status].toLowerCase()} cannot move to ${STATUS_LABELS[to] ? STATUS_LABELS[to].toLowerCase() : to}.`);
  if (to === 'known_error' && (!p.root_cause.trim() || !p.workaround.trim())) throw new UserError('A known error needs its root cause and a workaround. Write them in the problem details first.');
  if (to === 'resolved' && !p.permanent_fix.trim()) throw new UserError('Say what the permanent fix was (for example the change that removed the cause) before resolving.');
  const n = u.str(note, 1000);
  const out = (await db.query(`update problems set status = $2, updated_at = now(), resolved_at = case when $2 = 'resolved' then now() when $2 in ('investigating','known_error') then null else resolved_at end,
                                 closed_at = case when $2 = 'closed' then now() when $2 <> 'closed' then null else closed_at end where id = $1 returning *`, [p.id, to])).rows[0];
  await event(db, p.id, actor, `${actor.name} moved it to ${STATUS_LABELS[to].toLowerCase()}${n ? `: ${n}` : '.'}`);
  await audit(db, actor, 'problem_status', 'problem', p.ref, `${p.status} -> ${to}`, p.customer_id, ip);
  return out;
}

async function get(db, id) {
  return (await db.query(`select p.*, c.name as customer_name, o.name as owner_name, k.code as kb_code, k.title as kb_title
                            from problems p left join customers c on c.id = p.customer_id left join users o on o.id = p.owner_id left join kb_articles k on k.id = p.kb_article_id
                           where p.id = $1`, [id])).rows[0] || null;
}

async function linkTicket(db, p, ref, actor) {
  const t = (await db.query('select id, ref, subject from tickets where upper(ref) = upper($1)', [u.str(ref, 20)])).rows[0];
  if (!t) throw new UserError(`There is no ticket ${ref}.`);
  const r = await db.query('insert into problem_tickets (problem_id, ticket_id, linked_by) values ($1,$2,$3) on conflict do nothing', [p.id, t.id, actor.id]);
  if (r.rowCount) {
    await event(db, p.id, actor, `${actor.name} linked ${t.ref} (${t.subject}).`);
    await db.query(`insert into ticket_events (ticket_id, actor_id, kind, text, internal) values ($1,$2,'problem_linked',$3,true)`, [t.id, actor.id, `${actor.name} linked this ticket to problem ${p.ref}: ${p.title}.`]);
  }
  return t;
}
async function unlinkTicket(db, p, ticketId, actor) {
  const t = (await db.query('select ref from tickets where id = $1', [ticketId])).rows[0];
  const r = await db.query('delete from problem_tickets where problem_id = $1 and ticket_id = $2', [p.id, ticketId]);
  if (r.rowCount && t) await event(db, p.id, actor, `${actor.name} unlinked ${t.ref}.`);
}
async function linkAsset(db, p, tag, actor) {
  const a = (await db.query('select id, tag, name from assets where upper(tag) = upper($1)', [u.str(tag, 20)])).rows[0];
  if (!a) throw new UserError(`There is no asset ${tag}.`);
  const r = await db.query('insert into problem_assets (problem_id, asset_id) values ($1,$2) on conflict do nothing', [p.id, a.id]);
  if (r.rowCount) await event(db, p.id, actor, `${actor.name} linked ${a.tag} (${a.name}).`);
  return a;
}

/** The known error as a draft internal Knowledge Base article, linked back to the problem. */
async function toArticle(db, p, actor, ip = '') {
  if (p.kb_article_id) throw new UserError('This problem already has its article.');
  if (!p.workaround.trim()) throw new UserError('Write the workaround first: it is what the article is for.');
  const kb = require('./kb');
  const body = [`## Symptoms\n\n${p.description || p.title}`, `## Cause\n\n${p.root_cause || 'Under investigation.'}`, `## Workaround\n\n${p.workaround}`,
    p.permanent_fix ? `## Permanent fix\n\n${p.permanent_fix}` : `## Permanent fix\n\nNot yet available. Follow problem ${p.ref} for progress.`].join('\n\n');
  const a = await kb.create(db, actor, ip, { title: `Known error: ${p.title}`.slice(0, 200), body, summary: `Workaround for ${p.ref}.`, tags: 'known-error', audience: 'internal' });
  await db.query('update problems set kb_article_id = $2, updated_at = now() where id = $1', [p.id, a.id]);
  await event(db, p.id, actor, `${actor.name} wrote the known error up as Knowledge Base article ${a.code} (a draft, for review).`);
  return a;
}

module.exports = { STATUSES, STATUS_LABELS, MOVES, PRIORITY_LABELS, read, create, update, setStatus, get, linkTicket, unlinkTicket, linkAsset, toArticle, event };
