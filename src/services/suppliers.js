'use strict';
// Suppliers and contractors register: who they are, their documents (their quotes, LPOs we gave them, invoices, papers), and the projects
// and tenders they work on.
const { UserError } = require('./tickets');
const storage = require('../lib/storage');
const settings = require('../lib/settings');
const audit = require('../lib/audit');
const u = require('../lib/util');

const KINDS = { contractor: 'Contractor', subcontractor: 'Subcontractor', distributor: 'Distributor', vendor: 'Vendor / supplier', consultant: 'Consultant', third_party: 'Third party' };
const STATUSES = { active: 'Active', on_hold: 'On hold', inactive: 'Inactive' };
const PHRASE = { quote: 'their quote', lpo: 'an LPO given to them', invoice: 'an invoice', delivery_note: 'a delivery note', contract: 'a contract', registration: 'registration papers', tax_clearance: 'a tax clearance', other: 'a document' };
const DOC_KINDS = { quote: 'Their quote', lpo: 'LPO we gave them', invoice: 'Invoice', delivery_note: 'Delivery note', contract: 'Contract', registration: 'Registration papers', tax_clearance: 'Tax clearance', other: 'Other' };

function readFields(b) {
  const name = u.str(b.name, 200);
  if (!name) throw new UserError('Enter the supplier or contractor name.');
  const email = b.email ? u.email(b.email) : '';
  if (b.email && String(b.email).trim() && !email) throw new UserError('The e-mail address is not valid.');
  const cemail = b.contact_email ? u.email(b.contact_email) : '';
  if (b.contact_email && String(b.contact_email).trim() && !cemail) throw new UserError("The contact person's e-mail address is not valid.");
  const website = u.str(b.website, 200);
  if (website && !/^(https?:\/\/)?[a-z0-9.-]+\.[a-z]{2,}(\/\S*)?$/i.test(website)) throw new UserError('The website is not a valid address.');
  return {
    name, kind: u.oneOf(b.kind, Object.keys(KINDS), 'contractor'), status: u.oneOf(b.status, Object.keys(STATUSES), 'active'),
    services: u.str(b.services, 2000), tin: u.str(b.tin, 40), registration_no: u.str(b.registration_no, 60), address: u.str(b.address, 500),
    phone: u.str(b.phone, 60), email: email || '', website, contact_name: u.str(b.contact_name, 120), contact_phone: u.str(b.contact_phone, 60),
    contact_email: cemail || '', payment_terms: u.str(b.payment_terms, 500), notes: u.str(b.notes, 4000),
  };
}

const COLS = ['name', 'kind', 'status', 'services', 'tin', 'registration_no', 'address', 'phone', 'email', 'website', 'contact_name', 'contact_phone', 'contact_email', 'payment_terms', 'notes'];

async function addEvent(db, id, actor, text) {
  await db.query('insert into supplier_events (supplier_id, actor_id, text) values ($1,$2,$3)', [id, actor ? actor.id : null, String(text).slice(0, 2000)]);
}

async function create(db, f, actor, ip) {
  if ((await db.query('select 1 from suppliers where lower(name) = lower($1)', [f.name])).rows.length) throw new UserError(`${f.name} is already in the register.`);
  const code = `SUP-${String((await db.query("select nextval('supplier_seq') as n")).rows[0].n).padStart(4, '0')}`;
  const r = (await db.query(`insert into suppliers (code, ${COLS.join(', ')}, created_by) values ($1, ${COLS.map((_, i) => `$${i + 2}`).join(', ')}, $${COLS.length + 2}) returning id`,
    [code, ...COLS.map((c) => f[c]), actor.id])).rows[0];
  await addEvent(db, r.id, actor, `${actor.name} added ${f.name} to the register.`);
  await audit(db, actor, 'supplier_created', 'supplier', code, f.name, null, ip);
  return get(db, r.id);
}

async function update(db, s, f, actor, ip) {
  if ((await db.query('select 1 from suppliers where lower(name) = lower($1) and id <> $2', [f.name, s.id])).rows.length) throw new UserError(`Another supplier is already called ${f.name}.`);
  await db.query(`update suppliers set ${COLS.map((c, i) => `${c} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1`, [s.id, ...COLS.map((c) => f[c])]);
  const changed = COLS.filter((c) => String(s[c] ?? '') !== String(f[c] ?? ''));
  if (changed.length) {
    await addEvent(db, s.id, actor, `${actor.name} changed ${changed.join(', ').replace(/_/g, ' ')}${s.status !== f.status ? ` (status ${STATUSES[s.status]} → ${STATUSES[f.status]})` : ''}.`);
    await audit(db, actor, 'supplier_updated', 'supplier', s.code, changed.join(', '), null, ip);
  }
  return get(db, s.id);
}

async function get(db, id) {
  if (!id) return null;
  return (await db.query('select * from suppliers where id = $1', [id])).rows[0] || null;
}

async function documents(db, where, params) {
  return (await db.query(
    `select d.*, a.filename, a.size_bytes, a.scan_status, a.created_at as uploaded_at, us.name as uploader, s.name as supplier_name, s.code as supplier_code,
            p.ref as project_ref, p.name as project_name, t.ref as tender_ref, t.title as tender_title, po.ref as lpo_ref
       from supplier_documents d join attachments a on a.id = d.attachment_id join suppliers s on s.id = d.supplier_id
       left join users us on us.id = a.uploaded_by left join projects p on p.id = d.project_id left join tenders t on t.id = d.tender_id
       left join purchase_orders po on po.id = d.purchase_order_id
      where ${where} order by coalesce(d.doc_date, a.created_at::date) desc, d.id desc`, params)).rows.map((r) => ({ ...r, kind_label: DOC_KINDS[r.kind] || 'Document' }));
}

/**
 * Upload documents for a supplier. meta: { kind, reference, amount, currency, doc_date, valid_until, project_id, tender_id, purchase_order_id, notes }.
 * Returns { stored: [filename], rejected: [text] }.
 */
async function storeDocuments(db, supplier, files, meta, actor, currencies) {
  const kind = u.oneOf(meta.kind, Object.keys(DOC_KINDS), 'other');
  const amount = meta.amount === undefined || String(meta.amount).trim() === '' ? null : u.money(meta.amount, 1e13);
  if (Number.isNaN(amount)) throw new UserError('The amount must be a number (at most 2 decimals).');
  const currency = amount === null ? '' : (u.oneOf(meta.currency, currencies) || '');
  if (amount !== null && !currency) throw new UserError('Choose the currency of the amount.');
  const docDate = meta.doc_date ? u.dateStr(meta.doc_date) : null;
  if (meta.doc_date && !docDate) throw new UserError('The document date is not valid.');
  const validUntil = meta.valid_until ? u.dateStr(meta.valid_until) : null;
  if (meta.valid_until && !validUntil) throw new UserError('The "valid until" date is not valid.');
  const projectId = u.id(meta.project_id); const tenderId = u.id(meta.tender_id); const poId = u.id(meta.purchase_order_id);
  if (projectId && !(await db.query('select 1 from projects where id = $1', [projectId])).rows.length) throw new UserError('That project does not exist.');
  if (tenderId && !(await db.query('select 1 from tenders where id = $1', [tenderId])).rows.length) throw new UserError('That tender does not exist.');
  if (poId && !(await db.query('select 1 from purchase_orders where id = $1 and supplier_id = $2', [poId, supplier.id])).rows.length) throw new UserError('That LPO is not for this supplier.');
  if (!files || !files.length) throw new UserError('Choose a file to upload.');
  const st = await settings.getAll(db, ['attachment_blocked_ext', 'attachment_max_mb']);
  const stored = []; const rejected = [];
  for (const f of files) {
    const s = await storage.storeFile({ srcPath: f.path, filename: f.originalname, mime: f.mimetype, maxBytes: Number(st.attachment_max_mb || 10) * 1048576, blockedExt: st.attachment_blocked_ext || [] });
    if (s.rejected) { rejected.push(`${storage.safeName(f.originalname)}: ${s.rejected}`); continue; }
    const a = (await db.query(
      `insert into attachments (supplier_id, purchase_order_id, filename, mime, size_bytes, sha256, storage_name, scan_status, uploaded_by, doc_kind, version)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1) returning id`,
      [supplier.id, poId, s.filename, s.mime, s.size_bytes, s.sha256, s.storage_name, s.scan_status, actor.id, `supplier_${kind}`])).rows[0];
    await db.query(
      `insert into supplier_documents (attachment_id, supplier_id, kind, reference, amount, currency, doc_date, valid_until, project_id, tender_id, purchase_order_id, notes)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [a.id, supplier.id, kind, u.str(meta.reference, 120), amount, currency, docDate, validUntil, projectId, tenderId, poId, u.str(meta.notes, 1000)]);
    stored.push(s.filename);
  }
  if (stored.length) {
    await addEvent(db, supplier.id, actor, `${actor.name} added ${PHRASE[kind]} ${stored.map((x) => `"${x}"`).join(', ')}${meta.reference ? ` (ref. ${u.str(meta.reference, 120)})` : ''}${amount !== null ? `, ${currency} ${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}` : ''}.`);
    await audit(db, actor, 'supplier_document_added', 'supplier', supplier.code, `${DOC_KINDS[kind]}: ${stored.join(', ')}`, null, '');
  }
  return { stored, rejected };
}

// ---------------------------------------------------------------- projects and tenders
async function link(db, supplier, target, role, actor) {
  const col = target.type === 'project' ? 'project_id' : 'tender_id';
  const exists = (await db.query(`select 1 from ${target.type === 'project' ? 'projects' : 'tenders'} where id = $1`, [target.id])).rows.length;
  if (!exists) throw new UserError(`That ${target.type} does not exist.`);
  if ((await db.query(`select 1 from supplier_links where supplier_id = $1 and ${col} = $2`, [supplier.id, target.id])).rows.length) throw new UserError(`${supplier.name} is already on this ${target.type}.`);
  if (supplier.status === 'inactive') throw new UserError(`${supplier.name} is inactive in the register.`);
  await db.query(`insert into supplier_links (supplier_id, ${col}, role, added_by) values ($1,$2,$3,$4)`, [supplier.id, target.id, u.str(role, 200), actor.id]);
  const name = target.type === 'project'
    ? (await db.query('select ref || \' \' || name as n from projects where id = $1', [target.id])).rows[0].n
    : (await db.query("select ref || ' ' || title as n from tenders where id = $1", [target.id])).rows[0].n;
  await addEvent(db, supplier.id, actor, `${actor.name} added ${supplier.name} to ${target.type} ${name}${role ? ` as ${u.str(role, 200)}` : ''}.`);
  if (target.type === 'project') await db.query(`insert into project_events (project_id, actor_id, kind, text) values ($1,$2,'supplier',$3)`, [target.id, actor.id, `${actor.name} added ${supplier.kind === 'contractor' || supplier.kind === 'subcontractor' ? 'contractor' : 'supplier'} ${supplier.name}${role ? ` (${u.str(role, 200)})` : ''}.`]);
  else await db.query(`insert into tender_events (tender_id, actor_id, kind, text) values ($1,$2,'supplier',$3)`, [target.id, actor.id, `${actor.name} added ${supplier.name}${role ? ` (${u.str(role, 200)})` : ''}.`]);
}

async function unlink(db, linkId, actor) {
  const l = (await db.query('select l.*, s.name from supplier_links l join suppliers s on s.id = l.supplier_id where l.id = $1', [linkId])).rows[0];
  if (!l) throw new UserError('That link no longer exists.');
  await db.query('delete from supplier_links where id = $1', [linkId]);
  await addEvent(db, l.supplier_id, actor, `${actor.name} removed ${l.name} from ${l.project_id ? 'a project' : 'a tender'}.`);
  if (l.project_id) await db.query(`insert into project_events (project_id, actor_id, kind, text) values ($1,$2,'supplier',$3)`, [l.project_id, actor.id, `${actor.name} removed ${l.name}.`]);
  else await db.query(`insert into tender_events (tender_id, actor_id, kind, text) values ($1,$2,'supplier',$3)`, [l.tender_id, actor.id, `${actor.name} removed ${l.name}.`]);
  return l;
}

/** For the project or tender page: the suppliers on it, their documents for it, and the LPOs raised against it. */
async function forEntity(db, type, id) {
  const col = type === 'project' ? 'project_id' : 'tender_id';
  const links = (await db.query(
    `select l.id, l.role, l.created_at, s.id as supplier_id, s.code, s.name, s.kind, s.status, s.contact_name, s.contact_phone, s.contact_email, u.name as added_by_name
       from supplier_links l join suppliers s on s.id = l.supplier_id left join users u on u.id = l.added_by where l.${col} = $1 order by s.name`, [id])).rows
    .map((r) => ({ ...r, kind_label: KINDS[r.kind] }));
  const docs = await documents(db, `d.${col} = $1`, [id]);
  const lpos = (await db.query(`select po.id, po.ref, po.title, po.status, po.currency, po.total, s.name as supplier_name from purchase_orders po join suppliers s on s.id = po.supplier_id
                                 where po.${col} = $1 order by po.id desc`, [id])).rows;
  return { links, docs, lpos };
}

module.exports = { KINDS, STATUSES, DOC_KINDS, readFields, create, update, get, documents, storeDocuments, link, unlink, forEntity, addEvent };
