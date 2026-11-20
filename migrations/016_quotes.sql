-- 016: Quotes. A priced quotation with line items, for a customer or a prospect, usually linked to an opportunity in the pipeline.
-- A quote is edited while it is a draft. Once sent it is fixed: a change is made as a new revision (QUO-000012 R2), and the old one
-- is kept as "superseded". An approval step before sending will be added later (status 'draft' -> 'sent' is the place for it).

create sequence if not exists quote_seq;

create table if not exists quotes (
  id bigserial primary key,
  ref text not null,                                           -- QUO-000012, shared by every revision of the same quote
  revision int not null default 1 check (revision >= 1),
  opportunity_id bigint references opportunities(id),
  customer_id bigint references customers(id),
  prospect text not null default '',                           -- an organisation that is not a customer yet
  contact_name text not null default '',
  contact_email text not null default '',
  title text not null,
  currency text not null default 'USD',
  status text not null default 'draft' check (status in ('draft','sent','accepted','rejected','expired','cancelled','superseded')),
  issue_date date not null default current_date,
  valid_until date,
  tax_rate numeric(5,2) not null default 0 check (tax_rate >= 0 and tax_rate <= 100),
  tax_label text not null default 'VAT',
  intro text not null default '',                              -- printed above the lines
  terms text not null default '',                              -- printed below the totals (payment terms, delivery, validity)
  internal_notes text not null default '',                     -- never printed
  subtotal numeric(16,2) not null default 0,                   -- after line discounts, before tax
  discount_total numeric(16,2) not null default 0,
  tax_total numeric(16,2) not null default 0,
  total numeric(16,2) not null default 0,
  owner_id bigint not null references users(id),
  created_by bigint references users(id),
  sent_at timestamptz,
  decided_at timestamptz,
  decision_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ref, revision),
  check (customer_id is not null or prospect <> '')
);
create index if not exists quotes_opportunity_idx on quotes (opportunity_id);
create index if not exists quotes_customer_idx on quotes (customer_id);
create index if not exists quotes_status_idx on quotes (status);

create table if not exists quote_lines (
  id bigserial primary key,
  quote_id bigint not null references quotes(id) on delete cascade,
  position int not null,
  description text not null,
  quantity numeric(12,2) not null default 1 check (quantity > 0),
  unit text not null default '',                               -- "each", "month", "user / month", "hour"
  unit_price numeric(14,2) not null default 0 check (unit_price >= 0),
  discount_pct numeric(5,2) not null default 0 check (discount_pct >= 0 and discount_pct <= 100),
  line_total numeric(16,2) not null default 0
);
create index if not exists quote_lines_quote_idx on quote_lines (quote_id, position);

create table if not exists quote_events (
  id bigserial primary key,
  quote_id bigint not null references quotes(id) on delete cascade,
  actor_id bigint references users(id),
  text text not null,
  at timestamptz not null default now()
);
create index if not exists quote_events_idx on quote_events (quote_id, id);

-- what is printed on every quote, and the defaults for a new one (Settings page, Quotes card)
insert into settings (key, value) values
  ('quote_company', '{"name": "", "address": "", "phone": "", "email": "", "website": "", "tax_id": ""}'),
  ('quote_tax_rate', '18'),
  ('quote_tax_label', '"VAT"'),
  ('quote_validity_days', '30'),
  ('quote_terms', '"Prices are valid until the date shown above. Payment within 30 days of invoice."')
on conflict (key) do nothing;
