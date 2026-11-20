'use strict';
// Purchase orders (LPOs): what we order from a supplier or contractor, usually against their quote, a contract, a project, a tender
// or our own quote to a customer. Draft → Issued → Received → Closed (or Cancelled). An issued LPO is fixed; changes are made by
// cancelling it and raising a new one. Approval before issue is planned; it will sit between Draft and Issued.
const { UserError } = require('./tickets');
const Q = require('./quotes');                       // the same line arithmetic and line form as quotes
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const pdf = require('../lib/pdf');
const u = require('../lib/util');
const config = require('../config');

const STATUSES = ['draft', 'issued', 'received', 'closed', 'cancelled'];
const STATUS_LABELS = { draft: 'Draft', issued: 'Issued', received: 'Received', closed: 'Closed', cancelled: 'Cancelled' };
const MOVES = { draft: ['issued', 'cancelled'], issued: ['received', 'cancelled'], received: ['closed'], closed: [], cancelled: [] };
const MOVE_LABELS = { issued: 'Issue to the supplier', received: 'Goods or services received', closed: 'Close (invoiced and settled)', cancelled: 'Cancel' };

async function listSettings(db) {
  const q = await Q.listSettings(db);
  const s = await settings.getAll(db, ['lpo_terms', 'lpo_delivery_address']);
  return { ...q, terms: typeof s.lpo_terms === 'string' ? s.lpo_terms : '', deliveryAddress: typeof s.lpo_delivery_address === 'string' ? s.lpo_delivery_address : '' };
}

function readHeader(b, opts) {
  const title = u.str(b.title, 200);
  if (!title) throw new UserError('Enter what the order is for.');
  const supplierId = u.id(b.supplier_id);
  if (!supplierId) throw new UserError('Choose the supplier or contractor.');
  const currency = u.oneOf(b.currency, opts.currencies);
  if (!currency) throw new UserError('Choose one of the currencies set up in Settings.');
  const issue = b.issue_date ? u.dateStr(b.issue_date) : null;
  if (b.issue_date && !issue) throw new UserError('The order date is not valid.');
  const delivery = b.delivery_date ? u.dateStr(b.delivery_date) : null;
  if (b.delivery_date && !delivery) throw new UserError('The delivery date is not valid.');
  if (issue && delivery && delivery < issue) throw new UserError('The delivery date cannot be before the order date.');
  const rate = u.money(b.tax_rate === undefined || String(b.tax_rate).trim() === '' ? '0' : b.tax_rate, 100);
  if (rate === null || Number.isNaN(rate)) throw new UserError('The tax rate is a percentage from 0 to 100.');
  return {
    title, supplier_id: supplierId, currency, issue_date: issue, delivery_date: delivery, delivery_address: u.str(b.delivery_address, 500),
    payment_terms: u.str(b.payment_terms, 500), terms: u.str(b.terms, 4000), internal_notes: u.str(b.internal_notes, 4000), tax_rate: rate, tax_label: u.str(b.tax_label, 20) || 'VAT',
    supplier_doc_id: u.id(b.supplier_doc_id), contract_id: u.id(b.contract_id), project_id: u.id(b.project_id), tender_id: u.id(b.tender_id), customer_quote_id: u.id(b.customer_quote_id),
  };
}

const SELECT = `select po.*, s.name as supplier_name, s.code as supplier_code, s.address as supplier_address, s.tin as supplier_tin, s.email as supplier_email, s.phone as supplier_phone,
                       s.contact_name as supplier_contact, s.status as supplier_status, ow.name as owner_name, ib.name as issued_by_name,
                       p.ref as project_ref, p.name as project_name, t.ref as tender_ref, t.title as tender_title, c.reference as contract_ref, c.title as contract_title,
                       cq.ref as customer_quote_ref, cq.revision as customer_quote_revision, sd.reference as supplier_doc_ref, sa.filename as supplier_doc_file
                  from purchase_orders po join suppliers s on s.id = po.supplier_id join users ow on ow.id = po.owner_id left join users ib on ib.id = po.issued_by
                  left join projects p on p.id = po.project_id left join tenders t on t.id = po.tender_id left join contracts c on c.id = po.contract_id
                  left join quotes cq on cq.id = po.customer_quote_id left join supplier_documents sd on sd.id = po.supplier_doc_id left join attachments sa on sa.id = sd.attachment_id`;

async function get(db, id) { return id ? (await db.query(`${SELECT} where po.id = $1`, [id])).rows[0] || null : null; }
async function lines(db, id) { return (await db.query('select * from purchase_order_lines where purchase_order_id = $1 order by position, id', [id])).rows; }
async function events(db, id) {
  return (await db.query('select e.*, u.name as actor_name from purchase_order_events e left join users u on u.id = e.actor_id where e.purchase_order_id = $1 order by e.id desc limit 200', [id])).rows;
}
async function addEvent(db, id, actor, text) {
  await db.query('insert into purchase_order_events (purchase_order_id, actor_id, text) values ($1,$2,$3)', [id, actor ? actor.id : null, String(text).slice(0, 2000)]);
}

/** Every link must exist, and the supplier's own quote must be from the same supplier. */
async function checkLinks(db, h) {
  const s = (await db.query('select id, name, status from suppliers where id = $1', [h.supplier_id])).rows[0];
  if (!s) throw new UserError('That supplier does not exist.');
  if (s.status !== 'active') throw new UserError(`${s.name} is ${s.status === 'on_hold' ? 'on hold' : 'inactive'} in the register. Orders can only be raised for active suppliers.`);
  if (h.supplier_doc_id) {
    const d = (await db.query('select supplier_id from supplier_documents where id = $1', [h.supplier_doc_id])).rows[0];
    if (!d) throw new UserError("That supplier's quote no longer exists.");
    if (Number(d.supplier_id) !== Number(h.supplier_id)) throw new UserError("The supplier's quote must be from the same supplier as the order.");
  }
  for (const [col, table, what] of [['contract_id', 'contracts', 'contract'], ['project_id', 'projects', 'project'], ['tender_id', 'tenders', 'tender'], ['customer_quote_id', 'quotes', 'customer quote']]) {
    if (h[col] && !(await db.query(`select 1 from ${table} where id = $1`, [h[col]])).rows.length) throw new UserError(`That ${what} does not exist.`);
  }
  return s;
}

/** Starting values: from Settings and, when given, from the thing the order is against. from: { supplier, supplier_doc, contract, project, tender, customer_quote } ids. */
async function defaults(db, from, today) {
  const s = await listSettings(db);
  const out = { title: '', supplier_id: from.supplier || '', currency: s.defaultCurrency, issue_date: today, delivery_date: '', delivery_address: s.deliveryAddress, payment_terms: '',
    terms: s.terms, internal_notes: '', tax_rate: s.taxRate, tax_label: s.taxLabel, supplier_doc_id: from.supplier_doc || '', contract_id: from.contract || '', project_id: from.project || '',
    tender_id: from.tender || '', customer_quote_id: from.customer_quote || '' };
  if (out.supplier_id) {
    const sup = (await db.query('select payment_terms from suppliers where id = $1', [out.supplier_id])).rows[0];
    if (sup && sup.payment_terms) out.payment_terms = sup.payment_terms;
  }
  if (from.supplier_doc) {
    const d = (await db.query('select d.*, s.payment_terms from supplier_documents d join suppliers s on s.id = d.supplier_id where d.id = $1', [from.supplier_doc])).rows[0];
    if (d) Object.assign(out, { supplier_id: d.supplier_id, project_id: d.project_id || out.project_id, tender_id: d.tender_id || out.tender_id, payment_terms: d.payment_terms || out.payment_terms,
      currency: s.currencies.includes(d.currency) ? d.currency : out.currency, title: d.reference ? `Order against quote ${d.reference}` : out.title });
  }
  if (from.project && !out.title) { const p = (await db.query('select name from projects where id = $1', [from.project])).rows[0]; if (p) out.title = p.name; }
  if (from.tender && !out.title) { const t = (await db.query('select title from tenders where id = $1', [from.tender])).rows[0]; if (t) out.title = t.title; }
  if (from.contract && !out.title) { const c = (await db.query('select title from contracts where id = $1', [from.contract])).rows[0]; if (c) out.title = c.title; }
  if (from.customer_quote) {
    const cq = (await db.query('select title, currency from quotes where id = $1', [from.customer_quote])).rows[0];
    if (cq) Object.assign(out, { title: out.title || cq.title, currency: s.currencies.includes(cq.currency) ? cq.currency : out.currency });
  }
  return out;
}

const HEAD = ['supplier_id', 'title', 'currency', 'issue_date', 'delivery_date', 'delivery_address', 'payment_terms', 'terms', 'internal_notes', 'tax_rate', 'tax_label',
  'supplier_doc_id', 'contract_id', 'project_id', 'tender_id', 'customer_quote_id'];

async function create(db, input, actor, ip) {
  const h = { ...input }; for (const k of ['supplier_doc_id', 'contract_id', 'project_id', 'tender_id', 'customer_quote_id', 'delivery_date', 'issue_date']) h[k] = h[k] || null;
  const s = await checkLinks(db, h);
  const ref = `LPO-${String((await db.query("select nextval('purchase_order_seq') as n")).rows[0].n).padStart(6, '0')}`;
  const vals = HEAD.map((k) => (k === 'issue_date' ? h.issue_date || null : h[k]));
  const r = (await db.query(
    `insert into purchase_orders (ref, ${HEAD.join(', ')}, owner_id) values ($1, ${HEAD.map((k, i) => (k === 'issue_date' ? `coalesce($${i + 2}::date, current_date)` : `$${i + 2}`)).join(', ')}, $${HEAD.length + 2}) returning id`,
    [ref, ...vals, actor.id])).rows[0];
  await addEvent(db, r.id, actor, `${actor.name} raised the order for ${s.name}.`);
  await db.query('insert into supplier_events (supplier_id, actor_id, text) values ($1,$2,$3)', [h.supplier_id, actor.id, `${actor.name} raised ${ref}: ${h.title}.`]);
  await audit(db, actor, 'lpo_created', 'lpo', ref, `${s.name}: ${h.title}`, null, ip);
  return get(db, r.id);
}

function mustBeDraft(po) {
  if (po.status !== 'draft') throw new UserError(`${po.ref} was ${STATUS_LABELS[po.status].toLowerCase()} and can no longer be changed. To change an issued order, cancel it and raise a new one.`);
}

async function updateHeader(db, po, input, actor) {
  mustBeDraft(po);
  await require('./approvals').withdraw(db, 'lpo', po.id, actor, 'its details were changed');
  const h = { ...input }; for (const k of ['supplier_doc_id', 'contract_id', 'project_id', 'tender_id', 'customer_quote_id']) h[k] = h[k] || null;
  await checkLinks(db, h);
  await db.query(`update purchase_orders set ${HEAD.map((k, i) => (k === 'issue_date' ? `issue_date = coalesce($${i + 2}::date, issue_date)` : `${k} = $${i + 2}`)).join(', ')}, updated_at = now() where id = $1`,
    [po.id, ...HEAD.map((k) => h[k])]);
  await recalc(db, po.id);
  await addEvent(db, po.id, actor, `${actor.name} changed the order details.`);
  return get(db, po.id);
}

async function recalc(db, id) {
  const p = (await db.query('select tax_rate from purchase_orders where id = $1', [id])).rows[0];
  const t = Q.totals(await lines(db, id), p.tax_rate);
  await db.query('update purchase_orders set subtotal = $2, discount_total = $3, tax_total = $4, total = $5, updated_at = now() where id = $1', [id, t.subtotal, t.discount, t.tax, t.total]);
  return t;
}

async function saveLines(db, po, rows, actor) {
  mustBeDraft(po);
  await require('./approvals').withdraw(db, 'lpo', po.id, actor, 'its lines were changed');
  await db.query('delete from purchase_order_lines where purchase_order_id = $1', [po.id]);
  let pos = 0;
  for (const l of rows) {
    pos += 1;
    await db.query('insert into purchase_order_lines (purchase_order_id, position, description, quantity, unit, unit_price, discount_pct, line_total) values ($1,$2,$3,$4,$5,$6,$7,$8)',
      [po.id, pos, l.description, l.quantity, l.unit, l.unit_price, l.discount_pct, l.line_total]);
  }
  const t = await recalc(db, po.id);
  await addEvent(db, po.id, actor, `${actor.name} saved ${rows.length} line(s). Total ${po.currency} ${Q.fmtMoney(t.total)}.`);
  return get(db, po.id);
}

async function setStatus(db, po, to, actor, opts = {}, ip = '') {
  if (!STATUSES.includes(to)) throw new UserError('Unknown status.');
  if (!(MOVES[po.status] || []).includes(to)) throw new UserError(`A ${STATUS_LABELS[po.status].toLowerCase()} order cannot be marked ${STATUS_LABELS[to].toLowerCase()}.`);
  const note = u.str(opts.note, 1000);
  if (to === 'issued') {
    const n = (await db.query('select count(*)::int as n from purchase_order_lines where purchase_order_id = $1', [po.id])).rows[0].n;
    if (!n) throw new UserError('Add at least one line before issuing the order.');
    const s = (await db.query('select name, status from suppliers where id = $1', [po.supplier_id])).rows[0];
    if (s.status !== 'active') throw new UserError(`${s.name} is no longer active in the register. The order cannot be issued.`);
    await require('./approvals').assertApproved(db, 'lpo', po.id);
  }
  if (to === 'cancelled' && po.status === 'issued' && !note) throw new UserError('Say why an issued order is cancelled (the supplier has a copy).');
  await db.query(
    `update purchase_orders set status = $2, updated_at = now(),
            issued_at = case when $2 = 'issued' then now() else issued_at end, issued_by = case when $2 = 'issued' then $4 else issued_by end,
            issue_date = case when $2 = 'issued' then current_date else issue_date end,
            received_at = case when $2 = 'received' then now() else received_at end, closed_at = case when $2 in ('closed','cancelled') then now() else closed_at end,
            decision_note = case when $3 <> '' then $3 else decision_note end where id = $1`, [po.id, to, note, actor.id]);
  await addEvent(db, po.id, actor, `${actor.name} marked the order ${STATUS_LABELS[to].toLowerCase()}${note ? `: ${note}` : '.'}`);
  await db.query('insert into supplier_events (supplier_id, actor_id, text) values ($1,$2,$3)', [po.supplier_id, actor.id, `${po.ref} ${STATUS_LABELS[to].toLowerCase()} (${po.currency} ${Q.fmtMoney(po.total)})${note ? `: ${note}` : '.'}`]);
  if (po.project_id) await db.query(`insert into project_events (project_id, actor_id, kind, text) values ($1,$2,'lpo',$3)`, [po.project_id, actor.id, `LPO ${po.ref} to ${po.supplier_name} ${STATUS_LABELS[to].toLowerCase()} (${po.currency} ${Q.fmtMoney(po.total)}).`]);
  await audit(db, actor, `lpo_${to}`, 'lpo', po.ref, note || po.title, null, ip);
  return get(db, po.id);
}

// ---------------------------------------------------------------- PDF
const fmtDate = (d) => {
  if (!d) return '';
  const s = d instanceof Date ? d.toISOString().slice(0, 10) : String(d).slice(0, 10);
  const [y, m, day] = s.split('-').map(Number);
  return `${day} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1]} ${y}`;
};

/** The order as a PDF to send to the supplier. Internal notes are never printed. */
function toPdf(po, rows, s, palette, brand) {
  const c = s.company || {};
  const from = [c.address, c.phone && `Tel: ${c.phone}`, c.email, c.tax_id && `Tax ID / TIN: ${c.tax_id}`].filter(Boolean).join('\n').split('\n').filter(Boolean);
  const to = [po.supplier_address, po.supplier_tin && `TIN: ${po.supplier_tin}`, po.supplier_contact && `Attn: ${po.supplier_contact}`, po.supplier_email, po.supplier_phone].filter(Boolean).join('\n').split('\n').filter(Boolean);
  const anyDiscount = rows.some((l) => Number(l.discount_pct) > 0);
  const columns = [
    { header: '#', key: 'n', weight: 0.35 }, { header: 'Description', key: 'description', weight: 4.2 }, { header: 'Qty', key: 'qty', weight: 0.7, align: 'right' },
    { header: 'Unit', key: 'unit', weight: 0.9 }, { header: `Unit price (${po.currency})`, key: 'price', weight: 1.4, align: 'right' },
    ...(anyDiscount ? [{ header: 'Disc. %', key: 'disc', weight: 0.7, align: 'right' }] : []), { header: `Amount (${po.currency})`, key: 'amount', weight: 1.5, align: 'right' },
  ];
  const fq = (n) => Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 2 });
  const tableRows = rows.map((l, i) => ({ n: String(i + 1), description: l.description, qty: fq(l.quantity), unit: l.unit, price: Q.fmtMoney(l.unit_price), disc: Number(l.discount_pct) ? fq(l.discount_pct) : '', amount: Q.fmtMoney(l.line_total) }));
  const totalsRows = [];
  if (Number(po.discount_total) > 0) totalsRows.push(['Before discounts', Q.fmtMoney(Number(po.subtotal) + Number(po.discount_total))], ['Discounts', `- ${Q.fmtMoney(po.discount_total)}`]);
  totalsRows.push(['Subtotal', Q.fmtMoney(po.subtotal)], [`${po.tax_label} ${fq(po.tax_rate)}%`, Q.fmtMoney(po.tax_total)], [`Total (${po.currency})`, Q.fmtMoney(po.total), true]);
  const against = [po.supplier_doc_ref && `your quote ${po.supplier_doc_ref}`, po.contract_ref && `contract ${po.contract_ref}`, po.project_ref && `project ${po.project_ref}`, po.tender_ref && `tender ${po.tender_ref}`].filter(Boolean).join(', ');
  const kv = [['LPO number', po.ref], ['Date', fmtDate(po.issue_date)], ['Deliver by', po.delivery_date ? fmtDate(po.delivery_date) : 'As agreed'], ['For', po.title]];
  if (against) kv.push(['Against', against]);
  if (po.payment_terms) kv.push(['Payment terms', po.payment_terms]);
  const blocks = [
    { type: 'pair', left: { title: c.name || 'From', lines: from }, right: { title: `To: ${po.supplier_name}`, lines: to } },
    { type: 'kv', rows: kv },
    { type: 'table', columns, rows: tableRows, empty: 'No lines.' },
    { type: 'totals', rows: totalsRows },
  ];
  if (po.delivery_address) blocks.push({ type: 'heading', text: 'Deliver to' }, { type: 'p', text: po.delivery_address });
  if (po.terms) blocks.push({ type: 'heading', text: 'Terms' }, { type: 'p', text: po.terms });
  blocks.push({ type: 'pair', left: { title: 'Authorised by', lines: [po.issued_by_name || po.owner_name || '', '', 'Signature: ____________________', `Date: ${po.issued_at ? fmtDate(po.issued_at) : '____________'}`] },
    right: { title: 'Accepted by the supplier', lines: ['Name: ____________________', '', 'Signature: ____________________', 'Date: ____________'] } });
  if (['cancelled', 'closed', 'received'].includes(po.status)) blocks.push({ type: 'p', text: `Status: ${STATUS_LABELS[po.status]}.` });
  return pdf.document({
    title: `Local Purchase Order ${po.ref}`, subtitle: po.status === 'draft' ? 'DRAFT - not valid for supply' : po.status === 'cancelled' ? 'CANCELLED - not valid for supply' : ((brand && brand.name) ? '' : (c.name || '')),
    landscape: false, blocks, appName: c.name || config.appName, footer: `${po.ref}  |  ${fmtDate(po.issue_date)}`, palette, brand,
  });
}

/** LPO tracking figures, for everyone or one supplier: how many orders and how much money sit at each stage, per currency.
 *  { draft, issued, late, received, closed, cancelled, committed } each { n, by: { UGX: 123.45, ... } }; late is part of issued; committed = issued + received. */
async function tracker(db, supplierId) {
  const params = []; let where = 'true';
  if (supplierId) { params.push(supplierId); where = 'supplier_id = $1'; }
  const rows = (await db.query(`select status, currency, count(*)::int as n, coalesce(sum(total), 0) as total,
                                       count(*) filter (where status = 'issued' and delivery_date < current_date)::int as late_n,
                                       coalesce(sum(total) filter (where status = 'issued' and delivery_date < current_date), 0) as late_total
                                  from purchase_orders where ${where} group by status, currency`, params)).rows;
  const out = {}; for (const k of [...STATUSES, 'late', 'committed']) out[k] = { n: 0, by: {} };
  const add = (k, cur, n, v) => { if (!n) return; out[k].n += n; out[k].by[cur] = (out[k].by[cur] || 0) + Number(v); };
  for (const r of rows) {
    add(r.status, r.currency, r.n, r.total);
    if (r.status === 'issued') add('late', r.currency, r.late_n, r.late_total);
    if (r.status === 'issued' || r.status === 'received') add('committed', r.currency, r.n, r.total);
  }
  return out;
}

module.exports = { tracker, STATUSES, STATUS_LABELS, MOVES, MOVE_LABELS, listSettings, readHeader, get, lines, events, defaults, create, updateHeader, saveLines, setStatus, toPdf, addEvent };
