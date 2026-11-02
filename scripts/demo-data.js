'use strict';
// Demo data for trying every screen, and a clean way to remove it before go-live.
//   node scripts/demo-data.js load      create the sample customers, people, tickets, contracts, tenders, deals and projects
//   node scripts/demo-data.js status    show what demo data is in the database
//   node scripts/demo-data.js remove    delete all of it (only the demo rows; your own data is not touched)
// On the server:  cd /opt/itsm/app && sudo -u itsm env $(cat /etc/itsm/itsm.env | xargs) node scripts/demo-data.js load
const { pool, tx } = require('../src/db');
const demo = require('../src/services/demo');

const show = (s) => `${s.customers} customers, ${s.users} people, ${s.tickets} tickets, ${s.contracts} contracts, ${s.tenders} tenders, ${s.deals} deals, ${s.projects} projects, ${s.articles} help articles`;

(async () => {
  const cmd = (process.argv[2] || 'status').toLowerCase();
  if (cmd === 'load') {
    const s = await tx((db) => demo.load(db));
    console.log(`Demo data loaded: ${show(s)}.`);
    console.log(`Every demo person signs in with the password: ${demo.DEMO_PASSWORD}`);
    console.log(`Staff (all @${demo.DEMO_DOMAIN}): ${demo.STAFF.map(([k, n, r]) => `${k} (${r})`).join(', ')}`);
    console.log(`Customers: ${demo.CUSTOMERS.flatMap((c) => c.users.map(([k, , r]) => `${k} (${r})`)).join(', ')}`);
    console.log('Remove it all before go-live with: node scripts/demo-data.js remove');
  } else if (cmd === 'remove') {
    const before = await tx((db) => demo.remove(db));
    const after = await tx((db) => demo.status(db));
    console.log(demo.isEmpty(before) ? 'There was no demo data.' : `Removed demo data: ${show(before)}.`);
    if (!demo.isEmpty(after)) { console.error(`Something is left: ${show(after)}`); process.exitCode = 1; }
  } else if (cmd === 'status') {
    const s = await tx((db) => demo.status(db));
    console.log(demo.isEmpty(s) ? 'No demo data is loaded.' : `Demo data is loaded: ${show(s)}.`);
  } else {
    console.error('Use: node scripts/demo-data.js load | status | remove'); process.exitCode = 1;
  }
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
