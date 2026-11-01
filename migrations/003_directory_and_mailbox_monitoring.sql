-- Active Directory sign-in and shared-mailbox monitoring.

-- Users can authenticate against the directory instead of a local password. Directory users are staff only.
alter table users
  add column auth_source text not null default 'local' check (auth_source in ('local', 'ldap')),
  add column ldap_dn text,
  add column directory_synced_at timestamptz;
alter table users add constraint users_ldap_staff_only check (auth_source = 'local' or kind = 'staff');
create unique index users_ldap_dn_uq on users (lower(ldap_dn)) where ldap_dn is not null;

-- Mailboxes: read by UID (so that a person opening mail in Outlook cannot hide it from us) and monitored for health.
alter table mailboxes
  add column imap_folder text not null default 'INBOX',
  add column last_uid bigint,
  add column uid_validity text,
  add column mark_seen boolean not null default false,
  add column consecutive_failures int not null default 0,
  add column last_success_at timestamptz,
  add column stale_minutes int not null default 15 check (stale_minutes between 2 and 1440),
  add column alert_state text not null default 'ok' check (alert_state in ('ok', 'alerted'));

insert into settings (key, value) values
  ('ldap', '{"enabled": false, "url": "", "starttls": false, "ca_file": "", "bind_dn": "", "bind_secret_env": "LDAP_BIND_PASSWORD",
             "base_dn": "", "user_filter": "(&(objectCategory=person)(objectClass=user)(|(userPrincipalName={{u}})(sAMAccountName={{u}})(mail={{u}})))",
             "email_attr": "mail", "name_attr": "displayName", "nested_groups": true, "group_mappings": []}'::jsonb)
on conflict (key) do nothing;
