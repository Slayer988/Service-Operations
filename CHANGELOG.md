# Changelog

## 1.9.0
- **Active Directory made simple and moved into User management.** The separate Directory page, the group mappings and the role-from-group rules are gone. One card on the Users page: type the **server**, **domain** and a **service account with its password** (stored encrypted,
  never shown again), **Test connection**, then **Import users**: search, tick, choose a role, import. Imported people sign in with their Windows password; people who were not imported cannot. AD never changes a role. The hourly check still switches off people deleted or
  disabled in AD (never when the directory is unreachable). Search base, port and certificate file are under "Advanced". Earlier AD settings and accounts keep working (their role is now fixed as it was). Migration 012. `LDAP_BIND_PASSWORD` is now only an optional fallback.
- **User Manual.** The **?** icon at the top now opens a User Manual in a new tab (`/manual`). It is written for each person's role: customers read how to ask for help, follow and confirm requests; staff read the modules their role may use
  (tickets, verification, reports, customers, Operations Overview, projects, contracts, tenders, pipeline, SLA, e-mail, administration including the new Active Directory steps) and a "Who can do what" table generated from the live permissions. Also readable by people who still have to set up MFA.

## 1.8.0
- **Default theme headings are now an orange-red** (`#ff4a1c`) instead of flat red, readable on the navy background (5.3 : 1 contrast).
- **Business Overview is now Operations Overview** (`/operations`; `/business` redirects). A weekly executive dashboard in the style of the report cover: twelve tiles with the change from the week before (pre-sales deals, pipeline value, delivery
  projects, closed pipeline, SLA accounts, SLA compliance, breaches, open tickets, non-SLA incidents, B2B renewals, non-chargeable incidents, deals needing escalation), Key Highlights, a Status Summary, the escalated items, week navigation,
  and the earlier pipeline / tender / contract detail underneath. Each viewer sees only the tiles for records their role may see.
- **New Projects module** (`/projects`): register, new project (or "Start a project" from a won deal), manager, team, status, health, dates, budget, tasks and milestones, progress from tasks, escalation, activity log. Roles:
  service manager, department head and administrator manage; engineers, SDEs and technical team members update the tasks of projects they are on.
- **Escalation of deals** (reason required; cleared when the deal is won or lost) and a **non-chargeable** flag on tickets (Billing card), which feed two of the tiles.
- Weekly highlights (two typed sentences per week) are stored in `weekly_highlights`. Migration 011.
- New icons for the tiles. The old `business.js` route and view are replaced.

## 1.7.0
- **New theme "Default"**, in the company colours of the weekly report cover: deep navy background, white text, mint and teal accents and red page headings. It is the first theme in the switch and is what everyone sees until they choose another;
  nobody's saved choice changes. There are now six themes (Default, Service Green, Sunset Orange, Match Device, Ocean Blue, Midnight Dark), still changed only with the palette icon next to the bell. Migration 010.
- **New brand icon**: a hexagon with a flowing "S" replaces the headset in the menu header and on the sign-in page, and the browser tab now shows it too (`/static/favicon.svg`).

## 1.6.1
- **Fix: Service Desk Reports failed with a server error (500).** Every report sent PostgreSQL a time-zone value that some reports did not use, and PostgreSQL refuses a statement given more values than it uses. The value is now always part of the statement. Found by the installer's own integration test, which stopped the install as designed.
- New unit test (`report_queries`) checks every report's parameter count for each role, so this cannot return unnoticed.

## 1.6.0
- **Service Desk Reports in categories**: Ticket volume and trends, SLA and performance, Customers and services, People and workload, Backlog and ageing, Resolution and satisfaction, and Security (Security access only). 17 reports, each on screen
  and as Excel, PDF and CSV, with a shared period and customer filter and charts where they help. The old ticket-level CSV is the "Ticket register" (`/reports?format=csv` still works).
- **Collapsible side menu**: the menu button in the top bar collapses it to icons only (names appear as tooltips) and remembers the choice.
- **Themes reduced to five**: Service Green, Sunset Orange, Match Device, Ocean Blue, Midnight Dark. They are changed **only** with the palette switch next to the notification bell (removed from My account, the user menu and Settings,
  including the organisation default). Anyone who had chosen Violet or Graphite goes back to Service Green. Migration 009.
- **Colour-coded error codes**: error pages show the status code in a colour by meaning (amber 400/413/429, red outline 401/403, blue 404, solid red 5xx) with a one-line hint; info and warning message styles added to the existing
  success and error ones. All follow the theme, including dark.
- SLA policies and the Service Catalogue are reached only from Administration (they are not in the menu).

## 1.5.0
- **Roles set in the application take precedence over AD group roles.** When an administrator changes a directory user's role on the Users page, or creates the person there with "Active Directory" sign-in and a role, the role is fixed:
  sign-in and the hourly check never change it, and the person no longer needs to be in a mapped group (a disabled or removed AD account is still switched off). "Role from AD group" on the Users page hands the role back to the directory.
  The directory lookup test shows when an application role overrides the groups. Migration 008 adds `users.role_locked`.
- **SLA policies and the Service Catalogue moved to Administration** (user menu → Administration); the left menu keeps only daily work. Everyone on staff still reaches them from there (view-only where they cannot edit), and the
  Administration link now shows for all staff.

## 1.4.0
- **Themes**: Service Green (default), Ocean Blue, Violet, Sunset Orange, Graphite, Midnight (dark) and "Match my device" (green by day, Midnight when the device is in dark mode). Everyone, staff and customers, picks their own
  from the colour dots in the user menu or on **My account → Appearance**; "Organisation default" removes the personal choice. Administrators set the default for everyone in **Settings → Appearance**. The sign-in page follows the choice
  last made in that browser, else the default. Charts, status pills and forms follow the theme. No inline style or script is used (the theme is the `data-theme` attribute on the page). Migration 007 adds `users.theme`.
- **E-mail moved to Administration**: it is no longer in the left menu; open it from user menu → Administration → E-mail (service managers and security analysts keep their access, as before).
- Small fixes: the stylesheet no longer contains fixed colours outside the theme variables (a unit test guards this).

## 1.3.0
- **Contracts** rebuilt to the requirements document (CM-001..018): seven lifecycle statuses (Active, Expiring soon, Renewal in progress, Expired, Suspended, Terminated, Closed; the status follows the dates automatically),
  counterparties (customer, supplier or partner), obligations and deliverables, payment schedule, SLA targets and measured performance, amendments (extension, value change ...), document register with versions,
  separate legal / finance / management reviews, history, reminders at 90/60/30/14/7 days (configurable) with weekly escalation, dashboard, eight reports (CSV, Excel, PDF).
- **Tender Management** rebuilt (TM-001..015): fourteen statuses with enforced transitions, the standard bid checklist, team members, technical / commercial / management reviews that must be approved before submission,
  submission method and reference, evaluation and clarification log, award value, outcome note, link to the opportunity (an award or a loss moves it to Won / Lost) and a "start a contract" step after an award; dashboard and seven reports.
- **Pipeline Tracker** rebuilt (PT-001..030): ten stages (Lead identification ... Closing, Won, Lost, On hold) with configurable probabilities, activities, proposals, contacts, forecast by month, win/loss, workload and technical reports.
- **Service Delivery Engineer (SDE) function**: an SDE sees only the opportunities assigned to them, works on assigned tasks (status, progress, work notes), records site assessments / BOM / solution design / resources, and cannot change
  customer, value, stage or owner. SDE dashboard, task reminders, and the **Opportunity Support Report** (HTML, PDF and Excel).
- **Business overview** page (`/business`) combining the three dashboards; new roles: management, BD manager, bid manager, technical team, SDE, finance, legal, department head, read-only (16 staff roles in total).
- **Service Catalogue**: editable list of the services the business offers (name, code, category, icon, SLA policy, owner team, featured, active). Customers see the active entries; a customer service is created from a catalogue entry.
- **One CSID per customer** (enforced by the database); **a service can be covered by any number of contracts**. The governing contract for a ticket is the newest contract in force that has an SLA policy.
- **Administration hub**: Settings, Users, Directory and Audit are no longer in the left menu; open them from the user menu → Administration.
- Customers can be deleted when nothing refers to them (type the customer code); sites and customer users can be edited or removed.
- Settings: currencies, default currency, departments, contract types and reminder days, tender types and review requirement, opportunity categories, pipeline probabilities and stage names, status names.
- Alerts menu now includes contracts ending, overdue obligations, tender deadlines and overdue follow-ups / SDE tasks.
- `multer` upgraded to 2.x (security fixes). `uninstall.sh` no longer fails when run from inside `/opt/itsm`. Migration 006. Release name: `service-operations-1.3.0.tar.gz`.

## 1.2.0
- **New interface**: green theme with left menu, top bar (search, alerts, user menu), new staff dashboard (KPI tiles with period change, request-a-service tiles, ticket trend, tickets by category, SLA compliance, My tickets with SLA time left), customer dashboard and split-screen login. Only existing modules appear in the menu.
- **Contracts** replaces Renewals (more contract types, SLA service contracts listed on the same page); old `/renewals` links redirect.
- **Tender Management**: register, go/no-go, status flow, checklist, documents, history, deadline and clarification reminders by e-mail, CSV.
- **Pipeline Tracker**: opportunities, stages and probabilities, board and list, weighted value, win rate, lost reasons, link to tenders (a won or lost tender updates its opportunity), CSV.
- Incidents / Service requests filter on the ticket list; the request forms accept a pre-selected category.
- Settings: default currency and tender reminder days. Migration 005. 

## 1.1.0
- Display name changed to **Service Desk Ops** (set `APP_NAME` to change it). Technical names are unchanged, so upgrades are in place.
- **Shared mailboxes: up to five**, each read through **Microsoft 365 (Microsoft Graph, app registration)**, **Google Workspace (Gmail API, service account)** or **IMAP**. Add, edit, test and remove them on the E-mail page.
- Mail is followed by arrival order (IMAP UID / received time), not by the unread flag, so people reading mail in Outlook cannot hide it. Optional "mark processed mail as read".
- First connection of a mailbox only turns the last two days of unread mail into tickets. A message that fails three times is parked as *failed* instead of blocking the mailbox.
- **Mailbox monitoring**: health per mailbox, supervisor alert after repeated failures or silence (one per outage) and a recovery notice, dashboard banner, Test connection.
- Replies and acknowledgements use the Reply-To of the mailbox the ticket arrived in.
- **Active Directory sign-in** for staff over LDAPS/STARTTLS with AD group → role mapping, automatic account creation, a test page, and an hourly check that disables people who left AD.
- Login accepts an e-mail address or an AD user name. Directory users cannot change their password in the application.
- Migrations 003 and 004. New dependency: `ldapts`.

## 1.0.0
- First release: customers, CSIDs, services, tickets, SLA engine, portal, execution-engineer notification, two IMAP mailboxes, renewals, audit, backups, Oracle Linux 9 installer.
