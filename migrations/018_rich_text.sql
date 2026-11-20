-- 018: formatted text (bold, italic, underline, lists, headings, links ...) in ticket comments, internal notes and ticket descriptions.
-- 'rich' text is stored as a small, safe mark-up (the same as the Knowledge Base) and shown formatted; everything else, such as e-mail
-- that arrived as tickets or replies, stays 'text' and is shown exactly as it was written.
alter table ticket_comments add column if not exists format text not null default 'text';
alter table tickets add column if not exists description_format text not null default 'text';
do $$ begin
  alter table ticket_comments add constraint ticket_comments_format_chk check (format in ('text','rich'));
exception when duplicate_object then null; end $$;
do $$ begin
  alter table tickets add constraint tickets_description_format_chk check (description_format in ('text','rich'));
exception when duplicate_object then null; end $$;
