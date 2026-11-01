'use strict';
// The Administration page: everything that is set-up or oversight rather than daily work. Each tile appears only for people who may use it.
const perms = require('./perms');

function tiles(user) {
  if (!user || user.kind !== 'staff') return [];
  const can = (p) => perms.can(user, p);
  return [
    can('settings.manage') && { label: 'Settings', href: '/admin/settings', icon: 'settings', text: 'Business hours, SLA clocks, security, themes, currencies, contract and tender settings, reminders.' },
    can('user.manage') && { label: 'User management', href: '/admin/users', icon: 'user', text: 'Staff and customer accounts, roles, availability, password resets, and Active Directory (connect, import people, sign-in).' },
    can('audit.view') && { label: 'Audit log', href: '/audit', icon: 'log', text: 'Who did what, when, and from where.' },
    can('mail.view') && { label: 'E-mail', href: '/mail', icon: 'mail', text: 'Shared mailboxes that turn e-mail into tickets, their health, and the outgoing mail log.' },
    can('customer.view') && { label: 'Service catalogue', href: '/catalogue', icon: 'grid', text: can('catalogue.manage') ? 'The services you offer: add, edit, retire.' : 'The services we offer (view).' },
    can('ticket.view') && { label: 'SLA policies', href: '/sla', icon: 'clock', text: can('sla.configure') ? 'Response and resolution targets, calendars and holidays.' : 'Response and resolution targets, calendars and holidays (view).' },
  ].filter(Boolean);
}

module.exports = { tiles };
