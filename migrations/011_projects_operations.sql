-- 1.8.0: Projects module, the Operations Overview (weekly highlights), escalation of deals and non-chargeable tickets.

-- ---------------------------------------------------------------- projects
create sequence project_seq;
create table projects (
  id bigserial primary key,
  ref text not null unique default ('PRJ-' || lpad(nextval('project_seq')::text, 6, '0')),
  name text not null,
  customer_id bigint references customers(id),                 -- null for an internal project
  opportunity_id bigint references opportunities(id),          -- the won deal this project delivers, if any
  contract_id bigint references contracts(id),
  manager_id bigint not null references users(id),
  status text not null default 'planning' check (status in ('planning','active','on_hold','completed','cancelled')),
  health text not null default 'green' check (health in ('green','amber','red')),
  start_date date,
  end_date date,                                               -- planned end
  budget numeric(16,2) check (budget is null or budget >= 0),
  currency text not null default 'UGX',
  description text not null default '',
  status_note text not null default '',                        -- the latest status update, in a sentence or two
  escalated boolean not null default false,
  escalation_note text not null default '',
  closed_at timestamptz,                                       -- set when completed or cancelled
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (start_date is null or end_date is null or end_date >= start_date)
);
create index projects_status_idx on projects (status);
create index projects_customer_idx on projects (customer_id);
create index projects_manager_idx on projects (manager_id);

create table project_members (
  project_id bigint not null references projects(id) on delete cascade,
  user_id bigint not null references users(id),
  role text not null default '',
  added_at timestamptz not null default now(),
  primary key (project_id, user_id)
);
create index project_members_user_idx on project_members (user_id);

create table project_tasks (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  kind text not null default 'task' check (kind in ('task','milestone')),
  title text not null,
  assignee_id bigint references users(id),
  due_date date,
  status text not null default 'open' check (status in ('open','in_progress','done','cancelled')),
  done_at timestamptz,
  created_by bigint references users(id),
  created_at timestamptz not null default now()
);
create index project_tasks_project_idx on project_tasks (project_id);

create table project_events (
  id bigserial primary key,
  project_id bigint not null references projects(id) on delete cascade,
  actor_id bigint references users(id),
  kind text not null,
  text text not null,
  at timestamptz not null default now()
);
create index project_events_idx on project_events (project_id, id);

-- ---------------------------------------------------------------- escalation of deals
alter table opportunities
  add column escalated boolean not null default false,
  add column escalation_note text not null default '',
  add column escalated_at timestamptz,
  add column escalation_cleared_at timestamptz;

-- ---------------------------------------------------------------- non-chargeable support
alter table tickets add column non_chargeable boolean not null default false;

-- ---------------------------------------------------------------- weekly highlights (Operations Overview)
create table weekly_highlights (
  week_start date primary key,                                 -- the Monday
  top_presales text not null default '',
  major_delivery text not null default '',
  updated_by bigint references users(id),
  updated_at timestamptz not null default now()
);
