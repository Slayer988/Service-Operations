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
    quotes: await n('select count(*)::int as n from quotes where internal_notes like $1', [`${TAG}%`]),
    suppliers: await n('select count(*)::int as n from suppliers where notes like $1', [`${TAG}%`]),
    lpos: await n('select count(*)::int as n from purchase_orders where internal_notes like $1', [`${TAG}%`]),
  };
}
const isEmpty = (s) => Object.values(s).every((v) => v === 0);

// ---------------------------------------------------------------- load
const STAFF = [
  ['manager', 'Amina Nakato', 'service_manager'], ['agent1', 'Brian Okello', 'agent'], ['agent2', 'Carol Atim', 'agent'],
  ['engineer1', 'David Mugisha', 'engineer'], ['engineer2', 'Esther Namutebi', 'engineer'], ['soc', 'Felix Kato', 'security_analyst'],
  ['contracts', 'Grace Akello', 'contract_manager'], ['bd', 'Henry Ssemwogerere', 'bd_manager'], ['bids', 'Irene Nabirye', 'bid_manager'],
  ['sde', 'James Opio', 'sde'], ['finance', 'Kevin Lutaaya', 'finance'], ['executive', 'Lydia Namara', 'management'], ['depthead', 'Moses Byaruhanga', 'dept_head'],
  ['procurement', 'Nora Kirabo', 'procurement'],
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
  await loadQuotes(db, U, oppIds, cur, now);
  await loadProcurement(db, U, cur, now);
  await loadExtras(db, U, oppIds, cur, now);
  return status(db);
}

/** The rest of every module, so each screen and tab has something in it: contract obligations, payments, SLA performance, reviews and
 *  amendments; deal tasks, proposals, solution work and effort; tender reviews and evaluations; formatted ticket comments; article votes;
 *  e-mail domains for requests without signing in. Nothing here sends e-mail. */
async function loadExtras(db, U, oppIds, cur, now) {
  const q = (sql, p = []) => db.query(sql, p);
  const day = (n) => ymd(addDays(now, n));
  // ---- customers: e-mail domains, so "Raise a request with your work e-mail and your CSID" can be tried
  for (const [code, dom] of [['DEMO-KCB', 'kcb.demo.invalid'], ['DEMO-LVH', 'lakeview.demo.invalid'], ['DEMO-NLL', 'nilelogistics.demo.invalid']]) {
    await q('update customers set email_domains = $2 where code = $1', [code, [dom]]);
  }
  // ---- tickets: a few comments written with the formatting toolbar
  const open = (await q(`select t.id, t.assignee_id, t.requester_id from tickets t join customers c on c.id = t.customer_id where c.code like 'DEMO%' and t.status in ('open','in_progress') order by t.id limit 4`)).rows;
  const RICH = [
    '**Update:** we found the cause.\n\n- The link to the branch dropped at **09:40**\n- The provider has replaced a faulty module\n- We are watching it for one more hour\n\nWe will confirm before we close the ticket.',
    'Steps we took:\n\n1. Restarted the service\n2. Cleared the cache\n3. Tested with *two* users\n\n__Please try again__ and tell us if the problem is still there.',
    '~~Planned for tonight~~ moved to **Saturday 22:00** at your request. Expected downtime: 15 minutes.',
    '> Internal: the root cause is a full disk on the backup server.\n\nNext: **extend the volume** and move old backups to the archive.',
  ];
  for (const [i, t] of open.entries()) {
    await q(`insert into ticket_comments (ticket_id, author_id, body, internal, source, format, created_at) values ($1,$2,$3,$4,'agent','rich',$5)`,
      [t.id, t.assignee_id || U.agent1, RICH[i], i === 3, new Date(now.getTime() - (30 + i * 10) * 60000)]);
  }
  // ---- contracts: contacts, obligations, payments, measured SLA performance, approvals, an amendment and history
  const cons = (await q(`select c.id, c.title, c.customer_id, c.value, c.annual_value, c.status, c.counterparty_kind from contracts c where c.notes like $1 or c.customer_id in (select id from customers where code like 'DEMO%') order by c.id`, [`${TAG}%`])).rows;
  for (const [i, c] of cons.entries()) {
    await q('insert into contract_events (contract_id, actor_id, kind, text, created_at) values ($1,$2,$3,$4,$5)', [c.id, U.contracts, 'created', `Grace Akello created the contract. ${TAG}`, addDays(now, -120 + i)]);
    await q('insert into contract_contacts (contract_id, user_id) values ($1,$2), ($1,$3) on conflict do nothing', [c.id, U.contracts, U.manager]);
    if (!c.customer_id || c.status === 'expired') continue;
    const quarter = Math.round(Number(c.annual_value || c.value || 0) / 4);
    for (const [k, [due, st, paid]] of [[-80, 'paid', -75], [10, 'invoiced', null], [100, 'scheduled', null], [-170, 'paid', -160]].entries()) {
      await q('insert into contract_payments (contract_id, due_date, description, amount, status, paid_on) values ($1,$2,$3,$4,$5,$6)', [c.id, day(due), `Quarterly service fee (instalment ${k + 1})`, quarter, st, paid === null ? null : day(paid)]);
    }
    const obl = [['deliverable', 'Monthly service report', 'Availability, tickets and SLA results for the month.', 'open', 8], ['milestone', 'Quarterly service review meeting', 'Review the quarter with the customer.', 'done', -20],
      ['obligation', 'Disaster recovery test', 'Restore one critical system from backup and record the result.', i === 0 ? 'open' : 'in_progress', i === 0 ? -6 : 25]];
    for (const [kind, title, desc, st, due] of obl) {
      await q('insert into contract_obligations (contract_id, kind, title, description, responsible_id, due_date, status, completed_at) values ($1,$2,$3,$4,$5,$6,$7,$8)', [c.id, kind, title, desc, U.manager, day(due), st, st === 'done' ? addDays(now, due) : null]);
    }
    const targets = (await q('select id, metric, target from contract_sla_targets where contract_id = $1', [c.id])).rows;
    for (const t of targets) {
      for (let m = 3; m >= 1; m--) {
        const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m, 1)); const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - m + 1, 0));
        const tg = Number(t.target);
        const measured = t.metric === 'availability' ? Math.min(100, +(tg + (m === 2 && i === 0 ? -0.35 : 0.05 * m)).toFixed(3)) : +(tg * (m === 1 && i === 1 ? 1.25 : 0.6 + 0.1 * m)).toFixed(2);
        await q('insert into contract_performance (contract_id, sla_target_id, period_start, period_end, measured, note, recorded_by) values ($1,$2,$3,$4,$5,$6,$7)',
          [c.id, t.id, ymd(start), ymd(end), measured, `${TAG} from the monthly service report`, U.manager]);
      }
    }
  }
  const firstCustomerContract = cons.find((c) => c.customer_id && c.status !== 'expired');
  if (firstCustomerContract) {
    for (const [stage, who, decision, comment] of [['legal', U.contracts, 'approved', 'Liability cap and data protection clauses are acceptable.'], ['finance', U.finance, 'approved', 'Pricing and payment terms agreed.'], ['management', U.executive, 'changes_requested', 'Add a clause for the annual price review.']]) {
      await q('insert into contract_reviews (contract_id, stage, reviewer_id, decision, comment) values ($1,$2,$3,$4,$5)', [firstCustomerContract.id, stage, who, decision, comment]);
    }
    await q(`insert into contract_amendments (contract_id, kind, effective_date, description, old_value, new_value, created_by) values ($1,'variation',$2,'Two more branches added to the network support scope.',$3,$4,$5)`,
      [firstCustomerContract.id, day(-30), firstCustomerContract.value, Math.round(Number(firstCustomerContract.value) * 1.12), U.contracts]);
  }
  const cisco = cons.find((c) => /Cisco/.test(c.title) || c.status === 'renewal_in_progress');
  if (cisco) await q(`insert into contract_amendments (contract_id, kind, effective_date, description, created_by) values ($1,'extension',$2,'Extended by three months while the renewal is negotiated.',$3)`, [cisco.id, day(-10), U.contracts]);
  // ---- deals: engineering tasks with history, proposals, solution work and effort
  const deal = async (oi) => oppIds[oi];
  const o0 = await deal(0); const o1 = await deal(1); const o3 = await deal(3);
  await q('insert into opportunity_engineers (opportunity_id, user_id, assigned_by) values ($1,$2,$3) on conflict do nothing', [o0, U.engineer1, U.bd]);
  const TASKS = [[o0, 'Site survey of the data centre', U.sde, 'high', -12, -2, 'completed', 100], [o0, 'Size the new server and storage platform', U.sde, 'high', -5, 4, 'in_progress', 60],
    [o0, 'Migration runbook draft', U.engineer1, 'normal', 0, -1, 'in_progress', 30], [o1, 'Wireless heat-map for the branches', U.sde, 'urgent', -6, 3, 'pending', 0]];
  for (const [o, title, who, pr, startIn, dueIn, st, prog] of TASKS) {
    const t = (await q(`insert into opp_tasks (opportunity_id, title, description, assignee_id, priority, start_date, due_date, status, progress, work_notes, completed_at, created_by)
                        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id, ref`,
      [o, title, `${TAG} sample engineering task`, who, pr, day(startIn), day(dueIn), st, prog, st === 'pending' ? '' : 'Notes from the work so far are kept here.', st === 'completed' ? addDays(now, dueIn) : null, U.bd])).rows[0];
    await q('insert into opp_task_history (task_id, actor_id, text, created_at) values ($1,$2,$3,$4)', [t.id, U.bd, `Henry Ssemwogerere created the task and assigned it.`, addDays(now, startIn)]);
    if (st !== 'pending') await q('insert into opp_task_history (task_id, actor_id, text) values ($1,$2,$3)', [t.id, who, `Progress ${prog}%${st === 'completed' ? ', completed' : ''}.`]);
  }
  for (const [o, kind, ref, due, sub, st] of [[o0, 'technical_submission', 'TS-CBK-01', 12, null, 'preparing'], [o1, 'proposal', 'PR-WIFI-02', -4, -4, 'submitted'], [o3, 'quotation', 'QT-BKP-03', -10, -11, 'submitted']]) {
    await q('insert into opportunity_proposals (opportunity_id, kind, reference, due_date, submitted_on, status, prepared_by, notes) values ($1,$2,$3,$4,$5,$6,$7,$8)', [o, kind, ref, day(due), sub === null ? null : day(sub), st, U.sde, TAG]);
  }
  for (const [kind, title, st] of [['design', 'High-level design: two-site active/standby', 'completed'], ['sizing', 'Compute and storage sizing (5-year growth)', 'completed'], ['bom', 'Bill of materials with distributor pricing', 'in_progress']]) {
    await q('insert into opportunity_solution_items (opportunity_id, kind, title, description, status, author_id) values ($1,$2,$3,$4,$5,$6)', [o0, kind, title, `${TAG} sample solution work`, st, U.sde]);
  }
  for (const [who, name, skill, plan, act] of [[U.sde, 'James Opio', 'Solution architecture', 40, 22], [U.engineer1, 'David Mugisha', 'Data centre engineering', 16, 4]]) {
    await q('insert into opportunity_resources (opportunity_id, user_id, name, skill, planned_hours, actual_hours, notes) values ($1,$2,$3,$4,$5,$6,$7)', [o0, who, name, skill, plan, act, TAG]);
  }
  // ---- tenders: approvals before submission, evaluation steps after it, and history
  const tends = (await q(`select id, status, title from tenders where notes like $1 order by id`, [`${TAG}%`])).rows;
  for (const t of tends) await q('insert into tender_events (tender_id, actor_id, kind, text, at) values ($1,$2,$3,$4,$5)', [t.id, U.bids, 'created', `Irene Nabirye registered the tender. ${TAG}`, addDays(now, -40)]);
  const prep = tends.filter((t) => t.status === 'bid_preparation');
  if (prep[0]) for (const [stage, who, d, c] of [['technical', U.sde, 'approved', 'Technical proposal complete and compliant.'], ['commercial', U.finance, 'approved', 'Margin 18%, within policy.']]) await q('insert into tender_reviews (tender_id, stage, reviewer_id, decision, comment) values ($1,$2,$3,$4,$5)', [prep[0].id, stage, who, d, c]);
  if (prep[1]) await q(`insert into tender_reviews (tender_id, stage, reviewer_id, decision, comment) values ($1,'technical',$2,'changes_requested','Add the warranty terms for the laptops.')`, [prep[1].id, U.sde]);
  for (const t of tends.filter((x) => ['submitted', 'under_evaluation', 'awarded', 'unsuccessful'].includes(x.status))) {
    await q(`insert into tender_evaluations (tender_id, kind, title, event_date, due_date, responded_on, outcome, notes, created_by) values ($1,'clarification','Clarification on the support hours',$2,$3,$4,'Answered',$5,$6)`, [t.id, day(-12), day(-10), day(-11), TAG, U.bids]);
    if (t.status !== 'submitted') await q(`insert into tender_evaluations (tender_id, kind, title, event_date, score, outcome, notes, created_by) values ($1,'score','Technical evaluation',$2,$3,$4,$5,$6)`, [t.id, day(-8), t.status === 'unsuccessful' ? 64 : 82, t.status === 'unsuccessful' ? 'Below the winning score' : 'Passed to the financial stage', TAG, U.bids]);
  }
  // ---- Knowledge Base: readers' votes
  const arts = (await q(`select id from kb_articles where summary like $1 and status = 'published' order by id`, [`${TAG}%`])).rows;
  const voters = (await q(`select id from users where email like $1 order by id limit 6`, [`%@${DEMO_DOMAIN}`])).rows;
  for (const [i, a] of arts.entries()) for (const [j, v] of voters.entries()) if ((i + j) % 3 !== 0) await q('insert into kb_votes (article_id, user_id, helpful) values ($1,$2,$3) on conflict do nothing', [a.id, v.id, (i + j) % 5 !== 0]);
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

// Quotes on four of the deals: one sent, one revised after negotiation (R1 superseded, R2 sent with a discount), one accepted, one draft.
async function loadQuotes(db, U, oppIds, cur, now) {
  const Q = require('./quotes');
  const bd = { id: U.bd, name: 'Henry Ssemwogerere', email: `bd@${DEMO_DOMAIN}`, kind: 'staff', role: 'bd_manager' };
  const s = await Q.listSettings(db);
  const today = ymd(now);
  const make = async (oppIndex, lines, extra = {}) => {
    const d = await Q.defaults(db, oppIds[oppIndex], today);
    const h = { ...d, currency: cur, valid_until: ymd(addDays(now, 30)), tax_rate: s.taxRate, tax_label: s.taxLabel, internal_notes: `${TAG} sample quote`, intro: 'Thank you for the opportunity to quote. Our proposal is set out below.', customer_id: d.customer_id || null, opportunity_id: d.opportunity_id || null, ...extra };
    let q = await Q.create(db, h, bd, '');
    q = await Q.saveLines(db, q, lines.map(([description, quantity, unit, unit_price, discount_pct = 0]) => ({ description, quantity, unit, unit_price, discount_pct, line_total: Q.lineTotal(quantity, unit_price, discount_pct) })), bd);
    return q;
  };
  // 1: Branch Wi-Fi and SD-WAN rollout (proposal submission): sent
  let q1 = await make(1, [['SD-WAN edge appliance', 12, 'each', 18500000], ['Wi-Fi 6 access point', 40, 'each', 2400000], ['Installation and configuration', 12, 'site', 3500000], ['Managed SD-WAN service', 12, 'month', 9800000]]);
  q1 = await Q.setStatus(db, q1, 'sent', bd, { note: 'E-mailed to the IT manager.' });
  // 2: Managed backup for clinics (negotiation): R1 sent, then revised with a discount and sent again
  let q2 = await make(3, [['Backup appliance', 2, 'each', 32000000], ['Cloud backup storage (10 TB)', 12, 'month', 6500000], ['Onboarding and restore testing', 1, 'project', 12000000]]);
  q2 = await Q.setStatus(db, q2, 'sent', bd, { note: 'First offer.' });
  let q2b = await Q.revise(db, q2, bd, '');
  q2b = await Q.saveLines(db, q2b, [['Backup appliance', 2, 'each', 32000000, 5], ['Cloud backup storage (10 TB)', 12, 'month', 6500000, 10], ['Onboarding and restore testing', 1, 'project', 12000000]]
    .map(([description, quantity, unit, unit_price, discount_pct = 0]) => ({ description, quantity, unit, unit_price, discount_pct, line_total: Q.lineTotal(quantity, unit_price, discount_pct) })), bd);
  await Q.setStatus(db, q2b, 'sent', bd, { note: 'Revised after the commercial meeting: discount on hardware and storage.' });
  // 3: Cybersecurity assessment (won): accepted
  let q3 = await make(7, [['External penetration test', 1, 'engagement', 38000000], ['Internal vulnerability assessment', 1, 'engagement', 27000000], ['Report and executive debrief', 1, 'each', 6000000]]);
  q3 = await Q.setStatus(db, q3, 'sent', bd, {});
  await Q.setStatus(db, q3, 'accepted', bd, { note: 'Purchase order received.' });
  // 4: Fleet tracking integration (lead, a prospect): draft
  await make(5, [['GPS tracker with installation', 150, 'vehicle', 950000], ['Tracking platform licence', 150, 'vehicle / month', 45000]]);
}

// Three suppliers in the register, on demo projects and tenders, and two LPOs (one issued for a project, one draft against a contract).
async function loadProcurement(db, U, cur, now = new Date()) {
  const Sup = require('./suppliers'); const PO = require('./purchase_orders'); const Q = require('./quotes');
  const buyer = { id: U.procurement, name: 'Nora Kirabo', email: `procurement@${DEMO_DOMAIN}`, kind: 'staff', role: 'procurement' };
  const mk = (f) => Sup.create(db, { status: 'active', services: '', tin: '', registration_no: '', address: '', phone: '', email: '', website: '', contact_name: '', contact_phone: '', contact_email: '', payment_terms: '', ...f, notes: `${TAG} sample supplier` }, buyer, '');
  const cab = await mk({ name: 'Rwenzori Cabling Contractors (Demo)', kind: 'contractor', services: 'Structured cabling, fibre splicing, small civil works', tin: '1000456789', address: 'Plot 4, Ntinda Industrial Area, Kampala', phone: '+256 414 000 101', contact_name: 'Peter Ochieng', contact_phone: '+256 772 000 101', contact_email: `peter@cabling.${DEMO_DOMAIN}`, payment_terms: '50% on order, 50% on completion' });
  const dist = await mk({ name: 'Equator Networks Distribution (Demo)', kind: 'distributor', services: 'Cisco, Fortinet and HPE distribution', tin: '1000987654', address: 'Lugogo Bypass, Kampala', phone: '+256 414 000 202', contact_name: 'Martha Nambi', contact_email: `martha@equator.${DEMO_DOMAIN}`, payment_terms: '30 days after delivery' });
  await mk({ name: 'Kivu Security Consultants (Demo)', kind: 'consultant', services: 'Penetration testing support, ISO 27001 advisory', contact_name: 'Alex Mutebi', payment_terms: '30 days after invoice' });
  const projs = (await db.query(`select id from projects where description like $1 order by id limit 2`, [`${TAG}%`])).rows.map((r) => r.id);
  const tends = (await db.query(`select id from tenders where notes like $1 order by id limit 1`, [`${TAG}%`])).rows.map((r) => r.id);
  if (projs[0]) await Sup.link(db, cab, { type: 'project', id: projs[0] }, 'Cabling subcontractor', buyer);
  if (projs[0]) await Sup.link(db, dist, { type: 'project', id: projs[0] }, 'Equipment supplier', buyer);
  if (tends[0]) await Sup.link(db, dist, { type: 'tender', id: tends[0] }, 'Distributor (back-to-back pricing)', buyer);
  const s = await PO.listSettings(db);
  const today = new Date().toISOString().slice(0, 10);
  const lines = (rows) => rows.map(([description, quantity, unit, unit_price]) => ({ description, quantity, unit, unit_price, discount_pct: 0, line_total: Q.lineTotal(quantity, unit_price, 0) }));
  let po = await PO.create(db, { ...(await PO.defaults(db, { supplier: cab.id, project: projs[0] || '' }, today)), currency: cur, title: 'Cabling for the new floor', tax_rate: s.taxRate, tax_label: s.taxLabel,
    internal_notes: `${TAG} sample LPO`, supplier_doc_id: null, contract_id: null, tender_id: null, customer_quote_id: null }, buyer, '');
  po = await PO.saveLines(db, po, lines([['Cat6A cabling points, installed and tested', 48, 'point', 185000], ['Fibre backbone, 12 core, spliced', 1, 'run', 2600000]]), buyer);
  await PO.setStatus(db, po, 'issued', buyer, { note: 'Sent to Peter Ochieng.' });
  const con = (await db.query(`select id from contracts where notes like $1 order by id limit 1`, [`${TAG}%`])).rows[0];
  let po2 = await PO.create(db, { ...(await PO.defaults(db, { supplier: dist.id, contract: con ? con.id : '' }, today)), currency: cur, title: 'Firewall renewal licences', tax_rate: s.taxRate, tax_label: s.taxLabel,
    internal_notes: `${TAG} sample LPO`, supplier_doc_id: null, project_id: null, tender_id: null, customer_quote_id: null }, buyer, '');
  await PO.saveLines(db, po2, lines([['FortiGate 100F UTP bundle, 1 year', 2, 'licence', 6400000]]), buyer);
  // more orders, so the LPO tracker has every stage: late, received, closed and cancelled
  const kivu = (await db.query(`select id from suppliers where notes like $1 and kind = 'consultant' limit 1`, [like()])).rows[0];
  const more = [
    [dist.id, 'Core switches for the data centre', projs[0] || '', -4, [['Cisco Catalyst 9300 48-port switch', 4, 'each', 21500000]], ['issued'], 'Late: the distributor is waiting for stock.'],
    [dist.id, 'Wi-Fi access points for the hospital', projs[1] || '', -12, [['Wi-Fi 6 access point', 30, 'each', 1850000], ['PoE injector', 30, 'each', 120000]], ['issued', 'received'], 'Delivered complete; waiting for the invoice.'],
    [cab.id, 'Cabling for the clinic rooms', projs[1] || '', -40, [['Cat6 cabling points', 24, 'point', 165000]], ['issued', 'received', 'closed'], 'Invoiced and paid.'],
    [kivu ? kivu.id : cab.id, 'Penetration test support (2 days)', '', 7, [['Senior consultant day', 2, 'day', 2800000]], ['issued', 'cancelled'], 'The customer moved the test to next year.'],
  ];
  for (const [sid, title, proj, delivIn, rows, moves, note] of more) {
    let o = await PO.create(db, { ...(await PO.defaults(db, { supplier: sid, project: proj }, today)), currency: cur, title, tax_rate: s.taxRate, tax_label: s.taxLabel, delivery_date: ymd(addDays(now, delivIn)),
      internal_notes: `${TAG} sample LPO`, supplier_doc_id: null, contract_id: null, tender_id: null, customer_quote_id: null }, buyer, '');
    o = await PO.saveLines(db, o, lines(rows), buyer);
    for (const m of moves) o = await PO.setStatus(db, o, m, buyer, { note: m === moves[moves.length - 1] ? note : '' });
    await db.query('update purchase_orders set issue_date = least(issue_date, $2::date) where id = $1', [o.id, ymd(addDays(now, Math.min(delivIn - 14, -2)))]);
  }
  // their documents, as real files you can open: a quote, a tax clearance and a delivery note
  const storage = require('../lib/storage'); const pdf = require('../lib/pdf');
  const firstPo = (await db.query(`select id, ref from purchase_orders where supplier_id = $1 and internal_notes like $2 order by id limit 1`, [cab.id, like()])).rows[0];
  const docs = [
    [cab, 'quote', 'RCC-Q-0118', 9480000, 'Rwenzori Cabling quote RCC-Q-0118.pdf', projs[0] || null, null, 'Quotation RCC-Q-0118', [['Cat6A cabling points, installed and tested', '48 x 185,000'], ['Fibre backbone, 12 core', '1 x 2,600,000']]],
    [dist, 'tax_clearance', 'TCC-2026-5531', null, 'Equator tax clearance 2026.pdf', null, null, 'Tax clearance certificate (sample)', [['Valid until', '31 Dec 2026']]],
    [cab, 'delivery_note', 'DN-7781', null, 'Delivery note DN-7781.pdf', projs[0] || null, firstPo ? firstPo.id : null, 'Delivery note DN-7781', [['Cat6A cabling points', '48 installed'], ['Received by', 'Site engineer']]],
  ];
  for (const [sup, kind, ref, amount, filename, projectId, poId, title, kv] of docs) {
    const buf = pdf.document({ title, subtitle: 'Sample document from the demo data', appName: sup.name, blocks: [{ type: 'kv', rows: [['Reference', ref], ...kv] }, { type: 'p', text: 'This is a sample document created with the demo data. It can be removed with the rest of the demo data.' }] });
    const f = await storage.storeFile({ buffer: buf, filename, mime: 'application/pdf', maxBytes: 10 * 1048576, blockedExt: [] });
    if (f.rejected) continue;
    const a = (await db.query(`insert into attachments (supplier_id, purchase_order_id, filename, mime, size_bytes, sha256, storage_name, scan_status, uploaded_by, doc_kind, version) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1) returning id`,
      [sup.id, poId, f.filename, f.mime, f.size_bytes, f.sha256, f.storage_name, f.scan_status, U.procurement, `supplier_${kind}`])).rows[0];
    await db.query(`insert into supplier_documents (attachment_id, supplier_id, kind, reference, amount, currency, doc_date, valid_until, project_id, tender_id, purchase_order_id, notes) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,null,$10,$11)`,
      [a.id, sup.id, kind, ref, amount, amount === null ? '' : cur, ymd(addDays(now, -15)), kind === 'quote' ? ymd(addDays(now, 15)) : kind === 'tax_clearance' ? `${now.getUTCFullYear()}-12-31` : null, projectId, poId, TAG]);
  }
}
const like = () => `${TAG}%`;

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

  // stored files of every attachment about to go: removed from disk after the rows
  const files = (await db.query(`select storage_name from attachments where ticket_id = any($1) or opportunity_id = any($2) or tender_id = any($3) or contract_id = any($4) or customer_id = any($5)
                                    or supplier_id in (select id from suppliers where notes like $6)`, [tix, opps, tends, cons, cust, like])).rows.map((r) => r.storage_name);
  await run('delete from kb_votes where user_id = any($1)', [usr]);
  await run('delete from notifications where ticket_id = any($1) or opportunity_id = any($2) or tender_id = any($3) or contract_id = any($4) or recipient_user_id = any($5) or recipient_email like $6', [tix, opps, tends, cons, usr, `%@${DEMO_DOMAIN}`]);
  await run('delete from attachments where ticket_id = any($1) or opportunity_id = any($2) or tender_id = any($3) or contract_id = any($4) or customer_id = any($5)', [tix, opps, tends, cons, cust]);
  await run('delete from inbound_messages where ticket_id = any($1)', [tix]);
  await run('delete from ticket_comments where ticket_id = any($1)', [tix]);
  await run('delete from ticket_events where ticket_id = any($1)', [tix]);
  await run('delete from tickets where id = any($1)', [tix]);

  await run('delete from kb_articles where summary like $1', [like]);                         // versions, votes and ticket links go with it
  // purchase orders and suppliers: the sample ones, and any made on demo records or by demo people while trying the system
  const sups = await ids(db, 'select id from suppliers where notes like $1', [like]);
  const pos = await ids(db, `select id from purchase_orders where internal_notes like $1 or supplier_id = any($2) or owner_id = any($3) or project_id = any($4) or tender_id = any($5) or contract_id = any($6)
                              or customer_quote_id in (select id from quotes where internal_notes like $1 or opportunity_id = any($7) or customer_id = any($8) or owner_id = any($3))`, [like, sups, usr, projs, tends, cons, opps, cust]);
  await run('update attachments set purchase_order_id = null where purchase_order_id = any($1)', [pos]);
  await run('update supplier_documents set purchase_order_id = null where purchase_order_id = any($1)', [pos]);
  await run('update purchase_order_events set actor_id = null where actor_id = any($1)', [usr]);
  await run('update purchase_orders set issued_by = null where issued_by = any($1)', [usr]);
  await run('delete from purchase_orders where id = any($1)', [pos]);                           // lines and history go with it
  await run('delete from attachments where supplier_id = any($1)', [sups]);                    // their document records go with them
  await run('delete from suppliers where id = any($1)', [sups]);                               // links and history go with them
  await run('update suppliers set created_by = null where created_by = any($1)', [usr]);
  await run('update supplier_events set actor_id = null where actor_id = any($1)', [usr]);
  await run('update supplier_links set added_by = null where added_by = any($1)', [usr]);
  await run('update attachments set uploaded_by = null where uploaded_by = any($1) and supplier_id is not null', [usr]);
  await run('delete from projects where id = any($1)', [projs]);                              // tasks, members and events go with the project
  await run('delete from tenders where id = any($1)', [tends]);                               // children go with the tender
  // quotes: the sample ones, and any made on demo deals or customers or by demo people while trying the system
  await run('update quote_events set actor_id = null where actor_id = any($1)', [usr]);
  await run('delete from quotes where internal_notes like $1 or opportunity_id = any($2) or customer_id = any($3) or owner_id = any($4) or created_by = any($4)', [like, opps, cust, usr]);
  await run('update contracts set opportunity_id = null where opportunity_id = any($1)', [opps]);
  await run('update projects set opportunity_id = null where opportunity_id = any($1)', [opps]);
  await run('delete from opportunities where id = any($1)', [opps]);

  await run('delete from attachments where renewal_id in (select id from renewals where customer_id = any($1) or contract_id = any($2))', [cust, cons]);
  await run('delete from renewal_events where renewal_id in (select id from renewals where customer_id = any($1) or contract_id = any($2))', [cust, cons]);
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
  const storage = require('../lib/storage');
  for (const f of files) await storage.removeStored(f);
  return before;
}

module.exports = { load, remove, status, isEmpty, TAG, DEMO_PASSWORD, DEMO_DOMAIN, STAFF, CUSTOMERS };
