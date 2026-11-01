-- 1.5.0: a role assigned in the application takes precedence over the role from AD groups.
-- role_locked = true means the role was chosen in the application (Users page, or the account was created there for a directory sign-in);
-- the directory then only proves who the person is and never changes the role.
alter table users add column role_locked boolean not null default false;
