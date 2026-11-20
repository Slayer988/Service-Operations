'use strict';
// Asset register (CMDB): equipment, licences and subscriptions at customer sites, with their warranty and expiry, the CSID and contract
// that cover them, where they came from, and the tickets about them. Everything is checked here, so the pages, the import and the
// demo data follow the same rules.
const audit = require('../lib/audit');
const u = require('../lib/util');
const { UserError } = require('./tickets');

const CATEGORIES = {
  network: 'Network (switch, router, Wi-Fi)', security: 'Security (firewall, VPN)', server: 'Server', storage: 'Storage and backup', end_user: 'Laptop or desktop',
  printer: 'Printer or scanner', phone: 'Phone or video', power: 'Power (UPS, generator)', software: 'Software licence', cloud: 'Cloud subscription', other: 'Other',
};
const SHORT = { network: 'Network', security: 'Security', server: 'Server', storage: 'Storage', end_user: 'End-user', printer: 'Printer', phone: 'Phone / video', power: 'Power', software: 'Licence', cloud: 'Cloud', other: 'Other' };
const STATUSES = { in_stock: 'In stock', active: 'In use', under_repair: 'Under repair', retired: 'Retired', disposed: 'Disposed' };
const LIVE = ['in_stock', 'active', 'under_repair'];
// words people use in spreadsheets, for the import
const SYNONYMS = {
  switch: 'network', router: 'network', 'access point': 'network', ap: 'network', wifi: 'network', 'wi-fi': 'network', wireless: 'network', network: 'network',
  firewall: 'security', vpn: 'security', utm: 'security', security: 'security', server: 'server', vm: 'server', host: 'server',
  storage: 'storage', nas: 'storage', san: 'storage', backup: 'storage', laptop: 'end_user', desktop: 'end_user', pc: 'end_user', workstation: 'end_user', 'end user': 'end_user', 'end-user': 'end_user', computer: 'end_user',
  printer: 'printer', scanner: 'printer', mfp: 'printer', phone: 'phone', 'ip phone': 'phone', video: 'phone', camera: 'phone', ups: 'power', generator: 'power', power: 'power',
  licence: 'software', license: 'software', software: 'software', subscription: 'cloud', cloud: 'cloud', saas: 'cloud', other: 'other',
};
const FIELDS = ['name', 'category', 'status', 'customer_id', 'site_id', 'csid_id', 'contract_id', 'supplier_id', 'purchase_order_id', 'manufacturer', 'model', 'serial_number',
  'hostname', 'ip_address', 'quantity', 'purchase_date', 'warranty_until', 'expires_on', 'owner_contact', 'notes'];
const LABELS = { name: 'name', category: 'category', status: 'status', customer_id: 'customer', site_id: 'site', csid_id: 'CSID', contract_id: 'contract', supplier_id: 'supplier',
  purchase_order_id: 'purchase order', manufacturer: 'manufacturer', model: 'model', serial_number: 'serial number', hostname: 'host name', ip_address: 'IP address', quantity: 'quantity',
  purchase_date: 'purchase date', warranty_until: 'warranty end', expires_on: 'expiry / end of support', owner_contact: 'contact', notes: 'notes' };

/** "2026-03-31" or "31/03/2026" -> "2026-03-31"; '' -> null; anything else -> undefined (an error). */
function readDate(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  if (!s) return null;
  if (u.dateStr(s)) return s;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (m) { const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; if (u.dateStr(iso)) return iso; }
  return undefined;
}
function readCategory(v) {
  const s = String(v || '').trim().toLowerCase();
  if (CATEGORIES[s]) return s;
  for (const [k, label] of Object.entries(CATEGORIES)) if (label.toLowerCase() === s || SHORT[k].toLowerCase() === s) return k;
  return SYNONYMS[s] || null;
}
const IP_RE = /^(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?:\/\d{1,2})?|[0-9a-fA-F:]{2,39}(?:\/\d{1,3})?)$/;

/** The form (or an import row) cleaned: { values, errors: [] } */
function read(input) {
  const v = {}; const errors = [];
  v.name = u.str(input.name, 200);
  if (!v.name) errors.push('Give it a name, for example "Core switch, server room".');
  v.category = readCategory(input.category);
  if (!v.category) errors.push(`Choose a category${input.category ? ` ("${String(input.category).slice(0, 40)}" is not one)` : ''}.`);
  v.status = input.status === undefined || input.status === '' ? 'active' : (u.oneOf(input.status, Object.keys(STATUSES)) || Object.keys(STATUSES).find((k) => STATUSES[k].toLowerCase() === String(input.status).trim().toLowerCase()));
  if (!v.status) errors.push(`"${String(input.status).slice(0, 30)}" is not a status.`);
  for (const k of ['customer_id', 'site_id', 'csid_id', 'contract_id', 'supplier_id', 'purchase_order_id']) v[k] = u.id(input[k]) || null;
  for (const [k, max] of [['manufacturer', 100], ['model', 120], ['serial_number', 120], ['hostname', 120], ['owner_contact', 200]]) v[k] = u.str(input[k], max);
  v.notes = u.str(input.notes, 4000);
  v.ip_address = u.str(input.ip_address, 60).replace(/\s+/g, '');
  if (v.ip_address && !IP_RE.test(v.ip_address)) errors.push(`"${v.ip_address}" is not an IP address.`);
  const qty = input.quantity === undefined || input.quantity === '' ? 1 : u.intIn(input.quantity, 1, 1000000);
  if (qty === null || qty === undefined) errors.push('Quantity is a whole number from 1 (for a licence: the number of seats).'); else v.quantity = qty;
  for (const k of ['purchase_date', 'warranty_until', 'expires_on']) {
    const d = readDate(input[k]);
    if (d === undefined) errors.push(`The ${LABELS[k]} "${String(input[k]).slice(0, 20)}" is not a date (use 2026-12-31 or 31/12/2026).`); else v[k] = d;
  }
  if (v.purchase_date && v.warranty_until && v.warranty_until < v.purchase_date) errors.push('The warranty cannot end before the purchase date.');
  return { values: v, errors };
}

/** Checks that need the database: the site, CSID and contract belong to the customer; a serial number is not registered twice. */
async function check(db, v, selfId = null) {
  const errors = [];
  if (v.customer_id && !(await db.query('select 1 from customers where id = $1', [v.customer_id])).rowCount) errors.push('That customer does not exist.');
  for (const [k, table, what] of [['site_id', 'sites', 'site'], ['csid_id', 'csids', 'CSID']]) {
    if (!v[k]) continue;
    const r = (await db.query(`select customer_id from ${table} where id = $1`, [v[k]])).rows[0];
    if (!r) errors.push(`That ${what} does not exist.`);
    else if (!v.customer_id || Number(r.customer_id) !== Number(v.customer_id)) errors.push(`The ${what} must belong to the asset's customer.`);
  }
  if (v.contract_id) {
    const r = (await db.query('select customer_id, counterparty_kind from contracts where id = $1', [v.contract_id])).rows[0];
    if (!r) errors.push('That contract does not exist.');
    else if (r.customer_id && v.customer_id && Number(r.customer_id) !== Number(v.customer_id)) errors.push('The contract belongs to another customer.');
  }
  if (v.supplier_id && !(await db.query('select 1 from suppliers where id = $1', [v.supplier_id])).rowCount) errors.push('That supplier does not exist.');
  if (v.purchase_order_id && !(await db.query('select 1 from purchase_orders where id = $1', [v.purchase_order_id])).rowCount) errors.push('That purchase order does not exist.');
  if (v.serial_number) {
    const dup = (await db.query(`select tag from assets where lower(serial_number) = lower($1) and lower(manufacturer) = lower($2) and ($3::bigint is null or id <> $3) and status <> 'disposed' limit 1`,
      [v.serial_number, v.manufacturer || '', selfId])).rows[0];
    if (dup) errors.push(`Serial number ${v.serial_number}${v.manufacturer ? ` (${v.manufacturer})` : ''} is already registered as ${dup.tag}.`);
  }
  return errors;
}

async function event(db, assetId, actor, text) {
  await db.query('insert into asset_events (asset_id, actor_id, text) values ($1,$2,$3)', [assetId, actor ? actor.id : null, text]);
}

async function create(db, input, actor, ip = '', { quiet = false } = {}) {
  const { values: v, errors } = read(input);
  errors.push(...(await check(db, v)));
  if (errors.length) throw new UserError(errors.join(' '));
  const a = (await db.query(`insert into assets (${FIELDS.join(', ')}, created_by) values (${FIELDS.map((_, i) => `$${i + 1}`).join(', ')}, $${FIELDS.length + 1}) returning *`,
    [...FIELDS.map((k) => v[k]), actor ? actor.id : null])).rows[0];
  await event(db, a.id, actor, `${actor ? actor.name : 'The system'} registered ${a.tag}.`);
  if (!quiet) await audit(db, actor, 'asset_created', 'asset', a.tag, `${a.name} (${CATEGORIES[a.category]})`, a.customer_id, ip);
  return a;
}

const show = (k, val) => (val === null || val === undefined || val === '' ? '(none)' : k === 'category' ? SHORT[val] : k === 'status' ? STATUSES[val] : String(val));
async function update(db, asset, input, actor, ip = '') {
  const { values: v, errors } = read(input);
  errors.push(...(await check(db, v, asset.id)));
  if (errors.length) throw new UserError(errors.join(' '));
  const norm = (x) => (x instanceof Date ? x.toISOString().slice(0, 10) : x === null || x === undefined ? null : String(x));
  const changed = FIELDS.filter((k) => norm(asset[k]) !== norm(v[k]));
  if (!changed.length) return asset;
  const a = (await db.query(`update assets set ${FIELDS.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_at = now() where id = $1 returning *`, [asset.id, ...FIELDS.map((k) => v[k])])).rows[0];
  const plain = changed.filter((k) => !k.endsWith('_id') && k !== 'notes');
  const parts = plain.map((k) => `${LABELS[k]} ${show(k, norm(asset[k]))} → ${show(k, norm(v[k]))}`);
  const others = changed.filter((k) => !plain.includes(k)).map((k) => LABELS[k]);
  await event(db, a.id, actor, `${actor.name} changed ${[...parts, ...(others.length ? [`the ${others.join(', ')}`] : [])].join('; ')}.`);
  await audit(db, actor, 'asset_updated', 'asset', a.tag, changed.map((k) => LABELS[k]).join(', '), a.customer_id, ip);
  return a;
}

/** One asset with the names of what it is linked to. */
async function get(db, id) {
  return (await db.query(`select a.*, c.name as customer_name, c.code as customer_code, s.name as site_name, x.csid, k.reference as contract_reference, k.title as contract_title,
                                 sp.name as supplier_name, po.ref as po_ref, cb.name as created_by_name
                            from assets a left join customers c on c.id = a.customer_id left join sites s on s.id = a.site_id left join csids x on x.id = a.csid_id
                            left join contracts k on k.id = a.contract_id left join suppliers sp on sp.id = a.supplier_id left join purchase_orders po on po.id = a.purchase_order_id
                            left join users cb on cb.id = a.created_by where a.id = $1`, [id])).rows[0] || null;
}

/** { state: 'expired'|'soon'|'ok'|'none', days } for a date, against today (soon = within `within` days). */
function dateState(date, today, within = 90) {
  if (!date) return { state: 'none', days: null };
  const d = date instanceof Date ? date.toISOString().slice(0, 10) : String(date).slice(0, 10);
  const days = u.dayDiff(today, d);
  return { state: days < 0 ? 'expired' : days <= within ? 'soon' : 'ok', days, date: d };
}

async function linkTicket(db, ticket, assetId, actor) {
  if (!ticket.customer_id) throw new UserError('Verify the ticket\'s customer first: equipment is linked within one customer.');
  const a = (await db.query('select id, tag, name, customer_id, status from assets where id = $1', [assetId])).rows[0];
  if (!a) throw new UserError('That asset does not exist.');
  if (Number(a.customer_id) !== Number(ticket.customer_id)) throw new UserError(`${a.tag} belongs to another customer.`);
  const r = await db.query('insert into ticket_assets (ticket_id, asset_id, linked_by) values ($1,$2,$3) on conflict do nothing', [ticket.id, a.id, actor.id]);
  if (r.rowCount) {
    await event(db, a.id, actor, `${actor.name} linked ticket ${ticket.ref}.`);
    await db.query(`insert into ticket_events (ticket_id, actor_id, kind, text, internal) values ($1,$2,'asset_linked',$3,true)`, [ticket.id, actor.id, `${actor.name} linked ${a.tag} ${a.name}.`]);
  }
  return a;
}
async function unlinkTicket(db, ticket, assetId, actor) {
  const a = (await db.query('select id, tag, name from assets where id = $1', [assetId])).rows[0];
  const r = await db.query('delete from ticket_assets where ticket_id = $1 and asset_id = $2', [ticket.id, assetId]);
  if (r.rowCount && a) await event(db, a.id, actor, `${actor.name} unlinked ticket ${ticket.ref}.`);
}

// ------------------------------------------------------------------ import from a spreadsheet (CSV)
/** RFC 4180 CSV: quoted fields, doubled quotes, commas or semicolons, CRLF or LF. Returns rows of strings. */
function parseCsv(text) {
  let s = String(text || ''); if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const first = s.split(/\r?\n/, 1)[0] || '';
  const sep = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
  const rows = []; let row = []; let f = ''; let qd = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (qd) { if (c === '"') { if (s[i + 1] === '"') { f += '"'; i++; } else qd = false; } else f += c; continue; }
    if (c === '"') qd = true;
    else if (c === sep) { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && s[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  return rows.filter((r) => r.some((x) => String(x).trim() !== ''));
}
const HEADERS = {
  name: ['name', 'asset', 'asset name', 'description', 'item'], category: ['category', 'type', 'kind'], status: ['status', 'state'],
  customer: ['customer', 'customer code', 'client', 'company'], site: ['site', 'location', 'branch'], csid: ['csid', 'service id'], contract: ['contract', 'contract reference'],
  manufacturer: ['manufacturer', 'make', 'brand', 'vendor'], model: ['model'], serial_number: ['serial', 'serial number', 'serial no', 's/n', 'sn'],
  hostname: ['hostname', 'host name', 'host'], ip_address: ['ip', 'ip address', 'address'], quantity: ['quantity', 'qty', 'seats', 'licences', 'licenses'],
  purchase_date: ['purchase date', 'purchased', 'bought'], warranty_until: ['warranty', 'warranty end', 'warranty until', 'warranty expiry'],
  expires_on: ['expires', 'expiry', 'expiry date', 'end of support', 'renewal date', 'subscription end'], owner_contact: ['contact', 'owner', 'user', 'assigned to'], notes: ['notes', 'comment', 'comments'],
};
const TEMPLATE = 'name,category,customer,site,csid,manufacturer,model,serial_number,hostname,ip_address,quantity,status,purchase_date,warranty_until,expires_on,contract,owner_contact,notes\r\n'
  + 'Core switch,network,KCB,Head office,CSID-000001,Cisco,Catalyst 9300-48P,FOC2231X0AB,core-sw-01,10.1.0.2,1,active,2024-03-15,2027-03-14,,,IT manager,Server room rack 2\r\n'
  + 'Microsoft 365 Business Premium,software,KCB,,,Microsoft,M365 Business Premium,,,,120,active,2026-01-01,,2026-12-31,,,Annual subscription\r\n';

/**
 * Checks every row first and imports nothing if any row is wrong, so a spreadsheet goes in whole or not at all.
 * Customers, sites, CSIDs and contracts are given by code or name. Returns { imported, errors: ["Row 3: ..."] }.
 */
async function importCsv(db, text, actor, ip = '', { maxRows = 2000 } = {}) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new UserError('The file has no rows to import: the first line is the column names, then one asset per line.');
  if (rows.length - 1 > maxRows) throw new UserError(`At most ${maxRows} assets at a time; this file has ${rows.length - 1}. Split it.`);
  const head = rows[0].map((h) => String(h).trim().toLowerCase().replace(/[_]+/g, ' '));
  const col = {};
  for (const [k, names] of Object.entries(HEADERS)) { const i = head.findIndex((h) => h === k.replace(/_/g, ' ') || names.includes(h)); if (i >= 0) col[k] = i; }
  if (col.name === undefined || col.category === undefined) throw new UserError('The first line must name the columns, with at least "name" and "category". Download the template to see them all.');
  const customers = (await db.query('select id, code, name from customers')).rows;
  const findCustomer = (s) => { const t = s.trim().toLowerCase(); return customers.find((c) => c.code.toLowerCase() === t || c.name.toLowerCase() === t || c.name.toLowerCase().replace(/ \(demo\)$/, '') === t); };
  const out = []; const errors = []; const seen = new Map();
  for (let r = 1; r < rows.length; r++) {
    const cell = (k) => (col[k] === undefined ? '' : String(rows[r][col[k]] === undefined ? '' : rows[r][col[k]]).trim());
    const input = {}; const rowErr = [];
    for (const k of ['name', 'category', 'status', 'manufacturer', 'model', 'serial_number', 'hostname', 'ip_address', 'quantity', 'purchase_date', 'warranty_until', 'expires_on', 'owner_contact', 'notes']) input[k] = cell(k);
    if (cell('customer')) {
      const c = findCustomer(cell('customer'));
      if (!c) rowErr.push(`no customer "${cell('customer')}"`); else {
        input.customer_id = c.id;
        if (cell('site')) { const s = (await db.query('select id from sites where customer_id = $1 and lower(name) = lower($2)', [c.id, cell('site')])).rows[0]; if (s) input.site_id = s.id; else rowErr.push(`${c.name} has no site "${cell('site')}"`); }
        if (cell('csid')) { const x = (await db.query('select id from csids where customer_id = $1 and upper(csid) = upper($2)', [c.id, cell('csid')])).rows[0]; if (x) input.csid_id = x.id; else rowErr.push(`${c.name} has no CSID "${cell('csid')}"`); }
      }
    } else if (cell('site') || cell('csid')) rowErr.push('a site or CSID needs the customer column');
    if (cell('contract')) { const k = (await db.query('select id from contracts where lower(reference) = lower($1) or lower(title) = lower($1) limit 1', [cell('contract')])).rows[0]; if (k) input.contract_id = k.id; else rowErr.push(`no contract "${cell('contract')}"`); }
    const { values, errors: e1 } = read(input);
    rowErr.push(...e1.map((x) => x.replace(/\.$/, '')));
    if (!e1.length) rowErr.push(...(await check(db, values)).map((x) => x.replace(/\.$/, '')));
    if (values.serial_number) {
      const key = `${values.manufacturer.toLowerCase()}|${values.serial_number.toLowerCase()}`;
      if (seen.has(key)) rowErr.push(`serial number ${values.serial_number} is also on row ${seen.get(key)}`); else seen.set(key, r + 1);
    }
    if (rowErr.length) errors.push(`Row ${r + 1}${input.name ? ` (${input.name})` : ''}: ${rowErr.join('; ')}.`);
    else out.push(input);
  }
  if (errors.length) return { imported: 0, errors };
  const made = [];
  for (const input of out) made.push(await create(db, input, actor, ip, { quiet: true }));
  await audit(db, actor, 'assets_imported', 'asset', `${made.length} assets`, made.length ? `${made[0].tag} to ${made[made.length - 1].tag}` : '', null, ip);
  return { imported: made.length, errors: [], first: made[0] ? made[0].tag : null, last: made.length ? made[made.length - 1].tag : null };
}

/** Bell: live assets whose warranty or licence ends within `days` (and not already ended). */
async function endingSoon(db, today, days = 30) {
  return (await db.query(`select count(*)::int as n from assets where status = any($1) and
     ((warranty_until between $2::date and $2::date + $3::int) or (expires_on between $2::date and $2::date + $3::int))`, [LIVE, today, days])).rows[0].n;
}

module.exports = { CATEGORIES, SHORT, STATUSES, LIVE, LABELS, TEMPLATE, read, readDate, readCategory, check, create, update, get, dateState, linkTicket, unlinkTicket, parseCsv, importCsv, endingSoon, event };
