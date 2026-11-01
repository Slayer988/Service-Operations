-- 1.7.0: a sixth theme, "Default" (the company colours), which is also what people see until they choose another.
-- Nobody's stored choice changes. Only the list of allowed values grows.
alter table users drop constraint if exists users_theme_check;
alter table users add constraint users_theme_check check (theme is null or theme in ('default','green','sunset','auto','ocean','midnight'));
