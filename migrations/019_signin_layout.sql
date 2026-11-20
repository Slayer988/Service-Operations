-- 019: the Midnight Dark theme is removed (people who chose it get Default), and an optional notice on the sign-in page.
update users set theme = 'default' where theme = 'midnight';
alter table users drop constraint if exists users_theme_check;
alter table users add constraint users_theme_check check (theme is null or theme in ('default','green','sunset','auto','ocean'));
-- The text shown under the sign-in fields with an "I agree" box (for example an authorised-use warning). Empty = no notice.
insert into settings (key, value) values ('login_notice', '""') on conflict (key) do nothing;
