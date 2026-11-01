'use strict';
// Background jobs: notification outbox, SLA watch, mailbox polling, renewal reminders, auto-close.
// Runs as its own systemd service. A PostgreSQL advisory lock keeps two copies from doing the work twice.
const config = require('./config');
config.validate();
const { pool, q } = require('./db');
const notifications = require('./services/notifications');
const watch = require('./services/watch');
const inbound = require('./services/inbound');
const contracts = require('./services/contracts');
const directory = require('./services/directory');
const mailhealth = require('./services/mailhealth');
const tenders = require('./services/tenders');
const pipeline = require('./services/pipeline');

const db = { query: q };
let stopping = false;
const lastRun = {};

async function every(name, seconds, fn) {
  const now = Date.now();
  if (lastRun[name] && now - lastRun[name] < seconds * 1000) return;
  lastRun[name] = now;
  try { await fn(); } catch (err) { console.error(`[worker:${name}]`, err.message); }
}

async function tick() {
  await every('outbox', 15, () => notifications.processDue(db, 25));
  await every('sla', 60, () => watch.slaWatch(db));
  await every('autoclose', 900, () => watch.autoClose(db));
  await every('contracts', 3600, async () => {
    const n = await contracts.runSchedule(db);
    if (n) console.log(`[worker] contracts: ${n} reminder(s) queued`);
  });
  await every('tenders', 3600, async () => {
    const n = await tenders.runSchedule(db);
    if (n) console.log(`[tenders] ${n} reminder(s) queued`);
  });
  await every('pipeline', 3600, async () => {
    const n = await pipeline.runSchedule(db);
    if (n) console.log(`[worker] pipeline: ${n} reminder(s) queued`);
  });
  await every('directory', 3600, async () => {
    const r = await directory.syncAll(db);
    if (r && r.deactivated) console.log(`[worker] directory: ${r.deactivated} of ${r.checked} directory user(s) disabled`);
  });
  await every('mail-health', 60, () => mailhealth.check(db));
  await every('mail-retry', 120, () => inbound.retryFailed());
  const boxes = (await q(`select * from mailboxes where enabled`)).rows;
  for (const mb of boxes) {
    await every(`mail:${mb.id}`, mb.poll_seconds, async () => {
      const n = await inbound.syncMailbox(mb);
      if (n) console.log(`[worker] ${mb.key}: processed ${n} message(s)`);
    });
  }
  await every('cleanup', 3600, async () => { await q('delete from session where expire < now()'); });
}

async function main() {
  const lock = await pool.connect();
  const got = (await lock.query('select pg_try_advisory_lock(727002) as ok')).rows[0].ok;
  if (!got) { console.error('[worker] another worker is already running'); process.exit(1); }
  console.log('[worker] started');
  while (!stopping) {
    try { await tick(); } catch (err) { console.error('[worker] tick failed:', err.message); }
    await new Promise((r) => setTimeout(r, 5000));
  }
  lock.release();
  await pool.end();
}

for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { console.log(`[worker] ${sig}`); stopping = true; setTimeout(() => process.exit(0), 8000).unref(); });
main().catch((err) => { console.error('[worker] fatal', err); process.exit(1); });
