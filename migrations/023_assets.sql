-- 1.24.0: asset register (CMDB). The equipment, licences and subscriptions at each customer site (or our own, with no customer),
-- linked to the CSID and contract that cover them, the supplier and purchase order they came from, and the tickets about them.
create sequence if not exists asset_seq start 1;
create table if not exists assets (
  id                 bigserial primary key,
  tag                text not null unique default ('AST-' || lpad(nextval('asset_seq')::text, 6, '0')),
  name               text not null,
  category           text not null check (category in ('network','security','server','storage','end_user','printer','phone','power','software','cloud','other')),
  status             text not null default 'active' check (status in ('in_stock','active','under_repair','retired','disposed')),
  customer_id        bigint references customers(id),
  site_id            bigint references sites(id),
  csid_id            bigint references csids(id),
  contract_id        bigint references contracts(id) on delete set null,
  supplier_id        bigint references suppliers(id) on delete set null,
  purchase_order_id  bigint references purchase_orders(id) on delete set null,
  manufacturer       text not null default '',
  model              text not null default '',
  serial_number      text not null default '',
  hostname           text not null default '',
  ip_address         text not null default '',
  quantity           int not null default 1 check (quantity >= 1),
  purchase_date      date,
  warranty_until     date,
  expires_on         date,
  owner_contact      text not null default '',
  notes              text not null default '',
  created_by         bigint references users(id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index if not exists assets_customer on assets (customer_id);
create index if not exists assets_csid on assets (csid_id);
create index if not exists assets_contract on assets (contract_id);
create index if not exists assets_warranty on assets (warranty_until) where status in ('active','in_stock','under_repair');
create index if not exists assets_expires on assets (expires_on) where status in ('active','in_stock','under_repair');
create index if not exists assets_serial on assets (lower(serial_number)) where serial_number <> '';

create table if not exists asset_events (
  id        bigserial primary key,
  asset_id  bigint not null references assets(id) on delete cascade,
  actor_id  bigint references users(id),
  text      text not null,
  at        timestamptz not null default now()
);
create index if not exists asset_events_asset on asset_events (asset_id, at);

create table if not exists ticket_assets (
  ticket_id  bigint not null references tickets(id) on delete cascade,
  asset_id   bigint not null references assets(id) on delete cascade,
  linked_by  bigint references users(id),
  linked_at  timestamptz not null default now(),
  primary key (ticket_id, asset_id)
);
create index if not exists ticket_assets_asset on ticket_assets (asset_id);
