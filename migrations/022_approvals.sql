-- 1.23.0: approval before a quote is sent or a purchase order is issued.
-- One row per request: who asked, which level (1, or 2 for a second approver on large amounts), who may decide, and the decision.
-- A change to the quote or order after approval withdraws its approvals (status 'withdrawn'), so what was approved is what goes out.
create table if not exists approvals (
  id            bigserial primary key,
  entity        text not null check (entity in ('quote', 'lpo')),
  entity_id     bigint not null,
  level         int not null default 1 check (level in (1, 2)),
  roles         text[] not null,
  reasons       text not null default '',
  amount        numeric(16, 2) not null default 0,
  currency      text not null default '',
  requested_by  bigint not null references users(id),
  requested_at  timestamptz not null default now(),
  status        text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn')),
  decided_by    bigint references users(id),
  decided_at    timestamptz,
  comment       text not null default ''
);
create index if not exists approvals_entity on approvals (entity, entity_id);
create index if not exists approvals_pending on approvals (status) where status = 'pending';
