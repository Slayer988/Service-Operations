-- 1.25.0: problem management, change management and service notices (major incidents, planned maintenance, the customer status page).

-- ---------------------------------------------------------------- problems: the cause behind one or more incidents
create sequence if not exists problem_seq start 1;
create table if not exists problems (
  id              bigserial primary key,
  ref             text not null unique default ('PRB-' || lpad(nextval('problem_seq')::text, 6, '0')),
  title           text not null,
  description     text not null default '',
  status          text not null default 'open' check (status in ('open','investigating','known_error','resolved','closed')),
  priority        int not null default 3 check (priority between 1 and 4),
  customer_id     bigint references customers(id),
  owner_id        bigint references users(id),
  root_cause      text not null default '',
  workaround      text not null default '',
  permanent_fix   text not null default '',
  kb_article_id   bigint references kb_articles(id) on delete set null,
  created_by      bigint references users(id),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  resolved_at     timestamptz,
  closed_at       timestamptz
);
create index if not exists problems_status on problems (status);
create table if not exists problem_tickets (
  problem_id bigint not null references problems(id) on delete cascade,
  ticket_id  bigint not null references tickets(id) on delete cascade,
  linked_by  bigint references users(id),
  linked_at  timestamptz not null default now(),
  primary key (problem_id, ticket_id)
);
create index if not exists problem_tickets_ticket on problem_tickets (ticket_id);
create table if not exists problem_assets (
  problem_id bigint not null references problems(id) on delete cascade,
  asset_id   bigint not null references assets(id) on delete cascade,
  primary key (problem_id, asset_id)
);
create table if not exists problem_events (
  id bigserial primary key, problem_id bigint not null references problems(id) on delete cascade,
  actor_id bigint references users(id), text text not null, at timestamptz not null default now()
);

-- ---------------------------------------------------------------- changes: planned work on live services, approved before it is scheduled
create sequence if not exists change_seq start 1;
create table if not exists changes (
  id                   bigserial primary key,
  ref                  text not null unique default ('CHG-' || lpad(nextval('change_seq')::text, 6, '0')),
  title                text not null,
  description          text not null default '',
  type                 text not null default 'normal' check (type in ('standard','normal','emergency')),
  risk                 text not null default 'medium' check (risk in ('low','medium','high')),
  status               text not null default 'draft' check (status in ('draft','scheduled','in_progress','completed','failed','cancelled')),
  customer_id          bigint references customers(id),
  problem_id           bigint references problems(id) on delete set null,
  owner_id             bigint references users(id),
  implementer_id       bigint references users(id),
  impact               text not null default '',
  implementation_plan  text not null default '',
  backout_plan         text not null default '',
  test_plan            text not null default '',
  planned_start        timestamptz,
  planned_end          timestamptz,
  actual_start         timestamptz,
  actual_end           timestamptz,
  outcome              text not null default '',
  created_by           bigint references users(id),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  check (planned_end is null or planned_start is null or planned_end > planned_start)
);
create index if not exists changes_window on changes (planned_start, planned_end) where status in ('scheduled','in_progress');
create index if not exists changes_status on changes (status);
create table if not exists change_assets (
  change_id bigint not null references changes(id) on delete cascade,
  asset_id  bigint not null references assets(id) on delete cascade,
  primary key (change_id, asset_id)
);
create index if not exists change_assets_asset on change_assets (asset_id);
create table if not exists change_tickets (
  change_id bigint not null references changes(id) on delete cascade,
  ticket_id bigint not null references tickets(id) on delete cascade,
  primary key (change_id, ticket_id)
);
create table if not exists change_events (
  id bigserial primary key, change_id bigint not null references changes(id) on delete cascade,
  actor_id bigint references users(id), text text not null, at timestamptz not null default now()
);

-- changes are approved through the same approvals as quotes and purchase orders
alter table approvals drop constraint if exists approvals_entity_check;
alter table approvals add constraint approvals_entity_check check (entity in ('quote', 'lpo', 'change'));

-- ---------------------------------------------------------------- service notices: major incidents and planned maintenance, shown to the customers affected
create sequence if not exists notice_seq start 1;
create table if not exists notices (
  id             bigserial primary key,
  ref            text not null unique default ('NTC-' || lpad(nextval('notice_seq')::text, 6, '0')),
  kind           text not null check (kind in ('incident','maintenance')),
  title          text not null,
  severity       text not null default 'degraded' check (severity in ('outage','degraded','info')),
  status         text not null check (status in ('investigating','identified','monitoring','resolved','scheduled','in_progress','completed','cancelled')),
  all_customers  boolean not null default false,
  customer_ids   bigint[] not null default '{}',
  ticket_id      bigint references tickets(id) on delete set null,
  change_id      bigint references changes(id) on delete set null,
  starts_at      timestamptz not null default now(),
  ends_at        timestamptz,
  created_by     bigint references users(id),
  created_at     timestamptz not null default now(),
  closed_at      timestamptz
);
create index if not exists notices_open on notices (status) where closed_at is null;
create table if not exists notice_updates (
  id bigserial primary key, notice_id bigint not null references notices(id) on delete cascade,
  status text not null, text text not null, emailed int not null default 0,
  created_by bigint references users(id), at timestamptz not null default now()
);
create index if not exists notice_updates_notice on notice_updates (notice_id, at);
