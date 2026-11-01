'use strict';
// The User Manual (opened from the "?" icon). The text lives here as plain data so it can be tested; the view only lays it out.
// Everyone sees the sections that apply to them: a customer sees the portal, staff see the modules their role may use.
// The "who can do what" table is built from the real permission table (lib/perms.js), so it cannot disagree with the application.
const perms = require('./perms');
const { THEMES } = require('./themes');
const config = require('../config');

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
/** Escapes the text, then turns **word** into bold. Nothing else is allowed through. */
const inline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

// Block types: { p }, { h }, { steps: [] }, { list: [] }, { tip }, { table: { head: [], rows: [[]] } }, { access: [perm names] }
// Section: { id, title, who: 'all' | 'staff' | 'customer', perm?, role?, intro?, blocks }

function sections(user) {
  const staff = !(user && user.kind === 'customer');
  const themeRows = THEMES.map((t) => [t.label, t.text]);
  return [
    {
      id: 'start', title: 'Getting started', who: 'all',
      intro: staff ? 'Service Operations (Ops) is where service requests, incidents, contracts, tenders, deals and projects are handled in one place.' : 'Service Operations (Ops) is where you ask for help, follow your requests and see the services you receive.',
      blocks: [
        { h: 'Signing in' },
        { steps: [
          'Open the address your administrator gave you and type your e-mail address and password.',
          ...(staff ? ['Staff whose account was imported from Active Directory sign in with their normal Windows password (the user name or the e-mail address both work).'] : []),
          'If two-step verification is on for you, type the 6-digit code from your authenticator app and press **Continue**.',
        ] },
        { tip: `After ${config.lockoutAttempts} wrong passwords in a row an account is locked for ${config.lockoutMinutes} minutes. You are signed out after ${config.sessionIdleHours} hours without activity.` },
        { h: 'Finding your way around' },
        { list: [
          '**The menu on the left** lists only what your role may use. The button with three lines at the top folds it away.',
          '**The search box** at the top finds tickets, requests and more.',
          '**The palette icon** changes the colours (see Colour themes). **The bell** shows what needs your attention. **The ? icon** opens this manual in a new tab.',
          '**Your name** at the top right opens your account, Administration (if you may use it) and Sign out.',
        ] },
      ],
    },
    {
      id: 'account', title: 'Your account, password and two-step verification', who: 'all',
      blocks: [
        { p: 'Open **My account** from the menu under your name.' },
        { h: 'Changing your password' },
        { p: 'Type the current password, then the new one twice. A new password must be at least 12 characters and mix three of: lower case, upper case, numbers and symbols.' + (staff ? ' If your account comes from Active Directory the password is changed in Windows, not here.' : '') },
        { h: 'Turning on two-step verification' },
        { steps: [
          'Open **My account**, then **Manage** next to Two-step verification.',
          'Install an authenticator app on your phone (for example Microsoft Authenticator or Google Authenticator).',
          'Add an account in the app using the setup key shown on the page.',
          'Type the 6-digit code the app shows and confirm. From now on you are asked for a code every time you sign in.',
        ] },
        { tip: 'Some roles must use two-step verification. If yours does, you are taken to this page until it is on. To turn it off yourself, open Manage and enter your password and a current code.' },
      ],
    },
    {
      id: 'themes', title: 'Colour themes', who: 'all',
      blocks: [
        { p: 'Click the palette icon next to the bell and choose a theme. Your choice is kept for you and follows you to other computers.' },
        { table: { head: ['Theme', 'What it looks like'], rows: themeRows } },
      ],
    },

    // ------------------------------------------------------------------ customers
    {
      id: 'c-request', title: 'Asking for help: submitting a request', who: 'customer',
      blocks: [
        { steps: [
          'Press **Submit Request** in the menu.',
          'Choose whether it is an **incident** (something is broken) or a **service request** (you need something), then the service and category.',
          'Describe the problem or request. Say what you expected and what happened, and who is affected.',
          'Set how many people are affected (impact) and how urgent it is. These two answers set the priority and therefore how fast we respond.',
          'Attach screenshots or files if they help (up to five), then press **Submit**.',
        ] },
        { p: 'You get a ticket reference on the page and can follow it under My Requests. You can also write to the support mailbox your provider gave you: the e-mail becomes a ticket as well.' },
        { table: { head: ['Priority', 'Meaning'], rows: [['P1 Critical', 'Service is down or many people cannot work.'], ['P2 High', 'A major problem with a limited number of people, or a workaround is hard.'], ['P3 Medium', 'Normal problems and requests.'], ['P4 Low', 'Small issues and questions that can wait.']] } },
      ],
    },
    {
      id: 'c-track', title: 'Following your requests', who: 'customer',
      blocks: [
        { p: '**My Requests** lists everything you raised. Open one to read the conversation, see the status, and add a comment or a file.' },
        { table: { head: ['Status', 'What it means for you'], rows: [
          ['New / Open', 'We have it and will start.'], ['In progress', 'Someone is working on it.'], ['Waiting for customer', 'We need something from you. Reply on the ticket; the clock is paused until you do.'],
          ['Waiting for vendor', 'We are waiting for a supplier.'], ['Service restored', 'The service works again; we are finishing the follow-up.'], ['Resolved', 'We believe it is fixed. Please confirm or reopen.'],
          ['Closed / Cancelled', 'Finished.'] ] } },
        { h: 'When we say it is resolved' },
        { list: [
          '**Confirm** if it is fixed. You can rate the service from 1 to 5 and leave a comment. The ticket is then closed.',
          '**Reopen** if it is not. Say what is still wrong and the ticket goes back to the team.',
          '**Cancel** a request you no longer need, while it is still new. After work has started, add a comment asking us to cancel it.',
        ] },
      ],
    },
    {
      id: 'c-services', title: 'Your services and the catalogue', who: 'customer',
      blocks: [
        { p: '**My Services** shows what we provide to you. **Service Catalogue** shows everything you can ask for, with a short description of each. Pick one there and the request form opens with it already chosen.' },
      ],
    },
    {
      id: 'c-users', title: 'Our users (customer IT administrators)', who: 'customer', role: 'customer_admin',
      blocks: [
        { p: 'As the administrator for your organisation you can add colleagues and switch their access on and off under **Our Users**. Colleagues see their own requests; you see everyone\'s at your organisation.' },
        { steps: ['Open **Our Users** and fill in the name, e-mail address and role of the new person.', 'The page then shows a one-time password. Give it to your colleague; they should change it from **My account** after signing in.', 'To remove access later, switch the person off. Their past requests stay.'] },
      ],
    },

    // ------------------------------------------------------------------ staff: tickets
    {
      id: 'tickets', title: 'Tickets: incidents and service requests', who: 'staff', perm: 'ticket.view',
      intro: 'Everything a customer raises, by portal, e-mail or by phone, becomes a ticket with a reference, a priority and SLA clocks.',
      blocks: [
        { h: 'The lists' },
        { list: [
          '**My Requests**: tickets assigned to you.  **Incidents** and **Service Requests**: the two types.  **All Tickets**: everything you may see, with filters for status, priority, customer and more.',
          'Staff see the tickets of every customer (tickets in the Security queue only the security roles). Customers only ever see their own.',
        ] },
        { h: 'Working a ticket' },
        { steps: [
          'Open the ticket. The top shows the status, priority, customer, service and the SLA clocks (response and resolution).',
          'Write a reply to the customer, or tick **Internal note** for a note only staff can see. Attach files if needed.',
          'Change the **status** as the work moves: In progress, Waiting for customer, Waiting for vendor, Service restored, then Resolved. Resolving asks for a resolution code and note.',
          'Use **Assign** to give the ticket to a colleague, and **Priority** (impact and urgency) if the first assessment was wrong. Every change is written to the ticket history.',
        ] },
        { tip: 'The SLA clock stops while a ticket is Waiting for customer or Waiting for vendor and starts again when it moves on. It counts only inside the business hours of the SLA policy.' },
        { h: 'Statuses' },
        { table: { head: ['Status', 'Use it when'], rows: [
          ['New', 'Just arrived, nobody has looked at it.'], ['Open / In progress', 'Someone is working on it.'], ['Waiting for customer', 'You need an answer or access from the customer. Clock paused.'],
          ['Waiting for vendor', 'A supplier must act. Clock paused.'], ['Service restored', 'Service is back; root cause or follow-up remains.'], ['Resolved', 'Fixed. The customer is asked to confirm (they can reopen).'],
          ['Closed', 'Confirmed by the customer, or closed by staff.'], ['Cancelled', 'Raised by mistake or no longer needed.'] ] } },
        { h: 'Escalation, billing and breaches' },
        { list: [
          '**Escalate** a ticket to the next tier when you cannot solve it; say why. The person who receives it is notified.',
          '**Billing**: mark a ticket **non-chargeable** when the work is outside what the customer pays for. It is counted separately on the Operations Overview.',
          '**SLA note**: when a target was missed, a service manager records the cause and the corrective action. The SLA breaches report lists tickets that still have none.',
        ] },
      ],
    },
    {
      id: 'create', title: 'Raising a ticket for a customer', who: 'staff', perm: 'ticket.create_for_customer',
      blocks: [
        { p: 'Use **Submit Request** when a customer phones or visits. Choose the customer, then the site, service and requester (the lists follow the customer you chose), describe the problem, set impact and urgency, and submit. The customer receives the same e-mail as if they had used the portal.' },
      ],
    },
    {
      id: 'verification', title: 'Verification: e-mails from unknown senders', who: 'staff', perm: 'ticket.verify',
      blocks: [
        { p: 'An e-mail from an address that is not a registered customer still becomes a ticket, but it waits on the **Verification** page and its SLA clocks do not run.' },
        { steps: [
          'Open **Verification** and open a waiting ticket.',
          'Check who the sender is. If they belong to a customer, choose the customer, the CSID, the service, the site and the requester and press **Verify**.',
          'The ticket moves into the normal queues with the right SLA policy, and the engineer for the service is notified.',
        ] },
        { tip: 'The number on the menu item shows how many tickets are waiting.' },
      ],
    },
    {
      id: 'reports', title: 'Reports', who: 'staff', perm: 'report.view',
      blocks: [
        { p: '**Reports** opens a library of ticket reports in six groups: volume and trends, SLA and performance, customers and services, people and workload, backlog and ageing, resolution and satisfaction (plus Security for those who may see it).' },
        { steps: [
          'Open a report. Choose the period, and filter by customer, queue or priority when the report offers it.',
          'Read it on screen, or download it as **CSV**, **Excel** or **PDF** with the buttons at the top.',
        ] },
        { tip: 'Downloads are recorded in the audit log. Reports show only what your role may see.' },
      ],
    },
    {
      id: 'customers', title: 'Customers, services and sites', who: 'staff', perm: 'customer.view',
      blocks: [
        { p: '**Customers** lists the organisations we serve. A customer page holds the details, the **CSID** (the customer service ID used on tickets), the services we provide with their SLA policy and execution engineer, contracts, sites and the customer\'s users.' },
        { list: ['Service managers create customers and services, and set which SLA policy and engineer apply.', 'The **execution engineer** is the person notified first for tickets on that service.'] },
      ],
    },
    {
      id: 'operations', title: 'Operations Overview', who: 'staff', perm: 'operations.view',
      intro: 'The weekly dashboard for leaders: pre-sales, service delivery and SLA in one page.',
      blocks: [
        { p: 'Each tile shows the figure for the chosen week and the change from the week before. You see the tiles for the areas your role may see: tickets, SLA, contracts, tenders, pipeline and projects.' },
        { list: [
          'Weeks run **Monday to Sunday** in the company time zone. Use **Previous week** and **Next week**, or pick a date.',
          'The current week is marked "so far" because it is not finished.',
          '**Weekly highlights** are short notes for leadership (wins, risks, asks). Service managers and department heads can write them; they are kept for each week.',
          'Escalated deals and projects (leadership support needed) are listed so they are not missed.',
        ] },
      ],
    },
    {
      id: 'projects', title: 'Projects', who: 'staff', perm: 'project.view',
      blocks: [
        { p: '**Projects** tracks delivery work with a manager, a team, tasks and milestones, a status and a health.' },
        { steps: [
          'Managers press **New project**, name it, choose the customer, manager, dates and budget. A won deal can start a project with its details filled in.',
          'On the project page add **tasks** and **milestones** with an owner and a due date. Team members update the tasks of projects they are on.',
          'Progress is worked out from the tasks and milestones that are done; nobody types it in.',
          'Set the **health**: On track, At risk or Off track, and write a short status note. Use **Escalate** when leadership must help; say what is needed.',
        ] },
        { table: { head: ['Status', 'Meaning'], rows: [['Planning', 'Not started.'], ['Active', 'Work is under way.'], ['On hold', 'Paused.'], ['Completed', 'Delivered.'], ['Cancelled', 'Stopped.']] } },
      ],
    },
    {
      id: 'contracts', title: 'Contracts', who: 'staff', perm: 'contract.view',
      blocks: [
        { p: 'The contract register holds every customer and supplier contract with its dates, services, documents, financials, obligations, SLA targets, amendments and review history.' },
        { list: [
          'A contract moves through **Active**, **Expiring soon**, **Renewal in progress**, **Expired**, **Suspended**, **Terminated** and **Closed**. Expiring and expired are set automatically from the end date.',
          'Owners are reminded by e-mail before a contract ends (the number of days is a setting).',
          'Reviews are recorded by legal, finance, management and the department head, each with a decision and a comment.',
          'A contract can carry an SLA policy. Services it covers use it when the service has no policy of its own.',
        ] },
      ],
    },
    {
      id: 'tenders', title: 'Tender management', who: 'staff', perm: 'tender.view',
      blocks: [
        { p: 'Follow a tender from identification to award. The page shows the next steps you may take.' },
        { steps: [
          '**Identified, Registered, Under review, Qualification**: decide whether to bid.',
          '**Bid preparation**: the bid team works through the compliance checklist and uploads documents. Internal reviews (technical, commercial, management) are recorded.',
          '**Internal approval**, then **Submitted**: record the submission details.',
          '**Under evaluation / Clarification**, then **Awarded** or **Unsuccessful**. Then **Closed**.',
        ] },
        { tip: 'Deadlines are shown on the list and on the Operations Overview, so nothing is missed.' },
      ],
    },
    {
      id: 'pipeline', title: 'Pipeline tracker (deals)', who: 'staff', perm: 'pipeline.view',
      blocks: [
        { p: 'Every sales opportunity moves through stages: Lead identification, Prospecting, Qualification, Solution development, Proposal submission, Negotiation, Closing, then Won, Lost or On hold. Each stage has a default win probability that you can adjust.' },
        { list: [
          'Add customer contacts, activities, proposals and documents to the deal.',
          'Business development managers can ask **Service delivery engineers** or technical team members for support; they see only the deals assigned to them (**My Opportunities**) and keep technical tasks and solution notes there.',
          '**Escalate** a deal when leadership support is needed. It appears on the Operations Overview until the escalation is cleared.',
          'When a deal is **Won**, press **Start a project** (or **Create the contract**) on the deal and the new form opens with its details filled in.',
        ] },
      ],
    },
    {
      id: 'sla', title: 'SLA policies and business hours', who: 'staff', perm: 'ticket.view',
      blocks: [
        { p: 'Open **Administration**, then **SLA policies**. A policy sets response, restoration and resolution targets for each priority, and uses a **calendar** (working hours and public holidays). The clock runs only in working hours.' },
        { list: ['A ticket gets the policy of its service; if the service has none, the policy of the contract that covers it; otherwise the mailbox or default policy. A ticket without any policy is a **non-SLA** ticket and is counted that way.', 'Contract and SLA managers change policies; others can view them.'] },
      ],
    },
    {
      id: 'mail', title: 'E-mail to ticket', who: 'staff', perm: 'mail.view',
      blocks: [
        { p: 'Shared mailboxes (up to five) are read automatically and every message becomes a ticket, or a comment on the ticket named in the subject. **Administration → E-mail** shows each mailbox, when it was last read, whether it is healthy, and the log of outgoing mail.' },
        { tip: 'If a mailbox shows an error, tell an administrator: tickets by e-mail are not arriving until it is fixed. You get a notice when it recovers.' },
      ],
    },
    {
      id: 'admin', title: 'Administration', who: 'staff', perm: 'user.manage',
      intro: 'Open it from your name at the top right, then Administration.',
      blocks: [
        { h: 'Users, roles and sign-in' },
        { list: [
          '**Add a staff member with a local password**: the page shows a one-time password once. Give it to the person; they should change it from My account.',
          '**Role**: choose from the list and press Save. The role you set is the role; the directory never changes it.',
          '**Active**: untick to block someone. **Available**: untick when a person is away so tickets skip them.',
          '**Reset password** gives a one-time password for a local account. For an Active Directory account the password is changed in Windows.',
        ] },
        { h: 'Active Directory (on the Users page)' },
        { p: 'Active Directory only does two things here: it lets you **import people** and it checks their password when they sign in. Roles are always chosen in this application.' },
        { steps: [
          'On **Users**, open **Connection settings** under Active Directory.',
          'Type the **Server** (for example dc1.corp.local), the **Domain** (corp.local), the **Service account** (a normal read-only AD account, user name only) and its **Password**. Tick **Allow imported people to sign in with their Active Directory password** and press Save. The password is stored encrypted and never shown again.',
          'Press **Test connection**. It says how many people it found, or why it could not connect.',
          'Press **Import users**, search by name, tick the people you want, choose their role and press **Import ticked people**.',
          'Those people now sign in with their Windows password. Anyone not imported cannot sign in.',
        ] },
        { tip: 'Every hour the system checks the imported people: anyone deleted or disabled in Active Directory is switched off here. If the server cannot be reached, nobody is switched off. Always keep one local administrator account for emergencies.' },
        { p: 'The settings behind the form are simple: port 636 (secure) is used unless you change it under Advanced; the search base is worked out from the domain; a certificate file is only needed if your servers use a private certificate authority.' },
        { h: 'Other administration pages' },
        { list: [
          '**Settings**: business hours, SLA clocks, security (which roles need two-step verification), currencies, contract and tender reminders.',
          '**Audit log**: who did what, when and from where. It cannot be edited.',
          '**E-mail**, **Service catalogue** and **SLA policies** are described in their own sections.',
        ] },
      ],
    },
    {
      id: 'roles', title: 'Who can do what', who: 'staff',
      intro: 'This table is generated from the live permission settings. Ask an administrator if you need a different role.',
      blocks: [{ access: [
        ['ticket.view', 'See tickets'], ['ticket.work', 'Reply to, update and resolve tickets'], ['ticket.create_for_customer', 'Raise a ticket for a customer'], ['ticket.assign', 'Assign tickets'], ['ticket.verify', 'Verify e-mail tickets'],
        ['ticket.sla_note', 'Record SLA breach causes'], ['report.view', 'Reports'], ['customer.view', 'See customers and services'], ['customer.manage', 'Create and change customers'], ['catalogue.manage', 'Change the service catalogue'],
        ['sla.configure', 'Change SLA policies'], ['contract.view', 'See contracts'], ['contract.manage', 'Create and change contracts'], ['contract.finance', 'See contract financials'], ['tender.view', 'See tenders'], ['tender.manage', 'Create and move tenders'],
        ['tender.contribute', 'Work on a tender'], ['pipeline.view', 'See the pipeline'], ['pipeline.manage', 'Create and change deals'], ['pipeline.escalate', 'Escalate a deal'], ['project.view', 'See projects'], ['project.manage', 'Create and change projects'],
        ['project.contribute', 'Update tasks of own projects'], ['operations.view', 'Operations Overview'], ['operations.manage', 'Write the weekly highlights'], ['mail.view', 'See the e-mail page'], ['mail.manage', 'Change mailboxes'],
        ['user.manage', 'Manage users and Active Directory'], ['settings.manage', 'Change settings'], ['audit.view', 'See the audit log'],
      ] }],
    },
    {
      id: 'help', title: 'Problems and questions', who: 'all',
      blocks: [
        { table: { head: ['Problem', 'What to do'], rows: [
          ['I cannot sign in', `Check the e-mail address${staff ? ' or user name' : ''} and the password. After ${config.lockoutAttempts} wrong tries the account waits ${config.lockoutMinutes} minutes.${staff ? ' Active Directory users: an administrator must have imported your account first.' : ' If it is still refused, ask your IT administrator or your service provider.'}`],
          ...(staff ? [['"Your account has not been set up here yet"', 'Your Windows account is fine but you have not been imported. Ask an administrator.']] : []),
          ['I do not see a menu item', 'The menu shows only what your role may use. Ask an administrator if you need more.'],
          ['"Your role does not allow this action"', 'The same: your role does not include it.'],
          ['I lost my authenticator phone', 'Contact your administrator. You cannot turn two-step verification off yourself without a code from the app.'],
          ['An e-mail I sent did not become a ticket', 'Check that you wrote to the right support address. Mail from unknown senders waits for verification first.'],
        ] } },
        { p: 'For anything else, contact your administrator or the service desk.' },
      ],
    },
  ];
}

/** The sections this person may read, each with its blocks ready to draw. */
function forUser(user) {
  const customer = user && user.kind === 'customer';
  const out = [];
  for (const s of sections(user)) {
    if (s.who === 'customer' && !customer) continue;
    if (s.who === 'staff' && customer) continue;
    if (s.perm && !perms.can(user, s.perm)) continue;
    if (s.role && (!user || user.role !== s.role)) continue;
    out.push({ ...s, blocks: s.blocks.map((b) => (b.access ? { access: accessRows(b.access) } : b)) });
  }
  return out;
}

/** [{ what, perm, roles: [labels] }] for the "who can do what" table. */
function accessRows(list) {
  return list.map(([perm, what]) => ({ what, perm, roles: (perms.GRANTS[perm] || []).map((r) => perms.ROLE_LABELS[r]).filter(Boolean) }));
}

module.exports = { sections, forUser, accessRows, inline, esc };
