-- 1.14.0: a mailbox password, client secret or service-account key can be typed on the E-mail page. It is stored encrypted
-- (lib/secrets.js, AES-256-GCM). The environment variable named in secret_env keeps working for mailboxes that already use one.
alter table mailboxes add column secret_enc text not null default '';
