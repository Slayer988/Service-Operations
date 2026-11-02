# Service Operations (Ops)

A multi-tenant service operations platform: customers and their services (CSIDs), tickets with SLA timers, a customer portal,
execution-engineer notification, **e-mail-to-ticket from up to five shared mailboxes (Microsoft 365, Google Workspace or IMAP)**,
**Active Directory sign-in and import**, a **Service Catalogue**, **Contracts**, **Tender Management**, a **Pipeline Tracker** with the
Service Delivery Engineer (SDE) function, **Projects**, a weekly **Operations Overview**, **Service Desk Reports** and a role-aware **User Manual**.

Node.js 20/22 · Express 4 · EJS · PostgreSQL 15 · Nginx · systemd · Oracle Linux 9 · SELinux enforcing · **no Docker**.

Current version: **1.9.0** (`package.json`), plus unreleased work from migrations 013–015 (see [section 11](#11-unreleased-work-in-the-repository)).
Built from *Enterprise IT Service Desk – Requirements Specification, Revised v2* and the Contracts / Tenders / Pipeline requirements document.
Technical names (`itsm` user, `/opt/itsm`, `itsm-web`, `itsm-worker`, `/etc/itsm/itsm.env`) are unchanged since 1.0.0, so upgrades are in place.

## Contents

1. [Install](#1-install-oracle-linux-9-as-root)
2. [First steps after install](#2-first-steps-after-install)
3. [Shared mailboxes → tickets](#3-shared-mailboxes--tickets-up-to-five)
4. [Active Directory](#4-active-directory-user-management)
5. [Tenancy and roles](#5-tenancy-and-roles)
6. [Modules](#6-modules)
7. [Operations](#7-operations)
8. [Backup and restore](#8-backup-and-restore)
9. [Development](#9-development)
10. [Known limits](#10-known-limits)
11. [Unreleased work in the repository](#11-unreleased-work-in-the-repository)
12. [Requirements coverage](#12-requirements-coverage)

## 1. Install (Oracle Linux 9, as root)

```bash
tar xzf service-operations-<version>.tar.gz && cd service-operations
./install.sh --domain servicedesk.example.com --admin-email you@example.com --admin-name "Your Name" --timezone Africa/Nairobi
```

| Option | Meaning |
|---|---|
| `--domain NAME` | Host name users open (required) |
| `--admin-email EMAIL`, `--admin-name "Name"` | Create the first platform administrator; the one-time password is printed at the end |
| `--timezone ZONE` | Application time zone (default `Africa/Nairobi`) |
| `--cert FILE --key FILE` | Your own certificate; otherwise a self-signed one is created |
| `--no-tls` | Plain HTTP (testing only) |
| `--demo` | Load a small demo data set (`scripts/seed-demo.js`) |
| `--skip-tests` | Do not run the tests before starting |
| `--offline-bundle FILE` | Use a `node_modules.tar.gz` built by `scripts/make-offline-bundle.sh` |

What it does: installs Node, PostgreSQL 15 and Nginx; creates the `itsm` OS user and database role (peer authentication over the unix socket, so
there is no database password); copies the app to `/opt/itsm/app`; writes `/etc/itsm/itsm.env` with a generated `SESSION_SECRET`; **runs the unit and
integration tests against a temporary database `itsm_test`** and stops if they fail; runs the migrations; configures Nginx (`deploy/nginx-itsm.conf.template`
and `deploy/itsm-proxy.inc`), SELinux and firewalld; enables and starts `itsm-web` and `itsm-worker`; installs the daily backup timer and the 5-minute health check.

Guards: it refuses to continue if `/var/lib/pgsql/data` belongs to a different PostgreSQL major version, or if Nginx already serves the same
`server_name`. Use a different `--domain` or remove the old site first.

**Offline servers.** On a machine with internet run `scripts/make-offline-bundle.sh` (all dependencies are pure JavaScript), copy
`node_modules.tar.gz` to the server and pass `--offline-bundle node_modules.tar.gz`. Installing needs no internet, but the worker **does** need
outbound HTTPS to `login.microsoftonline.com` + `graph.microsoft.com` (Microsoft 365) or `oauth2.googleapis.com` + `gmail.googleapis.com` (Google)
for those mailboxes. Behind a proxy, see `NODE_USE_ENV_PROXY` / `HTTPS_PROXY` in `deploy/itsm.env.example`.

Uninstall: `./uninstall.sh` (keeps data) or `./uninstall.sh --purge-data`.

### Upgrading

Unpack the new release and run `./install.sh` again with the same options. Migrations are applied once each, in order (`scripts/migrate.js`); existing
data, the env file and mailboxes are kept. Compare `/etc/itsm/itsm.env` with `deploy/itsm.env.example` for new settings, then
`systemctl restart itsm-web itsm-worker`. See `CHANGELOG.md` for what each version changes.

Points to know when coming from older versions:

* **From 1.0.0:** IMAP mailboxes are read by arrival order, not by the unread flag, and processed mail is no longer marked as read unless you tick that box.
* **From before 1.3.0:** the one-CSID-per-customer rule is only switched on in the database if no existing customer has several CSIDs; nothing is deleted.
* **From before 1.9.0:** AD group → role mappings are gone. Existing AD accounts keep the role they had; the AD service-account password is now typed
  on the Users page (an `LDAP_BIND_PASSWORD` in the env file keeps working until you do).
* **Migration 015** makes the audit log append-only and hash-chained (section 6, *Security controls*). After it, rows in `audit_log` cannot be updated,
  deleted or truncated with ordinary SQL.

## 2. First steps after install

1. Open `https://<domain>/login` and sign in with the administrator printed by the installer. Platform administrators must enrol **MFA**
   (authenticator app; type the key, there is no QR code).
2. User menu → Administration → **SLA policies**: the seeded Platinum / Gold / Standard targets are **placeholders**. Enter your contract values and public holidays.
3. Administration → **Service catalogue**: review the services you offer. Then **Customers**: create a customer (its one CSID is created with it) →
   sites → services (from the catalogue) → contracts → customer users. Assign the **execution engineer** (primary and backup) per service or contract.
4. Administration → **E-mail**: set up the mailboxes (section 3). Put outgoing mail settings (`SMTP_*`, `MAIL_FROM`) in `/etc/itsm/itsm.env`;
   with `SMTP_HOST` empty, e-mails are only written to the log.
5. Administration → **User management** (optional): connect Active Directory and import staff (section 4). Keep one **local** platform administrator as a break-glass account.
6. Administration → **Settings**: priority matrix, categories, resolution codes, SLA pause statuses, reminder days, currencies, tender and pipeline
   options, MFA-required roles.

After editing `/etc/itsm/itsm.env`, run `systemctl restart itsm-web itsm-worker`. `APP_NAME=` changes the display name.

### Environment file (`/etc/itsm/itsm.env`)

| Variable | Default | Purpose |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | Public address; `https://` turns on secure cookies |
| `HOST`, `PORT` | `127.0.0.1`, `3000` | Where `itsm-web` listens (Nginx proxies to it) |
| `TRUST_PROXY` | `1` | Express proxy hops |
| `SESSION_SECRET` | – | **Required**, at least 32 characters. Also the key for stored secrets (AD password); changing it means retyping them |
| `SESSION_IDLE_HOURS` | `8` | Session cookie lifetime (rolling) |
| `APP_TIMEZONE` | `Africa/Nairobi` | Time zone for SLA calendars, deadlines and reports |
| `APP_NAME` | `Service Operations (Ops)` | Display name |
| `PGHOST`, `PGUSER`, `PGDATABASE` | unix socket, `itsm`, `itsm` | Database |
| `STORAGE_DIR` | `/var/lib/itsm/storage` | Attachments and original e-mails |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASSWORD`, `MAIL_FROM` | empty, `587`, `false` | Outgoing mail |
| mailbox secret variables | – | One per mailbox; you choose the names on the E-mail page (section 3) |
| `LDAP_BIND_PASSWORD` | – | Optional fallback for the AD service-account password |
| `AV_COMMAND` | – | Optional virus scanner run on each upload (exit code 1 = infected), e.g. `clamscan --no-summary` |
| `LOCKOUT_ATTEMPTS`, `LOCKOUT_MINUTES` | `5`, `15` | Account lockout |

## 3. Shared mailboxes → tickets (up to five)

Open **Administration → E-mail**. Two mailboxes (Security, IT Services) are seeded switched off; add up to five in total. For each one choose
**how to read it**, the **queue** its tickets go to (Security is restricted to staff with Security access), category, default priority, starting tier
and SLA policy. Secrets are not typed into the browser: the page holds only the *name* of an environment variable, and the value lives in
`/etc/itsm/itsm.env` (`chmod 640 root:itsm`). Use **Test connection**, then tick **Enabled**. The worker picks changes up within a minute.

Processing is the same for every provider (`src/services/inbound.js`):

* each message is stored once (by Message-ID) and its original `.eml` is kept;
* it is matched to a customer by sender; replies are threaded by our Message-ID or the `[REF]` in the subject;
* unknown senders, failed SPF/DKIM and unauthorised repliers go to the **verification queue**; automatic replies and loops are ignored;
* a message that fails three times is parked as *failed* (visible and reprocessable) so it cannot block the mailbox;
* on first connection only **unread mail from the last two days** becomes tickets;
* replies and acknowledgements carry the Reply-To of the mailbox the ticket came in through.

**Monitoring** (`src/services/mailhealth.js`): each mailbox shows its health, last successful check, last message and messages in 24 hours. After three
failed checks (or no success for the configured minutes) supervisors get one alert, the dashboard shows a red banner, and a recovery e-mail follows.
The 5-minute health check also logs enabled mailboxes in error.

### 3a. Microsoft 365 / Exchange Online (Graph), recommended
The application signs in as itself (client credentials) and reads only the mailboxes you allow.
1. Entra admin centre → *App registrations* → New, single tenant. Note the **Directory (tenant) ID** and **Application (client) ID**.
2. *Certificates & secrets* → New client secret → put the **value** in the env file (e.g. `M365_CLIENT_SECRET=...`). Note its expiry date.
3. *API permissions* → Microsoft Graph → **Application** → **Mail.Read** (**Mail.ReadWrite** only for "mark processed mail as read") → *Grant admin consent*.
4. **Limit the app to the shared mailboxes**, otherwise Mail.Read covers every mailbox in the tenant:
   ```powershell
   New-DistributionGroup -Name "ServiceDesk-Mailboxes" -Type Security -Members help@contoso.com,security@contoso.com
   New-ApplicationAccessPolicy -AppId <client-id> -PolicyScopeGroupId ServiceDesk-Mailboxes@contoso.com -AccessRight RestrictAccess -Description "Service Operations (Ops)"
   Test-ApplicationAccessPolicy -Identity help@contoso.com -AppId <client-id>
   ```
   (or "RBAC for Applications" where your tenant offers it). Shared mailboxes need no licence for this.
5. In the application choose *Microsoft 365 (Graph)*, enter the address, tenant ID, client ID and the variable name, then **Test connection**.

### 3b. Google Workspace (Gmail API)
1. Google Cloud console: create a project, enable the **Gmail API**, create a **service account** with domain-wide delegation and save its JSON key
   on the server (e.g. `/etc/itsm/google-sa.json`, `root:itsm`, `640`); set `GOOGLE_SA_KEY_FILE=/etc/itsm/google-sa.json`.
2. Admin console → Security → API controls → *Domain-wide delegation* → add the client ID with scope
   `https://www.googleapis.com/auth/gmail.readonly` (`gmail.modify` only for "mark as read").
3. In the application choose *Google Workspace*, enter the mailbox address (the user that is impersonated) and the variable name.
   Google Groups collaborative inboxes cannot be read this way.

### 3c. Plain IMAP
For Exchange on-premises, Zoho, Fastmail, cPanel hosts and similar: host, port, user and the password variable name. Microsoft 365 normally has
password IMAP switched off; use Graph there.

### Outgoing mail
All e-mail goes through the `notifications` outbox table with retry and back-off; a final failure alerts supervisors. Sending is **SMTP only**
(`SMTP_*` in the env file). For Microsoft 365 use an SMTP relay/connector; for Google use `smtp-relay.gmail.com` with IP allow-listing.

## 4. Active Directory (User management)

AD does two things: an administrator **imports people** from it, and it **checks their password** at sign-in. Roles never come from AD groups.
Everything is in the "Active Directory" card on **Administration → User management** (platform administrators).

1. **Connection settings**: the **Server** (`dc1.corp.local`), the **Domain** (`corp.local`) and a read-only **Service account** (`svc-itsm`,
   `CORP\svc-itsm` or `svc-itsm@corp.local`) with its **Password**. Tick **Allow imported people to sign in with their Active Directory password** and **Save**.
   The password is stored encrypted (AES-256-GCM, key derived from `SESSION_SECRET`, `src/lib/secrets.js`) and never shown again.
   **Advanced**: port (636 by default; 389 always upgrades to TLS), search base (derived from the domain), and a CA file for an internal CA
   (e.g. `/etc/itsm/ad-ca.pem`; Node does not use the system trust store). The certificate is always checked.
2. **Test connection** reports how many people it found, or why it could not connect.
3. **Import users**: search, tick, choose one role, **Import ticked people**. Name, e-mail and account are read from the directory. People disabled in AD,
   without an e-mail address or already having an account are skipped with the reason shown.
4. Imported people sign in with their AD user name (`jdoe`, `jdoe@corp.local`) or e-mail address and their Windows password. **People not imported cannot sign in.**

Rules: local accounts never use the directory, and an AD account never takes over a local one. An **hourly check** switches off imported people who were
deleted or disabled in AD and ends their sessions; it does nothing when the directory cannot be reached and never switches off the last active platform
administrator. MFA still applies. Customer users are not read from AD.

## 5. Tenancy and roles

* The **customer is the tenant**; one host name serves everyone. Customer users are bound to one customer taken from the **session**, never from request data.
* The database enforces it too: tickets, services, contracts and renewals use composite foreign keys, so a row cannot point at another customer's CSID, service, contract or site.
* Staff roles (`src/lib/perms.js`): `platform_admin`, `service_manager`, `contract_manager`, `agent`, `engineer`, `security_analyst`, `auditor`,
  `management`, `bd_manager`, `bid_manager`, `technical_team`, `sde`, `finance`, `legal`, `dept_head`, `readonly`. Customer roles: `customer_admin`, `customer_user`.
* The left menu lists only the modules a role may use. Business roles without ticket access land on the Operations Overview.
* The **Security** queue is visible only with `security.view` (platform admin, security analyst): other staff do not see those tickets in lists, search, reports or e-mails.
* The User Manual (`/manual`) contains a "Who can do what" table generated from the live permissions.

## 6. Modules

| Module | Path | Code |
|---|---|---|
| Staff dashboard / customer portal | `/`, `/portal` | `routes/portal.js`, `services/dashboard.js` |
| Tickets, verification queue | `/tickets` | `routes/tickets.js`, `services/tickets.js` |
| Customers, sites, CSIDs, services | `/customers` | `routes/customers.js` |
| Service Catalogue | Administration | `routes/catalogue.js`, `services/catalogue.js` |
| SLA policies | Administration | `routes/sla.js`, `lib/sla.js`, `services/watch.js` |
| Contracts | `/contracts` | `routes/contracts.js`, `services/contracts.js`, `services/contract_reports.js` |
| Tender Management | `/tenders` | `routes/tenders.js`, `services/tenders.js`, `services/tender_reports.js` |
| Pipeline Tracker, SDE | `/pipeline` | `routes/pipeline.js`, `services/pipeline.js`, `services/pipeline_reports.js` |
| Projects | `/projects` | `routes/projects.js`, `services/projects.js` |
| Operations Overview | `/operations` (`/business` redirects) | `routes/operations.js`, `services/operations.js` |
| Service Desk Reports | `/reports` | `routes/reports.js`, `services/ticket_reports.js` |
| E-mail (mailboxes) | Administration | `routes/mail.js`, `services/inbound.js`, `services/providers/` |
| Administration, users, audit | Administration | `routes/admin.js`, `services/directory.js` |
| User Manual | `/manual` | `routes/manual.js`, `lib/manual.js` |

* **SLA**: calendar-aware (time zone, service windows, holidays), per priority P1–P4; priority = impact × urgency (configurable). Timers pause in the pause
  statuses and resume with the remaining time preserved. The worker flags warnings and breaches, notifies and escalates.
* **Execution engineer**: dated assignments; reassigning closes the old row. Routing: primary → backup → supervisors. Audited.
* **Service Catalogue**: service managers add, edit, retire and re-order entries; customers see the active ones. A customer has **exactly one CSID**; each
  service can be covered by **any number of contracts**. A ticket's SLA comes from the newest contract in force that has an SLA policy.
* **Contracts** (old `/renewals` links redirect): customer, supplier and partner contracts. Status follows the dates (*Active → Expiring soon → Expired*)
  unless set to *Renewal in progress, Suspended, Terminated* or *Closed*. Obligations, payment schedule, SLA targets and measured performance, amendments,
  versioned documents, legal / finance / management reviews, history. Reminders at 90/60/30/14/7 days (configurable), weekly escalation, eight reports.
* **Tender Management**: fourteen statuses with allowed transitions only, the standard bid checklist, team, internal reviews, evaluation log, documents.
  Submission needs the method and approved technical, commercial and management reviews (switchable). Reminders at 14/7/3/1 days. An award or loss moves the
  linked opportunity to Won / Lost; an awarded tender offers "Register the contract". Dashboard and seven reports.
* **Pipeline Tracker**: ten stages with configurable probabilities, activities, proposals, contacts, board and list, weighted value, monthly forecast,
  win rate, mandatory lost reason, tender link, escalation with a reason; six reports.
* **SDE**: an SDE sees **only** the opportunities assigned to them (others return 404), updates their own tasks, records site assessments, BOM, solution
  design and resources, and cannot change customer, value, stage or owner. Overdue tasks are e-mailed weekly. Opportunity Support Report as screen, PDF and Excel.
* **Projects**: manager, team, status, health, dates, budget, link to the won deal and contract, tasks and milestones, progress computed from tasks,
  escalation flag, activity log. A won deal has **Start a project**.
* **Operations Overview**: weekly executive dashboard with twelve tiles compared with the week before, Key Highlights (two sentences typed per week),
  Status Summary and escalated items. Each tile appears only if the viewer may see the records behind it.
* **Service Desk Reports**: 17 reports in seven categories (plus a Security report with Security access), each on screen and as Excel, PDF and CSV,
  filtered by period and customer. Excel, PDF and charts are generated in-house (`lib/xlsx.js`, `lib/pdf.js`, `lib/charts.js`, server-side SVG).
* **Search**: the top-bar box searches tickets (`/tickets?q=` for staff, `/portal/tickets?q=` for customers).
* **Themes**: Default (navy, teal, mint), Service Green, Sunset Orange, Match Device, Ocean Blue, Midnight Dark, chosen per person with the palette icon
  next to the bell. The side menu collapses to icons.
* **Security controls**: scrypt passwords (12+ characters), lockout, TOTP MFA, CSRF tokens, strict CSP (no inline script or style), upload allow/deny lists,
  size limit and optional virus scan, immediate effect of deactivation, filter-injection-safe directory lookups, and an audit log that is append-only
  and SHA-256 hash-chained in the database (migration 015; `select audit_verify();` returns `null` when the chain is intact).

### Background worker (`src/worker.js`)

One worker runs at a time (PostgreSQL advisory lock). Each loop, on its own interval:

| Job | Every |
|---|---|
| Notification outbox | 15 s |
| SLA watch, mailbox health | 60 s |
| Each enabled mailbox | its poll interval (default 60 s, minimum 30 s) |
| Retry failed inbound mail | 2 min |
| Auto-close resolved tickets | 15 min |
| Contract, tender and pipeline reminders; AD check; expired-session cleanup | 1 h |

## 7. Operations

| Task | Command |
|---|---|
| Status | `systemctl status itsm-web itsm-worker` |
| Starts at boot? | `systemctl is-enabled itsm-web itsm-worker nginx postgresql` |
| Logs | `journalctl -u itsm-web -u itsm-worker -f` |
| Health | `curl -s http://127.0.0.1:3000/healthz` |
| Health-check problems | `journalctl -t itsm-health` |
| New admin / reset password | `cd /opt/itsm/app && sudo -u itsm env $(cat /etc/itsm/itsm.env \| xargs) node scripts/create-admin.js --email a@b.c --name "A B" --role platform_admin --password '...'` |
| Run migrations | `cd /opt/itsm/app && sudo -u itsm env $(cat /etc/itsm/itsm.env \| xargs) node scripts/migrate.js` |
| Demo data (small set) | `node scripts/seed-demo.js` |
| Demo data (full set) | `node scripts/demo-data.js load \| status \| remove` |

Demo users sign in with `Demo-Passw0rd-2026!`. **Never load demo data on production**; `demo-data.js remove` deletes only demo rows
(customer codes starting `DEMO`, addresses at `@demo.invalid`, records tagged `[DEMO]`).

The health check (`/usr/local/sbin/itsm-healthcheck`, every 5 minutes) writes one `err` line per problem with tag `itsm-health`: web not answering,
worker / PostgreSQL / Nginx down, a disk over 85 %, the TLS certificate expiring within 21 days, no database backup newer than 2 days, or a mailbox in error.

## 8. Backup and restore

A timer runs `/usr/local/sbin/itsm-backup` daily: `pg_dump` plus a tar of `/var/lib/itsm/storage` (attachments, original e-mails) into
`/var/backups/itsm`, keeping 14 days (`KEEP_DAYS`). **Copy these off the server.** Restore (rehearse on a spare machine):

```bash
systemctl stop itsm-web itsm-worker
runuser -u postgres -- dropdb itsm && runuser -u postgres -- createdb -O itsm itsm
gunzip -c /var/backups/itsm/itsm-db-YYYYMMDD-HHMMSS.sql.gz | runuser -u postgres -- psql -d itsm
tar -C /var/lib/itsm -xzf /var/backups/itsm/itsm-files-YYYYMMDD-HHMMSS.tar.gz
chown -R itsm:itsm /var/lib/itsm/storage && restorecon -R /var/lib/itsm
systemctl start itsm-web itsm-worker
```

`/etc/itsm/itsm.env` and any key or CA files in `/etc/itsm` are **not** in the backup: keep a copy in your password vault. Without the same
`SESSION_SECRET`, the stored AD password cannot be decrypted and must be retyped.

## 9. Development

```bash
npm install
npm test            # unit + integration tests (needs PostgreSQL; the installer uses a temporary database itsm_test)
npm run test:unit   # unit tests only, no database
npm run migrate     # apply migrations/*.sql
npm start           # web on HOST:PORT
npm run worker      # background worker
```

Configuration comes only from environment variables (`src/config.js`); `SESSION_SECRET` must be at least 32 characters.
`scripts/check-views.js` checks the EJS views and the CSP rules (no inline script or style).

```
src/server.js, src/app.js   web entry point and Express setup
src/worker.js               background jobs
src/routes/                 HTTP handlers, one file per module
src/services/               business logic and SQL
src/services/providers/     mailbox readers: Graph, Gmail, IMAP
src/lib/                    shared helpers (SLA, permissions, PDF, XLSX, charts, LDAP, TOTP, secrets …)
src/views/                  EJS templates (staff/, portal/, admin/, auth/, partials/)
src/public/                 CSS, browser script, icon
migrations/                 numbered SQL, applied once each in order
deploy/                     systemd units, Nginx template, backup / health-check / restore-test scripts, env example
scripts/                    migrate, create-admin, demo data, offline bundle, view checks
test/unit, test/integration node:test suites
```

## 10. Known limits

* Microsoft 365 and Gmail mailboxes are **read** through their APIs; **sending** is SMTP only. No OAuth2 for IMAP. Microsoft sovereign clouds are not supported.
* A mailbox polls on a timer; there is no push or webhook. Google Groups collaborative inboxes cannot be read.
* MFA enrolment is by typing the key (no QR, no recovery codes; an administrator resets MFA). Directory users cannot change their password here.
* Directory sign-in is for imported staff only; no SSO, SAML or OIDC; AD groups are not used.
* The top-bar search covers tickets only.
* No mobile or offline app. The PDF writer uses the built-in Helvetica font (Latin text only). SLA targets and seeded mailbox addresses are placeholders.
* The integration tests and `install.sh` have not been run against a real Microsoft 365 tenant, Google Workspace or domain controller; report the
  installer's test output if anything fails on first run.

## 11. Unreleased work in the repository

The latest commit adds code and migrations beyond 1.9.0 (`CHANGELOG.md` stops at 1.9.0). The **migrations run** on install or upgrade, but most of
the new application code is **not yet connected**: nothing in `src/app.js` or `src/worker.js` loads it, so it has no effect at run time.

| Item | Files | State |
|---|---|---|
| Knowledge Base: articles with categories, versions, votes, ticket links; staff `/kb`, customers `/portal/help` | `migrations/013`, `routes/kb.js`, `services/kb.js`, `lib/markdown.js`, `views/staff/kb*.ejs`, `views/portal/help*.ejs` | Tables created. Route not mounted, and `kb.view` / `kb.write` / `kb.publish` are not defined in `lib/perms.js` |
| Global search (tickets, customers, links to other modules) | `routes/search.js`, `lib/search.js`, `views/search.ejs` | Route not mounted; the top bar still posts to `/tickets` |
| Mailbox secrets typed on the E-mail page, stored encrypted | `migrations/014` | Column `mailboxes.secret_enc` added; not used by the mailbox code |
| SMTP settings on the E-mail page, encrypted password, plain-language errors | `lib/smtp.js`, `services/outgoing.js` | Not used; mail still goes out with `SMTP_*` from the env file |
| SLA breach history, forced first password change, one-time TOTP codes | `migrations/015` | Columns `sla_breaches`, `must_change_password`, `totp_last_step` added and back-filled; not read or written by the app |
| Tamper-evident audit log | `migrations/015` | **Active** (database triggers) |
| Daily housekeeping: retention of notifications / tickets / audit log, audit-chain check, TOTP secret encryption | `services/maintenance.js`, `lib/twofactor.js`, `retention_*` settings | Settings seeded; `maintenance.daily()` is not scheduled by the worker |
| Idle sign-out in minutes (`SESSION_IDLE_MINUTES`, default 10) and "you were signed out" notice | `lib/session.js` | Not used; `SESSION_IDLE_HOURS` still applies |
| Monthly restore test of the newest backup | `deploy/itsm-restore-test.{sh,service,timer}` | Not installed by `install.sh`. It also expects encrypted backups and a config bundle (`backup.pass`, `itsm-config-*.tar.gz.enc`) that `itsm-backup.sh` does not yet produce |
| Full demo data set with clean removal | `scripts/demo-data.js`, `services/demo.js` | Works from the command line; `install.sh --demo` still uses `seed-demo.js` |

## 12. Requirements coverage

**Done** = implemented · **Partial** = implemented with the stated limits · **Not in this release** = left for later.

| Area | Status | Notes |
|---|---|---|
| Multi-customer tenancy and isolation (NFR-001, CUS) | Done | Session-derived scope plus composite foreign keys |
| Customers, sites, CSIDs, services, contracts | Done | One CSID per customer; a service can have many contracts |
| Roles and permissions | Done | Fixed role set |
| Customer portal | Done | |
| Incidents, requests, priority matrix, assignment, escalation, reopen, resolution codes | Done | |
| SLA calendars, pause/resume, warnings, breaches | Done | Targets are placeholders until you enter contract values |
| Security queue separation (SEC) | Done | |
| Dashboards and reports | Done | Screen, CSV, Excel and PDF |
| Audit log (AUD) | Done | Append-only, hash-chained; automatic daily check not yet scheduled |
| Execution-engineer notification (SLA-009..014, AUTO-006) | Done | |
| Shared mailboxes, e-mail-to-ticket (EMAIL-001..013) | Done | Up to 5; Graph, Gmail API, IMAP; health monitoring; SMTP sending |
| Contracts (CM-001..018, REN-001..012) | Done | |
| Tender Management (TM-001..015) | Done | |
| Pipeline Tracker and SDE (PT-001..030) | Done | |
| Service Catalogue, Projects, Operations Overview, User Manual | Done | |
| Directory integration (IAM, AD/LDAP) | Partial | Staff only; no SSO |
| MFA | Partial | TOTP without QR or recovery codes |
| Backup procedures (NFR-005) | Partial | Daily backup and health check; off-site copy is yours; restore test not yet installed |
| Knowledge base | Partial | Code and tables present, not yet connected (section 11) |
| Data retention | Partial | Settings and code present, not yet scheduled (section 11) |
| Field service, maintenance, assets/CMDB, vendors, problem / change / approvals, NOC/SOC integrations, billing, mobile/offline | Not in this release | |
