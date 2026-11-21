'use strict';
// Invoices to customers (1.27.0). An invoice is raised for one customer from what is due to be billed: instalments in a contract's
// payment schedule, an accepted quote, and chargeable time logged on the customer's tickets. Lines can then be edited freely while it
// is a draft. Draft → Issued → Part paid → Paid; a draft or an issued invoice with no payments can be cancelled (with a reason once
// issued). Whatever an invoice billed (instalments, time) is marked with it, so nothing is billed twice; cancelling releases it.
const { UserError } = require('./tickets');
const Q = require('./quotes');                       // the same line arithmetic, line form and money format as quotes and LPOs
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const pdf = require('../lib/pdf');
const u = require('../lib/util');
const config = require('../config');

const STATUSES = ['draft', 'issued', 'part_paid', 'paid', 'cancelled'];
const STATUS_LABELS = { draft: 'Draft', issued: 'Issued', part_paid: 'Part paid', paid: 'Paid', cancelled: 'Cancelled' };
const METHODS = { bank: 'Bank transfer', mobile_money: 'Mobile money', cheque: 'Cheque', cash: 'Cash', card: 'Card', other: 'Other' };
const OPEN = ['issued', 'part_paid'];

async function listSettings(db) {
  const q = await Q.listSettings(db);
  const s = await settings.getAll(db, ['invoice_terms', 'invoice_due_days', 'invoice_bank_details', 'invoice_hourly_rate']);
  const days = Number(s.invoice_due_days); const rate = Number(s.invoice_hourly_rate);
  return { ...q, terms: typeof s.invoice_terms === 'string' ? s.invoice_terms : '', dueDays: Number.isInteger(days) && days >= 0 && days <= 365 ? days : 30,
    bank: typeof s.invoice_bank_details === 'string' ? s.invoice_bank_details : '', hourlyRate: Number.isFinite(rate) && rate >= 0 ? rate : 0 };
}

function addDays(ymd, n) { const d = new Date(`${ymd}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
const ymd = (d) => (!d ? null : d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10));

/** The header form. opts: { currencies }. */
function readHeader(b, opts) {
  const title = u.str(b.title, 200);
  // a new invoice may leave it empty: it is then named after what it bills
  if (!title && !opts.titleOptional) throw new UserError('Enter what the invoice is for.');
  const customerId = u.id(b.customer_id);
  if (!customerId) throw new UserError('Choose the customer.');
  const currency = u.oneOf(b.currency, opts.currencies);
  if (!currency) throw new UserError('Choose one of the currencies set up in Settings.');
  const date = (k, what) => { if (!b[k]) return null; const v = u.dateStr(b[k]); if (!v) throw new UserError(`The ${what} is not valid.`); return v; };
  const issue = date('issue_date', 'invoice date'); const due = date('due_date', 'due date');
  const from = date('period_from', 'start of the period'); const to = date('period_to', 'end of the period');
  if (issue && due && due < issue) throw new UserError('The due date cannot be before the invoice date.');
  if (from && to && to < from) throw new UserError('The period ends before it starts.');
  const rate = u.money(b.tax_rate === undefined || String(b.tax_rate).trim() === '' ? '0' : b.tax_rate, 100);
  if (rate === null || Number.isNaN(rate)) throw new UserError('The tax rate is a percentage from 0 to 100.');
  return {
    title, customer_id: customerId, currency, issue_date: issue, due_date: due, period_from: from, period_to: to, customer_ref: u.str(b.customer_ref, 120),
    payment_terms: u.str(b.payment_terms, 500), terms: u.str(b.terms, 4000), internal_notes: u.str(b.internal_notes, 4000), tax_rate: rate, tax_label: u.str(b.tax_label, 20) || 'VAT',
    contract_id: u.id(b.contract_id), project_id: u.id(b.project_id),
  };
}

const SELECT = `select i.*, c.name as customer_name, c.code as customer_code, c.billing_address, c.tin as customer_tin, c.billing_email, ow.name as owner_name, ib.name as issued_by_name,
                       ct.reference as contract_ref, ct.title as contract_title, p.ref as project_ref, p.name as project_name, qu.ref as quote_ref, qu.revision as quote_revision,
                       (i.total - i.paid_total) as balance
                  from invoices i join customers c on c.id = i.customer_id join users ow on ow.id = i.owner_id left join users ib on ib.id = i.issued_by
                  left join contracts ct on ct.id = i.contract_id left join projects p on p.id = i.project_id left join quotes qu on qu.id = i.quote_id`;

async function get(db, id) { return id ? (await db.query(`${SELECT} where i.id = $1`, [id])).rows[0] || null : null; }
async function lines(db, id) { return (await db.query('select * from invoice_lines where invoice_id = $1 order by position, id', [id])).rows; }
async function payments(db, id) {
  return (await db.query('select p.*, u.name as recorded_by_name from invoice_payments p left join users u on u.id = p.recorded_by where p.invoice_id = $1 order by p.paid_on, p.id', [id])).rows;
}
async function events(db, id) {
  return (await db.query('select e.*, u.name as actor_name from invoice_events e left join users u on u.id = e.actor_id where e.invoice_id = $1 order by e.id desc limit 200', [id])).rows;
}
async function addEvent(db, id, actor, text) {
  await db.query('insert into invoice_events (invoice_id, actor_id, text) values ($1,$2,$3)', [id, actor ? actor.id : null, String(text).slice(0, 2000)]);
}
/** What this invoice billed: contract instalments and time entries (grouped per ticket). */
async function billed(db, id) {
  return {
    instalments: (await db.query(`select cp.*, c.reference as contract_ref from contract_payments cp join contracts c on c.id = cp.contract_id where cp.invoice_id = $1 order by cp.due_date`, [id])).rows,
    time: (await db.query(`select t.id, t.ref, t.subject, sum(tt.minutes)::int as minutes, count(*)::int as entries from ticket_time tt join tickets t on t.id = tt.ticket_id
                            where tt.invoice_id = $1 group by t.id order by t.ref`, [id])).rows,
  };
}

/** What can be billed to a customer now: instalments not yet billed (due by `upto`, or all with all=true), accepted quotes not on a live
 *  invoice, and chargeable time not yet billed (logged by `upto`), per ticket. */
async function billable(db, customerId, upto) {
  const instalments = (await db.query(
    `select cp.id, cp.due_date, cp.description, cp.amount, c.id as contract_id, c.reference as contract_ref, c.title as contract_title, c.currency
       from contract_payments cp join contracts c on c.id = cp.contract_id
      where c.customer_id = $1 and cp.invoice_id is null and cp.status = 'scheduled' order by cp.due_date, cp.id`, [customerId])).rows
    .map((r) => ({ ...r, due: ymd(r.due_date) <= upto }));
  const quotes = (await db.query(
    `select qu.id, qu.ref, qu.revision, qu.title, qu.currency, qu.total, qu.decided_at from quotes qu
      where qu.customer_id = $1 and qu.status = 'accepted'
        and not exists (select 1 from invoices i where i.quote_id = qu.id and i.status <> 'cancelled') order by qu.id desc`, [customerId])).rows;
  const time = (await db.query(
    `select t.id, t.ref, t.subject, sum(tt.minutes)::int as minutes, count(*)::int as entries, min(tt.work_date) as first_day, max(tt.work_date) as last_day
       from ticket_time tt join tickets t on t.id = tt.ticket_id
      where t.customer_id = $1 and tt.billable and tt.invoice_id is null and tt.work_date <= $2::date and not coalesce(t.non_chargeable, false)
      group by t.id order by t.ref`, [customerId, upto])).rows;
  return { instalments, quotes, time };
}

/** Unbilled chargeable time per customer (for the invoices page). */
async function unbilledTime(db) {
  return (await db.query(`select c.id, c.name, sum(tt.minutes)::int as minutes, count(distinct t.id)::int as tickets, min(tt.work_date) as since
                            from ticket_time tt join tickets t on t.id = tt.ticket_id join customers c on c.id = t.customer_id
                           where tt.billable and tt.invoice_id is null and not coalesce(t.non_chargeable, false) group by c.id order by minutes desc`)).rows;
}

/** Starting values for a new invoice for a customer. */
async function defaults(db, customerId, today) {
  const s = await listSettings(db);
  const out = { title: '', customer_id: customerId || '', currency: s.defaultCurrency, issue_date: today, due_date: addDays(today, s.dueDays), period_from: '', period_to: '', customer_ref: '',
    payment_terms: s.dueDays ? `${s.dueDays} days from the invoice date` : 'On receipt', terms: s.terms, internal_notes: '', tax_rate: s.taxRate, tax_label: s.taxLabel, contract_id: '', project_id: '' };
  return out;
}

const HEAD = ['customer_id', 'title', 'currency', 'issue_date', 'due_date', 'period_from', 'period_to', 'customer_ref', 'payment_terms', 'terms', 'internal_notes', 'tax_rate', 'tax_label', 'contract_id', 'project_id'];

async function checkLinks(db, h) {
  const c = (await db.query('select id, name, status, hourly_rate from customers where id = $1', [h.customer_id])).rows[0];
  if (!c) throw new UserError('That customer does not exist.');
  if (h.contract_id) {
    const ct = (await db.query('select customer_id from contracts where id = $1', [h.contract_id])).rows[0];
    if (!ct) throw new UserError('That contract does not exist.');
    if (Number(ct.customer_id) !== Number(h.customer_id)) throw new UserError("The contract must be one of this customer's.");
  }
  if (h.project_id) {
    const p = (await db.query('select customer_id from projects where id = $1', [h.project_id])).rows[0];
    if (!p) throw new UserError('That project does not exist.');
    if (p.customer_id && Number(p.customer_id) !== Number(h.customer_id)) throw new UserError("The project must be this customer's (or an internal project).");
  }
  return c;
}

const hours = (minutes) => Math.round(minutes / 60 * 100) / 100;

/**
 * Raise a draft invoice. picks: { instalments: [ids], quote: id, tickets: [ids], upto: 'YYYY-MM-DD' } (all optional; with none the
 * invoice starts empty and its lines are typed in). Everything picked must be the customer's, unbilled, and in the invoice currency.
 */
async function create(db, input, picks, actor, ip, today) {
  const h = { ...input }; for (const k of ['contract_id', 'project_id', 'issue_date', 'due_date', 'period_from', 'period_to']) h[k] = h[k] || null;
  const c = await checkLinks(db, h);
  const s = await listSettings(db);
  if (!h.due_date && s.dueDays) h.due_date = addDays(h.issue_date || today, s.dueDays); // the standard terms (Settings) unless a date is given
  const upto = picks.upto || today;
  const avail = await billable(db, h.customer_id, upto);
  const out = []; const notes = [];
  const want = (ids) => [...new Set((ids || []).map(Number).filter(Boolean))];

  const instIds = want(picks.instalments);
  for (const id of instIds) {
    const r = avail.instalments.find((x) => Number(x.id) === id);
    if (!r) throw new UserError('An instalment you chose is not this customer\'s, or was billed already. Open the page again.');
    if (r.currency !== h.currency) throw new UserError(`${r.contract_ref} is in ${r.currency}; this invoice is in ${h.currency}. Bill it on an invoice in ${r.currency}.`);
    out.push({ description: `${r.contract_ref}${r.contract_title ? ` ${r.contract_title}` : ''}: ${r.description || 'instalment'} (due ${ymd(r.due_date)})`, quantity: 1, unit: 'instalment', unit_price: Number(r.amount), discount_pct: 0 });
    if (!h.contract_id) h.contract_id = r.contract_id;
  }
  let quote = null;
  if (picks.quote) {
    quote = avail.quotes.find((x) => Number(x.id) === Number(picks.quote));
    if (!quote) throw new UserError('That quote is not an accepted quote of this customer, or it is on an invoice already.');
    if (quote.currency !== h.currency) throw new UserError(`Quote ${quote.ref} is in ${quote.currency}; this invoice is in ${h.currency}.`);
    const ql = await Q.lines(db, quote.id);
    for (const l of ql) out.push({ description: l.description, quantity: Number(l.quantity), unit: l.unit, unit_price: Number(l.unit_price), discount_pct: Number(l.discount_pct) });
    const qh = (await db.query('select tax_rate, tax_label from quotes where id = $1', [quote.id])).rows[0];
    h.tax_rate = qh.tax_rate; h.tax_label = qh.tax_label;
  }
  const tIds = want(picks.tickets);
  let rate = c.hourly_rate !== null && c.hourly_rate !== undefined ? Number(c.hourly_rate) : s.hourlyRate;
  if (tIds.length && h.currency !== s.defaultCurrency) { notes.push(`Hourly rates are in ${s.defaultCurrency}: the time lines were priced at 0 for you to fill in.`); rate = 0; }
  let minutesBilled = 0;
  for (const id of tIds) {
    const r = avail.time.find((x) => Number(x.id) === id);
    if (!r) throw new UserError('A ticket you chose has no unbilled chargeable time for this customer. Open the page again.');
    out.push({ description: `Support time on ${r.ref}: ${r.subject} (${r.entries} ${r.entries === 1 ? 'entry' : 'entries'}, ${ymd(r.first_day)} to ${ymd(r.last_day)})`, quantity: hours(r.minutes), unit: 'hour', unit_price: rate, discount_pct: 0 });
    minutesBilled += r.minutes;
  }
  if (out.length > 200) throw new UserError('That is more than 200 lines. Bill it on more than one invoice.');
  if (!h.title) h.title = quote ? quote.title : instIds.length ? 'Contract instalment' : tIds.length ? 'Support services' : 'Invoice';

  const ref = `INV-${String((await db.query("select nextval('invoice_seq') as n")).rows[0].n).padStart(6, '0')}`;
  const r = (await db.query(
    `insert into invoices (ref, ${HEAD.join(', ')}, quote_id, owner_id) values ($1, ${HEAD.map((k, i) => (k === 'issue_date' ? `coalesce($${i + 2}::date, current_date)` : `$${i + 2}`)).join(', ')}, $${HEAD.length + 2}, $${HEAD.length + 3}) returning id`,
    [ref, ...HEAD.map((k) => h[k]), quote ? quote.id : null, actor.id])).rows[0];
  let pos = 0;
  for (const l of out) {
    pos += 1;
    await db.query('insert into invoice_lines (invoice_id, position, description, quantity, unit, unit_price, discount_pct, line_total) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [r.id, pos, l.description.slice(0, 1000), l.quantity, l.unit, l.unit_price, l.discount_pct, Q.lineTotal(l.quantity, l.unit_price, l.discount_pct)]);
  }
  if (instIds.length) await db.query('update contract_payments set invoice_id = $1 where id = any($2::bigint[]) and invoice_id is null', [r.id, instIds]);
  if (tIds.length) await db.query(`update ticket_time tt set invoice_id = $1 from tickets t where t.id = tt.ticket_id and tt.ticket_id = any($2::bigint[]) and t.customer_id = $3
                                     and tt.billable and tt.invoice_id is null and tt.work_date <= $4::date`, [r.id, tIds, h.customer_id, upto]);
  await recalc(db, r.id);
  const parts = [instIds.length && `${instIds.length} instalment(s)`, quote && `quote ${Q.label(quote)}`, tIds.length && `${hours(minutesBilled)} hours on ${tIds.length} ticket(s)`].filter(Boolean);
  await addEvent(db, r.id, actor, `${actor.name} raised the invoice for ${c.name}${parts.length ? ` from ${parts.join(', ')}` : ''}.${notes.length ? ` ${notes.join(' ')}` : ''}`);
  if (quote) await db.query('insert into quote_events (quote_id, actor_id, text) values ($1,$2,$3)', [quote.id, actor.id, `${actor.name} invoiced the quote on ${ref}.`]);
  await audit(db, actor, 'invoice_created', 'invoice', ref, `${c.name}: ${h.title}`, null, ip);
  const inv = await get(db, r.id);
  inv.notes = notes;
  return inv;
}

function mustBeDraft(inv) {
  if (inv.status !== 'draft') throw new UserError(`${inv.ref} was ${STATUS_LABELS[inv.status].toLowerCase()} and can no longer be changed. To correct an issued invoice, cancel it and raise a new one.`);
}

async function updateHeader(db, inv, input, actor) {
  mustBeDraft(inv);
  const h = { ...input, customer_id: inv.customer_id }; // the customer is fixed: what was billed belongs to them
  for (const k of ['contract_id', 'project_id', 'due_date', 'period_from', 'period_to']) h[k] = h[k] || null;
  await checkLinks(db, h);
  if (h.currency !== inv.currency && (await db.query('select 1 from contract_payments where invoice_id = $1 limit 1', [inv.id])).rows.length) throw new UserError('This invoice bills contract instalments in its currency; the currency cannot be changed.');
  await db.query(`update invoices set ${HEAD.map((k, i) => (k === 'issue_date' ? `issue_date = coalesce($${i + 2}::date, issue_date)` : `${k} = $${i + 2}`)).join(', ')}, updated_at = now() where id = $1`,
    [inv.id, ...HEAD.map((k) => h[k])]);
  await recalc(db, inv.id);
  await addEvent(db, inv.id, actor, `${actor.name} changed the invoice details.`);
  return get(db, inv.id);
}

async function recalc(db, id) {
  const p = (await db.query('select tax_rate from invoices where id = $1', [id])).rows[0];
  const t = Q.totals(await lines(db, id), p.tax_rate);
  await db.query('update invoices set subtotal = $2, discount_total = $3, tax_total = $4, total = $5, updated_at = now() where id = $1', [id, t.subtotal, t.discount, t.tax, t.total]);
  return t;
}

async function saveLines(db, inv, rows, actor) {
  mustBeDraft(inv);
  await db.query('delete from invoice_lines where invoice_id = $1', [inv.id]);
  let pos = 0;
  for (const l of rows) {
    pos += 1;
    await db.query('insert into invoice_lines (invoice_id, position, description, quantity, unit, unit_price, discount_pct, line_total) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [inv.id, pos, l.description, l.quantity, l.unit, l.unit_price, l.discount_pct, l.line_total]);
  }
  const t = await recalc(db, inv.id);
  await addEvent(db, inv.id, actor, `${actor.name} saved ${rows.length} line(s). Total ${inv.currency} ${Q.fmtMoney(t.total)}.`);
  return get(db, inv.id);
}

/** Release what a cancelled invoice billed, so it can be billed again. */
async function release(db, id) {
  await db.query(`update contract_payments set invoice_id = null, status = case when status = 'invoiced' then 'scheduled' else status end where invoice_id = $1`, [id]);
  await db.query('update ticket_time set invoice_id = null where invoice_id = $1', [id]);
}

async function issue(db, inv, actor, ip, today) {
  mustBeDraft(inv);
  const n = (await db.query('select count(*)::int as n from invoice_lines where invoice_id = $1', [inv.id])).rows[0].n;
  if (!n) throw new UserError('Add at least one line before issuing the invoice.');
  if (!(Number(inv.total) > 0)) throw new UserError('The invoice total is 0. Check the prices before issuing it.');
  // issued today; the due date keeps its distance from the invoice date
  const gap = inv.due_date ? Math.max(0, Math.round((new Date(ymd(inv.due_date)) - new Date(ymd(inv.issue_date))) / 864e5)) : null;
  await db.query(`update invoices set status = 'issued', issued_at = now(), issued_by = $2, issue_date = $3::date, due_date = case when $4::int is null then null else $3::date + $4::int end, updated_at = now() where id = $1`,
    [inv.id, actor.id, today, gap]);
  await db.query(`update contract_payments set status = 'invoiced' where invoice_id = $1 and status = 'scheduled'`, [inv.id]);
  await addEvent(db, inv.id, actor, `${actor.name} issued the invoice (${inv.currency} ${Q.fmtMoney(inv.total)}).`);
  if (inv.contract_id) await db.query("insert into contract_events (contract_id, actor_id, kind, text) values ($1,$2,'invoice',$3)", [inv.contract_id, actor.id, `Invoice ${inv.ref} issued: ${inv.currency} ${Q.fmtMoney(inv.total)}.`]);
  if (inv.project_id) await db.query(`insert into project_events (project_id, actor_id, kind, text) values ($1,$2,'invoice',$3)`, [inv.project_id, actor.id, `Invoice ${inv.ref} issued to ${inv.customer_name} (${inv.currency} ${Q.fmtMoney(inv.total)}).`]);
  await audit(db, actor, 'invoice_issued', 'invoice', inv.ref, `${inv.customer_name}: ${inv.currency} ${Q.fmtMoney(inv.total)}`, null, ip);
  return get(db, inv.id);
}

async function cancel(db, inv, note, actor, ip) {
  note = u.str(note, 1000);
  if (!['draft', 'issued'].includes(inv.status)) throw new UserError(inv.status === 'cancelled' ? 'The invoice is already cancelled.' : 'An invoice with payments cannot be cancelled. Remove the payments first if they were recorded by mistake.');
  if (inv.status === 'issued' && !note) throw new UserError('Say why an issued invoice is cancelled (the customer has a copy).');
  await db.query(`update invoices set status = 'cancelled', cancelled_at = now(), decision_note = $2, updated_at = now() where id = $1`, [inv.id, note]);
  await release(db, inv.id);
  await addEvent(db, inv.id, actor, `${actor.name} cancelled the invoice${note ? `: ${note}` : '.'} What it billed can be billed again.`);
  await audit(db, actor, 'invoice_cancelled', 'invoice', inv.ref, note || inv.title, null, ip);
  return get(db, inv.id);
}

/** After a payment is added or removed: the paid total, the status, and the instalments it billed. */
async function settle(db, id, today) {
  const t = (await db.query('select coalesce(sum(amount), 0) as paid, max(paid_on) as last from invoice_payments where invoice_id = $1', [id])).rows[0];
  const inv = (await db.query('select total from invoices where id = $1', [id])).rows[0];
  const paid = Number(t.paid);
  const st = paid <= 0 ? 'issued' : Math.round(paid * 100) >= Math.round(Number(inv.total) * 100) ? 'paid' : 'part_paid';
  await db.query(`update invoices set paid_total = $2, status = $3, paid_at = case when $3 = 'paid' then coalesce(paid_at, now()) else null end, updated_at = now() where id = $1`, [id, paid, st]);
  if (st === 'paid') await db.query(`update contract_payments set status = 'paid', paid_on = coalesce(paid_on, $2::date) where invoice_id = $1`, [id, ymd(t.last) || today]);
  else await db.query(`update contract_payments set status = 'invoiced', paid_on = null where invoice_id = $1 and status = 'paid'`, [id]);
  return st;
}

function readPayment(b, inv, today) {
  const amount = u.money(b.amount, 1e13);
  if (amount === null || Number.isNaN(amount) || amount <= 0) throw new UserError('Enter the amount received (a number above 0).');
  const balance = Math.round((Number(inv.total) - Number(inv.paid_total)) * 100) / 100;
  if (Math.round(amount * 100) > Math.round(balance * 100)) throw new UserError(`That is more than the balance of ${inv.currency} ${Q.fmtMoney(balance)}.`);
  const day = b.paid_on ? u.dateStr(b.paid_on) : today;
  if (!day) throw new UserError('The payment date is not valid.');
  if (day > today) throw new UserError('The payment date cannot be in the future.');
  if (day < ymd(inv.issue_date)) throw new UserError('The payment date is before the invoice date.');
  return { amount, paid_on: day, method: u.oneOf(b.method, Object.keys(METHODS), 'bank'), reference: u.str(b.reference, 120), note: u.str(b.note, 500) };
}

async function addPayment(db, inv, input, actor, ip, today) {
  if (!OPEN.includes(inv.status)) throw new UserError(inv.status === 'draft' ? 'Issue the invoice before recording a payment.' : `The invoice is ${STATUS_LABELS[inv.status].toLowerCase()}.`);
  await db.query('insert into invoice_payments (invoice_id, paid_on, amount, method, reference, note, recorded_by) values ($1,$2,$3,$4,$5,$6,$7)',
    [inv.id, input.paid_on, input.amount, input.method, input.reference, input.note, actor.id]);
  const st = await settle(db, inv.id, today);
  await addEvent(db, inv.id, actor, `${actor.name} recorded a payment of ${inv.currency} ${Q.fmtMoney(input.amount)} (${METHODS[input.method]}${input.reference ? `, ${input.reference}` : ''}) received ${input.paid_on}.${st === 'paid' ? ' The invoice is paid.' : ''}`);
  await audit(db, actor, 'invoice_payment', 'invoice', inv.ref, `${inv.currency} ${Q.fmtMoney(input.amount)} ${input.method} ${input.reference}`.trim(), null, ip);
  return get(db, inv.id);
}

async function removePayment(db, inv, paymentId, actor, ip, today) {
  const p = (await db.query('delete from invoice_payments where id = $1 and invoice_id = $2 returning *', [paymentId, inv.id])).rows[0];
  if (!p) throw new UserError('That payment does not exist.');
  await settle(db, inv.id, today);
  await addEvent(db, inv.id, actor, `${actor.name} removed the payment of ${inv.currency} ${Q.fmtMoney(p.amount)} recorded for ${ymd(p.paid_on)}.`);
  await audit(db, actor, 'invoice_payment_removed', 'invoice', inv.ref, `${inv.currency} ${Q.fmtMoney(p.amount)} of ${ymd(p.paid_on)}`, null, ip);
  return get(db, inv.id);
}

/** Figures for the invoices page, per currency: drafts, outstanding, overdue, received this month. */
async function summary(db, today, customerId = null) {
  const params = [today]; let where = 'true';
  if (customerId) { params.push(customerId); where = 'customer_id = $2'; }
  const rows = (await db.query(`select currency,
      count(*) filter (where status = 'draft')::int as draft_n, coalesce(sum(total) filter (where status = 'draft'), 0) as draft,
      count(*) filter (where status in ('issued','part_paid'))::int as open_n, coalesce(sum(total - paid_total) filter (where status in ('issued','part_paid')), 0) as open,
      count(*) filter (where status in ('issued','part_paid') and due_date < $1::date)::int as overdue_n,
      coalesce(sum(total - paid_total) filter (where status in ('issued','part_paid') and due_date < $1::date), 0) as overdue
    from invoices where ${where} group by currency`, params)).rows;
  const recv = (await db.query(`select i.currency, coalesce(sum(p.amount), 0) as amount, count(*)::int as n from invoice_payments p join invoices i on i.id = p.invoice_id
                                 where p.paid_on >= date_trunc('month', $1::date) and p.paid_on <= $1::date ${customerId ? 'and i.customer_id = $2' : ''} group by i.currency`, params)).rows;
  const out = { draft: { n: 0, by: {} }, open: { n: 0, by: {} }, overdue: { n: 0, by: {} }, received: { n: 0, by: {} } };
  for (const r of rows) for (const k of ['draft', 'open', 'overdue']) { out[k].n += r[`${k}_n`]; if (r[`${k}_n`]) out[k].by[r.currency] = Number(r[k]); }
  for (const r of recv) { out.received.n += r.n; out.received.by[r.currency] = Number(r.amount); }
  return out;
}

// ---------------------------------------------------------------- PDF
const fmtDate = (d) => {
  if (!d) return '';
  const [y, m, day] = ymd(d).split('-').map(Number);
  return `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};

/** The invoice as a PDF for the customer. Internal notes are never printed. */
function toPdf(inv, rows, pays, s, palette, brand) {
  const c = s.company || {};
  const from = [c.address, c.phone && `Tel: ${c.phone}`, c.email, c.tax_id && `TIN: ${c.tax_id}`].filter(Boolean).join('\n').split('\n').filter(Boolean);
  const to = [inv.billing_address, inv.customer_tin && `TIN: ${inv.customer_tin}`, inv.billing_email].filter(Boolean).join('\n').split('\n').filter(Boolean);
  const anyDiscount = rows.some((l) => Number(l.discount_pct) > 0);
  const columns = [
    { header: '#', key: 'n', weight: 0.35 }, { header: 'Description', key: 'description', weight: 4.2 }, { header: 'Qty', key: 'qty', weight: 0.7, align: 'right' },
    { header: 'Unit', key: 'unit', weight: 0.9 }, { header: `Unit price (${inv.currency})`, key: 'price', weight: 1.4, align: 'right' },
    ...(anyDiscount ? [{ header: 'Disc. %', key: 'disc', weight: 0.7, align: 'right' }] : []), { header: `Amount (${inv.currency})`, key: 'amount', weight: 1.5, align: 'right' },
  ];
  const tableRows = rows.map((l, i) => ({ n: String(i + 1), description: l.description, qty: Q.fmtQty(l.quantity), unit: l.unit, price: Q.fmtMoney(l.unit_price), disc: Number(l.discount_pct) ? Q.fmtQty(l.discount_pct) : '', amount: Q.fmtMoney(l.line_total) }));
  const totalsRows = [];
  if (Number(inv.discount_total) > 0) totalsRows.push(['Before discounts', Q.fmtMoney(Number(inv.subtotal) + Number(inv.discount_total))], ['Discounts', `- ${Q.fmtMoney(inv.discount_total)}`]);
  totalsRows.push(['Subtotal', Q.fmtMoney(inv.subtotal)], [`${inv.tax_label} ${Q.fmtQty(inv.tax_rate)}%`, Q.fmtMoney(inv.tax_total)], [`Total (${inv.currency})`, Q.fmtMoney(inv.total), true]);
  if (Number(inv.paid_total) > 0) totalsRows.push(['Paid', `- ${Q.fmtMoney(inv.paid_total)}`], [`Balance due (${inv.currency})`, Q.fmtMoney(Number(inv.total) - Number(inv.paid_total)), true]);
  const kv = [['Invoice number', inv.ref], ['Invoice date', fmtDate(inv.issue_date)], ['Due date', inv.due_date ? fmtDate(inv.due_date) : 'On receipt'], ['For', inv.title]];
  if (inv.period_from || inv.period_to) kv.push(['Period', `${fmtDate(inv.period_from) || '…'} to ${fmtDate(inv.period_to) || '…'}`]);
  if (inv.customer_ref) kv.push(['Your reference', inv.customer_ref]);
  const against = [inv.contract_ref && `contract ${inv.contract_ref}`, inv.quote_ref && `our quote ${inv.quote_ref}${inv.quote_revision > 1 ? ` R${inv.quote_revision}` : ''}`, inv.project_ref && `project ${inv.project_ref}`].filter(Boolean).join(', ');
  if (against) kv.push(['Against', against]);
  if (inv.payment_terms) kv.push(['Payment terms', inv.payment_terms]);
  const blocks = [
    { type: 'pair', left: { title: c.name || (brand && brand.name) || config.appName, lines: from.length ? from : ['(Add the company address and TIN in Settings, Company)'] }, right: { title: `Bill to: ${inv.customer_name}`, lines: to } },
    { type: 'kv', rows: kv },
    { type: 'table', columns, rows: tableRows, empty: 'No lines.' },
    { type: 'totals', rows: totalsRows },
  ];
  if (s.bank) blocks.push({ type: 'heading', text: 'How to pay' }, { type: 'p', text: s.bank });
  if (inv.terms) blocks.push({ type: 'heading', text: 'Terms' }, { type: 'p', text: inv.terms });
  if (pays && pays.length) blocks.push({ type: 'heading', text: 'Payments received' }, { type: 'p', text: pays.map((p) => `${fmtDate(p.paid_on)}: ${inv.currency} ${Q.fmtMoney(p.amount)} (${METHODS[p.method]}${p.reference ? `, ${p.reference}` : ''})`).join('\n') });
  return pdf.document({
    title: `Invoice ${inv.ref}`, subtitle: inv.status === 'draft' ? 'DRAFT - not a tax invoice' : inv.status === 'cancelled' ? 'CANCELLED' : inv.status === 'paid' ? 'PAID - thank you' : ((brand && brand.name) ? '' : (c.name || '')),
    landscape: false, blocks, appName: c.name || config.appName, footer: `${inv.ref}  |  ${fmtDate(inv.issue_date)}`, palette, brand,
  });
}

module.exports = { STATUSES, STATUS_LABELS, METHODS, OPEN, listSettings, readHeader, readPayment, get, lines, payments, events, billed, billable, unbilledTime, defaults, create,
  updateHeader, saveLines, issue, cancel, addPayment, removePayment, summary, toPdf, addDays, hours };
