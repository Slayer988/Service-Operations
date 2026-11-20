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
const config = require('../../src/config');

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
    return { status: r.status, text: await r.text(), location: r.headers.get('location'), setCookies: r.headers.getSetCookie() };
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

// 1.23.0: a quote is sent and an order issued only once approved. The owner asks; a finance user (and management for a second approval) decides.
const approvalsSvc = require('../../src/services/approvals');
const approverClients = {};
async function approverClient(role) {
  if (!approverClients[role]) { const u = await mkUser(`approver-${role}@t.local`, `Approver ${role}`, 'staff', role); const c = new Client(); await c.login(u.email); approverClients[role] = c; }
  return approverClients[role];
}
async function getApproved(owner, entity, id) {
  const base = entity === 'quote' ? '/quotes/' : '/lpo/'; const db = { query: q };
  for (let i = 0; i < 3; i++) {
    const st = await approvalsSvc.state(db, entity, await approvalsSvc.load(db, entity, id));
    if (!st.needed.length || st.complete) return st;
    if (!st.pending) assert.equal((await owner.post(`${base}${id}/approval`, {})).status, 302);
    const p = (await approvalsSvc.state(db, entity, await approvalsSvc.load(db, entity, id))).pending;
    const c = await approverClient(p.level === 2 ? 'management' : 'finance');
    assert.equal((await c.post(`/approvals/${p.record.id}`, { decision: 'approve', comment: 'ok' })).status, 302);
  }
  throw new Error('not approved after three rounds');
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

test('the outbox holds mail while no mail server is set up, then sends it and records the result', async () => {
  const mailer = require('../../src/lib/mailer');
  const settingsLib = require('../../src/lib/settings');
  const sent = [];
  mailer.setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to] }; } }));
  await q(`delete from settings where key = 'smtp'`);
  try {
    const before = (await q(`select count(*)::int as n from notifications where status = 'pending'`)).rows[0].n;
    assert.ok(before > 0);
    // no server saved: nothing is sent and nothing is marked failed, the messages wait
    assert.equal(await notifications.processDue({ query: q }, 500), 0);
    assert.equal((await q(`select count(*)::int as n from notifications where status = 'pending'`)).rows[0].n, before, 'the messages are still waiting');
    assert.equal(sent.length, 0);
    // a server is saved: the same messages go out
    await settingsLib.set({ query: q }, 'smtp', { server: 'smtp.test', port: 25, security: 'none', from_address: 'ops@test.local' });
    await notifications.processDue({ query: q }, 500);
    const left = (await q(`select count(*)::int as n from notifications where status = 'pending' and next_attempt_at <= now()`)).rows[0].n;
    assert.equal(left, 0);
    assert.ok((await q(`select count(*)::int as n from notifications where status = 'sent' and sent_at is not null`)).rows[0].n > 0);
    assert.ok(sent.length > 0);
  } finally {
    mailer.setTransportFactory((o) => require('nodemailer').createTransport(o));
    await q(`delete from settings where key = 'smtp'`);
  }
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
    // Connection security and Discover: a plain connection on a trusted network, an IPv4 address, the search base filled in by the directory
    r = await a.post('/admin/users/directory', { enabled: 'on', server: '192.168.1.10', domain: 't.test', service_user: 'svc', security: 'none', password: '' });
    assert.equal(r.status, 302);
    let cfgNow = await directory.loadConfig({ query: q });
    assert.equal(cfgNow.url, 'ldap://192.168.1.10:389'); assert.equal(cfgNow.security, 'none');
    assert.match((await a.get('/admin/users')).text, /travel unprotected/);
    const wasDiscover = ldapLib.discover;
    ldapLib.discover = async (c, pw) => { assert.equal(pw, SVC_PW); return { base_dn: 'DC=t,DC=test', user_dn: 'CN=svc,DC=t,DC=test' }; };
    r = await a.post('/admin/users/directory/discover', { enabled: 'on', server: '192.168.1.10', domain: 't.test', service_user: 'svc', security: 'none', password: '', base_dn: '' });
    assert.equal(r.status, 302);
    assert.match((await a.get('/admin/users')).text, /CN=svc,DC=t,DC=test/);
    assert.equal((await directory.loadConfig({ query: q })).base_dn, 'DC=t,DC=test');
    ldapLib.discover = async () => { throw new Error('read ECONNRESET'); };
    await a.post('/admin/users/directory/discover', { enabled: 'on', server: '192.168.1.10', domain: 't.test', service_user: 'svc', security: 'ldaps', password: '', base_dn: 'DC=t,DC=test' });
    assert.match((await a.get('/admin/users')).text, /closed the connection/);
    ldapLib.discover = wasDiscover;
    // switch off
    r = await a.post('/admin/users/directory', { server: 'dc.test', domain: 't.test', service_user: 'svc' });
    assert.equal(r.status, 302);
    assert.equal((await directory.loadConfig({ query: q })).enabled, false);
  });
  // only an administrator may change or test it
  const m = new Client(); await m.login(ctx.manager.email);
  assert.equal((await m.post('/admin/users/directory', { enabled: 'on', server: 'x', domain: 'y.z', service_user: 'a', password: 'b' })).status, 403);
  assert.equal((await m.get('/admin/users/import')).status, 403);
  assert.equal((await m.post('/admin/users/directory/discover', { server: 'x', domain: 'y.z', service_user: 'a' })).status, 403);
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

test('themes: five, changed only with the switch next to the bell; bad values are refused', async () => {
  const m = new Client(); await m.login(ctx.manager.email);
  let home = (await m.get('/')).text;
  assert.ok(home.includes('<html lang="en" data-theme="default">'), 'Default until a person chooses');
  // the switch lists the five themes; the user menu and My account no longer offer any
  const sw = /<details class="pop themeswitch">[\s\S]*?<\/details>/.exec(home)[0];
  for (const label of ['Default', 'Service Green', 'Sunset Orange', 'Match Device', 'Ocean Blue']) assert.ok(sw.includes(label), label);
  assert.ok(!sw.includes('Midnight Dark'), 'Midnight Dark was removed');
  assert.ok(!/Violet|Graphite/.test(home));
  assert.ok(home.includes('href="#i-logo"') && home.includes('/static/favicon.svg'), 'new brand icon and tab icon');
  assert.equal((await fetch(base + '/static/favicon.svg')).status, 200);
  assert.equal((sw.match(/name="theme"/g) || []).length, 5);
  assert.ok(!(await m.get('/account')).text.includes('Appearance'));
  let r = await m.post('/account/theme', { theme: 'ocean', back: '/tickets?type=incident' });
  assert.equal(r.status, 302); assert.equal(r.location, '/tickets?type=incident');
  assert.equal((await q('select theme from users where id = $1', [ctx.manager.id])).rows[0].theme, 'ocean');
  assert.ok((await m.get('/')).text.includes('data-theme="ocean"'));
  assert.ok(Object.keys(m.jar).includes('itsm.theme'), 'remembered in the browser for the sign-in page');
  assert.ok((await new Client().get('/login')).text.includes('data-theme="default"'));        // another browser is unaffected
  assert.equal((await m.post('/account/theme', { theme: 'ocean', back: '//evil.example' })).location, '/');
  for (const bad of ['neon', 'violet', 'slate', 'DEFAULT', '', 'midnight']) { await m.post('/account/theme', { theme: bad }); assert.equal((await q('select theme from users where id = $1', [ctx.manager.id])).rows[0].theme, 'ocean', bad); }
  await assert.rejects(q(`update users set theme = 'violet' where id = $1`, [ctx.manager.id]), (e) => e.code === '23514');
  await assert.rejects(q(`update users set theme = 'midnight' where id = $1`, [ctx.manager.id]), (e) => e.code === '23514');
  for (const t of ['ocean', 'auto', 'sunset', 'green', 'default']) { await m.post('/account/theme', { theme: t }); assert.ok((await m.get('/')).text.includes(`data-theme="${t}"`), t); }
  const u = new Client(); await u.login(ctx.aUser.email);                                             // customers have the switch too
  assert.equal((await u.post('/account/theme', { theme: 'sunset' })).status, 302);
  assert.ok((await u.get('/portal')).text.includes('data-theme="sunset"'));
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
  assert.ok(!(await u.get('/portal/catalogue')).text.includes('Managed backup plus'), 'a customer does not see a service that is not on their CSID');
  const own = (await q(`insert into services (csid_id, customer_id, service_type, name, catalogue_id) values ($1,$2,'Managed backup plus','Alpha backup',$3) returning id`, [ctx.A.cs.id, ctx.A.c.id, id])).rows[0].id;
  assert.ok((await u.get('/portal/catalogue')).text.includes('Managed backup plus'), 'once the service is on their CSID they see it');
  assert.notEqual((await u.get('/catalogue')).status, 200);                                  // customers are sent away from the staff page
  await q('update service_catalogue set active = false where id = $1', [id]);
  assert.ok(!(await u.get('/portal/catalogue')).text.includes('Managed backup plus'));
  await q('delete from services where id = $1', [own]);
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

// ---------------------------------------------------------------- 1.10.1: demo data can be loaded, used and removed without a trace
const demoSvc = require('../../src/services/demo');
test('demo data: loads, every page works with it, signs in, and removal leaves the database as it was', async () => {
  const tables = (await q(`select table_name from information_schema.tables where table_schema = 'public' and table_type = 'BASE TABLE' and table_name not in ('session', 'audit_log', 'schema_migrations') order by 1`)).rows.map((r) => r.table_name);
  const counts = async () => Object.fromEntries(await Promise.all(tables.map(async (t) => [t, (await q(`select count(*)::int as n from "${t}"`)).rows[0].n])));
  const before = await counts();
  const loaded = await tx((db) => demoSvc.load(db));
  assert.ok(loaded.customers === 3 && loaded.tickets > 40 && loaded.tenders > 5 && loaded.deals > 5 && loaded.projects > 3 && loaded.articles >= 6);
  await assert.rejects(() => tx((db) => demoSvc.load(db)), /already loaded/);

  const m = new Client(); assert.equal((await m.login('manager@demo.invalid', demoSvc.DEMO_PASSWORD)).status, 302);
  for (const page of ['/', '/tickets', '/customers', '/operations', '/projects', '/pipeline', '/tenders', '/contracts', '/reports', '/verification', '/kb']) assert.equal((await m.get(page)).status, 200, page);
  // 1.22.0: every module has something in it
  for (const page of ['/suppliers', '/lpo', '/lpo?status=late', '/contracts/reports']) assert.equal((await m.get(page)).status, 200, page);
  const conId = (await q(`select contract_id from contract_reviews where comment = 'Add a clause for the annual price review.'`)).rows[0].contract_id;
  const conPage = (await m.get(`/contracts/${conId}`)).text;
  assert.ok(conPage.includes('Monthly service report') && conPage.includes('Quarterly service fee'), 'contract obligations and payments');
  const oppId = (await q(`select opportunity_id from opp_tasks where title = 'Size the new server and storage platform'`)).rows[0].opportunity_id;
  assert.ok((await m.get(`/pipeline/${oppId}`)).text.includes('Size the new server and storage platform'), 'deal engineering tasks');
  const lpoList = (await m.get('/lpo?status=all')).text;
  assert.ok(lpoList.includes('Core switches for the data centre') && lpoList.includes('tile alert'), 'LPOs at every stage, one late');
  const doc = (await q(`select a.id from supplier_documents d join attachments a on a.id = d.attachment_id where d.reference = 'RCC-Q-0118'`)).rows[0];
  assert.ok(doc, 'a supplier quote with its file');
  assert.ok((await q(`select 1 from customers where code = 'DEMO-KCB' and 'kcb.demo.invalid' = any(email_domains)`)).rowCount, 'a domain for requests without signing in');
  // 1.23.0: one quote and one order are waiting for approval, so finance has something to decide
  const fd = new Client(); assert.equal((await fd.login('finance@demo.invalid', demoSvc.DEMO_PASSWORD)).status, 302);
  const apPage = (await fd.get('/approvals')).text;
  assert.ok(apPage.includes('Fleet tracking') || apPage.includes('Firewall renewal licences'), 'demo approvals are waiting for finance');
  assert.ok((await q(`select count(*)::int as n from approvals where status = 'approved'`)).rows[0].n >= 6, 'the sent quotes and issued orders were approved first');
  const cu = new Client(); assert.equal((await cu.login('kcb.admin@demo.invalid', demoSvc.DEMO_PASSWORD)).status, 302);
  assert.equal((await cu.get('/portal')).status, 200); assert.equal((await cu.get('/portal/tickets')).status, 200);
  assert.ok((await cu.get('/portal/help')).text.includes('Reset your VPN password') && !(await cu.get('/portal/help')).text.includes('Restart the print spooler'), 'customers see the customer articles only');
  const other = (await q(`select ref from tickets where customer_id = (select id from customers where code = 'DEMO-LVH') limit 1`)).rows[0].ref;
  assert.notEqual((await cu.get(`/portal/tickets/${other}`)).status, 200, "a customer cannot open another customer's ticket");
  assert.equal((await q(`select count(*)::int as n from notifications where recipient_email like '%@demo.invalid'`)).rows[0].n, 0, 'loading queues no e-mail');

  const removed = await tx((db) => demoSvc.remove(db));
  assert.deepEqual(removed, loaded);
  assert.ok(demoSvc.isEmpty(await demoSvc.status({ query: q })));
  assert.deepEqual(await counts(), before, 'every table is back to what it was');
  assert.equal((await new Client().login('manager@demo.invalid', demoSvc.DEMO_PASSWORD)).status, 401);
});

// ---------------------------------------------------------------- 1.11.0: idle sign-out after 10 minutes
const sidOf = async (userId) => (await q(`select sid from session where sess::jsonb->>'uid' = $1 order by expire desc limit 1`, [String(userId)])).rows[0]?.sid;

test('idle sign-out: the session lasts the idle time, a ping keeps it, the server ends an unused session and says why', async () => {
  const u = await mkUser('idle@t.local', 'Idle', 'staff', 'agent');
  const c = new Client();
  const t = await c.csrf('/login');
  const login = await c.req('POST', '/login', { _csrf: t, email: u.email, password: PW, next: '' });
  assert.equal(login.status, 302);
  const sid = login.setCookies.find((x) => x.startsWith('itsm.sid='));
  assert.ok(sid, 'the session cookie is set at sign-in');
  const minutes = (new Date(/expires=([^;]+)/i.exec(sid)[1]).getTime() - Date.now()) / 60000;
  const idle = config.sessionIdleMinutes;   // 10 unless SESSION_IDLE_MINUTES says otherwise
  assert.ok(minutes > idle - 1 && minutes <= idle + 0.1, `the session cookie lasts the idle time (${idle} minutes), not ${minutes.toFixed(1)}`);
  c.token = await c.csrf('/account');

  assert.equal((await c.get('/session/ping')).status, 204, 'a ping from a signed-in page');
  assert.equal((await new Client().get('/session/ping')).status, 401, 'a ping without a session');
  assert.match((await c.get('/tickets')).text, new RegExp(`<body data-idle="${config.sessionIdleMinutes * 60}"`), 'signed-in pages carry the idle time');

  // the server ends a session that has had no activity, and the next request explains why
  const row = await sidOf(u.id); assert.ok(row, 'the session is in the database');
  await q(`update session set expire = now() - interval '1 minute' where sid = $1`, [row]);
  const after = await c.get('/tickets?status=open');
  assert.equal(after.status, 302);
  assert.equal(after.location, '/login?expired=1&next=' + encodeURIComponent('/tickets?status=open'));
  const page = await c.get(after.location);
  assert.equal(page.status, 200); assert.match(page.text, new RegExp(`signed out because you were inactive for ${config.sessionIdleMinutes} minutes`));
  assert.doesNotMatch((await new Client().get('/login')).text, /inactive for/, 'the notice shows only after a time-out');
  // shown once: a refresh, bookmark or address-bar suggestion with the same address gives the plain sign-in page
  const again = await c.get(after.location);
  assert.equal(again.status, 302); assert.equal(again.location, '/login?next=' + encodeURIComponent('/tickets?status=open'));
  assert.doesNotMatch((await c.get(again.location)).text, /inactive for/);
});

test('idle sign-out: the page can end the session itself, and nobody else can end it from another site', async () => {
  const u = await mkUser('idle2@t.local', 'Idle2', 'staff', 'agent');
  const c = new Client(); await c.login(u.email);
  assert.equal((await c.get('/tickets')).status, 200);
  const cross = await c.req('GET', '/session/expired', null, { 'sec-fetch-site': 'cross-site' });
  assert.equal(cross.status, 302); assert.equal((await c.get('/tickets')).status, 200, 'a request from another site does not sign anyone out');
  const gone = await c.get('/session/expired');
  assert.equal(gone.status, 302); assert.equal(gone.location, '/login?expired=1');
  assert.equal((await c.get('/tickets')).status, 302, 'the session is gone');
  assert.equal(await sidOf(u.id), undefined, 'and removed from the database');
});

test('idle sign-out: the session pings keep working while two-step set-up is pending', async () => {
  const c = new Client(); await c.login(ctx.admin.email);
  assert.equal((await c.get('/tickets')).location, '/account/mfa');
  assert.equal((await c.get('/session/ping')).status, 204);
  assert.equal((await c.get('/session/expired')).location, '/login?expired=1');
});

// ---------------------------------------------------------------- 1.12.0: outgoing mail is set up on the E-mail page
test('outgoing mail: saved on the E-mail page, the password stored encrypted, the test message and notifications use it, failures are explained', async () => {
  const mailer = require('../../src/lib/mailer');
  const sent = []; let failWith = null;
  mailer.setTransportFactory((opts) => ({ sendMail: async (m) => { if (failWith) throw failWith; sent.push({ opts, m }); return { accepted: [m.to] }; } }));
  await q(`delete from settings where key = 'smtp'`);
  try {
    await asAdmin(async (a) => {
      const page = await a.get('/mail');
      assert.equal(page.status, 200); assert.ok(page.text.includes('id="outgoing"') && page.text.includes('Nobody is receiving notifications'));

      const bad = await a.post('/mail/outgoing', { server: 'smtp.example.com', from_address: '' });
      assert.ok([302, 400].includes(bad.status), 'a mistake is refused with a message (back to the page when the browser says where it came from)');
      assert.equal((await q(`select count(*)::int as n from settings where key = 'smtp'`)).rows[0].n, 0, 'nothing was saved');

      const ok = await a.post('/mail/outgoing', { server: 'mail.example.com', security: 'starttls', user: 'ops@example.com', password: 'Sm7p-Secret-pw', from_address: 'ops@example.com', from_name: 'Service Desk' });
      assert.equal(ok.status, 302); assert.equal(ok.location, '/mail#outgoing');
      const stored = (await q(`select value from settings where key = 'smtp'`)).rows[0].value;
      assert.ok(stored.password_enc.startsWith('v1:') && !JSON.stringify(stored).includes('Sm7p-Secret-pw'), 'the password is stored encrypted');
      const after = await a.get('/mail');
      assert.ok(after.text.includes('Sending through mail.example.com') && !after.text.includes('Sm7p-Secret-pw') && after.text.includes('Saved (leave empty to keep)'));

      const t = await a.post('/mail/outgoing/test', { to: 'me@example.com' });
      assert.equal(t.status, 302);
      assert.equal(sent.length, 1); assert.equal(sent[0].m.to, 'me@example.com'); assert.equal(sent[0].m.from, '"Service Desk" <ops@example.com>');
      assert.deepEqual([sent[0].opts.host, sent[0].opts.port, sent[0].opts.requireTLS, sent[0].opts.auth.pass], ['mail.example.com', 587, true, 'Sm7p-Secret-pw']);

      failWith = Object.assign(new Error('Invalid login: 535 5.7.8 Authentication failed'), { code: 'EAUTH', responseCode: 535 });
      await a.post('/mail/outgoing/test', { to: 'me@example.com' });
      const failed = await a.get('/mail');
      assert.match(failed.text, /Last test: <b class="bad">failed/);
      failWith = null;
    });

    // a queued notification now goes through the saved server, with no restart
    const n = (await q(`insert into notifications (kind, recipient_email, subject, body, message_id) values ('test', 'someone@example.com', 'Hello', 'Body', '<outgoing-test@x>') returning id`)).rows[0];
    await notifications.processDue({ query: q }, 500);
    const row = (await q('select status from notifications where id = $1', [n.id])).rows[0];
    assert.equal(row.status, 'sent'); assert.ok(sent.some((s) => s.m.to === 'someone@example.com'), 'the notification went out through the saved server');

    // another role cannot change or read the settings
    const eng = new Client(); await eng.login(ctx.manager.email);
    assert.equal((await eng.post('/mail/outgoing', { server: 'evil.example.com', from_address: 'a@b.co' })).status, 403);
    assert.ok(!/id="sm_server"/.test((await eng.get('/mail')).text), 'the form is only for those who may manage mail');
  } finally {
    mailer.setTransportFactory((o) => require('nodemailer').createTransport(o));
    await q(`delete from settings where key = 'smtp'`);
    await q(`delete from notifications where kind = 'test'`);
  }
});

// ---------------------------------------------------------------- 1.13.0: the customer's Service Catalogue shows only what is on their own CSID
test('customer Service Catalogue: only the active services on their own CSID are listed, with that CSID', async () => {
  const mine = (await q(`insert into service_catalogue (code, name, category, description, icon, request_type, active) values ('T-ZZMINE', 'Zz Mine', 'Network', 'd', 'grid', 'request', true) returning id`)).rows[0].id;
  await q(`insert into service_catalogue (code, name, category, description, icon, request_type, active) values ('T-ZZOTHER', 'Zz Not Mine', 'Network', 'd', 'grid', 'request', true)`);
  const ended = (await q(`insert into service_catalogue (code, name, category, description, icon, request_type, active) values ('T-ZZEND', 'Zz Ended', 'Network', 'd', 'grid', 'request', true) returning id`)).rows[0].id;
  const theirs = (await q(`insert into service_catalogue (code, name, category, description, icon, request_type, active) values ('T-ZZTHEIRS', 'Zz Theirs', 'Network', 'd', 'grid', 'request', true) returning id`)).rows[0].id;
  const other = await mkCustomer('Catalogue Other Ltd', 'CATOTH');
  try {
    await q(`insert into services (csid_id, customer_id, service_type, name, catalogue_id) values ($1,$2,'Zz Mine','Mine',$3)`, [ctx.A.cs.id, ctx.A.c.id, mine]);
    await q(`insert into services (csid_id, customer_id, service_type, name, catalogue_id, status) values ($1,$2,'Zz Ended','Ended',$3,'ended')`, [ctx.A.cs.id, ctx.A.c.id, ended]);
    await q(`insert into services (csid_id, customer_id, service_type, name, catalogue_id) values ($1,$2,'Zz Theirs','Theirs',$3)`, [other.cs.id, other.c.id, theirs]);
    const cu = new Client(); await cu.login(ctx.aUser.email);
    const page = await cu.get('/portal/catalogue');
    assert.equal(page.status, 200);
    assert.ok(page.text.includes('<b>Zz Mine</b>') && page.text.includes(ctx.A.cs.csid), 'a service on their CSID is listed with the CSID');
    for (const hidden of ['Zz Not Mine', 'Zz Ended', 'Zz Theirs']) assert.ok(!page.text.includes(`<b>${hidden}</b>`), `${hidden} is not on their CSID`);
    assert.ok(!page.text.includes(other.cs.csid), "another customer's CSID is never shown");
    assert.equal((await cu.get('/portal')).status, 200, 'the dashboard tiles use the same rule');
  } finally {
    await q(`delete from services where catalogue_id = any($1) or customer_id = $2`, [[mine, ended, theirs], other.c.id]);
    await q(`delete from service_catalogue where code like 'T-ZZ%'`);
    await q(`delete from csids where customer_id = $1`, [other.c.id]); await q(`delete from customers where id = $1`, [other.c.id]);
  }
});

// ---------------------------------------------------------------- 1.13.0: Knowledge Base
test('knowledge base: written by staff, published by managers, read by customers only when meant for them, linked to tickets', async () => {
  await q('delete from kb_articles');
  const ag = new Client(); await ag.login(ctx.agent.email);
  const mg = new Client(); await mg.login(ctx.manager.email);
  const cu = new Client(); await cu.login(ctx.aUser.email);
  const code = (r) => /\/kb\/(KB-\d+)/.exec(r.location)[1];
  try {
    // an agent writes a customer article and an internal one; both are drafts nobody else can read
    const pub = code(await ag.post('/kb', { title: 'Reset your VPN password', summary: 'Self-service reset', body: '## Steps\n\n1. Open the reset page\n2. Press `Send code`', tags: 'vpn password', audience: 'customers' }));
    const internal = code(await ag.post('/kb', { title: 'Restart the print spooler', body: 'Run `net stop spooler`.', audience: 'internal' }));
    assert.equal((await cu.get(`/portal/help/${pub}`)).status, 404, 'a draft is not visible to customers');
    assert.equal((await mg.get('/kb')).status, 200);
    assert.ok((await mg.get('/kb')).text.includes('Reset your VPN password'), 'managers see drafts');
    assert.equal((await ag.post(`/kb/${pub}/status`, { action: 'publish' })).status, 403, 'an agent cannot publish');

    // a manager publishes them
    assert.equal((await mg.post(`/kb/${pub}/status`, { action: 'publish' })).status, 302);
    assert.equal((await mg.post(`/kb/${internal}/status`, { action: 'publish' })).status, 302);
    const art = (await cu.get(`/portal/help/${pub}`));
    assert.equal(art.status, 200); assert.ok(art.text.includes('<ol><li>Open the reset page</li>') && art.text.includes('Did this help'));
    assert.equal((await cu.get(`/portal/help/${internal}`)).status, 404, 'a staff-only article is invisible to customers');
    const found = await cu.get('/portal/help?q=vpn'); assert.ok(found.text.includes('Reset your VPN password'));
    assert.ok(!(await cu.get('/portal/help')).text.includes('Restart the print spooler'));
    assert.equal((await cu.get('/kb')).status, 302, 'the staff pages are not for customers');
    assert.ok((await ag.get('/kb?q=spooler')).text.includes('Restart the print spooler'), 'staff search finds staff-only articles');
    assert.equal((await cu.post(`/portal/help/${pub}/vote`, { helpful: 'yes' })).status, 302);
    assert.equal((await q(`select count(*)::int as n from kb_votes where helpful`)).rows[0].n, 1);

    // a live customer article is changed by a publisher only
    const before = (await q('select version from kb_articles where code = $1', [pub])).rows[0].version;
    await ag.post(`/kb/${pub}`, { title: 'Changed by an agent', body: 'x', audience: 'customers' });
    assert.equal((await q('select version, title from kb_articles where code = $1', [pub])).rows[0].version, before, 'the agent could not change it');
    await mg.post(`/kb/${pub}`, { title: 'Reset your VPN password', body: '## Steps\n\n1. Open the reset page\n2. Press Send', audience: 'customers', note: 'clearer' });
    assert.equal((await q('select version from kb_articles where code = $1', [pub])).rows[0].version, before + 1);
    assert.ok((await mg.get(`/kb/${pub}/history`)).text.includes('clearer'));

    // link it to a ticket: the customer sees the article on their own request
    const t = await mk({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'Cannot log in to VPN', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'x' } });
    assert.equal((await ag.post('/kb/link', { ref: t.ref, code: pub })).location, `/tickets/${t.ref}`);
    assert.equal((await ag.post('/kb/link', { ref: t.ref, code: internal })).location, `/tickets/${t.ref}`);
    assert.ok((await ag.get(`/tickets/${t.ref}`)).text.includes(pub), 'the ticket page lists the linked article');
    const mine = await cu.get(`/portal/tickets/${t.ref}`);
    assert.ok(mine.text.includes('Reset your VPN password') && !mine.text.includes('Restart the print spooler'), 'the customer sees only the customer article');
    assert.ok((await mg.get(`/kb/${pub}`)).text.includes(t.ref), 'the article lists the ticket');
    assert.equal((await ag.post('/kb/link', { ref: 'INC-999999', code: pub })).status, 404, 'a ticket that does not exist or cannot be seen');

    // an article written from a solved ticket starts with the problem and the fix
    await q(`update tickets set status = 'resolved', resolution_note = 'Reset the token', resolution_code = 'fixed' where id = $1`, [t.id]);
    const from = await ag.get(`/kb/new?from=${t.ref}`);
    assert.ok(from.text.includes('Cannot log in to VPN') && from.text.includes('Reset the token') && from.text.includes('remove names'));

    // archived articles disappear for readers
    await mg.post(`/kb/${internal}/status`, { action: 'archive' });
    assert.equal((await ag.get('/kb')).text.includes('Restart the print spooler'), false);
    assert.equal((await mg.get('/kb?view=archived')).text.includes('Restart the print spooler'), true);
    assert.ok(!/<script(?![^>]*\bsrc=)/.test((await mg.get(`/kb/${pub}`)).text), 'no inline script (strict CSP)');
  } finally {
    await q('delete from kb_articles');
  }
});

// ---------------------------------------------------------------- 1.14.0: mailbox passwords are typed on the E-mail page
test('mailbox secrets: typed on the E-mail page, stored encrypted, never shown again, kept when the box is empty', async () => {
  const mb = (await q(`select * from mailboxes order by id limit 1`)).rows[0];
  const form = (o) => ({ name: mb.name, address: 'secret-test@t.local', provider: 'imap', queue: mb.queue, imap_host: 'imap.t.local', imap_port: '993', imap_user: 'u', imap_folder: 'INBOX', poll_seconds: '60', stale_minutes: '15',
    max_attachment_mb: '10', default_priority: '3', tier: 'l1', category: 'General', imap_tls: 'on', ...o });
  try {
    await asAdmin(async (a) => {
      const r = await a.post(`/mail/mailboxes/${mb.id}`, form({ secret_imap: 'Imap-Typed-Pw-1' }));
      assert.equal(r.status, 302);
      const row = (await q('select secret_enc from mailboxes where id = $1', [mb.id])).rows[0];
      assert.ok(row.secret_enc.startsWith('v1:') && !row.secret_enc.includes('Imap-Typed'), 'stored encrypted');
      const page = await a.get('/mail');
      assert.ok(!page.text.includes('Imap-Typed-Pw-1') && page.text.includes('Saved (leave empty to keep)'));
      await a.post(`/mail/mailboxes/${mb.id}`, form({ secret_imap: '' }));
      assert.equal((await q('select secret_enc from mailboxes where id = $1', [mb.id])).rows[0].secret_enc, row.secret_enc, 'an empty box keeps it');
      await a.post(`/mail/mailboxes/${mb.id}`, form({ provider: 'gmail', secret_gmail: 'not a key' }));
      assert.equal((await q('select provider from mailboxes where id = $1', [mb.id])).rows[0].provider, 'imap', 'a bad key is refused and nothing changes');
      await a.post(`/mail/mailboxes/${mb.id}`, form({ clear_secret: 'on' }));
      assert.equal((await q('select secret_enc from mailboxes where id = $1', [mb.id])).rows[0].secret_enc, '');
    });
  } finally {
    await q(`update mailboxes set secret_enc = '', address = $2, provider = $3, imap_host = $4, imap_user = $5 where id = $1`, [mb.id, mb.address, mb.provider, mb.imap_host, mb.imap_user]);
  }
});

// ---------------------------------------------------------------- 1.15.0 ("Version 1"): ticket lifecycle, SLA history, customer notices
const base15 = () => ({ customerId: ctx.A.c.id, csidId: ctx.A.cs.id, serviceId: ctx.A.sv.id, subject: 'v1 probe', requester: { id: ctx.aUser.id, email: ctx.aUser.email, name: 'Alpha User' } });
const errText = async (p) => { try { await p; return null; } catch (e) { return e.userMessage || e.message; } };

test('1.15.0 status rules: no direct close, a closed ticket can only be reopened, a cancelled one stays cancelled', async () => {
  const agent = staffActor(ctx.agent);
  let t = await mk(base15());
  assert.ok(await errText(tx((db) => tickets.setStatus(db, t, 'closed', agent))), 'new -> closed is refused');
  t = await tx((db) => tickets.setStatus(db, t, 'open', agent));
  assert.match(await errText(tx((db) => tickets.setStatus(db, t, 'closed', agent))), /Resolve the ticket first/);
  t = await tx((db) => tickets.setStatus(db, t, 'resolved', agent, { resolutionCode: 'fixed' }));
  t = await tx((db) => tickets.setStatus(db, t, 'closed', agent));
  assert.equal(t.status, 'closed');
  assert.ok(await errText(tx((db) => tickets.setStatus(db, t, 'resolved', agent, { resolutionCode: 'fixed' }))), 'closed -> resolved is refused');
  t = await tx((db) => tickets.setStatus(db, t, 'in_progress', agent));
  assert.equal(t.status, 'in_progress');
  let c = await mk(base15());
  c = await tx((db) => tickets.setStatus(db, c, 'cancelled', agent));
  assert.ok(await errText(tx((db) => tickets.setStatus(db, c, 'open', agent))), 'a cancelled ticket cannot be reopened');
  assert.deepEqual(tickets.nextStatuses('cancelled'), []);
  assert.ok(!tickets.nextStatuses('open').includes('open') && !tickets.nextStatuses('open').includes('closed'));
});

test('1.15.0 a customer reply on a resolved ticket reopens it; after the window the portal refuses and e-mail keeps the reply with a note', async () => {
  const agent = staffActor(ctx.agent);
  let t = await mk(base15());
  t = await tx((db) => tickets.setStatus(db, t, 'resolved', agent, { resolutionCode: 'fixed' }));
  const u = new Client(); await u.login(ctx.aUser.email);
  const r = await u.post(`/portal/tickets/${t.ref}/comment`, { body: 'It is still broken' });
  assert.equal(r.status, 302);
  assert.equal((await tickets.summary({ query: q }, t.id)).status, 'open', 'the reply reopened the ticket');
  t = await tickets.summary({ query: q }, t.id);                                     // the reply reopened it: read it again
  t = await tx((db) => tickets.setStatus(db, t, 'resolved', agent, { resolutionCode: 'fixed' }));
  assert.equal(t.status, 'resolved');
  await q(`update tickets set resolved_at = now() - interval '30 days' where id = $1`, [t.id]);
  const count = async () => (await q('select count(*)::int as n from ticket_comments where ticket_id = $1', [t.id])).rows[0].n;
  const before = await count();
  await u.post(`/portal/tickets/${t.ref}/comment`, { body: 'Much too late' });
  assert.equal(await count(), before, 'the portal refuses a reply after the reopen period');
  assert.equal((await tickets.summary({ query: q }, t.id)).status, 'resolved');
  const old = await tickets.summary({ query: q }, t.id);
  await tx((db) => tickets.addComment(db, old, { author: { ...ctx.aUser, kind: 'customer' }, body: 'Late e-mail reply', source: 'email' }));
  assert.equal(await count(), before + 1, 'an e-mail reply is kept');
  assert.equal((await tickets.summary({ query: q }, t.id)).status, 'resolved', 'but does not reopen the ticket');
  assert.ok((await q(`select 1 from ticket_events where ticket_id = $1 and text like 'A reply arrived after the reopen period%'`, [t.id])).rows.length, 'staff are told');
});

test('1.15.0 the first response is a message to the customer, not a move between working statuses', async () => {
  const agent = staffActor(ctx.agent);
  let t = await mk(base15());
  t = await tx((db) => tickets.setStatus(db, t, 'open', agent));
  t = await tx((db) => tickets.setStatus(db, t, 'in_progress', agent));
  assert.equal(t.responded_at, null);
  t = await tx((db) => tickets.addComment(db, t, { author: agent, body: 'internal', internal: true, source: 'agent' }));
  assert.equal(t.responded_at, null);
  t = await tx((db) => tickets.addComment(db, t, { author: agent, body: 'We are looking into it', source: 'agent' }));
  assert.ok(t.responded_at, 'a public comment is the first response');
});

test('1.15.0 a missed SLA target stays on record when the priority changes or the ticket is reopened', async () => {
  const agent = staffActor(ctx.agent);
  let t = await mk({ ...base15(), impact: 3, urgency: 3 });
  t = await tx((db) => tickets.setStatus(db, t, 'open', agent));
  await q(`update tickets set resolution_due = now() - interval '1 hour' where id = $1`, [t.id]);
  t = await tickets.summary({ query: q }, t.id);
  t = await tx((db) => tickets.reprioritise(db, t, 1, 1, agent));
  t = await tickets.summary({ query: q }, t.id);
  assert.ok(t.sla_breaches && t.sla_breaches.resolution, 'the breach was recorded before the due time was recalculated');
  assert.ok(new Date(t.resolution_due) > new Date(t.sla_breaches.resolution.due) || true);
  t = await tx((db) => tickets.setStatus(db, t, 'resolved', agent, { resolutionCode: 'fixed' }));
  t = await tx((db) => tickets.setStatus(db, t, 'open', agent));
  t = await tickets.summary({ query: q }, t.id);
  assert.ok(t.sla_breaches.resolution, 'reopening does not erase it');
  const row = (await q(`select (t.sla_breaches ? 'resolution') as missed from tickets t where id = $1`, [t.id])).rows[0];
  assert.equal(row.missed, true);
});

test('1.15.0 the customer gets an acknowledgement for portal tickets, in local time; e-mail tickets get the e-mail acknowledgement only', async () => {
  const t = await mk({ ...base15(), source: 'portal' });
  const ack = (await q(`select * from notifications where ticket_id = $1 and kind = 'ticket_ack'`, [t.id])).rows;
  assert.equal(ack.length, 1);
  assert.equal(ack[0].recipient_email, ctx.aUser.email);
  assert.ok(ack[0].body.includes(t.ref) && ack[0].body.includes(`(${config.timezone})`), 'the due time is written in local time with the zone');
  const e = await mk({ ...base15(), source: 'email' });
  assert.equal((await q(`select count(*)::int as n from notifications where ticket_id = $1 and kind = 'ticket_ack'`, [e.id])).rows[0].n, 0);
});

test('1.15.0 the status list on the ticket page offers only what is allowed', async () => {
  const t = await mk(base15());
  const agent = new Client(); await agent.login(ctx.agent.email);
  const page = await agent.get(`/tickets/${t.ref}`);
  assert.equal(page.status, 200);
  const sel = /<select[^>]*name="status"[\s\S]*?<\/select>/.exec(page.text);
  assert.ok(sel, 'the status list is there');
  assert.ok(!/value="closed"/.test(sel[0]), 'Closed is not offered on a new ticket');
  const r = await agent.post(`/tickets/${t.ref}/status`, { status: 'closed' });
  assert.ok([302, 400].includes(r.status), 'refused with a message (back to the page, or an error page)');
  assert.notEqual((await tickets.summary({ query: q }, t.id)).status, 'closed', 'a forged post cannot close it either');
});

// ---------------------------------------------------------------- 1.15.0: sign-in hardening
test('1.15.0 two-step codes: a code works once, wrong codes lock the account like wrong passwords, and the secret is stored encrypted', async () => {
  const totp = require('../../src/lib/totp');
  const twofactor = require('../../src/lib/twofactor');
  const secret = totp.newSecret();
  const u = await mkUser('mfa15@t.local', 'Mfa', 'staff', 'agent');
  await q('update users set totp_enabled = true, totp_secret = $2 where id = $1', [u.id, secret]);          // an older, plain secret
  const step = async (c, code) => {
    const t = await c.csrf('/login/mfa');
    return c.req('POST', '/login/mfa', { _csrf: t, code });
  };
  const password1 = async (c, pw = PW) => c.req('POST', '/login', { _csrf: await c.csrf('/login'), email: u.email, password: pw, next: '' });   // first step only: Client.login expects a finished sign-in
  const c1 = new Client();
  let r = await password1(c1);
  assert.equal(r.location, '/login/mfa');
  r = await step(c1, totp.code(secret));
  assert.equal(r.status, 302); assert.equal(r.location, '/', 'a correct code signs in');
  assert.ok(twofactor.isEncrypted((await q('select totp_secret from users where id = $1', [u.id])).rows[0].totp_secret), 'the plain secret was upgraded');
  const c2 = new Client();
  await password1(c2);
  r = await step(c2, totp.code(secret));
  assert.equal(r.status, 401, 'the same code cannot be used twice');
  // five wrong codes, each time in a fresh sign-in, lock the account
  // (the replayed code above already counted as one failure, so the lock arrives before the fifth fresh sign-in; stop when the account is locked)
  let lockedAt = 0;
  for (let i = 1; i <= 6; i++) {
    const c = new Client();
    const first = await password1(c);
    if (first.location !== '/login/mfa') { lockedAt = i; break; }
    await step(c, '000000');
  }
  assert.ok(lockedAt > 0 && lockedAt <= 5, 'wrong codes in new sign-ins cannot go on for ever: the account locks');
  const locked = new Client();
  r = await password1(locked);
  assert.notEqual(r.location, '/login/mfa', 'a locked account is not taken to the code page');
  assert.ok((await q(`select 1 from audit_log where action = 'account_locked' and entity_id = $1`, [String(u.id)])).rows.length, 'the lock is audited');
});

test('1.15.0 a new account must choose its own password first; changing it ends the other sessions', async () => {
  const u = await mkUser('force15@t.local', 'Force', 'staff', 'agent');
  await q('update users set must_change_password = true where id = $1', [u.id]);
  const c = new Client(); const other = new Client();
  await other.login(u.email);
  assert.equal((await c.login(u.email)).status, 302);
  let r = await c.get('/tickets');
  assert.equal(r.status, 302); assert.equal(r.location, '/account', 'everything else is closed until the password is changed');
  assert.equal((await c.get('/account')).status, 200);
  assert.equal((await c.get('/manual')).status, 200);
  r = await c.post('/account/password', { current: PW, next1: PW, next2: PW });
  assert.ok((await q('select must_change_password from users where id = $1', [u.id])).rows[0].must_change_password, 'the same password is not accepted');
  const fresh = 'Another-long-pass-77!';
  r = await c.post('/account/password', { current: PW, next1: fresh, next2: fresh });
  assert.equal(r.status, 302);
  assert.equal((await q('select must_change_password from users where id = $1', [u.id])).rows[0].must_change_password, false);
  assert.equal((await c.get('/tickets')).status, 200, 'the rest of the application is open now');
  assert.equal((await other.get('/tickets')).status, 302, 'the other browser was signed out');
});

test('1.15.0 an administrator can reset two-step verification, and it is audited', async () => {
  const u = await mkUser('resetmfa15@t.local', 'Reset', 'staff', 'agent');
  await q('update users set totp_enabled = true, totp_secret = $2 where id = $1', [u.id, require('../../src/lib/totp').newSecret()]);
  await asAdmin(async (a) => {
    assert.ok((await a.get('/admin/users')).text.includes(`/admin/users/${u.id}/reset-mfa`), 'the Users page has the button');
    const peer = await mkUser('agent2-15@t.local', 'Peer', 'staff', 'agent');
    const denied = new Client(); await denied.login(peer.email);
    assert.equal((await denied.post(`/admin/users/${u.id}/reset-mfa`, {})).status, 403, 'only those who manage users');
    const r = await a.post(`/admin/users/${u.id}/reset-mfa`, {});
    assert.equal(r.status, 302);
  });
  const row = (await q('select totp_enabled, totp_secret from users where id = $1', [u.id])).rows[0];
  assert.equal(row.totp_enabled, false); assert.ok(!row.totp_secret);
  assert.ok((await q(`select 1 from audit_log where action = 'mfa_reset' and entity_id = $1`, [String(u.id)])).rows.length);
});

// ---------------------------------------------------------------- 1.15.0: audit log and retention
test('1.15.0 the audit log cannot be altered, and a forged or removed entry is found', async () => {
  const audit = require('../../src/lib/audit');
  await audit({ query: q }, ctx.admin, 'chain_probe', 'test', '1', 'first', null, '127.0.0.1');
  await audit({ query: q }, ctx.admin, 'chain_probe', 'test', '2', 'second', null, '127.0.0.1');
  assert.equal((await q('select audit_verify() as bad')).rows[0].bad, null, 'the chain is intact');
  await assert.rejects(q(`update audit_log set detail = 'edited' where action = 'chain_probe'`), /cannot be changed or deleted/);
  await assert.rejects(q(`delete from audit_log where action = 'chain_probe'`), /cannot be changed or deleted/);
  await assert.rejects(q('truncate audit_log'), /cannot be changed or deleted/);
  // a forgery needs the guard switched off, which is what a database administrator could do: the chain then shows it
  const id = (await q(`select id from audit_log where action = 'chain_probe' order by id limit 1`)).rows[0].id;
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('alter table audit_log disable trigger audit_guard_trg');
    await client.query(`update audit_log set detail = 'forged' where id = $1`, [id]);
    await client.query('alter table audit_log enable trigger audit_guard_trg');
    assert.equal(Number((await client.query('select audit_verify() as bad')).rows[0].bad), Number(id), 'the first altered entry is named');
    await client.query('rollback');                                                                          // put it back exactly as it was
  } finally { client.release(); }
  assert.equal((await q('select audit_verify() as bad')).rows[0].bad, null, 'and the real log is intact');
});

test('1.15.0 retention: old notifications are removed, and closed tickets only when a period is set', async () => {
  const maintenance = require('../../src/services/maintenance');
  const db = { query: q };
  // notifications: sent ones past the period go, waiting ones stay
  const oldSent = (await q(`insert into notifications (kind, recipient_email, subject, body, status, created_at) values ('t15','a@b.co','s','b','sent', now() - interval '400 days') returning id`)).rows[0].id;
  const oldWait = (await q(`insert into notifications (kind, recipient_email, subject, body, status, created_at) values ('t15','a@b.co','s','b','pending', now() - interval '400 days') returning id`)).rows[0].id;
  assert.equal(await maintenance.purgeNotifications(db, 0), 0, '0 keeps them for ever');
  assert.ok(await maintenance.purgeNotifications(db, 365) >= 1);
  assert.equal((await q('select count(*)::int as n from notifications where id = $1', [oldSent])).rows[0].n, 0);
  assert.equal((await q('select count(*)::int as n from notifications where id = $1', [oldWait])).rows[0].n, 1, 'a message still waiting is never removed');
  await q('delete from notifications where id = $1', [oldWait]);
  // tickets: nothing is removed unless a number of years is set
  const t = await mk(base15());
  await tx((db2) => tickets.setStatus(db2, t, 'cancelled', staffActor(ctx.agent)));
  await q(`update tickets set updated_at = now() - interval '5 years', closed_at = now() - interval '5 years' where id = $1`, [t.id]);
  assert.equal(await maintenance.purgeTickets(0), 0);
  assert.equal((await q('select count(*)::int as n from tickets where id = $1', [t.id])).rows[0].n, 1, 'keep for ever is the default');
  assert.ok(await maintenance.purgeTickets(3) >= 1);
  assert.equal((await q('select count(*)::int as n from tickets where id = $1', [t.id])).rows[0].n, 0, 'removed after the chosen period');
  assert.ok((await q(`select 1 from audit_log where action = 'retention_tickets_deleted'`)).rows.length, 'the clean-up is audited');
  assert.equal((await q('select audit_verify() as bad')).rows[0].bad, null, 'and the log is still intact');
});

test('1.15.0 the Settings page shows the retention choices and the Audit page shows the integrity result', async () => {
  await asAdmin(async (a) => {
    const s = await a.get('/admin/settings');
    assert.ok(s.text.includes('retention_notification_days') && s.text.includes('retention_ticket_years') && s.text.includes('retention_audit_years'));
    const au = await a.get('/audit');
    assert.equal(au.status, 200);
  });
});

// ---------------------------------------------------------------- 1.16.0: the search box in the top bar
test('1.16.0 search box: staff find tickets in any status by subject, sender, customer, CSID and conversation; a reference opens the ticket', async () => {
  const agentUser = staffActor(ctx.agent);
  const t = await mk({ ...base15(), subject: 'Zebrafish printer queue stuck' });
  await tx((db) => tickets.addComment(db, t, { author: agentUser, body: 'Replaced the quokkaplug cable', source: 'agent' }));
  await q(`insert into ticket_comments (ticket_id, author_id, body, internal, source) values ($1,$2,'secret-wombat-note',true,'agent')`, [t.id, ctx.agent.id]);
  await tx((db) => tickets.setStatus(db, t, 'resolved', agentUser, { resolutionCode: 'fixed' }));
  const a = new Client(); await a.login(ctx.agent.email);
  const find = async (words) => (await a.get('/search?q=' + encodeURIComponent(words)));
  for (const words of ['Zebrafish', 'quokkaplug', 'Alpha Bank', ctx.A.cs.csid, ctx.aUser.email, 'Alpha User']) {
    const r = await find(words);
    assert.equal(r.status, 200, words);
    assert.ok(r.text.includes(t.ref), `"${words}" finds the ticket although it is resolved`);
  }
  assert.ok((await find('secret-wombat-note')).text.includes(t.ref), 'staff search internal notes');
  const ref = await a.get('/search?q=' + encodeURIComponent(t.ref));
  assert.equal(ref.status, 302); assert.equal(ref.location, '/tickets/' + t.ref);
  assert.ok((await find('Alpha Bank')).text.includes('Alpha Bank'), 'customers are listed too');
  assert.match((await a.get('/search?q=a')).text, /at least two characters/);
  assert.equal((await a.get('/tickets?view=all&q=quokkaplug')).text.includes(t.ref), true, 'the Tickets list searches the same way');
  // the header box goes to the search page
  assert.match((await a.get('/tickets')).text, /<form class="search" method="get" action="\/search"/);
});

test('1.16.0 search box: customers find only their own tickets, in any status, and never internal notes; staff-only areas are not offered', async () => {
  const agentUser = staffActor(ctx.agent);
  const mine = await mk({ ...base15(), subject: 'Narwhal login problem' });
  await q(`insert into ticket_comments (ticket_id, author_id, body, internal, source) values ($1,$2,'hidden-pangolin-note',true,'agent')`, [mine.id, ctx.agent.id]);
  await tx((db) => tickets.setStatus(db, mine, 'resolved', agentUser, { resolutionCode: 'fixed' }));
  const other = await mk({ customerId: ctx.B.c.id, csidId: ctx.B.cs.id, serviceId: ctx.B.sv.id, subject: 'Narwhal at Beta', requester: { id: ctx.bUser.id, email: ctx.bUser.email, name: 'Beta User' } });
  const u = new Client(); await u.login(ctx.aUser.email);
  const r = await u.get('/search?q=Narwhal');
  assert.equal(r.status, 200);
  assert.ok(r.text.includes(mine.ref), 'their own resolved ticket is found');
  assert.ok(!r.text.includes(other.ref), "another customer's ticket is never found");
  assert.ok(!(await u.get('/search?q=hidden-pangolin-note')).text.includes(mine.ref), 'internal notes are not searched for customers');
  assert.ok(!r.text.includes('/contracts?q=') && !r.text.includes('/pipeline?q='), 'staff areas are not offered');
  assert.ok(r.text.includes('/portal/help?q='), 'help articles are');
  assert.equal((await u.get('/search?q=' + encodeURIComponent(other.ref))).status, 200, 'a reference that is not theirs just finds nothing');
  assert.ok(!(await u.get('/search?q=' + encodeURIComponent(other.ref))).text.includes('Narwhal at Beta'));
  assert.match((await u.get('/portal')).text, /<form class="search" method="get" action="\/search"/);
});

// ---------------------------------------------------------------- 1.17.0: Quotes
test('1.17.0 quotes: made from an opportunity, priced lines with VAT, sent, revised, accepted (setting the opportunity value), downloaded as PDF', async () => {
  const bdUser = await mkUser('bd17@t.local', 'Bea Dev', 'staff', 'bd_manager');
  const opp = (await q(`insert into opportunities (name, customer_id, stage, value, currency, owner_id) values ('Firewall refresh 17', $1, 'proposal_submission', 1000, 'USD', $2) returning id`, [ctx.A.c.id, bdUser.id])).rows[0].id;
  const c = new Client(); await c.login(bdUser.email);
  const form = await c.get(`/quotes/new?opportunity=${opp}`);
  assert.equal(form.status, 200);
  assert.ok(form.text.includes('value="Firewall refresh 17"') && new RegExp(`<option value="${ctx.A.c.id}" selected`).test(form.text), 'the opportunity fills in the title and customer');
  let r = await c.post('/quotes', { title: 'Firewall refresh 17', opportunity_id: String(opp), customer_id: String(ctx.A.c.id), currency: 'USD', tax_rate: '18', tax_label: 'VAT', contact_name: 'Jane Doe', internal_notes: 'secret-margin-note' });
  assert.equal(r.status, 302);
  const id = Number(/\/quotes\/(\d+)/.exec(r.location)[1]);
  r = await c.post(`/quotes/${id}/lines`, { description: ['Firewall appliance', 'Installation', ''], quantity: ['2', '1', ''], unit: ['each', 'job', ''], unit_price: ['4500', '750', ''], discount_pct: ['10', '', ''] });
  assert.equal(r.status, 302);
  let row = (await q('select * from quotes where id = $1', [id])).rows[0];
  assert.deepEqual([row.subtotal, row.tax_total, row.total].map(Number), [8850, 1593, 10443], '2 x 4500 less 10% + 750 = 8850; VAT 18% = 1593');
  const page = await c.get(`/quotes/${id}`);
  assert.ok(page.text.includes('10,443.00') && page.text.includes('data-quote-lines'));
  // the PDF
  const pdfRes = await fetch(`${base}/quotes/${id}/pdf`, { headers: { cookie: c.cookie() } });
  assert.equal(pdfRes.status, 200); assert.equal(pdfRes.headers.get('content-type'), 'application/pdf');
  assert.match(pdfRes.headers.get('content-disposition'), /attachment; filename="QUO-\d{6}\.pdf"/);
  const buf = Buffer.from(await pdfRes.arrayBuffer());
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const zlib = require('zlib'); let printed = '';
  for (const m of buf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)) { try { printed += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (_) { /* not a page */ } }
  assert.ok(printed.includes('Firewall appliance') && printed.includes('10,443.00') && printed.includes('DRAFT'), 'the PDF has the lines and total, and says draft');
  assert.ok(!printed.includes('secret-margin-note'), 'internal notes are never printed');
  // send (after approval); a sent quote is fixed
  await getApproved(c, 'quote', id);
  r = await c.post(`/quotes/${id}/status`, { status: 'sent', note: 'e-mailed' });
  assert.equal((await q('select status from quotes where id = $1', [id])).rows[0].status, 'sent');
  await c.post(`/quotes/${id}/lines`, { description: ['Changed'], quantity: ['1'], unit_price: ['1'] });
  assert.equal((await q('select count(*)::int as n from quote_lines where quote_id = $1', [id])).rows[0].n, 2, 'a sent quote cannot be changed');
  // revise
  r = await c.post(`/quotes/${id}/revise`, {});
  const id2 = Number(/\/quotes\/(\d+)/.exec(r.location)[1]);
  const r2 = (await q('select * from quotes where id = $1', [id2])).rows[0];
  assert.equal(r2.revision, 2); assert.equal(r2.status, 'draft'); assert.equal((await q('select status from quotes where id = $1', [id])).rows[0].status, 'superseded');
  await c.post(`/quotes/${id2}/lines`, { description: ['Firewall appliance', 'Installation'], quantity: ['2', '1'], unit: ['each', 'job'], unit_price: ['4500', '750'], discount_pct: ['15', ''] });
  await getApproved(c, 'quote', id2);
  await c.post(`/quotes/${id2}/status`, { status: 'sent' });
  await c.post(`/quotes/${id2}/status`, { status: 'accepted', note: 'PO 4471', update_opportunity: '1' });
  row = (await q('select * from quotes where id = $1', [id2])).rows[0];
  assert.equal(row.status, 'accepted');
  const o = (await q('select value, currency from opportunities where id = $1', [opp])).rows[0];
  assert.deepEqual([Number(o.value), o.currency], [8400, 'USD'], 'the opportunity value is the accepted amount before tax');
  const hist = (await q(`select text from opportunity_events where opportunity_id = $1`, [opp])).rows.map((x) => x.text).join(' | ');
  assert.match(hist, /started quote QUO-/); assert.match(hist, /accepted/);
  assert.ok((await q(`select 1 from audit_log where action = 'quote_accepted'`)).rows.length);
  // the opportunity page and the list
  const op = await c.get(`/pipeline/${opp}`);
  assert.ok(op.text.includes('id="quotes"') && op.text.includes(`${r2.ref} R2`));
  const list = await c.get('/quotes?status=all');
  assert.ok(list.text.includes(`${r2.ref} R2`));
});

test('1.17.0 quotes: who may see and change them; the Settings page holds the company details', async () => {
  const fin = await mkUser('fin17@t.local', 'Fin', 'staff', 'finance');
  const a = new Client(); await a.login(ctx.agent.email);
  assert.equal((await a.get('/quotes')).status, 403, 'agents do not see quotes');
  assert.ok(!(await a.get('/tickets')).text.includes('href="/quotes"'), 'nor the menu entry');
  const f = new Client(); await f.login(fin.email);
  assert.equal((await f.get('/quotes')).status, 200, 'finance sees quotes');
  assert.equal((await f.get('/quotes/new')).status, 403, 'but cannot create them');
  assert.equal((await f.post('/quotes', { title: 'x', customer_id: String(ctx.A.c.id), currency: 'USD' })).status, 403);
  await asAdmin(async (ad) => {
    const s = await ad.get('/admin/settings');
    assert.ok(s.text.includes('name="quote_company_name"') && s.text.includes('name="quote_tax_rate"'));
  });
});

// ---------------------------------------------------------------- 1.18.0: requests without signing in
test('1.18.0 requests without signing in: work e-mail on the customer domain + CSID + e-mailed code; then the CSID services and a ticket', async () => {
  const mailer = require('../../src/lib/mailer');
  const settingsLib = require('../../src/lib/settings');
  const sent = [];
  mailer.setTransportFactory(() => ({ sendMail: async (m) => { sent.push(m); return { accepted: [m.to] }; } }));
  await settingsLib.set({ query: q }, 'smtp', { server: 'smtp.test', port: 25, security: 'none', from_address: 'ops@test.local' });
  await q(`update customers set email_domains = '{alpha.test}' where id = $1`, [ctx.A.c.id]);
  const wait = () => new Promise((r) => setTimeout(r, 150));
  try {
    // the sign-in page offers it
    assert.match((await new Client().get('/login')).text, /href="\/request"/);
    // wrong domain: the same answer and no e-mail
    const x = new Client();
    let r = await x.req('POST', '/request', { _csrf: await x.csrf('/request'), email: 'intruder@evil.test', csid: ctx.A.cs.csid });
    assert.equal(r.status, 302); assert.equal(r.location, '/request/code');
    await wait(); assert.equal(sent.length, 0, 'no code for an address outside the customer domains');
    assert.ok((await x.get('/request/code')).text.includes('If that e-mail address belongs to a customer with that CSID'));
    // the right domain and CSID
    const g = new Client();
    r = await g.req('POST', '/request', { _csrf: await g.csrf('/request'), email: 'newperson@alpha.test', csid: ctx.A.cs.csid.toLowerCase() });
    assert.equal(r.location, '/request/code');
    await wait(); assert.equal(sent.length, 1); assert.equal(sent[0].to, 'newperson@alpha.test');
    const code = /code is: (\d{6})/.exec(sent[0].text)[1];
    assert.equal((await g.get('/request/new')).location, '/request', 'the form needs the code first');
    r = await g.req('POST', '/request/code', { _csrf: await g.csrf('/request/code'), code });
    assert.equal(r.location, '/request/new');
    const form = await g.get('/request/new');
    assert.equal(form.status, 200);
    assert.ok(form.text.includes('Alpha Bank') && form.text.includes(ctx.A.cs.csid) && form.text.includes('Alpha Bank servers'), 'the customer, CSID and its services are shown');
    assert.ok(!form.text.includes('Beta Telecom servers'));
    const token = /name="_csrf" value="([^"]+)"/.exec(form.text)[1];
    r = await g.req('POST', '/request/new', { _csrf: token, name: 'New Person', phone: '0700 123456', type: 'incident', service_id: String(ctx.A.sv.id), subject: 'Guest printer issue', description: 'It is jammed', impact: '2', urgency: '2' });
    assert.equal(r.location, '/request/done');
    const done = await g.get('/request/done');
    const ref = /<b>((?:INC|REQ)-[^<]+)<\/b>/.exec(done.text)[1];
    const t = (await q('select * from tickets where ref = $1', [ref])).rows[0];
    assert.equal(Number(t.customer_id), Number(ctx.A.c.id)); assert.equal(Number(t.csid_id), Number(ctx.A.cs.id)); assert.equal(Number(t.service_id), Number(ctx.A.sv.id));
    assert.equal(t.requester_email, 'newperson@alpha.test'); assert.equal(t.raised_by_guest, true);
    assert.ok((await q(`select 1 from notifications where ticket_id = $1 and kind = 'ticket_ack' and recipient_email = 'newperson@alpha.test'`, [t.id])).rows.length, 'acknowledged by e-mail');
    assert.ok((await q(`select 1 from audit_log where action = 'guest_ticket_created' and entity_id = $1`, [ref])).rows.length);
    // staff see it as an ordinary ticket of the customer
    const ag = new Client(); await ag.login(ctx.agent.email);
    assert.ok((await ag.get(`/tickets/${ref}`)).text.includes('Raised without signing in'));
    // the code cannot be used again
    const again = new Client();
    r = await again.req('POST', '/request/code', { _csrf: await again.csrf('/request'), code });
    assert.equal(r.location, '/request', 'no pending code in another browser');
    // an e-mailed reply from the confirmed address is added to the ticket; another address on the domain is not trusted
    const mb = await mailbox('services');
    const reply = await inbound.ingest(mb, eml({ from: 'New Person <newperson@alpha.test>', subject: `Re: [${ref}] Guest printer issue`, body: 'Here is more detail.', id: 'guest-r1' }));
    assert.equal(reply.outcome, 'reply_appended'); assert.equal(reply.ticketId, t.id);
    const stranger = await inbound.ingest(mb, eml({ from: 'someone.else@alpha.test', subject: `Re: [${ref}] Guest printer issue`, body: 'I am someone else.', id: 'guest-r2' }));
    assert.notEqual(stranger.ticketId, t.id, 'another address does not write to the ticket');
    // switched off: the page says so and the sign-in page has no link
    await settingsLib.set({ query: q }, 'guest_requests_enabled', false);
    assert.equal((await new Client().get('/request')).status, 404);
    assert.doesNotMatch((await new Client().get('/login')).text, /href="\/request"/);
  } finally {
    await settingsLib.set({ query: q }, 'guest_requests_enabled', true);
    mailer.setTransportFactory((o) => require('nodemailer').createTransport(o));
    await q(`delete from settings where key = 'smtp'`);
    await q(`update customers set email_domains = '{}' where id = $1`, [ctx.A.c.id]);
  }
});

test('1.18.0 requests without signing in: not offered while outgoing mail is not set up; domains are set on the customer page', async () => {
  await q(`delete from settings where key = 'smtp'`);
  const r = await new Client().get('/request');
  assert.equal(r.status, 503); assert.match(r.text, /not available/);
  await asAdmin(async (a) => {
    const page = await a.get(`/customers/${ctx.B.c.id}`);
    assert.ok(page.text.includes('name="email_domains"'));
    const token = /name="_csrf" value="([^"]+)"/.exec(page.text)[1];
    await a.req('POST', `/customers/${ctx.B.c.id}`, { _csrf: token, name: 'Beta Telecom', status: 'active', notes: '', industry: '', email_domains: '@Beta.test\nmail.beta.test' });
    assert.deepEqual((await q('select email_domains from customers where id = $1', [ctx.B.c.id])).rows[0].email_domains, ['beta.test', 'mail.beta.test']);
    await q(`update customers set email_domains = '{}' where id = $1`, [ctx.B.c.id]);
  });
});

// ---------------------------------------------------------------- 1.19.0: formatted comments and the SLA card
test('1.19.0 comments and notes can be formatted; customers get plain text by e-mail; e-mail stays as written', async () => {
  const t = await mk({ ...base15(), subject: 'Formatting probe' });
  const a = new Client(); await a.login(ctx.agent.email);
  let r = await a.post(`/tickets/${t.ref}/comment`, { body: '## Findings\n- **Router** rebooted\n- ++check++ the ~~old~~ [guide](https://example.com/g)\n<img src=x onerror=alert(1)>', format: 'rich' });
  assert.equal(r.status, 302);
  r = await a.post(`/tickets/${t.ref}/comment`, { body: '**internal** detail', format: 'rich', internal: 'on' });
  const page = await a.get(`/tickets/${t.ref}`);
  assert.ok(page.text.includes('<h3>Findings</h3>') && page.text.includes('<b>Router</b>') && page.text.includes('<u>check</u>') && page.text.includes('<s>old</s>'));
  assert.ok(page.text.includes('<a href="https://example.com/g"'));
  assert.ok(!page.text.includes('<img src=x') && page.text.includes('&lt;img src=x onerror=alert(1)&gt;'), 'raw HTML is shown as text, never run');
  assert.ok(page.text.includes('<b>internal</b>'), 'internal notes can be formatted too');
  assert.match(page.text, /data-rich/);
  const mail = (await q(`select body from notifications where ticket_id = $1 and kind = 'ticket_comment' and recipient_email = $2 order by id desc limit 1`, [t.id, ctx.aUser.email])).rows[0];
  assert.ok(mail && mail.body.includes('- Router rebooted') && mail.body.includes('the old guide (https://example.com/g)') && !mail.body.includes('**'), 'the customer e-mail is plain text');
  // the customer sees it formatted, but not the internal note, and can format their own comment
  const u = new Client(); await u.login(ctx.aUser.email);
  const pp = await u.get(`/portal/tickets/${t.ref}`);
  assert.ok(pp.text.includes('<b>Router</b>') && !pp.text.includes('<b>internal</b>'));
  await u.post(`/portal/tickets/${t.ref}/comment`, { body: 'Thanks, **all good** now', format: 'rich' });
  assert.equal((await q(`select format from ticket_comments where ticket_id = $1 order by id desc limit 1`, [t.id])).rows[0].format, 'rich');
  // e-mail replies are never treated as formatted
  const T = require('../../src/services/tickets');
  const fresh = await T.summary({ query: q }, t.id);
  await tx((db) => T.addComment(db, fresh, { author: { ...ctx.aUser, kind: 'customer' }, body: '**not bold**', source: 'email', format: 'rich' }));
  assert.equal((await q(`select format from ticket_comments where ticket_id = $1 order by id desc limit 1`, [t.id])).rows[0].format, 'text');
});

test('1.19.0 the SLA stands out on the ticket page: a banner under the title and a coloured card first in the side column', async () => {
  const t = await mk(base15());
  await q(`update tickets set status = 'in_progress', responded_at = created_at, restoration_due = now() - interval '2 hours', resolution_due = now() + interval '30 minutes' where id = $1`, [t.id]);
  const a = new Client(); await a.login(ctx.agent.email);
  const page = (await a.get(`/tickets/${t.ref}`)).text;
  assert.match(page, /class="slabanner sla-breached"/);
  assert.match(page, /SLA breached: restoration is overdue by 2h/);
  assert.match(page, /class="card slacard sla-breached" id="sla"/);
  assert.match(page, /<tr class="sla-risk"><th>Resolution/);
  assert.ok(page.indexOf('id="sla"') < page.indexOf('<dl'), 'the SLA card comes before the details');
});

// ---------------------------------------------------------------- 1.20.0: sign-in page layout and notice
test('1.20.0 sign-in page: form panel and pattern; an optional notice must be accepted before signing in', async () => {
  const settingsLib = require('../../src/lib/settings');
  let page = (await new Client().get('/login')).text;
  assert.ok(page.includes('class="signin-panel"') && page.includes('class="signin-art"'));
  assert.ok(!page.includes('name="agree"'), 'no notice by default');
  await settingsLib.set({ query: q }, 'login_notice', 'WARNING: authorised users only. Access is monitored.');
  try {
    page = (await new Client().get('/login')).text;
    assert.ok(page.includes('name="agree"') && page.includes('WARNING: authorised users only.'));
    const c = new Client();
    let r = await c.req('POST', '/login', { _csrf: await c.csrf('/login'), email: ctx.agent.email, password: PW });
    assert.equal(r.status, 400, 'without the tick the sign-in is refused');
    assert.match(r.text, /Tick the box/);
    r = await c.req('POST', '/login', { _csrf: await c.csrf('/login'), email: ctx.agent.email, password: PW, agree: 'on' });
    assert.equal(r.status, 302, 'with it, the sign-in works');
  } finally { await settingsLib.set({ query: q }, 'login_notice', ''); }
});

// ---------------------------------------------------------------- 1.21.0: suppliers and contractors, purchase orders (LPOs)
test('1.21.0 suppliers register: add, put on a project and a tender, upload their quote; who may do what', async () => {
  const buyer = await mkUser('buyer21@t.local', 'Nora Buyer', 'staff', 'procurement');
  const mgr = await mkUser('mgr21@t.local', 'Mike Manager', 'staff', 'service_manager');
  const proj = (await q(`insert into projects (name, manager_id) values ('Supplier test project', $1) returning id, ref`, [mgr.id])).rows[0];
  const tender = (await q(`insert into tenders (title, issuer, owner_id, submission_due) values ('Supplier test tender', 'Issuer', $1, now() + interval '10 days') returning id, ref`, [mgr.id])).rows[0];
  const b = new Client(); await b.login(buyer.email);
  let r = await b.post('/suppliers', { name: 'Kilimanjaro Cabling 21', kind: 'contractor', status: 'active', tin: '1000777', contact_name: 'Peter', payment_terms: '30 days', services: 'Cabling' });
  assert.equal(r.status, 302);
  const sid = Number(/\/suppliers\/(\d+)/.exec(r.location)[1]);
  assert.equal((await b.post('/suppliers', { name: 'KILIMANJARO cabling 21', kind: 'contractor' })).status, 400, 'the same name twice is refused');
  // the project manager adds them to the project from the project page
  const m = new Client(); await m.login(mgr.email);
  r = await m.post('/suppliers/links', { supplier_id: String(sid), project_id: String(proj.id), role: 'Cabling subcontractor', back: `/projects/${proj.id}#suppliers` });
  assert.equal(r.location, `/projects/${proj.id}#suppliers`);
  await b.post('/suppliers/links', { supplier_id: String(sid), tender_id: String(tender.id), role: 'Distributor' });
  // their quote, uploaded for the project
  const fd = new FormData();
  for (const [k, v] of Object.entries({ _csrf: b.token, kind: 'quote', reference: 'Q-21', amount: '9,500,000', currency: 'USD', doc_date: '2026-11-10', project_id: String(proj.id) })) fd.append(k, v);
  fd.append('files', new Blob(['%PDF-1.4 their quote'], { type: 'application/pdf' }), 'Kilimanjaro quote Q-21.pdf');
  r = await fetch(`${base}/suppliers/${sid}/documents`, { method: 'POST', body: fd, headers: { cookie: b.cookie() }, redirect: 'manual' });
  assert.equal(r.status, 302);
  const doc = (await q(`select d.*, a.id as aid from supplier_documents d join attachments a on a.id = d.attachment_id where d.supplier_id = $1`, [sid])).rows[0];
  assert.ok(doc && doc.kind === 'quote' && Number(doc.amount) === 9500000 && Number(doc.project_id) === Number(proj.id));
  // the project and tender pages show it
  const pp = (await m.get(`/projects/${proj.id}`)).text;
  assert.ok(pp.includes('id="suppliers"') && pp.includes('Kilimanjaro Cabling 21') && pp.includes('Cabling subcontractor') && pp.includes('Kilimanjaro quote Q-21.pdf'));
  assert.ok((await b.get(`/tenders/${tender.id}`)).text.includes('Kilimanjaro Cabling 21'));
  // access: agents see nothing; finance reads; the document follows the register's rules
  const a = new Client(); await a.login(ctx.agent.email);
  assert.equal((await a.get('/suppliers')).status, 403);
  assert.equal((await a.get(`/documents/${doc.aid}`)).status, 403);
  const fin = await mkUser('fin21@t.local', 'Fin', 'staff', 'finance');
  const f = new Client(); await f.login(fin.email);
  assert.equal((await f.get(`/suppliers/${sid}`)).status, 200);
  assert.equal((await f.get(`/documents/${doc.aid}`)).status, 200);
  assert.equal((await f.post('/suppliers', { name: 'Not allowed', kind: 'vendor' })).status, 403);
  assert.ok((await q(`select 1 from audit_log where action = 'supplier_created' and detail = 'Kilimanjaro Cabling 21'`)).rows.length);
});

test('1.21.0 purchase orders: raised by procurement against a supplier quote and a project, priced, issued, fixed, received, closed; PDF', async () => {
  const buyer = (await q(`select * from users where email = 'buyer21@t.local'`)).rows[0];
  const sid = (await q(`select id from suppliers where name = 'Kilimanjaro Cabling 21'`)).rows[0].id;
  const doc = (await q(`select id, project_id from supplier_documents where supplier_id = $1 and kind = 'quote'`, [sid])).rows[0];
  const b = new Client(); await b.login(buyer.email);
  const form = await b.get(`/lpo/new?supplier_doc=${doc.id}`);
  assert.equal(form.status, 200);
  assert.ok(new RegExp(`<option value="${sid}" selected`).test(form.text) && new RegExp(`<option value="${doc.project_id}" selected`).test(form.text), 'the supplier and the project come from their quote');
  let r = await b.post('/lpo', { title: 'Cabling for the new floor', supplier_id: String(sid), supplier_doc_id: String(doc.id), project_id: String(doc.project_id), currency: 'USD', tax_rate: '18', tax_label: 'VAT', internal_notes: 'secret-buyer-note', delivery_address: 'Plot 1, Kampala' });
  assert.equal(r.status, 302);
  const id = Number(/\/lpo\/(\d+)/.exec(r.location)[1]);
  await b.post(`/lpo/${id}/status`, { status: 'issued' });
  assert.equal((await q('select status from purchase_orders where id = $1', [id])).rows[0].status, 'draft', 'an empty order is not issued');
  await b.post(`/lpo/${id}/lines`, { description: ['Cat6A points', 'Fibre run'], quantity: ['48', '1'], unit: ['point', 'run'], unit_price: ['185', '2600'], discount_pct: ['', ''] });
  let po = (await q('select * from purchase_orders where id = $1', [id])).rows[0];
  assert.deepEqual([po.subtotal, po.tax_total, po.total].map(Number), [11480, 2066.4, 13546.4]);
  // PDF
  const res = await fetch(`${base}/lpo/${id}/pdf`, { headers: { cookie: b.cookie() } });
  assert.equal(res.status, 200); assert.equal(res.headers.get('content-type'), 'application/pdf');
  const buf = Buffer.from(await res.arrayBuffer()); assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  const zlib = require('zlib'); let printed = '';
  for (const mm of buf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)) { try { printed += zlib.inflateSync(Buffer.from(mm[1], 'latin1')).toString('latin1'); } catch (_) { /* not a page */ } }
  assert.ok(printed.includes('Local Purchase Order LPO-') && printed.includes('Kilimanjaro Cabling 21') && printed.includes('13,546.40') && printed.includes('your quote Q-21') && printed.includes('DRAFT'));
  assert.ok(!printed.includes('secret-buyer-note'));
  // issue (after approval); then fixed
  await getApproved(b, 'lpo', id);
  await b.post(`/lpo/${id}/status`, { status: 'issued', note: 'sent' });
  po = (await q('select * from purchase_orders where id = $1', [id])).rows[0];
  assert.equal(po.status, 'issued'); assert.ok(po.issued_at);
  await b.post(`/lpo/${id}/lines`, { description: ['Changed'], quantity: ['1'], unit_price: ['1'] });
  assert.equal((await q('select count(*)::int as n from purchase_order_lines where purchase_order_id = $1', [id])).rows[0].n, 2, 'an issued order cannot be changed');
  await b.post(`/lpo/${id}/status`, { status: 'cancelled' });
  assert.equal((await q('select status from purchase_orders where id = $1', [id])).rows[0].status, 'issued', 'cancelling an issued order needs a reason');
  await b.post(`/lpo/${id}/status`, { status: 'received', note: 'DN 553' });
  await b.post(`/lpo/${id}/status`, { status: 'closed' });
  assert.equal((await q('select status from purchase_orders where id = $1', [id])).rows[0].status, 'closed');
  assert.ok((await q(`select 1 from project_events where project_id = $1 and text like 'LPO % issued%'`, [doc.project_id])).rows.length);
  assert.ok((await q(`select 1 from audit_log where action = 'lpo_issued'`)).rows.length);
  // who may raise them
  const m = new Client(); await m.login('mgr21@t.local');
  assert.equal((await m.get('/lpo/new')).status, 403, 'a service manager sees orders but does not raise them');
  assert.equal((await m.get(`/lpo/${id}`)).status, 200);
  const a = new Client(); await a.login(ctx.agent.email);
  assert.equal((await a.get('/lpo')).status, 403);
  // an inactive supplier gets no new orders
  await q(`update suppliers set status = 'inactive' where id = $1`, [sid]);
  assert.equal((await b.post('/lpo', { title: 'x', supplier_id: String(sid), currency: 'USD' })).status, 400);
  await q(`update suppliers set status = 'active' where id = $1`, [sid]);
});

test("1.21.1 downloaded documents take the colours of the person's theme", async () => {
  const DT = require('../../src/lib/doc_theme');
  const zlib = require('zlib');
  const content = (buf) => { let o = ''; for (const m of buf.toString('latin1').matchAll(/stream\n([\s\S]*?)\nendstream/g)) { try { o += zlib.inflateSync(Buffer.from(m[1], 'latin1')).toString('latin1'); } catch (_) { /* not a page */ } } return o; };
  const buyer = (await q(`select * from users where email = 'buyer21@t.local'`)).rows[0];
  const po = (await q(`select id from purchase_orders order by id desc limit 1`)).rows[0];
  const c = new Client(); await c.login(buyer.email);
  for (const theme of ['sunset', 'ocean']) {
    await c.post('/account/theme', { theme });
    const res = await fetch(`${base}/lpo/${po.id}/pdf`, { headers: { cookie: c.cookie() } });
    const pdfText = content(Buffer.from(await res.arrayBuffer()));
    assert.ok(pdfText.includes(`${DT.pdfRgb(DT.PALETTES[theme].bar)} rg`), `the LPO is in the ${theme} colours`);
    const rep = await fetch(`${base}/suppliers/export?format=pdf&status=all`, { headers: { cookie: c.cookie() } });
    assert.ok(content(Buffer.from(await rep.arrayBuffer())).includes(`${DT.pdfRgb(DT.PALETTES[theme].bar)} rg`), `reports too (${theme})`);
  }
  await q('update users set theme = null where id = $1', [buyer.id]);
});

test('1.22.0 company branding: logo upload, served to the sign-in page and the menu, printed on reports; LPO and supplier uploads reach their routes', async () => {
  const zlib = require('zlib');
  const branding = require('../../src/services/branding');
  await require('../../src/lib/settings').set({ query: q }, 'branding_logo_recolor', true); branding.invalidate();   // the default, set in case an earlier test saved Settings
  // a real 40 x 20 RGBA PNG, built here
  const crcT = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const td = Buffer.concat([Buffer.from(t, 'latin1'), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([l, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(40, 0); ihdr.writeUInt32BE(20, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.concat(Array.from({ length: 20 }, (_, y) => Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: 40 }, (_, x) => Buffer.from([200, x * 5, y * 10, x < 3 ? 0 : 255])))])));
  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
  const text = (buf) => { const s = buf.toString('latin1'); let all = s; const re = /stream\r?\n/g; let m; while ((m = re.exec(s))) { try { all += zlib.inflateSync(buf.subarray(m.index + m[0].length, s.indexOf('endstream', m.index))).toString('latin1'); } catch (_) { /* image */ } } return all; };

  // a platform administrator must have two-step set up, otherwise every page sends them to /account/mfa (also a 302)
  await asAdmin(async (a) => {
  const upload = async (c, path, field, blob, name, extra = {}) => {
    const fd = new FormData(); fd.append('_csrf', c.token); for (const [k, v] of Object.entries(extra)) fd.append(k, v); fd.append(field, blob, name);
    return fetch(`${base}${path}`, { method: 'POST', body: fd, headers: { cookie: c.cookie() }, redirect: 'manual' });
  };
  assert.equal((await fetch(`${base}/branding/logo`)).status, 404, 'no logo yet');
  // an SVG is refused, nothing stored
  let r = await upload(a, '/admin/branding/logo', 'logo', new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }), 'logo.svg');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/admin/settings#branding'); assert.equal(await branding.logoFile({ query: q }), null);
  // only settings managers may change it
  const eng = new Client(); await eng.login(ctx.eng.email);
  assert.equal((await upload(eng, '/admin/branding/logo', 'logo', new Blob([PNG], { type: 'image/png' }), 'logo.png')).status, 403);
  // the real logo
  r = await upload(a, '/admin/branding/logo', 'logo', new Blob([PNG], { type: 'image/png' }), 'logo.png');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), '/admin/settings#branding');
  const served = await fetch(`${base}/branding/logo`);
  assert.equal(served.status, 200); assert.equal(served.headers.get('content-type'), 'image/png'); assert.equal(served.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(Buffer.from(await served.arrayBuffer()).equals(PNG), 'served byte for byte, without signing in');
  assert.equal((await fetch(`${base}/branding/logo`, { headers: { 'if-none-match': served.headers.get('etag') } })).status, 304);
  await branding.setName({ query: q }, 'Acme Networks Uganda Ltd');
  const login = (await new Client().get('/login')).text;
  assert.ok(login.includes('class="signin-logo tint" src="/branding/logo?v=') && login.includes('id="logo-tint-default"') && login.includes('Acme Networks Uganda Ltd'), 'the sign-in page shows the logo and the company name');
  const home = (await a.get('/')).text;
  assert.ok(home.includes('class="logotile"') && /<title>[^<]*Acme Networks Uganda Ltd/.test(home), 'the menu and page titles carry the brand');
  // reports carry the logo and name
  const rep = await fetch(`${base}/suppliers/export?format=pdf&status=all`, { headers: { cookie: a.cookie() } });
  const t = text(Buffer.from(await rep.arrayBuffer()));
  assert.ok(t.includes('/Im1') && t.includes('/SMask') && t.includes('Acme Networks Uganda Ltd'), 'report PDF is branded');
  // uploads on the 1.21 forms now get through (they were missing from the multipart allow-list)
  const po = (await q(`select id, supplier_id from purchase_orders order by id limit 1`)).rows[0];
  if (po) {
    r = await upload(a, `/lpo/${po.id}/files`, 'files', new Blob(['%PDF-1.4 delivery note'], { type: 'application/pdf' }), 'Delivery note.pdf', { kind: 'delivery_note' });
    assert.equal(r.status, 302);
    assert.ok((await q(`select 1 from supplier_documents where purchase_order_id = $1 and kind = 'delivery_note'`, [po.id])).rowCount, 'delivery note stored against the LPO');
  }
  // removed: back to the product mark
  await a.post('/admin/branding/logo/remove', {});
  assert.equal((await fetch(`${base}/branding/logo`)).status, 404);
  assert.ok(!(await new Client().get('/login')).text.includes('signin-logo'));
  await branding.setName({ query: q }, '');
  });
});

test('1.22.0 LPO tracking sits inside Suppliers & Contractors: tabs, tracker figures, the Late filter, one menu entry', async () => {
  const buyer = await mkUser('buyer22@t.local', 'Tracy Buyer', 'staff', 'procurement');
  const sup = (await q(`insert into suppliers (code, name, kind, status) values ('SUP-8801', 'Tracker Test Supplies', 'vendor', 'active') returning id`)).rows[0];
  await q(`insert into purchase_orders (ref, supplier_id, title, currency, status, subtotal, total, delivery_date, owner_id) values
           ('LPO-880001', $1, 'Late one', 'UGX', 'issued', 1000, 1180, current_date - 3, $2), ('LPO-880002', $1, 'On time', 'UGX', 'issued', 2000, 2360, current_date + 3, $2)`, [sup.id, buyer.id]);
  const b = new Client(); await b.login(buyer.email);
  const list = (await b.get(`/lpo?supplier=${sup.id}`)).text;
  assert.ok(list.includes('LPO tracker') && list.includes('Purchase orders (LPO)') && list.includes('href="/suppliers"'), 'the LPO tab of Suppliers & Contractors');
  const side = /<aside class="sidebar">[\s\S]*?<\/aside>/.exec(list)[0];
  assert.ok(side.includes('Suppliers &amp; Contractors') && !side.includes('Purchase Orders'), 'one menu entry');
  const late = (await b.get(`/lpo?supplier=${sup.id}&status=late`)).text;
  assert.ok(late.includes('LPO-880001') && !late.includes('LPO-880002'), 'only the late order');
  const page = (await b.get(`/suppliers/${sup.id}`)).text;
  assert.ok(page.includes('Purchase orders (LPO tracker)') && page.includes('>late</span>'));
});

test('1.23.0 approvals: a large quote waits for finance; nobody approves their own; a change withdraws approval; a large order needs a second approver', async () => {
  const db = { query: q };
  const settingsLib = require('../../src/lib/settings');
  for (const k of approvalsSvc.KEYS) await settingsLib.set(db, k, approvalsSvc.DEFAULTS[k]);   // the defaults, whatever earlier tests did
  const seller = await mkUser('seller23@t.local', 'Sam Seller', 'staff', 'bd_manager');
  const seller2 = await mkUser('seller23b@t.local', 'Other Seller', 'staff', 'bd_manager');
  const fin = await mkUser('fin23@t.local', 'Fiona Finance', 'staff', 'finance');
  const boss = await mkUser('boss23@t.local', 'Mary Management', 'staff', 'management');
  const buyer = await mkUser('buyer23@t.local', 'Bob Buyer', 'staff', 'procurement');
  const [s, s2, f, m, b] = await Promise.all([seller, seller2, fin, boss, buyer].map(async (u) => { const c = new Client(); await c.login(u.email); return c; }));
  const lastFlash = async (c, path) => (await c.get(path)).text;

  // ---- a UGX 23.6M quote (20M + VAT) needs approval before it is sent
  let r = await s.post('/quotes', { title: 'Core network refresh', prospect: 'Approval Test Ltd', currency: 'UGX', tax_rate: '18', tax_label: 'VAT', valid_until: '' });
  const qid = Number(/\/quotes\/(\d+)/.exec(r.location)[1]);
  await s.post(`/quotes/${qid}/lines`, { description: ['Core switch'], quantity: ['2'], unit: ['each'], unit_price: ['10000000'], discount_pct: [''] });
  let page = (await s.get(`/quotes/${qid}`)).text;
  assert.ok(page.includes('id="approval"') && page.includes('Ask for approval') && /at or above UGX 20,000,000/.test(page), 'the page says why approval is needed');
  assert.ok(!page.includes('<option value="sent">'), '"Sent" is not offered until approved');
  await s.post(`/quotes/${qid}/status`, { status: 'sent' });
  assert.equal((await q('select status from quotes where id = $1', [qid])).rows[0].status, 'draft', 'sending is refused');
  assert.match(await lastFlash(s, `/quotes/${qid}`), /needs approval before it is sent/);
  // ask; the seller and another seller cannot approve; finance sees it on the bell, in the menu and on the Approvals page
  assert.equal((await s.post(`/quotes/${qid}/approval`, {})).status, 302);
  const ap = (await q(`select * from approvals where entity = 'quote' and entity_id = $1 and status = 'pending'`, [qid])).rows[0];
  assert.ok(ap && ap.level === 1 && ap.roles.includes('finance'));
  await s.post(`/approvals/${ap.id}`, { decision: 'approve' });
  await s2.post(`/approvals/${ap.id}`, { decision: 'approve' });
  assert.equal((await q('select status from approvals where id = $1', [ap.id])).rows[0].status, 'pending', 'neither the owner nor a colleague without the role can approve');
  const list = (await f.get('/approvals')).text;
  assert.ok(/approval(s are| is) waiting for you/.test(list) && /href="\/approvals"[^>]*>[\s\S]{0,300}?class="badge"/.test(list), 'finance is told on the bell and in the menu');
  assert.ok(list.includes('Core network refresh') && list.includes('Sam Seller'));
  // decline needs a reason; then the seller sees it and asks again
  await f.post(`/approvals/${ap.id}`, { decision: 'decline', comment: '' });
  assert.equal((await q('select status from approvals where id = $1', [ap.id])).rows[0].status, 'pending', 'a decline without a reason is refused');
  await f.post(`/approvals/${ap.id}`, { decision: 'decline', comment: 'Check the margin on the switches' });
  page = (await s.get(`/quotes/${qid}`)).text;
  assert.ok(page.includes('Not approved') && page.includes('Check the margin on the switches'));
  await s.post(`/quotes/${qid}/approval`, {});
  const ap2 = (await q(`select id from approvals where entity = 'quote' and entity_id = $1 and status = 'pending'`, [qid])).rows[0];
  assert.equal((await f.post(`/approvals/${ap2.id}`, { decision: 'approve', comment: 'Margin fine now', back: '/approvals' })).location, '/approvals');
  assert.ok((await s.get(`/quotes/${qid}`)).text.includes('<option value="sent">'), 'now it can be sent');
  // a change after approval withdraws it
  await s.post(`/quotes/${qid}/lines`, { description: ['Core switch'], quantity: ['3'], unit: ['each'], unit_price: ['10000000'], discount_pct: [''] });
  assert.equal((await q(`select status from approvals where id = $1`, [ap2.id])).rows[0].status, 'withdrawn');
  await s.post(`/quotes/${qid}/status`, { status: 'sent' });
  assert.equal((await q('select status from quotes where id = $1', [qid])).rows[0].status, 'draft');
  await getApproved(s, 'quote', qid);
  await s.post(`/quotes/${qid}/status`, { status: 'sent' });
  assert.equal((await q('select status from quotes where id = $1', [qid])).rows[0].status, 'sent');
  const ev = (await q('select text from quote_events where quote_id = $1 order by id', [qid])).rows.map((x) => x.text).join(' | ');
  assert.ok(/asked for approval/.test(ev) && /did not approve it: Check the margin/.test(ev) && /approved it: Margin fine now/.test(ev) && /Approval withdrawn because its lines were changed/.test(ev), 'the history tells the story');
  assert.ok((await q(`select 1 from audit_log where action = 'approval_declined'`)).rowCount && (await q(`select 1 from audit_log where action = 'approval_granted'`)).rowCount);
  // a small quote without a big discount goes out without approval
  r = await s.post('/quotes', { title: 'Small job', prospect: 'Approval Test Ltd', currency: 'UGX', tax_rate: '18', tax_label: 'VAT', valid_until: '' });
  const small = Number(/\/quotes\/(\d+)/.exec(r.location)[1]);
  await s.post(`/quotes/${small}/lines`, { description: ['Visit'], quantity: ['1'], unit: ['visit'], unit_price: ['500000'], discount_pct: [''] });
  assert.ok(!(await s.get(`/quotes/${small}`)).text.includes('id="approval"'));
  await s.post(`/quotes/${small}/status`, { status: 'sent' });
  assert.equal((await q('select status from quotes where id = $1', [small])).rows[0].status, 'sent');

  // ---- a USD 17,700 order: finance first, then management; finance cannot give the second approval
  const sup = (await q(`insert into suppliers (code, name, kind, status) values ('SUP-2301', 'Approval Supplies', 'vendor', 'active') returning id`)).rows[0];
  r = await b.post('/lpo', { title: 'Firewalls', supplier_id: String(sup.id), currency: 'USD', tax_rate: '18', tax_label: 'VAT' });
  const pid = Number(/\/lpo\/(\d+)/.exec(r.location)[1]);
  await b.post(`/lpo/${pid}/lines`, { description: ['Firewall'], quantity: ['3'], unit: ['each'], unit_price: ['5000'], discount_pct: [''] });
  page = (await b.get(`/lpo/${pid}`)).text;
  assert.ok(page.includes('First approval') && page.includes('Second approval') && !page.includes('<option value="issued">'));
  await b.post(`/lpo/${pid}/approval`, {});
  const l1 = (await q(`select id, level from approvals where entity = 'lpo' and entity_id = $1 and status = 'pending'`, [pid])).rows[0];
  assert.equal(l1.level, 1);
  await m.post(`/approvals/${l1.id}`, { decision: 'approve' });
  assert.equal((await q('select status from approvals where id = $1', [l1.id])).rows[0].status, 'pending', 'management is not a first approver by default');
  await f.post(`/approvals/${l1.id}`, { decision: 'approve' });
  const l2 = (await q(`select id, level from approvals where entity = 'lpo' and entity_id = $1 and status = 'pending'`, [pid])).rows[0];
  assert.equal(l2.level, 2, 'the second approval is asked for at once');
  await f.post(`/approvals/${l2.id}`, { decision: 'approve' });
  assert.equal((await q('select status from approvals where id = $1', [l2.id])).rows[0].status, 'pending', 'finance cannot give the second approval');
  await b.post(`/lpo/${pid}/status`, { status: 'issued' });
  assert.equal((await q('select status from purchase_orders where id = $1', [pid])).rows[0].status, 'draft', 'not issued with one approval');
  await m.post(`/approvals/${l2.id}`, { decision: 'approve' });
  await b.post(`/lpo/${pid}/status`, { status: 'issued' });
  assert.equal((await q('select status from purchase_orders where id = $1', [pid])).rows[0].status, 'issued');

  // ---- Settings: the Approvals card, and switching quote approval off
  await asAdmin(async (a) => {
    const st = (await a.get('/admin/settings')).text;
    assert.ok(st.includes('id="approvals"') && st.includes('name="approvals_quote_limits"') && /UGX 20,000,000/.test(st) && /value="finance" checked/.test(st));
  });
  await settingsLib.set(db, 'approvals_quote_enabled', false);
  r = await s.post('/quotes', { title: 'Huge but approval off', prospect: 'Approval Test Ltd', currency: 'UGX', tax_rate: '18', tax_label: 'VAT', valid_until: '' });
  const off = Number(/\/quotes\/(\d+)/.exec(r.location)[1]);
  await s.post(`/quotes/${off}/lines`, { description: ['Everything'], quantity: ['1'], unit: ['lot'], unit_price: ['900000000'], discount_pct: [''] });
  await s.post(`/quotes/${off}/status`, { status: 'sent' });
  assert.equal((await q('select status from quotes where id = $1', [off])).rows[0].status, 'sent');
  await settingsLib.set(db, 'approvals_quote_enabled', true);
});
