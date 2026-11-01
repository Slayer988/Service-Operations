-- 1.3.0: Contracts register (replaces renewals), Tender Management and Pipeline Tracker per the Ops requirements document,
-- Service Delivery Engineer support, service catalogue, one CSID per customer, many contracts per service, new roles.

-- ---------------------------------------------------------------- roles
alter table users drop constraint users_role_check;
alter table users add constraint users_role_check check (role in (
  'platform_admin','service_manager','contract_manager','agent','engineer','security_analyst','auditor',
  'management','bd_manager','bid_manager','technical_team','sde','finance','legal','dept_head','readonly',
  'customer_admin','customer_user'));

-- ---------------------------------------------------------------- one CSID per customer
do $$
begin
  if exists (select 1 from csids group by customer_id having count(*) > 1) then
    raise notice 'Some customers already have more than one CSID. The application refuses to create more, but the existing ones are left alone.';
  else
    create unique index csids_one_per_customer on csids (customer_id);
  end if;
end $$;

-- ---------------------------------------------------------------- service catalogue
create table service_catalogue (
  id bigserial primary key,
  code text not null unique,
  name text not null unique,
  category text not null default '',                      -- ticket category used when it is requested
  description text not null default '',
  icon text not null default 'grid',
  request_type text not null default 'request' check (request_type in ('incident','request')),
  sla_policy_id bigint references sla_policies(id),
  owner_team text not null default '',
  featured boolean not null default false,                -- shown as a tile on the dashboards
  active boolean not null default true,
  sort_order int not null default 100,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
insert into service_catalogue (code, name, category, description, icon, request_type, featured, sort_order) values
 ('CAT-HW',  'Hardware / New Device',  'Hardware',            'Laptops, desktops and accessories: request, replace or repair.',        'laptop',  'request', true, 10),
 ('CAT-ACC', 'Access and Accounts',    'Access and accounts', 'Passwords, new users, leavers and permission changes.',                 'lock',    'request', true, 20),
 ('CAT-EML', 'Email',                  'Email',               'Mailboxes, distribution lists and mail problems.',                      'mail',    'request', true, 30),
 ('CAT-NET', 'Network',                'Network',             'Connectivity, VPN and Wi-Fi.',                                          'wifi',    'request', true, 40),
 ('CAT-PRN', 'Printer',                'Printer',             'Printing, scanning and supplies.',                                      'printer', 'request', true, 50),
 ('CAT-SRV', 'Server support',         'Server',              'Monitoring and support of physical and virtual servers.',               'server',  'request', false, 110),
 ('CAT-NSP', 'Network support',        'Network',             'Managed network support and maintenance.',                              'wifi',    'request', false, 120),
 ('CAT-SEC', 'Cybersecurity',          'Security',            'Security monitoring, incident response and hardening.',                 'shield',  'request', false, 130),
 ('CAT-STO', 'Storage and backup',     'Storage',             'Storage platforms, backup and recovery.',                               'server',  'request', false, 140),
 ('CAT-EUS', 'End-user support',       'Software',            'Desktop and application support for staff.',                            'user',    'request', false, 150),
 ('CAT-MGI', 'Managed infrastructure', 'Server',              'Operation of customer infrastructure under a service agreement.',       'server',  'request', false, 160),
 ('CAT-PRO', 'Professional services',  'Other',               'Projects, design, migrations and consulting.',                          'clipboard','request', false, 170),
 ('CAT-OTH', 'Other',                  'Other',               'Anything not listed.',                                                  'grid',    'request', false, 900);
alter table services add column catalogue_id bigint references service_catalogue(id);
update services s set catalogue_id = c.id from service_catalogue c where lower(c.name) = lower(s.service_type);
create index services_catalogue_idx on services (catalogue_id);

-- ---------------------------------------------------------------- contracts register
create sequence contract_seq;
alter table contracts alter column customer_id drop not null;
alter table contracts alter column sla_policy_id drop not null;
alter table contracts drop constraint contracts_customer_id_reference_key;
update contracts c set reference = c.reference || '-' || c.id where exists (select 1 from contracts d where d.reference = c.reference and d.id < c.id);
alter table contracts add constraint contracts_reference_key unique (reference);
alter table contracts alter column reference set default ('CTR-' || lpad(nextval('contract_seq')::text, 6, '0'));
alter table contracts drop constraint contracts_status_check;
update contracts set status = 'active' where status = 'draft';
alter table contracts add constraint contracts_status_check check (status in ('active','expiring_soon','renewal_in_progress','expired','suspended','terminated','closed'));
alter table contracts
  add column title text not null default '',
  add column type text not null default 'Service agreement',
  add column counterparty_kind text not null default 'customer' check (counterparty_kind in ('customer','supplier','partner')),
  add column supplier text not null default '',
  add column description text not null default '',
  add column value numeric(16,2) check (value is null or value >= 0),
  add column annual_value numeric(16,2) check (annual_value is null or annual_value >= 0),
  add column currency text not null default 'UGX',
  add column owner_id bigint references users(id),
  add column department text not null default '',
  add column renewal_date date,
  add column renewal_terms text not null default '',
  add column notice_days int not null default 60,
  add column auto_renew boolean not null default false,
  add column extra_emails text[] not null default '{}',
  add column tender_id bigint references tenders(id),
  add column opportunity_id bigint references opportunities(id),
  add column legacy_renewal_id bigint,
  add column created_by bigint references users(id),
  add column updated_at timestamptz not null default now();
update contracts set title = reference where title = '';
alter table contracts add constraint contracts_counterparty check (counterparty_kind <> 'customer' or customer_id is not null);
create index contracts_end_idx on contracts (end_date);
create index contracts_customer_idx on contracts (customer_id);

create table contract_events (
  id bigserial primary key,
  contract_id bigint not null references contracts(id) on delete cascade,
  actor_id bigint references users(id),
  kind text not null,
  text text not null default '',
  created_at timestamptz not null default now()
);
create index contract_events_idx on contract_events (contract_id, id);
create table contract_contacts (
  contract_id bigint not null references contracts(id) on delete cascade,
  user_id bigint not null references users(id),
  primary key (contract_id, user_id)
);
create table contract_obligations (
  id bigserial primary key,
  contract_id bigint not null references contracts(id) on delete cascade,
  kind text not null default 'obligation' check (kind in ('obligation','deliverable','milestone')),
  title text not null,
  description text not null default '',
  responsible text not null default '',
  responsible_id bigint references users(id),
  due_date date,
  status text not null default 'open' check (status in ('open','in_progress','done','waived')),
  completed_at timestamptz,
  created_at timestamptz not null default now()
);
create index contract_obligations_idx on contract_obligations (contract_id);
create table contract_amendments (
  id bigserial primary key,
  contract_id bigint not null references contracts(id) on delete cascade,
  kind text not null default 'amendment' check (kind in ('variation','extension','amendment','revision')),
  effective_date date not null,
  description text not null,
  old_end_date date, new_end_date date,
  old_value numeric(16,2), new_value numeric(16,2),
  created_by bigint references users(id),
  created_at timestamptz not null default now()
);
create index contract_amendments_idx on contract_amendments (contract_id);
create table contract_payments (
  id bigserial primary key,
  contract_id bigint not null references contracts(id) on delete cascade,
  due_date date not null,
  description text not null default '',
  amount numeric(16,2) not null check (amount >= 0),
  status text not null default 'scheduled' check (status in ('scheduled','invoiced','paid')),
  paid_on date,
  created_at timestamptz not null default now()
);
create index contract_payments_idx on contract_payments (contract_id, due_date);
create table contract_sla_targets (
  id bigserial primary key,
  contract_id bigint not null references contracts(id) on delete cascade,
  metric text not null check (metric in ('availability','response_time','resolution_time','other')),
  label text not null,
  target numeric(12,3) not null,
  unit text not null default '',
  direction text not null check (direction in ('min','max')),     -- min: measured must be at least the target; max: at most
  notes text not null default ''
);
create index contract_sla_targets_idx on contract_sla_targets (contract_id);
create table contract_performance (
  id bigserial primary key,
  contract_id bigint not null references contracts(id) on delete cascade,
  sla_target_id bigint not null references contract_sla_targets(id) on delete cascade,
  period_start date not null,
  period_end date not null,
  measured numeric(12,3) not null,
  note text not null default '',
  recorded_by bigint references users(id),
  created_at timestamptz not null default now(),
  check (period_end >= period_start)
);
create index contract_performance_idx on contract_performance (contract_id, sla_target_id);
create table contract_reviews (
  id bigserial primary key,
  contract_id bigint not null references contracts(id) on delete cascade,
  stage text not null check (stage in ('legal','finance','management','department')),
  reviewer_id bigint not null references users(id),
  decision text not null check (decision in ('approved','changes_requested','rejected')),
  comment text not null default '',
  created_at timestamptz not null default now()
);
create index contract_reviews_idx on contract_reviews (contract_id, id);

-- a service can be covered by many contracts; both must belong to the same customer (enforced by the foreign keys)
create table service_contracts (
  service_id bigint not null,
  contract_id bigint not null,
  customer_id bigint not null,
  linked_by bigint references users(id),
  linked_at timestamptz not null default now(),
  primary key (service_id, contract_id),
  foreign key (service_id, customer_id) references services (id, customer_id) on delete cascade,
  foreign key (contract_id, customer_id) references contracts (id, customer_id) on delete cascade
);
create index service_contracts_contract_idx on service_contracts (contract_id);
insert into service_contracts (service_id, contract_id, customer_id) select id, contract_id, customer_id from services where contract_id is not null;
alter table services drop column contract_id;

-- ---------------------------------------------------------------- tenders
alter table tenders drop constraint tenders_status_check;
update tenders set status = case status when 'reviewing' then 'under_review' when 'preparing' then 'bid_preparation' when 'won' then 'awarded'
                                         when 'lost' then 'unsuccessful' when 'no_bid' then 'withdrawn' else status end;
alter table tenders add constraint tenders_status_check check (status in
  ('identified','registered','under_review','qualification','bid_preparation','internal_approval','submitted','under_evaluation','clarification',
   'awarded','unsuccessful','cancelled','withdrawn','closed'));
alter table tenders
  add column type text not null default 'RFP',
  add column description text not null default '',
  add column scope text not null default '',
  add column department text not null default '',
  add column business_unit text not null default '',
  add column submission_method text not null default '',
  add column submission_reference text not null default '',
  add column awarded_to text not null default '',
  add column awarded_on date,
  add column closed_at timestamptz;
alter table tender_tasks
  add column section text not null default 'general' check (section in ('administrative','technical','financial','statutory','preparation','general')),
  add column notes text not null default '';
create table tender_members (
  tender_id bigint not null references tenders(id) on delete cascade,
  user_id bigint not null references users(id),
  role text not null default 'technical',
  primary key (tender_id, user_id)
);
create table tender_reviews (
  id bigserial primary key,
  tender_id bigint not null references tenders(id) on delete cascade,
  stage text not null check (stage in ('technical','commercial','management')),
  reviewer_id bigint not null references users(id),
  decision text not null check (decision in ('approved','changes_requested','rejected')),
  comment text not null default '',
  created_at timestamptz not null default now()
);
create index tender_reviews_idx on tender_reviews (tender_id, id);
create table tender_evaluations (
  id bigserial primary key,
  tender_id bigint not null references tenders(id) on delete cascade,
  kind text not null check (kind in ('stage','clarification','score')),
  title text not null,
  event_date date,
  due_date date,
  responded_on date,
  score numeric(7,2),
  outcome text not null default '',
  notes text not null default '',
  created_by bigint references users(id),
  created_at timestamptz not null default now()
);
create index tender_evaluations_idx on tender_evaluations (tender_id, id);

-- ---------------------------------------------------------------- pipeline
alter table opportunities drop constraint opportunities_stage_check;
update opportunities set stage = case stage when 'lead' then 'lead_identification' when 'qualified' then 'qualification' when 'proposal' then 'proposal_submission' else stage end;
alter table opportunities add constraint opportunities_stage_check check (stage in
  ('lead_identification','prospecting','qualification','solution_development','proposal_submission','negotiation','closing','won','lost','on_hold'));
alter table opportunities alter column stage set default 'lead_identification';
alter table opportunities alter column currency set default 'UGX';
alter table opportunities
  add column industry text not null default '',
  add column classification text not null default '',
  add column segment text not null default '',
  add column team text not null default '',
  add column competitor text not null default '',
  add column next_step_owner_id bigint references users(id),
  add column support_challenges text not null default '',
  add column support_recommendations text not null default '';
alter table customers add column industry text not null default '';

create table opportunity_contacts (
  id bigserial primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  name text not null,
  title text not null default '',
  email text not null default '',
  phone text not null default ''
);
create index opportunity_contacts_idx on opportunity_contacts (opportunity_id);
create table opportunity_activities (
  id bigserial primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  kind text not null check (kind in ('meeting','call','email','presentation','follow_up','technical_meeting','site_assessment','solution_review','consultation','other')),
  activity_date date not null,
  description text not null,
  outcome text not null default '',
  technical boolean not null default false,
  created_by bigint references users(id),
  created_at timestamptz not null default now()
);
create index opportunity_activities_idx on opportunity_activities (opportunity_id, activity_date);
create table opportunity_proposals (
  id bigserial primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  kind text not null check (kind in ('quotation','proposal','technical_submission')),
  reference text not null default '',
  due_date date,
  submitted_on date,
  status text not null default 'preparing' check (status in ('preparing','submitted','accepted','rejected')),
  prepared_by bigint references users(id),
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index opportunity_proposals_idx on opportunity_proposals (opportunity_id);
create table opportunity_engineers (
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  user_id bigint not null references users(id),
  assigned_by bigint references users(id),
  assigned_at timestamptz not null default now(),
  primary key (opportunity_id, user_id)
);
create index opportunity_engineers_user_idx on opportunity_engineers (user_id);
create sequence opp_task_seq;
create table opp_tasks (
  id bigserial primary key,
  ref text not null unique default ('TSK-' || lpad(nextval('opp_task_seq')::text, 6, '0')),
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  title text not null,
  description text not null default '',
  assignee_id bigint references users(id),
  priority text not null default 'normal' check (priority in ('low','normal','high','urgent')),
  start_date date,
  due_date date,
  status text not null default 'pending' check (status in ('pending','in_progress','completed')),
  progress int not null default 0 check (progress between 0 and 100),
  work_notes text not null default '',
  completed_at timestamptz,
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index opp_tasks_opp_idx on opp_tasks (opportunity_id);
create index opp_tasks_assignee_idx on opp_tasks (assignee_id, status);
create table opp_task_history (
  id bigserial primary key,
  task_id bigint not null references opp_tasks(id) on delete cascade,
  actor_id bigint references users(id),
  text text not null,
  created_at timestamptz not null default now()
);
create index opp_task_history_idx on opp_task_history (task_id, id);
create table opportunity_solution_items (
  id bigserial primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  kind text not null check (kind in ('design','architecture','bom','sizing','technical_proposal','other')),
  title text not null,
  description text not null default '',
  status text not null default 'in_progress' check (status in ('in_progress','completed')),
  author_id bigint references users(id),
  created_at timestamptz not null default now()
);
create index opportunity_solution_items_idx on opportunity_solution_items (opportunity_id);
create table opportunity_resources (
  id bigserial primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  user_id bigint references users(id),
  name text not null default '',
  skill text not null default '',
  planned_hours numeric(8,1) not null default 0 check (planned_hours >= 0),
  actual_hours numeric(8,1) not null default 0 check (actual_hours >= 0),
  notes text not null default ''
);
create index opportunity_resources_idx on opportunity_resources (opportunity_id);

-- ---------------------------------------------------------------- documents: any record, with kinds and versions
alter table attachments
  add column contract_id bigint references contracts(id),
  add column opportunity_id bigint references opportunities(id),
  add column opp_task_id bigint references opp_tasks(id),
  add column doc_kind text not null default '',
  add column version int not null default 1;
alter table attachments drop constraint attachments_target;
alter table attachments add constraint attachments_target check (num_nonnulls(ticket_id, renewal_id, tender_id, contract_id, opportunity_id) >= 1);
create index attachments_contract_idx on attachments (contract_id);
create index attachments_opportunity_idx on attachments (opportunity_id);
alter table notifications add column contract_id bigint references contracts(id), add column opportunity_id bigint references opportunities(id);

-- ---------------------------------------------------------------- renewals become contracts
insert into contracts (customer_id, csid_id, start_date, end_date, status, title, type, counterparty_kind, supplier, description, value, currency, owner_id,
                       renewal_date, notice_days, extra_emails, notes, created_by, created_at, legacy_renewal_id)
select r.customer_id, r.csid_id, coalesce(r.start_date, r.created_at::date), r.expiry_date,
       case r.status when 'renewed' then 'active' when 'not_renewing' then 'closed' when 'expired' then 'expired' when 'overdue' then 'expiring_soon'
                     when 'in_progress' then 'renewal_in_progress' when 'awaiting_approval' then 'renewal_in_progress' else 'active' end,
       r.name,
       case r.kind when 'license' then 'Software licence' when 'subscription' then 'Subscription' when 'oem_support' then 'Support contract' when 'maintenance' then 'Maintenance contract'
                   when 'service_agreement' then 'Service agreement' when 'supply' then 'Supplier agreement' when 'lease' then 'Lease / rental' else 'Other' end,
       'customer', r.vendor,
       trim(both ' ' from concat_ws(E'\n', nullif('Reference: ' || r.reference, 'Reference: '), nullif('Quantity: ' || coalesce(r.quantity::text, ''), 'Quantity: '),
                                    nullif('Covers: ' || r.covered_assets, 'Covers: '), nullif('Decision: ' || r.decision, 'Decision: '), nullif('Approval: ' || r.approval_ref, 'Approval: '))),
       r.cost, coalesce(nullif(r.currency, ''), 'UGX'), r.owner_id, r.renewal_date, r.notice_days, r.extra_emails, r.notes, r.created_by, r.created_at, r.id
  from renewals r;
insert into contract_contacts (contract_id, user_id) select c.id, rc.user_id from renewal_contacts rc join contracts c on c.legacy_renewal_id = rc.renewal_id on conflict do nothing;
insert into contract_events (contract_id, actor_id, kind, text, created_at) select c.id, e.actor_id, e.kind, e.text, e.created_at from renewal_events e join contracts c on c.legacy_renewal_id = e.renewal_id;
update attachments a set contract_id = c.id from contracts c where c.legacy_renewal_id = a.renewal_id;
insert into service_contracts (service_id, contract_id, customer_id) select r.service_id, c.id, r.customer_id from renewals r join contracts c on c.legacy_renewal_id = r.id where r.service_id is not null on conflict do nothing;

-- ---------------------------------------------------------------- settings
insert into settings (key, value) values
  ('contract_types', '["Service agreement","Maintenance contract","Support contract","Supplier agreement","SLA","Software licence","Subscription","Lease / rental","Other"]'),
  ('tender_types', '["RFP","RFQ","RFI","EOI","Other"]'),
  ('opportunity_categories', '["Service","Solution","Product","Managed services","Other"]'),
  ('currencies', '["UGX","USD","EUR","GBP","KES","TZS"]'),
  ('departments', '["Sales","Technical","Finance","Legal","Operations"]'),
  ('pipeline_probabilities', '{"lead_identification":5,"prospecting":10,"qualification":25,"solution_development":40,"proposal_submission":60,"negotiation":75,"closing":90,"won":100,"lost":0,"on_hold":10}'),
  ('contract_reminder_days', '[90,60,30,14,7]'),
  ('tender_require_reviews', 'true')
on conflict (key) do nothing;
update settings set value = '"UGX"'::jsonb where key = 'default_currency' and value = '"USD"'::jsonb;

-- keep the CSID sequence ahead of any CSID already issued (older seed or imported data may have used numbers directly)
do $$
declare m bigint;
begin
  select coalesce(max(nullif(regexp_replace(csid, '\D', '', 'g'), '')::bigint), 0) into m from csids;
  if m > 0 and m >= (select last_value from csid_seq) then perform setval('csid_seq', m, true); end if;
end $$;
