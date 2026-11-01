'use strict';
const { Pool, types } = require('pg');

// bigint (int8) columns hold our ids and counters; all are far below 2^53, so return them as numbers
// (the driver returns strings by default, which breaks strict comparisons such as user.id === ticket.assignee_id).
types.setTypeParser(20, (v) => parseInt(v, 10));
// `date` columns are calendar days with no time zone: keep them as 'YYYY-MM-DD' strings (the driver would make local-midnight Dates, which drift by a day).
types.setTypeParser(1082, (v) => v);

// node-postgres reads PGHOST / PGUSER / PGDATABASE / PGPASSWORD / PGPORT from the environment.
// On the server PGHOST=/var/run/postgresql (unix socket, peer authentication, no password).
const pool = new Pool({ max: 10, idleTimeoutMillis: 30000 });
pool.on('error', (err) => console.error('[db] idle client error', err.message));

const q = (text, params) => pool.query(text, params);

async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await fn(client);
    await client.query('commit');
    return result;
  } catch (err) {
    try { await client.query('rollback'); } catch (_) { /* ignore */ }
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { pool, q, tx };
