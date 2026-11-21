-- 026: Invoicing (from contract payment schedules, accepted quotes and chargeable time), project budget versus actual, and supplier
-- performance (on-time delivery from the LPOs, and a quality rating when goods or services are received).

create sequence if not exists invoice_seq;

-- what is printed on an invoice to the customer
alter table customers add column if not exists billing_address text not null default '';
alter table customers add column if not exists tin text not null default '';
alter table customers add column if not exists billing_email text not null default '';
alter table customers add column if not exists hourly_rate numeric(14,2) check (hourly_rate is null or hourly_rate >= 0);

create table if not exists invoices (
  id bigserial primary key,
  ref text not null unique,                                    -- INV-000001
  customer_id bigint not null references customers(id),
  title text not null,
  status text not null default 'draft' check (status in ('draft','issued','part_paid','paid','cancelled')),
  currency text not null default 'UGX',
  issue_date date not null default current_date,
  due_date date,
  period_from date,                                            -- the period the invoice covers (time, a contract instalment), printed if set
  period_to date,
  customer_ref text not null default '',                       -- the customer's order number
  payment_terms text not null default '',
  terms text not null default '',                              -- printed (bank details come from Settings)
  internal_notes text not null default '',                     -- never printed
  tax_rate numeric(5,2) not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  tax_label text not null default 'VAT',
  subtotal numeric(16,2) not null default 0,
  discount_total numeric(16,2) not null default 0,
  tax_total numeric(16,2) not null default 0,
  total numeric(16,2) not null default 0,
  paid_total numeric(16,2) not null default 0,
  contract_id bigint references contracts(id),
  quote_id bigint references quotes(id),
  project_id bigint references projects(id),
  owner_id bigint not null references users(id),
  issued_by bigint references users(id),
  issued_at timestamptz,
  paid_at timestamptz,
  cancelled_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (period_from is null or period_to is null or period_to >= period_from),
  check (due_date is null or due_date >= issue_date)
);
create index if not exists invoices_customer_idx on invoices (customer_id);
create index if not exists invoices_status_idx on invoices (status);
create index if not exists invoices_project_idx on invoices (project_id);
create index if not exists invoices_quote_idx on invoices (quote_id);

create table if not exists invoice_lines (
  id bigserial primary key,
  invoice_id bigint not null references invoices(id) on delete cascade,
  position int not null,
  description text not null,
  quantity numeric(12,2) not null default 1 check (quantity > 0),
  unit text not null default '',
  unit_price numeric(14,2) not null default 0 check (unit_price >= 0),
  discount_pct numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100),
  line_total numeric(16,2) not null default 0
);
create index if not exists invoice_lines_idx on invoice_lines (invoice_id, position);

create table if not exists invoice_payments (
  id bigserial primary key,
  invoice_id bigint not null references invoices(id) on delete cascade,
  paid_on date not null,
  amount numeric(16,2) not null check (amount > 0),
  method text not null default 'bank' check (method in ('bank','mobile_money','cheque','cash','card','other')),
  reference text not null default '',
  note text not null default '',
  recorded_by bigint references users(id),
  created_at timestamptz not null default now()
);
create index if not exists invoice_payments_idx on invoice_payments (invoice_id);
create index if not exists invoice_payments_day_idx on invoice_payments (paid_on);

create table if not exists invoice_events (
  id bigserial primary key,
  invoice_id bigint not null references invoices(id) on delete cascade,
  actor_id bigint references users(id),
  text text not null,
  at timestamptz not null default now()
);
create index if not exists invoice_events_idx on invoice_events (invoice_id, id);

-- what has been billed: a contract instalment and a time entry are on one invoice at most (released if the invoice is cancelled)
alter table contract_payments add column if not exists invoice_id bigint references invoices(id) on delete set null;
alter table ticket_time add column if not exists invoice_id bigint references invoices(id) on delete set null;
create index if not exists contract_payments_invoice_idx on contract_payments (invoice_id);
create index if not exists ticket_time_invoice_idx on ticket_time (invoice_id);
create index if not exists ticket_time_unbilled_idx on ticket_time (ticket_id) where billable and invoice_id is null;

-- supplier performance: how good the goods or service were, recorded when the order is received
alter table purchase_orders add column if not exists quality smallint check (quality is null or quality between 1 and 5);
alter table purchase_orders add column if not exists quality_note text not null default '';

-- Settings, Invoices card
insert into settings (key, value) values
  ('invoice_terms', '"Payment within 30 days of the invoice date. Please quote the invoice number with your payment."'),
  ('invoice_due_days', '30'),
  ('invoice_bank_details', '""'),
  ('invoice_hourly_rate', '0')
on conflict (key) do nothing;
