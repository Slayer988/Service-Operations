'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const smtp = require('../../src/lib/smtp');

test('smtp settings: the port follows the security, a pasted address is cleaned, the From address is needed', () => {
  let r = smtp.validate({ server: 'smtp.example.com', from_address: 'ops@example.com' });
  assert.deepEqual([r.config.security, r.config.port], ['starttls', 587]);
  assert.deepEqual([smtp.validate({ server: 'smtp.example.com', security: 'ssl', from_address: 'a@b.co' }).config.port, smtp.validate({ server: 'x.co', security: 'none', from_address: 'a@b.co' }).config.port], [465, 25]);
  r = smtp.validate({ server: 'smtp://Mail.Example.com:465/', from_address: 'a@b.co' });
  assert.deepEqual([r.config.server, r.config.port, r.config.security], ['Mail.Example.com', 465, 'ssl']);
  assert.match(smtp.validate({ server: 'smtp.example.com', from_address: '' }).error, /From address/);
  assert.match(smtp.validate({ server: 'smtp.example.com', from_address: 'not an address' }).error, /must look like/);
  assert.match(smtp.validate({ server: 'a b', from_address: 'a@b.co' }).error, /mail server must be/);
  assert.match(smtp.validate({ server: 'x.co', port: '70000', from_address: 'a@b.co' }).error, /port/);
  assert.equal(smtp.validate({ server: '', from_address: '' }).config.server, '', 'an empty server just switches it off');
});

test('smtp settings: the sender name cannot inject headers or break the From line', () => {
  const r = smtp.validate({ server: 'x.co', from_address: 'a@b.co', from_name: 'Ops "Desk" <evil@x.co>\\' });
  assert.equal(r.config.from_name, 'Ops Desk evil@x.co');
  assert.equal(smtp.fromHeader(r.config), '"Ops Desk evil@x.co" <a@b.co>');
  assert.match(smtp.validate({ server: 'x.co', from_address: 'a@b.co', from_name: 'Ops\r\nBcc: x@y.co' }).error, /sender name/);
  assert.match(smtp.validate({ server: 'x.co', from_address: 'a@b.co\r\nBcc: x@y.co' }).error, /From address/);
  assert.equal(smtp.fromHeader({ from_name: '', from_address: 'a@b.co' }), 'a@b.co');
});

test('smtp connection options: STARTTLS is demanded, SSL/TLS is encrypted from the start, None is never encrypted', () => {
  const base = { server: 'm.example.com', user: '', allow_untrusted: false };
  const st = smtp.transportOptions(smtp.derive({ ...base, security: 'starttls', port: 587 }), '');
  assert.deepEqual([st.secure, st.requireTLS, st.ignoreTLS, st.auth], [false, true, undefined, undefined]);
  const ssl = smtp.transportOptions(smtp.derive({ ...base, security: 'ssl', port: 465 }), '');
  assert.deepEqual([ssl.secure, ssl.requireTLS], [true, undefined]);
  const none = smtp.transportOptions(smtp.derive({ ...base, security: 'none', port: 25, user: 'u' }), 'pw');
  assert.deepEqual([none.secure, none.ignoreTLS, none.auth], [false, true, { user: 'u', pass: 'pw' }]);
  assert.equal(smtp.transportOptions(smtp.derive({ ...base, security: 'ssl' }), '').tls, undefined, 'certificates are checked unless the administrator chose otherwise');
  assert.deepEqual(smtp.transportOptions(smtp.derive({ ...base, security: 'ssl', allow_untrusted: true }), '').tls, { rejectUnauthorized: false });
  const d = smtp.derive({}); assert.deepEqual([d.server, d.security, d.port], ['', 'starttls', 587]);
});

test('smtp explain: failures are put in plain words and the password is removed', () => {
  const cfg = { server: 'mail.example.com', port: 587, security: 'starttls' };
  const err = (message, code, responseCode) => Object.assign(new Error(message), { code, responseCode });
  const cases = [
    [err('Invalid login: 535 5.7.8 Authentication failed', 'EAUTH', 535), /refused the user name or password/],
    [err('Greeting never received', 'ETIMEDOUT'), /did not answer in time/],
    [err('connect ECONNREFUSED 10.1.1.1:587', 'ECONNREFUSED'), /Nothing is listening on mail\.example\.com on port 587/],
    [err('getaddrinfo ENOTFOUND mail.example.com', 'ENOTFOUND'), /cannot find that mail server name/],
    [err('Client network socket disconnected before secure TLS connection was established', 'ECONNECTION'), /port and the security usually do not match/],
    [err('550 5.7.1 Unable to relay', 'EENVELOPE', 550), /will not pass this mail on/],
    [err('Mail command failed: 550 5.7.60 SendAsDenied', 'EENVELOPE', 550), /does not allow this account to send as that From address/],
    [err('530 5.7.0 Authentication required', 'EAUTH', 530), /wants a user name and password/],
    [err('self-signed certificate in certificate chain', 'ESOCKET'), /does not trust the mail server's certificate/],
    [err("Hostname/IP does not match certificate's altnames", 'ESOCKET'), /different name than the one you typed/],
  ];
  for (const [e, re] of cases) assert.match(smtp.explain(e, cfg), re, e.message);
  assert.equal(smtp.explain(new Error('something odd'), cfg), 'something odd', 'unknown errors are shown as they are');
  const out = smtp.explain(new Error('Invalid login for user, password S3cret!pw rejected'), cfg, 'S3cret!pw');
  assert.ok(!out.includes('S3cret!pw'));
});

test('outgoing mail is wired: the E-mail page card, the routes, the mailer reads the saved settings for each message', () => {
  const fs = require('node:fs'); const path = require('node:path');
  const read = (p) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
  assert.match(read('src/views/staff/mail.ejs'), /id="outgoing"/);
  assert.match(read('src/routes/mail.js'), /\/mail\/outgoing\/test/);
  const mailer = read('src/lib/mailer.js');
  assert.ok(/outgoing\.effective/.test(mailer) && !/config\.smtp/.test(mailer), 'the mailer takes its server from the saved settings, not from a fixed copy of the environment');
});
