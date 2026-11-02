'use strict';
// Outgoing mail settings: checking what an administrator typed, turning it into connection options, and explaining failures in plain words.
// The password is stored encrypted by services/outgoing.js (lib/secrets.js); nothing in here ever sees it except to remove it from messages.

const SECURITY = ['starttls', 'ssl', 'none'];
const DEFAULT_PORT = { starttls: 587, ssl: 465, none: 25 };
const HOST_RE = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;
const MAIL_RE = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;
const CONTROL = /[\u0000-\u001f\u007f]/;

/** Validate what the form sent. Returns { config } (everything except the password) or { error } in plain words. */
function validate(input) {
  let server = String(input.server || '').trim().replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '');
  const noPort = input.port === undefined || input.port === null || String(input.port).trim() === '';
  let port = noPort ? null : Number(input.port);
  const m = /^([^:/]+):(\d{1,5})$/.exec(server);                           // someone pasted "smtp.example.com:465"
  if (m) { server = m[1]; if (noPort) port = Number(m[2]); }
  const security = SECURITY.includes(input.security) ? input.security : (port === 465 ? 'ssl' : port === 25 ? 'none' : 'starttls');
  if (port === null) port = DEFAULT_PORT[security];
  const c = {
    server, port, security,
    user: String(input.user || '').trim(),
    from_address: String(input.from_address || '').trim(),
    from_name: String(input.from_name || '').replace(/[<>"\\]/g, '').trim(),
    allow_untrusted: input.allow_untrusted === true || input.allow_untrusted === 'on',
  };
  if (c.server && !HOST_RE.test(c.server)) return { error: 'The mail server must be a name such as smtp.example.com or an IPv4 address, with no slashes or spaces.' };
  if (!Number.isInteger(c.port) || c.port < 1 || c.port > 65535) return { error: 'The port must be a number from 1 to 65535 (587, 465 or 25 is normal).' };
  if (c.user.length > 254 || CONTROL.test(c.user)) return { error: 'The user name is too long or contains characters that are not allowed.' };
  if (CONTROL.test(c.from_name) || c.from_name.length > 80) return { error: 'The sender name is too long or contains characters that are not allowed.' };
  if (c.server && !c.from_address) return { error: 'Enter the From address: the address your mail server lets this application send as, such as noreply@example.com.' };
  if (c.from_address && (!MAIL_RE.test(c.from_address) || c.from_address.length > 254 || CONTROL.test(c.from_address))) return { error: 'The From address must look like noreply@example.com.' };
  return { config: c };
}

/** The settings as stored, with the values the connection needs filled in. Works for an empty or older record too. */
function derive(stored) {
  const c = { ...(stored || {}) };
  c.server = String(c.server || '');
  c.security = SECURITY.includes(c.security) ? c.security : 'starttls';
  c.port = Number(c.port) || DEFAULT_PORT[c.security];
  c.user = String(c.user || '');
  c.from_address = String(c.from_address || '');
  c.from_name = String(c.from_name || '');
  c.allow_untrusted = c.allow_untrusted === true;
  return c;
}

/** The From header: "Name" <address>. */
function fromHeader(c) {
  return c.from_name ? `"${c.from_name}" <${c.from_address}>` : c.from_address;
}

/** Options for nodemailer. STARTTLS is demanded (no silent downgrade), SSL/TLS connects encrypted, None never encrypts. */
function transportOptions(c, password) {
  const o = {
    host: c.server, port: c.port,
    secure: c.security === 'ssl',
    connectionTimeout: 15000, greetingTimeout: 15000, socketTimeout: 30000,
  };
  if (c.security === 'starttls') o.requireTLS = true;
  if (c.security === 'none') o.ignoreTLS = true;
  if (c.security !== 'none' && c.allow_untrusted) o.tls = { rejectUnauthorized: false };
  if (c.user) o.auth = { user: c.user, pass: password || '' };
  return o;
}

function scrub(err, ...secrets) {
  let msg = String((err && err.message) || err || 'Unknown error');
  for (const s of secrets) if (s && String(s).length > 2) msg = msg.split(String(s)).join('***');
  return msg;
}

/** A plain-words reason before the technical message. cfg: { server, port, security, user }. */
function explain(err, cfg, ...secrets) {
  const raw = scrub(err, ...secrets);
  const code = String((err && err.code) || '');
  const resp = Number(err && err.responseCode) || 0;
  const text = `${raw} ${code}`;
  const c = cfg || {};
  const where = c.server ? `${c.server} on port ${c.port}` : 'the mail server';
  let hint = '';
  if (resp === 530 || /Authentication required|Client was not authenticated|5\.7\.57|must issue a STARTTLS|Must issue a STARTTLS/i.test(text)) {
    hint = /STARTTLS/i.test(text)
      ? 'The mail server wants an encrypted connection first. Set Connection security to STARTTLS (port 587) or SSL/TLS (port 465).'
      : 'The mail server wants a user name and password before it accepts mail. Enter them.';
  } else if (code === 'EAUTH' || resp === 535 || /Invalid login|Authentication unsuccessful|authentication failed|5\.7\.8|5\.7\.139|BadCredentials|Username and Password not accepted/i.test(text)) {
    hint = 'The mail server refused the user name or password. Check both. Microsoft 365 and Gmail often refuse a normal password for this kind of sign-in: they need SMTP sign-in switched on for the account, or an app password.';
  } else if (/Relay access denied|Unable to relay|5\.7\.1\b|5\.7\.54|relay not permitted|not permitted to relay/i.test(text)) {
    hint = 'The mail server will not pass this mail on. Ask whoever runs it to allow this server\'s address to send, or sign in with a user name and password.';
  } else if (/SendAsDenied|5\.7\.60|not owned by user|Sender address rejected|sender.*(not allowed|rejected)/i.test(text) || resp === 553 || code === 'EENVELOPE') {
    hint = 'The mail server does not allow this account to send as that From address. Use the account\'s own address, or an address it is allowed to send as.';
  } else if (/ECONNRESET|wrong version number|SSL routines|ssl3_get_record|before secure TLS|socket hang up|EPROTO/i.test(text)) {
    hint = `${where} closed the connection while the encrypted link was being set up. The port and the security usually do not match: STARTTLS goes with port 587, SSL/TLS with port 465, and None with port 25.`;
  } else if (/STARTTLS/i.test(text)) {
    hint = 'The mail server does not offer STARTTLS. Choose SSL/TLS (port 465), or None on a trusted internal network.';
  } else if (/ECONNREFUSED/i.test(text)) {
    hint = `Nothing is listening on ${where}. Check the server name, the port and the security, and that the firewall allows this server to reach it.`;
  } else if (/ETIMEDOUT|timed out|timeout|Greeting never received|ESOCKET.*closed/i.test(text) && !/certificate/i.test(text)) {
    hint = `${where} did not answer in time. Usually a firewall between this server and the mail server (many hosting and cloud networks block port 25), or the wrong port or security.`;
  } else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(text)) {
    hint = 'This server cannot find that mail server name. Check the spelling, or use an address that this server\'s DNS knows.';
  } else if (/Hostname\/IP|altnames|does not match/i.test(text)) {
    hint = 'The certificate was issued for a different name than the one you typed. Use the exact server name that is on the certificate, not an IP address or a shorter name.';
  } else if (/self[- ]signed|unable to verify|UNABLE_TO_GET_ISSUER|CERT_|certificate/i.test(text)) {
    hint = 'This server does not trust the mail server\'s certificate. Under Advanced you can accept it, which is reasonable for a mail server inside your own network that you trust; better, install your company CA certificate on this server.';
  } else if (/message.*(too large|size)/i.test(text) || resp === 552) {
    hint = 'The mail server refused the message as too large.';
  }
  return hint ? `${hint} (${raw})` : raw;
}

module.exports = { SECURITY, DEFAULT_PORT, validate, derive, fromHeader, transportOptions, explain, scrub };
