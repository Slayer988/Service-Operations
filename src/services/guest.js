'use strict';
// Requests without signing in. A person at a customer gives their e-mail address and the customer's CSID. When the address is on one of
// the customer's e-mail domains and the CSID is that customer's active CSID, a 6-digit code is e-mailed to the address. Typing the code
// proves they can read that mailbox; they then see the services on that CSID and can raise a ticket on it.
//
// The answer to the first step is the same whether or not the details match, so the page cannot be used to find out which addresses,
// domains or CSIDs exist. Codes are stored only as a keyed hash, expire after 15 minutes, allow 5 tries, and are limited per address and
// per network address.
const crypto = require('crypto');
const config = require('../config');
const settings = require('../lib/settings');
const mailer = require('../lib/mailer');
const outgoing = require('./outgoing');
const u = require('../lib/util');

const CODE_MINUTES = 15;
const SESSION_MINUTES = 30;
const MAX_TRIES = 5;
const PER_EMAIL_PER_HOUR = 3;
const PER_IP_PER_HOUR = 30;                 // a whole office can share one address
const TICKETS_PER_SESSION = 5;

// ---------------------------------------------------------------- domains
const DOMAIN_RE = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** The domains typed on the customer page (one per line, or separated by commas or spaces), checked and de-duplicated. */
function parseDomains(text) {
  const out = []; const bad = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const d = raw.trim().toLowerCase().replace(/^@/, '').replace(/\.$/, '');
    if (!d) continue;
    if (!DOMAIN_RE.test(d)) bad.push(raw.trim()); else if (!out.includes(d)) out.push(d);
  }
  if (bad.length) return { error: `Not a valid e-mail domain: ${bad.slice(0, 3).join(', ')}. Type only the part after @, for example example.co.ug.` };
  if (out.length > 20) return { error: 'At most 20 e-mail domains per customer.' };
  return { domains: out };
}

/** The domain of an address, or '' (exact match only: a sub-domain must be listed itself). */
const domainOf = (email) => { const m = /@([^@]+)$/.exec(String(email || '').toLowerCase()); return m ? m[1] : ''; };

// ---------------------------------------------------------------- codes
const key = () => crypto.createHash('sha256').update(`guest-code:${config.sessionSecret}`).digest();
const hashCode = (id, code) => crypto.createHmac('sha256', key()).update(`${id}:${code}`).digest('hex');
const newCode = () => String(crypto.randomInt(0, 1000000)).padStart(6, '0');

// Every request to send a code counts against the network address and against the e-mail address, whether or not it matched, so the
// limits behave the same for addresses that exist and those that do not (one web process; the window is an hour).
const ipHits = new Map(); const emailHits = new Map();
function allowed(map, k, max, now = Date.now()) {
  const hour = 3600000;
  const list = (map.get(k) || []).filter((t) => now - t < hour);
  if (list.length >= max) { map.set(k, list); return false; }
  list.push(now); map.set(k, list);
  if (map.size > 5000) for (const [kk, v] of map) if (!v.some((t) => now - t < hour)) map.delete(kk);
  return true;
}

async function enabled(db) {
  return (await settings.get(db, 'guest_requests_enabled', true)) !== false;
}
/** Whether codes can be e-mailed at all (no mail server = the page says the service is not available). */
async function canSend(db) {
  return (await outgoing.effective(db)).source !== 'none';
}

/** The customer and CSID that this address and CSID belong to, or null. */
async function match(db, email, csidText) {
  const domain = domainOf(email);
  if (!domain) return null;
  return (await db.query(
    `select c.id as customer_id, c.name as customer_name, x.id as csid_id, x.csid
       from csids x join customers c on c.id = x.customer_id
      where upper(x.csid) = upper($1) and x.status = 'active' and c.status = 'active' and $2 = any(c.email_domains)`, [csidText, domain])).rows[0] || null;
}

/**
 * Step 1. Returns { pendingId } (the code row, or null when nothing matched) or { error } for things that are the person's own doing
 * (a malformed address or CSID, too many requests). The caller says the same thing either way.
 */
async function requestCode(db, { email: rawEmail, csid: rawCsid, ip }) {
  const email = u.email(rawEmail);
  const csid = u.str(rawCsid, 40).toUpperCase().replace(/\s+/g, '');
  if (!email) return { error: 'Enter your e-mail address.' };
  if (!/^[A-Z0-9-]{3,40}$/.test(csid)) return { error: 'Enter the CSID exactly as it appears on your contract or invoice (for example CS-000123).' };
  if (!allowed(ipHits, ip || '', PER_IP_PER_HOUR)) return { error: 'Too many requests from your network. Please try again in an hour.' };
  if (!allowed(emailHits, email, PER_EMAIL_PER_HOUR)) return { error: 'Too many codes were requested for this address. Please try again in an hour.' };
  const m = await match(db, email, csid);
  if (!m) {
    console.log(`[guest] no match for a code request (domain ${domainOf(email)}, ip ${ip || '?'})`);
    return { pendingId: null, email };
  }
  const code = newCode();
  const row = (await db.query(
    `insert into guest_codes (email, customer_id, csid_id, code_hash, expires_at, ip) values ($1,$2,$3,'',now() + ($4 || ' minutes')::interval,$5) returning id`,
    [email, m.customer_id, m.csid_id, String(CODE_MINUTES), u.str(ip, 60)])).rows[0];
  await db.query('update guest_codes set code_hash = $2 where id = $1', [row.id, hashCode(row.id, code)]);
  // Sent straight away and not kept in the outbox (the code is a secret and only useful for a few minutes). Not waited for, so the
  // answer takes the same time whether or not the details matched.
  mailer.send({
      to: email, subject: `Your code to raise a request: ${code}`,
      text: `Your one-time code is: ${code}\n\nType it on the page where you asked for it. It is valid for ${CODE_MINUTES} minutes and can only be used once.\n`
        + `It lets you raise a request for ${m.customer_name} (${m.csid}).\n\nIf you did not ask for this code, you can ignore this message.\n`,
  }).then((out) => { if (out && out.logged) console.error('[guest] the code could not be sent: outgoing mail is not set up'); },
    (err) => console.error('[guest] the code could not be sent:', err.message));
  return { pendingId: row.id, email };
}

/** Step 2. Returns { ok: { email, customer_id, csid_id } } or { error, restart? }. */
async function checkCode(db, pendingId, typed) {
  const code = String(typed || '').replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return { error: 'Type the 6-digit code from the e-mail.' };
  if (!pendingId) return { error: 'That code is not correct.' };
  const row = (await db.query('select * from guest_codes where id = $1 for update', [pendingId])).rows[0];
  if (!row || row.used_at) return { error: 'This code was already used. Ask for a new one.', restart: true };
  if (new Date(row.expires_at) < new Date()) return { error: 'This code has expired. Ask for a new one.', restart: true };
  if (row.attempts >= MAX_TRIES) return { error: 'Too many wrong tries. Ask for a new code.', restart: true };
  const good = crypto.timingSafeEqual(Buffer.from(row.code_hash, 'hex'), Buffer.from(hashCode(row.id, code), 'hex'));
  if (!good) {
    await db.query('update guest_codes set attempts = attempts + 1 where id = $1', [row.id]);
    return row.attempts + 1 >= MAX_TRIES ? { error: 'Too many wrong tries. Ask for a new code.', restart: true } : { error: 'That code is not correct.' };
  }
  await db.query('update guest_codes set used_at = now() where id = $1', [row.id]);
  return { ok: { email: row.email, customer_id: Number(row.customer_id), csid_id: Number(row.csid_id) } };
}

/** What the confirmed person may see: the customer, the CSID and its active services. Null when anything stopped being valid. */
async function context(db, g) {
  if (!g || !g.email || !g.until || Date.now() > g.until) return null;
  const c = (await db.query(
    `select c.id as customer_id, c.name as customer_name, c.email_domains, x.id as csid_id, x.csid, x.description
       from csids x join customers c on c.id = x.customer_id where x.id = $1 and c.id = $2 and x.status = 'active' and c.status = 'active'`, [g.csid_id, g.customer_id])).rows[0];
  if (!c || !c.email_domains.includes(domainOf(g.email))) return null;            // the domain was removed or the CSID ended meanwhile
  const services = (await db.query(`select id, name, service_type from services where csid_id = $1 and customer_id = $2 and status = 'active' order by name`, [c.csid_id, c.customer_id])).rows;
  return { ...c, services };
}

/** Remove old codes (the daily job). */
async function purge(db) {
  const r = await db.query(`delete from guest_codes where created_at < now() - interval '2 days' returning id`);
  return r.rows.length;
}

module.exports = {
  CODE_MINUTES, SESSION_MINUTES, MAX_TRIES, PER_EMAIL_PER_HOUR, PER_IP_PER_HOUR, TICKETS_PER_SESSION,
  parseDomains, domainOf, enabled, canSend, match, requestCode, checkCode, context, purge, _ipHits: ipHits, _emailHits: emailHits, _hashCode: hashCode,
};
