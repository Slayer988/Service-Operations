-- Up to five shared mailboxes, each read through IMAP, Microsoft 365 (Graph) or Google Workspace (Gmail API).

alter table mailboxes drop constraint mailboxes_key_check;
alter table mailboxes add constraint mailboxes_key_slug check (key ~ '^[a-z][a-z0-9_]{1,29}$');

alter table mailboxes
  add column name text not null default '',
  add column provider text not null default 'imap' check (provider in ('imap', 'graph', 'gmail')),
  add column tenant_id text not null default '',          -- Microsoft 365: directory (tenant) ID or domain
  add column client_id text not null default '',          -- Microsoft 365: application (client) ID
  add column last_received_at timestamptz;                -- Graph / Gmail: time of the newest message handled

update mailboxes set name = case key when 'security' then 'Security' when 'services' then 'IT Services' else key end;
alter table mailboxes add constraint mailboxes_name_set check (name <> '');
create unique index mailboxes_address_uq on mailboxes (lower(address));

create function enforce_mailbox_limit() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(727005);
  if (select count(*) from mailboxes) >= 5 then
    raise exception 'At most 5 shared mailboxes are supported.' using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger mailboxes_limit before insert on mailboxes for each row execute function enforce_mailbox_limit();
