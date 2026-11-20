'use strict';
// 1.15.0: pure rules behind the lifecycle, SLA history, local-time e-mail, one-time codes and secret storage.
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'unit-test-secret-0123456789abcdef0123456789';
const test = require('node:test');
const assert = require('node:assert/strict');
const sla = require('../../src/lib/sla');
const util = require('../../src/lib/util');
const totp = require('../../src/lib/totp');
const twofactor = require('../../src/lib/twofactor');
const tickets = require('../../src/services/tickets');

const NOW = new Date('2026-11-02T10:00:00Z');
const ago = (h) => new Date(NOW.getTime() - h * 3600000).toISOString();

test('breachRecord: a target met late, or still unmet past its due time, is recorded', () => {
  const r = sla.breachRecord({ type: 'incident', response_due: ago(5), responded_at: ago(1), resolution_due: ago(2), resolved_at: null, restoration_due: ago(1), restored_at: ago(3) }, NOW);
  assert.ok(r.response && r.resolution, 'late response and overdue resolution');
  assert.equal(r.restoration, undefined, 'restored on time');
  assert.equal(r.response.due, ago(5));
});

test('breachRecord: on-time work and a paused clock record nothing', () => {
  assert.deepEqual(sla.breachRecord({ type: 'incident', response_due: ago(-2), responded_at: null, resolution_due: ago(-9), resolved_at: null }, NOW), {});
  assert.deepEqual(sla.breachRecord({ type: 'incident', resolution_due: ago(3), resolved_at: null, paused_at: ago(4) }, NOW), {}, 'waiting for the customer is not a breach');
});

test('breachRecord: requests have no restoration target, and what is on record is never removed', () => {
  assert.equal(sla.breachRecord({ type: 'request', restoration_due: ago(5), restored_at: null }, NOW).restoration, undefined);
  const kept = { resolution: { due: ago(50), at: ago(40) } };
  const r = sla.breachRecord({ type: 'incident', sla_breaches: kept, resolution_due: ago(-100), resolved_at: null }, NOW);   // the due time was moved later by a reopen
  assert.deepEqual(r.resolution, kept.resolution);
});

test('status transitions: working states move freely, nothing closes directly, closed only reopens, cancelled is final', () => {
  assert.deepEqual(tickets.nextStatuses('cancelled'), []);
  assert.ok(!tickets.nextStatuses('new').includes('closed') && !tickets.nextStatuses('new').includes('new'));
  assert.ok(!tickets.nextStatuses('open').includes('closed') && tickets.nextStatuses('open').includes('resolved'));
  assert.ok(tickets.nextStatuses('resolved').includes('closed') && tickets.nextStatuses('resolved').includes('in_progress'));
  assert.deepEqual(tickets.nextStatuses('closed').sort(), ['in_progress', 'open', 'pending_customer', 'pending_vendor', 'restored']);
  for (const s of Object.keys(tickets.TRANSITIONS)) assert.ok(!tickets.nextStatuses(s).includes(s), `${s} does not list itself`);
});

test('localStamp: written in the time zone with its name, and blank values are n/a', () => {
  assert.equal(util.localStamp('2026-11-02T05:00:00Z', 'Africa/Kampala'), '2026-11-02 08:00 (Africa/Kampala)');
  assert.equal(util.localStamp(new Date('2026-11-02T21:30:00Z'), 'Africa/Kampala'), '2026-11-03 00:30 (Africa/Kampala)', 'the date rolls over with the zone');
  assert.equal(util.localStamp(null, 'Africa/Kampala'), 'n/a');
  assert.equal(util.localStamp('not a date', 'Africa/Kampala'), 'n/a');
});

test('two-step codes: matchStep names the 30-second step, so the same step can be refused a second time', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  const t = 1111111109000;
  const step = totp.matchStep(secret, '081804', t);
  assert.equal(step, Math.floor(t / 1000 / 30));
  assert.equal(totp.matchStep(secret, '081 804', t), step, 'spaces are ignored');
  assert.equal(totp.matchStep(secret, '000000', t), null);
  assert.equal(totp.matchStep(secret, 'abcdef', t), null);
  assert.equal(totp.matchStep(null, '081804', t), null);
  assert.equal(totp.matchStep(secret, totp.code(secret, t - 30000), t), step - 1, 'the previous step is still accepted, and reported as that step');
  assert.ok(totp.verify(secret, '081804', t));
});

test('two-step secrets are stored encrypted; an older plain secret is still readable', () => {
  const secret = totp.newSecret();
  const stored = twofactor.protect(secret);
  assert.ok(twofactor.isEncrypted(stored) && !stored.includes(secret));
  assert.equal(twofactor.reveal(stored), secret);
  assert.equal(twofactor.reveal(secret), secret, 'plain, from an earlier version');
  assert.equal(twofactor.isEncrypted(secret), false);
  assert.equal(twofactor.reveal(null), null);
  assert.equal(twofactor.reveal('v1:AAAA:BBBB:CCCC'), null, 'unreadable (another key) is null, not an error');
});

// 1.16.0: the search box
const search = require('../../src/lib/search');
test('search: short or empty text is not searched, wildcards in the text are harmless, a ticket reference is recognised', () => {
  assert.equal(search.term('a'), ''); assert.equal(search.term('   '), ''); assert.equal(search.term(undefined), '');
  assert.equal(search.term('  printer  '), 'printer');
  assert.equal(search.term('x'.repeat(300)).length, 100);
  assert.equal(search.like('50%_off\\'), '%50\\%\\_off\\\\%');
  assert.ok(search.looksLikeRef('INC-000123') && search.looksLikeRef('req-0042a'));
  assert.ok(!search.looksLikeRef('printer jammed') && !search.looksLikeRef('INC') && !search.looksLikeRef('a-b'));
});

test('search: customers never match on internal notes, staff do', () => {
  assert.ok(search.ticketClause(3).includes('not tc.internal'));
  assert.ok(!search.ticketClause(3, { internal: true }).includes('not tc.internal'));
  assert.ok(search.ticketClause(7).includes('$7') && !search.ticketClause(7).includes('$3'));
});

// 1.17.0: quotes
const quotes = require('../../src/services/quotes');
const navLib = require('../../src/lib/nav');
test('quotes: line amounts and totals are exact to the cent, with discounts and tax', () => {
  assert.equal(quotes.lineTotal(2, 4500, 10), 8100);
  assert.equal(quotes.lineTotal(3, 0.1), 0.3, 'no floating-point drift');
  assert.equal(quotes.lineTotal(12, 120000.5), 1440006);
  assert.equal(quotes.lineTotal(1, 99.99, 33.33), 66.66);
  const t = quotes.totals([{ quantity: 2, unit_price: 4500, discount_pct: 10 }, { quantity: 1, unit_price: 750, discount_pct: 0 }], 18);
  assert.deepEqual(t, { gross: 9750, discount: 900, subtotal: 8850, tax: 1593, total: 10443 });
  assert.deepEqual(quotes.totals([], 18), { gross: 0, discount: 0, subtotal: 0, tax: 0, total: 0 });
  assert.equal(quotes.totals([{ quantity: 1, unit_price: 0.05, discount_pct: 0 }], 18).tax, 0.01, 'tax is rounded to the cent');
});

test('quotes: the line form drops empty rows, accepts thousands separators and refuses bad numbers', () => {
  const rows = quotes.readLines({ description: ['A', '', 'B'], quantity: ['2', '', ''], unit: ['each', '', ''], unit_price: ['1,250.50', '', '10'], discount_pct: ['', '', '5'] });
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].quantity, rows[0].unit_price, rows[0].line_total], [2, 1250.5, 2501]);
  assert.deepEqual([rows[1].quantity, rows[1].discount_pct, rows[1].line_total], [1, 5, 9.5], 'a blank quantity is 1');
  assert.equal(quotes.readLines({ description: 'Single', quantity: '3', unit_price: '2' })[0].line_total, 6, 'one row arrives as plain values');
  assert.throws(() => quotes.readLines({ description: ['A'], quantity: ['0'], unit_price: ['1'] }), /quantity/);
  assert.throws(() => quotes.readLines({ description: ['A'], quantity: ['1'], unit_price: ['-5'] }), /unit price/);
  assert.throws(() => quotes.readLines({ description: ['A'], quantity: ['1'], unit_price: ['1'], discount_pct: ['101'] }), /discount/);
});

test('quotes: the allowed moves; a sent quote is changed by revising it; reference labels', () => {
  assert.deepEqual(quotes.MOVES.draft, ['sent', 'cancelled']);
  assert.ok(quotes.MOVES.sent.includes('accepted') && quotes.MOVES.sent.includes('rejected'));
  for (const s of ['accepted', 'rejected', 'cancelled', 'superseded']) assert.deepEqual(quotes.MOVES[s], [], `${s} is final`);
  assert.ok(!quotes.REVISABLE.includes('draft') && quotes.REVISABLE.includes('sent'));
  assert.equal(quotes.label({ ref: 'QUO-000012', revision: 1 }), 'QUO-000012');
  assert.equal(quotes.label({ ref: 'QUO-000012', revision: 3 }), 'QUO-000012 R3');
  assert.throws(() => quotes.readHeader({ title: 'x', customer_id: '1', currency: 'USD', issue_date: '2026-11-05', valid_until: '2026-11-01' }, { currencies: ['USD'] }), /before/);
  assert.throws(() => quotes.readHeader({ title: 'x', currency: 'USD' }, { currencies: ['USD'] }), /customer/);
});

test('quotes: in the menu for the commercial roles and finance, not for the service desk', () => {
  const has = (role) => navLib.build({ kind: 'staff', role }, { path: '/', query: {} }).flat().some((i) => i.href === '/quotes');
  for (const r of ['platform_admin', 'bd_manager', 'bid_manager', 'finance', 'management', 'contract_manager']) assert.ok(has(r), r);
  for (const r of ['agent', 'engineer', 'security_analyst', 'sde']) assert.ok(!has(r), r);
  assert.deepEqual(navLib.build({ kind: 'staff', role: 'bd_manager' }, { path: '/quotes/4', query: {} }).flat().filter((i) => i.on).map((i) => i.label), ['Quotes']);
});

// 1.18.0: requests without signing in
const guest = require('../../src/services/guest');
test('guest requests: customer e-mail domains are cleaned and checked; the address domain must match exactly', () => {
  assert.deepEqual(guest.parseDomains('@KCB.co.ug\nkcb.com, kcb.co.ug  mail.kcb.com.').domains, ['kcb.co.ug', 'kcb.com', 'mail.kcb.com']);
  assert.deepEqual(guest.parseDomains('').domains, []);
  assert.match(guest.parseDomains('kcb').error, /valid e-mail domain/);
  assert.match(guest.parseDomains('user@kcb.com').error, /valid e-mail domain/, 'a whole address is not a domain');
  assert.match(guest.parseDomains('-bad-.com').error, /valid e-mail domain/);
  assert.equal(guest.domainOf('Jane.Doe@KCB.co.ug'), 'kcb.co.ug');
  assert.equal(guest.domainOf('nobody'), '');
  assert.ok(guest.TICKETS_PER_SESSION > 0 && guest.MAX_TRIES === 5 && guest.CODE_MINUTES === 15);
});

// 1.19.0: formatted comments and the SLA card
const md = require('../../src/lib/markdown');
const slaView = require('../../src/lib/sla_view');
test('formatted text: underline and strike-through; e-mail gets plain text; nothing unsafe gets through', () => {
  assert.equal(md.render('++under++ and ~~gone~~ and **bold**'), '<p><u>under</u> and <s>gone</s> and <b>bold</b></p>');
  assert.equal(md.render('<script>alert(1)</script> ++<img src=x onerror=alert(1)>++'), '<p>&lt;script&gt;alert(1)&lt;/script&gt; <u>&lt;img src=x onerror=alert(1)&gt;</u></p>');
  assert.ok(!md.render('[x](javascript:alert(1))').includes('href'));
  assert.equal(md.toText('## Steps\n- **Restart** the ++router++\n- see [the guide](https://example.com/g)\n> quoted'), 'Steps\n- Restart the router\n- see the guide (https://example.com/g)\n  quoted');
});

test('SLA card: each target shows met, missed, breached, at risk, on track or paused, and the card takes the most urgent', () => {
  const now = new Date('2026-11-06T10:00:00Z');
  const h = (n) => new Date(now.getTime() + n * 3600000).toISOString();
  const base = { type: 'incident', status: 'in_progress', created_at: h(-10) };
  let v = slaView.view({ ...base, response_due: h(-9), responded_at: h(-9.5), restoration_due: h(5), resolution_due: h(20) }, now);
  assert.deepEqual(v.rows.map((r) => r.state), ['met', 'running', 'running']); assert.equal(v.state, 'running'); assert.match(v.headline, /on track/);
  v = slaView.view({ ...base, response_due: h(-9), responded_at: h(-8), restoration_due: h(0.5), resolution_due: h(20) }, now);
  assert.deepEqual(v.rows.map((r) => r.state), ['missed', 'risk', 'running']); assert.equal(v.state, 'missed');
  v = slaView.view({ ...base, response_due: h(-9), responded_at: h(-9.5), restoration_due: h(-2), resolution_due: h(20) }, now);
  assert.equal(v.state, 'breached'); assert.match(v.headline, /restoration is overdue by 2h 00m/);
  v = slaView.view({ ...base, created_at: h(-30), response_due: h(-29), responded_at: h(-29.5), restoration_due: h(3), resolution_due: h(40) }, now);
  assert.equal(v.rows[1].state, 'risk', 'less than a quarter of the time left');
  v = slaView.view({ ...base, response_due: h(-9), responded_at: h(-9.5), resolution_due: h(-1), paused_at: h(-3) }, now);
  assert.equal(v.rows[1].state, 'paused'); assert.equal(v.state, 'paused');
  v = slaView.view({ ...base, sla_breaches: { resolution: { due: h(-50), at: h(-40) } }, response_due: h(-9), responded_at: h(-9.5), resolution_due: h(30) }, now);
  assert.equal(v.rows[1].label, 'Missed earlier'); assert.equal(v.state, 'missed');
  v = slaView.view({ ...base, type: 'request', response_due: h(-9), responded_at: h(-9.5), restoration_due: h(1), resolution_due: h(9), resolved_at: h(-1) }, now);
  assert.equal(v.rows.length, 2, 'requests have no restoration target'); assert.equal(v.state, 'met');
  assert.equal(slaView.view({ ...base }, now).state, 'none');
  assert.equal(slaView.span(90 * 60000), '1h 30m'); assert.equal(slaView.span(26 * 3600000), '1d 2h'); assert.equal(slaView.span(20000), 'under a minute');
});

// 1.21.0: suppliers, contractors and purchase orders
const perms21 = require('../../src/lib/perms');
const Sup21 = require('../../src/services/suppliers');
const PO21 = require('../../src/services/purchase_orders');
test('procurement: the role and who may see or do what', () => {
  const as = (role) => ({ kind: 'staff', role });
  assert.ok(perms21.STAFF_ROLES.includes('procurement') && perms21.ROLE_LABELS.procurement === 'Procurement officer');
  assert.ok(perms21.can(as('procurement'), 'lpo.manage') && perms21.can(as('procurement'), 'supplier.manage') && perms21.can(as('procurement'), 'project.view') && perms21.can(as('procurement'), 'contract.view'));
  assert.ok(!perms21.can(as('procurement'), 'ticket.work') && !perms21.can(as('procurement'), 'user.manage'));
  for (const r of ['service_manager', 'finance', 'management', 'auditor']) assert.ok(perms21.can(as(r), 'lpo.view') && !perms21.can(as(r), 'lpo.manage'), r);
  for (const r of ['agent', 'security_analyst']) assert.ok(!perms21.can(as(r), 'supplier.view') && !perms21.can(as(r), 'lpo.view'), r);
  assert.ok(perms21.can(as('engineer'), 'supplier.view') && !perms21.can(as('engineer'), 'supplier.manage'), 'project team members see the contractors on their projects');
});

test('procurement: supplier form and order form checks; the order lifecycle', () => {
  assert.throws(() => Sup21.readFields({ name: '' }), /name/);
  assert.throws(() => Sup21.readFields({ name: 'A', email: 'nope' }), /e-mail/);
  assert.throws(() => Sup21.readFields({ name: 'A', website: 'not a site' }), /website/);
  const f = Sup21.readFields({ name: ' Acme ', kind: 'weird', status: 'odd', email: 'Sales@Acme.co.ug', website: 'acme.co.ug' });
  assert.deepEqual([f.name, f.kind, f.status, f.email], ['Acme', 'contractor', 'active', 'sales@acme.co.ug']);
  const opts = { currencies: ['UGX', 'USD'] };
  assert.throws(() => PO21.readHeader({ title: '', supplier_id: '1', currency: 'UGX' }, opts), /what the order is for/);
  assert.throws(() => PO21.readHeader({ title: 'x', currency: 'UGX' }, opts), /supplier/);
  assert.throws(() => PO21.readHeader({ title: 'x', supplier_id: '1', currency: 'EUR' }, opts), /currencies/);
  assert.throws(() => PO21.readHeader({ title: 'x', supplier_id: '1', currency: 'UGX', issue_date: '2026-11-10', delivery_date: '2026-11-01' }, opts), /delivery date/);
  assert.deepEqual(PO21.MOVES.draft, ['issued', 'cancelled']);
  assert.deepEqual(PO21.MOVES.issued, ['received', 'cancelled']);
  assert.deepEqual(PO21.MOVES.closed, []); assert.deepEqual(PO21.MOVES.cancelled, []);
});

// 1.21.1: documents take the colours of the person's theme
const DT = require('../../src/lib/doc_theme');
const pdfLib = require('../../src/lib/pdf');
const xlsxLib = require('../../src/lib/xlsx');
test("documents: PDF and Excel colours follow the person's theme", () => {
  assert.deepEqual(Object.keys(DT.PALETTES).sort(), ['auto', 'default', 'green', 'ocean', 'sunset']);
  assert.equal(DT.palette({ theme: 'ocean' }).bar, '#0b66b8');
  assert.equal(DT.palette({ theme: null }), DT.PALETTES.default, 'no choice = Default');
  assert.equal(DT.palette({ theme: 'midnight' }), DT.PALETTES.default, 'a removed theme falls back to Default');
  assert.deepEqual(DT.palette('auto'), DT.PALETTES.green, 'Match Device prints in its daytime colours');
  assert.equal(DT.pdfRgb('#0b66b8'), '0.043 0.400 0.722');
  assert.equal(DT.argb('#c2570c'), 'FFC2570C');
  const zlib = require('zlib');
  const content = (buf) => { let o = ''; for (const m of buf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)) { try { o += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (_) { o += m[1]; } } return o; };
  const p = content(pdfLib.document({ title: 'T', palette: DT.palette('sunset'), blocks: [{ type: 'table', columns: [{ header: 'A', key: 'a' }], rows: [{ a: '1' }] }] }));
  assert.ok(p.includes(`${DT.pdfRgb('#c2570c')} rg`), 'the title bar and table header are in the sunset colour');
  assert.ok(!p.includes(DT.pdfRgb('#0b7a1f')), 'and not in green');
  const x = xlsxLib.workbook([{ name: 'R', title: 'R', columns: [{ header: 'A', key: 'a' }], rows: [{ a: 1 }] }], { palette: DT.palette('ocean') });
  assert.ok(x.length > 100);
});
