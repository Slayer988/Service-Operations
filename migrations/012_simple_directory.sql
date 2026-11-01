-- 1.9.0: Active Directory is simplified. Roles are always set in the application (no group mapping), so every directory user
-- keeps the role they have now. Only imported people can sign in with their AD password; nobody is created at first sign-in.
update users set role_locked = true where auth_source = 'ldap';
