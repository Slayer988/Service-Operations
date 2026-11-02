-- 015: SLA breach history, forced first password change, one-time MFA codes, tamper-evident audit log, retention settings.

-- ---------------------------------------------------------------- SLA breach history
-- Which targets were ever missed on a ticket, and when: {"response": {"due": "...", "at": "..."}, "resolution": {...}}.
-- It is kept when a ticket is reopened or its priority changes, so a recalculated due date never hides an earlier breach.
alter table tickets add column if not exists sla_breaches jsonb not null default '{}'::jsonb;

update tickets t set sla_breaches = jsonb_strip_nulls(jsonb_build_object(
  'response', case when t.response_due is not null and (
        (t.responded_at is not null and t.responded_at > t.response_due) or (t.sla_flags->>'response_breached') = 'true')
      then jsonb_build_object('due', t.response_due, 'at', coalesce(t.responded_at, t.updated_at)) end,
  'restoration', case when t.restoration_due is not null and (
        (t.restored_at is not null and t.restored_at > t.restoration_due) or (t.sla_flags->>'restoration_breached') = 'true')
      then jsonb_build_object('due', t.restoration_due, 'at', coalesce(t.restored_at, t.updated_at)) end,
  'resolution', case when t.resolution_due is not null and (
        (t.resolved_at is not null and t.resolved_at > t.resolution_due) or (t.sla_flags->>'resolution_breached') = 'true')
      then jsonb_build_object('due', t.resolution_due, 'at', coalesce(t.resolved_at, t.updated_at)) end))
 where t.sla_breaches = '{}'::jsonb;

-- ---------------------------------------------------------------- sign-in
-- A password chosen by someone else (a new account, an administrator's reset) must be replaced at the first sign-in.
alter table users add column if not exists must_change_password boolean not null default false;
-- The time step of the last two-step code accepted, so a code cannot be used twice.
alter table users add column if not exists totp_last_step bigint;

-- ---------------------------------------------------------------- audit log: tamper evident
-- Every row carries the hash of the row before it. Changing, removing or inserting a row in the middle breaks the chain, and
-- audit_verify() finds the first row where it breaks. Rows cannot be updated or deleted by ordinary statements.
alter table audit_log add column if not exists chain_no bigint;
alter table audit_log add column if not exists prev_hash text not null default '';
alter table audit_log add column if not exists row_hash text not null default '';

create table if not exists audit_head (
  id int primary key check (id = 1),
  last_no bigint not null default 0,
  last_hash text not null default ''
);
insert into audit_head (id) values (1) on conflict do nothing;

create or replace function audit_digest(prev text, r audit_log) returns text language sql immutable as $$
  select encode(sha256(convert_to(concat_ws('|', prev, r.chain_no::text, r.id::text, to_char(r.at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US'),
    coalesce(r.actor_id::text, ''), r.actor_email, r.action, r.entity, r.entity_id, coalesce(r.customer_id::text, ''), r.detail, r.ip), 'UTF8')), 'hex')
$$;

-- Chain the rows that already exist, oldest first (the guard triggers are not installed yet).
do $$
declare r audit_log; prev text := ''; n bigint := 0;
begin
  for r in select * from audit_log where chain_no is null order by id loop
    n := n + 1;
    r.chain_no := n; r.prev_hash := prev;
    r.row_hash := audit_digest(prev, r);
    update audit_log set chain_no = r.chain_no, prev_hash = r.prev_hash, row_hash = r.row_hash where id = r.id;
    prev := r.row_hash;
  end loop;
  if n > 0 then update audit_head set last_no = n, last_hash = prev where id = 1; end if;
end $$;

create unique index if not exists audit_log_chain_idx on audit_log (chain_no);

create or replace function audit_chain() returns trigger language plpgsql as $$
declare h audit_head;
begin
  select * into h from audit_head where id = 1 for update;          -- one row at a time: the chain has no forks
  new.chain_no := h.last_no + 1;
  new.prev_hash := h.last_hash;
  new.row_hash := audit_digest(new.prev_hash, new);
  update audit_head set last_no = new.chain_no, last_hash = new.row_hash where id = 1;
  return new;
end $$;

create or replace function audit_guard() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('itsm.audit_purge', true), '') = 'on' then
    return old;                                                       -- only audit_purge() sets this, and only for old rows
  end if;
  raise exception 'The audit log cannot be changed or deleted.' using errcode = '42501';
end $$;

drop trigger if exists audit_chain_trg on audit_log;
create trigger audit_chain_trg before insert on audit_log for each row execute function audit_chain();
drop trigger if exists audit_guard_trg on audit_log;
create trigger audit_guard_trg before update or delete on audit_log for each row execute function audit_guard();
drop trigger if exists audit_guard_truncate_trg on audit_log;
create trigger audit_guard_truncate_trg before truncate on audit_log for each statement execute function audit_guard();

-- Walks the chain. Returns null when it is intact, otherwise the id of the first row that does not match
-- (-1 when the newest rows are missing).
create or replace function audit_verify() returns bigint language plpgsql as $$
declare r audit_log; prev text := null; h audit_head;
begin
  for r in select * from audit_log order by chain_no loop
    if prev is not null and r.prev_hash <> prev then return r.id; end if;
    if r.row_hash <> audit_digest(r.prev_hash, r) then return r.id; end if;
    prev := r.row_hash;
  end loop;
  select * into h from audit_head where id = 1;
  if prev is not null and prev <> h.last_hash then return -1; end if;
  return null;
end $$;

-- The one sanctioned way to remove old rows (the retention setting). It keeps the chain checkable: the oldest remaining row
-- becomes the start of the chain. Returns how many rows were removed.
create or replace function audit_purge(keep interval) returns bigint language plpgsql as $$
declare n bigint;
begin
  perform set_config('itsm.audit_purge', 'on', true);
  delete from audit_log where at < now() - keep;
  get diagnostics n = row_count;
  perform set_config('itsm.audit_purge', '', true);
  return n;
end $$;

-- ---------------------------------------------------------------- retention (0 = keep for ever)
insert into settings (key, value) values
  ('retention_notification_days', '365'),
  ('retention_audit_years', '0'),
  ('retention_ticket_years', '0')
on conflict (key) do nothing;
