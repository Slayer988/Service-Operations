-- 020: Suppliers and contractors register, their documents (their quotes, our LPOs to them, registration papers), links to projects and
-- tenders, and purchase orders (LPOs) issued by the procurement team. Approval of purchase orders before issue is planned for later.

-- ---------------------------------------------------------------- the procurement role
alter table users drop constraint users_role_check;
alter table users add constraint users_role_check check (role in (
  'platform_admin','service_manager','contract_manager','agent','engineer','security_analyst','auditor',
  'management','bd_manager','bid_manager','technical_team','sde','finance','legal','dept_head','readonly','procurement',
  'customer_admin','customer_user'));

-- ---------------------------------------------------------------- register
create sequence if not exists supplier_seq;
create table if not exists suppliers (
  id bigserial primary key,
  code text not null unique,                                   -- SUP-0001
  name text not null,
  kind text not null default 'contractor' check (kind in ('contractor','subcontractor','distributor','vendor','consultant','third_party')),
  status text not null default 'active' check (status in ('active','on_hold','inactive')),
  services text not null default '',                           -- what they supply or do
  tin text not null default '',
  registration_no text not null default '',
  address text not null default '',
  phone text not null default '',
  email text not null default '',
  website text not null default '',
  contact_name text not null default '',
  contact_phone text not null default '',
  contact_email text not null default '',
  payment_terms text not null default '',
  notes text not null default '',
  created_by bigint references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists suppliers_name_idx on suppliers (lower(name));

create table if not exists supplier_events (
  id bigserial primary key,
  supplier_id bigint not null references suppliers(id) on delete cascade,
  actor_id bigint references users(id),
  text text not null,
  at timestamptz not null default now()
);
create index if not exists supplier_events_idx on supplier_events (supplier_id, id);

-- a supplier on a project or a tender, with what they do there
create table if not exists supplier_links (
  id bigserial primary key,
  supplier_id bigint not null references suppliers(id) on delete cascade,
  project_id bigint references projects(id) on delete cascade,
  tender_id bigint references tenders(id) on delete cascade,
  role text not null default '',
  added_by bigint references users(id),
  created_at timestamptz not null default now(),
  check (num_nonnulls(project_id, tender_id) = 1)
);
create unique index if not exists supplier_links_project_idx on supplier_links (supplier_id, project_id) where project_id is not null;
create unique index if not exists supplier_links_tender_idx on supplier_links (supplier_id, tender_id) where tender_id is not null;

-- ---------------------------------------------------------------- purchase orders (LPOs)
create sequence if not exists purchase_order_seq;
create table if not exists purchase_orders (
  id bigserial primary key,
  ref text not null unique,                                    -- LPO-000001
  supplier_id bigint not null references suppliers(id),
  title text not null,
  status text not null default 'draft' check (status in ('draft','issued','received','closed','cancelled')),
  currency text not null default 'UGX',
  issue_date date not null default current_date,
  delivery_date date,
  delivery_address text not null default '',
  payment_terms text not null default '',
  terms text not null default '',
  internal_notes text not null default '',
  tax_rate numeric(5,2) not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  tax_label text not null default 'VAT',
  subtotal numeric(16,2) not null default 0,
  discount_total numeric(16,2) not null default 0,
  tax_total numeric(16,2) not null default 0,
  total numeric(16,2) not null default 0,
  -- what the order is against (all optional): the supplier's quote, a contract, a project, a tender, our quote to a customer
  supplier_doc_id bigint,
  contract_id bigint references contracts(id),
  project_id bigint references projects(id),
  tender_id bigint references tenders(id),
  customer_quote_id bigint references quotes(id),
  owner_id bigint not null references users(id),
  issued_by bigint references users(id),
  issued_at timestamptz,
  received_at timestamptz,
  closed_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists purchase_orders_supplier_idx on purchase_orders (supplier_id);
create index if not exists purchase_orders_status_idx on purchase_orders (status);
create index if not exists purchase_orders_project_idx on purchase_orders (project_id);

create table if not exists purchase_order_lines (
  id bigserial primary key,
  purchase_order_id bigint not null references purchase_orders(id) on delete cascade,
  position int not null,
  description text not null,
  quantity numeric(12,2) not null default 1 check (quantity > 0),
  unit text not null default '',
  unit_price numeric(14,2) not null default 0 check (unit_price >= 0),
  discount_pct numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100),
  line_total numeric(16,2) not null default 0
);
create index if not exists purchase_order_lines_idx on purchase_order_lines (purchase_order_id, position);

create table if not exists purchase_order_events (
  id bigserial primary key,
  purchase_order_id bigint not null references purchase_orders(id) on delete cascade,
  actor_id bigint references users(id),
  text text not null,
  at timestamptz not null default now()
);
create index if not exists purchase_order_events_idx on purchase_order_events (purchase_order_id, id);

-- ---------------------------------------------------------------- documents: kept in attachments, described here
alter table attachments add column if not exists supplier_id bigint references suppliers(id);
alter table attachments add column if not exists purchase_order_id bigint references purchase_orders(id);
alter table attachments drop constraint if exists attachments_target;
alter table attachments add constraint attachments_target check (num_nonnulls(ticket_id, renewal_id, tender_id, contract_id, opportunity_id, supplier_id, purchase_order_id) >= 1);
create index if not exists attachments_supplier_idx on attachments (supplier_id);
create index if not exists attachments_po_idx on attachments (purchase_order_id);

-- what a supplier document is: their quote, an LPO we gave them (outside this system or signed), an invoice, a delivery note, papers
create table if not exists supplier_documents (
  id bigserial primary key,
  attachment_id bigint not null unique references attachments(id) on delete cascade,
  supplier_id bigint not null references suppliers(id) on delete cascade,
  kind text not null check (kind in ('quote','lpo','invoice','delivery_note','contract','registration','tax_clearance','other')),
  reference text not null default '',
  amount numeric(16,2),
  currency text not null default '',
  doc_date date,
  valid_until date,
  project_id bigint references projects(id) on delete set null,
  tender_id bigint references tenders(id) on delete set null,
  purchase_order_id bigint references purchase_orders(id) on delete set null,
  notes text not null default '',
  created_at timestamptz not null default now()
);
create index if not exists supplier_documents_supplier_idx on supplier_documents (supplier_id);
create index if not exists supplier_documents_project_idx on supplier_documents (project_id);
create index if not exists supplier_documents_tender_idx on supplier_documents (tender_id);

do $$ begin
  alter table purchase_orders add constraint purchase_orders_supplier_doc_fk foreign key (supplier_doc_id) references supplier_documents(id) on delete set null;
exception when duplicate_object then null; end $$;

insert into settings (key, value) values
  ('lpo_terms', '"Please quote the LPO number on your delivery note and invoice. Goods and services are accepted only against this order."'),
  ('lpo_delivery_address', '""')
on conflict (key) do nothing;
