# Changelog

## 1.26.0
- **Time on tickets** (migration 025). Log the time spent with a reply (*Time spent*: 20, 1h 30m, 1:30 or 1.5h) or in the ticket's new **Time** box (the day, what was done, chargeable or not; chargeable by default unless the ticket is non-chargeable). The box shows the total and the chargeable part; your own entries can be removed within 7 days, a service manager can remove any. Each entry is noted in the ticket's internal history.
  - **Timesheet** in the menu: your week, day by day and per customer, with the chargeable total; service managers, finance and management can choose anyone or everyone. Download as Excel.
  - New report **Time spent per customer**: hours, chargeable and not, per customer for any period — the basis for invoicing support time.
- **Reply templates**. *Reply Templates* in the menu: canned replies with the formatting toolbar and placeholders ({{requester_name}}, {{customer_name}}, {{ticket_ref}}, {{ticket_subject}}, {{csid}}, {{agent_name}}). Pick one above the reply box on a ticket and it is filled in for that ticket and inserted at the cursor. Personal templates for everyone; service managers can share templates with the whole desk. The most used come first.
- **Automation rules**. *Administration, Automation rules*: rules applied to every new ticket from every channel (portal, e-mail, staff, phone, API). Conditions: channel, incident or request, customer, category, priority, words in the subject or description, the sender's e-mail domain. Actions: set impact and urgency (priority and SLA follow), move to the Security queue or another tier, assign to someone, add an internal note. Rules run in order (move them up and down), *Stop here* ends the chain, *Check against recent tickets* shows how many of the last 200 tickets a rule would have matched before you save it. What a rule did is written in the ticket's history; the list shows how often each rule ran. Service managers and administrators manage them; every change is audited.
- **Customer satisfaction from the e-mail**. The *resolved* e-mail (and the automatic close e-mail, if not yet rated) carries **one-click rating links** from 5 Excellent to 1 Very poor. No sign-in: the link is signed for that ticket and that person, opens a page to confirm and add a comment (so mail scanners that open links do not vote), and works for 30 days. Portal confirmations still take a rating as before.
  - A rating of **1 or 2** is e-mailed at once to the service managers with the customer's comment.
  - The rating and how it came in are on the ticket. New report **Satisfaction by engineer**, next to *Customer satisfaction* per customer.
- Demo data: five shared reply templates and one personal one, three automation rules, time logged on demo tickets across the week, and ratings that came by e-mail.
- User manual: *Time on tickets and timesheets*, *Reply templates*, *Automation rules*, *Customer satisfaction*; customers are told about rating from the e-mail.

## 1.25.0
- **Problem management** (migration 024). *Problems* in the menu: the cause behind recurring incidents. Open one from a ticket (or link a ticket to an existing problem), link the incidents and equipment, record the **root cause** and **workaround** and move it to **Known error**: the workaround then shows on every linked ticket. Write the known error up as a draft **Knowledge Base article** with one button, raise the **change** that fixes it, and resolve it with the permanent fix. History on every problem; P1 to P4 priority; a closed problem can be reopened.
- **Change management**. *Changes* in the menu: standard (pre-approved routine), normal and emergency changes, low/medium/high risk, with the impact, implementation plan, back-out plan, test plan, planned window (in the application time zone), owner, implementer, equipment affected and the problem it fixes.
  - Normal and emergency changes are **approved before they are scheduled** through the same Approvals as quotes and LPOs (by default a service manager or department head; **high risk** also management). All changeable in *Settings, Approvals*. Editing a draft or moving a scheduled change back to draft withdraws the approval.
  - Scheduling checks the plan, back-out plan, impact and window. *Start the work* and *Completed* / *Failed: backed out* record the actual times and the outcome (a note is required when it failed).
  - **Change calendar**: a month view of scheduled, running and finished changes; work that overlaps on the **same customer or the same equipment** is marked in red, and listed on the change page. On a phone it becomes a list of the days with changes.
  - The asset's history records the changes made to it.
- **Major incidents and service notices**. *Declare a major incident* from a ticket, or *Announce the maintenance* from a change: choose the customers affected, write in plain words, and optionally **e-mail** the customers' administrators (and the person who reported the ticket). Post updates (Investigating, Cause identified, Fixed and monitoring, Resolved); resolving closes the notice.
  - Customers see a **banner on every portal page** while an incident is open or maintenance is within 7 days, and a new **Service Status** page with the updates and the last 30 days.
  - Staff see open major incidents in a red banner on every page and as a count on *Service Notices* in the menu. Declaring and updating notices: service managers, agents and security analysts.
- Tickets have a *Problem and major incident* box: linked problems with their workaround, link to a problem, open a problem, raise a change, declare a major incident.
- Who can do what: engineers, agents, service managers, security analysts and the technical team manage problems and changes; managers, auditors, SDEs and read-only users see them.
- Demo data: two problems (one known error with its workaround, linked to tickets and equipment), six changes (completed, failed and backed out, scheduled and clashing on the calendar, a standard change, one high-risk change waiting for approval), an open major incident with updates, announced maintenance and an incident resolved last week.
- User manual: *Problems and known errors*, *Changes and the change calendar*, *Major incidents and service notices*, and *Service status* for customers.

## 1.24.0
- **Asset register (CMDB)** (migration 023): the equipment, licences and subscriptions at each customer site, and our own, with a tag (AST-000001), category, make, model, serial number, host name and IP address, quantity (licence seats), status (in stock, in use, under repair, retired, disposed), purchase date, **warranty end** and **expiry / end of support**, and links to the customer, site, **CSID**, **covering contract**, supplier and purchase order.
  - **Assets** in the menu: boxes for what is in use, warranties ending within 90 days, out of warranty, licences and support ending, expired, and under repair; search by tag, name, serial, host name, IP or model; filter by customer, category and status; download as Excel, PDF or CSV.
  - **Import from a spreadsheet** (CSV, with a downloadable template): customers by code or name, sites by name, CSIDs by number, everyday words for categories (switch, firewall, laptop, UPS, licence…), dates as 2026-12-31 or 31/12/2026. Every row is checked first; if any is wrong nothing is imported and each wrong row is listed. A serial number is registered once per manufacturer, so the same file cannot be imported twice.
  - **Tickets**: an *Equipment* box links the customer's equipment to the ticket and shows at once whether it is in warranty, out of warranty or its support has expired, and which contract covers it. The asset lists its tickets; a contract lists the equipment it covers; the customer's page summarises their equipment.
  - The **bell** tells those who manage assets when warranties or licences end within 30 days. The **search box** finds equipment by serial number, host name or IP address.
  - **Customer portal**: *Our Equipment* lists the customer's own equipment with warranty and renewal dates (without our notes or IP addresses).
  - Every change is kept in the asset's history and the audit log. Engineers, agents, service managers, security analysts, the technical team and procurement manage assets; contract managers, management, department heads, SDEs, auditors and read-only users see them. A customer with equipment cannot be deleted (suspend it instead).
  - Demo data: 21 items across the three demo customers and our own monitoring server, with warranties and licences ending soon or expired, one under repair, linked to open tickets, their contract, and a demo supplier and LPO.
  - User manual: *Assets: equipment and licences* for staff and *Our Equipment* for customers.
- **Fixed: forms that fill a customer's sites, CSIDs and contracts lost the values already chosen** when the page opened with a customer selected (an asset being edited, a new ticket shown again after a mistake, ticket verification). The choices now stay.

## 1.23.0
- **Approval of quotes and purchase orders** (migration 022). A quote above a set amount, or with a large discount, must be approved before it can be sent; every purchase order before it is issued, and a large order by a second approver as well.
  - **Defaults** (all changeable in *Settings, Approvals*): quotes at **UGX 20,000,000 / USD 5,000** and above, or with a discount of **10%** or more, are approved by finance, management or a department head; a quote in a currency without a limit always needs approval. Every LPO is approved by finance or a department head, and from **UGX 50,000,000 / USD 13,000** also by management.
  - The draft shows an **Approval** box saying whether approval is needed and why. **Ask for approval** sends it to the approvers: they see it on the **bell** and under the new **Approvals** menu entry with a count, and decide there or on the item (**Approve**, or **Decline** with a reason). *Sent* / *Issue* is offered only once approved.
  - **Nobody approves their own** quote or order (neither the person who asked nor the owner). A change to the draft after approval **withdraws** it, so what goes out is what was approved; an approval also only counts for the amount that was approved. After a first approval of a large order the second is asked for at once.
  - Every request and decision is in the item's history and the audit log. *Approvals* lists what is waiting for you, what you asked for and your recent decisions.
  - The demo data approves its sent quotes and issued orders, and leaves one quote and one LPO waiting for finance to try.
  - User manual: a new *Approvals of quotes and purchase orders* section.
- **Automatic tests on GitHub.** Every push and pull request runs the same checks as the installer on GitHub's machines: JavaScript syntax, the page templates, the shell scripts, all unit tests and all integration tests against a real PostgreSQL 15, on Node 22 and Node 20. The result shows as a tick or a cross on each commit and as the *Tests* badge in the README.
- **Security audit of the dependencies** on every push (fails on high or critical problems), and **Dependabot** opens a pull request each Monday when a dependency needs updating.
- **Security: nodemailer updated from 6.10 to 10.6.** The audit found 22 published problems in the old version of the library that sends e-mail (8 rated high: address-parsing denial of service, header injection, mail delivered to an unintended domain, file read through the raw message option). Version 10 fixes them all. Tested with the full suite and a real message to an SMTP server. Nothing to change in the settings.
- **Security: uuid** (used inside the Active Directory library) pinned to 11.1.1, which fixes a missing bounds check.
- **package-lock.json** is now part of the code, so the installer and the tests use exactly the versions that were tested.
- Fixed: the installer's demo-data test could pick a deal or contract created by an earlier test instead of the demo one.
- GitHub Actions updated to checkout v7 and setup-node v7 (Dependabot).
- Fixed: the Decline button style (a red outline, readable in every theme).

## 1.22.0
- **Company logo and name** (Settings, Company branding; migration 021). Upload your company logo (PNG or JPEG, up to 1 MB) and set the company name once, and the whole system carries them:
  - **Sign-in page, menu, customer portal and the request page:** "Service Operations (Ops)" with your logo centred beneath it, on a white tile so any logo reads on the dark colours. When the menu is collapsed, a small logo.
  - **Every PDF** (reports and list exports, quotes, purchase orders, the opportunity support report): your logo at the top of each page, and the company name in the footer. **Excel** exports carry the company name in their titles. Page titles in the browser tab use the company name.
  - **The logo takes the colours of each person's theme** (on by default; Settings, Company branding, *Recolour the logo to match each person's theme*). Dark parts of the logo become the theme colour (teal on Default, green, blue on Ocean, orange on Sunset) and white stays white, so the shapes still read. It is the same on screen (an SVG colour filter) and in every PDF (blend modes), for PNG and JPEG logos alike. Untick the box to always show the logo in its own colours.
  - Without a logo the company name is shown in its place; without either, nothing changes. *Remove logo* goes back to the product mark. Uploads and removals are audited; only people who may change Settings can do it.
  - The file is checked before it is kept: only real PNG and JPEG images (not SVG, GIF or WebP; at most 4000 x 4000 pixels), so nothing in it can run in a browser. It is served with nosniff and a closed content policy, and cached by browsers until it changes.
- **LPO tracking inside Suppliers & Contractors.** Purchase orders are no longer a separate menu entry: *Suppliers & Contractors* has two tabs, **Register** and **Purchase orders (LPO)**. The LPO tab opens with an **LPO tracker**: Drafts, Awaiting delivery, **Late** (issued and past the deliver-by date), Received and Closed, each with the number of orders and their value per currency, plus what is committed and not yet closed. Press a box to list those orders; choose a supplier to track only theirs. A new *Late* filter (also in the Excel, PDF and CSV export). Each supplier's page shows the same tracker for that supplier, and its order list now has the project, the deliver-by date and a *late* mark.
- **Demo data for every module.** Loading the demo now fills every screen and tab: contract obligations, payments, measured SLA performance, approvals, a variation and an extension; deal engineering tasks with history, proposals, solution designs and engineer effort; tender approvals, clarifications and scores; formatted replies on tickets; Knowledge Base votes; e-mail domains on the demo customers (for requests without signing in); supplier documents as real PDF files; and purchase orders at every stage of the LPO tracker. *Remove* takes all of it away again, including the stored files, and leaves every table as it was.
- **User manual:** a new *Demo data: trying the system* section lists every demo sign-in with its role and what it is good for, what the demo contains module by module, and how to try requests without signing in. It also covers the company logo and the LPO tracker.
- **Fixed: uploads on the 1.21 pages.** Attaching a supplier's quote or document (*Suppliers & Contractors*, Documents) and attaching a signed copy, delivery note or invoice to a purchase order were refused with "This form does not accept file uploads" in 1.21.0 and 1.21.1. Both work now.
- The company name moved from the Quotes card to its own box at the top of Settings; it is the same setting, so nothing needs re-entering.

## 1.21.1
- **Documents follow your theme.** Every PDF and Excel file you download (quotes, LPOs, the opportunity support report, and every list and report export) now uses the colours of the theme you are using: Default (deep navy bars, teal headings), Service Green, Ocean Blue or Sunset Orange; Match Device prints in its daytime green, because paper is light. Before, all documents were green. The colours are those of the person who downloads the file.

## 1.21.0
- **Suppliers & Contractors register** (menu: Suppliers & Contractors; migration 020). Contractors, subcontractors, distributors, vendors, consultants and third parties, with code (SUP-0001), status (active, on hold, inactive), TIN, registration number, contacts, payment terms and what they supply. Each has a page with its documents, the projects and tenders it is on, its purchase orders and its history. Excel, PDF and CSV export.
  - **Documents:** upload their quotes (reference, amount, date, validity), LPOs given to them outside the system, invoices, delivery notes, contracts, registration papers and tax clearance; each can be marked for a project, a tender or one of our LPOs. Downloads follow the register's access rules and are audited.
  - **On projects and tenders:** a *Contractors and suppliers* card lists who works on it and in what role, their documents for it and the LPOs raised for it; the project or tender manager adds and removes them there. It is written to the project's activity and the tender's history.
- **Purchase Orders (LPO)** (menu: Purchase Orders) for the new **Procurement officer** role. An LPO (LPO-000001) is raised for an active supplier, against their quote, a contract, a project, a tender or one of our quotes to a customer (back-to-back), from a *Raise LPO* button on each of those or from the list.
  - Lines, discounts and VAT as on quotes; Draft → Issued → Received → Closed, or Cancelled (an issued order needs a reason). An issued order is fixed. The A4 PDF has the company details, the supplier with TIN and contact, the lines, totals, what it is against, delivery, terms and signature boxes; drafts are marked DRAFT; internal notes are never printed.
  - Signed copies, delivery notes and invoices are attached to the order and kept with the supplier's documents. Every step is audited and written to the supplier's history and the project's activity.
  - **Access:** procurement and the administrator raise and issue LPOs; finance, the service delivery manager, management, department heads, auditors and read-only viewers can see them. The register is kept by procurement, the service delivery manager, contract, bid and department managers; everyone who works on projects or tenders, and finance, can see it.
  - **Settings → Quotes and purchase orders:** standard LPO terms and the default delivery address (the company details are shared with quotes).
  - The demo data has a procurement officer (procurement@demo.invalid), three suppliers on demo projects and a tender, and two LPOs (one issued for a project, one draft against a contract).
  - **Not yet:** approval of an LPO before it is issued (planned), e-mailing an LPO from the application, and matching invoices against orders.

## 1.20.1
- The wave shapes in the menu (the corner of the name block and the band at the foot of the menu) are replaced by the rotated-squares pattern of the sign-in page, in the colours of the theme in use. The version at the foot sits on a small label so it stays readable on any theme.

## 1.20.0
- **New sign-in page layout.** A form panel on the left (product name, *Sign in*, the two fields with underlined inputs, a full-width SIGN IN button, the password and "No account?" hints, the version at the bottom) and an abstract pattern of overlapping squares on the right, drawn only in the colours of the theme in use. On a phone only the form panel is shown. Migration 019.
- **Optional sign-in notice.** Settings → *Sign-in page* → Notice (for example an authorised-use warning). When set, it appears under the fields with an "I agree" box that must be ticked; the server refuses a sign-in without it (before checking the password, so it does not count as a failed attempt). Empty by default.
- **Midnight Dark removed.** Five themes remain: Default, Service Green, Sunset Orange, Match Device (green by day, dark when the device is in dark mode) and Ocean Blue. Anyone who had chosen Midnight Dark now gets Default.

## 1.19.1
- Test-only: the formatting test expected "the guide (link)" in the customer e-mail, but the comment it sends says "the ~~old~~ guide", which correctly becomes "the old guide (link)". No application code changed since 1.19.0.

## 1.19.0
- **Formatted comments and notes.** The comment box on a ticket (replies and internal notes), the description on New ticket, the customer's comment and request forms and the *Raise a request* form are now a small word-processor box: bold, italic, underline, strike-through, heading, bulleted and numbered lists, quote, code and links, from a toolbar or with Ctrl+B / Ctrl+I / Ctrl+U. Text pasted from Word or a web page keeps its bold, italics, lists and links and drops everything else. Migration 018.
  - Stored as the same safe mark-up as the Knowledge Base (now with ++underline++ and ~~strike-through~~); the server escapes everything and turns only those marks into HTML, so a comment can never carry a script or a style. Links must be http, https or mailto.
  - Customers receive formatted replies as tidy plain text by e-mail (lists kept, links written out). Comments and tickets that arrived by e-mail, and everything written before this version, are shown exactly as written.
  - Without JavaScript the plain text box still works.
- **The SLA stands out on the ticket page.** A coloured bar under the ticket title states the most urgent SLA fact (for example "SLA breached: restoration is overdue by 1h 35m" or "SLA at risk: resolution is due in 40m"). The SLA card is now first in the right-hand column, coloured by state with a badge (Breached, Missed, At risk, Paused, On track, Met), and each target shows its own state and the time left or how late it is, counting down while the page is open. "At risk" means due within the hour or less than a quarter of its time left.

## 1.18.1
- Pages shown to people who are not signed in (Raise a request, Not available, error pages) now have the footer centred at the bottom of the window, under the centred card. It was at the left edge.

## 1.18.0
- **Requests without signing in.** People at a customer can raise a ticket without an account, at **/request** (linked from the sign-in page as *Raise a request*). Migration 017.
  1. They give their work e-mail address and their organisation's **CSID**. The address must be on one of the customer's **e-mail domains** (new field on the customer page, exact domain match) and the CSID must be that customer's active CSID.
  2. A 6-digit code is e-mailed to the address (valid 15 minutes, 5 tries, used once; only a keyed hash is stored, and the code is not kept in the outbox).
  3. With the code they see the customer, the CSID and its **active services**, and raise an incident or request on it (name, optional phone, service, category, impact, urgency, subject, description). They get the usual acknowledgement by e-mail; e-mailed replies from that same address (passing the sender checks) are added to the ticket.
  - The first step gives the same answer, takes the same time and has the same limits whether or not the details match, so it cannot be used to find out which addresses, domains or CSIDs exist. Limits: 3 codes per address and 30 per network address per hour, 5 tickets per confirmed session (30 minutes); nginx throttles /request like sign-in.
  - A registered customer user with the same address gets the ticket linked to their account. Tickets are marked in their history and audited (guest_ticket_created). Domain changes are audited; a domain can belong to one customer only.
  - **Settings → Tickets:** *Requests without signing in* (allowed by default; it only works for customers with e-mail domains set, and only while outgoing mail is set up).
  - **Upgrade note:** run the installer so the nginx configuration gets the /request throttle.

## 1.17.0
- **Quotes.** New **Quotes** module (menu: Quotes; migration 016). A quote has a customer or prospect, contact, currency, quote date, valid-until date, tax (name and rate), an introduction, terms, internal notes and priced lines (description, quantity, unit, unit price, discount %).
  Amounts and totals are calculated in cents so they never drift, and update as you type. Descriptions can be picked from the service catalogue.
  - **Aligned with opportunities:** start a quote from an opportunity and it takes the customer, contact, currency and title; the opportunity page lists its quotes; sending, accepting, declining and expiry are written to the opportunity's history; accepting can set the opportunity value to the quote amount before tax.
  - **PDF:** each quote downloads as an A4 PDF with your company details, the customer, the lines, discounts, tax, total and terms (drafts are marked DRAFT; internal notes are never printed). The list downloads in Excel, PDF or CSV.
  - **Lifecycle:** Draft → Sent → Accepted / Declined / Expired / Cancelled. A sent quote is fixed; changes are made as a new revision (QUO-000012 R2) and the earlier one is marked Superseded. Sent quotes past their date expire overnight.
  - **Access:** quote.view (the pipeline roles and finance) and quote.manage (administrator, service delivery manager, contract manager, business development and bid managers). Every create, status change, revision and PDF download is audited.
  - **Settings → Quotes:** company name, address, phone, e-mail, website and tax ID printed on every quote; default tax rate (18%) and name (VAT), validity (30 days) and standard terms.
  - Search finds quotes from the top bar (via the Quotes link), a customer with quotes cannot be deleted, and the demo data includes four sample quotes (sent, revised, accepted, draft).
  - **Not yet:** approval before sending (planned next), e-mailing the quote from the application, and quotes in the customer portal.

## 1.16.0
- **The search box in the top bar works.** It used to open the Tickets list with the open tickets only, so a resolved ticket never turned up, and it looked only at the subject, reference and sender address. It now opens a **Search** page.
  Staff find tickets in any status by reference, subject, sender name or address, customer name, CSID and words written on the ticket (internal notes included), see matching customers, and get one-click links to search Contracts, Tenders, Pipeline, Projects and the Knowledge Base for the same words (only the areas their role may use; each area applies its own access rules).
  Customers find their own tickets in any status, by reference, subject and the conversation (never internal notes), with a link to Help articles. Typing a ticket reference and pressing Enter opens that ticket straight away. The Tickets list search and the customer's *My tickets* search use the same matching.

## 1.15.3
- **Fix: "You were signed out because you were inactive" kept coming back.** The notice came from `?expired=1` in the sign-in address, so a refresh, a bookmark or an address-bar suggestion showed it again long after the time-out. It is now shown once per time-out (a short-lived cookie records that it was shown, and the next sign-in clears it), the address is cleaned in the browser, and the notice fades after 20 seconds.

## 1.15.2
- Test-only: the two-step lock test assumed the lock would arrive on the fifth wrong code; it arrives sooner because a replayed code also counts as a failure. The test now checks that the account locks within five attempts. No application code changed since 1.15.1.

## 1.15.1
- **Fix: a reply on a closed ticket.** The portal comment form refused a reply on a *closed* ticket outright; it now follows the same rule as a resolved one (a customer reply reopens it inside the reopen period, and is refused with a message after it). A cancelled ticket still refuses with a clear message.
- Three of the new 1.15.0 installer tests were corrected (a stale ticket object in one, a sign-in helper that expected a finished login in another, and the expected answer to a forged "close" request). No other code changed.

## 1.15.0 - "Version 1"
The review of operational consistency (ITIL ticket lifecycle, ISO/IEC 27001:2022 Annex A, OWASP ASVS), with every finding fixed. Migration 015.
- **Ticket lifecycle.** Allowed status moves are enforced and the status list offers only those: nothing closes directly (resolve first), a closed ticket can only be reopened, a cancelled ticket stays cancelled, and a ticket never goes back to *New*. The first response is a reply to the customer, a request for information, or a resolution; a move to In progress no longer counts.
- **A customer reply reopens a resolved or closed ticket** (portal and e-mail, inside the reopen period). After it, the portal refuses with a message and an e-mailed reply is kept with a note for staff. Before, the portal refused all replies on resolved tickets.
- **SLA history.** A missed target stays on the ticket (`sla_breaches`) when it is reopened or its priority changes; the staff page shows *Missed earlier* and the reports and dashboard count it as missed. Existing tickets are filled in from their flags and dates.
- **Customer notices.** An acknowledgement is e-mailed when a portal or staff-raised ticket is logged (with the response time in local time), and customers are told when service is restored and when a ticket is closed automatically. Times in e-mail are written in the configured time zone, with its name.
- **Mail waits instead of being lost.** While no mail server is set up, queued messages stay queued (up to 7 days) and go out when a server is saved; they were marked sent after only being written to the log.
- **Sign-in.** A password set by someone else must be changed at first sign-in; a changed password signs out other sessions; the same password cannot be chosen again; two-step codes work once; wrong codes count towards the same lock as wrong passwords; two-step secrets are stored encrypted (older ones are upgraded automatically); an administrator can reset someone's two-step verification (audited). The sign-in throttle in nginx is 20 requests a minute.
- **Audit log.** Tamper-evident: each entry carries the hash of the one before, ordinary statements cannot change or delete entries, a daily check finds the first altered entry, shows the result on the Audit page and e-mails administrators and auditors if it fails. It is evidence of tampering, not protection against a database superuser.
- **Retention.** New *How long records are kept* settings and a nightly clean-up: notifications (365 days), closed and cancelled tickets with their files, and the audit log (the last two default to keep for ever).
- **Backups.** Encrypted with a passphrase created at install (shown once: keep it in your vault), every file read back, the configuration in `/etc/itsm` included (encrypted only), an optional off-server copy (`BACKUP_COPY_TO` in `/etc/itsm/backup.conf`), a monthly restore test (`itsm-restore-test`) and health-check warnings. See README, Backup and restore.
- **Upgrade notes.** Existing temporary passwords are not forced to change; accounts created or reset from now on are. If `SESSION_SECRET` is ever changed, stored two-step secrets become unreadable and an administrator must reset them (as for the other stored secrets).

## 1.14.0
- **Mailbox passwords are typed on the E-mail page.** The IMAP password, the Microsoft 365 client secret and the Google service-account key (paste the JSON) are entered in the mailbox form, stored encrypted (AES-256-GCM, like the Active Directory and outgoing mail passwords)
  and never shown again; an empty box keeps the saved one, and a tick removes it. Changing how a mailbox is read clears the old secret. The variable named under *Advanced* still works for mailboxes set up earlier, and a typed secret is used first. Error messages now say "enter it in the box
  below". Migration 014. (Active Directory and outgoing mail already took their passwords on the page.)

## 1.13.0
- **Knowledge Base.** New **Knowledge Base** in the staff menu and **Help Articles** in the customer portal (migration 013). Articles have a title, summary, category, tags, a review-by date and an audience (*Staff only* or *Staff and customers*). Staff search by word, part of a title or tag.
  Writers (those who work tickets, technical teams, service delivery engineers) create and edit; service delivery managers and administrators publish, take back to draft, archive and manage categories. A customer article that is live can only be changed by a publisher.
  Every save keeps a version with a note, and a version can be restored. Readers vote **Yes, it helped / No**. The ticket page has a **Knowledge Base** card: link an article, search for the same problem, or **write an article from a solved ticket** (the problem and the fix are copied in).
  Customers see the customer articles linked to their request, and a hint on the new-request page. Article text is plain with a few marks and is escaped: no script or markup can be added. User Manual sections for staff and customers; demo data includes seven articles.
- **Fix: the customer's Service Catalogue shows only what is on their own CSID.** Customers used to see every active catalogue entry. They now see only the active services on their account, each with its CSID, and the dashboard tiles follow the same rule. Ended services and retired entries are not listed.

## 1.12.0
- **Outgoing mail is set up in the browser.** New **Outgoing mail** card at the top of Administration → E-mail: mail server, connection security (STARTTLS 587, SSL/TLS 465, or None 25 with a warning), optional user name and password, From address and sender name,
  and **Send test email**. The password is stored encrypted and never shown again. A change applies at once in the web service and the worker, with no restart. Failures are explained in plain words (wrong password, nothing listening, port and security do not match, relay or
  From address refused, untrusted certificate, name not found). An install that already has `SMTP_*` in `/etc/itsm/itsm.env` keeps working until a mail server is saved on the page. The page warns when nothing is set up, because notifications are then only written to the log.
  Security: STARTTLS is demanded (no silent downgrade), certificates are checked unless the administrator ticks the Advanced box, and the sender name cannot inject mail headers.
- **Login page.** The application name beside the icon is about twice as large and is now the main heading; the phone layout no longer lets the wave cover the text.

## 1.11.0
- **Idle sign-out after 10 minutes.** Anyone who has done nothing for 10 minutes is signed out. Working in the app (clicking, typing, scrolling, in any open tab) keeps the session alive; a bar appears one minute before the end with **Stay signed in**.
  The server enforces it too (the session cookie and the stored session both last the idle time, and every request starts it again), so closing the laptop lid or leaving a tab in the background cannot keep a session open. After a time-out the sign-in page says
  "You were signed out because you were inactive for 10 minutes" and returns to the page you were on. Change the time with `SESSION_IDLE_MINUTES` in `/etc/itsm/itsm.env` (1 to 480). **Upgrade note:** the old `SESSION_IDLE_HOURS` (8 hours) is no longer read, so existing
  installs get 10 minutes straight away; add `SESSION_IDLE_MINUTES=` to the env file only if you want a different time. Signing out by hand and a disabled user work as before.
- **Fix: reports missed tickets raised just after midnight.** The report dates ("today", "30 days ago") were taken from the server clock in UTC, so between 00:00 and 03:00 in Kampala the default period ended the day before, and a ticket raised in those hours
  was left out of Service Desk Reports. Report periods are now days in the configured time zone (`APP_TIMEZONE`), as are "today" on the Operations Overview and the pipeline pages. (Found by the installer's tests, which ran at 00:40.)

## 1.10.1
- **Demo data you can remove.** `node scripts/demo-data.js load | status | remove`: sample customers, staff in every role, about 65 tickets over eight weeks, contracts, tenders, deals and projects, so every screen and the Operations Overview have something to show. `remove` deletes
  only the demo rows (marked by a `DEMO` customer code, `@demo.invalid` addresses and `[DEMO]` notes) and leaves everything else as it was. No e-mail is queued. The old `seed-demo.js` (which no longer matched the database) now loads the same data.

## 1.10.0
- **The Active Directory form now looks like a simple connection form**: Domain, IPv4 address (a name works too), User name, Password, Search base with a **Discover** button. Discover saves what you typed, connects, reads the search base from the directory and shows the service account's own DN.
- **Connection security** choice: LDAPS (636, default), STARTTLS (389) or **None** (389, no certificate needed; passwords are sent unprotected and the page says so). Port is only under Advanced and follows the choice. Added for domain controllers that have no LDAPS certificate,
  which is what "read ECONNRESET" usually means. A hardened domain controller that refuses unsigned binds now gets a plain-words message.

## 1.9.1
- **Active Directory connection errors now say what is wrong.** "Test connection" and the import search explain the usual causes in plain words before the technical message: the connection reset during the secure handshake (the domain controller has no certificate for LDAPS, or a firewall cuts it), refused, timed out, name not found, untrusted or mismatched certificate, wrong service-account password.

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
