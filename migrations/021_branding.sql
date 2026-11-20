-- 021: the company logo, kept in the database (so it is in every backup and both the web and the worker can read it).
-- The company name is the existing quote_company.name setting, now edited on the Settings page under "Company branding".
create table if not exists branding_assets (
  id int primary key check (id = 1),
  mime text not null check (mime in ('image/png','image/jpeg')),
  data bytea not null,
  width int not null,
  height int not null,
  sha256 text not null,
  updated_by bigint references users(id),
  updated_at timestamptz not null default now()
);
