-- 1.6.0: only five themes remain (Service Green, Sunset Orange, Match Device, Ocean Blue, Midnight Dark).
-- Anyone who had chosen a removed theme goes back to the default; the organisation-wide default setting is no longer used.
update users set theme = null where theme in ('violet', 'slate');
alter table users drop constraint if exists users_theme_check;
alter table users add constraint users_theme_check check (theme is null or theme in ('green','sunset','auto','ocean','midnight'));
delete from settings where key = 'default_theme';
