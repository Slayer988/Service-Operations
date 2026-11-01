'use strict';
// Create a staff user (default: platform administrator).
//   node scripts/create-admin.js --email you@example.com --name "Your Name" [--role platform_admin] [--password ...]
// If --password is omitted a random one is generated and printed once.
const { pool, q } = require('../src/db');
const password = require('../src/lib/password');
const perms = require('../src/lib/perms');

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i > -1 ? process.argv[i + 1] : undefined; }

(async () => {
  const email = (arg('email') || '').trim().toLowerCase();
  const name = arg('name') || email.split('@')[0];
  const role = arg('role') || 'platform_admin';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Give a valid --email');
  if (!perms.STAFF_ROLES.includes(role)) throw new Error(`--role must be one of: ${perms.STAFF_ROLES.join(', ')}`);
  const pw = arg('password') || password.randomPassword();
  const hash = await password.hash(pw);
  const existing = await q('select id from users where lower(email) = $1', [email]);
  if (existing.rows.length) {
    await q(`update users set password_hash = $2, role = $3, active = true, failed_logins = 0, locked_until = null, password_changed_at = now() where id = $1 and kind = 'staff'`, [existing.rows[0].id, hash, role]);
    console.log(`Updated staff user ${email} (${role}).`);
  } else {
    await q(`insert into users (email, name, kind, role, password_hash, password_changed_at) values ($1,$2,'staff',$3,$4,now())`, [email, name, role, hash]);
    console.log(`Created staff user ${email} (${role}).`);
  }
  if (!arg('password')) console.log(`Password (shown only now): ${pw}`);
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
