'use strict';
// Integration tests: need PostgreSQL (the installer creates a throw-away database `itsm_test` for them).
const test = require('node:test');
const assert = require('node:assert/strict');
const { q, pool, tx } = require('../../src/db');
const migrate = require('../../scripts/migrate');
const password = require('../../src/lib/password');
const tickets = require('../../src/services/tickets');
const notifications = require('../../src/services/notifications');
const inbound = require('../../src/services/inbound');
const contractsSvc = require('../../src/services/contracts');
const pipelineSvc = require('../../src/services/pipeline');
const watch = require('../../src/services/watch');
const engineers = require('../../src/services/engineers');
const createApp = require('../../src/app');

const PW = 'Correct-horse-battery-9';
const ctx = {};
let server; let base;

// ---------------------------------------------------------------- tiny HTTP client with a cookie jar
class Client {
  constructor() { this.jar = {}; this.token = null; }
  cookie() { return Object.values(this.jar).join('; '); }
  async req(method, path, form, extraHeaders = {}) {
    const headers = { ...extraHeaders };
    if (this.cookie()) headers.cookie = this.cookie();
    let body;
    if (form) {
      headers['content-type'] = 'application/x-www-form-urlencoded';
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(form)) for (const x of [].concat(v)) params.append(k, x);   // an array is a repeated field, like ticked boxes
      body = params.toString();
    }
    const r = await fetch(base + path, { method, headers, body, redirect: 'manual' });
    for (const c of r.headers.getSetCookie()) { const kv = c.split(';')[0]; this.jar[kv.split('=')[0]] = kv; }
    return { status: r.status, text: await r.text(), location: r.headers.get('location') };
  }
  async csrf(path) { const r = await this.req('GET', path); const m = /name="_csrf" value="([^"]+)"/.exec(r.text); assert.ok(m, 'no csrf token on ' + path); return m[1]; }
  async login(email, pw = PW) {
    const t = await this.csrf('/login');
    const r = await this.req('POST', '/login', { _csrf: t, email, password: pw, next: '' });
    if (r.status === 302) this.token = await this.csrf('/account');
    return r;
  }
  get(path) { return this.req('GET', path); }
  post(path, form) { return this.req('POST', path, { _csrf: this.token, ...form }); }
}

async function mkUser(email, name, kind, role, customerId = null) {
  return (await q(`insert into users (email, name, kind, role, customer_id, password_hash) values ($1,$2,$3,$4,$5,$6) returning *`,
    [email, name, kind, role, customerId, await password.hash(PW)])).rows[0];
}
async function mkCustomer(name, code) {
  const c = (await q('insert into customers (name, code) values ($1,$2) returning *', [name, code])).rows[0];
  const n = (await q("select nextval('csid_seq') as n")).rows[0].n;
  const cs = (await q('insert into csids (csid, customer_id, description) values ($1,$2,$3) returning *', [`CS-T${String(n).padStart(5, '0')}`, c.id, 'test'])).rows[0];
  const sv = (await q(`insert into services (csid_id, customer_id, service_type, name) values ($1,$2,'Server support',$3) returning *`, [cs.id, c.id, `${name} servers`])).rows[0];
  return { c, cs, sv };
}
async function mk(input) { return tx((db) => tickets.createTicket(db, { source: 'agent', impact: 2, urgency: 2, ...input })); }
const staffActor = (u) => ({ ...u, kind: 'staff' });

test.before(async () => {
  await migrate();
  const A = await mkCustomer('Alpha Bank', 'ALPHA'); const B = await mkCustomer('Beta Telecom', 'BETA');
  Object.assign(ctx, { A, B });
  ctx.agent = await mkUser('agent@t.local', 'Agent', 'staff', 'agent');
  ctx.eng = await mkUser('eng@t.local', 'Engineer', 'staff', 'engineer');
  ctx.backup = await mkUser('backup@t.local', 'Backup', 'staff', 'engineer');
  ctx.manager = await mkUser('manager@t.local', 'Manager', 'staff', 'service_manager');
  ctx.soc = await mkUser('soc@t.local', 'SOC', 'staff', 'security_analyst');
  ctx.admin = await mkUser('admin@t.local', 'Admin', 'staff', 'platform_admin');
  ctx.aUser = await mkUser('user@alpha.test', 'Alpha User', 'customer', 'customer_user', A.c.id);
  ctx.aAdmin = await mkUser('admin@alpha.test', 'Alpha Admin', 'customer', 'customer_admin', A.c.id);
  ctx.bUser = await mkUser('user@beta.test', 'Beta User', 'customer', 'customer_user', B.c.id);
  ctx.policy = (await q(`select id from sla_policies where name = 'Standard 8x5'`)).rows[0].id;
  await q(`update services set sla_policy_id = $1 where id = any($2)`, [ctx.policy, [A.sv.id, B.sv.id]]);
  await tx((db) => engineers.assignEngineer(db, { entity: 'service', entityId: A.sv.id, engineerId: ctx.eng.id, backupId: ctx.backup.id, reason: 'test', actor: staffActor(ctx.admin) }));
  const app = createApp();
  await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

// ---------------------------------------------------------------- database rules
test('the database refuses a service that belongs to another customer', async () => {
  await assert.rejects(
    q(`insert into tickets (ref, type, customer_id, csid_id, service_id, subject, priority, source, requester_id)
       values ('INC-X00001','incident',$1,$2,$3,'bad',3,'agent',$4)`, [ctx.A.c.id, ctx.A.cs.id, ctx.B.sv.id, ctx.aUser.id]),
    (e) => e.code === '23503');
});

test('createTicket validates CSID / service / customer relationships', async () => {
  await assert.rejects(mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.B.sv.id, subject: 'x', requester: { id: ctx.aUser.id, email: 'user@alpha.test', name: 'u' } }), tickets.UserError);
  await assert.rejects(mk({ customerId: ctx.A.c.id, csidId: ctx.B.cs.id, subject: 'x', requester: { id: ctx.aUser.id, email: 'user@alpha.test', name: 'u' } }), tickets.UserError);
  await assert.rejects(mk({ customerId: ctx.A.c.id, serviceId: ctx.A.sv.id, subject: 'x', requester: { id: ctx.aUser.id, email: 'user@alpha.test', name: 'u' } }), /CSID/);
});

// ---------------------------------------------------------------- execution engineer routing
test('a new ticket notifies the execution engineer with the required details', async () => {
  const t = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'Server down', impact: 1, urgency: 1, requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'Alpha User' } });
  assert.equal(t.exec_engineer_id, ctx.eng.id);
  assert.equal(t.assignee_id, ctx.eng.id);
  assert.equal(t.priority, 1);
  assert.ok(t.response_due && t.resolution_due && t.restoration_due);
  const n = (await q(`select * from notifications where ticket_id = $1 and kind = 'engineer_new_ticket'`, [t.id])).rows;
  assert.equal(n.length, 1);
  assert.equal(n[0].recipient_email, 'eng@t.local');
  for (const part of [t.ref, 'Alpha Bank', 'Server down', 'P1 Critical', 'Response due', '/tickets/' + t.ref]) assert.ok(n[0].body.includes(part) || n[0].subject.includes(part), `missing ${part}`);
});

test('an unavailable engineer falls back to the backup and supervisors are told', async () => {
  await q('update users set available = false where id = $1', [ctx.eng.id]);
  const t = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'Backup case', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  assert.equal(t.exec_engineer_id, ctx.backup.id);
  const sup = (await q(`select recipient_email from notifications where ticket_id = $1 and kind = 'engineer_routing'`, [t.id])).rows.map((r) => r.recipient_email);
  assert.ok(sup.includes('manager@t.local'));
  await q('update users set available = false where id = $1', [ctx.backup.id]);
  const t2 = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'Nobody case', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  assert.equal(t2.exec_engineer_id, null);
  assert.ok((await q(`select 1 from notifications where ticket_id = $1 and kind = 'engineer_routing'`, [t2.id])).rows.length >= 1);
  await q('update users set available = true where id = any($1)', [[ctx.eng.id, ctx.backup.id]]);
});

test('engineer reassignment keeps history and is audited', async () => {
  await tx((db) => engineers.assignEngineer(db, { entity: 'service', entityId: ctx.A.sv.id, engineerId: ctx.backup.id, backupId: ctx.eng.id, reason: 'rota change', actor: staffActor(ctx.manager) }));
  const h = await engineers.history({ query: q }, 'service', ctx.A.sv.id);
  assert.ok(h.length >= 2);
  assert.equal(h[0].engineer_id, ctx.backup.id);
  assert.equal(h[0].reason, 'rota change');
  assert.ok((await q(`select 1 from audit_log where action = 'engineer_assigned' and detail like '%rota change%'`)).rows.length);
  await assert.rejects(tx((db) => engineers.assignEngineer(db, { entity: 'service', entityId: ctx.A.sv.id, engineerId: ctx.eng.id, reason: '', actor: staffActor(ctx.manager) })), tickets.UserError);
  await tx((db) => engineers.assignEngineer(db, { entity: 'service', entityId: ctx.A.sv.id, engineerId: ctx.eng.id, backupId: ctx.backup.id, reason: 'restore', actor: staffActor(ctx.manager) }));
});

test('restricted tickets are not described in e-mail to engineers without Security access', async () => {
  const t = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'Ransomware suspected', queue: 'security', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  const n = (await q(`select * from notifications where ticket_id = $1 and kind = 'engineer_new_ticket'`, [t.id])).rows[0];
  assert.ok(n);
  assert.ok(!n.body.includes('Ransomware') && !n.subject.includes('Ransomware'));
});

// ---------------------------------------------------------------- SLA lifecycle
test('SLA clock pauses while waiting for the customer and resumes afterwards', async () => {
  const t = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'Pause test', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  const agent = staffActor(ctx.agent);
  const paused = await tx((db) => tickets.setStatus(db, t, 'pending_customer', agent));
  assert.ok(paused.paused_at);
  assert.ok(paused.sla_remaining && paused.sla_remaining.resolution > 0);
  const resumed = await tx((db) => tickets.setStatus(db, paused, 'in_progress', agent));
  assert.equal(resumed.paused_at, null);
  assert.ok(Math.abs(new Date(resumed.resolution_due) - new Date(t.resolution_due)) < 3 * 60000);
});

test('resolving an incident needs a resolution code; customers cannot reopen after the window', async () => {
  const t = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'Resolve test', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  const agent = staffActor(ctx.agent);
  await assert.rejects(tx((db) => tickets.setStatus(db, t, 'resolved', agent)), tickets.UserError);
  const r = await tx((db) => tickets.setStatus(db, t, 'resolved', agent, { resolutionCode: 'fixed', resolutionNote: 'rebooted' }));
  assert.equal(r.status, 'resolved'); assert.ok(r.resolved_at && r.restored_at);
  assert.ok((await q(`select 1 from notifications where ticket_id = $1 and kind = 'ticket_update'`, [t.id])).rows.length);
  await q(`update tickets set resolved_at = now() - interval '10 days' where id = $1`, [t.id]);
  const old = await tickets.summary({ query: q }, t.id);
  await assert.rejects(tx((db) => tickets.setStatus(db, old, 'open', { ...ctx.aUser, kind: 'customer' })), /more than/);
  const again = await tx((db) => tickets.setStatus(db, old, 'open', agent));
  assert.equal(again.status, 'open');
});

test('SLA watch flags breaches once, escalates and alerts supervisors', async () => {
  const t = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'Breach test', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  await q(`update tickets set response_due = now() - interval '1 hour' where id = $1`, [t.id]);
  await watch.slaWatch({ query: q });
  await watch.slaWatch({ query: q });
  const after = await tickets.summary({ query: q }, t.id);
  assert.equal(after.sla_flags.response_breached, true);
  assert.equal(after.tier, 'l2');
  const n = (await q(`select * from notifications where ticket_id = $1 and kind = 'sla_breach'`, [t.id])).rows;
  assert.ok(n.length >= 1);
  assert.equal(new Set(n.map((x) => x.dedupe_key)).size, n.length);
});

test('resolved tickets are closed automatically', async () => {
  const t = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'Autoclose', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  await tx((db) => tickets.setStatus(db, t, 'resolved', staffActor(ctx.agent), { resolutionCode: 'fixed' }));
  await q(`update tickets set resolved_at = now() - interval '5 days' where id = $1`, [t.id]);
  await watch.autoClose({ query: q });
  assert.equal((await tickets.summary({ query: q }, t.id)).status, 'closed');
});

test('the outbox sends queued mail and records the result', async () => {
  const before = (await q(`select count(*)::int as n from notifications where status = 'pending'`)).rows[0].n;
  assert.ok(before > 0);
  await notifications.processDue({ query: q }, 500);
  const left = (await q(`select count(*)::int as n from notifications where status = 'pending' and next_attempt_at <= now()`)).rows[0].n;
  assert.equal(left, 0);
  assert.ok((await q(`select count(*)::int as n from notifications where status = 'sent' and sent_at is not null`)).rows[0].n > 0);
});

// ---------------------------------------------------------------- HTTP: authentication and isolation
test('CSRF protection and multipart restrictions', async () => {
  const c = new Client();
  assert.equal((await c.req('POST', '/login', { email: 'a@b.c', password: 'x' })).status, 403);
  const fd = new FormData(); fd.append('x', '1');
  const r = await fetch(base + '/logout', { method: 'POST', body: fd });
  assert.equal(r.status, 400);
});

test('login lockout after repeated failures', async () => {
  const u = await mkUser('lock@t.local', 'Lock', 'staff', 'agent');
  const c = new Client();
  for (let i = 0; i < 5; i++) assert.equal((await c.login(u.email, 'wrong-password-123')).status, 401);
  const r = await c.login(u.email, PW);
  assert.equal(r.status, 401);
  assert.match(r.text, /locked/i);
});

test('platform administrators are sent to set up two-step verification', async () => {
  const c = new Client();
  assert.equal((await c.login(ctx.admin.email)).status, 302);
  const r = await c.get('/tickets');
  assert.equal(r.status, 302); assert.equal(r.location, '/account/mfa');
});

test('customers see only their own tickets and cannot guess other references', async () => {
  const mine = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'ALPHA-USER-TICKET', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  const colleague = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'ALPHA-ADMIN-TICKET', requester: { id: ctx.aAdmin.id, email: ctx.aAdmin.email, name: 'x' } });
  const other = await mk({ customerId: ctx.B.c.id, csidId: ctx.B.cs.id, serviceId: ctx.B.sv.id, subject: 'BETA-SECRET-TICKET', requester: { id: ctx.bUser.id, email: ctx.bUser.email, name: 'x' } });
  await q(`insert into ticket_comments (ticket_id, author_id, body, internal, source) values ($1,$2,'INTERNAL-ONLY-NOTE',true,'agent')`, [mine.id, ctx.agent.id]);
  await q(`insert into attachments (ticket_id, customer_id, filename, size_bytes, sha256, storage_name) values ($1,$2,'secret.txt',1,'x',$3) returning id`, [other.id, ctx.B.c.id, 'a'.repeat(48)]);
  const attId = (await q(`select id from attachments where ticket_id = $1`, [other.id])).rows[0].id;

  const u = new Client(); await u.login(ctx.aUser.email);
  let r = await u.get('/portal/tickets');
  assert.ok(r.text.includes('ALPHA-USER-TICKET')); assert.ok(!r.text.includes('ALPHA-ADMIN-TICKET')); assert.ok(!r.text.includes('BETA-SECRET'));
  assert.equal((await u.get(`/portal/tickets/${mine.ref}`)).status, 200);
  assert.ok(!(await u.get(`/portal/tickets/${mine.ref}`)).text.includes('INTERNAL-ONLY-NOTE'));
  assert.equal((await u.get(`/portal/tickets/${colleague.ref}`)).status, 404);
  assert.equal((await u.get(`/portal/tickets/${other.ref}`)).status, 404);
  assert.equal((await u.get(`/attachments/${attId}`)).status, 404);
  assert.equal((await u.get('/tickets')).status, 302);               // staff area redirects customers
  assert.equal((await u.get('/customers')).location, '/portal');
  r = await u.post(`/portal/tickets/${other.ref}/comment`, { body: 'sneaky' });
  assert.equal(r.status, 404);
  assert.equal((await q('select count(*)::int as n from ticket_comments where ticket_id = $1', [other.id])).rows[0].n, 0);

  const a = new Client(); await a.login(ctx.aAdmin.email);
  r = await a.get('/portal/tickets');
  assert.ok(r.text.includes('ALPHA-USER-TICKET') && r.text.includes('ALPHA-ADMIN-TICKET')); assert.ok(!r.text.includes('BETA-SECRET'));
  assert.equal((await a.get('/portal/users')).status, 200);
  assert.equal((await u.get('/portal/users')).status, 403);
});

test('customer admin cannot manage users of another customer', async () => {
  const a = new Client(); await a.login(ctx.aAdmin.email);
  const r = await a.post(`/portal/users/${ctx.bUser.id}/toggle`, {});
  assert.equal(r.status, 404);
  assert.equal((await q('select active from users where id = $1', [ctx.bUser.id])).rows[0].active, true);
});

test('the Security queue is invisible to staff without Security access', async () => {
  const t = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'SEC-RESTRICTED-SUBJECT', queue: 'security', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  const agent = new Client(); await agent.login(ctx.agent.email);
  assert.equal((await agent.get(`/tickets/${t.ref}`)).status, 404);
  assert.ok(!(await agent.get('/tickets?view=all')).text.includes('SEC-RESTRICTED-SUBJECT'));
  const soc = new Client(); await soc.login(ctx.soc.email);
  assert.equal((await soc.get(`/tickets/${t.ref}`)).status, 200);
  assert.ok((await q(`select 1 from audit_log where action = 'security_ticket_viewed' and entity_id = $1`, [t.ref])).rows.length);
  const r = await agent.post(`/tickets/${t.ref}/comment`, { body: 'nope' });
  assert.equal(r.status, 404);
});

test('role limits: agents cannot administer; staff actions are recorded', async () => {
  const agent = new Client(); await agent.login(ctx.agent.email);
  assert.equal((await agent.get('/admin/users')).status, 403);
  assert.equal((await agent.get('/admin/settings')).status, 403);
  assert.equal((await agent.get('/audit')).status, 403);
  assert.equal((await agent.post(`/services/${ctx.A.sv.id}/engineer`, { engineer_id: ctx.eng.id, reason: 'x' })).status, 403);
  const t = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'Role test', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  const r = await agent.post(`/tickets/${t.ref}/status`, { status: 'in_progress' });
  assert.equal(r.status, 302);
  assert.equal((await tickets.summary({ query: q }, t.id)).status, 'in_progress');
});

test('disabling a user ends their session immediately', async () => {
  const u = await mkUser('temp@t.local', 'Temp', 'staff', 'agent');
  const c = new Client(); await c.login(u.email);
  assert.equal((await c.get('/tickets')).status, 200);
  await q('update users set active = false where id = $1', [u.id]);
  assert.equal((await c.get('/tickets')).status, 302);
});

test('a suspended customer cannot sign in', async () => {
  const S = await mkCustomer('Gamma Ltd', 'GAMMA');
  const u = await mkUser('user@gamma.test', 'G', 'customer', 'customer_user', S.c.id);
  await q(`update customers set status = 'suspended' where id = $1`, [S.c.id]);
  const c = new Client();
  assert.equal((await c.login(u.email)).status, 401);
});

// ---------------------------------------------------------------- e-mail channel
const eml = ({ from, to = 'itservices@example.com', subject, body = 'Hello', headers = {}, id }) => Buffer.from([
  `From: ${from}`, `To: ${to}`, `Subject: ${subject}`, `Message-ID: <${id}@test>`, 'Date: Sat, 31 Oct 2026 10:00:00 +0300', 'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8', ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`), '', body].join('\r\n'));
const mailbox = async (key) => (await q('select * from mailboxes where key = $1', [key])).rows[0];

test('e-mail from a registered contact creates a linked ticket and an acknowledgement', async () => {
  const mb = await mailbox('services');
  const r = await inbound.ingest(mb, eml({ from: `Alpha User <${ctx.aUser.email}>`, subject: 'Printer jammed', body: 'Please help', id: 'm1' }));
  assert.equal(r.outcome, 'ticket_created');
  const t = await tickets.summary({ query: q }, r.ticketId);
  assert.equal(t.customer_id, ctx.A.c.id); assert.equal(t.csid_id, ctx.A.cs.id); assert.equal(t.service_id, ctx.A.sv.id);
  assert.equal(t.queue, 'it_services'); assert.equal(t.category, 'IT Services'); assert.equal(t.source, 'email');
  assert.equal(t.exec_engineer_id, ctx.eng.id);
  const ack = (await q(`select * from notifications where ticket_id = $1 and kind = 'email_ack'`, [t.id])).rows[0];
  assert.ok(ack && ack.subject.includes(t.ref) && ack.reply_to === mb.address || (ack && ack.subject.includes(t.ref)));
  ctx.emailTicket = t;
});

test('a reply is appended to the ticket and the same message never creates a duplicate', async () => {
  const mb = await mailbox('services'); const t = ctx.emailTicket;
  const reply = eml({ from: ctx.aUser.email, subject: `Re: [${t.ref}] Printer jammed`, body: 'It is still jammed.\n\nOn Mon, X wrote:\n> old text', id: 'm2' });
  const r = await inbound.ingest(mb, reply);
  assert.equal(r.outcome, 'reply_appended'); assert.equal(r.ticketId, t.id);
  const c = (await q(`select * from ticket_comments where ticket_id = $1 and source = 'email'`, [t.id])).rows;
  assert.equal(c.length, 1); assert.ok(!c[0].body.includes('old text'));
  const before = (await q('select count(*)::int as n from tickets')).rows[0].n;
  assert.deepEqual(await inbound.ingest(mb, reply), { duplicate: true });
  assert.equal((await q('select count(*)::int as n from tickets')).rows[0].n, before);
});

test('replies match on thread headers as well as on the subject', async () => {
  const mb = await mailbox('services'); const t = ctx.emailTicket;
  const out = (await q(`select message_id from notifications where ticket_id = $1 and message_id is not null limit 1`, [t.id])).rows[0];
  const r = await inbound.ingest(mb, eml({ from: ctx.aUser.email, subject: 'Totally different subject', body: 'threaded', id: 'm3', headers: { 'In-Reply-To': out.message_id } }));
  assert.equal(r.outcome, 'reply_appended'); assert.equal(r.ticketId, t.id);
});

test('unknown senders go to the verification queue and are not linked to a customer', async () => {
  const mb = await mailbox('services');
  const r = await inbound.ingest(mb, eml({ from: 'Stranger <stranger@nowhere.example>', subject: 'Need a quote', id: 'm4' }));
  assert.equal(r.outcome, 'verification');
  const t = await tickets.summary({ query: q }, r.ticketId);
  assert.equal(t.customer_id, null); assert.equal(t.needs_verification, true); assert.equal(t.exec_engineer_id, null);
  assert.ok((await q(`select 1 from notifications where ticket_id = $1 and kind = 'verification_needed'`, [t.id])).rows.length);
  const agent = new Client(); await agent.login(ctx.agent.email);
  assert.ok((await agent.get('/verification')).text.includes(t.ref));
  const cust = new Client(); await cust.login(ctx.aUser.email);
  assert.equal((await cust.get(`/portal/tickets/${t.ref}`)).status, 404);
  const v = await tx((db) => tickets.verifyTicket(db, t, { customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, requesterId: ctx.aUser.id }, staffActor(ctx.agent)));
  assert.equal(v.needs_verification, false); assert.equal(v.customer_id, ctx.A.c.id); assert.equal(v.exec_engineer_id, ctx.eng.id);
});

test('automatic replies and failed sender checks are not trusted', async () => {
  const mb = await mailbox('services');
  const auto = await inbound.ingest(mb, eml({ from: ctx.aUser.email, subject: 'Out of office', id: 'm5', headers: { 'Auto-Submitted': 'auto-replied' } }));
  assert.equal(auto.outcome, 'ignored');
  const spoof = await inbound.ingest(mb, eml({ from: ctx.aUser.email, subject: 'Urgent wire request', id: 'm6', headers: { 'Authentication-Results': 'mx.example; spf=fail; dkim=fail' } }));
  assert.equal(spoof.outcome, 'verification');
  assert.equal((await tickets.summary({ query: q }, spoof.ticketId)).customer_id, null);
  const noReply = await inbound.ingest(mb, eml({ from: 'noreply@vendor.example', subject: 'Newsletter', id: 'm7' }));
  assert.equal(noReply.outcome, 'ignored');
});

test('a sender from another customer cannot write to a ticket by guessing its reference', async () => {
  const mb = await mailbox('services'); const t = ctx.emailTicket;
  const r = await inbound.ingest(mb, eml({ from: ctx.bUser.email, subject: `Re: [${t.ref}] hi`, body: 'injected', id: 'm8' }));
  assert.equal(r.outcome, 'ticket_created');
  assert.notEqual(r.ticketId, t.id);
  assert.equal((await q(`select count(*)::int as n from ticket_comments where ticket_id = $1 and body like '%injected%'`, [t.id])).rows[0].n, 0);
});

test('the Security mailbox routes to the Security queue with its own category', async () => {
  const mb = await mailbox('security');
  const r = await inbound.ingest(mb, eml({ from: ctx.aUser.email, to: mb.address, subject: 'Phishing e-mail received', id: 'm9' }));
  const t = await tickets.summary({ query: q }, r.ticketId);
  assert.equal(t.queue, 'security'); assert.equal(t.category, 'Security'); assert.equal(t.priority, mb.default_priority);
  const agent = new Client(); await agent.login(ctx.agent.email);
  assert.equal((await agent.get(`/tickets/${t.ref}`)).status, 404);
});

test('acknowledgements are rate limited per sender (loop protection)', async () => {
  const mb = await mailbox('services');
  for (let i = 0; i < 6; i++) await inbound.ingest(mb, eml({ from: 'flood@example.org', subject: `Flood ${i}`, id: `f${i}` }));
  const n = (await q(`select count(*)::int as n from notifications where kind = 'email_ack' and recipient_email = 'flood@example.org'`)).rows[0].n;
  assert.ok(n <= 3, `sent ${n} acknowledgements`);
});

// ---------------------------------------------------------------- contracts: schedule
test('contract status follows the dates, reminders are sent once, and the reminder can be resent', async () => {
  const mkc = async (title, endOffset) => (await q(
    `insert into contracts (customer_id, title, type, start_date, end_date, owner_id, created_by, status) values ($1,$2,'SLA', current_date - 400, current_date + $3::int, $4, $4, 'active') returning id`,
    [ctx.A.c.id, title, endOffset, ctx.manager.id])).rows[0].id;
  const soon = await mkc('Firewall support', 25); const gone = await mkc('Old support', -3); const far = await mkc('Long contract', 400);
  await contractsSvc.runSchedule({ query: q });
  const st = async (id) => (await q('select status from contracts where id = $1', [id])).rows[0].status;
  assert.equal(await st(soon), 'expiring_soon'); assert.equal(await st(gone), 'expired'); assert.equal(await st(far), 'active');
  const count = async (id) => (await q(`select count(*)::int as n from notifications where contract_id = $1 and kind = 'contract_reminder'`, [id])).rows[0].n;
  const first = await count(soon);
  assert.ok(first >= 1, 'the owner is reminded');
  await contractsSvc.runSchedule({ query: q });
  assert.equal(await count(soon), first, 'the same reminder is not queued twice');
  assert.equal(await count(far), 0);
  const m = new Client(); await m.login(ctx.manager.email);
  assert.equal((await m.post(`/contracts/${soon}/resend`, {})).status, 302);
  assert.ok(await count(soon) > first);
});

// ---------------------------------------------------------------- Active Directory (the directory itself is replaced by a stub)
const ldapLib = require('../../src/lib/ldap');
const directory = require('../../src/services/directory');
const settingsLib = require('../../src/lib/settings');

const SVC_PW = 'Svc-secret-pw-9';
async function withDirectory(fn) {
  const saved = { authenticate: ldapLib.authenticate, recheck: ldapLib.recheck, searchUsers: ldapLib.searchUsers, testConnection: ldapLib.testConnection };
  const r = await directory.saveConfig({ query: q }, { enabled: 'on', server: 'dc.test', domain: 't.test', service_user: 'svc', password: SVC_PW });
  assert.ok(r.config, r.error);
  try { await fn(); } finally {
    Object.assign(ldapLib, saved);
    await settingsLib.set({ query: q }, 'ldap', { ...(await settingsLib.get({ query: q }, 'ldap', {})), enabled: false });
  }
}
const dirUser = (email, name = 'New Hire', dn = 'CN=New Hire,DC=t') => ({ dn, email, name, login: email.split('@')[0], disabled: false });
const importRow = async (email) => (await q('select * from users where lower(email) = $1', [email])).rows[0];

test('Active Directory settings: saved from User management, the password is stored encrypted and never shown again', async () => {
  await asAdmin(async (a) => {
    let page = await a.get('/admin/users');
    assert.equal(page.status, 200); assert.ok(page.text.includes('Active Directory'));
    // switching on without a password is refused with a plain message
    let r = await a.post('/admin/users/directory', { enabled: 'on', server: 'dc.test', domain: 't.test', service_user: 'svc' });
    assert.equal(r.status, 400); assert.match(r.text, /password/i);
    r = await a.post('/admin/users/directory', { enabled: 'on', server: 'ldaps://dc.test:636', domain: 'T.Test', service_user: 'svc', password: SVC_PW });
    assert.equal(r.status, 302); assert.match(r.location, /\/admin\/users/);
    const saved = (await settingsLib.get({ query: q }, 'ldap', null));
    assert.equal(saved.server, 'dc.test'); assert.equal(saved.domain, 't.test'); assert.equal(saved.enabled, true);
    assert.ok(saved.password_enc && !JSON.stringify(saved).includes(SVC_PW), 'the password is not stored in the clear');
    page = await a.get('/admin/users');
    assert.ok(!page.text.includes(SVC_PW), 'the password is never sent back to the browser');
    // a blank password keeps the saved one; the settings can be saved again
    r = await a.post('/admin/users/directory', { enabled: 'on', server: 'dc.test', domain: 't.test', service_user: 'svc', password: '' });
    assert.equal(r.status, 302);
    assert.equal((await settingsLib.get({ query: q }, 'ldap', null)).password_enc, saved.password_enc);
    assert.equal(directory.bindPassword(await directory.loadConfig({ query: q })), SVC_PW);
    // test connection
    const was = ldapLib.testConnection;
    ldapLib.testConnection = async () => ({ ok: true, people: 14, more: false });
    r = await a.post('/admin/users/directory/test', {}); assert.equal(r.status, 302);
    assert.match((await a.get('/admin/users')).text, /Connected to dc\.test/);
    ldapLib.testConnection = async () => { throw new Error('connect ECONNREFUSED'); };
    await a.post('/admin/users/directory/test', {});
    assert.match((await a.get('/admin/users')).text, /Could not connect/);
    ldapLib.testConnection = was;
    // switch off
    r = await a.post('/admin/users/directory', { server: 'dc.test', domain: 't.test', service_user: 'svc' });
    assert.equal(r.status, 302);
    assert.equal((await directory.loadConfig({ query: q })).enabled, false);
  });
  // only an administrator may change or test it
  const m = new Client(); await m.login(ctx.manager.email);
  assert.equal((await m.post('/admin/users/directory', { enabled: 'on', server: 'x', domain: 'y.z', service_user: 'a', password: 'b' })).status, 403);
  assert.equal((await m.get('/admin/users/import')).status, 403);
});

test('Active Directory import: search, tick, choose one role; the details come from the directory; repeats are skipped', async () => {
  await withDirectory(async () => {
    const hire = dirUser('newhire@corp.test'); const second = dirUser('second@corp.test', 'Second Person', 'CN=Second,DC=t');
    ldapLib.searchUsers = async (cfg, pw, term) => { assert.equal(pw, SVC_PW); return { tooMany: false, users: [hire, second, { ...dirUser('off@corp.test', 'Off Person', 'CN=Off,DC=t'), disabled: true }, dirUser(ctx.admin.email, 'Admin Twin', 'CN=Twin,DC=t')] }; };
    ldapLib.recheck = async (cfg, pw, dns) => dns.map((dn) => {
      const u = [hire, second].find((x) => x.dn === dn);
      return u ? { dn, state: 'ok', user: u } : { dn, state: 'gone', user: null };
    });
    await asAdmin(async (a) => {
      const page = await a.get('/admin/users/import?go=1');
      assert.equal(page.status, 200);
      for (const t of ['New Hire', 'Second Person', 'Off Person']) assert.ok(page.text.includes(t), `the search result lacks ${t}`);
      assert.ok(page.text.includes('local account') || page.text.includes('Local account'), 'a person who already has a local account is marked');
      // nothing ticked, no role, nobody chosen
      assert.equal((await a.post('/admin/users/import', { role: 'agent' })).status, 400);
      assert.equal((await a.post('/admin/users/import', { dn: hire.dn, role: 'platform_owner' })).status, 400);
      assert.equal((await a.post('/admin/users/import', { dn: hire.dn, role: 'customer_admin' })).status, 400, 'only staff roles can be given');
      // import two people, one role
      let r = await a.post('/admin/users/import', { dn: [hire.dn, second.dn, 'CN=Gone,DC=t'], role: 'agent', email: 'attacker@evil.test' });
      assert.equal(r.status, 302);
      const msg = (await a.get('/admin/users')).text;
      assert.match(msg, /Imported 2 people/); assert.match(msg, /no longer in the directory/);
      const u = await importRow('newhire@corp.test');
      assert.equal(u.auth_source, 'ldap'); assert.equal(u.kind, 'staff'); assert.equal(u.role, 'agent'); assert.equal(u.role_locked, true);
      assert.equal(u.password_hash, null); assert.equal(u.ldap_dn, 'CN=New Hire,DC=t'); assert.equal(u.active, true);
      assert.equal(await importRow('attacker@evil.test'), undefined, 'details are not taken from the form');
      assert.equal((await q(`select count(*)::int as n from audit_log where action = 'user_imported_from_directory'`)).rows[0].n >= 2, true);
      ctx.dirUser = u;
      // again: already imported
      await a.post('/admin/users/import', { dn: hire.dn, role: 'agent' });
      assert.match((await a.get('/admin/users')).text, /already imported/);
      assert.equal((await q(`select count(*)::int as n from users where lower(email) = 'newhire@corp.test'`)).rows[0].n, 1);
      // a person who already has a local account is not taken over
      ldapLib.recheck = async (cfg, pw, dns) => [{ dn: dns[0], state: 'ok', user: dirUser(ctx.admin.email, 'Admin Twin', 'CN=Twin,DC=t') }];
      await a.post('/admin/users/import', { dn: 'CN=Twin,DC=t', role: 'platform_admin' });
      assert.match((await a.get('/admin/users')).text, /already has a local account/);
      assert.equal((await q('select auth_source, ldap_dn from users where id = $1', [ctx.admin.id])).rows[0].auth_source, 'local');
      // disabled in AD: not imported
      ldapLib.recheck = async (cfg, pw, dns) => [{ dn: dns[0], state: 'disabled', user: dirUser('off@corp.test', 'Off Person', 'CN=Off,DC=t') }];
      await a.post('/admin/users/import', { dn: 'CN=Off,DC=t', role: 'agent' });
      assert.equal(await importRow('off@corp.test'), undefined);
      // the directory cannot be searched
      ldapLib.searchUsers = async () => { throw new Error('ETIMEDOUT'); };
      const down = await a.get('/admin/users/import?go=1');
      assert.equal(down.status, 200); assert.match(down.text, /Could not search/);
    });
  });
});

test('Active Directory sign-in: imported people sign in with their AD password; nobody else does', async () => {
  await withDirectory(async () => {
    // the role from the application is the role, whatever the directory returns
    ldapLib.authenticate = async () => ({ ok: true, user: dirUser('newhire@corp.test'), role: 'platform_admin', groups: ['Domain Admins'] });
    const c = new Client();
    assert.equal((await c.login('newhire', 'Any-directory-pw-1')).status, 302);
    assert.equal((await c.get('/tickets')).status, 200);
    assert.equal((await importRow('newhire@corp.test')).role, 'agent');
    assert.equal((await new Client().login('newhire@corp.test', 'x')).status, 302, 'the e-mail address works as well');

    // wrong password counts as a failed attempt
    ldapLib.authenticate = async () => ({ ok: false, reason: 'bad_password' });
    const before = (await q('select failed_logins from users where id = $1', [ctx.dirUser.id])).rows[0].failed_logins;
    assert.equal((await new Client().login('newhire@corp.test', 'wrong')).status, 401);
    assert.equal((await q('select failed_logins from users where id = $1', [ctx.dirUser.id])).rows[0].failed_logins, before + 1);

    // somebody in AD who was never imported
    ldapLib.authenticate = async () => ({ ok: true, user: dirUser('stranger@corp.test', 'Stranger', 'CN=Stranger,DC=t') });
    const r = await new Client().login('stranger', 'x');
    assert.equal(r.status, 401); assert.match(r.text, /not been set up here/);
    assert.equal((await q(`select count(*)::int as n from users where lower(email) = 'stranger@corp.test'`)).rows[0].n, 0);

    // the directory is down
    ldapLib.authenticate = async () => { throw new Error('connect ECONNREFUSED'); };
    const down = await new Client().login('newhire', 'x');
    assert.equal(down.status, 401); assert.match(down.text, /could not be reached/);

    // an administrator switched the person off: the directory does not turn them back on
    ldapLib.authenticate = async () => ({ ok: true, user: dirUser('newhire@corp.test') });
    await q('update users set active = false where id = $1', [ctx.dirUser.id]);
    assert.equal((await new Client().login('newhire', 'x')).status, 401);
    assert.equal((await q('select active from users where id = $1', [ctx.dirUser.id])).rows[0].active, false);
    await q('update users set active = true, failed_logins = 0, locked_until = null where id = $1', [ctx.dirUser.id]);

    // a local account cannot be taken over, and local accounts never go to the directory
    ldapLib.authenticate = async () => ({ ok: true, user: dirUser(ctx.admin.email, 'Impostor', 'CN=Impostor,DC=t'), role: 'platform_admin' });
    assert.equal((await new Client().login('impostor', 'x')).status, 401);
    const adm = (await q('select auth_source, ldap_dn, role from users where id = $1', [ctx.admin.id])).rows[0];
    assert.equal(adm.auth_source, 'local'); assert.equal(adm.ldap_dn, null);
    ldapLib.authenticate = async () => { throw new Error('the directory must not be asked about a local account'); };
    assert.equal((await new Client().login(ctx.agent.email, PW)).status, 302);
  });
});

test('Active Directory: the role set on the Users page is never changed by the directory', async () => {
  await withDirectory(async () => {
    await asAdmin(async (a) => assert.equal((await a.post(`/admin/users/${ctx.dirUser.id}`, { active: 'on', available: 'on', role: 'engineer' })).status, 302));
    assert.equal((await importRow('newhire@corp.test')).role, 'engineer');
    ldapLib.authenticate = async () => ({ ok: true, user: dirUser('newhire@corp.test', 'New Hire Renamed'), role: 'agent' });
    assert.equal((await new Client().login('newhire', 'x')).status, 302);
    const u = await importRow('newhire@corp.test');
    assert.equal(u.role, 'engineer'); assert.equal(u.name, 'New Hire Renamed', 'the name follows the directory');
    ldapLib.recheck = async (cfg, pw, dns) => dns.map((dn) => ({ dn, state: 'ok', user: dirUser(dn === ctx.dirUser.ldap_dn ? 'newhire@corp.test' : 'second@corp.test', dn === ctx.dirUser.ldap_dn ? 'New Hire' : 'Second Person', dn) }));
    const r = await directory.syncAll({ query: q });
    assert.equal(r.deactivated, 0); assert.equal((await importRow('newhire@corp.test')).role, 'engineer');
    assert.equal((await q(`select count(*)::int as n from audit_log where action = 'role_changed_from_directory'`)).rows[0].n, 0);
  });
});

test('hourly directory check disables people who left, and does nothing when the directory is unreachable', async () => {
  await withDirectory(async () => {
    const c = new Client(); ldapLib.authenticate = async () => ({ ok: true, user: dirUser('newhire@corp.test') });
    await c.login('newhire', 'x');
    assert.equal((await c.get('/tickets')).status, 200);

    ldapLib.recheck = async () => { throw new Error('ETIMEDOUT'); };
    await assert.rejects(() => directory.syncAll({ query: q }), /ETIMEDOUT/);
    assert.equal((await q('select active from users where id = $1', [ctx.dirUser.id])).rows[0].active, true);

    ldapLib.recheck = async (cfg, pw, dns) => dns.map((dn) => (dn === ctx.dirUser.ldap_dn ? { dn, state: 'disabled', user: dirUser('newhire@corp.test') } : { dn, state: 'ok', user: dirUser('second@corp.test', 'Second Person', dn) }));
    const r = await directory.syncAll({ query: q });
    assert.equal(r.deactivated, 1);
    assert.equal((await q('select active from users where id = $1', [ctx.dirUser.id])).rows[0].active, false);
    assert.equal((await c.get('/tickets')).status, 302);   // the open session ended
    assert.equal((await q(`select count(*)::int as n from audit_log where action = 'user_deactivated_by_directory'`)).rows[0].n >= 1, true);
  });
  assert.equal(await directory.syncAll({ query: q }), null, 'nothing happens while Active Directory sign-in is off');
});

// ---------------------------------------------------------------- mailboxes: Microsoft 365 reader, health monitoring, limit of five
const mailhealth = require('../../src/services/mailhealth');
const GUID = '11111111-2222-3333-4444-555555555555';

function fakeGraph({ messages = [], failList = false } = {}) {
  return async (url, opts = {}) => {
    const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
    if (url.startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'tok', expires_in: 3600 });
    if (failList && /\/messages\?/.test(url)) return json({ error: { message: 'Service unavailable' } }, 503);
    if (/\/messages\/[^/?]+\/\$value$/.test(url)) { const id = decodeURIComponent(url.split('/messages/')[1].split('/')[0]); return new Response(messages.find((m) => m.id === id).raw, { status: 200 }); }
    if (/\/messages\?/.test(url)) return json({ value: messages.map(({ raw, ...rest }) => rest) });
    return json({}, 404);
  };
}

test('Microsoft 365 mailbox: a message becomes a ticket, the position is remembered, nothing is created twice', async () => {
  const mb0 = (await q(`insert into mailboxes (key, name, address, queue, category, provider, tenant_id, client_id, secret_env, enabled)
    values ('m365box', 'M365 Box', 'm365box@example.com', 'it_services', 'General', 'graph', $1, $1, 'TEST_GRAPH_SECRET', true) returning *`, [GUID])).rows[0];
  ctx.m365 = mb0;
  const raw = eml({ from: `Alpha User <${ctx.aUser.email}>`, to: 'm365box@example.com', subject: 'Mailbox full', id: 'g1' });
  const messages = [{ id: 'AAA=', internetMessageId: '<g1@test>', receivedDateTime: new Date().toISOString(), isRead: false, raw }];
  const env = { TEST_GRAPH_SECRET: 'x' };
  assert.equal(await inbound.syncMailbox(mb0, { fetch: fakeGraph({ messages }), env }), 1);
  const t = (await q(`select * from tickets where mailbox_id = $1`, [mb0.id])).rows;
  assert.equal(t.length, 1); assert.equal(t[0].customer_id, ctx.A.c.id); assert.equal(t[0].source, 'email');
  const row = await mailbox('m365box');
  assert.equal(row.last_status, 'ok'); assert.equal(row.consecutive_failures, 0); assert.ok(row.last_success_at); assert.ok(row.last_received_at);
  assert.equal(await inbound.syncMailbox(row, { fetch: fakeGraph({ messages }), env }), 0);   // same message again: recognised, not downloaded
  assert.equal((await q('select count(*)::int as n from tickets where mailbox_id = $1', [mb0.id])).rows[0].n, 1);
  const test1 = await inbound.testConnection(row, { fetch: async (u) => (u.includes('login.') ? new Response(JSON.stringify({ access_token: 't', expires_in: 3600 })) : new Response(JSON.stringify({ displayName: 'Inbox', totalItemCount: 1, unreadItemCount: 0 }))), env });
  assert.equal(test1.ok, true);
});

test('mailbox monitoring: three failures raise one alert, recovery raises one notice, secrets never appear in errors', async () => {
  const env = { TEST_GRAPH_SECRET: 'super-secret-value' };
  for (let i = 0; i < 3; i++) await inbound.syncMailbox(await mailbox('m365box'), { fetch: fakeGraph({ failList: true }), env });
  let row = await mailbox('m365box');
  assert.equal(row.last_status, 'error'); assert.equal(row.consecutive_failures, 3); assert.ok(!row.last_error.includes('super-secret-value'));
  assert.equal(await mailhealth.check({ query: q }), 1);
  assert.equal(await mailhealth.check({ query: q }), 0);   // one alert per outage
  const down = (await q(`select * from notifications where kind = 'mailbox_down'`)).rows;
  assert.ok(down.length >= 1 && down.every((n) => n.subject.includes('m365box@example.com')));
  assert.equal((await mailbox('m365box')).alert_state, 'alerted');

  await inbound.syncMailbox(await mailbox('m365box'), { fetch: fakeGraph({ messages: [] }), env });
  assert.equal((await mailbox('m365box')).consecutive_failures, 0);
  await mailhealth.check({ query: q });
  assert.equal((await mailbox('m365box')).alert_state, 'ok');
  assert.ok((await q(`select count(*)::int as n from notifications where kind = 'mailbox_recovered'`)).rows[0].n >= 1);
});

test('a mailbox that is not configured is reported, not crashed on', async () => {
  const row = await mailbox('m365box');
  assert.equal(await inbound.syncMailbox(row, { fetch: fakeGraph(), env: {} }), 0);
  const after = await mailbox('m365box');
  assert.equal(after.last_status, 'not configured'); assert.match(after.last_error, /TEST_GRAPH_SECRET/);
});

test('at most five mailboxes, and each address only once', async () => {
  const add = (k) => q(`insert into mailboxes (key, name, address, queue, category) values ($1,$1,$2,'it_services','General')`, [k, `${k}@example.com`]);
  await add('extra_a'); await add('extra_b');
  assert.equal((await q('select count(*)::int as n from mailboxes')).rows[0].n, 5);
  await assert.rejects(() => add('extra_c'), /At most 5/);
  await assert.rejects(() => q(`insert into mailboxes (key, name, address, queue, category) values ('x','x','EXTRA_A@example.com','it_services','General')`), /duplicate|unique|At most/);
  await q(`delete from mailboxes where key in ('extra_a','extra_b')`);
});

test('SLA and the Service Catalogue are reached from Administration, for everyone who may see them', async () => {
  const ag = new Client(); await ag.login(ctx.agent.email);
  const side = /<aside class="sidebar">[\s\S]*?<\/aside>/.exec((await ag.get('/')).text)[0];
  for (const href of ['/sla', '/catalogue']) assert.ok(!side.includes(`href="${href}"`), `${href} is still in the left menu`);
  assert.ok((await ag.get('/')).text.includes('href="/admin">Administration'), 'the user menu offers Administration');
  const hub = await ag.get('/admin');
  assert.equal(hub.status, 200);
  assert.ok(hub.text.includes('href="/sla"') && hub.text.includes('href="/catalogue"'));
  assert.ok(!hub.text.includes('href="/admin/users"') && !hub.text.includes('href="/admin/settings"'));
  assert.equal((await ag.get('/sla')).status, 200);
  assert.equal((await ag.get('/catalogue')).status, 200);
  const sm = new Client(); await sm.login(ctx.manager.email);
  assert.ok((await sm.get('/catalogue')).text.includes('Administration'));
});

// ---------------------------------------------------------------- 1.3: dashboards, catalogue, contracts, tenders and pipeline
const tendersSvc = require('../../src/services/tenders');
const tzLib = require('../../src/lib/tz');
const appConfig = require('../../src/config');
const inDays = (n) => tzLib.dateToLocal(new Date(Date.now() + n * 86400000), appConfig.timezone);

test('dashboards render for staff and customers, and the new service form is pre-filled', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  let r = await m.get('/');
  assert.equal(r.status, 200);
  for (const s of ['Ticket Trend', 'Tickets by Category', 'SLA Compliance', 'My Tickets', 'Service Operations (Ops)']) assert.ok(r.text.includes(s), `dashboard lacks "${s}"`);
  assert.equal((await m.get('/?tab=resolved')).status, 200);
  assert.equal((await m.get('/tickets?type=incident&view=all')).status, 200);
  assert.ok((await m.get('/tickets/new?category=Email&type=request')).text.includes('<option selected>Email</option>'));
  const u = new Client(); await u.login(ctx.aUser.email);
  r = await u.get('/portal');
  assert.equal(r.status, 200); assert.ok(r.text.includes('Request a Service')); assert.ok(!r.text.includes('SLA Compliance')); assert.ok(!r.text.includes('BETA-SECRET'));
  assert.ok((await u.get('/portal/tickets/new?category=Email&type=request')).text.includes('<option selected>Email</option>'));
  assert.ok(!(await u.get('/portal')).text.includes('/tenders'));        // no staff-only modules in a customer's menu
});

// A platform administrator is sent to set up MFA, so for these tests the account is marked as enrolled after sign-in (and put back).
async function asAdmin(fn) {
  const c = new Client(); await c.login(ctx.admin.email);
  await q('update users set totp_enabled = true where id = $1', [ctx.admin.id]);
  try { return await fn(c); } finally { await q('update users set totp_enabled = false where id = $1', [ctx.admin.id]); }
}

test('administration: Settings, Users and Audit are not in the menu; the Administration page lists them for the administrator only; the old Directory page redirects to Users', async () => {
  await asAdmin(async (a) => {
    const home = (await a.get('/')).text;
    const side = /<aside class="sidebar">[\s\S]*?<\/aside>/.exec(home);
    assert.ok(side, 'the sidebar renders');
    for (const href of ['/admin/settings', '/admin/users', '/audit', '/mail', '/sla', '/catalogue']) assert.ok(!side[0].includes(`href="${href}"`), `${href} is still in the left menu`);
    const hub = await a.get('/admin');
    assert.equal(hub.status, 200);
    for (const part of ['/admin/settings', '/admin/users', '/audit', '/mail', '/sla', '/catalogue']) assert.ok(hub.text.includes(part), `Administration lacks ${part}`);
    assert.ok(!hub.text.includes('href="/admin/directory"'), 'Active Directory is part of User management now');
    const old = await a.get('/admin/directory'); assert.equal(old.status, 301); assert.match(old.location, /\/admin\/users#directory/);
    assert.equal((await a.get('/mail')).status, 200);
  });
  const g = new Client(); await g.login(ctx.manager.email);
  assert.equal((await g.get('/admin/settings')).status, 403);
  assert.equal((await g.get('/admin/users')).status, 403);
  // the service manager reaches E-mail from Administration, not from the menu
  const gh = await g.get('/admin'); assert.ok(gh.text.includes('href="/mail"'));
  assert.ok(!/<aside class="sidebar">[\s\S]*?<\/aside>/.exec((await g.get('/')).text)[0].includes('href="/mail"'));
  assert.equal((await g.get('/mail')).status, 200);
  const ag = new Client(); await ag.login(ctx.agent.email);
  assert.equal((await ag.get('/mail')).status, 403);
});

test('themes: six, changed only with the switch next to the bell; bad values are refused', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  let home = (await m.get('/')).text;
  assert.ok(home.includes('<html lang="en" data-theme="default">'), 'Default until a person chooses');
  // the switch lists the six themes; the user menu and My account no longer offer any
  const sw = /<details class="pop themeswitch">[\s\S]*?<\/details>/.exec(home)[0];
  for (const label of ['Default', 'Service Green', 'Sunset Orange', 'Match Device', 'Ocean Blue', 'Midnight Dark']) assert.ok(sw.includes(label), label);
  assert.ok(!/Violet|Graphite/.test(home));
  assert.ok(home.includes('href="#i-logo"') && home.includes('/static/favicon.svg'), 'new brand icon and tab icon');
  assert.equal((await fetch(base + '/static/favicon.svg')).status, 200);
  assert.equal((sw.match(/name="theme"/g) || []).length, 6);
  assert.ok(!(await m.get('/account')).text.includes('Appearance'));
  let r = await m.post('/account/theme', { theme: 'ocean', back: '/tickets?type=incident' });
  assert.equal(r.status, 302); assert.equal(r.location, '/tickets?type=incident');
  assert.equal((await q('select theme from users where id = $1', [ctx.manager.id])).rows[0].theme, 'ocean');
  assert.ok((await m.get('/')).text.includes('data-theme="ocean"'));
  assert.ok(Object.keys(m.jar).includes('itsm.theme'), 'remembered in the browser for the sign-in page');
  assert.ok((await new Client().get('/login')).text.includes('data-theme="default"'));        // another browser is unaffected
  assert.equal((await m.post('/account/theme', { theme: 'ocean', back: '//evil.example' })).location, '/');
  for (const bad of ['neon', 'violet', 'slate', 'DEFAULT', '']) { await m.post('/account/theme', { theme: bad }); assert.equal((await q('select theme from users where id = $1', [ctx.manager.id])).rows[0].theme, 'ocean', bad); }
  await assert.rejects(q(`update users set theme = 'violet' where id = $1`, [ctx.manager.id]), (e) => e.code === '23514');
  for (const t of ['midnight', 'auto', 'sunset', 'green', 'default']) { await m.post('/account/theme', { theme: t }); assert.ok((await m.get('/')).text.includes(`data-theme="${t}"`), t); }
  const u = new Client(); await u.login(ctx.aUser.email);                                             // customers have the switch too
  assert.equal((await u.post('/account/theme', { theme: 'midnight' })).status, 302);
  assert.ok((await u.get('/portal')).text.includes('data-theme="midnight"'));
  await q('update users set theme = null where id = any($1)', [[ctx.manager.id, ctx.aUser.id]]);
  const anon = new Client(); anon.token = await anon.csrf('/login');
  const ar = await anon.post('/account/theme', { theme: 'ocean' });
  assert.equal(ar.status, 302); assert.ok(ar.location.startsWith('/login'));
});

test('the side menu collapses to icons (remembered), and error pages carry a coloured code', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  const open = (await m.get('/')).text;
  assert.ok(!open.includes('data-nav="collapsed"') && open.includes('data-nav-toggle') && open.includes('aria-expanded="true"'));
  assert.ok(/<a href="\/tickets\?view=mine"[^>]*title="My Requests"/.test(open), 'every menu link has a tooltip for icon-only mode');
  const r = await fetch(base + '/', { headers: { cookie: `${m.cookie()}; itsm.nav=collapsed` }, redirect: 'manual' });
  const t = await r.text();
  assert.ok(t.includes('<html lang="en" data-theme="default" data-nav="collapsed">') && t.includes('aria-expanded="false"'));
  // error codes: 404 blue "missing", 403 red "deny"; the code is shown
  const nf = await m.get('/no-such-page'); assert.equal(nf.status, 404);
  assert.ok(/class="errc missing"[^>]*>404</.test(nf.text));
  const ag = new Client(); await ag.login(ctx.agent.email);
  const fb = await ag.get('/admin/settings'); assert.equal(fb.status, 403);
  assert.ok(/class="errc deny"[^>]*>403</.test(fb.text));
  const bad = await m.post('/contracts', { title: '', counterparty_kind: 'customer', start_date: '2026-01-01' });
  assert.equal(bad.status, 400); assert.ok(/class="errc warn"[^>]*>400</.test(bad.text));
});

test('Service Desk Reports: categories, filters and downloads; the Security category only for security access', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  const hub = await m.get('/reports'); assert.equal(hub.status, 200);
  for (const c of ['Ticket volume and trends', 'SLA and performance', 'Customers and services', 'People and workload', 'Backlog and ageing', 'Resolution and satisfaction']) assert.ok(hub.text.includes(c), c);
  assert.ok(!hub.text.includes('Security queue tickets'), 'a service manager has no Security category');
  const ids = ['tickets', 'trend', 'category', 'channel', 'sla_customer', 'sla_priority', 'breaches', 'by_customer', 'by_service', 'requesters', 'by_engineer', 'exec_engineer', 'backlog_age', 'open_tickets', 'by_status', 'resolution_codes', 'satisfaction'];
  for (const id of ids) {
    assert.equal((await m.get(`/reports/${id}`)).status, 200, id);
    assert.equal((await m.get(`/reports/${id}?format=csv&from=2026-01-01&to=2026-12-31`)).status, 200, `${id} csv`);
  }
  assert.ok((await m.get('/reports/tickets?format=csv')).text.includes('Ticket,Customer'));
  assert.equal((await m.get('/reports/by_customer?format=xlsx')).status, 200);
  assert.ok((await m.get('/reports/sla_priority?format=pdf')).text.startsWith('%PDF'));
  assert.equal((await m.get(`/reports/by_customer?customer=${ctx.A.c.id}&from=2026-02-01&to=2026-01-01`)).status, 200);   // dates in the wrong order are swapped
  assert.equal((await m.get('/reports/security')).status, 404);
  assert.equal((await m.get('/reports/nothing')).status, 404);
  const old = await m.get('/reports?format=csv'); assert.equal(old.status, 301); assert.ok(old.location.startsWith('/reports/tickets?format=csv'));
  const soc = new Client(); await soc.login(ctx.soc.email);
  assert.ok((await soc.get('/reports')).text.includes('Security queue tickets'));
  assert.equal((await soc.get('/reports/security')).status, 200);
  // the register contains a ticket the person may see and never a Security ticket they may not
  const secT = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'SEC-REPORT-TEST', queue: 'security', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
  assert.ok(!(await m.get('/reports/tickets')).text.includes(secT.ref));
  assert.ok((await soc.get('/reports/tickets')).text.includes(secT.ref));
  const a = new Client(); await a.login(ctx.aUser.email);
  assert.notEqual((await a.get('/reports')).status, 200);                                            // customers have no staff reports
});

test('a customer has exactly one CSID, and a service can be covered by any number of contracts', async () => {
  await assert.rejects(q('insert into csids (csid, customer_id) values ($1,$2)', ['CS-DUP001', ctx.A.c.id]), (e) => e.code === '23505');
  const m = new Client(); await m.login(ctx.manager.email);
  const r = await m.post(`/customers/${ctx.A.c.id}/csids`, {});
  assert.equal(r.status, 400); assert.ok(r.text.includes('already has'));
  assert.equal((await q('select count(*)::int as n from csids where customer_id = $1', [ctx.A.c.id])).rows[0].n, 1);
  const mkc = async (title, policy) => (await q(`insert into contracts (customer_id, title, type, start_date, end_date, sla_policy_id, created_by) values ($1,$2,'SLA', current_date - 30, current_date + 300, $3, $4) returning id`, [ctx.A.c.id, title, policy, ctx.manager.id])).rows[0].id;
  const c1 = await mkc('Support 2026', null); const c2 = await mkc('Add-on 2026', ctx.policy); const c3 = await mkc('Third', null);
  for (const c of [c1, c2, c3]) assert.equal((await m.post(`/contracts/${c}/services`, { service_id: String(ctx.A.sv.id) })).status, 302);
  assert.equal((await q('select count(*)::int as n from service_contracts where service_id = $1', [ctx.A.sv.id])).rows[0].n, 3);
  assert.equal((await tickets.governingContract({ query: q }, ctx.A.sv.id)).sla_policy_id, ctx.policy, 'the newest in-force contract with a policy governs');
  // another customer's service cannot be linked
  const rr = await m.post(`/contracts/${c1}/services`, { service_id: String(ctx.B.sv.id) });
  assert.equal(rr.status, 400);
  assert.ok((await m.get(`/services/${ctx.A.sv.id}`)).text.includes('Support 2026'));
});

test('service catalogue: staff edit it, retiring keeps history, customers see only active entries', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  let r = await m.post('/catalogue', { name: 'Managed backup', category: 'Other', description: 'Daily backups', icon: 'server', request_type: 'request', sort_order: '3', active: 'on', featured: 'on' });
  assert.equal(r.status, 302);
  const id = (await q(`select id from service_catalogue where name = 'Managed backup'`)).rows[0].id;
  assert.equal((await m.post(`/catalogue/${id}`, { name: 'Managed backup plus', category: 'Other', description: 'Daily backups', icon: 'server', request_type: 'request', sort_order: '3', active: 'on' })).status, 302);
  assert.equal((await q('select name from service_catalogue where id = $1', [id])).rows[0].name, 'Managed backup plus');
  const u = new Client(); await u.login(ctx.aUser.email);
  assert.ok((await u.get('/portal/catalogue')).text.includes('Managed backup plus'));
  assert.notEqual((await u.get('/catalogue')).status, 200);                                  // customers are sent away from the staff page
  await q('update service_catalogue set active = false where id = $1', [id]);
  assert.ok(!(await u.get('/portal/catalogue')).text.includes('Managed backup plus'));
  const a = new Client(); await a.login(ctx.agent.email);
  assert.equal((await a.post('/catalogue', { name: 'x' })).status, 403);
});

test('customers can be deleted only when nothing refers to them', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  const T = await mkCustomer('Temp Ltd', 'TEMPLTD');
  await q('delete from services where customer_id = $1', [T.c.id]);
  assert.equal((await m.post(`/customers/${T.c.id}/delete`, { confirm: 'WRONG' })).status, 400);
  assert.equal((await m.post(`/customers/${T.c.id}/delete`, { confirm: 'TEMPLTD' })).status, 302);
  assert.equal((await q('select count(*)::int as n from customers where id = $1', [T.c.id])).rows[0].n, 0);
  assert.equal((await m.post(`/customers/${ctx.A.c.id}/delete`, { confirm: 'ALPHA' })).status, 400);
  assert.equal((await q('select count(*)::int as n from customers where id = $1', [ctx.A.c.id])).rows[0].n, 1);
});

test('contracts: the module is for permitted staff; register, review, amend, document list and reports', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  const old = await m.get('/renewals/123?x=1');
  assert.equal(old.status, 301); assert.equal(old.location, '/contracts');
  const a = new Client(); await a.login(ctx.agent.email);
  assert.equal((await a.get('/contracts')).status, 403);
  assert.equal((await m.post('/contracts', { title: '', counterparty_kind: 'customer', start_date: '2026-01-01' })).status, 400);
  let r = await m.post('/contracts', { title: 'Alpha managed network', counterparty_kind: 'customer', customer_id: String(ctx.A.c.id), type: 'SLA', start_date: '2026-01-01', end_date: '2027-12-31', value: '120000000', currency: 'UGX', notice_days: '60' });
  assert.equal(r.status, 302);
  const id = /\/contracts\/(\d+)/.exec(r.location)[1];
  assert.ok((await m.get(`/contracts/${id}`)).text.includes('Alpha managed network'));
  assert.equal((await m.post(`/contracts/${id}/status`, { status: 'terminated' })).status, 400);        // a reason is required
  assert.equal((await m.post(`/contracts/${id}/obligations`, { title: 'Monthly report', kind: 'deliverable', due_date: '2026-12-01' })).status, 302);
  assert.equal((await m.post(`/contracts/${id}/amendments`, { kind: 'extension', effective_date: '2026-11-01', description: 'Two more years', new_end_date: '2029-12-31' })).status, 302);
  assert.equal((await q('select end_date from contracts where id = $1', [id])).rows[0].end_date, '2029-12-31');
  assert.equal((await m.post(`/contracts/${id}/reviews`, { stage: 'legal', decision: 'approved' })).status, 403);   // service manager holds no legal review
  for (const rep of ['active', 'expiry', 'renewals', 'value', 'counterparty', 'obligations', 'sla', 'amendments']) assert.equal((await m.get(`/contracts/reports/${rep}`)).status, 200, rep);
  const x = await m.get('/contracts/reports/active?format=xlsx');
  assert.equal(x.status, 200);
  assert.ok((await m.get('/contracts/export?format=csv')).text.includes('Alpha managed network'));
  const bo = await m.get('/business'); assert.equal(bo.status, 301); assert.equal(bo.location, '/operations');
  assert.ok((await m.get('/operations')).text.includes('Operations Overview'));
});

test('tenders: 14 statuses, reviews before submission, reminders sent once, award closes the opportunity as won', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  const bid = new Client(); const bm = await mkUser('bid@t.local', 'Bid Manager', 'staff', 'bid_manager'); await bid.login(bm.email);
  const opp = (await q(`insert into opportunities (name, customer_id, value, currency, owner_id, created_by, stage, probability) values ('Bank WAN', $1, 50000, 'USD', $2, $2, 'proposal_submission', 60) returning id`, [ctx.A.c.id, ctx.manager.id])).rows[0].id;
  assert.equal((await bid.post('/tenders', { title: 'No deadline', issuer: 'X', submission_due: '' })).status, 400);
  let r = await bid.post('/tenders', { title: 'Core network refresh', issuer: 'Ministry of Works', type: 'RFP', department: 'Gov', submission_due: inDays(5), est_value: '120000', currency: 'USD', opportunity_id: String(opp) });
  assert.equal(r.status, 302);
  const id = /\/tenders\/(\d+)/.exec(r.location)[1];
  assert.ok((await bid.get(`/tenders/${id}`)).text.includes('Core network refresh'));
  assert.equal((await bid.post(`/tenders/${id}/status`, { status: 'awarded' })).status, 400);               // cannot skip the lifecycle
  assert.equal((await bid.post(`/tenders/${id}/tasks`, { standard: '1' })).status, 302);
  assert.ok((await q('select count(*)::int as n from tender_tasks where tender_id = $1', [id])).rows[0].n >= 15);
  for (const s of ['under_review', 'qualification', 'bid_preparation', 'internal_approval']) assert.equal((await bid.post(`/tenders/${id}/status`, { status: s })).status, 302, s);
  const count = async () => (await q(`select count(*)::int as n from notifications where kind = 'tender_reminder' and tender_id = $1`, [id])).rows[0].n;
  // the reminder job only covers tenders still being prepared
  await q(`update tenders set status = 'bid_preparation' where id = $1`, [id]);
  await tendersSvc.runSchedule({ query: q });
  const first = await count(); assert.ok(first >= 1);
  await tendersSvc.runSchedule({ query: q });
  assert.equal(await count(), first, 'sent once per threshold');
  await q(`update tenders set status = 'internal_approval' where id = $1`, [id]);
  assert.equal((await bid.post(`/tenders/${id}/status`, { status: 'submitted', method: 'portal' })).status, 400);   // reviews not approved yet
  assert.equal((await bid.post(`/tenders/${id}/reviews`, { stage: 'technical', decision: 'approved' })).status, 403);   // a bid manager cannot review
  const tech = await mkUser('tech@t.local', 'Tech', 'staff', 'technical_team'); const fin = await mkUser('fin@t.local', 'Fin', 'staff', 'finance'); const mg = await mkUser('mgmt@t.local', 'Exec', 'staff', 'management');
  for (const [u, stage] of [[tech, 'technical'], [fin, 'commercial'], [mg, 'management']]) { const c = new Client(); await c.login(u.email); assert.equal((await c.post(`/tenders/${id}/reviews`, { stage, decision: 'approved' })).status, 302, stage); }
  assert.equal((await bid.post(`/tenders/${id}/status`, { status: 'submitted' })).status, 400);                      // method required
  assert.equal((await bid.post(`/tenders/${id}/status`, { status: 'submitted', method: 'e-GP portal', reference: 'ACK-9' })).status, 302);
  assert.equal((await bid.post(`/tenders/${id}/status`, { status: 'under_evaluation' })).status, 302);
  assert.equal((await bid.post(`/tenders/${id}/status`, { status: 'awarded', award_value: '110000', awarded_to: 'Us', awarded_on: '2026-12-01' })).status, 302);
  const t = (await q('select status, award_value, submission_method from tenders where id = $1', [id])).rows[0];
  assert.equal(t.status, 'awarded'); assert.equal(Number(t.award_value), 110000); assert.equal(t.submission_method, 'e-GP portal');
  assert.equal((await q('select stage from opportunities where id = $1', [opp])).rows[0].stage, 'won');
  assert.equal((await bid.post(`/tenders/${id}/status`, { status: 'unsuccessful', outcome_note: 'x' })).status, 400);  // an award cannot be reversed
  for (const rep of ['active', 'submissions', 'evaluations', 'awards', 'winloss', 'value', 'performance']) assert.equal((await bid.get(`/tenders/reports/${rep}`)).status, 200, rep);
  assert.equal((await bid.get('/tenders/reports/awards?format=pdf')).status, 200);
  assert.ok((await bid.get('/tenders/export?format=csv')).text.includes('Core network refresh'));
  assert.equal((await bid.get('/tenders?status=awarded&q=Core')).status, 200);
  const b = new Client(); await b.login(ctx.agent.email);
  assert.equal((await b.get('/tenders')).status, 403);
  assert.equal((await b.post('/tenders', { title: 'x', issuer: 'y', submission_due: inDays(3) })).status, 403);
  // the award can start a contract carrying the tender's details
  assert.ok((await m.get(`/contracts/new?tender_id=${id}`)).text.includes('Core network refresh'));
});

test('pipeline: ten stages, a lost reason is required, forecasts and reports render', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  let r = await m.post('/pipeline', { name: 'Bank core upgrade', customer_id: String(ctx.A.c.id), value: '50000', currency: 'USD', expected_close: '2027-01-31', owner_id: String(ctx.manager.id) });
  assert.equal(r.status, 302);
  const id = /\/pipeline\/(\d+)/.exec(r.location)[1];
  assert.equal((await q('select stage, probability from opportunities where id = $1', [id])).rows[0].stage, 'lead_identification');
  assert.equal((await m.post(`/pipeline/${id}/stage`, { stage: 'solution_development' })).status, 302);
  assert.equal((await q('select probability from opportunities where id = $1', [id])).rows[0].probability, pipelineSvc.DEFAULT_PROB.solution_development);
  assert.equal((await m.post(`/pipeline/${id}/stage`, { stage: 'lost' })).status, 400);
  assert.equal((await m.post('/pipeline', { name: 'Nobody', value: '5' })).status, 400);
  assert.equal((await m.post(`/pipeline/${id}/stage`, { stage: 'lost', reason: 'Price' })).status, 302);
  assert.equal((await m.post(`/pipeline/${id}/stage`, { stage: 'negotiation' })).status, 302);              // can be reopened
  assert.ok((await m.get('/pipeline?view=list&stage=negotiation')).text.includes('Bank core upgrade'));
  assert.equal((await m.get('/pipeline')).status, 200);
  for (const rep of ['pipeline', 'forecast', 'winloss', 'customers', 'workload', 'technical']) assert.equal((await m.get(`/pipeline/reports/${rep}`)).status, 200, rep);
  assert.equal((await m.get('/pipeline/export?format=xlsx')).status, 200);
  const a = new Client(); await a.login(ctx.agent.email);
  assert.equal((await a.get('/pipeline')).status, 403);
});

test('Service Delivery Engineer: sees only assigned opportunities, works on tasks, cannot change commercial data; the support report is produced', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  const sde = await mkUser('sde@t.local', 'Sam SDE', 'staff', 'sde'); const sde2 = await mkUser('sde2@t.local', 'Other SDE', 'staff', 'sde');
  const mkopp = async (name) => (await q(`insert into opportunities (name, customer_id, value, currency, owner_id, created_by) values ($1,$2,1000,'USD',$3,$3) returning id`, [name, ctx.A.c.id, ctx.manager.id])).rows[0].id;
  const o1 = await mkopp('SDE visible'); const o2 = await mkopp('SDE hidden');
  assert.equal((await m.post(`/pipeline/${o1}/engineers`, { user_id: String(sde.id) })).status, 302);
  assert.equal((await m.post(`/pipeline/${o1}/engineers`, { user_id: String(sde2.id) })).status, 302);
  assert.equal((await m.post(`/pipeline/${o1}/tasks`, { title: 'Site survey', assignee_id: String(sde.id), due_date: '2026-12-01', priority: 'high' })).status, 302);
  assert.equal((await m.post(`/pipeline/${o1}/tasks`, { title: 'For the other', assignee_id: String(sde2.id) })).status, 302);
  const t1 = (await q(`select id from opp_tasks where opportunity_id = $1 and title = 'Site survey'`, [o1])).rows[0].id;
  const t2 = (await q(`select id from opp_tasks where opportunity_id = $1 and title = 'For the other'`, [o1])).rows[0].id;
  assert.ok((await q(`select 1 from notifications where kind = 'opportunity_task' and opportunity_id = $1 and recipient_email = $2`, [o1, 'sde@t.local'])).rows.length, 'the engineer is notified of the new task');
  const s = new Client(); await s.login(sde.email);
  assert.equal((await s.get('/')).status, 302);                                                           // no ticket queue: goes to the business overview
  assert.equal((await s.get('/pipeline')).status, 302);
  const dash = await s.get('/pipeline/sde'); assert.equal(dash.status, 200); assert.ok(dash.text.includes('SDE visible')); assert.ok(!dash.text.includes('SDE hidden'));
  assert.equal((await s.get(`/pipeline/${o2}`)).status, 404);
  assert.equal((await s.get(`/pipeline/${o1}`)).status, 200);
  assert.equal((await s.post(`/pipeline/${o1}`, { name: 'Hacked', customer_id: String(ctx.A.c.id), value: '999999', owner_id: String(sde.id) })).status, 403);
  assert.equal((await s.post(`/pipeline/${o1}/stage`, { stage: 'won' })).status, 403);
  assert.equal((await s.post(`/pipeline/${o1}/engineers`, { user_id: String(sde.id) })).status, 403);
  assert.equal((await s.get('/pipeline/new')).status, 403);
  assert.equal((await s.post(`/pipeline/${o1}/tasks/${t1}`, { status: 'in_progress', progress: '60', work_notes: 'Survey started' })).status, 302);
  assert.equal((await s.post(`/pipeline/${o1}/tasks/${t2}`, { status: 'completed' })).status, 403);         // not their task
  assert.equal((await s.post(`/pipeline/${o1}/tasks/${t1}`, { status: 'completed' })).status, 302);
  assert.deepEqual((await q('select status, progress from opp_tasks where id = $1', [t1])).rows[0], { status: 'completed', progress: 100 });
  assert.equal(Number((await q('select value from opportunities where id = $1', [o1])).rows[0].value), 1000);
  assert.equal((await s.post(`/pipeline/${o1}/activities`, { kind: 'site_assessment', activity_date: '2026-11-02', description: 'Surveyed the campus', outcome: 'Feasible' })).status, 302);
  assert.equal((await s.post(`/pipeline/${o1}/solution`, { kind: 'bom', title: 'Initial BOM' })).status, 302);
  assert.equal((await s.post(`/pipeline/${o1}/support-notes`, { support_challenges: 'Old cabling', support_recommendations: 'Re-cable' })).status, 302);
  const rep = await s.get(`/pipeline/${o1}/support-report`); assert.equal(rep.status, 200); assert.ok(rep.text.includes('Surveyed the campus') && rep.text.includes('Old cabling'));
  assert.equal((await s.get(`/pipeline/${o2}/support-report`)).status, 404);
  const pdf = await s.get(`/pipeline/${o1}/support-report?format=pdf`); assert.equal(pdf.status, 200); assert.ok(pdf.text.startsWith('%PDF'));
  const xl = await s.get(`/pipeline/${o1}/support-report?format=xlsx`); assert.equal(xl.status, 200); assert.ok(xl.text.startsWith('PK'));
  // overdue tasks are reminded once a week, and the owner is told
  await q(`update opp_tasks set due_date = current_date - 2, status = 'in_progress' where id = $1`, [t2]);
  await pipelineSvc.runSchedule({ query: q });
  const n = async () => (await q(`select count(*)::int as n from notifications where opportunity_id = $1 and kind = 'opportunity_task' and subject like 'Overdue%'`, [o1])).rows[0].n;
  const first = await n(); assert.ok(first >= 1);
  await pipelineSvc.runSchedule({ query: q });
  assert.equal(await n(), first);
  assert.equal((await m.get('/pipeline/sde')).status, 200);
});

// ---------------------------------------------------------------- 1.8.0: Projects, Operations Overview, escalation, non-chargeable
test('projects: register, tasks and milestones, team, escalation; only managers edit and only team members update tasks', async () => {
  const m = new Client(); await m.login(ctx.manager.email);                                                // service manager: project.manage
  const eng = await mkUser('projeng@t.local', 'Project Engineer', 'staff', 'engineer');
  const out = await mkUser('projout@t.local', 'Outside Engineer', 'staff', 'engineer');
  assert.ok((await m.get('/operations')).text.includes('Projects'));                                       // in the menu
  assert.equal((await m.get('/projects')).status, 200);
  assert.equal((await m.post('/projects', { name: '', manager_id: String(ctx.manager.id) })).status, 400);
  assert.equal((await m.post('/projects', { name: 'Bad dates', manager_id: String(ctx.manager.id), start_date: '2026-12-01', end_date: '2026-11-01' })).status, 400);
  const r = await m.post('/projects', { name: 'Alpha rollout', customer_id: String(ctx.A.c.id), manager_id: String(ctx.manager.id), status: 'active', health: 'amber', start_date: '2026-10-01', end_date: '2026-12-31', budget: '5000000', currency: 'UGX' });
  assert.equal(r.status, 302);
  const p = (await q(`select * from projects where name = 'Alpha rollout'`)).rows[0];
  assert.match(p.ref, /^PRJ-\d{6}$/); assert.equal(p.status, 'active'); assert.equal(p.closed_at, null);
  assert.equal((await q('select count(*)::int as n from project_members where project_id = $1 and user_id = $2', [p.id, ctx.manager.id])).rows[0].n, 1, 'the manager is on the team');
  // tasks and milestones; progress follows the tasks
  assert.equal((await m.post(`/projects/${p.id}/tasks`, { title: 'Site survey', kind: 'task', due_date: '2026-10-10' })).status, 302);
  assert.equal((await m.post(`/projects/${p.id}/tasks`, { title: 'Go live', kind: 'milestone', due_date: '2026-12-15' })).status, 302);
  assert.equal((await m.post(`/projects/${p.id}/tasks`, { title: '' })).status, 302);                      // refused with a message, nothing added
  assert.equal((await q('select count(*)::int as n from project_tasks where project_id = $1', [p.id])).rows[0].n, 2);
  const t1 = (await q(`select id from project_tasks where title = 'Site survey'`)).rows[0].id;
  assert.equal((await m.post(`/projects/${p.id}/tasks/${t1}`, { status: 'done' })).status, 302);
  assert.ok((await q('select done_at from project_tasks where id = $1', [t1])).rows[0].done_at);
  const page = (await m.get(`/projects/${p.id}`)).text;
  assert.ok(page.includes('Alpha rollout') && page.includes('Site survey') && page.includes('50%'));
  // permissions: an engineer sees projects but cannot edit them, and cannot touch tasks unless on the team
  const e = new Client(); await e.login(eng.email);
  assert.equal((await e.get(`/projects/${p.id}`)).status, 200);
  assert.equal((await e.post(`/projects/${p.id}`, { name: 'Hacked', manager_id: String(eng.id) })).status, 403);
  assert.equal((await e.post(`/projects/${p.id}/tasks`, { title: 'Not on the team' })).status, 403);
  assert.equal((await e.get('/projects/new')).status, 403);
  assert.equal((await m.post(`/projects/${p.id}/team`, { user_id: String(eng.id), role: 'Network engineer' })).status, 302);
  assert.equal((await e.post(`/projects/${p.id}/tasks`, { title: 'Cabling', due_date: '2026-10-20' })).status, 302);
  const o = new Client(); await o.login(out.email);
  assert.equal((await o.post(`/projects/${p.id}/tasks`, { title: 'Sneaky' })).status, 403);
  assert.equal((await m.post(`/projects/${p.id}/team/${ctx.manager.id}/remove`, {})).status, 302);       // the manager cannot be removed
  assert.equal((await q('select count(*)::int as n from project_members where project_id = $1 and user_id = $2', [p.id, ctx.manager.id])).rows[0].n, 1);
  const ag = new Client(); await ag.login(ctx.agent.email);
  assert.equal((await ag.get('/projects')).status, 403);                                                     // service desk agents have no projects
  const cu = new Client(); await cu.login(ctx.aUser.email);
  assert.notEqual((await cu.get('/projects')).status, 200);
  // escalation needs a reason; completing the project closes it
  assert.equal((await m.post(`/projects/${p.id}/escalation`, { escalate: '1', note: '' })).status, 302);
  assert.equal((await q('select escalated from projects where id = $1', [p.id])).rows[0].escalated, false);
  assert.equal((await m.post(`/projects/${p.id}/escalation`, { escalate: '1', note: 'Vendor delay, needs the CEO' })).status, 302);
  assert.equal((await q('select escalated from projects where id = $1', [p.id])).rows[0].escalated, true);
  assert.ok((await m.get('/projects?escalated=1')).text.includes('Alpha rollout'));
  assert.equal((await m.post(`/projects/${p.id}`, { name: 'Alpha rollout', customer_id: String(ctx.A.c.id), manager_id: String(ctx.manager.id), status: 'completed', health: 'green', currency: 'UGX' })).status, 302);
  assert.ok((await q('select closed_at from projects where id = $1', [p.id])).rows[0].closed_at, 'completed projects are closed');
  assert.ok((await q(`select count(*)::int as n from project_events where project_id = $1`, [p.id])).rows[0].n >= 5, 'activity is recorded');
  // a project can start from a won deal
  const deal = (await q(`insert into opportunities (name, customer_id, stage, owner_id, closed_at) values ('Won deal for project', $1, 'won', $2, now()) returning id`, [ctx.A.c.id, ctx.manager.id])).rows[0].id;
  const np = await m.get(`/projects/new?opportunity_id=${deal}`); assert.equal(np.status, 200); assert.ok(np.text.includes('Won deal for project'));
});

test('Operations Overview: the weekly dashboard, per-role tiles, highlights, escalated deals and non-chargeable tickets', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  const bo = await m.get('/business'); assert.equal(bo.status, 301); assert.equal(bo.location, '/operations');
  const page = await m.get('/operations'); assert.equal(page.status, 200);
  for (const t of ['Operations Overview', 'Total Active Pre-Sales Deals', 'Pre-Sales Pipeline Value', 'Active Delivery Projects', 'Closed Pipeline', 'Active SLA Accounts', 'Avg SLA Compliance %', 'SLA Breaches This Week',
    'Open Support Tickets', 'Post-Sale Support Incidents (Non-SLA)', 'B2B Renewal Accounts', 'Non-Chargeable Incidents (Non-SLA)', 'Deals Requiring Escalation', 'Key Highlights This Week', 'Status Summary']) assert.ok(page.text.includes(t), t);
  assert.ok(!page.text.includes('Business Overview'));
  // other weeks, and nonsense
  assert.equal((await m.get('/operations?week=2026-09-28')).status, 200);
  assert.ok((await m.get('/operations?week=2026-09-28')).text.includes('Week 40'));
  assert.equal((await m.get('/operations?week=not-a-date')).status, 200);
  // a deal is escalated by someone who may, and shows on the page; a won deal cannot be escalated
  const deal = (await q(`insert into opportunities (name, customer_id, stage, value, currency, owner_id) values ('Escalate me', $1, 'negotiation', 3000000, 'UGX', $2) returning id`, [ctx.A.c.id, ctx.manager.id])).rows[0].id;
  assert.equal((await m.post(`/pipeline/${deal}/escalation`, { escalate: '1', note: '' })).status, 400);
  assert.equal((await q('select escalated from opportunities where id = $1', [deal])).rows[0].escalated, false);
  assert.equal((await m.post(`/pipeline/${deal}/escalation`, { escalate: '1', note: 'Needs the MD to call the buyer' })).status, 302);
  assert.equal((await q('select escalated from opportunities where id = $1', [deal])).rows[0].escalated, true);
  const after = (await m.get('/operations')).text;
  assert.ok(after.includes('Needing leadership support') && after.includes('Escalate me') && after.includes('Needs the MD to call the buyer'));
  assert.equal((await m.post(`/pipeline/${deal}/stage`, { stage: 'won' })).status, 302);
  assert.equal((await q('select escalated from opportunities where id = $1', [deal])).rows[0].escalated, false, 'winning a deal clears its escalation');
  assert.equal((await m.post(`/pipeline/${deal}/escalation`, { escalate: '1', note: 'again' })).status, 400);
  assert.equal((await q('select escalated from opportunities where id = $1', [deal])).rows[0].escalated, false);
  // highlights: only those who may manage the page write them, and only for a Monday
  const monday = '2026-10-26';
  assert.equal((await m.post('/operations/highlights', { week: monday, top_presales: 'Bank demo went well', major_delivery: 'Contract signed' })).status, 302);
  assert.ok((await m.get(`/operations?week=${monday}`)).text.includes('Bank demo went well'));
  assert.equal((await m.post('/operations/highlights', { week: '2026-10-28', top_presales: 'Wrong day' })).status, 302);
  assert.equal((await q('select count(*)::int as n from weekly_highlights where week_start = $1', ['2026-10-28'])).rows[0].n, 0);
  const ag = new Client(); await ag.login(ctx.agent.email);
  assert.equal((await ag.post('/operations/highlights', { week: monday, top_presales: 'Agent edit' })).status, 403);
  // every role sees only the tiles for records it may see
  const agentPage = (await ag.get('/operations')).text;
  assert.ok(agentPage.includes('Open Support Tickets') && !agentPage.includes('Total Active Pre-Sales Deals') && !agentPage.includes('Active Delivery Projects') && !agentPage.includes('Pipeline Value'));
  const fin = await mkUser('fin-ops@t.local', 'Finance Ops', 'staff', 'finance');
  const f = new Client(); await f.login(fin.email);
  const finPage = (await f.get('/operations')).text;
  assert.ok(finPage.includes('B2B Renewal Accounts') && !finPage.includes('Open Support Tickets') && !finPage.includes('Pre-Sales Pipeline Value'));
  const cu = new Client(); await cu.login(ctx.aUser.email);
  assert.notEqual((await cu.get('/operations')).status, 200);                                               // customers never see it
  // non-chargeable: staff mark a ticket, the change is recorded, customers cannot
  const tk = (await q(`select ref from tickets where customer_id = $1 and type = 'incident' limit 1`, [ctx.A.c.id])).rows[0];
  if (tk) {
    assert.equal((await ag.post(`/tickets/${tk.ref}/billing`, { non_chargeable: '1' })).status, 302);
    assert.equal((await q('select non_chargeable from tickets where ref = $1', [tk.ref])).rows[0].non_chargeable, true);
    assert.equal((await ag.post(`/tickets/${tk.ref}/billing`, { non_chargeable: '0' })).status, 302);
    assert.equal((await q('select non_chargeable from tickets where ref = $1', [tk.ref])).rows[0].non_chargeable, false);
    assert.notEqual((await cu.post(`/tickets/${tk.ref}/billing`, { non_chargeable: '1' })).status, 200);
    assert.equal((await q('select non_chargeable from tickets where ref = $1', [tk.ref])).rows[0].non_chargeable, false, 'customers cannot change billing');
  }
});

// ---------------------------------------------------------------- 1.9.0: the User Manual behind the ? icon
test('User Manual: the ? icon opens it in a new tab; each person reads the sections for their role', async () => {
  const anon = await new Client().get('/manual');
  assert.equal(anon.status, 302); assert.match(anon.location, /^\/login/);

  const ag = new Client(); await ag.login(ctx.agent.email);
  const home = (await ag.get('/')).text;
  assert.match(home, /<a class="iconbtn"[^>]*href="\/manual"[^>]*target="_blank"[^>]*rel="noopener"/);
  const m = await ag.get('/manual');
  assert.equal(m.status, 200);
  for (const part of ['User Manual', 'id="tickets"', 'id="verification"', 'id="roles"', 'Operations Overview']) assert.ok(m.text.includes(part), `the agent's manual lacks ${part}`);
  for (const part of ['id="admin"', 'id="pipeline"', 'id="contracts"']) assert.ok(!m.text.includes(part), `the agent's manual should not have ${part}`);
  assert.ok(!/<script(?![^>]*\bsrc=)/.test(m.text), 'no inline script (strict CSP)');

  const cu = new Client(); await cu.login(ctx.aUser.email);
  assert.match((await cu.get('/portal')).text, /href="\/manual"[^>]*target="_blank"/);
  const cm = await cu.get('/manual');
  assert.equal(cm.status, 200);
  assert.ok(cm.text.includes('id="c-request"') && cm.text.includes('id="c-track"'));
  for (const part of ['id="tickets"', 'id="admin"', 'id="roles"', 'Active Directory']) assert.ok(!cm.text.includes(part), `the customer's manual should not have ${part}`);

  await asAdmin(async (a) => {
    const am = await a.get('/manual');
    assert.equal(am.status, 200); assert.ok(am.text.includes('id="admin"') && am.text.includes('Import users'));
  });
});
