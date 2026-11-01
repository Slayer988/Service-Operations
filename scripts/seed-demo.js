'use strict';
// Optional demo data so you can try every screen. Safe to run once on a fresh database.
//   node scripts/seed-demo.js
const { pool, tx } = require('../src/db');
const password = require('../src/lib/password');

(async () => {
  const pw = await password.hash('Demo-Passw0rd-2026!');
  await tx(async (db) => {
    if ((await db.query(`select 1 from customers where code = 'DEMO'`)).rows.length) { console.log('Demo data already present.'); return; }
    const c = (await db.query(`insert into customers (name, code) values ('Demo Bank Ltd','DEMO') returning id`)).rows[0].id;
    await db.query(`insert into sites (customer_id, name, address) values ($1,'Head office','Hargeisa')`, [c]);
    const n = (await db.query("select nextval('csid_seq') as n")).rows[0].n;
    const cs = (await db.query(`insert into csids (csid, customer_id, description) values ($1,$2,'Managed services') returning id`, [`CS-${String(n).padStart(6, '0')}`, c])).rows[0].id;
    const pol = (await db.query(`select id from sla_policies where name = 'Gold 12x5'`)).rows[0].id;
    const ct = (await db.query(`insert into contracts (customer_id, reference, csid_id, start_date, sla_policy_id) values ($1,'DEMO-2026-01',$2,current_date,$3) returning id`, [c, cs, pol])).rows[0].id;
    const sv = (await db.query(`insert into services (csid_id, customer_id, service_type, name, contract_id) values ($1,$2,'Server support','Core banking servers',$3) returning id`, [cs, c, ct])).rows[0].id;
    await db.query(`insert into services (csid_id, customer_id, service_type, name, contract_id) values ($1,$2,'Network support','Branch network',$3)`, [cs, c, ct]);
    const mk = async (email, name, role) => (await db.query(`insert into users (email, name, kind, role, password_hash) values ($1,$2,'staff',$3,$4) returning id`, [email, name, role, pw])).rows[0].id;
    const eng = await mk('engineer@demo.local', 'Demo Engineer', 'engineer');
    const bak = await mk('backup@demo.local', 'Demo Backup Engineer', 'engineer');
    await mk('agent@demo.local', 'Demo Agent', 'agent');
    await mk('manager@demo.local', 'Demo Service Manager', 'service_manager');
    await mk('soc@demo.local', 'Demo SOC Analyst', 'security_analyst');
    await db.query(`insert into users (email, name, kind, role, customer_id, password_hash) values ('user@demo-bank.local','Demo Customer User','customer','customer_user',$1,$2), ('admin@demo-bank.local','Demo Customer Admin','customer','customer_admin',$1,$2)`, [c, pw]);
    await db.query(`insert into engineer_assignments (entity, service_id, engineer_id, backup_id, reason) values ('service',$1,$2,$3,'demo data')`, [sv, eng, bak]);
    console.log('Demo data created. Demo users all use the password: Demo-Passw0rd-2026!');
    console.log('Staff: agent@demo.local, engineer@demo.local, manager@demo.local, soc@demo.local. Customer: user@demo-bank.local, admin@demo-bank.local');
  });
  await pool.end();
})().catch((e) => { console.error(e.message); process.exit(1); });
