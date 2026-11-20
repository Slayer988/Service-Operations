-- 017: requests without signing in. Someone at a customer can raise a ticket with no account, as long as their e-mail address is on
-- one of the customer's e-mail domains and they give the customer's CSID. They prove the address by typing a one-time code e-mailed to it.

-- the e-mail domains that belong to the customer, lower case, for example {"kcb.co.ug","kcb.com"}
alter table customers add column if not exists email_domains text[] not null default '{}';

-- a ticket raised this way (the requester's address was confirmed with a code); e-mailed replies from that same address are accepted
alter table tickets add column if not exists raised_by_guest boolean not null default false;

-- one-time codes. Only a keyed hash of the code is stored. A row is made only when the CSID and the domain match.
create table if not exists guest_codes (
  id bigserial primary key,
  email text not null,
  customer_id bigint not null references customers(id) on delete cascade,
  csid_id bigint not null references csids(id) on delete cascade,
  code_hash text not null,
  attempts int not null default 0,
  expires_at timestamptz not null,
  used_at timestamptz,
  ip text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists guest_codes_email_idx on guest_codes (email, created_at);
create index if not exists guest_codes_ip_idx on guest_codes (ip, created_at);

insert into settings (key, value) values ('guest_requests_enabled', 'true') on conflict (key) do nothing;
