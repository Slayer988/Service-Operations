'use strict';
// Knowledge Base: articles written by staff and read by staff (internal) or customers (audience "customers").
//   * Writers (kb.write) create and edit; only publishers (kb.publish) publish, unpublish, archive and manage categories.
//   * Customer-facing articles are only changed by publishers once they are live, so nothing public is altered unreviewed.
//   * Every save keeps a version; people vote whether an article helped; articles can be linked to tickets.
//   * Customers only ever see published articles whose audience is "customers".
const perms = require('../lib/perms');
const audit = require('../lib/audit');
const u = require('../lib/util');
const { UserError } = require('./tickets');

const CODE_RE = /^KB-\d{4,6}$/;
const AUDIENCES = ['internal', 'customers'];
const STATUSES = ['draft', 'published', 'archived'];
const STATUS_LABELS = { draft: 'Draft', published: 'Published', archived: 'Archived' };
const AUDIENCE_LABELS = { internal: 'Staff only', customers: 'Staff and customers' };
const REVIEW_MONTHS = 12;

/** Validate the article form. Returns the clean values or throws a UserError in plain words. */
function readForm(b) {
  const title = String(b.title || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  if (!title) throw new UserError('Give the article a title.');
  const body = String(b.body || '').replace(/\r\n?/g, '\n').trim();
  if (!body) throw new UserError('Write the article text.');
  if (body.length > 60000) throw new UserError('The article is too long (limit 60,000 characters). Split it into two articles and link them.');
  const tags = [...new Set(String(b.tags || '').toLowerCase().split(/[\s,;]+/).map((t) => t.replace(/[^a-z0-9-]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 10).join(' ');
  return {
    title, body, tags,
    summary: String(b.summary || '').replace(/\s+/g, ' ').trim().slice(0, 300),
    category_id: u.id(b.category_id) || null,
    audience: AUDIENCES.includes(b.audience) ? b.audience : 'internal',
    review_by: u.dateStr(b.review_by) || null,
  };
}

const isWriter = (user) => perms.can(user, 'kb.write');
const isPublisher = (user) => perms.can(user, 'kb.publish');

/** Who may change this article. A live customer article is changed only by publishers. */
function canEdit(user, article) {
  if (!isWriter(user)) return false;
  if (article.status === 'published' && article.audience === 'customers' && !isPublisher(user)) return false;
  return true;
}

/** SQL limiting what the person may see; pushes its parameters onto params. */
function visibility(user, params, a = 'a') {
  if (user.kind === 'customer') return `${a}.status = 'published' and ${a}.audience = 'customers'`;
  if (isWriter(user)) return 'true';                                       // writers can open anything, archived articles included
  return `${a}.status = 'published'`;
}

const FIELDS = `a.id, a.code, a.title, a.summary, a.category_id, a.tags, a.audience, a.status, a.review_by, a.published_at, a.views, a.version, a.created_at, a.updated_at,
  c.name as category, au.name as author_name,
  (select count(*)::int from kb_votes v where v.article_id = a.id and v.helpful) as helpful,
  (select count(*)::int from kb_votes v where v.article_id = a.id and not v.helpful) as not_helpful`;

/**
 * The list or the search result. opts: { text, category, status, mine, due, archived }.
 * Text is matched against the whole article (words, in any order); a part of a title also matches.
 */
async function search(q, user, opts = {}) {
  const params = []; const where = [visibility(user, params)];
  const text = String(opts.text || '').trim().slice(0, 100);
  let rank = '0';
  if (text) {
    params.push(text);
    const n = params.length;
    rank = `ts_rank(a.search, websearch_to_tsquery('simple', $${n}))`;
    params.push(`%${text.replace(/[\\%_]/g, '\\$&')}%`);
    where.push(`(a.search @@ websearch_to_tsquery('simple', $${n}) or a.title ilike $${params.length} or a.tags ilike $${params.length})`);
  }
  if (u.id(opts.category)) { params.push(u.id(opts.category)); where.push(`a.category_id = $${params.length}`); }
  if (user.kind !== 'customer') {
    if (isWriter(user)) {
      if (opts.archived) where.push(`a.status = 'archived'`);
      else { where.push(`a.status <> 'archived'`); if (STATUSES.includes(opts.status)) { params.push(opts.status); where.push(`a.status = $${params.length}`); } }
    }
    if (opts.mine) { params.push(user.id); where.push(`a.author_id = $${params.length}`); }
    if (opts.due) where.push(`a.status = 'published' and a.review_by is not null and a.review_by < current_date`);
  }
  const rows = (await q(
    `select ${FIELDS}, ${rank} as rank, left(a.body, 600) as body_start
       from kb_articles a left join kb_categories c on c.id = a.category_id left join users au on au.id = a.author_id
      where ${where.join(' and ')} order by ${text ? 'rank desc, ' : ''}a.updated_at desc limit 100`, params)).rows;
  return rows;
}

async function get(q, user, code) {
  if (!CODE_RE.test(String(code || '').toUpperCase())) return null;
  const params = [String(code).toUpperCase()]; const vis = visibility(user, params);
  const a = (await q(
    `select a.*, c.name as category, au.name as author_name, ub.name as updated_by_name,
            (select count(*)::int from kb_votes v where v.article_id = a.id and v.helpful) as helpful,
            (select count(*)::int from kb_votes v where v.article_id = a.id and not v.helpful) as not_helpful
       from kb_articles a left join kb_categories c on c.id = a.category_id left join users au on au.id = a.author_id left join users ub on ub.id = a.updated_by
      where a.code = $1 and ${vis}`, params)).rows[0];
  if (!a) return null;
  a.mine = (await q('select helpful from kb_votes where article_id = $1 and user_id = $2', [a.id, user.id])).rows[0] || null;
  return a;
}

async function categories(q) {
  return (await q(`select k.id, k.name, (select count(*)::int from kb_articles a where a.category_id = k.id and a.status = 'published') as published from kb_categories k order by k.sort_order, k.name`)).rows;
}

async function create(db, actor, ip, b, { fromTicketId = null } = {}) {
  if (!isWriter(actor)) throw new UserError('Your role cannot write articles.', 403);
  const f = readForm(b);
  const r = await db.query(
    `insert into kb_articles (title, summary, body, category_id, tags, audience, review_by, author_id, updated_by) values ($1,$2,$3,$4,$5,$6,$7,$8,$8) returning id, code`,
    [f.title, f.summary, f.body, f.category_id, f.tags, f.audience, f.review_by, actor.id]);
  const a = r.rows[0];
  await db.query(`insert into kb_article_versions (article_id, version, title, summary, body, edited_by, note) values ($1, 1, $2, $3, $4, $5, 'First version')`, [a.id, f.title, f.summary, f.body, actor.id]);
  if (fromTicketId) await db.query(`insert into kb_ticket_links (article_id, ticket_id, linked_by) values ($1,$2,$3) on conflict do nothing`, [a.id, fromTicketId, actor.id]);
  await audit(db, actor, 'kb_created', 'kb', a.code, f.title, null, ip);
  return a;
}

async function update(db, actor, ip, article, b, note = '') {
  if (!canEdit(actor, article)) throw new UserError(article.status === 'published' && article.audience === 'customers' ? 'This article is live for customers, so only a publisher can change it. Ask a service delivery manager, or unpublish it first.' : 'Your role cannot edit articles.', 403);
  const f = readForm(b);
  if (article.status === 'published' && f.audience !== article.audience && !isPublisher(actor)) f.audience = article.audience;   // who may read it is decided by a publisher
  const version = article.version + 1;
  await db.query(
    `update kb_articles set title = $2, summary = $3, body = $4, category_id = $5, tags = $6, audience = $7, review_by = $8, version = $9, updated_by = $10, updated_at = now() where id = $1`,
    [article.id, f.title, f.summary, f.body, f.category_id, f.tags, f.audience, f.review_by, version, actor.id]);
  await db.query(`insert into kb_article_versions (article_id, version, title, summary, body, edited_by, note) values ($1,$2,$3,$4,$5,$6,$7)`,
    [article.id, version, f.title, f.summary, f.body, actor.id, String(note || '').slice(0, 200)]);
  await audit(db, actor, 'kb_updated', 'kb', article.code, `v${version}${f.audience !== article.audience ? `, audience ${f.audience}` : ''}`, null, ip);
  return version;
}

/** publish | draft (take back to draft) | archive. Publishers only. */
async function setStatus(db, actor, ip, article, action) {
  if (!isPublisher(actor)) throw new UserError('Only a publisher (service delivery manager or administrator) can do that.', 403);
  const to = { publish: 'published', draft: 'draft', archive: 'archived' }[action];
  if (!to) throw new UserError('Unknown action.');
  if (to === article.status) return;
  await db.query(
    `update kb_articles set status = $2, updated_by = $3, updated_at = now(),
            published_at = case when $2 = 'published' and published_at is null then now() else published_at end,
            review_by = case when $2 = 'published' and review_by is null then (current_date + ($4 || ' months')::interval)::date else review_by end where id = $1`,
    [article.id, to, actor.id, String(REVIEW_MONTHS)]);
  await audit(db, actor, { published: 'kb_published', draft: 'kb_unpublished', archived: 'kb_archived' }[to], 'kb', article.code, article.title, null, ip);
}

async function versions(q, article) {
  return (await q(`select v.version, v.title, v.edited_at, v.note, e.name as editor from kb_article_versions v left join users e on e.id = v.edited_by where v.article_id = $1 order by v.version desc`, [article.id])).rows;
}
async function getVersion(q, article, n) {
  return (await q(`select v.*, e.name as editor from kb_article_versions v left join users e on e.id = v.edited_by where v.article_id = $1 and v.version = $2`, [article.id, Number(n) || 0])).rows[0] || null;
}

/** One vote per person; voting again changes it. Only on an article the person can read. */
async function vote(db, user, article, helpful) {
  if (article.status !== 'published') throw new UserError('Only published articles can be rated.');
  await db.query(
    `insert into kb_votes (article_id, user_id, helpful) values ($1,$2,$3)
     on conflict (article_id, user_id) do update set helpful = excluded.helpful, voted_at = now()`, [article.id, user.id, !!helpful]);
}

async function countView(db, article) { await db.query('update kb_articles set views = views + 1 where id = $1', [article.id]); }

// ---- tickets
async function linkTicket(db, actor, ip, article, ticket) {
  const r = await db.query(`insert into kb_ticket_links (article_id, ticket_id, linked_by) values ($1,$2,$3) on conflict do nothing returning ticket_id`, [article.id, ticket.id, actor.id]);
  if (r.rows[0]) await audit(db, actor, 'kb_linked', 'kb', article.code, ticket.ref, ticket.customer_id, ip);
  return !!r.rows[0];
}
async function unlinkTicket(db, actor, ip, article, ticket) {
  await db.query('delete from kb_ticket_links where article_id = $1 and ticket_id = $2', [article.id, ticket.id]);
  await audit(db, actor, 'kb_unlinked', 'kb', article.code, ticket.ref, ticket.customer_id, ip);
}
/** Articles linked to a ticket, as the person may see them (customers: published customer articles only). */
async function forTicket(q, user, ticketId) {
  const params = [ticketId]; const vis = visibility(user, params);
  return (await q(`select a.code, a.title, a.status, a.audience from kb_ticket_links l join kb_articles a on a.id = l.article_id where l.ticket_id = $1 and a.status <> 'archived' and ${vis} order by l.linked_at`, params)).rows;
}
async function ticketsOf(q, article, user) {
  const params = [article.id]; const vis = perms.ticketVisibility(user, params, 't');
  return (await q(`select t.ref, t.subject, t.status from kb_ticket_links l join tickets t on t.id = l.ticket_id where l.article_id = $1 and (${vis}) order by l.linked_at desc limit 50`, params)).rows;
}

// ---- categories (publishers)
async function addCategory(db, actor, ip, name) {
  if (!isPublisher(actor)) throw new UserError('Only a publisher can change categories.', 403);
  const n = String(name || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!n) throw new UserError('Enter a category name.');
  try { await db.query('insert into kb_categories (name) values ($1)', [n]); } catch (e) { if (e.code === '23505') throw new UserError('That category already exists.'); throw e; }
  await audit(db, actor, 'kb_category_added', 'kb', '', n, null, ip);
}
async function removeCategory(db, actor, ip, id) {
  if (!isPublisher(actor)) throw new UserError('Only a publisher can change categories.', 403);
  const r = await db.query('delete from kb_categories where id = $1 returning name', [id]);          // articles in it simply have no category afterwards
  if (r.rows[0]) await audit(db, actor, 'kb_category_removed', 'kb', '', r.rows[0].name, null, ip);
}

/** A starting text for an article written from a solved ticket (the author removes customer details before publishing). */
function draftFromTicket(ticket) {
  const body = [`## Problem`, '', String(ticket.description || '').trim().slice(0, 1500) || '(describe what the person saw)', '', `## Solution`, '',
    String(ticket.resolution_note || '').trim().slice(0, 3000) || '1. (the steps that fixed it)'].join('\n');
  return { title: ticket.subject, summary: '', body, tags: '', audience: 'internal', category_id: '', review_by: '' };
}

module.exports = { CODE_RE, AUDIENCES, STATUSES, STATUS_LABELS, AUDIENCE_LABELS, REVIEW_MONTHS, readForm, canEdit, visibility, search, get, categories, create, update, setStatus, versions, getVersion,
  vote, countView, linkTicket, unlinkTicket, forTicket, ticketsOf, addCategory, removeCategory, draftFromTicket };
