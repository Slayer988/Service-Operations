'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ldap = require('../../src/lib/ldap');
const secrets = require('../../src/lib/secrets');
const config = require('../../src/config');
const { assess } = require('../../src/services/mailhealth');

test('escapeFilter neutralises LDAP filter injection', () => {
  assert.equal(ldap.escapeFilter('a*)(uid=*'), 'a\\2a\\29\\28uid=\\2a');
  assert.equal(ldap.escapeFilter('x\\y'), 'x\\5cy');
  const f = ldap.buildUserFilter(ldap.DEFAULT_FILTER, 'bob)(|(cn=*');
  assert.ok(!f.includes('bob)(|(cn=*'));
  assert.equal((f.match(/\(/g) || []).length, (f.match(/\)/g) || []).length + 0);
});

test('buildUserFilter requires the placeholder', () => {
  assert.throws(() => ldap.buildUserFilter('(cn=x)', 'a'), /\{\{u\}\}/);
});

test('settings: only server, domain and service account are needed; the rest is worked out', () => {
  const ok = ldap.validateConfig({ server: 'dc1.corp.local', domain: 'Corp.Local', service_user: 'svc-itsm', enabled: 'on' }).config;
  assert.equal(ok.enabled, true); assert.equal(ok.port, 636); assert.equal(ok.domain, 'corp.local'); assert.equal(ok.default_role, 'agent');
  const d = ldap.derive(ok);
  assert.equal(d.url, 'ldaps://dc1.corp.local:636'); assert.equal(d.starttls, false);
  assert.equal(d.bind_dn, 'svc-itsm@corp.local'); assert.equal(d.base_dn, 'DC=corp,DC=local');
  assert.equal(ldap.derive({ ...ok, port: 389 }).url, 'ldap://dc1.corp.local:389'); assert.equal(ldap.derive({ ...ok, port: 389 }).starttls, true);   // plain ldap:// always upgrades to TLS
  assert.equal(ldap.derive({ ...ok, service_user: 'CORP\\svc' }).bind_dn, 'CORP\\svc');              // a full name is used as typed
  assert.equal(ldap.derive({ ...ok, service_user: 'svc@other.local' }).bind_dn, 'svc@other.local');
  assert.equal(ldap.derive({ ...ok, base_dn: 'OU=Staff,DC=corp,DC=local' }).base_dn, 'OU=Staff,DC=corp,DC=local');
  assert.ok(ldap.isConfigured(d)); assert.ok(!ldap.isConfigured(ldap.derive({})));
});

test('settings: pasted addresses are cleaned, bad input gets a plain message, switching on needs the essentials', () => {
  assert.equal(ldap.validateConfig({ server: 'ldaps://dc1.corp.local:636/', domain: 'corp.local', service_user: 'svc' }).config.server, 'dc1.corp.local');
  assert.equal(ldap.validateConfig({ server: 'dc1.corp.local:3269', domain: 'corp.local', service_user: 'svc' }).config.port, 3269);
  assert.match(ldap.validateConfig({ server: 'dc1/../x', domain: 'corp.local', service_user: 'svc' }).error, /server/);
  assert.match(ldap.validateConfig({ server: 'dc1', port: '99999', domain: 'corp.local' }).error, /port/);
  assert.match(ldap.validateConfig({ server: 'dc1', domain: 'not a domain' }).error, /domain/);
  assert.match(ldap.validateConfig({ server: 'dc1', domain: 'corp.local', ca_file: '../../etc/shadow' }).error, /certificate file/);
  assert.match(ldap.validateConfig({ server: 'dc1', domain: 'corp.local', base_dn: 'nonsense' }).error, /search base/);
  assert.match(ldap.validateConfig({ enabled: 'on', server: 'dc1', domain: 'corp.local' }).error, /service account/);
  assert.ok(ldap.validateConfig({ enabled: false }).config);
  assert.equal(ldap.validateConfig({ server: 'dc1', domain: 'corp.local', default_role: 'customer_admin' }).config.default_role, 'agent');
});

test('settings saved by earlier versions still work', () => {
  const d = ldap.derive({ enabled: true, url: 'ldaps://dc.old:636', bind_dn: 'svc@corp.local', base_dn: 'DC=corp,DC=local', group_mappings: [{ group_dn: 'x', role: 'agent' }] });
  assert.equal(d.server, 'dc.old'); assert.equal(d.port, 636); assert.equal(d.domain, 'corp.local'); assert.equal(d.bind_dn, 'svc@corp.local'); assert.equal(d.url, 'ldaps://dc.old:636');
  assert.equal(ldap.baseToDomain('OU=x,DC=corp,DC=local'), 'corp.local'); assert.equal(ldap.domainToBase('a.b.c'), 'DC=a,DC=b,DC=c');
});

test('the service account password is stored encrypted and only the same server can read it', () => {
  config.sessionSecret = 'a'.repeat(40);
  const e = secrets.encrypt('P@ss w0rd!');
  assert.ok(e.startsWith('v1:') && !e.includes('P@ss'));
  assert.equal(secrets.decrypt(e), 'P@ss w0rd!');
  assert.notEqual(secrets.encrypt('P@ss w0rd!'), e);                       // a fresh random value each time
  assert.equal(secrets.decrypt(e.slice(0, -4) + 'AAAA'), null);            // tampering is detected
  assert.equal(secrets.decrypt('plain'), null); assert.equal(secrets.decrypt(null), null);
  config.sessionSecret = 'b'.repeat(40);
  assert.equal(secrets.decrypt(e), null);                                  // another SESSION_SECRET cannot read it
  config.sessionSecret = 'a'.repeat(40);
});

test('isDisabled reads the AD userAccountControl bit', () => {
  assert.equal(ldap.isDisabled('514'), true);
  assert.equal(ldap.isDisabled(['512']), false);
  assert.equal(ldap.isDisabled(undefined), false);
});

// ---- authenticate() against a fake directory
function fakeDirectory({ users, goodPasswords }) {
  const log = [];
  ldap._useClientFactory(() => ({
    async bind(dn, pw) {
      log.push(['bind', dn]);
      if (dn === 'svc@c.local' && pw === 'svcpw') return;
      if (goodPasswords[dn] === pw && pw) return;
      const e = new Error('bad'); e.name = 'InvalidCredentialsError'; e.code = 49; throw e;
    },
    async search(base, opt) {
      log.push(['search', base, opt.filter]);
      return { searchEntries: users.filter((u) => opt.filter.includes(u.sAMAccountName)) };
    },
    async unbind() {},
  }));
  return log;
}
const cfg = ldap.derive({ enabled: true, server: 'x', domain: 'c.local', service_user: 'svc' });
const jane = { dn: 'CN=Jane,DC=c', sAMAccountName: 'jane', mail: 'Jane@Corp.Local', displayName: 'Jane D', userAccountControl: '512' };

test('authenticate: success returns the person (no groups, no role)', async () => {
  fakeDirectory({ users: [jane], goodPasswords: { 'CN=Jane,DC=c': 'Correct-horse-1' } });
  const r = await ldap.authenticate(cfg, 'svcpw', 'jane', 'Correct-horse-1');
  assert.equal(r.ok, true); assert.equal('role' in r, false);
  assert.equal(r.user.email, 'jane@corp.local'); assert.equal(r.user.name, 'Jane D'); assert.equal(r.user.dn, 'CN=Jane,DC=c');
});

test('authenticate: wrong password, empty password, unknown user, account disabled in AD', async () => {
  const log = fakeDirectory({ users: [jane, { ...jane, sAMAccountName: 'off', dn: 'CN=Off,DC=c', userAccountControl: '514' }], goodPasswords: { 'CN=Jane,DC=c': 'Correct-horse-1', 'CN=Off,DC=c': 'Correct-horse-1' } });
  assert.deepEqual(await ldap.authenticate(cfg, 'svcpw', 'jane', 'nope'), { ok: false, reason: 'bad_password' });
  assert.deepEqual(await ldap.authenticate(cfg, 'svcpw', 'jane', ''), { ok: false, reason: 'bad_password' });
  assert.deepEqual(await ldap.authenticate(cfg, 'svcpw', 'ghost', 'x'), { ok: false, reason: 'unknown' });
  assert.equal((await ldap.authenticate(cfg, 'svcpw', 'off', 'Correct-horse-1')).reason, 'disabled');
  assert.ok(!log.some((l) => l[0] === 'bind' && l[1] === 'CN=Off,DC=c'), 'a disabled account is never even tried');
});

test('authenticate: typed name cannot inject into the filter', async () => {
  const log = fakeDirectory({ users: [jane], goodPasswords: {} });
  await ldap.authenticate(cfg, 'svcpw', 'jane)(objectClass=*', 'x');
  const f = log.find((l) => l[0] === 'search')[2];
  assert.ok(f.includes('jane\\29\\28objectClass=\\2a'));
});

test('authenticate: infrastructure failure throws instead of reporting a wrong password', async () => {
  ldap._useClientFactory(() => ({ async bind() { throw new Error('connect ECONNREFUSED'); }, async unbind() {} }));
  await assert.rejects(() => ldap.authenticate(cfg, 'svcpw', 'jane', 'x'), /ECONNREFUSED/);
  await assert.rejects(() => ldap.authenticate(cfg, '', 'jane', 'x'), /password is not set/);
});

test('searchUsers: escapes what was typed, sorts by name, flags a long list, copes with too many matches', async () => {
  const seen = [];
  const people = [{ dn: 'CN=Zed', sAMAccountName: 'zed', mail: 'z@c', displayName: 'Zed', userAccountControl: '512' }, { dn: 'CN=Amy', sAMAccountName: 'amy', mail: 'a@c', displayName: 'Amy', userAccountControl: '514' }];
  ldap._useClientFactory(() => ({ async bind() {}, async search(base, opt) { seen.push(opt); return { searchEntries: people }; }, async unbind() {} }));
  const r = await ldap.searchUsers(cfg, 'svcpw', 'a*)(x=');
  assert.deepEqual(r.users.map((u) => u.name), ['Amy', 'Zed']); assert.equal(r.users[0].disabled, true); assert.equal(r.tooMany, false);
  assert.ok(seen[0].filter.includes('a\\2a\\29\\28x=') && !seen[0].filter.includes('a*)(x='));
  assert.equal(seen[0].sizeLimit, 100);
  await ldap.searchUsers(cfg, 'svcpw', ''); assert.ok(!seen[1].filter.includes('displayName'), 'an empty search lists people');
  ldap._useClientFactory(() => ({ async bind() {}, async search() { const e = new Error('limit'); e.code = 4; throw e; }, async unbind() {} }));
  assert.deepEqual(await ldap.searchUsers(cfg, 'svcpw', 'a'), { users: [], tooMany: true });
  ldap._useClientFactory(() => ({ async bind() {}, async search() { return { searchEntries: Array.from({ length: 100 }, (_, i) => ({ dn: `CN=${i}`, sAMAccountName: `u${i}`, displayName: `U${i}` })) }; }, async unbind() {} }));
  assert.equal((await ldap.searchUsers(cfg, 'svcpw', '')).tooMany, true);
  ldap._useClientFactory(() => ({ async bind() { throw new Error('ETIMEDOUT'); }, async unbind() {} }));
  await assert.rejects(() => ldap.searchUsers(cfg, 'svcpw', 'a'), /ETIMEDOUT/);
});

test('testConnection counts people', async () => {
  ldap._useClientFactory(() => ({ async bind() {}, async search(base, opt) { return { searchEntries: opt.scope === 'base' ? [{ dn: base }] : Array.from({ length: 14 }, (_, i) => ({ dn: `CN=${i}` })) }; }, async unbind() {} }));
  assert.deepEqual(await ldap.testConnection(cfg, 'svcpw'), { ok: true, people: 14, more: false });
  ldap._useClientFactory(() => ({ async bind() { const e = new Error('bad'); e.code = 49; throw e; }, async unbind() {} }));
  await assert.rejects(() => ldap.testConnection(cfg, 'wrong'));
});

test('recheck: gone, disabled, ok; unreachable throws', async () => {
  const bob = { dn: 'CN=Bob,DC=c', sAMAccountName: 'bob', mail: 'b@c', displayName: 'Bob', userAccountControl: '514' };
  const amy = { dn: 'CN=Amy,DC=c', sAMAccountName: 'amy', mail: 'a@c', displayName: 'Amy', userAccountControl: '512' };
  const entries = { 'CN=Bob,DC=c': bob, 'CN=Amy,DC=c': amy };
  ldap._useClientFactory(() => ({
    async bind() {},
    async search(base, opt) {
      if (opt.scope === 'base' && entries[base]) return { searchEntries: [entries[base]] };
      const e = new Error('no'); e.code = 32; throw e;
    },
    async unbind() {},
  }));
  const r = await ldap.recheck(cfg, 'svcpw', ['CN=Gone,DC=c', 'CN=Bob,DC=c', 'CN=Amy,DC=c']);
  assert.deepEqual(r.map((x) => x.state), ['gone', 'disabled', 'ok']);
  assert.equal(r[2].user.email, 'a@c');
  ldap._useClientFactory(() => ({ async bind() { throw new Error('ETIMEDOUT'); }, async unbind() {} }));
  await assert.rejects(() => ldap.recheck(cfg, 'svcpw', ['CN=Amy,DC=c']), /ETIMEDOUT/);
  ldap._useClientFactory(null);
});

// ---- mailbox health
const now = Date.parse('2026-11-01T10:00:00Z');
const box = (o) => ({ enabled: true, consecutive_failures: 0, stale_minutes: 15, poll_seconds: 60, last_success_at: '2026-11-01T09:59:00Z', last_error: '', last_status: 'ok', ...o });

test('assess: healthy, failing, stale, slow polling, disabled', () => {
  assert.equal(assess(box({}), now).healthy, true);
  assert.equal(assess(box({ consecutive_failures: 3, last_error: 'auth failed' }), now).healthy, false);
  assert.equal(assess(box({ consecutive_failures: 2 }), now).healthy, true);
  assert.equal(assess(box({ last_success_at: '2026-11-01T09:30:00Z' }), now).healthy, false);
  assert.equal(assess(box({ last_success_at: '2026-11-01T09:30:00Z', poll_seconds: 1800 }), now).healthy, true);   // 3 x 30 min allowed
  assert.equal(assess(box({ enabled: false, consecutive_failures: 9 }), now).healthy, true);
  assert.equal(assess(box({ last_success_at: null }), now).healthy, true);   // never succeeded yet: failures decide
});
