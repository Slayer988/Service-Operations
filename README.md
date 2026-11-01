# Service Operations (Ops)

A multi-tenant service desk: customers and their services (CSIDs), tickets with SLA timers, a customer portal, execution-engineer notification,
**e-mail-to-ticket from up to five shared mailboxes (Microsoft 365, Google Workspace or IMAP)**, **Active Directory sign-in and import (in User management)**, **Contracts** (with renewal tracking), **Tender Management** and a **Pipeline Tracker**,
in a green dashboard-style interface.

Node.js 20/22 · Express · EJS · PostgreSQL 15 · Nginx · systemd · Oracle Linux 9 · SELinux enforcing · **no Docker**.

Built from *Enterprise IT Service Desk – Requirements Specification, Revised v2* (Phase 1 plus the v2 additions). See "Requirements coverage".
Technical names (`itsm` user, `/opt/itsm`, `itsm-web`, `itsm-worker`, `/etc/itsm/itsm.env`) are unchanged from 1.0.0 so upgrades are in place.

## 1. Install (Oracle Linux 9, as root)

```bash
tar xzf service-operations-<version>.tar.gz && cd service-operations
./install.sh --domain servicedesk.example.com --admin-email you@example.com --admin-name "Your Name" --timezone Africa/Nairobi
```

Options: `--no-tls` (plain HTTP, testing only), `--cert F --key F` (your certificate; otherwise a self-signed one is made),
`--demo` (sample customers and users), `--skip-tests`, `--offline-bundle FILE`.

What it does: installs Node, PostgreSQL 15, Nginx; creates the `itsm` OS user and database role (peer authentication over a unix socket, no database
password); copies the app to `/opt/itsm/app`; writes `/etc/itsm/itsm.env` with a generated `SESSION_SECRET`; **runs the unit and integration tests against a
temporary database `itsm_test`** (stops if they fail); runs migrations; configures Nginx, SELinux and firewalld; enables and starts `itsm-web` and
`itsm-worker` (they start at boot); installs the daily backup timer and a 5-minute health check. The administrator's one-time password is printed at the end.

Guards: it refuses to continue if `/var/lib/pgsql/data` belongs to a different PostgreSQL major version, or if Nginx already serves the same
`server_name` (for example the earlier Django app): use a different `--domain` or remove the old one first.

**Offline servers.** On a machine with internet run `scripts/make-offline-bundle.sh` (creates `node_modules.tar.gz`; all dependencies are pure JavaScript),
copy it to the server and pass `--offline-bundle node_modules.tar.gz`. The server needs no internet for installing, but it **does** need outbound HTTPS to
`login.microsoftonline.com` + `graph.microsoft.com` (Microsoft 365) or `oauth2.googleapis.com` + `gmail.googleapis.com` (Google) for those mailboxes.

Uninstall: `./uninstall.sh` (keeps data) or `./uninstall.sh --purge-data`.

### Upgrading from 1.0.0, 1.1.0, 1.2.0 or 1.3.0
Unpack 1.9.0 and run `./install.sh` again with the same options. Migrations 003–012 add directory users, mailbox monitoring, the new mailbox
fields, the contract, tender, pipeline and service catalogue tables and the one-CSID rule (if an existing customer already has several CSIDs, the database rule is not switched on for now, nothing is deleted, and no further CSIDs can be created through the application); existing data, the env file and the two existing mailboxes are kept (they were IMAP and stay IMAP). Then add the new lines you need to
`/etc/itsm/itsm.env` (see `deploy/itsm.env.example`: `APP_NAME`, Microsoft/Google credentials; the Active Directory password is now typed on the Users page, and an `LDAP_BIND_PASSWORD` from an earlier install keeps working until you do) and `systemctl restart itsm-web itsm-worker`.
Behaviour changes: IMAP mailboxes are now read **by arrival order, not by the unread flag**, and processed mail is no longer marked as read unless you tick that box.

## 2. First steps after install

1. Open `https://<domain>/login` and sign in with the administrator printed by the installer. Platform administrators must enrol **MFA** (authenticator app; type the key – no QR code).
2. User menu → Administration → **SLA policies**: the seeded targets for Platinum/Gold/Standard are **illustrative placeholders**. Enter your contract values; add public holidays.
3. Administration → **Service catalogue**: review the services you offer. **Customers**: create a customer (its one CSID is created with it) → sites → services (chosen from the catalogue) → contracts → customer users. Assign the **execution engineer** (primary and backup) per service or contract.
4. User menu → Administration → **E-mail**: set up your mailboxes (section 3). Put outgoing mail settings (`SMTP_*`) in `/etc/itsm/itsm.env`; with `SMTP_HOST` empty, mails are only written to the log.
5. Administration → **User management** (optional): connect Active Directory and import your staff (section 4). Keep one **local** platform administrator as a break-glass account.
6. User menu → **Administration** → **Settings** (User management and Audit are there too): priority matrix, categories, resolution codes, SLA pause statuses, reminder days, MFA-required roles.

After editing `/etc/itsm/itsm.env`: `systemctl restart itsm-web itsm-worker`. The application name can be changed with `APP_NAME=`.

## 3. Shared mailboxes → tickets (up to five)

Open **Administration → E-mail** (user menu, top right). Two mailboxes (Security, IT Services) exist switched off; add up to five in total. For each one choose **how to read it**, the **queue** its tickets go to
(Security is restricted to staff with Security access), category, default priority, starting tier and SLA policy. **Secrets are never stored in the database or shown
in the browser**: the page holds only the *name* of an environment variable; the value lives in `/etc/itsm/itsm.env` (`chmod 640 root:itsm`).
Use **Test connection**, then tick **Enabled**. The worker picks changes up within a minute. Replies and acknowledgements to customers carry the Reply-To of the mailbox the ticket came in through.

What happens to each message is identical for every provider: it is stored once (Message-ID), its original `.eml` is kept, and it is matched to a customer by sender;
replies are threaded by our Message-ID or the `[REF]` in the subject; unknown senders, failed SPF/DKIM and unauthorised repliers go to the **verification queue**; automatic replies and
loops are ignored; a message that cannot be processed three times is parked as *failed* (visible, reprocessable) so it cannot block the mailbox.
When a mailbox is first connected only **unread mail from the last two days** becomes tickets (so connecting an old mailbox does not create thousands).

**Monitoring.** Each mailbox shows its health, last successful check, last message received and messages in 24 hours. After three failed checks (or no success for the
configured minutes) supervisors get one e-mail alert, the dashboard shows a red banner, and another e-mail follows when it recovers. The 5-minute system health check also logs a problem.

### 3a. Microsoft 365 / Exchange Online (Graph) – recommended for shared mailboxes
No passwords, no IMAP. The application signs in as itself (client credentials) and reads only the mailboxes you allow.
1. Entra admin centre → *App registrations* → New: name "Service Operations (Ops)", single tenant. Note the **Directory (tenant) ID** and **Application (client) ID**.
2. *Certificates & secrets* → New client secret → copy the **value** into `/etc/itsm/itsm.env` (for example `M365_CLIENT_SECRET=...`). Secrets expire: put the expiry date in your calendar.
3. *API permissions* → Microsoft Graph → **Application** permissions → **Mail.Read** (add **Mail.ReadWrite** only if you want "mark processed mail as read") → *Grant admin consent*.
4. **Limit the app to the shared mailboxes** (otherwise Mail.Read allows every mailbox in the tenant). Classic method in Exchange Online PowerShell:
   ```powershell
   New-DistributionGroup -Name "ServiceDesk-Mailboxes" -Type Security -Members help@contoso.com,security@contoso.com
   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId ServiceDesk-Mailboxes@contoso.com -AccessRight RestrictAccess -Description "Service Operations (Ops)"
   Test-ApplicationAccessPolicy -Identity help@contoso.com -AppId <client-id>
   ```
   Microsoft is replacing this with "RBAC for Applications"; use whichever your tenant offers. Shared mailboxes need no licence for this.
5. In the application choose *Microsoft 365 (Graph)*, enter the address, tenant ID, client ID and the variable name (`M365_CLIENT_SECRET`), **Test connection**.

### 3b. Google Workspace (Gmail API)
1. Google Cloud console: create a project, enable the **Gmail API**, create a **service account**, enable domain-wide delegation and download its JSON key to the server, for example
   `/etc/itsm/google-sa.json` (`chown root:itsm`, `chmod 640`); set `GOOGLE_SA_KEY_FILE=/etc/itsm/google-sa.json` in the env file.
2. Admin console → Security → API controls → *Domain-wide delegation* → add the service account's client ID with the scope `https://www.googleapis.com/auth/gmail.readonly`
   (`gmail.modify` only for "mark as read").
3. In the application choose *Google Workspace*, enter the mailbox address (the user that is impersonated – a dedicated shared-inbox user or a delegated mailbox) and the variable name. Google has no
   "shared mailbox" object as Exchange does; Google Groups collaborative inboxes cannot be read this way.

### 3c. Plain IMAP (password)
For Exchange on-premises (IMAP4 service enabled; user as `DOMAIN\user\sharedmailbox` or the shared mailbox's own login), Zoho, Fastmail, cPanel hosts and similar. Enter host, port, user and the
password variable name. Microsoft 365 tenants normally have password IMAP switched off: use Graph there.

### Outgoing mail
Notifications, acknowledgements and renewal reminders are sent over **SMTP** (`SMTP_*` in the env file). Sending *through* Graph or the Gmail API is not implemented. For Microsoft 365 use an
SMTP relay/connector (Microsoft is phasing out password-based SMTP AUTH) or your on-premises relay; for Google use `smtp-relay.gmail.com` with IP allow-listing.

## 4. Active Directory (User management)

Active Directory does two things: it lets an administrator **import people**, and it **checks their password** when they sign in. Nothing else. Roles are never taken from AD groups: the role you choose on the Users page is the role.
Everything is on **Administration → User management**, in the "Active Directory" card (platform administrators).

1. Press **Connection settings** and fill in three things: the **Server** (`dc1.corp.local`), the **Domain** (`corp.local`) and the **Service account** (a normal read-only AD account, typed as `svc-itsm`; a full name such as `CORP\svc-itsm` or `svc-itsm@corp.local` is used as typed) with its **Password**.
   Tick **Allow imported people to sign in with their Active Directory password** and **Save**. The password is stored encrypted in the database (AES-256-GCM, key derived from `SESSION_SECRET`) and is never shown again; leave the box empty later to keep it. Changing `SESSION_SECRET` means retyping it.
   Under **Advanced** (rarely needed): the port (636 secure by default; 389 always upgrades to TLS), the search base (worked out from the domain), and a certificate file when your domain controllers use an internal CA
   (copy the PEM to the server, for example `/etc/itsm/ad-ca.pem`; Node does not use the Linux trust store). Passwords are never sent unencrypted and the certificate is always checked.
2. Press **Test connection**. It reports how many people it found, or why it could not connect.
3. Press **Import users**, search by name, tick the people, choose one role for them and **Import ticked people**. Their name, e-mail address and AD account are read from the directory, not from the form. A person who is disabled in AD,
   has no e-mail address or already has a (local or imported) account is skipped, with the reason shown. Change anyone's role afterwards on the Users page.
4. Imported people sign in with their AD user name (`jdoe`, `jdoe@corp.local`) or e-mail address and their Windows password. **Anyone not imported cannot sign in.**

Rules: local accounts (customers, the break-glass administrator) never use the directory, and an AD account can never take over a local one. An administrator's decision to switch someone off is never reversed. An **hourly check** switches off imported people who were deleted or
disabled in AD and ends their sessions; it does nothing at all when the directory cannot be reached, and never switches off the last active platform administrator. MFA still applies on top (required for platform administrators). Customer users are not read from AD in this version.
`/admin/directory` (the earlier page) goes to User management. Accounts that earlier versions created through AD groups keep working; their role is now fixed as it was and is changed on the Users page.

## 5. Tenancy and roles

* The **customer is the tenant**; one host name serves everyone. Staff see all customers; customer users are bound to one customer taken from the **session**, never from request data.
* The database enforces it too: tickets, services, contracts and renewals use composite foreign keys, so a row cannot point at a CSID, service, contract or site of another customer.
* Staff roles: `platform_admin`, `service_manager`, `contract_manager`, `agent`, `engineer`, `security_analyst`, `auditor`, `management`, `bd_manager`, `bid_manager`, `technical_team`, `sde`, `finance`, `legal`, `dept_head`, `readonly`; customer roles `customer_admin`, `customer_user`. Business roles without ticket access land on the Operations Overview. The **Security** queue is visible only to roles with
  `security.view` (platform admin, security analyst); other staff do not see those tickets in lists, search, reports or e-mails.

## 6. How the other parts work

* **SLA**: calendar-aware (timezone, windows, holidays), per priority P1–P4; priority = impact × urgency (configurable). Timers pause in the pause statuses and resume with remaining time preserved.
  The worker flags warnings/breaches, notifies and escalates.
* **Execution engineer**: dated assignments; reassigning closes the old row (history). Routing: primary → backup → supervisors. Audited.
* **Service Catalogue**: the services you offer. Service managers add, edit, retire and re-order entries (retiring keeps every customer service that uses it). Customers see the active entries on their portal.
  A customer has **exactly one CSID** (created with the customer); each service belongs to that CSID and can be covered by **any number of contracts** (link them on the service or on the contract). The contract that sets a
  ticket's SLA is the newest one in force that has an SLA policy.
* **Contracts** (was "Renewals"; old `/renewals` links redirect): customer, supplier and partner contracts. Status follows the dates (*Active → Expiring soon → Expired*) unless you set *Renewal in progress, Suspended, Terminated* or *Closed*
  (the last two need a reason). Obligations and deliverables, payment schedule, SLA targets and measured performance, amendments (an extension or value change updates the contract), versioned documents, legal / finance /
  management reviews, history. Reminders to the owner and contacts at 90/60/30/14/7 days (configurable), sent once; weekly escalation to managers for contracts that expired or end within 7 days; resend. Dashboard, eight reports
  (active, expiry, renewals, value, counterparty, obligations, SLA, amendments) as screen, CSV, Excel and PDF.
* **Tender Management**: register a tender (issuer, type, value, clarification and submission deadlines in the application time zone), fourteen statuses
  (*Identified, Registered, Under review, Qualification, Bid preparation, Internal approval, Submitted, Under evaluation, Clarification, Awarded, Unsuccessful, Cancelled, Withdrawn, Closed*) with allowed transitions only,
  the standard bid checklist (administrative, technical, financial, statutory), team, internal reviews, evaluation log, documents, history. **Submission needs the method and approved technical, commercial and management reviews**
  (switchable in Settings). Reminders at 14/7/3/1 days (configurable) are sent once to the owner, team and checklist assignees, with supervisors added at 1 day and when a deadline passes. An award or a loss moves the linked
  opportunity to Won / Lost; an awarded tender offers "Register the contract". Dashboard and seven reports.
* **Pipeline Tracker**: opportunities (existing customer or prospect) through ten stages (*Lead identification, Prospecting, Qualification, Solution development, Proposal submission, Negotiation, Closing, Won, Lost, On hold*) with
  configurable probabilities (default 5/10/25/40/60/75/90), activities, proposals, contacts, next step, board and list, open and weighted value, monthly forecast, win rate, a mandatory lost reason, tender link; six reports.
* **Service Delivery Engineer (SDE)**: a business user assigns SDEs to an opportunity and gives them tasks. The SDE sees **only** their opportunities (others return "not found"), updates their own tasks, records site assessments,
  BOM / solution design / resources and support notes, and **cannot** edit customer, value, stage or owner. The SDE dashboard shows their tasks and deadlines; overdue tasks are e-mailed once a week to the SDE and the owner.
  The **Opportunity Support Report** is available as screen, PDF and Excel.
* **Operations Overview** (`/operations`, the former Business Overview; `/business` still works): the weekly executive dashboard. Twelve tiles compare the chosen week (Monday to Sunday, with previous / next week and a date picker) with the
  week before: *Total Active Pre-Sales Deals, Pre-Sales Pipeline Value, Active Delivery Projects, Closed Pipeline* (deals won in the week), *Active SLA Accounts, Avg SLA Compliance %, SLA Breaches This Week, Open Support Tickets,
  Post-Sale Support Incidents (Non-SLA), B2B Renewal Accounts, Non-Chargeable Incidents (Non-SLA), Deals Requiring Escalation*. Below them are **Key Highlights** (two sentences typed for the week by a service manager,
  department head or administrator, plus two counts: projects off track or escalated, and deals and projects needing leadership support), a **Status Summary**, the list of escalated items, and the earlier pipeline / tender /
  contract detail. Every figure comes from the records; a tile appears only if the viewer may see the records behind it (an agent sees the ticket tiles, finance the SLA-account and renewal tiles, and so on).
  How each is counted: open counts are taken at the end of the week and compared with the start of the week, rebuilt from created and closed dates (so a deal that went on hold since is not reconstructed); pipeline value is in the default
  currency only; SLA compliance is response and resolution targets met for tickets raised in the week; a breach is a target that fell due in the week and was missed; "Non-SLA" means the ticket has no SLA policy; "non-chargeable" is a flag
  staff set on the ticket (Billing card); B2B renewal accounts are customers with a contract ending inside the expiring window; "needing escalation" is a flag on a deal or project with a stated reason.
* **Projects** (`/projects`): delivery work for a customer or internal. Each project has a manager, team, status (*Planning, Active, On hold, Completed, Cancelled*), health (*On track, At risk, Off track*), planned dates, budget, an optional
  link to the won deal and the contract, a latest-status note, tasks and milestones with owners and due dates, an escalation flag and a full activity log. Progress is the share of tasks done (never typed in). A won deal has a
  **Start a project** button. Service managers, department heads and administrators manage projects; a team member who is an engineer, SDE or technical team member updates tasks on the projects they are on; others with project access read.
* **Escalation**: on a deal (service manager, contract manager, BD manager, department head, administrator) or a project (managers): a reason is required, it is logged, and winning or losing a deal clears it.
* **Themes**: six: **Default** (the company colours: deep navy, teal and mint, with red headings; it is what everyone sees until they choose another), Service Green, Sunset Orange, Match Device, Ocean Blue, Midnight Dark. Each person changes theme only with the **palette icon next to the notification bell**; the choice is kept for that person (and in the browser, so the
  sign-in page matches). Dark mode also applies to charts, tables and forms. **Side menu**: the button at the left of the top bar collapses it to icons only (tooltips show the names) and remembers the choice.
  **Error pages** show the status code in a colour: amber for something to correct (400, 413, 429), red outline for "not allowed" (401, 403), blue for "not found" (404), solid red for a fault on our side (5xx); message banners use
  green, blue, amber and red the same way.
* **Service Desk Reports** (Reports in the menu): seven categories, 17 reports (a Security category with one more appears for people with Security access). *Ticket volume and trends*: ticket register, created and resolved over time, by category and type,
  by channel and queue. *SLA and performance*: SLA by customer, SLA and times by priority, SLA breaches with cause and corrective action. *Customers and services*: by customer, by service, top requesters. *People and workload*: by assignee,
  by execution engineer. *Backlog and ageing*: open backlog by age and priority, open tickets oldest first, by status. *Resolution and satisfaction*: resolution codes, customer satisfaction. The period and customer apply to all;
  every report is shown on screen and downloads as Excel, PDF or CSV. People see only the tickets they may see (Security tickets only with Security access).
* **Interface**: left menu that only lists modules you may use, a top bar with search, alerts and your menu; staff dashboard (five KPI tiles with change against the previous period, request-a-service tiles,
  30-day trend, tickets by category, SLA compliance, "My tickets" with SLA time remaining) and a simpler customer dashboard. Charts are drawn on the server as SVG (the strict CSP forbids inline script and style).
  The name can be changed with `APP_NAME`.
* **Outbox**: all e-mail goes through the `notifications` table with retry/back-off; a final failure alerts supervisors.
* **Security controls**: scrypt passwords (12+ chars), lockout, TOTP MFA, CSRF tokens, strict CSP (no inline script/style), upload allow/deny lists, size limit and optional virus scan (`AV_COMMAND`), audit log,
  immediate effect of deactivation, filter-injection-safe directory lookups.

## 7. Operations

| Task | Command |
|---|---|
| Status | `systemctl status itsm-web itsm-worker` |
| Starts at boot? | `systemctl is-enabled itsm-web itsm-worker nginx postgresql` |
| Logs | `journalctl -u itsm-web -u itsm-worker -f` |
| Health | `curl -s http://127.0.0.1:3000/healthz` |
| New admin / reset password | `cd /opt/itsm/app && sudo -u itsm env $(cat /etc/itsm/itsm.env \| xargs) node scripts/create-admin.js --email a@b.c --name "A B" --role platform_admin --password '...'` |
| Run migrations | `cd /opt/itsm/app && sudo -u itsm env $(cat /etc/itsm/itsm.env \| xargs) node scripts/migrate.js` |
| Demo data | `node scripts/seed-demo.js` (password `Demo-Passw0rd-2026!` – never on production) |

## 8. Backup and restore

A timer runs `/usr/local/sbin/itsm-backup` daily: `pg_dump` + a tar of `/var/lib/itsm/storage` (attachments, original e-mails) into `/var/backups/itsm`, keeping 14 days.
**Copy these off the server.** Restore (rehearse quarterly on a spare machine):

```bash
systemctl stop itsm-web itsm-worker
runuser -u postgres -- dropdb itsm && runuser -u postgres -- createdb -O itsm itsm
gunzip -c /var/backups/itsm/itsm-db-YYYYMMDD-HHMMSS.sql.gz | runuser -u postgres -- psql -d itsm
tar -C /var/lib/itsm -xzf /var/backups/itsm/itsm-files-YYYYMMDD-HHMMSS.tar.gz
chown -R itsm:itsm /var/lib/itsm/storage && restorecon -R /var/lib/itsm
systemctl start itsm-web itsm-worker
```
The environment file `/etc/itsm/itsm.env` (secrets) and any key/CA files in `/etc/itsm` are **not** in that backup: keep a copy in your password vault.

## 9. Known limits

* Microsoft 365 and Gmail mailboxes are **read** through their APIs; **sending** is SMTP only. No OAuth2 for IMAP. Microsoft sovereign clouds (GCC High, China) are not supported (commercial `graph.microsoft.com` only).
* Gmail: reading a Google Group collaborative inbox is not possible; use a user mailbox.
* A mailbox polls on a timer (default 60 s; minimum 30 s): there is no push/webhook.
* MFA enrolment is by typing the key (no QR, no recovery codes; an administrator resets MFA). Directory users cannot change their password here, by design.
* Directory sign-in is for staff only and only for imported people; no SSO/SAML/OIDC; AD groups are not used.
* No mobile/offline app. The PDF writer uses the built-in Helvetica font (Latin text). SLA targets and seeded mailbox addresses are placeholders.

## 10. Requirements coverage

Legend: **Done** = implemented · **Partial** = implemented with the limits stated · **Not in this release** = left for later phases.

| Area (specification) | Status | Notes |
|---|---|---|
| Multi-customer tenancy, isolation (NFR-001, CUS) | Done | Session-derived scope plus composite foreign keys |
| Customers, sites, CSIDs, services, contracts | Done | |
| Roles and permissions | Done | Fixed role set |
| Customer portal | Done | |
| Incidents, requests, priority matrix, assignment, escalation, reopen, resolution codes | Done | |
| SLA calendars, pause/resume, warnings, breaches | Done | Targets are placeholders until you enter contract values |
| Security queue separation (SEC) | Done | |
| Dashboard and reports | Done | Charts on screen; service desk, contract, tender and pipeline reports as CSV, Excel and PDF |
| Audit log | Done | |
| Execution-engineer notification (SLA-009..014, AUTO-006) | Done | |
| Shared mailboxes, e-mail-to-ticket (EMAIL-001..013) | Done | Up to 5; Microsoft 365 Graph, Google Gmail API, IMAP; health monitoring; sending is SMTP |
| Licence and support renewals (REN-001..012) | Done | Now the **Contracts** module |
| Contracts (CM-001..018), Tender Management (TM-001..015), Pipeline Tracker and SDE function (PT-001..030), common requirements (CR) | Done | Requirements document supplied for 1.3.0; see section 6 |
| Service catalogue, one CSID per customer, service ↔ many contracts | Done | |
| Directory integration (IAM, AD/LDAP) | Partial | Staff only; no SSO |
| Backup procedures (NFR-005) | Done | Off-site copy is yours |
| MFA | Partial | TOTP without QR/recovery codes |
| Field service, maintenance, assets/CMDB, vendors, knowledge base, problem/change/approvals (shown in the design mock-up, deliberately not in the menu because they do not exist), NOC/SOC integrations, billing, PDF export, mobile/offline | Not in this release | |

## 11. What has and has not been verified

**Verified in a sandbox**
* JavaScript syntax of every file; every unit test file (`node --test test/unit/*.test.js`: SLA maths, TOTP, CSV guard, inbound mail, directory settings, search, sign-in and the encrypted password, the User Manual, mailbox health, charts, menus, dashboards, and the new contract status/SLA logic, tender
  transitions and reminder timing, pipeline totals, forecast and probabilities).
* EJS view syntax and the CSP rules (no inline script or style).
* **All six SQL migrations and every query of the new modules against a real PostgreSQL 16**, including the one-CSID rule, service ↔ contract links, contract/tender/pipeline services and schedules (reminders sent once),
  tender award → opportunity move, the SDE task flow and the reports (CSV, Excel and PDF files were produced and opened with `openpyxl` and `pdftotext`).
* The route handlers of the new modules were run with a stand-in for the web layer and a real database (permissions, the SDE restrictions: 404 for an unassigned opportunity, 403 for editing commercial data or someone else's task);
  pages were rendered with a small EJS stand-in and checked in a browser screenshot.

**Not verified**: the sandbox could not download npm packages, so the real Express application has never been started here. That means the integration tests (`test/integration`, rewritten for 1.3.0) have **never run**, sessions, CSRF,
login, file uploads and document downloads were not exercised, views were not rendered by the real `ejs`, and the `multer` 2.x upgrade is untested. Nothing has been tested against a real Microsoft 365 tenant, Google Workspace or
domain controller (the `ldapts` package is also unproven), and `install.sh` has not been run on Oracle Linux. Expect small defects on first run. `install.sh` runs the unit and integration tests before starting anything and prints any
failure; please send that output.
