-- 1.26.0: time on tickets, reply templates, automation rules, and ratings from the resolution e-mail.

-- time spent on tickets (feeds the timesheets now and invoicing later)
create table if not exists ticket_time (
  id         bigserial primary key,
  ticket_id  bigint not null references tickets(id) on delete cascade,
  user_id    bigint not null references users(id),
  work_date  date not null,
  minutes    int not null check (minutes between 1 and 1440),
  billable   boolean not null default true,
  note       text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists ticket_time_ticket on ticket_time (ticket_id);
create index if not exists ticket_time_user_date on ticket_time (user_id, work_date);
create index if not exists ticket_time_date on ticket_time (work_date);

-- reply templates: personal, or shared with the whole desk
create table if not exists reply_templates (
  id          bigserial primary key,
  title       text not null,
  body        text not null,
  category    text not null default '',
  shared      boolean not null default false,
  owner_id    bigint references users(id) on delete cascade,
  use_count   int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists reply_templates_owner on reply_templates (owner_id);

-- automation rules, applied in order when a ticket is created
create table if not exists automation_rules (
  id           bigserial primary key,
  name         text not null,
  active       boolean not null default true,
  position     int not null default 100,
  conditions   jsonb not null default '{}',
  actions      jsonb not null default '{}',
  stop         boolean not null default false,
  run_count    int not null default 0,
  last_run_at  timestamptz,
  created_by   bigint references users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

-- when and how a customer rated the ticket
alter table tickets add column if not exists satisfaction_at timestamptz;
alter table tickets add column if not exists satisfaction_via text not null default '';
