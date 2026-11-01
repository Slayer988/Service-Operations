-- Default configuration. Targets below are ILLUSTRATIVE placeholders: the specification requires that
-- real response / restoration / resolution targets come from approved contracts. Edit them in the application.

insert into settings (key, value) values
 ('priority_matrix', '{"1":{"1":1,"2":2,"3":3},"2":{"1":2,"2":3,"3":4},"3":{"1":3,"2":4,"3":4}}'),
 ('categories', '["Network","Server","Storage","Security","Email","Access and accounts","Software","Hardware","Printer","Other"]'),
 ('resolution_codes', '["fixed","workaround","no_fault_found","vendor_fix","customer_action","duplicate","cancelled"]'),
 ('sla_pause_statuses', '["pending_customer"]'),
 ('reopen_window_days', '5'),
 ('auto_close_days', '3'),
 ('allow_multiple_csids_per_customer', 'true'),
 ('mfa_required_roles', '["platform_admin"]'),
 ('attachment_blocked_ext', '["exe","bat","cmd","com","scr","js","jse","vbs","vbe","wsf","msi","ps1","jar","dll","lnk","hta","reg","iso"]'),
 ('attachment_max_mb', '10'),
 ('renewal_reminders', '{"default":[180,120,90,60,30,7]}'),
 ('renewal_escalate_unacked_days', '30'),
 ('sla_warn_percent', '20'),
 ('email_ack_per_sender_per_hour', '3'),
 ('default_sla_policy', 'null');

insert into calendars (name, timezone, schedule) values
 ('24x7',  'Africa/Nairobi', '{"1":[["00:00","24:00"]],"2":[["00:00","24:00"]],"3":[["00:00","24:00"]],"4":[["00:00","24:00"]],"5":[["00:00","24:00"]],"6":[["00:00","24:00"]],"7":[["00:00","24:00"]]}'),
 ('12x5',  'Africa/Nairobi', '{"1":[["07:00","19:00"]],"2":[["07:00","19:00"]],"3":[["07:00","19:00"]],"4":[["07:00","19:00"]],"5":[["07:00","19:00"]],"6":[],"7":[]}'),
 ('8x5',   'Africa/Nairobi', '{"1":[["08:00","17:00"]],"2":[["08:00","17:00"]],"3":[["08:00","17:00"]],"4":[["08:00","17:00"]],"5":[["08:00","17:00"]],"6":[],"7":[]}');

insert into sla_policies (name, description, calendar_id) values
 ('Platinum 24x7', 'Illustrative placeholder targets - replace with contract values', (select id from calendars where name = '24x7')),
 ('Gold 12x5',     'Illustrative placeholder targets - replace with contract values', (select id from calendars where name = '12x5')),
 ('Standard 8x5',  'Illustrative placeholder targets - replace with contract values', (select id from calendars where name = '8x5'));

-- minutes of supported time (calendar-aware): response / restoration / resolution
insert into sla_targets (policy_id, priority, response_min, restoration_min, resolution_min)
select p.id, t.priority, t.r, t.s, t.l
from sla_policies p
join (values
  ('Platinum 24x7', 1, 15, 240, 480),   ('Platinum 24x7', 2, 30, 480, 1440),
  ('Platinum 24x7', 3, 120, 1440, 2880), ('Platinum 24x7', 4, 480, 2880, 5760),
  ('Gold 12x5', 1, 30, 240, 480),       ('Gold 12x5', 2, 60, 480, 960),
  ('Gold 12x5', 3, 240, 960, 1920),     ('Gold 12x5', 4, 480, 1920, 3840),
  ('Standard 8x5', 1, 60, 240, 480),    ('Standard 8x5', 2, 120, 480, 960),
  ('Standard 8x5', 3, 240, 960, 1920),  ('Standard 8x5', 4, 480, 1920, 3840)
) as t(pname, priority, r, s, l) on t.pname = p.name;

update settings set value = to_jsonb((select id from sla_policies where name = 'Standard 8x5')) where key = 'default_sla_policy';

insert into mailboxes (key, address, queue, category, default_priority, sla_policy_id) values
 ('security', 'security@example.com',    'security',    'Security',    2, (select id from sla_policies where name = 'Gold 12x5')),
 ('services', 'itservices@example.com',  'it_services', 'IT Services', 3, (select id from sla_policies where name = 'Standard 8x5'));
