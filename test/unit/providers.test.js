'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const graph = require('../../src/services/providers/graph');
const gmail = require('../../src/services/providers/gmail');
const { request, b64url, fromB64url } = require('../../src/services/providers/common');

const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { 'Content-Type': 'application/json' } });

function harness(handler, extra = {}) {
  const calls = []; const ingested = []; const sql = [];
  const ctx = {
    env: extra.env || {},
    fetch: async (url, opts = {}) => { calls.push({ url: String(url), method: opts.method || 'GET', body: opts.body, headers: opts.headers || {} }); return handler(String(url), opts); },
    pool: { query: async (text, params) => { sql.push({ text, params }); return { rows: [] }; } },
    ingestSafe: async (mb, raw, info) => { ingested.push({ ref: info.ref, raw: Buffer.from(raw).toString('utf8') }); },
    seen: extra.seen || (async () => false),
  };
  return { ctx, calls, ingested, sql };
}

const GUID = '11111111-2222-3333-4444-555555555555';
let nextId = 100;
const gbox = (o = {}) => ({ id: nextId++, key: 'ms', name: 'MS', provider: 'graph', address: 'help@corp.com', tenant_id: GUID, client_id: GUID, secret_env: 'MS_SECRET', imap_folder: 'INBOX', last_received_at: null, mark_seen: false, ...o });

test('request: errors carry status and the provider message; network failure is explained', async () => {
  await assert.rejects(() => request(async () => json({ error: { code: 'ErrorAccessDenied', message: 'Access is denied.' } }, 403), 'https://graph.microsoft.com/v1.0/x'),
    (e) => e.status === 403 && /graph\.microsoft\.com answered 403: Access is denied/.test(e.message));
  await assert.rejects(() => request(async () => { const e = new Error('fetch failed'); e.cause = { code: 'ENOTFOUND' }; throw e; }, 'https://graph.microsoft.com/x'),
    (e) => e.status === 0 && /ENOTFOUND/.test(e.message));
});

test('graph configError', () => {
  const env = { MS_SECRET: 'x' };
  assert.equal(graph.configError(gbox(), env), '');
  assert.match(graph.configError(gbox({ tenant_id: '' }), env), /tenant/);
  assert.match(graph.configError(gbox({ client_id: 'nope' }), env), /GUID/);
  assert.match(graph.configError(gbox(), {}), /client-secret variable/);
  assert.match(graph.configError(gbox({ address: '' }), env), /address/);
});

function graphHandler({ list, folderLookup, onRaw }) {
  return (url, opts) => {
    if (url.startsWith('https://login.microsoftonline.com/')) return json({ access_token: 'tok', expires_in: 3600 });
    if (/\/mailFolders\?/.test(url)) return json({ value: folderLookup || [] });
    if (/\/messages\/[^/?]+\/\$value$/.test(url)) return new Response(onRaw ? onRaw(url) : 'Subject: hi\r\n\r\nbody', { status: 200 });
    if (/\/messages\?/.test(url)) return json({ value: list });
    if (opts && opts.method === 'PATCH') return new Response(null, { status: 200 });
    return json({}, 404);
  };
}

test('graph poll (first run): token request, unread-only, oldest first, watermark moves forward', async () => {
  const mb = gbox();
  const list = [
    { id: 'A', internetMessageId: '<a@x>', receivedDateTime: '2026-11-01T08:00:00Z', isRead: true },
    { id: 'B', internetMessageId: '<b@x>', receivedDateTime: '2026-11-01T09:00:00Z', isRead: false },
    { id: 'C', internetMessageId: '<c@x>', receivedDateTime: '2026-11-01T09:30:00Z', isRead: false },
  ];
  const h = harness(graphHandler({ list }), { env: { MS_SECRET: 'sek' } });
  const n = await graph.poll(mb, h.ctx);
  assert.equal(n, 2);
  assert.deepEqual(h.ingested.map((i) => i.ref), ['B', 'C']);
  assert.match(h.ingested[0].raw, /Subject: hi/);
  const tok = h.calls[0];
  assert.match(tok.url, new RegExp(`/${GUID}/oauth2/v2.0/token$`));
  assert.match(tok.body, /grant_type=client_credentials/);
  assert.match(tok.body, /client_secret=sek/);
  assert.match(tok.body, /scope=https%3A%2F%2Fgraph\.microsoft\.com%2F\.default/);
  const listCall = h.calls.find((c) => /\/messages\?/.test(c.url));
  assert.match(listCall.url, /users\/help%40corp\.com\/mailFolders\/inbox\/messages/);
  assert.match(listCall.url, /orderby=receivedDateTime%20asc/);
  assert.equal(listCall.headers.Authorization, 'Bearer tok');
  const marks = h.sql.filter((s) => /last_received_at/.test(s.text)).map((s) => new Date(s.params[1]).toISOString());
  assert.deepEqual(marks, ['2026-11-01T08:00:00.000Z', '2026-11-01T09:00:00.000Z', '2026-11-01T09:30:00.000Z']);
});

test('graph poll (later run): reads from the watermark, includes read mail, skips already-recorded ids, caches the token', async () => {
  const mb = gbox({ last_received_at: '2026-11-01T09:30:00Z' });
  const list = [
    { id: 'C', internetMessageId: '<c@x>', receivedDateTime: '2026-11-01T09:30:00Z', isRead: false },
    { id: 'D', internetMessageId: '<d@x>', receivedDateTime: '2026-11-01T09:45:00Z', isRead: true },
  ];
  const h = harness(graphHandler({ list }), { env: { MS_SECRET: 's' }, seen: async (m, id) => id === '<c@x>' });
  assert.equal(await graph.poll(mb, h.ctx), 1);
  assert.deepEqual(h.ingested.map((i) => i.ref), ['D']);
  assert.match(decodeURIComponent(h.calls.find((c) => /\/messages\?/.test(c.url)).url), /receivedDateTime ge 2026-11-01T09:30:00Z/);
  const h2 = harness(graphHandler({ list: [] }), { env: { MS_SECRET: 's' } });
  await graph.poll(mb, h2.ctx);
  assert.ok(!h2.calls.some((c) => /oauth2/.test(c.url)), 'token reused from cache');
});

test('graph poll: nothing in the first window still sets a starting point; mark-as-read patches the message', async () => {
  const mb = gbox();
  const h = harness(graphHandler({ list: [] }), { env: { MS_SECRET: 's' } });
  await graph.poll(mb, h.ctx);
  assert.ok(h.sql.some((s) => /last_received_at = \$2 where id = \$1 and last_received_at is null/.test(s.text)));
  const mb2 = gbox({ last_received_at: '2026-11-01T00:00:00Z', mark_seen: true });
  const h2 = harness(graphHandler({ list: [{ id: 'Z', internetMessageId: '<z@x>', receivedDateTime: '2026-11-01T01:00:00Z', isRead: false }] }), { env: { MS_SECRET: 's' } });
  await graph.poll(mb2, h2.ctx);
  const patch = h2.calls.find((c) => c.method === 'PATCH');
  assert.ok(patch); assert.equal(patch.body, JSON.stringify({ isRead: true }));
});

test('graph: a named folder is looked up by display name (quotes escaped)', async () => {
  const mb = gbox({ imap_folder: "Support's" });
  const h = harness(graphHandler({ list: [], folderLookup: [{ id: 'FOLDER-ID' }] }), { env: { MS_SECRET: 's' } });
  await graph.poll(mb, h.ctx);
  assert.match(decodeURIComponent(h.calls.find((c) => /mailFolders\?/.test(c.url)).url), /displayName eq 'Support''s'/);
  assert.ok(h.calls.some((c) => /mailFolders\/FOLDER-ID\/messages/.test(c.url)));
});

test('graph: failures give a useful hint; an item failing to ingest stops before the watermark passes it', async () => {
  const h = harness((url) => (url.includes('login.microsoftonline') ? json({ error: 'invalid_client', error_description: 'AADSTS7000215: Invalid client secret' }, 401) : json({}, 500)), { env: { MS_SECRET: 's' } });
  await assert.rejects(() => graph.poll(gbox(), h.ctx), /AADSTS7000215.*secrets expire/);
  const h2 = harness((url) => (url.includes('login.') ? json({ access_token: 't', expires_in: 3600 }) : json({ error: { message: 'Denied' } }, 403)), { env: { MS_SECRET: 's' } });
  await assert.rejects(() => graph.test(gbox(), h2.ctx), /admin consent/);

  const list = [{ id: 'B', internetMessageId: '<b@x>', receivedDateTime: '2026-11-01T09:00:00Z', isRead: false }, { id: 'C', internetMessageId: '<c@x>', receivedDateTime: '2026-11-01T09:30:00Z', isRead: false }];
  const h3 = harness(graphHandler({ list }), { env: { MS_SECRET: 's' } });
  h3.ctx.ingestSafe = async (mb, raw, info) => { if (info.ref === 'C') throw new Error('db down'); h3.ingested.push(info.ref); };
  const mb = gbox({ last_received_at: '2026-11-01T08:00:00Z' });
  await assert.rejects(() => graph.poll(mb, h3.ctx), /db down/);
  const marks = h3.sql.filter((s) => /last_received_at/.test(s.text)).map((s) => new Date(s.params[1]).toISOString());
  assert.deepEqual(marks, ['2026-11-01T09:00:00.000Z']);   // C was never marked as done
});

test('graph test(): reports the folder counts', async () => {
  const h = harness((url) => (url.includes('login.') ? json({ access_token: 't', expires_in: 3600 }) : json({ displayName: 'Inbox', totalItemCount: 42, unreadItemCount: 3 })), { env: { MS_SECRET: 's' } });
  const r = await graph.test(gbox(), h.ctx);
  assert.equal(r.ok, true); assert.match(r.message, /42 message\(s\), 3 unread/);
});

// ---------------------------------------------------------------- Gmail
const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
const keyFile = path.join(os.tmpdir(), `sa-${process.pid}.json`);
fs.writeFileSync(keyFile, JSON.stringify({ client_email: 'sa@proj.iam.gserviceaccount.com', private_key: privateKey, token_uri: 'https://evil.example/token' }));
test.after(() => fs.rmSync(keyFile, { force: true }));
const mbox = (o = {}) => ({ id: nextId++, key: 'g', name: 'G', provider: 'gmail', address: 'help@corp.com', secret_env: 'G_KEY', last_received_at: null, mark_seen: false, ...o });

test('gmail assertion is a valid RS256 JWT for the impersonated mailbox', () => {
  const key = JSON.parse(fs.readFileSync(keyFile, 'utf8'));
  const jwt = gmail.assertion(key, 'help@corp.com', 'https://www.googleapis.com/auth/gmail.readonly', 1000);
  const [h, b, s] = jwt.split('.');
  assert.deepEqual(JSON.parse(fromB64url(h)), { alg: 'RS256', typ: 'JWT' });
  const claims = JSON.parse(fromB64url(b));
  assert.equal(claims.iss, 'sa@proj.iam.gserviceaccount.com'); assert.equal(claims.sub, 'help@corp.com'); assert.equal(claims.exp, 4600);
  assert.equal(claims.aud, 'https://oauth2.googleapis.com/token');
  assert.ok(crypto.createVerify('RSA-SHA256').update(`${h}.${b}`).verify(publicKey, fromB64url(s)));
});

test('gmail configError', () => {
  assert.equal(gmail.configError(mbox(), { G_KEY: keyFile }), '');
  assert.match(gmail.configError(mbox(), {}), /key-file variable/);
  assert.match(gmail.configError(mbox(), { G_KEY: '/nonexistent.json' }), /does not exist/);
});

function gmailHandler(messages, order) {
  return (url, opts) => {
    if (url === 'https://oauth2.googleapis.com/token') return json({ access_token: 'gtok', expires_in: 3600 });   // never the URL from the key file
    if (/\/messages\?/.test(url)) return json({ messages: order.map((id) => ({ id })) });
    const m = /\/messages\/([^/?]+)\?format=raw/.exec(url);
    if (m) return json({ raw: b64url(`Subject: ${m[1]}\r\n\r\nhello`), internalDate: String(messages[m[1]]) });
    if (/\/modify$/.test(url)) return new Response(null, { status: 200 });
    if (/\/profile$/.test(url)) return json({ emailAddress: 'help@corp.com', messagesTotal: 7 });
    return json({}, 404);
  };
}

test('gmail poll: newest-first listing is processed oldest first, raw is decoded, first run asks for unread only', async () => {
  const msgs = { m1: 1000000, m2: 2000000, m3: 3000000 };
  const h = harness(gmailHandler(msgs, ['m3', 'm2', 'm1']), { env: { G_KEY: keyFile } });
  const mb = mbox();
  assert.equal(await gmail.poll(mb, h.ctx), 3);
  assert.deepEqual(h.ingested.map((i) => i.ref), ['m1', 'm2', 'm3']);
  assert.match(h.ingested[0].raw, /^Subject: m1/);
  assert.match(decodeURIComponent(h.calls.find((c) => /\/messages\?/.test(c.url)).url), /q=is:unread newer_than:2d/);
  const tokenCall = h.calls[0];
  assert.equal(tokenCall.url, 'https://oauth2.googleapis.com/token');
  assert.match(tokenCall.body, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer/);
  const marks = h.sql.filter((s) => /last_received_at/.test(s.text)).map((s) => new Date(s.params[1]).getTime());
  assert.deepEqual(marks, [1000000, 2000000, 3000000]);
  // same ids again (boundary overlap) are not downloaded twice
  const h2 = harness(gmailHandler(msgs, ['m3', 'm2', 'm1']), { env: { G_KEY: keyFile } });
  assert.equal(await gmail.poll({ ...mb, last_received_at: new Date(3000000) }, h2.ctx), 0);
  assert.match(decodeURIComponent(h2.calls.find((c) => /\/messages\?/.test(c.url)).url), /q=after:2940/);
});

test('gmail test() and mark-as-read scope', async () => {
  const h = harness(gmailHandler({}, []), { env: { G_KEY: keyFile } });
  const r = await gmail.test(mbox({ mark_seen: true }), h.ctx);
  assert.equal(r.ok, true); assert.match(r.message, /help@corp.com.*7 message/);
  const claims = JSON.parse(fromB64url(h.calls[0].body.match(/assertion=([^&]+)/)[1].split('.')[1]));
  assert.match(claims.scope, /gmail\.modify/);
});
