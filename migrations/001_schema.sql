-- Service Operations (Ops): base schema.
-- Tenancy model: a "customer" is the tenant. Every customer-owned row carries customer_id, and composite
-- foreign keys make the database itself refuse a CSID/service/contract/site that belongs to another customer.

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);

create table customers (
  id bigserial primary key,
  name text not null unique,
  code text not null unique,
  status text not null default 'active' check (status in ('active','suspended')),
  notes text not null default '',
  created_at timestamptz not null default now()
);

create table users (
  id bigserial primary key,
  email text not null,
  name text not null,
  kind text not null check (kind in ('staff','customer')),
  role text not null check (role in ('platform_admin','service_manager','contract_manager','agent','engineer',
                                      'security_analyst','auditor','customer_admin','customer_user')),
  customer_id bigint references customers(id),
  password_hash text,
  active boolean not null default true,
  available boolean not null default true,
  failed_logins int not null default 0,
  locked_until timestamptz,
  totp_secret text,
  totp_enabled boolean not null default false,
  last_login_at timestamptz,
  password_changed_at timestamptz,
  created_at timestamptz not null default now(),
  check ((kind = 'customer') = (customer_id is not null)),
  check ((kind = 'customer' and role in ('customer_admin','customer_user'))
      or (kind = 'staff' and role not in ('customer_admin','customer_user')))
);
create unique index users_email_uq on users (lower(email));
create index users_customer_idx on users (customer_id);

create table sites (
  id bigserial primary key,
  customer_id bigint not null references customers(id),
  name text not null,
  address text not null default '',
  unique (customer_id, name),
  unique (id, customer_id)
);

create sequence csid_seq start 1;
create table csids (
  id bigserial primary key,
  csid text not null unique,
  customer_id bigint not null references customers(id),
  description text not null default '',
  status text not null default 'active' check (status in ('active','suspended','ended')),
  created_at timestamptz not null default now(),
  unique (id, customer_id)
);
create index csids_customer_idx on csids (customer_id);

create table calendars (
  id bigserial primary key,
  name text not null unique,
  timezone text not null,
  -- {"1":[["08:00","17:00"]], ... "7":[]}  keys are ISO weekdays (1 = Monday). "24:00" is allowed as an end time.
  schedule jsonb not null
);
create table holidays (
  calendar_id bigint not null references calendars(id) on delete cascade,
  day date not null,
  name text not null default '',
  primary key (calendar_id, day)
);

create table sla_policies (
  id bigserial primary key,
  name text not null unique,
  description text not null default '',
  calendar_id bigint not null references calendars(id),
  active boolean not null default true
);
create table sla_targets (
  policy_id bigint not null references sla_policies(id) on delete cascade,
  priority int not null check (priority between 1 and 4),
  response_min int not null check (response_min > 0),
  restoration_min int not null check (restoration_min > 0),
  resolution_min int not null check (resolution_min > 0),
  primary key (policy_id, priority)
);

create table contracts (
  id bigserial primary key,
  customer_id bigint not null references customers(id),
  reference text not null,
  csid_id bigint,
  start_date date not null,
  end_date date,
  sla_policy_id bigint not null references sla_policies(id),
  status text not null default 'active' check (status in ('draft','active','expired','terminated')),
  exclusions text not null default '',
  notes text not null default '',
  created_at timestamptz not null default now(),
  unique (customer_id, reference),
  unique (id, customer_id),
  foreign key (csid_id, customer_id) references csids (id, customer_id)
);

create table services (
  id bigserial primary key,
  csid_id bigint not null,
  customer_id bigint not null,
  service_type text not null,
  name text not null,
  description text not null default '',
  status text not null default 'active' check (status in ('active','suspended','ended')),
  start_date date,
  end_date date,
  owner_id bigint references users(id),
  contract_id bigint,
  sla_policy_id bigint references sla_policies(id),
  site_id bigint,
  created_at timestamptz not null default now(),
  unique (id, customer_id),
  unique (id, csid_id, customer_id),
  foreign key (csid_id, customer_id) references csids (id, customer_id),
  foreign key (contract_id, customer_id) references contracts (id, customer_id),
  foreign key (site_id, customer_id) references sites (id, customer_id)
);
create index services_csid_idx on services (csid_id);

-- Execution engineer per contract or service. A row is current while today is inside its effective dates.
-- Reassignment closes the old row and inserts a new one, so this table is also the assignment history (SLA-014).
create table engineer_assignments (
  id bigserial primary key,
  entity text not null check (entity in ('service','contract')),
  service_id bigint references services(id),
  contract_id bigint references contracts(id),
  engineer_id bigint not null references users(id),
  backup_id bigint references users(id),
  effective_from date not null default current_date,
  effective_to date,
  reason text not null default '',
  changed_by bigint references users(id),
  created_at timestamptz not null default now(),
  check ((entity = 'service' and service_id is not null and contract_id is null)
      or (entity = 'contract' and contract_id is not null and service_id is null))
);
create index engineer_assignments_service_idx on engineer_assignments (service_id);
create index engineer_assignments_contract_idx on engineer_assignments (contract_id);

create table mailboxes (
  id bigserial primary key,
  key text not null unique check (key in ('security','services')),
  address text not null,
  queue text not null check (queue in ('it_services','security')),
  category text not null,
  default_priority int not null default 3 check (default_priority between 1 and 4),
  tier text not null default 'l1' check (tier in ('l1','l2','l3')),
  sla_policy_id bigint references sla_policies(id),
  imap_host text not null default '',
  imap_port int not null default 993,
  imap_tls boolean not null default true,
  imap_user text not null default '',
  secret_env text not null default '',        -- NAME of the environment variable holding the password
  poll_seconds int not null default 60,
  max_attachment_mb int not null default 10,
  enabled boolean not null default false,
  last_sync_at timestamptz,
  last_status text not null default 'never run',
  last_error text not null default '',
  created_at timestamptz not null default now()
);

create sequence ticket_seq start 1;
create table tickets (
  id bigserial primary key,
  ref text not null unique,
  type text not null check (type in ('incident','request')),
  queue text not null default 'it_services' check (queue in ('it_services','security')),
  tier text not null default 'l1' check (tier in ('l1','l2','l3')),
  customer_id bigint references customers(id),
  csid_id bigint,
  service_id bigint,
  contract_id bigint,
  site_id bigint,
  requester_id bigint references users(id),
  requester_email text not null default '',
  requester_name text not null default '',
  subject text not null,
  description text not null default '',
  category text not null default '',
  impact int not null default 2 check (impact between 1 and 3),
  urgency int not null default 2 check (urgency between 1 and 3),
  priority int not null check (priority between 1 and 4),
  status text not null default 'new' check (status in
    ('new','open','in_progress','pending_customer','pending_vendor','restored','resolved','closed','cancelled')),
  assignee_id bigint references users(id),
  exec_engineer_id bigint references users(id),
  source text not null check (source in ('portal','agent','email','api')),
  mailbox_id bigint references mailboxes(id),
  sla_policy_id bigint references sla_policies(id),
  response_due timestamptz,
  restoration_due timestamptz,
  resolution_due timestamptz,
  responded_at timestamptz,
  restored_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  paused_at timestamptz,
  pause_reason text,
  sla_remaining jsonb,
  sla_flags jsonb not null default '{}'::jsonb,
  breach_cause text not null default '',
  breach_action text not null default '',
  resolution_code text not null default '',
  resolution_note text not null default '',
  satisfaction int check (satisfaction between 1 and 5),
  satisfaction_comment text not null default '',
  needs_verification boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (csid_id, customer_id) references csids (id, customer_id),
  foreign key (service_id, csid_id, customer_id) references services (id, csid_id, customer_id),
  foreign key (contract_id, customer_id) references contracts (id, customer_id),
  foreign key (site_id, customer_id) references sites (id, customer_id),
  check (customer_id is not null or needs_verification),
  check (service_id is null or (csid_id is not null and customer_id is not null))
);
create index tickets_customer_idx on tickets (customer_id, status);
create index tickets_status_idx on tickets (status, priority);
create index tickets_assignee_idx on tickets (assignee_id);
create index tickets_requester_idx on tickets (requester_id);

create table ticket_comments (
  id bigserial primary key,
  ticket_id bigint not null references tickets(id),
  author_id bigint references users(id),
  author_label text not null default '',
  body text not null,
  internal boolean not null default false,
  source text not null default 'portal' check (source in ('portal','agent','email','system')),
  message_id text,
  created_at timestamptz not null default now()
);
create index ticket_comments_ticket_idx on ticket_comments (ticket_id, created_at);

create table ticket_events (
  id bigserial primary key,
  ticket_id bigint not null references tickets(id),
  actor_id bigint references users(id),
  kind text not null,
  text text not null default '',
  internal boolean not null default false,
  created_at timestamptz not null default now()
);
create index ticket_events_ticket_idx on ticket_events (ticket_id, created_at);

create table renewals (
  id bigserial primary key,
  customer_id bigint not null references customers(id),
  csid_id bigint,
  service_id bigint,
  contract_id bigint,
  kind text not null default 'license' check (kind in ('license','subscription','oem_support','maintenance','other')),
  name text not null,
  vendor text not null default '',
  reference text not null default '',
  quantity int,
  start_date date,
  expiry_date date not null,
  renewal_date date,
  notice_days int not null default 60,
  cost numeric(14,2),
  currency text not null default '',
  covered_assets text not null default '',
  owner_id bigint not null references users(id),
  extra_emails text[] not null default '{}',
  status text not null default 'upcoming' check (status in
    ('upcoming','owner_notified','in_progress','awaiting_approval','renewed','not_renewing','expired','overdue')),
  acknowledged_at timestamptz,
  acknowledged_by bigint references users(id),
  decision text not null default '',
  approval_ref text not null default '',
  notes text not null default '',
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (csid_id, customer_id) references csids (id, customer_id),
  foreign key (service_id, customer_id) references services (id, customer_id),
  foreign key (contract_id, customer_id) references contracts (id, customer_id)
);
create index renewals_expiry_idx on renewals (expiry_date);
create table renewal_contacts (
  renewal_id bigint not null references renewals(id) on delete cascade,
  user_id bigint not null references users(id),
  primary key (renewal_id, user_id)
);
create table renewal_events (
  id bigserial primary key,
  renewal_id bigint not null references renewals(id),
  actor_id bigint references users(id),
  kind text not null,
  text text not null default '',
  created_at timestamptz not null default now()
);

create table attachments (
  id bigserial primary key,
  ticket_id bigint references tickets(id),
  renewal_id bigint references renewals(id),
  customer_id bigint references customers(id),
  filename text not null,
  mime text not null default 'application/octet-stream',
  size_bytes bigint not null,
  sha256 text not null,
  storage_name text not null unique,
  scan_status text not null default 'not_scanned' check (scan_status in ('clean','infected','not_scanned','rejected')),
  uploaded_by bigint references users(id),
  created_at timestamptz not null default now(),
  check (ticket_id is not null or renewal_id is not null)
);
create index attachments_ticket_idx on attachments (ticket_id);

create table notifications (
  id bigserial primary key,
  kind text not null,
  ticket_id bigint references tickets(id),
  renewal_id bigint references renewals(id),
  recipient_user_id bigint references users(id),
  recipient_email text not null,
  subject text not null,
  body text not null,
  status text not null default 'pending' check (status in ('pending','sent','failed','cancelled')),
  attempts int not null default 0,
  max_attempts int not null default 5,
  next_attempt_at timestamptz not null default now(),
  last_error text not null default '',
  message_id text,
  in_reply_to text,
  reply_to text,
  dedupe_key text unique,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notifications_due_idx on notifications (status, next_attempt_at);
create index notifications_ticket_idx on notifications (ticket_id);
create index notifications_message_idx on notifications (message_id);

create table inbound_messages (
  id bigserial primary key,
  mailbox_id bigint not null references mailboxes(id),
  provider_message_id text not null,
  imap_uid bigint,
  from_addr text not null default '',
  from_name text not null default '',
  to_addr text not null default '',
  subject text not null default '',
  sent_at timestamptz,
  received_at timestamptz not null default now(),
  headers jsonb not null default '{}'::jsonb,
  raw_name text,
  outcome text not null default 'pending' check (outcome in
    ('pending','ticket_created','reply_appended','verification','ignored','rejected','failed')),
  ticket_id bigint references tickets(id),
  detail text not null default '',
  attempts int not null default 0,
  processed_at timestamptz,
  unique (mailbox_id, provider_message_id)
);
create index inbound_messages_outcome_idx on inbound_messages (outcome);

create table audit_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  actor_id bigint,
  actor_email text not null default '',
  action text not null,
  entity text not null default '',
  entity_id text not null default '',
  customer_id bigint,
  detail text not null default '',
  ip text not null default ''
);
create index audit_log_at_idx on audit_log (at desc);

-- Express session store (connect-pg-simple)
create table session (
  sid varchar not null primary key,
  sess json not null,
  expire timestamp(6) not null
);
create index session_expire_idx on session (expire);
