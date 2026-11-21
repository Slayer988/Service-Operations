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
    assets: await n('select count(*)::int as n from assets where customer_id = any($1) or notes like $2', [cust, `${TAG}%`]),
    problems: await n('select count(*)::int as n from problems where created_by = any($1) or customer_id = any($2)', [usr, cust]),
    changes: await n('select count(*)::int as n from changes where created_by = any($1) or customer_id = any($2)', [usr, cust]),
    notices: await n('select count(*)::int as n from notices where created_by = any($1)', [usr]),
    templates: await n('select count(*)::int as n from reply_templates where owner_id = any($1)', [usr]),
    rules: await n('select count(*)::int as n from automation_rules where created_by = any($1)', [usr]),
    time_entries: await n('select count(*)::int as n from ticket_time where user_id = any($1)', [usr]),
    invoices: await n('select count(*)::int as n from invoices where internal_notes like $1 or customer_id = any($2)', [`${TAG}%`, cust]),
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
  await loadAssets(db, U, now);
  await loadServiceManagement(db, U, now);
  await loadDeskTools(db, U, now);
  await loadInvoicing(db, U, now);
  return status(db);
}

/** The asset register: equipment and licences at each demo customer, some with a warranty or licence ending soon or already ended,
 *  linked to their site, CSID and contract, a few bought through a demo LPO, and linked to open tickets. */
async function loadAssets(db, U, now) {
  const A = require('./assets');
  const day = (n) => ymd(addDays(now, n));
  const eng = { id: U.engineer1, name: 'David Mugisha', email: `engineer1@${DEMO_DOMAIN}`, kind: 'staff', role: 'engineer' };
  const dist = (await db.query(`select id from suppliers where notes like $1 and kind = 'distributor' limit 1`, [`${TAG}%`])).rows[0];
  const po = dist ? (await db.query(`select id from purchase_orders where supplier_id = $1 and status in ('issued','received','closed') order by id limit 1`, [dist.id])).rows[0] : null;
  const KIT = {
    'DEMO-KCB': [
      ['Core switch A, server room', 'network', 'Cisco', 'Catalyst 9300-48P', 'FOC2231X0A1', 'kcb-core-sw-a', '10.1.0.2', 1, -700, 395, null],
      ['Core switch B, server room', 'network', 'Cisco', 'Catalyst 9300-48P', 'FOC2231X0A2', 'kcb-core-sw-b', '10.1.0.3', 1, -700, 395, null],
      ['Perimeter firewall', 'security', 'Fortinet', 'FortiGate 200F', 'FG200FTK21000123', 'kcb-fw-01', '10.1.0.1', 1, -500, 230, 21, 'supplier'],
      ['Core banking database server', 'server', 'Dell', 'PowerEdge R750', 'CN0DBSRV7501', 'kcb-db-01', '10.1.10.11', 1, -1130, -35, null],
      ['Application server', 'server', 'Dell', 'PowerEdge R650', 'CN0APPSRV6502', 'kcb-app-01', '10.1.10.12', 1, -400, 690, null],
      ['Backup storage', 'storage', 'Synology', 'RS3621xs+', '2140PDN123456', 'kcb-nas-01', '10.1.10.20', 1, -300, 790, null],
      ['UPS, server room', 'power', 'APC', 'Smart-UPS SRT 10kVA', 'AS2109123456', '', '', 1, -1050, 45, null],
      ['Microsoft 365 E3', 'software', 'Microsoft', '365 E3 (annual)', '', '', '', 250, -290, null, 75],
      ['Branch router, Entebbe', 'network', 'Cisco', 'ISR 1111-8P', 'FGL2245L0E1', 'kcb-ent-rtr', '10.2.0.1', 1, -600, 130, null, null, 'Entebbe branch'],
    ],
    'DEMO-LVH': [
      ['Core switch, main hospital', 'network', 'HPE Aruba', 'CX 6300M', 'SG12KX0LV1', 'lvh-core-01', '172.16.0.2', 1, -420, 680, null],
      ['Wi-Fi 6 access points, wards', 'network', 'HPE Aruba', 'AP-515', '', '', '', 30, -60, 1035, null],
      ['Patient records server', 'server', 'HPE', 'ProLiant DL380 Gen10', 'CZJ0512LVH1', 'lvh-emr-01', '172.16.10.5', 1, -1400, -300, null],
      ['Nurse-call system controller', 'phone', 'Ascom', 'Telligence', 'ASC-778812', '', '172.16.20.4', 1, -900, 200, null],
      ['UPS, data room', 'power', 'Eaton', '9PX 6kVA', 'GA12K0LVH9', '', '', 1, -800, 280, null, null, null, 'under_repair'],
      ['Reception printer', 'printer', 'HP', 'LaserJet Pro M404dn', 'PHBLV40411', '', '172.16.30.9', 1, -500, 50, null, null, 'Outpatient clinic'],
      ['Backup software', 'software', 'Veeam', 'Backup & Replication (10 instances)', '', '', '', 10, -340, null, 25],
    ],
    'DEMO-NLL': [
      ['Firewall, depot', 'security', 'Fortinet', 'FortiGate 60F', 'FGT60FTK22009876', 'nll-fw-01', '192.168.1.1', 1, -380, 350, 350],
      ['Fleet tracking server', 'server', 'Lenovo', 'ThinkSystem SR630', 'J30ABCD1', 'nll-fleet-01', '192.168.1.20', 1, -650, 80, null],
      ['Dispatch laptops', 'end_user', 'Lenovo', 'ThinkPad E14', '', '', '', 12, -200, 165, null],
      ['Virtualisation licences', 'software', 'VMware', 'vSphere Standard (2 CPUs)', '', '', '', 2, -760, null, -10],
    ],
  };
  const made = {};
  for (const [code, rows] of Object.entries(KIT)) {
    const c = (await db.query('select id from customers where code = $1', [code])).rows[0]; if (!c) continue;
    const sites = (await db.query('select id, name from sites where customer_id = $1 order by id', [c.id])).rows;
    const csid = (await db.query('select id from csids where customer_id = $1 order by id limit 1', [c.id])).rows[0];
    const contract = (await db.query(`select id from contracts where customer_id = $1 and status in ('active','renewal_in_progress','expiring') order by id limit 1`, [c.id])).rows[0];
    made[code] = [];
    for (const [name, category, manufacturer, model, serial, hostname, ip, quantity, boughtAgo, warrantyIn, expiresIn, from, siteName, status] of rows) {
      const site = (siteName && sites.find((s) => s.name === siteName)) || sites[0];
      const a = await A.create(db, { name, category, manufacturer, model, serial_number: serial, hostname, ip_address: ip, quantity, status: status || 'active',
        customer_id: c.id, site_id: site ? site.id : null, csid_id: csid ? csid.id : null, contract_id: contract ? contract.id : null,
        supplier_id: from === 'supplier' && dist ? dist.id : null, purchase_order_id: from === 'supplier' && po ? po.id : null,
        purchase_date: day(boughtAgo), warranty_until: warrantyIn === null || warrantyIn === undefined ? null : day(warrantyIn), expires_on: expiresIn === null || expiresIn === undefined ? null : day(expiresIn),
        owner_contact: category === 'end_user' ? 'Dispatch team' : 'IT manager', notes: `${TAG} sample equipment` }, eng, '', { quiet: true });
      made[code].push(a);
    }
  }
  await A.create(db, { name: 'Monitoring server (ours)', category: 'server', manufacturer: 'Dell', model: 'PowerEdge R350', serial_number: 'CN0OURMON01', hostname: 'ops-mon-01', ip_address: '10.250.0.10',
    purchase_date: day(-250), warranty_until: day(845), notes: `${TAG} our own equipment: the monitoring server` }, eng, '', { quiet: true });
  // link the main equipment to open tickets of the same customer, so tickets show what they are about and its warranty
  for (const [code, list] of Object.entries(made)) {
    const t = (await db.query(`select t.id, t.ref, t.customer_id from tickets t join customers c on c.id = t.customer_id where c.code = $1 and t.status in ('new','open','in_progress','pending_customer','pending_vendor') and not t.needs_verification order by t.id limit 2`, [code])).rows;
    for (const [i, tk] of t.entries()) if (list[i * 3]) await A.linkTicket(db, tk, list[i * 3].id, eng);
  }
}

/** Reply templates (shared and personal), automation rules, time logged on tickets over the last two weeks, and when ratings were given. */
async function loadDeskTools(db, U, now) {
  const tpl = [
    ['Asking for a screenshot', 'Asking for details', 'Hello {{requester_name}},\n\nThank you for reporting this. To help us find the cause quickly, could you send us:\n\n- a **screenshot** of the error message\n- the **time** it happened\n- whether it affects **only you or colleagues too**\n\nYou can reply to this e-mail or add it to {{ticket_ref}} in the portal.\n\nKind regards,\n{{agent_name}}'],
    ['Password reset done', 'Accounts', 'Hello {{requester_name}},\n\nYour password has been reset. You will receive the temporary password by SMS. You must change it when you first sign in.\n\nIf you did not ask for this, call us at once.\n\nKind regards,\n{{agent_name}}'],
    ['Escalated to an engineer', 'Updates', 'Hello {{requester_name}},\n\nWe have passed {{ticket_ref}} to one of our engineers, who will contact you shortly. Thank you for your patience.\n\n{{agent_name}}'],
    ['Resolved: please confirm', 'Closing', 'Hello {{requester_name}},\n\nWe believe **{{ticket_subject}}** is now fixed. Please check and confirm in the portal, or reply if anything is still wrong.\n\nKind regards,\n{{agent_name}}'],
    ['Waiting for your reply', 'Closing', 'Hello {{requester_name}},\n\nWe are still waiting for the information we asked for on {{ticket_ref}}. If we do not hear from you within 3 working days we will close the ticket; you can reopen it at any time.\n\n{{agent_name}}'],
  ];
  for (const [title, category, body] of tpl) await db.query('insert into reply_templates (title, category, body, shared, owner_id, use_count) values ($1,$2,$3,true,$4,$5)', [title, category, body, U.manager, 3 + title.length % 17]);
  await db.query(`insert into reply_templates (title, category, body, shared, owner_id) values ('My printer checklist', 'Printers', $1, false, $2)`,
    ['Hello {{requester_name}},\n\nCould you check: 1. the printer is on and shows no error; 2. there is paper and toner; 3. you chose the right printer. Then try again and tell us.\n\n{{agent_name}}', U.agent1]);
  const kcb = (await db.query(`select id from customers where code = 'DEMO-KCB'`)).rows[0];
  const rules = [
    ['Security words go to the Security queue', { words: ['phishing', 'ransomware', 'malware', 'virus', 'suspicious e-mail'] }, { queue: 'security', tier: 'l2', note: 'Possible security incident: do not forward the e-mail or open attachments.' }, true, 7],
    ['Bank P1/P2 to the senior engineer', { customer_id: kcb ? kcb.id : null, priority_max: 2 }, { assignee_id: U.engineer2, note: 'Bank priority ticket: call the IT manager within 15 minutes.' }, false, 4],
    ['Printer requests: first checks', { words: ['printer', 'printing', 'toner'] }, { note: 'Ask for the printer name and whether others can print (template "My printer checklist").' }, false, 11],
  ];
  for (const [i, [name, c, a, stop, n]] of rules.entries()) {
    if (c.customer_id === null) continue;
    await db.query('insert into automation_rules (name, conditions, actions, stop, position, created_by, run_count, last_run_at) values ($1,$2,$3,$4,$5,$6,$7,$8)', [name, c, a, stop, (i + 1) * 10, U.manager, n, addDays(now, -(i + 1))]);
  }
  // time on demo tickets: one to three entries by whoever worked on it, in the last two weeks
  const tix = (await db.query(`select t.id, t.assignee_id, t.non_chargeable, t.status, t.created_at from tickets t join customers c on c.id = t.customer_id
                                where c.code like 'DEMO%' and t.assignee_id is not null and not t.needs_verification order by t.id`)).rows;
  const notes = ['Remote session with the user', 'Checked the logs', 'Site visit', 'Replaced the cable', 'Configured and tested', 'Called the vendor', ''];
  for (const [i, t] of tix.entries()) {
    if (i % 4 === 3) continue;
    const entries = 1 + (i % 3);
    for (let k = 0; k < entries; k++) {
      const back = Math.min(13, (i + k * 2) % 14);
      const day = ymd(addDays(now, -back));
      if (new Date(`${day}T23:59:59Z`) < new Date(t.created_at)) continue;
      await db.query('insert into ticket_time (ticket_id, user_id, work_date, minutes, billable, note) values ($1,$2,$3,$4,$5,$6)', [t.id, t.assignee_id, day, [15, 30, 45, 60, 90, 120, 20][(i + k) % 7], !t.non_chargeable, notes[(i + k) % notes.length]]);
    }
  }
  // ratings: given when the ticket was resolved, half in the portal and half from the e-mail link
  await db.query(`update tickets set satisfaction_at = coalesce(resolved_at, closed_at, updated_at) + interval '3 hours', satisfaction_via = case when id % 2 = 0 then 'email' else 'portal' end
                   where satisfaction is not null and customer_id in (select id from customers where code like 'DEMO%')`);
}

/** Invoicing and supplier performance: billing details on the demo customers; an invoice for a contract instalment that is overdue,
 *  one for support time that is part paid, one for an accepted quote that is paid (on a project), and a draft; quality ratings on the
 *  received orders, one of them delivered late. Settings are not changed. */
async function loadInvoicing(db, U, now) {
  const INV = require('./invoices');
  const today = ymd(now);
  const fin = { id: U.finance, name: 'Kevin Lutaaya', email: `finance@${DEMO_DOMAIN}`, kind: 'staff', role: 'finance' };
  const custs = (await db.query(`select id, code from customers where code like 'DEMO%' order by id`)).rows;
  for (const [i, c] of custs.entries()) {
    await db.query('update customers set tin = $2, billing_email = $3, billing_address = $4, hourly_rate = $5 where id = $1',
      [c.id, String(1000200300 + i * 1111), `accounts.${c.code.toLowerCase().replace('demo-', '')}@${DEMO_DOMAIN}`, `Plot ${12 + i * 7}, Kampala Road\nP.O. Box ${7000 + i * 13}, Kampala`, i === 0 ? 150000 : 120000]);
  }
  const s = await INV.listSettings(db); const cur = s.defaultCurrency;
  const hdr = (cid, extra = {}) => ({ title: '', customer_id: cid, currency: cur, issue_date: null, due_date: null, period_from: null, period_to: null, customer_ref: '',
    payment_terms: `${s.dueDays} days from the invoice date`, terms: s.terms, internal_notes: `${TAG} sample invoice`, tax_rate: s.taxRate, tax_label: s.taxLabel, contract_id: null, project_id: null, ...extra });
  const backdate = (id, issued, due) => db.query(`update invoices set issue_date = $2::date, due_date = $3::date, issued_at = $2::date + time '10:00' where id = $1`, [id, ymd(addDays(now, issued)), ymd(addDays(now, due))]);
  const pay = async (id, amount, daysAgo, method, ref) => INV.addPayment(db, await INV.get(db, id), { amount, paid_on: ymd(addDays(now, -daysAgo)), method, reference: ref, note: '' }, fin, '', today);

  // 1. a contract instalment, issued 45 days ago and not paid: overdue
  const inst = (await db.query(`select cp.id, c.customer_id from contract_payments cp join contracts c on c.id = cp.contract_id
                                 where c.customer_id = any($1) and cp.status = 'scheduled' and cp.invoice_id is null and c.currency = $2 order by cp.due_date limit 1`, [custs.map((c) => c.id), cur])).rows[0];
  if (inst) {
    const i1 = await INV.create(db, hdr(inst.customer_id, { customer_ref: 'PO-2026-0412' }), { instalments: [inst.id], upto: ymd(addDays(now, 365)) }, fin, '', today);
    await INV.issue(db, i1, fin, '', today); await backdate(i1.id, -45, -15);
  }
  // 2 and 4. support time: the customer with the most unbilled time is invoiced and part paid; the next one is a draft
  const tm = (await db.query(`select t.customer_id, count(distinct t.id)::int as n from ticket_time tt join tickets t on t.id = tt.ticket_id
                               where t.customer_id = any($1) and tt.billable and tt.invoice_id is null and not t.non_chargeable group by 1 order by sum(tt.minutes) desc limit 2`, [custs.map((c) => c.id)])).rows;
  const tix = async (cid, n) => (await db.query(`select distinct t.id from ticket_time tt join tickets t on t.id = tt.ticket_id where t.customer_id = $1 and tt.billable and tt.invoice_id is null and not t.non_chargeable limit $2`, [cid, n])).rows.map((r) => r.id);
  if (tm[0]) {
    const i2 = await INV.create(db, hdr(tm[0].customer_id, { title: 'Support services this month', period_from: ymd(addDays(now, -14)), period_to: today }), { tickets: await tix(tm[0].customer_id, 6), upto: today }, fin, '', today);
    await INV.issue(db, i2, fin, '', today); await backdate(i2.id, -6, 24);
    const g = await INV.get(db, i2.id);
    await pay(i2.id, Math.round(Number(g.total) * 0.4), 2, 'mobile_money', 'MP261118.1432.A77');
  }
  if (tm[1]) await INV.create(db, hdr(tm[1].customer_id, { title: 'Support services (to check)' }), { tickets: await tix(tm[1].customer_id, 3), upto: today }, fin, '', today);
  // 3. an accepted quote, invoiced against the customer's project and paid
  const qu = (await db.query(`select qu.id, qu.customer_id, qu.currency from quotes qu where qu.internal_notes like $1 and qu.status = 'accepted' and qu.customer_id is not null
                               and not exists (select 1 from invoices i where i.quote_id = qu.id and i.status <> 'cancelled') order by qu.id limit 1`, [`${TAG}%`])).rows[0];
  if (qu) {
    const pj = (await db.query(`select id from projects where customer_id = $1 and description like $2 order by id limit 1`, [qu.customer_id, `${TAG}%`])).rows[0];
    const i3 = await INV.create(db, hdr(qu.customer_id, { currency: qu.currency, project_id: pj ? pj.id : null }), { quote: qu.id, upto: today }, fin, '', today);
    await INV.issue(db, i3, fin, '', today); await backdate(i3.id, -20, 10);
    const g = await INV.get(db, i3.id);
    await pay(i3.id, Number(g.total), 5, 'bank', 'EFT 77120934');
  }
  // supplier performance: quality ratings on received orders, one delivered 4 days late
  const got = (await db.query(`select id, delivery_date from purchase_orders where internal_notes like $1 and status in ('received','closed') order by id`, [`${TAG}%`])).rows;
  const rate = [[4, 'Complete and well packed.'], [2, 'Two access points arrived damaged and were replaced a week later.'], [5, 'Neat work; tested and labelled.']];
  for (const [i, o] of got.entries()) {
    await db.query('update purchase_orders set quality = $2, quality_note = $3 where id = $1', [o.id, rate[i % 3][0], rate[i % 3][1]]);
    // received around the deliver-by date: the first one 4 days late, the others a day early
    if (o.delivery_date) await db.query(`update purchase_orders set received_at = (delivery_date + $2::int) + time '11:00' where id = $1 and delivery_date + $2::int <= current_date`, [o.id, i === 0 ? 4 : -1]);
  }
}

/** Problems, changes and service notices: a known error with its workaround and the change that fixes it, changes at every stage
 *  (one waiting for approval, two clashing on the calendar, one failed and backed out), an open major incident with updates,
 *  announced maintenance, and an incident resolved last week. Nothing is e-mailed. */
async function loadServiceManagement(db, U, now) {
  const P = require('./problems'); const C = require('./changes'); const N = require('./notices'); const tz = require('../lib/tz');
  const eng = { id: U.engineer1, name: 'David Mugisha', email: `engineer1@${DEMO_DOMAIN}`, kind: 'staff', role: 'engineer' };
  const agent = { id: U.agent1, name: 'Brian Okello', email: `agent1@${DEMO_DOMAIN}`, kind: 'staff', role: 'agent' };
  const mgr = { id: U.manager, name: 'Amina Nakato', email: `manager@${DEMO_DOMAIN}`, kind: 'staff', role: 'service_manager' };
  const cust = async (code) => (await db.query('select id from customers where code = $1', [code])).rows[0].id;
  const asset = async (name) => { const r = (await db.query('select tag from assets where name = $1 and notes like $2 limit 1', [name, `${TAG}%`])).rows[0]; return r ? r.tag : ''; };
  const tickets = async (code, n) => (await db.query(`select t.id, t.ref from tickets t join customers c on c.id = t.customer_id where c.code = $1 and not t.needs_verification order by t.created_at desc limit $2`, [code, n])).rows;
  const at = (days, hh, mm = 0) => { const d = addDays(now, days); return tz.dateToLocal(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), hh - 3, mm)), 'Africa/Kampala'); };
  const KCB = await cust('DEMO-KCB'); const LVH = await cust('DEMO-LVH'); const NLL = await cust('DEMO-NLL');

  // ---- problems
  const p1 = await P.create(db, { title: 'Entebbe branch VPN drops several times a day', priority: 2, customer_id: KCB,
    description: 'The site-to-site VPN from the Entebbe branch drops for 2 to 5 minutes, four to six times a day, since the router was replaced. Tellers lose the core banking system each time.',
    root_cause: 'A firmware bug in the branch router (Cisco ISR, IOS-XE 17.6.1) resets the IPsec tunnel when the ISP link renegotiates. Fixed by the vendor in 17.9.4.',
    workaround: 'On the head-office firewall, clear the Entebbe tunnel (VPN > IPsec monitor > Entebbe > Bring up). It comes back in under a minute. Tell the branch manager the core system is back.',
    permanent_fix: '' }, eng, '');
  for (const t of await tickets('DEMO-KCB', 2)) await P.linkTicket(db, p1, t.ref, eng);
  const br = await asset('Branch router, Entebbe'); if (br) await P.linkAsset(db, p1, br, eng);
  await P.setStatus(db, await P.get(db, p1.id), 'known_error', eng, 'Root cause confirmed with the vendor.', '');
  const p2 = await P.create(db, { title: 'Patient records server slow every morning', priority: 3, customer_id: LVH,
    description: 'Between 07:30 and 08:30 the patient records system takes up to a minute to open a record. Reported by the wards and the outpatient clinic.' }, eng, '');
  for (const t of await tickets('DEMO-LVH', 1)) await P.linkTicket(db, p2, t.ref, eng);
  const emr = await asset('Patient records server'); if (emr) await P.linkAsset(db, p2, emr, eng);
  await P.setStatus(db, await P.get(db, p2.id), 'investigating', eng, 'Collecting disk and database statistics for a week.', '');

  // ---- changes
  const mk = async (b) => C.create(db, { owner_id: eng.id, implementer_id: eng.id, ...b }, eng, '');
  const run = async (c, moves, note = '') => { let x = await C.get(db, c.id); await approveAll(db, U, 'change', c.id, eng, 'Plan and back-out reviewed.'); for (const m of moves) x = await C.setStatus(db, await C.get(db, x.id), m, eng, m === moves[moves.length - 1] ? note : '', ''); return x; };
  // a finished change moved into the past, at a sensible hour of that evening (local time)
  const backdate = async (c, startDays, hh, hours) => { const start = tz.localToDate(at(startDays, hh), 'Africa/Kampala');
    await db.query(`update changes set planned_start = $2, planned_end = $2::timestamptz + make_interval(hours => $3), actual_start = case when actual_start is null then null else $2::timestamptz + interval '4 minutes' end,
       actual_end = case when actual_end is null then null else $2::timestamptz + make_interval(hours => $3) - interval '20 minutes' end where id = $1`, [c.id, start, hours]);
    await db.query(`update change_events set at = $2::timestamptz - interval '2 days' + (id - (select min(id) from change_events where change_id = $1)) * interval '3 hours' where change_id = $1 and id < (select max(id) - 2 from change_events where change_id = $1)`, [c.id, start]);
    await db.query(`update change_events set at = $2::timestamptz + (id - (select max(id) - 2 from change_events where change_id = $1)) * interval '30 minutes' where change_id = $1 and id >= (select max(id) - 2 from change_events where change_id = $1)`, [c.id, start]); };
  const plan = { implementation_plan: '1. Take a backup of the configuration.\n2. Apply the change.\n3. Check the service with the customer.', backout_plan: 'Restore the saved configuration and reboot (10 minutes).', test_plan: 'Users at the site can log in and open the core system.' };
  const c1 = await mk({ title: 'Replace the UPS batteries, KCB server room', type: 'normal', risk: 'low', customer_id: KCB, impact: 'None expected: the UPS runs on bypass for 20 minutes.', planned_start: at(3, 20), planned_end: at(3, 22), assets: await asset('UPS, server room'), ...plan });
  await run(c1, ['scheduled', 'in_progress', 'completed'], 'Batteries replaced, self-test passed, runtime 38 minutes at current load.'); await backdate(c1, -6, 20, 2);
  const c2 = await mk({ title: 'Upgrade the depot firewall firmware', type: 'normal', risk: 'medium', customer_id: NLL, impact: 'Internet and VPN down for up to 15 minutes at the depot.', planned_start: at(4, 21), planned_end: at(4, 22), assets: await asset('Firewall, depot'), ...plan });
  await run(c2, ['scheduled', 'in_progress', 'failed'], 'After the upgrade the dispatch VPN would not come up. Rolled back to 7.2.8 within 12 minutes; service restored. Vendor case opened.'); await backdate(c2, -10, 21, 1);
  const c3 = await mk({ title: 'Upgrade the Entebbe branch router firmware (fixes PRB-000001)', type: 'normal', risk: 'medium', customer_id: KCB, problem_id: p1.id,
    impact: 'The Entebbe branch is offline for about 15 minutes, after banking hours.', planned_start: at(3, 22), planned_end: at(3, 23, 30), assets: br, ...plan });
  await run(c3, ['scheduled']);
  const c6 = await mk({ title: 'Core switch configuration backup and reboot', type: 'normal', risk: 'low', customer_id: KCB, impact: 'Head office network down for 5 minutes.', planned_start: at(3, 23), planned_end: at(4, 0, 30), assets: await asset('Core switch A, server room'), ...plan });
  await run(c6, ['scheduled']);
  await mk({ title: 'Add 20 Microsoft 365 E3 licences', type: 'standard', risk: 'low', customer_id: KCB, impact: 'None.', planned_start: at(1, 10), planned_end: at(1, 11),
    implementation_plan: 'Buy 20 more seats in the admin centre and assign them to the new staff list.', backout_plan: '', test_plan: 'New staff can sign in.' }).then(async (c) => C.setStatus(db, c, 'scheduled', eng, '', ''));
  const c4 = await mk({ title: 'Move patient records to the new server', type: 'normal', risk: 'high', customer_id: LVH,
    impact: 'Patient records unavailable for up to 2 hours overnight; wards use the paper procedure.', planned_start: at(9, 22), planned_end: at(10, 0), assets: emr, ...plan });
  await require('./approvals').request(db, 'change', c4.id, eng, '');        // waiting for the change approvers

  // ---- service notices: an open major incident, announced maintenance, and one resolved last week
  const t = (await tickets('DEMO-KCB', 1))[0];
  const n1 = (await N.create(db, { kind: 'incident', title: 'Internet access down at the Entebbe branch', severity: 'outage', customer_ids: [KCB], ticket_id: t ? t.id : null,
    text: 'The Entebbe branch has no internet or core banking access. Our engineers are working with the internet provider. Next update within 30 minutes.' }, agent, '')).notice;
  await N.addUpdate(db, n1, { status: 'identified', text: 'The provider has found a fibre cut near Kajjansi and a repair team is on site; they expect about 3 hours. Meanwhile the branch can use the 4G backup link for the core system.' }, agent, '');
  // the incident began 2 hours before the demo was loaded, with the second update an hour later
  await db.query(`update notices set starts_at = now() - interval '2 hours' where id = $1`, [n1.id]);
  await db.query(`update notice_updates set at = now() - interval '115 minutes' + (id - (select min(id) from notice_updates where notice_id = $1)) * interval '60 minutes' where notice_id = $1`, [n1.id]);
  await N.create(db, { kind: 'maintenance', title: 'Branch router upgrade, Entebbe', customer_ids: [KCB], change_id: c3.id, starts_at: at(3, 22), ends_at: at(3, 23, 30),
    text: 'We will upgrade the Entebbe branch router to fix the VPN drops. The branch will be offline for about 15 minutes after banking hours.' }, mgr, '');
  const n3 = (await N.create(db, { kind: 'incident', title: 'E-mail delays', severity: 'degraded', customer_ids: [NLL], text: 'Some e-mails are arriving up to 30 minutes late. We are investigating.', starts_at: at(-5, 9) }, agent, '')).notice;
  await N.addUpdate(db, n3, { status: 'resolved', text: 'The mail relay queue was cleared and the cause (a full disk) fixed. All delayed e-mails have been delivered.' }, agent, '');
  await db.query(`update notices set closed_at = $2 where id = $1`, [n3.id, addDays(now, -5)]);
  await db.query(`update notice_updates set at = $2::timestamptz + (id - (select min(id) from notice_updates where notice_id = $1)) * interval '90 minutes' where notice_id = $1`, [n3.id, addDays(now, -5)]);
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

// Approval the way people do it: the owner asks, finance (and management for a second approval) decides.
function demoApprovers(U) {
  return { 1: { id: U.finance, name: 'Kevin Lutaaya', email: `finance@${DEMO_DOMAIN}`, kind: 'staff', role: 'finance' },
    2: { id: U.executive, name: 'Lydia Namara', email: `executive@${DEMO_DOMAIN}`, kind: 'staff', role: 'management' } };
}
async function approveAll(db, U, entity, id, requester, comment = 'Checked against the budget.') {
  const A = require('./approvals'); const who = demoApprovers(U);
  for (let i = 0; i < 3; i++) {
    const st = await A.state(db, entity, await A.load(db, entity, id));
    if (!st.needed.length || st.complete) return;
    if (!st.pending) await A.request(db, entity, id, requester, '');
    const p = (await A.state(db, entity, await A.load(db, entity, id))).pending;
    // the first demo person whose role may decide this request (and who did not ask for it)
    const pool = [who[1], who[2], { id: U.manager, name: 'Amina Nakato', email: `manager@${DEMO_DOMAIN}`, kind: 'staff', role: 'service_manager' }, { id: U.depthead, name: 'Moses Byaruhanga', email: `depthead@${DEMO_DOMAIN}`, kind: 'staff', role: 'dept_head' }];
    const decider = pool.find((x) => p.record.roles.includes(x.role) && x.id !== requester.id) || who[p.level] || who[1];
    await A.decide(db, p.record.id, decider, 'approved', comment, '');
  }
}

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
  await approveAll(db, U, 'quote', q1.id, bd);
  q1 = await Q.setStatus(db, q1, 'sent', bd, { note: 'E-mailed to the IT manager.' });
  // 2: Managed backup for clinics (negotiation): R1 sent, then revised with a discount and sent again
  let q2 = await make(3, [['Backup appliance', 2, 'each', 32000000], ['Cloud backup storage (10 TB)', 12, 'month', 6500000], ['Onboarding and restore testing', 1, 'project', 12000000]]);
  await approveAll(db, U, 'quote', q2.id, bd);
  q2 = await Q.setStatus(db, q2, 'sent', bd, { note: 'First offer.' });
  let q2b = await Q.revise(db, q2, bd, '');
  q2b = await Q.saveLines(db, q2b, [['Backup appliance', 2, 'each', 32000000, 5], ['Cloud backup storage (10 TB)', 12, 'month', 6500000, 10], ['Onboarding and restore testing', 1, 'project', 12000000]]
    .map(([description, quantity, unit, unit_price, discount_pct = 0]) => ({ description, quantity, unit, unit_price, discount_pct, line_total: Q.lineTotal(quantity, unit_price, discount_pct) })), bd);
  await approveAll(db, U, 'quote', q2b.id, bd, 'Discount agreed: within this quarter\'s margin.');
  await Q.setStatus(db, q2b, 'sent', bd, { note: 'Revised after the commercial meeting: discount on hardware and storage.' });
  // 3: Cybersecurity assessment (won): accepted
  let q3 = await make(7, [['External penetration test', 1, 'engagement', 38000000], ['Internal vulnerability assessment', 1, 'engagement', 27000000], ['Report and executive debrief', 1, 'each', 6000000]]);
  await approveAll(db, U, 'quote', q3.id, bd);
  q3 = await Q.setStatus(db, q3, 'sent', bd, {});
  await Q.setStatus(db, q3, 'accepted', bd, { note: 'Purchase order received.' });
  // 4: Fleet tracking integration (lead, a prospect): draft, waiting for approval (so approvers have something to decide)
  const q4 = await make(5, [['GPS tracker with installation', 150, 'vehicle', 950000], ['Tracking platform licence', 150, 'vehicle / month', 45000]]);
  const A = require('./approvals');
  if ((await A.state(db, 'quote', await A.load(db, 'quote', q4.id))).needed.length) await A.request(db, 'quote', q4.id, bd, '');
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
  await approveAll(db, U, 'lpo', po.id, buyer);
  await PO.setStatus(db, po, 'issued', buyer, { note: 'Sent to Peter Ochieng.' });
  const con = (await db.query(`select id from contracts where notes like $1 order by id limit 1`, [`${TAG}%`])).rows[0];
  let po2 = await PO.create(db, { ...(await PO.defaults(db, { supplier: dist.id, contract: con ? con.id : '' }, today)), currency: cur, title: 'Firewall renewal licences', tax_rate: s.taxRate, tax_label: s.taxLabel,
    internal_notes: `${TAG} sample LPO`, supplier_doc_id: null, project_id: null, tender_id: null, customer_quote_id: null }, buyer, '');
  await PO.saveLines(db, po2, lines([['FortiGate 100F UTP bundle, 1 year', 2, 'licence', 6400000]]), buyer);
  await require('./approvals').request(db, 'lpo', po2.id, buyer, '');                 // a draft waiting for finance
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
    await approveAll(db, U, 'lpo', o.id, buyer);
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
  await run('delete from notices where created_by = any($1) or ticket_id = any($2)', [usr, tix]);
  await run('delete from automation_rules where created_by = any($1)', [usr]);
  await run('delete from reply_templates where owner_id = any($1)', [usr]);
  await run('delete from ticket_time where user_id = any($1) or ticket_id = any($2)', [usr, tix]);
  // invoices: the sample ones, and any raised for demo customers, by demo people, or on demo quotes, projects and contracts (lines, payments, history go with them)
  await run(`delete from invoices where internal_notes like $1 or customer_id = any($2) or owner_id = any($3) or project_id = any($4) or contract_id = any($5)
               or quote_id in (select id from quotes where internal_notes like $1 or customer_id = any($2) or owner_id = any($3))`, [like, cust, usr, projs, cons]);
  await run('update invoice_payments set recorded_by = null where recorded_by = any($1)', [usr]);
  await run('update invoice_events set actor_id = null where actor_id = any($1)', [usr]);
  await run('update invoices set issued_by = null where issued_by = any($1)', [usr]);
  await run(`delete from approvals where entity = 'change' and entity_id in (select id from changes where created_by = any($1) or customer_id = any($2))`, [usr, cust]);
  await run('delete from changes where created_by = any($1) or customer_id = any($2)', [usr, cust]);
  await run('delete from problems where created_by = any($1) or customer_id = any($2)', [usr, cust]);
  await run('delete from assets where customer_id = any($1) or notes like $2 or created_by = any($3)', [cust, like, usr]);
  await run('delete from asset_events where actor_id = any($1)', [usr]);
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
  await run(`delete from approvals where (entity = 'lpo' and entity_id = any($1)) or requested_by = any($2) or decided_by = any($2)`, [pos, usr]);
  await run(`delete from approvals where entity = 'quote' and entity_id in (select id from quotes where internal_notes like $1 or opportunity_id = any($2) or customer_id = any($3) or owner_id = any($4) or created_by = any($4))`, [like, opps, cust, usr]);
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
