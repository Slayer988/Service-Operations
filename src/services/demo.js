'use strict';
// Demo data: a believable set of customers, people, tickets, contracts, tenders, deals and projects so every screen has something to show.
// Everything it creates can be recognised and removed again before go-live:
//   * customers have a code starting "DEMO"; people have an e-mail address ending "@demo.invalid";
//   * contracts, tenders, deals, projects and weekly highlights carry "[DEMO]" at the start of their notes / description / text;
//   * tickets belong to demo customers, or come from a demo address.
// remove() deletes exactly those rows and nothing else. Nothing here sends e-mail (no notifications are queued).
const password = require('../lib/password');
const priorityLib = require('../lib/priority');
const settings = require('../lib/settings');
const tickets = require('./tickets');
const pipeline = require('./pipeline');
const operations = require('./operations');
const config = require('../config');

const TAG = '[DEMO]';
const DEMO_PASSWORD = 'Demo-Passw0rd-2026!';
const DEMO_DOMAIN = 'demo.invalid';
// earlier versions of the demo script used these; remove() cleans them up too
const OLD_EMAIL_LIKE = ['%@demo.local', '%@demo-bank.local'];

/** Small repeatable random numbers, so the demo data looks the same every time it is loaded. */
function prng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const ymd = (d) => d.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(d.getTime() + n * 86400000);
const addMin = (d, n) => new Date(d.getTime() + n * 60000);

const USER_LIKE = `(email like '%@${DEMO_DOMAIN}' or email like any($1))`;

async function ids(db, sql, params = []) { return (await db.query(sql, params)).rows.map((r) => r.id); }
const demoUserIds = (db) => ids(db, `select id from users where ${USER_LIKE}`, [OLD_EMAIL_LIKE]);
const demoCustomerIds = (db) => ids(db, `select id from customers where code like 'DEMO%'`);

/** What demo data is in the database now. */
async function status(db) {
  const n = async (sql, p = []) => (await db.query(sql, p)).rows[0].n;
  const cust = await demoCustomerIds(db); const usr = await demoUserIds(db);
  return {
    customers: cust.length, users: usr.length,
    tickets: await n(`select count(*)::int as n from tickets where customer_id = any($1) or requester_id = any($2) or requester_email like '%@${DEMO_DOMAIN}'`, [cust, usr]),
    contracts: await n(`select count(*)::int as n from contracts where notes like $1 or customer_id = any($2)`, [`${TAG}%`, cust]),
    tenders: await n('select count(*)::int as n from tenders where notes like $1', [`${TAG}%`]),
    deals: await n('select count(*)::int as n from opportunities where notes like $1', [`${TAG}%`]),
    projects: await n('select count(*)::int as n from projects where description like $1', [`${TAG}%`]),
    articles: await n('select count(*)::int as n from kb_articles where summary like $1', [`${TAG}%`]),
  };
}
const isEmpty = (s) => Object.values(s).every((v) => v === 0);

// ---------------------------------------------------------------- load
const STAFF = [
  ['manager', 'Amina Nakato', 'service_manager'], ['agent1', 'Brian Okello', 'agent'], ['agent2', 'Carol Atim', 'agent'],
  ['engineer1', 'David Mugisha', 'engineer'], ['engineer2', 'Esther Namutebi', 'engineer'], ['soc', 'Felix Kato', 'security_analyst'],
  ['contracts', 'Grace Akello', 'contract_manager'], ['bd', 'Henry Ssemwogerere', 'bd_manager'], ['bids', 'Irene Nabirye', 'bid_manager'],
  ['sde', 'James Opio', 'sde'], ['finance', 'Kevin Lutaaya', 'finance'], ['executive', 'Lydia Namara', 'management'], ['depthead', 'Moses Byaruhanga', 'dept_head'],
];

const CUSTOMERS = [
  { code: 'DEMO-KCB', name: 'Kampala Commercial Bank (Demo)', industry: 'Banking', policy: 'Platinum 24x7', sites: [['Head office', 'Plot 12, Kampala Road'], ['Entebbe branch', 'Airport Road, Entebbe']],
    users: [['kcb.admin', 'Patrick Tumusiime', 'customer_admin'], ['kcb.user', 'Rose Nansubuga', 'customer_user']],
    services: [['Core banking servers', 'Server support'], ['Branch network', 'Network support'], ['Security monitoring', 'Cybersecurity']] },
  { code: 'DEMO-LVH', name: 'Lakeview Hospital (Demo)', industry: 'Healthcare', policy: 'Gold 12x5', sites: [['Main hospital', 'Jinja Road, Kampala'], ['Outpatient clinic', 'Bugolobi']],
    users: [['lvh.admin', 'Dr. Sarah Achieng', 'customer_admin'], ['lvh.user', 'Timothy Wanyama', 'customer_user']],
    services: [['Hospital network', 'Network support'], ['Clinical systems servers', 'Server support'], ['Staff e-mail', 'Email']] },
  { code: 'DEMO-NLL', name: 'Nile Logistics Ltd (Demo)', industry: 'Logistics', policy: 'Standard 8x5', sites: [['Depot and offices', 'Industrial Area, Kampala']],
    users: [['nll.admin', 'Joseph Mwesigwa', 'customer_admin'], ['nll.user', 'Betty Namukasa', 'customer_user']],
    services: [['Office IT support', 'Hardware / New Device'], ['Ad-hoc support (no SLA)', 'Access and Accounts']] },
];

const INCIDENTS = [
  ['Email not syncing on mobile phones', 'Email'], ['VPN keeps disconnecting every few minutes', 'Network'], ['Core application is very slow since this morning', 'Server support'],
  ['Branch network link is down', 'Network'], ['Printer offline on the second floor', 'Printer'], ['Server disk space is critical', 'Server support'],
  ['Users cannot log in to the portal', 'Access and Accounts'], ['Wi-Fi unavailable in the east wing', 'Network'], ['Overnight backup job failed', 'Server support'],
  ['Laptop will not start after update', 'Hardware / New Device'], ['Payment gateway blocked by firewall', 'Network'], ['Phishing e-mail reported by several staff', 'Cybersecurity'],
  ['Antivirus raised an alert on a workstation', 'Cybersecurity'], ['Shared drive is not accessible', 'Access and Accounts'],
];
const REQUESTS = [
  ['New laptop for a new member of staff', 'Hardware / New Device'], ['Create a user account and mailbox', 'Access and Accounts'], ['Install a software licence', 'Hardware / New Device'],
  ['Add a user to the finance share', 'Access and Accounts'], ['Move a desk network port', 'Network'], ['Reset password and unlock account', 'Access and Accounts'],
  ['Increase mailbox quota', 'Email'], ['Provide the monthly backup report', 'Server support'],
];
const AGENT_NOTES = ['Thank you, we are looking into this now.', 'We have identified the cause and are working on a fix.', 'The change is in place. Please check and tell us if it still happens.', 'Checked remotely; nothing wrong found on our side so far. Could you send a screenshot?'];
const CUSTOMER_NOTES = ['It started this morning and affects several people.', 'Thank you, it works now.', 'Still the same, please help.', 'Attached is what we see on the screen.'];

async function load(db, { now = new Date() } = {}) {
  const have = await status(db);
  if (!isEmpty(have)) throw new Error('Demo data is already loaded. Remove it first (node scripts/demo-data.js remove).');
  const rnd = prng(20260101);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const chance = (p) => rnd() < p;
  const st = await settings.getAll(db, ['priority_matrix', 'default_currency']);
  const cur = st.default_currency || 'UGX';
  const hash = await password.hash(DEMO_PASSWORD);
  const policies = Object.fromEntries((await db.query('select id, name from sla_policies')).rows.map((r) => [r.name, r.id]));
  const catalogue = Object.fromEntries((await db.query('select id, name from service_catalogue')).rows.map((r) => [r.name, r.id]));

  // ---- people
  const U = {};
  for (const [key, name, role] of STAFF) {
    U[key] = (await db.query(`insert into users (email, name, kind, role, password_hash, password_changed_at) values ($1,$2,'staff',$3,$4,now()) returning id`, [`${key}@${DEMO_DOMAIN}`, name, role, hash])).rows[0].id;
  }

  // ---- customers, their sites, CSID, services, contract, engineers, users
  const C = [];
  for (const [i, def] of CUSTOMERS.entries()) {
    const c = (await db.query(`insert into customers (name, code, industry, notes) values ($1,$2,$3,$4) returning id`, [def.name, def.code, def.industry, `${TAG} sample customer`])).rows[0].id;
    const sites = [];
    for (const [n, a] of def.sites) sites.push((await db.query('insert into sites (customer_id, name, address) values ($1,$2,$3) returning id', [c, n, a])).rows[0].id);
    const seq = (await db.query("select nextval('csid_seq') as n")).rows[0].n;
    const cs = (await db.query(`insert into csids (csid, customer_id, description) values ($1,$2,$3) returning id`, [`CS-${String(seq).padStart(6, '0')}`, c, `${TAG} managed services`])).rows[0].id;
    const policyId = policies[def.policy] || null;
    const monthsAgo = [8, 22, 5][i]; const endIn = [480, 38, 200][i];
    const kEnd = addDays(now, endIn);
    const contract = (await db.query(
      `insert into contracts (customer_id, csid_id, title, type, status, start_date, end_date, renewal_date, sla_policy_id, value, annual_value, currency, owner_id, department, notice_days, auto_renew, notes, description, created_by)
       values ($1,$2,$3,'Service agreement',$4,$5,$6,$7,$8,$9,$10,$11,$12,'Service Delivery',60,$13,$14,$15,$16) returning id`,
      [c, cs, `${def.name.replace(' (Demo)', '')} managed IT services`, endIn <= 90 ? 'expiring_soon' : 'active', ymd(addDays(now, -monthsAgo * 30)), ymd(kEnd), ymd(addDays(kEnd, -60)), policyId,
        [480e6, 360e6, 144e6][i], [240e6, 180e6, 72e6][i], cur, U.contracts, i === 2, `${TAG} sample contract`, 'Managed IT support, monitoring and maintenance.', U.contracts])).rows[0].id;
    await db.query(`insert into contract_sla_targets (contract_id, metric, label, target, unit, direction) values ($1,'availability','Service availability',$2,'%','min'), ($1,'resolution_time','Resolution of P1 incidents',$3,'hours','max')`, [contract, [99.9, 99.5, 99][i], [4, 8, 24][i]]);
    const svc = [];
    for (const [k, [name, type]] of def.services.entries()) {
      const noSla = def.code === 'DEMO-NLL' && k === 1;                         // one service with no SLA and no contract: its tickets count as non-SLA
      const s = (await db.query(
        `insert into services (csid_id, customer_id, service_type, name, description, site_id, sla_policy_id, catalogue_id, owner_id, start_date) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) returning id`,
        [cs, c, type, name, `${TAG} sample service`, sites[k % sites.length], noSla ? null : policyId, catalogue[type] || null, U.manager, ymd(addDays(now, -monthsAgo * 30))])).rows[0].id;
      if (!noSla) await db.query('insert into service_contracts (service_id, contract_id, customer_id) values ($1,$2,$3)', [s, contract, c]);
      await db.query(`insert into engineer_assignments (entity, service_id, engineer_id, backup_id, reason) values ('service',$1,$2,$3,$4)`, [s, k % 2 ? U.engineer2 : U.engineer1, k % 2 ? U.engineer1 : U.engineer2, `${TAG} demo data`]);
      svc.push({ id: s, noSla, contract: noSla ? null : contract, policy: noSla ? null : policyId, site: sites[k % sites.length] });
    }
    const cu = [];
    for (const [key, name, role] of def.users) {
      cu.push({ id: (await db.query(`insert into users (email, name, kind, role, customer_id, password_hash, password_changed_at) values ($1,$2,'customer',$3,$4,$5,now()) returning id`, [`${key}@${DEMO_DOMAIN}`, name, role, c, hash])).rows[0].id, name, email: `${key}@${DEMO_DOMAIN}` });
    }
    C.push({ id: c, cs, def, svc, users: cu });
  }
  // suppliers and a few more contracts
  const extra = [
    ['Dell Technologies (Demo)', 'Hardware support agreement', 'supplier', 'active', 70, 96e6, 'Dell Technologies (Demo)'],
    ['Cisco Partner Network (Demo)', 'Network equipment support', 'supplier', 'renewal_in_progress', 25, 72e6, 'Cisco Partner Network (Demo)'],
    ['Microsoft Licensing (Demo)', 'Software licence subscription', 'supplier', 'active', 160, 120e6, 'Microsoft Licensing (Demo)'],
  ];
  for (const [, title, kind, status_, endIn, val, supplier] of extra) {
    await db.query(
      `insert into contracts (counterparty_kind, supplier, title, type, status, start_date, end_date, renewal_date, value, annual_value, currency, owner_id, notice_days, notes, created_by)
       values ($1,$2,$3,'Supplier agreement',$4,$5,$6,$7,$8,$9,$10,$11,60,$12,$11)`,
      [kind, supplier, title, status_, ymd(addDays(now, endIn - 365)), ymd(addDays(now, endIn)), ymd(addDays(now, endIn - 60)), val, val, cur, U.contracts, `${TAG} sample contract`]);
  }
  await db.query(
    `insert into contracts (customer_id, csid_id, title, type, status, start_date, end_date, value, currency, owner_id, notes, created_by)
     values ($1,$2,'Previous maintenance contract','Maintenance contract','expired',$3,$4,$5,$6,$7,$8,$7)`,
    [C[2].id, C[2].cs, ymd(addDays(now, -400)), ymd(addDays(now, -35)), 48e6, cur, U.contracts, `${TAG} sample contract`]);

  // ---- tickets, spread over the last eight weeks, a few breached, a few non-SLA, two waiting for verification
  const matrix = st.priority_matrix;
  const policyCache = {};
  const policyOf = async (id) => (id ? (policyCache[id] ||= await tickets.loadPolicy(db, id)) : null);
  const total = 64;
  for (let i = 0; i < total; i++) {
    const cust = C[i % 7 === 0 ? 2 : i % 3 === 0 ? 1 : 0];
    const svc = pick(cust.svc);
    const isIncident = chance(0.68);
    const [subject, category0] = isIncident ? pick(INCIDENTS) : pick(REQUESTS);
    const category = category0;
    const security = category === 'Cybersecurity';
    const impact = chance(0.1) ? 1 : chance(0.5) ? 2 : 3; const urgency = chance(0.15) ? 1 : chance(0.5) ? 2 : 3;
    const priority = priorityLib.compute(matrix, impact, urgency);
    const ageDays = Math.floor(Math.pow(rnd(), 1.15) * 56);
    let created = addMin(addDays(now, -ageDays), -Math.floor(rnd() * 300));
    created = new Date(Math.min(created.getTime(), now.getTime() - 40 * 60000));
    const type = isIncident ? 'incident' : 'request';
    const policy = await policyOf(svc.policy);
    const dues = tickets.computeDues(policy, priority, type, created);
    const roll = rnd();
    let status_;
    if (ageDays > 10) status_ = roll < 0.8 ? 'closed' : roll < 0.86 ? 'resolved' : roll < 0.95 ? 'in_progress' : 'open';
    else if (ageDays > 3) status_ = roll < 0.35 ? 'closed' : roll < 0.5 ? 'resolved' : roll < 0.8 ? 'in_progress' : 'open';
    else status_ = roll < 0.08 ? 'closed' : roll < 0.2 ? 'resolved' : roll < 0.58 ? 'in_progress' : roll < 0.85 ? 'open' : 'new';
    const requester = pick(cust.users);
    const worker = chance(0.5) ? U.engineer1 : U.engineer2; const assignee = status_ === 'new' ? null : (security ? U.soc : chance(0.35) ? pick([U.agent1, U.agent2]) : worker);
    const spanTo = (due, fracOk, fracBreach, breach) => {
      if (!due) return addMin(created, Math.round(60 + rnd() * 600));
      return new Date(created.getTime() + (due.getTime() - created.getTime()) * (breach ? fracBreach : fracOk));
    };
    const breach = chance(0.14);
    let respondedAt = null; let resolvedAt = null; let closedAt = null; let restoredAt = null;
    if (status_ !== 'new') respondedAt = spanTo(dues.response_due, 0.1 + rnd() * 0.7, 1.3 + rnd() * 0.8, breach && chance(0.4));
    if (['resolved', 'closed'].includes(status_)) {
      resolvedAt = spanTo(dues.resolution_due, 0.15 + rnd() * 0.75, 1.1 + rnd() * 0.9, breach);
      if (respondedAt && resolvedAt <= respondedAt) resolvedAt = addMin(respondedAt, 45);
      if (resolvedAt.getTime() > now.getTime() - 10 * 60000) resolvedAt = new Date(now.getTime() - 10 * 60000);
      if (resolvedAt <= created) resolvedAt = addMin(created, 30);
      if (type === 'incident') restoredAt = addMin(created, Math.max(15, Math.round((resolvedAt - created) / 60000 * 0.7)));
    }
    if (status_ === 'closed') { closedAt = new Date(Math.min(now.getTime() - 5 * 60000, resolvedAt.getTime() + (1 + Math.floor(rnd() * 3)) * 86400000)); }
    const rated = status_ === 'closed' && chance(0.6) ? pick([5, 5, 5, 4, 4, 3, 2]) : null;
    const nonChargeable = svc.noSla && chance(0.6);
    const seq = (await db.query("select nextval('ticket_seq') as n")).rows[0].n;
    const ref = `${type === 'request' ? 'REQ' : 'INC'}-${String(seq).padStart(6, '0')}`;
    const t = (await db.query(
      `insert into tickets (ref, type, queue, tier, customer_id, csid_id, service_id, contract_id, site_id, requester_id, requester_email, requester_name, subject, description, category, impact, urgency, priority,
          status, assignee_id, exec_engineer_id, source, sla_policy_id, response_due, restoration_due, resolution_due, responded_at, restored_at, resolved_at, closed_at, resolution_code, resolution_note, satisfaction, satisfaction_comment,
          created_at, updated_at, non_chargeable)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34,$35,$36,$37) returning id`,
      [ref, type, security ? 'security' : 'it_services', 'l1', cust.id, cust.cs, svc.id, svc.contract, svc.site, requester.id, requester.email, requester.name, subject, `${subject}. ${pick(CUSTOMER_NOTES)} (${TAG} sample ticket)`, category, impact, urgency, priority,
        status_, assignee, security ? U.soc : (await db.query('select engineer_id from engineer_assignments where service_id = $1 limit 1', [svc.id])).rows[0].engineer_id,
        chance(0.25) ? 'email' : 'portal', svc.policy, dues.response_due, dues.restoration_due, dues.resolution_due, respondedAt, restoredAt, resolvedAt, closedAt,
        resolvedAt ? 'fixed' : '', resolvedAt ? 'Resolved and confirmed working.' : '', rated, rated ? pick(['Quick and helpful.', 'Thank you.', 'Solved, but it took a while.', '']) : '',
        created, closedAt || resolvedAt || respondedAt || created, nonChargeable])).rows[0].id;
    const ev = (at, kind, text, actor, internal = false) => db.query('insert into ticket_events (ticket_id, actor_id, kind, text, internal, created_at) values ($1,$2,$3,$4,$5,$6)', [t, actor, kind, text, internal, at]);
    await ev(created, 'created', `Ticket created via portal. Priority ${priorityLib.LABELS[priority]}.`, null);
    if (assignee) await ev(addMin(created, 5), 'assign', 'Assigned to a member of the team.', U.agent1);
    if (respondedAt) await ev(respondedAt, 'status', 'Status changed from New to In progress.', assignee);
    if (resolvedAt) await ev(resolvedAt, 'status', 'Status changed from In progress to Resolved.', assignee);
    if (closedAt) await ev(closedAt, 'status', 'Status changed from Resolved to Closed.', requester.id);
    const cm = (at, author, body, source, internal = false) => db.query('insert into ticket_comments (ticket_id, author_id, body, internal, source, created_at) values ($1,$2,$3,$4,$5,$6)', [t, author, body, internal, source, at]);
    if (respondedAt) await cm(respondedAt, assignee || U.agent1, pick(AGENT_NOTES), 'agent');
    if (respondedAt && chance(0.5)) await cm(addMin(respondedAt, 30), assignee || U.agent1, 'Checked the configuration and the logs. No change made yet.', 'agent', true);
    if (resolvedAt && chance(0.6)) await cm(addMin(resolvedAt, -5), requester.id, pick(CUSTOMER_NOTES), 'portal');
  }
  // two e-mails from senders nobody knows yet: they wait on the Verification page
  for (const [i, [name, mail, subject]] of [['Unknown Sender', `enquiries.supplier@${DEMO_DOMAIN}`, 'Server room temperature alarm'], ['New Contact', `it.newclient@${DEMO_DOMAIN}`, 'Request for support quotation']].entries()) {
    const seq = (await db.query("select nextval('ticket_seq') as n")).rows[0].n;
    const created = addMin(now, -(90 + i * 200));
    const t = (await db.query(
      `insert into tickets (ref, type, queue, tier, requester_email, requester_name, subject, description, category, impact, urgency, priority, status, source, needs_verification, created_at, updated_at)
       values ($1,'incident','it_services','l1',$2,$3,$4,$5,'',2,2,3,'new','email',true,$6,$6) returning id`,
      [`INC-${String(seq).padStart(6, '0')}`, mail, name, subject, `${subject}. (${TAG} sample e-mail from an unknown sender)`, created])).rows[0].id;
    await db.query(`insert into ticket_events (ticket_id, kind, text, internal, created_at) values ($1,'created','Ticket created via email. Priority P3 Medium.',false,$2), ($1,'verification','Sender could not be matched to a registered customer. Waiting for verification.',true,$2)`, [t, created]);
  }

  // ---- pipeline
  const P = pipeline.DEFAULT_PROB;
  const deals = [
    ['Core banking data centre refresh', C[0].id, '', 'solution_development', 1.8e9, 46, 'Hardware refresh and migration', 14],
    ['Branch Wi-Fi and SD-WAN rollout', C[0].id, '', 'proposal_submission', 640e6, 30, 'Submit the proposal', 6],
    ['Hospital CCTV and access control', C[1].id, '', 'qualification', 420e6, 75, 'Site assessment', 12],
    ['Managed backup for clinics', C[1].id, '', 'negotiation', 210e6, 21, 'Agree the commercial terms', 4],
    ['Warehouse network upgrade', C[2].id, '', 'prospecting', 160e6, 90, 'Intro meeting', 9],
    ['Fleet tracking integration', null, 'Savannah Transport Ltd', 'lead_identification', 300e6, 120, 'Qualify the lead', 20],
    ['Cloud migration for a microfinance group', null, 'Pearl Microfinance', 'closing', 520e6, 18, 'Final signature', 2],
    ['Cybersecurity assessment', C[0].id, '', 'won', 85e6, -9, 'Handover to delivery', -9],
    ['Office relocation IT services', C[2].id, '', 'won', 70e6, -3, 'Handover to delivery', -3],
    ['Telemedicine platform', null, 'Mulago Health Partners', 'lost', 380e6, -15, 'Lost to a competitor on price', -15],
  ];
  const oppIds = [];
  for (const [i, [name, cust, prospect, stage, value, closeIn, next, nextIn]] of deals.entries()) {
    const closed = ['won', 'lost'].includes(stage);
    const createdAt = addDays(now, -(20 + i * 5));
    const esc = i === 1;
    const o = (await db.query(
      `insert into opportunities (name, customer_id, prospect, source, stage, value, currency, probability, expected_close, owner_id, next_step, next_step_date, lost_reason, closed_at, notes, created_by, created_at, updated_at,
          classification, escalated, escalation_note, escalated_at)
       values ($1,$2,$3,'Referral',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$9,$15,$15,$16,$17,$18,$19) returning id`,
      [name, cust, prospect, stage, value, cur, stage === 'won' ? 100 : stage === 'lost' ? 0 : P[stage], ymd(addDays(now, closeIn)), U.bd, next, closed ? null : ymd(addDays(now, nextIn)),
        stage === 'lost' ? next : '', closed ? addDays(now, closeIn) : null, `${TAG} sample deal`, createdAt, ['Solution', 'Service', 'Product'][i % 3],
        esc, esc ? 'Needs a director to join the customer meeting and agree the discount.' : '', esc ? addDays(now, -2) : null])).rows[0].id;
    oppIds.push(o);
    await db.query('insert into opportunity_contacts (opportunity_id, name) values ($1,$2)', [o, `Contact at ${cust ? 'the customer' : prospect || 'the prospect'}`]);
    if (i % 2 === 0) await db.query(`insert into opportunity_activities (opportunity_id, kind, activity_date, description, created_by) values ($1,'meeting',$2,'Introductory meeting with the customer team.',$3)`, [o, ymd(addDays(createdAt, 3)), U.bd]);
  }
  await db.query('insert into opportunity_engineers (opportunity_id, user_id, assigned_by) values ($1,$2,$3), ($4,$2,$3)', [oppIds[0], U.sde, U.bd, oppIds[1]]);

  // ---- tenders
  const T = [
    ['Supply and support of network equipment', 'Uganda Revenue Authority (sample)', 'identified', 21, 450e6], ['Managed IT services for district offices', 'Ministry of Local Government (sample)', 'qualification', 28, 900e6],
    ['Data centre cooling and power maintenance', 'National Social Security Fund (sample)', 'bid_preparation', 9, 380e6], ['End-user computing refresh', 'Kampala Capital City Authority (sample)', 'bid_preparation', 16, 520e6],
    ['Security operations centre services', 'Bank of Uganda (sample)', 'submitted', -6, 1.2e9], ['Hospital information system support', 'Ministry of Health (sample)', 'under_evaluation', -20, 700e6],
    ['Office network cabling', 'Makerere University (sample)', 'awarded', -40, 150e6], ['Annual IT maintenance contract', 'UNBS (sample)', 'unsuccessful', -45, 240e6],
  ];
  for (const [i, [title, issuer, status_, dueIn, est]] of T.entries()) {
    const submitted = ['submitted', 'under_evaluation', 'awarded', 'unsuccessful'].includes(status_);
    const t = (await db.query(
      `insert into tenders (title, issuer, status, submission_due, est_value, currency, owner_id, type, source, category, notes, created_by, submitted_at, awarded_on, award_value, awarded_to, outcome_note, closed_at, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,'RFP','Public portal','Services',$8,$7,$9,$10,$11,$12,$13,$14,$15,$15) returning id`,
      [title, issuer, status_, addDays(now, dueIn), est, cur, U.bids, `${TAG} sample tender`, submitted ? addDays(now, dueIn - 1) : null,
        status_ === 'awarded' ? ymd(addDays(now, dueIn + 20)) : null, status_ === 'awarded' ? est * 0.9 : null, status_ === 'awarded' ? 'Our company' : status_ === 'unsuccessful' ? 'A competitor' : '',
        status_ === 'unsuccessful' ? 'Our price was higher than the winning bid.' : '', ['awarded', 'unsuccessful'].includes(status_) ? addDays(now, dueIn + 25) : null, addDays(now, dueIn - 30 - i)])).rows[0].id;
    await db.query('insert into tender_members (tender_id, user_id, role) values ($1,$2,$3), ($1,$4,$5) on conflict do nothing', [t, U.bids, 'Bid manager', U.sde, 'Technical lead']);
    if (status_ === 'bid_preparation') {
      for (const [n, section, due, done] of [['Collect company registration and tax documents', 'statutory', 3, true], ['Write the technical proposal', 'technical', 6, false], ['Prepare the price schedule', 'financial', 7, false], ['Obtain the bid security', 'administrative', 5, false]]) {
        await db.query('insert into tender_tasks (tender_id, title, section, due_at, done_at, assignee_id) values ($1,$2,$3,$4,$5,$6)', [t, n, section, addDays(now, due), done ? addDays(now, -1) : null, U.bids]);
      }
    }
  }

  // ---- projects
  const J = [
    ['Core banking servers migration', C[0].id, 'active', 'amber', -60, 45, 380e6, 'Vendor delivery of the new servers is two weeks late.', false, ''],
    ['Hospital network upgrade', C[1].id, 'active', 'green', -30, 75, 260e6, 'Cabling finished in the main building.', false, ''],
    ['Branch Wi-Fi pilot', C[0].id, 'planning', 'green', 10, 90, 120e6, 'Site surveys are booked.', false, ''],
    ['Warehouse cabling and office move', C[2].id, 'active', 'red', -75, -5, 95e6, 'Over time and over budget; the customer changed the scope twice.', true, 'Needs a decision from leadership on the extra budget request.'],
    ['Cybersecurity assessment handover', C[0].id, 'completed', 'green', -90, -12, 85e6, 'Report delivered and accepted.', false, ''],
  ];
  for (const [name, cust, status_, health, startIn, endIn, budget, note, esc, escNote] of J) {
    const p = (await db.query(
      `insert into projects (name, customer_id, manager_id, status, health, start_date, end_date, budget, currency, description, status_note, escalated, escalation_note, closed_at, created_by, created_at, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$3,$15,$15) returning id`,
      [name, cust, U.manager, status_, health, ymd(addDays(now, startIn)), ymd(addDays(now, endIn)), budget, cur, `${TAG} sample project`, note, esc, escNote, status_ === 'completed' ? addDays(now, endIn) : null, addDays(now, Math.min(startIn, 0) - 3)])).rows[0].id;
    for (const [uid, role] of [[U.manager, 'Project manager'], [U.engineer1, 'Lead engineer'], [U.sde, 'Solution engineer']]) await db.query('insert into project_members (project_id, user_id, role) values ($1,$2,$3) on conflict do nothing', [p, uid, role]);
    const tasks = status_ === 'completed'
      ? [['Assessment complete', 'milestone', 'done', -40], ['Report delivered', 'milestone', 'done', -14]]
      : [['Kick-off with the customer', 'milestone', status_ === 'planning' ? 'open' : 'done', startIn + 3], ['Site survey', 'task', status_ === 'planning' ? 'in_progress' : 'done', startIn + 10], ['Install and configure equipment', 'task', 'in_progress', Math.max(endIn - 20, 5)],
        ['Testing and sign-off', 'milestone', 'open', endIn - 5], ['Handover and training', 'task', 'open', endIn]];
    for (const [title, kind, tst, dueIn] of tasks) {
      await db.query('insert into project_tasks (project_id, kind, title, assignee_id, due_date, status, done_at, created_by) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [p, kind, title, kind === 'milestone' ? U.manager : U.engineer1, ymd(addDays(now, dueIn)), tst, tst === 'done' ? addDays(now, Math.min(dueIn, -1)) : null, U.manager]);
    }
    await db.query(`insert into project_events (project_id, actor_id, kind, text) values ($1,$2,'created',$3)`, [p, U.manager, 'Sample project created.']);
  }

  // ---- this week's and last week's highlights on the Operations Overview
  const monday = operations.weekStart(operations.todayIn(config.timezone));
  const lastMonday = operations.addDays(monday, -7);
  await db.query(`insert into weekly_highlights (week_start, top_presales, major_delivery, updated_by) values ($1,$2,$3,$4) on conflict (week_start) do nothing`, [monday, `${TAG} Two deals moved to negotiation and closing; the tender for the security operations centre is under evaluation.`, `${TAG} Hospital cabling is finished; the warehouse project needs a decision on extra budget.`, U.manager]);
  await db.query(`insert into weekly_highlights (week_start, top_presales, major_delivery, updated_by) values ($1,$2,$3,$4) on conflict (week_start) do nothing`, [lastMonday, `${TAG} Cybersecurity assessment won; office relocation services won.`, `${TAG} Core banking migration kicked off.`, U.manager]);
  await loadArticles(db, U, await demoCustomerIds(db));
  return status(db);
}

/** Knowledge Base articles: some for staff only, some for customers, one still a draft; a few are linked to demo tickets. */
const ARTICLES = [
  ['Reset your VPN password', 'Network and VPN', 'customers', 'published', 'vpn password remote', 'Forgot your VPN password or it has expired? Reset it yourself.',
    '## Before you start\n\nYou need your **mobile phone** nearby: a code is sent to it.\n\n1. Open the self-service reset page from the link in your welcome e-mail.\n2. Choose *VPN* and press `Send code`.\n3. Type the code and choose a new password of at least 12 characters.\n4. Disconnect and connect the VPN again with the new password.\n\n> If the code does not arrive within two minutes, check that your phone has signal and try once more before you ask for help.'],
  ['Printer shows offline', 'Devices and printing', 'customers', 'published', 'printer offline', 'What to try when a printer you could use yesterday shows as offline.',
    '## Quick checks\n\n1. Make sure the printer is on and shows no error on its screen.\n2. Check the network cable or the Wi-Fi symbol on the printer.\n3. On your computer, open the printer list, right-click the printer and choose **Set as default**, then print a test page.\n\nIf the page does not print, **submit a request** with the printer name and the label on its side.'],
  ['Set up your work e-mail on a phone', 'E-mail and calendar', 'customers', 'published', 'email phone mobile', 'Add your work mailbox to an iPhone or Android phone.',
    '## Steps\n\n1. Open **Settings**, then **Mail** (iPhone) or **Accounts** (Android).\n2. Add an account and choose *Exchange* or *Microsoft 365*.\n3. Enter your work e-mail address and password.\n4. Accept the security prompt: your phone will ask for a screen lock.\n\n- You must use a passcode of at least six digits.\n- Do not use your personal e-mail app for work mail.'],
  ['Restart the print spooler on a print server', 'Devices and printing', 'internal', 'published', 'printer spooler windows', 'For engineers: clear a stuck print queue.',
    '## When to use it\n\nSeveral users report that jobs sit in the queue and nothing prints.\n\n```\nnet stop spooler\ndel /Q /F /S %systemroot%\\System32\\spool\\PRINTERS\\*.*\nnet start spooler\n```\n\nTell the customer before you clear the queue: waiting jobs are lost.'],
  ['Unlock an Active Directory account', 'Accounts and passwords', 'internal', 'published', 'ad account locked', 'Verify the person, unlock the account, explain why it locked.',
    '## Steps\n\n1. Confirm who is calling: ask for the employee number and the name of their manager.\n2. In *Active Directory Users and Computers* find the account and untick **Account is locked out**.\n3. Ask whether they changed their password recently: an old password saved on a phone is the usual cause.\n\n> Never reset a password for a caller you could not verify. Raise a security ticket instead.'],
  ['Handling a suspected phishing e-mail', 'Security', 'internal', 'published', 'phishing security email', 'First response steps for the service desk.',
    '## First response\n\n1. Ask the person **not** to click anything and to forward the message as an attachment.\n2. Raise a ticket in the **Security** queue.\n3. Search the mail system for the same sender or subject and list who else received it.'],
  ['New starter checklist', 'Procedures', 'internal', 'draft', 'onboarding starter', 'Draft: what to prepare for a new employee.',
    '- Create the account and mailbox\n- Order a laptop\n- Add to the department group\n- Book a 30 minute induction'],
];

async function loadArticles(db, U, custIds) {
  const cats = Object.fromEntries((await db.query('select id, name from kb_categories')).rows.map((r) => [r.name, r.id]));
  const made = [];
  for (const [title, cat, audience, st, tags, summary, body] of ARTICLES) {
    const a = (await db.query(
      `insert into kb_articles (title, summary, body, category_id, tags, audience, status, author_id, updated_by, published_at, review_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9, $10) returning id`,
      [title, `${TAG} ${summary}`, body, cats[cat] || null, tags, audience, st, U.manager, st === 'published' ? new Date() : null, st === 'published' ? ymd(addDays(new Date(), 330)) : null])).rows[0].id;
    await db.query(`insert into kb_article_versions (article_id, version, title, summary, body, edited_by, note) values ($1,1,$2,$3,$4,$5,'First version')`, [a, title, `${TAG} ${summary}`, body, U.manager]);
    made.push(a);
  }
  const t = (await db.query('select id from tickets where customer_id = any($1) order by id limit 6', [custIds])).rows;
  for (const [i, row] of t.entries()) await db.query('insert into kb_ticket_links (article_id, ticket_id, linked_by) values ($1,$2,$3) on conflict do nothing', [made[i % 3], row.id, U.manager]);
}

// ---------------------------------------------------------------- remove
/** Delete every row that load() created (and earlier demo data), and nothing else. Returns what was there. */
async function remove(db) {
  const before = await status(db);
  const cust = await demoCustomerIds(db); const usr = await demoUserIds(db);
  const run = (sql, p = []) => db.query(sql, p);
  const like = `${TAG}%`;
  const tix = await ids(db, `select id from tickets where customer_id = any($1) or requester_id = any($2) or requester_email like '%@${DEMO_DOMAIN}'`, [cust, usr]);
  const opps = await ids(db, `select id from opportunities where notes like $1`, [like]);
  const tends = await ids(db, `select id from tenders where notes like $1`, [like]);
  const projs = await ids(db, `select id from projects where description like $1`, [like]);
  const cons = await ids(db, `select id from contracts where notes like $1 or customer_id = any($2)`, [like, cust]);

  await run('delete from notifications where ticket_id = any($1) or opportunity_id = any($2) or tender_id = any($3) or contract_id = any($4) or recipient_user_id = any($5) or recipient_email like $6', [tix, opps, tends, cons, usr, `%@${DEMO_DOMAIN}`]);
  await run('delete from attachments where ticket_id = any($1) or opportunity_id = any($2) or tender_id = any($3) or contract_id = any($4) or customer_id = any($5)', [tix, opps, tends, cons, cust]);
  await run('delete from inbound_messages where ticket_id = any($1)', [tix]);
  await run('delete from ticket_comments where ticket_id = any($1)', [tix]);
  await run('delete from ticket_events where ticket_id = any($1)', [tix]);
  await run('delete from tickets where id = any($1)', [tix]);

  await run('delete from kb_articles where summary like $1', [like]);                         // versions, votes and ticket links go with it
  await run('delete from projects where id = any($1)', [projs]);                              // tasks, members and events go with the project
  await run('delete from tenders where id = any($1)', [tends]);                               // children go with the tender
  await run('update contracts set opportunity_id = null where opportunity_id = any($1)', [opps]);
  await run('update projects set opportunity_id = null where opportunity_id = any($1)', [opps]);
  await run('delete from opportunities where id = any($1)', [opps]);

  await run('delete from renewals where customer_id = any($1) or contract_id = any($2)', [cust, cons]);
  await run('delete from contracts where id = any($1)', [cons]);                              // its SLA targets, links and history go with it
  await run('delete from engineer_assignments where service_id in (select id from services where customer_id = any($1)) or reason like $2', [cust, `${TAG}%`]);
  await run('delete from services where customer_id = any($1)', [cust]);
  await run('delete from sites where customer_id = any($1)', [cust]);
  await run('delete from csids where customer_id = any($1)', [cust]);
  await run('delete from session where sess::jsonb ->> \'uid\' = any($1)', [usr.map(String)]);
  await run('delete from weekly_highlights where top_presales like $1 or major_delivery like $1', [like]);
  await run('delete from users where id = any($1)', [usr]);
  await run('delete from customers where id = any($1)', [cust]);
  return before;
}

module.exports = { load, remove, status, isEmpty, TAG, DEMO_PASSWORD, DEMO_DOMAIN, STAFF, CUSTOMERS };
