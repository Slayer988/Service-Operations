'use strict';
// Quotes: priced quotations with line items, for a customer or a prospect, usually linked to an opportunity in the pipeline.
// A draft can be changed freely. Sending fixes it: later changes are made as a new revision (same reference, R2, R3 ...), and the
// revision it replaces is marked superseded. Accepting a quote linked to an opportunity can set the opportunity's value to the quote.
// An approval step before sending is planned; it will sit between 'draft' and 'sent'.
const { UserError } = require('./tickets');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const pdf = require('../lib/pdf');
const u = require('../lib/util');
const config = require('../config');

const STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'expired', 'cancelled', 'superseded'];
const STATUS_LABELS = { draft: 'Draft', sent: 'Sent', accepted: 'Accepted', rejected: 'Rejected', expired: 'Expired', cancelled: 'Cancelled', superseded: 'Superseded' };
const OPEN = ['draft', 'sent'];
// what a person may do next from each status (revise is separate: it makes a new revision)
const MOVES = {
  draft: ['sent', 'cancelled'],
  sent: ['accepted', 'rejected', 'expired', 'cancelled'],
  expired: ['accepted'],                  // a customer may still say yes after the date; the person decides
  accepted: [], rejected: [], cancelled: [], superseded: [],
};
const REVISABLE = ['sent', 'rejected', 'expired'];
const MAX_LINES = 200;

const label = (q) => `${q.ref}${q.revision > 1 ? ` R${q.revision}` : ''}`;

// ---------------------------------------------------------------- arithmetic (in cents, so totals never drift)
const cents = (n) => Math.round(Number(n) * 100);
/** One line: quantity x unit price, less its discount, rounded to the cent. */
function lineTotal(quantity, unitPrice, discountPct = 0) {
  return Math.round(cents(quantity) * cents(unitPrice) / 100 * (1 - Number(discountPct) / 100)) / 100;
}
/** Totals for a set of lines: { gross, discount, subtotal, tax, total }. Tax is on the subtotal (after discounts). */
function totals(lines, taxRate = 0) {
  let gross = 0; let net = 0;
  for (const l of lines) {
    gross += Math.round(cents(l.quantity) * cents(l.unit_price) / 100);
    net += cents(lineTotal(l.quantity, l.unit_price, l.discount_pct));
  }
  const tax = Math.round(net * Number(taxRate) / 100);
  return { gross: gross / 100, discount: (gross - net) / 100, subtotal: net / 100, tax: tax / 100, total: (net + tax) / 100 };
}

// ---------------------------------------------------------------- settings
async function listSettings(db) {
  const s = await settings.getAll(db, ['quote_company', 'quote_tax_rate', 'quote_tax_label', 'quote_validity_days', 'quote_terms', 'currencies', 'default_currency']);
  const company = { name: '', address: '', phone: '', email: '', website: '', tax_id: '', ...(s.quote_company && typeof s.quote_company === 'object' ? s.quote_company : {}) };
  const rate = Number(s.quote_tax_rate);
  const days = Number(s.quote_validity_days);
  return {
    company,
    taxRate: Number.isFinite(rate) && rate >= 0 && rate <= 100 ? rate : 0,
    taxLabel: typeof s.quote_tax_label === 'string' && s.quote_tax_label.trim() ? s.quote_tax_label.trim().slice(0, 20) : 'VAT',
    validityDays: Number.isInteger(days) && days >= 0 && days <= 365 ? days : 30,
    terms: typeof s.quote_terms === 'string' ? s.quote_terms : '',
    currencies: Array.isArray(s.currencies) && s.currencies.length ? s.currencies : ['UGX', 'USD'],
    defaultCurrency: s.default_currency || 'UGX',
  };
}

// ---------------------------------------------------------------- reading forms
const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);

/** The line rows of the form (repeated fields). Rows with no description are dropped, so emptying a description removes the line. */
function readLines(b) {
  const desc = arr(b.description); const qty = arr(b.quantity); const unit = arr(b.unit); const price = arr(b.unit_price); const disc = arr(b.discount_pct);
  const out = [];
  for (let i = 0; i < desc.length; i++) {
    const description = u.str(desc[i], 1000);
    if (!description) continue;
    const row = `Line ${out.length + 1} (${description.slice(0, 30)})`;
    const q = u.money(qty[i] === undefined || String(qty[i]).trim() === '' ? '1' : qty[i], 1e9);
    if (q === null || Number.isNaN(q) || q <= 0) throw new UserError(`${row}: the quantity must be a number above 0.`);
    const p = u.money(price[i] === undefined || String(price[i]).trim() === '' ? '0' : price[i], 1e12);
    if (p === null || Number.isNaN(p)) throw new UserError(`${row}: the unit price must be a number (0 or more, at most 2 decimals).`);
    const d = disc[i] === undefined || String(disc[i]).trim() === '' ? 0 : u.money(disc[i], 100);
    if (d === null || Number.isNaN(d)) throw new UserError(`${row}: the discount is a percentage from 0 to 100.`);
    out.push({ description, quantity: q, unit: u.str(unit[i], 40), unit_price: p, discount_pct: d, line_total: lineTotal(q, p, d) });
    if (out.length > MAX_LINES) throw new UserError(`A quote can have at most ${MAX_LINES} lines.`);
  }
  return out;
}

/** The header fields. opts: { currencies }. */
function readHeader(b, opts) {
  const title = u.str(b.title, 200);
  if (!title) throw new UserError('Enter a title for the quote (what it is for).');
  const customerId = u.id(b.customer_id); const prospect = u.str(b.prospect, 200);
  if (!customerId && !prospect) throw new UserError('Choose a customer, or enter the name of the organisation the quote is for.');
  const currency = u.oneOf(b.currency, opts.currencies);
  if (!currency) throw new UserError('Choose one of the currencies set up in Settings.');
  const issue = b.issue_date ? u.dateStr(b.issue_date) : null;
  if (b.issue_date && !issue) throw new UserError('The quote date is not valid.');
  const valid = b.valid_until ? u.dateStr(b.valid_until) : null;
  if (b.valid_until && !valid) throw new UserError('The "valid until" date is not valid.');
  if (issue && valid && valid < issue) throw new UserError('"Valid until" cannot be before the quote date.');
  const rate = u.money(b.tax_rate === undefined || String(b.tax_rate).trim() === '' ? '0' : b.tax_rate, 100);
  if (rate === null || Number.isNaN(rate)) throw new UserError('The tax rate is a percentage from 0 to 100.');
  const email = b.contact_email ? u.email(b.contact_email) : '';
  if (b.contact_email && String(b.contact_email).trim() && !email) throw new UserError('The contact e-mail address is not valid.');
  return {
    title, customer_id: customerId, prospect: customerId ? '' : prospect, contact_name: u.str(b.contact_name, 120), contact_email: email || '',
    currency, issue_date: issue, valid_until: valid, tax_rate: rate, tax_label: u.str(b.tax_label, 20) || 'VAT',
    intro: u.str(b.intro, 4000), terms: u.str(b.terms, 4000), internal_notes: u.str(b.internal_notes, 4000), opportunity_id: u.id(b.opportunity_id),
  };
}

// ---------------------------------------------------------------- reading records
const SELECT = `select qu.*, c.name as customer_name, ow.name as owner_name, o.ref as opportunity_ref, o.name as opportunity_name, o.stage as opportunity_stage,
                       coalesce(c.name, nullif(qu.prospect, '')) as org
                  from quotes qu left join customers c on c.id = qu.customer_id join users ow on ow.id = qu.owner_id left join opportunities o on o.id = qu.opportunity_id`;

async function get(db, id) {
  if (!id) return null;
  return (await db.query(`${SELECT} where qu.id = $1`, [id])).rows[0] || null;
}
async function lines(db, id) {
  return (await db.query('select * from quote_lines where quote_id = $1 order by position, id', [id])).rows;
}
async function events(db, id) {
  return (await db.query('select e.*, u.name as actor_name from quote_events e left join users u on u.id = e.actor_id where e.quote_id = $1 order by e.id desc limit 200', [id])).rows;
}
/** Every revision of the same quote, newest first. */
async function revisions(db, ref) {
  return (await db.query('select id, ref, revision, status, total, currency, issue_date from quotes where ref = $1 order by revision desc', [ref])).rows;
}
async function forOpportunity(db, oppId) {
  return (await db.query(`${SELECT} where qu.opportunity_id = $1 order by qu.ref desc, qu.revision desc`, [oppId])).rows;
}

async function addEvent(db, quoteId, actor, text) {
  await db.query('insert into quote_events (quote_id, actor_id, text) values ($1,$2,$3)', [quoteId, actor ? actor.id : null, String(text).slice(0, 2000)]);
}
async function oppEvent(db, oppId, actor, text) {
  if (oppId) await db.query(`insert into opportunity_events (opportunity_id, actor_id, kind, text) values ($1,$2,'quote',$3)`, [oppId, actor ? actor.id : null, String(text).slice(0, 2000)]);
}

// ---------------------------------------------------------------- changes
/** The values a new quote starts with: from the opportunity when there is one, and the defaults in Settings. */
async function defaults(db, oppId, today) {
  const s = await listSettings(db);
  const out = { title: '', customer_id: '', prospect: '', contact_name: '', contact_email: '', currency: s.defaultCurrency, issue_date: today,
    valid_until: s.validityDays ? addDays(today, s.validityDays) : '', tax_rate: s.taxRate, tax_label: s.taxLabel, intro: '', terms: s.terms, internal_notes: '', opportunity_id: '' };
  if (oppId) {
    const o = (await db.query('select * from opportunities where id = $1', [oppId])).rows[0];
    if (o) {
      const contact = (await db.query('select name, email from opportunity_contacts where opportunity_id = $1 order by id limit 1', [o.id])).rows[0];
      Object.assign(out, { title: o.name, customer_id: o.customer_id || '', prospect: o.customer_id ? '' : o.prospect, currency: s.currencies.includes(o.currency) ? o.currency : out.currency,
        contact_name: (contact && contact.name) || o.contact_name || '', contact_email: (contact && contact.email) || o.contact_email || '', opportunity_id: o.id });
    }
  }
  return out;
}
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10);
}

async function checkLinks(db, h) {
  if (h.customer_id && !(await db.query('select 1 from customers where id = $1', [h.customer_id])).rows.length) throw new UserError('That customer does not exist.');
  if (h.opportunity_id) {
    const o = (await db.query('select id, customer_id, prospect from opportunities where id = $1', [h.opportunity_id])).rows[0];
    if (!o) throw new UserError('That opportunity does not exist.');
    if (o.customer_id && h.customer_id && Number(o.customer_id) !== Number(h.customer_id)) throw new UserError('The quote must be for the same customer as its opportunity.');
  }
}

async function create(db, input, actor, ip) {
  const h = { ...input, customer_id: input.customer_id || null, opportunity_id: input.opportunity_id || null };
  await checkLinks(db, h);
  const ref = `QUO-${String((await db.query("select nextval('quote_seq') as n")).rows[0].n).padStart(6, '0')}`;
  const r = (await db.query(
    `insert into quotes (ref, revision, opportunity_id, customer_id, prospect, contact_name, contact_email, title, currency, issue_date, valid_until, tax_rate, tax_label, intro, terms, internal_notes, owner_id, created_by)
     values ($1,1,$2,$3,$4,$5,$6,$7,$8,coalesce($9::date, current_date),$10,$11,$12,$13,$14,$15,$16,$16) returning id`,
    [ref, h.opportunity_id, h.customer_id, h.prospect, h.contact_name, h.contact_email, h.title, h.currency, h.issue_date, h.valid_until, h.tax_rate, h.tax_label, h.intro, h.terms, h.internal_notes, actor.id])).rows[0];
  await addEvent(db, r.id, actor, `${actor.name} created the quote.`);
  await oppEvent(db, h.opportunity_id, actor, `${actor.name} started quote ${ref}: ${h.title}.`);
  await audit(db, actor, 'quote_created', 'quote', ref, h.title, h.customer_id, ip);
  return get(db, r.id);
}

function mustBeDraft(quote) {
  if (quote.status !== 'draft') throw new UserError(`Quote ${label(quote)} was ${STATUS_LABELS[quote.status].toLowerCase()} and can no longer be changed. Make a new revision to change it.`);
}

async function updateHeader(db, quote, h, actor) {
  mustBeDraft(quote);
  await require('./approvals').withdraw(db, 'quote', quote.id, actor, 'its details were changed');
  await checkLinks(db, h);
  await db.query(
    `update quotes set opportunity_id = $2, customer_id = $3, prospect = $4, contact_name = $5, contact_email = $6, title = $7, currency = $8, issue_date = coalesce($9::date, issue_date), valid_until = $10,
            tax_rate = $11, tax_label = $12, intro = $13, terms = $14, internal_notes = $15, updated_at = now() where id = $1`,
    [quote.id, h.opportunity_id, h.customer_id, h.prospect, h.contact_name, h.contact_email, h.title, h.currency, h.issue_date, h.valid_until, h.tax_rate, h.tax_label, h.intro, h.terms, h.internal_notes]);
  await recalc(db, quote.id);
  await addEvent(db, quote.id, actor, `${actor.name} changed the quote details.`);
  return get(db, quote.id);
}

async function recalc(db, id) {
  const q = (await db.query('select tax_rate from quotes where id = $1', [id])).rows[0];
  const t = totals(await lines(db, id), q.tax_rate);
  await db.query('update quotes set subtotal = $2, discount_total = $3, tax_total = $4, total = $5, updated_at = now() where id = $1', [id, t.subtotal, t.discount, t.tax, t.total]);
  return t;
}

async function saveLines(db, quote, rows, actor) {
  mustBeDraft(quote);
  await require('./approvals').withdraw(db, 'quote', quote.id, actor, 'its lines were changed');
  await db.query('delete from quote_lines where quote_id = $1', [quote.id]);
  let pos = 0;
  for (const l of rows) {
    pos += 1;
    await db.query('insert into quote_lines (quote_id, position, description, quantity, unit, unit_price, discount_pct, line_total) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [quote.id, pos, l.description, l.quantity, l.unit, l.unit_price, l.discount_pct, l.line_total]);
  }
  const t = await recalc(db, quote.id);
  await addEvent(db, quote.id, actor, `${actor.name} saved ${rows.length} line(s). Total ${quote.currency} ${fmtMoney(t.total)}.`);
  return get(db, quote.id);
}

/**
 * Move a quote on. opts: { note, updateOpportunity } — on acceptance, updateOpportunity sets the opportunity's value and currency to the
 * quote's amount before tax (what the pipeline counts), and says so in the opportunity's history.
 */
async function setStatus(db, quote, to, actor, opts = {}, ip = '') {
  if (!STATUSES.includes(to)) throw new UserError('Unknown status.');
  if (!(MOVES[quote.status] || []).includes(to)) throw new UserError(`A ${STATUS_LABELS[quote.status].toLowerCase()} quote cannot be marked ${STATUS_LABELS[to].toLowerCase()}.`);
  const note = u.str(opts.note, 1000);
  if (to === 'sent') {
    const n = (await db.query('select count(*)::int as n from quote_lines where quote_id = $1', [quote.id])).rows[0].n;
    if (!n) throw new UserError('Add at least one line before sending the quote.');
    if (quote.valid_until && quote.valid_until < u.localDay(config.timezone)) throw new UserError('The "valid until" date has passed. Change it before sending.');
    await require('./approvals').assertApproved(db, 'quote', quote.id);
  }
  if (to === 'rejected' && !note) throw new UserError('Say why the customer declined (it helps with the next quote).');
  await db.query(
    `update quotes set status = $2, updated_at = now(), sent_at = case when $2 = 'sent' then now() else sent_at end,
            decided_at = case when $2 in ('accepted','rejected') then now() else decided_at end, decision_note = case when $3 <> '' then $3 else decision_note end where id = $1`,
    [quote.id, to, note]);
  const what = `${actor.name} marked the quote ${STATUS_LABELS[to].toLowerCase()}${note ? `: ${note}` : '.'}`;
  await addEvent(db, quote.id, actor, what);
  await oppEvent(db, quote.opportunity_id, actor, `Quote ${label(quote)} (${quote.currency} ${fmtMoney(quote.total)}) ${STATUS_LABELS[to].toLowerCase()}${note ? `: ${note}` : '.'}`);
  if (to === 'accepted' && quote.opportunity_id && opts.updateOpportunity) {
    await db.query('update opportunities set value = $2, currency = $3, updated_at = now() where id = $1', [quote.opportunity_id, quote.subtotal, quote.currency]);
    await oppEvent(db, quote.opportunity_id, actor, `${actor.name} set the opportunity value to ${quote.currency} ${fmtMoney(quote.subtotal)} (accepted quote ${label(quote)}, before ${quote.tax_label}).`);
  }
  await audit(db, actor, `quote_${to}`, 'quote', label(quote), note || quote.title, quote.customer_id, ip);
  return get(db, quote.id);
}

/** A new draft revision with the same reference and lines. A sent quote it replaces becomes superseded. */
async function revise(db, quote, actor, ip = '') {
  if (!REVISABLE.includes(quote.status)) throw new UserError(quote.status === 'draft' ? 'This quote is still a draft: change it directly.' : `A ${STATUS_LABELS[quote.status].toLowerCase()} quote cannot be revised. Start a new quote.`);
  const newer = (await db.query('select revision from quotes where ref = $1 and revision > $2 limit 1', [quote.ref, quote.revision])).rows[0];
  if (newer) throw new UserError(`There is already a newer revision (R${newer.revision}). Open that one.`);
  const s = await listSettings(db);
  const today = u.localDay(config.timezone);
  const r = (await db.query(
    `insert into quotes (ref, revision, opportunity_id, customer_id, prospect, contact_name, contact_email, title, currency, issue_date, valid_until, tax_rate, tax_label, intro, terms, internal_notes,
                         subtotal, discount_total, tax_total, total, owner_id, created_by)
     select ref, revision + 1, opportunity_id, customer_id, prospect, contact_name, contact_email, title, currency, $2::date, $3::date, tax_rate, tax_label, intro, terms, internal_notes,
            subtotal, discount_total, tax_total, total, owner_id, $4 from quotes where id = $1 returning id`,
    [quote.id, today, s.validityDays ? addDays(today, s.validityDays) : quote.valid_until, actor.id])).rows[0];
  await db.query(`insert into quote_lines (quote_id, position, description, quantity, unit, unit_price, discount_pct, line_total)
                  select $2, position, description, quantity, unit, unit_price, discount_pct, line_total from quote_lines where quote_id = $1`, [quote.id, r.id]);
  if (quote.status === 'sent') {
    await db.query(`update quotes set status = 'superseded', updated_at = now() where id = $1`, [quote.id]);
    await addEvent(db, quote.id, actor, `${actor.name} replaced this quote with revision R${quote.revision + 1}.`);
  }
  await addEvent(db, r.id, actor, `${actor.name} made revision R${quote.revision + 1} from R${quote.revision}.`);
  await oppEvent(db, quote.opportunity_id, actor, `${actor.name} started revision R${quote.revision + 1} of quote ${quote.ref}.`);
  await audit(db, actor, 'quote_revised', 'quote', `${quote.ref} R${quote.revision + 1}`, quote.title, quote.customer_id, ip);
  return get(db, r.id);
}

/** Sent quotes past their date become expired (the worker runs this every night). Returns how many. */
async function expireDue(db, today = u.localDay(config.timezone)) {
  const r = await db.query(`update quotes set status = 'expired', updated_at = now() where status = 'sent' and valid_until < $1::date returning id, ref, revision, opportunity_id`, [today]);
  for (const x of r.rows) {
    await addEvent(db, x.id, null, 'The quote expired: its "valid until" date passed without a decision.');
    await oppEvent(db, x.opportunity_id, null, `Quote ${label(x)} expired without a decision.`);
  }
  return r.rows.length;
}

// ---------------------------------------------------------------- PDF
const fmtMoney = (n) => Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtQty = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
const fmtDate = (d) => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  return `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};

/** The quote as a PDF the customer can be sent. Internal notes are never printed. */
function toPdf(quote, rows, s, palette, brand) {
  const c = s.company || {};
  const from = [c.address, c.phone && `Tel: ${c.phone}`, c.email, c.website, c.tax_id && `Tax ID / TIN: ${c.tax_id}`].filter(Boolean).join('\n').split('\n').filter(Boolean);
  const to = [quote.contact_name && `Attn: ${quote.contact_name}`, quote.contact_email].filter(Boolean);
  const anyDiscount = rows.some((l) => Number(l.discount_pct) > 0);
  const columns = [
    { header: '#', key: 'n', weight: 0.35 },
    { header: 'Description', key: 'description', weight: 4.2 },
    { header: 'Qty', key: 'qty', weight: 0.7, align: 'right' },
    { header: 'Unit', key: 'unit', weight: 0.9 },
    { header: `Unit price (${quote.currency})`, key: 'price', weight: 1.4, align: 'right' },
    ...(anyDiscount ? [{ header: 'Disc. %', key: 'disc', weight: 0.7, align: 'right' }] : []),
    { header: `Amount (${quote.currency})`, key: 'amount', weight: 1.5, align: 'right' },
  ];
  const tableRows = rows.map((l, i) => ({ n: String(i + 1), description: l.description, qty: fmtQty(l.quantity), unit: l.unit, price: fmtMoney(l.unit_price), disc: Number(l.discount_pct) ? fmtQty(l.discount_pct) : '', amount: fmtMoney(l.line_total) }));
  const totalsRows = [];
  if (Number(quote.discount_total) > 0) totalsRows.push(['Before discounts', fmtMoney(Number(quote.subtotal) + Number(quote.discount_total))], ['Discounts', `- ${fmtMoney(quote.discount_total)}`]);
  totalsRows.push(['Subtotal', fmtMoney(quote.subtotal)]);
  totalsRows.push([`${quote.tax_label} ${fmtQty(quote.tax_rate)}%`, fmtMoney(quote.tax_total)]);
  totalsRows.push([`Total (${quote.currency})`, fmtMoney(quote.total), true]);
  const blocks = [
    { type: 'pair', left: { title: c.name || 'From', lines: from }, right: { title: 'Quotation for', lines: [quote.org || '', ...to] } },
    { type: 'kv', rows: [['Quote number', label(quote)], ['Date', fmtDate(quote.issue_date)], ['Valid until', quote.valid_until ? fmtDate(quote.valid_until) : 'Not stated'], ['Subject', quote.title]] },
  ];
  if (quote.intro) blocks.push({ type: 'p', text: quote.intro });
  blocks.push({ type: 'table', columns, rows: tableRows, empty: 'No lines.' });
  blocks.push({ type: 'totals', rows: totalsRows });
  if (quote.terms) blocks.push({ type: 'heading', text: 'Terms' }, { type: 'p', text: quote.terms });
  if (quote.status !== 'draft' && quote.status !== 'sent') blocks.push({ type: 'p', text: `Status: ${STATUS_LABELS[quote.status]}.` });
  return pdf.document({
    title: `Quotation ${label(quote)}`, subtitle: quote.status === 'draft' ? 'DRAFT - not for sending' : ((brand && brand.name) ? '' : (c.name || '')), landscape: false, blocks,
    appName: c.name || config.appName, footer: `${label(quote)}  |  ${fmtDate(quote.issue_date)}`, palette, brand,
  });
}

module.exports = {
  STATUSES, STATUS_LABELS, OPEN, MOVES, REVISABLE, MAX_LINES, label, lineTotal, totals, listSettings, readLines, readHeader, get, lines, events, revisions, forOpportunity,
  defaults, create, updateHeader, saveLines, setStatus, revise, expireDue, toPdf, fmtMoney, addDays,
};
