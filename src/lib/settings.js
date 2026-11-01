'use strict';
async function getAll(db, keys) {
  const r = await db.query('select key, value from settings where key = any($1)', [keys]);
  const out = {};
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}
async function get(db, key, fallback = null) {
  const r = await db.query('select value from settings where key = $1', [key]);
  return r.rows.length ? r.rows[0].value : fallback;
}
async function set(db, key, value) {
  await db.query(
    `insert into settings (key, value) values ($1, $2::jsonb)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, JSON.stringify(value)],
  );
}
module.exports = { get, getAll, set };
