-- 1.13.0: Knowledge Base. Articles written by staff; published articles are read by staff (internal) and by customers (audience 'customers').
-- Every save keeps a version; people can vote whether an article helped; articles can be linked to tickets.
create sequence kb_code_seq start 1;

create table kb_categories (
  id serial primary key,
  name text not null unique,
  sort_order int not null default 100
);

create table kb_articles (
  id bigserial primary key,
  code text not null unique default ('KB-' || lpad(nextval('kb_code_seq')::text, 4, '0')),
  title text not null,
  summary text not null default '',
  body text not null default '',
  category_id int references kb_categories(id) on delete set null,
  tags text not null default '',                                   -- space separated, lower case
  audience text not null default 'internal' check (audience in ('internal', 'customers')),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  author_id bigint references users(id) on delete set null,
  updated_by bigint references users(id) on delete set null,
  review_by date,
  published_at timestamptz,
  views int not null default 0,
  version int not null default 1,
  search tsvector,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index kb_articles_search_idx on kb_articles using gin (search);
create index kb_articles_status_idx on kb_articles (status, audience);

create function kb_articles_search_update() returns trigger as $$
begin
  new.search := setweight(to_tsvector('simple', coalesce(new.title, '')), 'A')
             || setweight(to_tsvector('simple', coalesce(new.summary, '') || ' ' || coalesce(new.tags, '')), 'B')
             || setweight(to_tsvector('simple', coalesce(new.body, '')), 'C');
  return new;
end $$ language plpgsql;
create trigger kb_articles_search_trg before insert or update of title, summary, tags, body on kb_articles
  for each row execute function kb_articles_search_update();

create table kb_article_versions (
  id bigserial primary key,
  article_id bigint not null references kb_articles(id) on delete cascade,
  version int not null,
  title text not null,
  summary text not null default '',
  body text not null default '',
  edited_by bigint references users(id) on delete set null,
  edited_at timestamptz not null default now(),
  note text not null default '',
  unique (article_id, version)
);

create table kb_votes (
  article_id bigint not null references kb_articles(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  helpful boolean not null,
  voted_at timestamptz not null default now(),
  primary key (article_id, user_id)
);

create table kb_ticket_links (
  article_id bigint not null references kb_articles(id) on delete cascade,
  ticket_id bigint not null references tickets(id) on delete cascade,
  linked_by bigint references users(id) on delete set null,
  linked_at timestamptz not null default now(),
  primary key (article_id, ticket_id)
);
create index kb_ticket_links_ticket_idx on kb_ticket_links (ticket_id);

insert into kb_categories (name, sort_order) values
  ('Getting started', 10), ('Accounts and passwords', 20), ('E-mail and calendar', 30), ('Network and VPN', 40),
  ('Devices and printing', 50), ('Security', 60), ('Procedures', 70), ('Troubleshooting', 80);
