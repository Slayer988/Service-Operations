'use strict';
// Applies migrations/*.sql in order, once each. Safe to run repeatedly.
const fs = require('fs');
const path = require('path');
const { pool } = require('../src/db');

async function migrate() {
  const dir = path.join(__dirname, '..', 'migrations');
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const client = await pool.connect();
  try {
    await client.query('select pg_advisory_lock(727001)');
    await client.query('create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())');
    const done = new Set((await client.query('select name from schema_migrations')).rows.map((r) => r.name));
    for (const f of files) {
      if (done.has(f)) continue;
      const sql = fs.readFileSync(path.join(dir, f), 'utf8');
      console.log(`[migrate] applying ${f}`);
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into schema_migrations (name) values ($1)', [f]);
        await client.query('commit');
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${f} failed: ${err.message}`);
      }
    }
    console.log('[migrate] up to date');
  } finally {
    try { await client.query('select pg_advisory_unlock(727001)'); } catch (_) { /* ignore */ }
    client.release();
  }
}

module.exports = migrate;
if (require.main === module) {
  migrate().then(() => pool.end()).catch((e) => { console.error(e.message); process.exit(1); });
}
