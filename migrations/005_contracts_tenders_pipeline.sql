-- Contracts (more kinds), Tender Management and the sales Pipeline.

alter table renewals drop constraint renewals_kind_check;
alter table renewals add constraint renewals_kind_check
  check (kind in ('license','subscription','oem_support','maintenance','service_agreement','supply','lease','other'));

-- ---------------------------------------------------------------- pipeline
create sequence opp_seq;
create table opportunities (
  id bigserial primary key,
  ref text not null unique default ('OPP-' || lpad(nextval('opp_seq')::text, 6, '0')),
  name text not null,
  customer_id bigint references customers(id),            -- an existing customer, or
  prospect text not null default '',                      -- the name of an organisation that is not a customer yet
  contact_name text not null default '',
  contact_email text not null default '',
  source text not null default '',
  stage text not null default 'lead' check (stage in ('lead','qualified','proposal','negotiation','won','lost')),
  value numeric(14,2) not null default 0 check (value >= 0),
  currency text not null default 'USD',
  probability int not null default 10 check (probability between 0 and 100),
  expected_close date,
  owner_id bigint not null references users(id),
  next_step text not null default '',
  next_step_date date,
  lost_reason text not null default '',
  closed_at timestamptz,
  notes text not null default '',
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (customer_id is not null or prospect <> '')
);
create index opportunities_stage_idx on opportunities (stage);
create index opportunities_owner_idx on opportunities (owner_id);
create table opportunity_events (
  id bigserial primary key,
  opportunity_id bigint not null references opportunities(id) on delete cascade,
  actor_id bigint references users(id),
  kind text not null,
  text text not null,
  at timestamptz not null default now()
);
create index opportunity_events_idx on opportunity_events (opportunity_id, id);

-- ---------------------------------------------------------------- tenders
create sequence tender_seq;
create table tenders (
  id bigserial primary key,
  ref text not null unique default ('TND-' || lpad(nextval('tender_seq')::text, 6, '0')),
  title text not null,
  issuer text not null,                                   -- the organisation that issued the tender
  customer_id bigint references customers(id),
  opportunity_id bigint references opportunities(id),
  tender_no text not null default '',                     -- the issuer's own reference
  source text not null default '',                        -- portal, newspaper, invitation ...
  category text not null default '',
  est_value numeric(14,2) check (est_value is null or est_value >= 0),
  currency text not null default 'USD',
  published_on date,
  clarification_due timestamptz,
  site_visit_at timestamptz,
  submission_due timestamptz not null,
  status text not null default 'identified' check (status in
    ('identified','reviewing','no_bid','preparing','submitted','won','lost','cancelled')),
  decision_score int check (decision_score between 0 and 100),
  decision_reason text not null default '',
  owner_id bigint not null references users(id),
  submitted_at timestamptz,
  outcome_note text not null default '',
  award_value numeric(14,2) check (award_value is null or award_value >= 0),
  notes text not null default '',
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index tenders_due_idx on tenders (submission_due);
create index tenders_status_idx on tenders (status);
create table tender_tasks (
  id bigserial primary key,
  tender_id bigint not null references tenders(id) on delete cascade,
  title text not null,
  assignee_id bigint references users(id),
  due_at timestamptz,
  done_at timestamptz,
  done_by bigint references users(id),
  created_at timestamptz not null default now()
);
create index tender_tasks_idx on tender_tasks (tender_id);
create table tender_events (
  id bigserial primary key,
  tender_id bigint not null references tenders(id) on delete cascade,
  actor_id bigint references users(id),
  kind text not null,
  text text not null,
  at timestamptz not null default now()
);
create index tender_events_idx on tender_events (tender_id, id);

alter table attachments add column tender_id bigint references tenders(id);
alter table attachments drop constraint attachments_check;
alter table attachments add constraint attachments_target check (ticket_id is not null or renewal_id is not null or tender_id is not null);
create index attachments_tender_idx on attachments (tender_id);
alter table notifications add column tender_id bigint references tenders(id);

insert into settings (key, value) values
  ('default_currency', '"USD"'::jsonb),
  ('tender_reminder_days', '[14,7,3,1]'::jsonb)
on conflict (key) do nothing;
