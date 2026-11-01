-- 1.4.0: each person can choose a colour theme; null means "use the organisation default" (setting default_theme).
alter table users add column theme text check (theme is null or theme in ('green','ocean','violet','sunset','slate','midnight','auto'));
