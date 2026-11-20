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

/** Demo sign-ins for the manual, read from the demo data itself so the two cannot disagree. */
function demoInfo() {
  const demo = require('../services/demo');
  const USE = { service_manager: 'the dashboards, assigning, SLA notes, weekly highlights', agent: 'the service desk: replying, assigning, verification', engineer: 'working tickets and project tasks',
    security_analyst: 'the Security queue', contract_manager: 'contracts, obligations, payments, renewals', bd_manager: 'the pipeline and quotes', bid_manager: 'tenders and bid tasks',
    sde: 'deal engineering tasks, solution design, tender reviews', finance: 'contract financials, approvals, LPOs (view)', management: 'the Operations Overview and approvals',
    dept_head: 'department views and approvals', procurement: 'Suppliers & Contractors and purchase orders', customer_admin: 'the customer portal and the customer\'s users', customer_user: 'the customer portal' };
  const rows = [...demo.STAFF.map(([k, , r]) => [`${k}@${demo.DEMO_DOMAIN}`, perms.ROLE_LABELS[r] || r, USE[r] || '']),
    ...demo.CUSTOMERS.flatMap((c) => c.users.slice(0, 1).map(([k, , r]) => [`${k}@${demo.DEMO_DOMAIN}`, `${perms.ROLE_LABELS[r] || r} (${c.name.replace(/ \(Demo\)$/, '')})`, USE[r] || '']))];
  return { rows, password: demo.DEMO_PASSWORD, domain: demo.DEMO_DOMAIN };
}

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
        { tip: `After ${config.lockoutAttempts} wrong passwords in a row an account is locked for ${config.lockoutMinutes} minutes. You are signed out after ${config.sessionIdleMinutes} minutes without activity: a warning appears a minute before, and pressing a key, clicking or scrolling keeps you signed in.` },
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
        { h: 'First sign-in, and lost phones' },
        { list: [
          'A password someone else chose for you (a new account, or a reset by an administrator) must be replaced at your first sign-in. Until you do, only this page is open.',
          'Changing your password signs you out everywhere else.',
          'A code can be used once. After five wrong passwords or codes the account is locked for a while; starting again does not give more tries.',
          'Lost your phone? An administrator can reset your two-step verification; you then set it up again with the new phone.',
        ] },
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
          'Describe the problem or request. Say what you expected and what happened, and who is affected. You can format the text with the toolbar (bold, lists, links ...), as in a word processor.',
          'Set how many people are affected (impact) and how urgent it is. These two answers set the priority and therefore how fast we respond.',
          'Attach screenshots or files if they help (up to five), then press **Submit**.',
        ] },
        { p: 'You get a ticket reference on the page and can follow it under My Requests. You can also write to the support mailbox your provider gave you: the e-mail becomes a ticket as well.' },
        { tip: 'Colleagues without an account can raise a request too, if your organisation has this turned on: they choose **Raise a request** on the sign-in page, give their work e-mail address and your CSID, and type the code they receive by e-mail.' },
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
        { tip: 'You receive an e-mail when your request is logged (with when we will respond, in local time), when we need something from you, when service is restored, when it is resolved and when it is closed. A reply to a resolved or closed request reopens it, within the reopen period.' },
        { tip: 'The search box at the top finds your tickets in any status (open, resolved or closed) by reference, subject or words in the conversation, and links to Help articles. Type a ticket reference and press Enter to open it.' },
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
        { p: '**My Services** shows what we provide to you. **Service Catalogue** lists the services that are on your account, each with its CSID. Pick one there and the request form opens with it already chosen.' },
      ],
    },
    {
      id: 'c-help', title: 'Help Articles', who: 'customer',
      blocks: [
        { p: 'Many questions already have an answer. Open **Help Articles**, type a few words and read the steps. Press **Yes, it helped** or **No** at the end: it tells us which articles to improve.' },
        { tip: 'Not solved? Use **Submit Request**. A request we have answered with an article shows the article under "Help articles" on the request page.' },
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
        { h: 'Searching' },
        { p: 'The search box at the top finds tickets in any status by reference, subject, sender, customer, CSID or words written on the ticket, and lists matching customers. Type a ticket reference and press Enter to open that ticket. Below the results are links to search Contracts, Tenders, Pipeline, Projects and the Knowledge Base for the same words.' },
        { h: 'Working a ticket' },
        { steps: [
          'Open the ticket. A coloured **SLA bar** under the title says at once whether the SLA is on track (green), at risk (amber: due within the hour or less than a quarter of the time left), breached or missed (red) or paused (blue). The **SLA card** at the top of the right-hand column shows each target with the time left or how late it is, counting down while the page is open.',
          'Write a reply to the customer, or tick **Internal note** for a note only staff can see. The box formats text like a word processor: **bold**, italic, underline, strike-through, headings, bulleted and numbered lists, quotes, code and links (toolbar or Ctrl+B / Ctrl+I / Ctrl+U). Text pasted from Word or a web page keeps its bold, italics, lists and links. The customer receives the reply as plain text by e-mail. Attach files if needed.',
          'Change the **status** as the work moves: In progress, Waiting for customer, Waiting for vendor, Service restored, then Resolved. Resolving asks for a resolution code and note.',
          'Use **Assign** to give the ticket to a colleague, and **Priority** (impact and urgency) if the first assessment was wrong. Every change is written to the ticket history.',
        ] },
        { tip: 'The status list shows only what is allowed from where the ticket is. Nothing is closed directly: **Resolve** it first (the customer is asked to confirm, or it closes by itself after a few days). A closed ticket can only be reopened, and a cancelled ticket stays cancelled. A customer reply on a resolved or closed ticket reopens it; after the reopen period the portal refuses it and an e-mailed reply is kept on the ticket with a note for staff.' },
        { tip: 'The **first response** is a reply to the customer (a public comment), asking them for information, or resolving. Moving a ticket to In progress is not a response. A target that was missed stays on the ticket as **Missed earlier**, even if a reopen or a priority change moves the due time later, and the reports count it as missed.' },
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
        { list: ['Service managers create customers and services, and set which SLA policy and engineer apply.', 'The **execution engineer** is the person notified first for tickets on that service.',
          '**E-mail domains** (customer details): people with an address on these domains can raise a request **without an account** at /request (link on the sign-in page). They give the customer\'s CSID, type a 6-digit code e-mailed to them, then see the active services on that CSID and raise a ticket. Their e-mailed replies to that ticket are added to it. Leave the domains empty to switch this off for a customer; an administrator can switch it off for everyone in Settings, Tickets.'] },
        { tip: 'Tickets raised this way are marked in their history ("Raised without signing in ... confirmed with a one-time code"). It needs outgoing mail to be set up, because the code is sent by e-mail.' },
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
          'Add customer contacts, activities, proposals, **quotes** and documents to the deal.',
          'Business development managers can ask **Service delivery engineers** or technical team members for support; they see only the deals assigned to them (**My Opportunities**) and keep technical tasks and solution notes there.',
          '**Escalate** a deal when leadership support is needed. It appears on the Operations Overview until the escalation is cleared.',
          'When a deal is **Won**, press **Start a project** (or **Create the contract**) on the deal and the new form opens with its details filled in.',
        ] },
      ],
    },
    {
      id: 'quotes', title: 'Quotes', who: 'staff', perm: 'quote.view',
      intro: 'A quote is a priced offer with lines, tax and terms, downloaded as a PDF to send to the customer. It is usually made from an opportunity in the pipeline.',
      blocks: [
        { steps: [
          'On an opportunity, press **New quote for this opportunity** (or open **Quotes** and press **New quote**). The customer, contact, currency and title are filled in from the opportunity; the tax rate, validity and terms come from Settings.',
          'Add the **lines**: description, quantity, unit (each, month, user / month ...), unit price and an optional discount in percent. The amounts and totals update as you type. Empty rows are ignored; clear a description to remove a line. Descriptions can be picked from the service catalogue.',
          'Press **Download draft PDF** to check it. The draft PDF is marked DRAFT.',
          'Send the PDF to the customer from your e-mail, then choose **Sent to the customer** under Next step.',
          'When the customer answers, mark it **Accepted** (with an opportunity, you can set the opportunity value to the quote amount before tax at the same time) or **Declined** with the reason.',
        ] },
        { list: [
          'A sent quote cannot be changed. To change it, press **Make a new revision**: a copy opens as a draft (for example QUO-000012 R2) and the sent one is marked **Superseded**. Every revision stays on record.',
          'A sent quote whose **Valid until** date has passed is marked **Expired** overnight. It can still be marked Accepted if the customer agrees later, or revised with a new date.',
          'The **Quotes** page lists the newest revision of each quote, with filters, and downloads the list in Excel, PDF or CSV. The opportunity page lists its quotes.',
          'Administrators set the company name, address, tax ID, tax rate, validity and standard terms printed on every quote in **Settings**, Quotes.',
          'Internal notes are never printed. A quote above the approval limits (amount or discount) is approved before it is sent: see **Approvals**.',
        ] },
      ],
    },
    {
      id: 'suppliers', title: 'Suppliers and contractors', who: 'staff', perm: 'supplier.view',
      intro: 'The register of the companies we buy from or subcontract to: contractors, subcontractors, distributors, vendors, consultants and other third parties.',
      blocks: [
        { steps: [
          'Open **Suppliers & Contractors** and press **Add a supplier or contractor**: name, type, TIN, contact, payment terms and what they supply or do.',
          'On the supplier page, **Upload a document**: their quote (with its reference, amount, date and validity), an LPO given to them outside this system, an invoice, a delivery note, or papers such as registration and tax clearance. A document can be marked as being for a project, a tender or one of our LPOs.',
          'Put them on a **project** or a **tender** with their role there (for example "cabling subcontractor"), from the supplier page or from the **Contractors and suppliers** card on the project or tender page.',
        ] },
        { list: [
          'The project and tender pages list their contractors and suppliers, the documents for that project or tender and the LPOs raised for it.',
          'A supplier **On hold** or **Inactive** cannot be given new orders.',
          'Procurement and the managers of the register keep it; project and tender managers add contractors to their own project or tender; everyone who works on projects or tenders, and finance, can see it.',
        ] },
      ],
    },
    {
      id: 'lpo', title: 'Purchase orders (LPOs)', who: 'staff', perm: 'lpo.view',
      intro: 'Local purchase orders that the procurement team issues to suppliers, contractors, distributors and other third parties.',
      blocks: [
        { steps: [
          'Raise an LPO from where it starts: **Raise LPO** next to a supplier\'s quote, **Raise an LPO** on a supplier, on a project\'s or tender\'s contractor card, **Raise an LPO against this contract** on a contract, or **Raise a back-to-back LPO** on one of our quotes to a customer. The supplier, project, tender, contract and payment terms are filled in for you; you can also start from **Suppliers & Contractors**, the **Purchase orders (LPO)** tab, New purchase order.',
          'Add the **lines** (description, quantity, unit, unit price, discount); totals and VAT update as you type.',
          'Check the **draft PDF**, then **Issue to the supplier**. The order is then fixed and dated, and its PDF (with signature boxes for us and for the supplier) is what you send.',
          'Attach the **signed copy**, the **delivery note** and the **invoice** to the order as they come in. Mark it **Received** when the goods or services are delivered and **Closed** when it is invoiced and settled.',
        ] },
        { list: [
          'Purchase orders live in **Suppliers & Contractors**, on the **Purchase orders (LPO)** tab. Its **LPO tracker** shows how many orders, and how much money, are Drafts, Awaiting delivery, **Late** (past their deliver-by date), Received and Closed; press a box to list those orders. Choose a supplier to see the tracker for that supplier only.',
          'Each supplier\'s page has the same tracker for that supplier, with every order, its project, its deliver-by date and a **late** mark.',
          'An issued order cannot be changed: cancel it (a reason is required, because the supplier has a copy) and raise a new one.',
          'Every step is in the order\'s history, the supplier\'s history, the project\'s activity when it is for a project, and the audit log.',
          'Company details, the standard LPO terms and the default delivery address are set by an administrator in **Settings**, Quotes and purchase orders.',
        ] },
        { tip: 'An LPO is approved before it is issued (see **Approvals**): press **Ask for approval** on the draft. Until it is approved, Issue is not offered.' },
      ],
    },
    {
      id: 'approvals', title: 'Approvals of quotes and purchase orders', who: 'staff',
      intro: 'A quote above a set amount or discount is approved before it is sent, and every purchase order before it is issued. Large orders need a second approver.',
      blocks: [
        { h: 'Asking for approval' },
        { steps: [
          'Finish the draft: its lines, terms and PDF. The **Approval** box on the page says whether approval is needed and why (for example "the total is at or above UGX 20,000,000").',
          'Press **Ask for approval**. The approvers see it at once on their **bell** and under **Approvals** in the menu, with a count.',
          'When it is approved, **Sent** (quotes) or **Issue** (orders) appears under Next step. If it is not approved, the approver\'s reason is shown: change what was asked and press Ask for approval again.',
        ] },
        { tip: 'Any change to the draft after approval (its details or its lines) withdraws the approval, so what goes to the customer or supplier is exactly what was approved. A new revision of a quote is approved afresh.' },
        { h: 'Deciding' },
        { steps: [
          'Open **Approvals** in the menu. **Waiting for you** lists what you may decide; open an item to read its lines and PDF first.',
          'Press **Approve**, or write a reason and press **Decline** (a reason is required, so it can be put right). You can decide on the list or on the item\'s page.',
          'For a large purchase order, the first approval (finance or a department head) is followed at once by a request for the **second approval** (management).',
        ] },
        { list: [
          '**Nobody approves their own** quote or order: not the person who asked and not its owner. A platform administrator can approve anything except their own.',
          '**The defaults**: quotes need approval at **UGX 20,000,000** or **USD 5,000** and above, or with a discount of **10%** or more (a quote in another currency always needs it); finance, management or a department head approves. Every LPO is approved by finance or a department head; at **UGX 50,000,000** or **USD 13,000** and above management approves as well.',
          'An administrator changes all of this in **Settings**, **Approvals**: the limits per currency, the discount, who approves, and whether approval is on at all.',
          'Every request and decision is written to the item\'s history and the audit log. **Approvals**, **What you asked for** shows where your own requests stand.',
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
      id: 'kb', title: 'Knowledge Base', who: 'staff', perm: 'kb.view',
      intro: 'Short guides for problems you meet more than once. A good article saves the next person the same hunt.',
      blocks: [
        { p: '**Knowledge Base** in the menu opens the list. Type a few words, part of a title or a tag in the search box. On a ticket, the **Knowledge Base** card on the right shows linked articles and a link to search for the same problem.' },
        ...(perms.can(user, 'kb.write') ? [
          { h: 'Writing an article' },
          { steps: ['Search first. If an article exists, improve it instead of writing a second one.', 'Press **New article** (or **Write an article from this ticket** on a solved ticket: the problem and the fix are copied in; remove customer names and details).', 'Give it a title in the words people use, a short summary, a category and a few tags. The text is plain: **#** for headings, **-** for bullets, **1.** for steps, backticks for commands, **[[KB-0012]]** to link another article.', 'Choose who can read it: **Staff only**, or **Staff and customers**.', 'Save. It stays a draft until a service delivery manager publishes it.'] },
          { tip: 'Every save keeps the old version. **History** shows who changed what and lets you restore an earlier version.' },
          { p: 'An article that is live for customers can only be changed by a publisher, so nothing public is altered without a check. Articles have a **review by** date (a year after publishing unless you set it); old ones appear under **Review due**.' },
        ] : []),
        ...(perms.can(user, 'kb.publish') ? [
          { h: 'Publishing' },
          { p: 'Open a draft, read it, check that a customer article says nothing about a particular customer, then press **Publish**. **Take back to draft** hides it again; **Archive** keeps it but removes it from the lists. Categories are managed at the bottom of the Knowledge Base page.' },
        ] : []),
        { p: 'Press **Yes, it helped** or **No** on an article you used. The counts help the authors decide what to improve.' },
      ],
    },
    {
      id: 'mail', title: 'E-mail to ticket', who: 'staff', perm: 'mail.view',
      blocks: [
        { p: 'Shared mailboxes (up to five) are read automatically and every message becomes a ticket, or a comment on the ticket named in the subject. **Administration → E-mail** shows each mailbox, when it was last read, whether it is healthy, and the log of outgoing mail.' },
        ...(perms.can(user, 'mail.manage') ? [{ p: 'The **Outgoing mail** card at the top of that page is where the mail server for notifications is set: the server, the security (STARTTLS is the usual choice), a user name and password if the server asks for them, and the From address. **Send test email** checks it at once and explains in plain words if the server refuses. Until it is set, nobody receives notifications.' }] : []),
        ...(perms.can(user, 'mail.manage') ? [{ p: 'Each mailbox form has a box for its **password** (IMAP), **client secret** (Microsoft 365) or **service-account key** (Google). Type it there once: it is stored encrypted and never shown again. Leave the box empty when you save other changes to keep the saved one.' }] : []),
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
          '**Reset password** gives a one-time password for a local account. The person must replace it at their first sign-in. For an Active Directory account the password is changed in Windows.',
          '**Reset** next to Two-step shows where someone has two-step verification on. Use it when a phone is lost: it switches it off, ends their sessions and is written to the audit log. Roles that must use two-step set it up again at the next sign-in.',
        ] },
        { h: 'Active Directory (on the Users page)' },
        { p: 'Active Directory only does two things here: it lets you **import people** and it checks their password when they sign in. Roles are always chosen in this application.' },
        { steps: [
          'On **Users**, open **Connection settings** under Active Directory.',
          'Type the **Domain** (for example corp.local), the **IPv4 address** of your domain controller (a name such as dc1.corp.local also works), the **User name** of a normal read-only AD account (the name only; the domain is added) and its **Password**. The password is stored encrypted and never shown again.',
          'Press **Discover**. It saves what you typed, connects, and fills in the **Search base** for you. If it cannot connect it says why.',
          'Choose the **Connection security**: LDAPS (port 636) or STARTTLS (port 389) are encrypted and need a certificate on the domain controller. **None** works without a certificate but sends passwords unprotected, so use it only on a trusted internal network.',
          'Tick **Allow imported people to sign in with their Active Directory password** and press **Save**, then **Test connection**.',
          'Press **Import users**, search by name, tick the people you want, choose their role and press **Import ticked people**.',
          'Those people now sign in with their Windows password. Anyone not imported cannot sign in.',
        ] },
        { tip: 'Every hour the system checks the imported people: anyone deleted or disabled in Active Directory is switched off here. If the server cannot be reached, nobody is switched off. Always keep one local administrator account for emergencies.' },
        { p: 'Under Advanced you can set a different port, and a certificate file when your domain controllers use a certificate from your own authority.' },
        { h: 'Company logo and name (Settings, Company branding)' },
        { steps: [
          'Open **Settings**. At the top, under **Company branding**, choose your logo file and press **Upload logo**. Use a PNG or JPEG of at most 1 MB; a wide logo with a transparent background looks best. SVG, GIF and WebP are not accepted.',
          'Type the **Company name** in the next box and press **Save settings** at the bottom of the page.',
        ] },
        { list: [
          '**The logo** replaces the company name wherever a mark is shown: the sign-in page, the menu, the customer portal and the request page (centred under the words Service Operations (Ops)), and the top of every PDF report, quote and purchase order (the logo alone).',
          '**The company name** is used in page titles, page and PDF footers, the "From" block of quotes and LPOs, and Excel titles; with no logo it is shown in place of one.',
          '**Recolour the logo to match each person\'s theme** (next to the company name, on by default): the dark parts of the logo take the theme colour and white stays white, on screen and in PDFs. Untick it to keep the logo in its own colours everywhere.',
          '**Remove logo** goes back to the product mark. Changes show at once for everyone and are written to the audit log.',
        ] },
        { h: 'Other administration pages' },
        { list: [
          '**Settings**: business hours, SLA clocks, security (which roles need two-step verification), currencies, contract and tender reminders.',
          '**Audit log**: who did what, when and from where. It cannot be edited or deleted, and each entry is chained to the one before it: the page shows the result of the daily check, and administrators are e-mailed if it ever fails.',
          '**How long records are kept** (Settings): e-mail notifications (default 365 days), closed tickets and the audit log (default: for ever). A nightly clean-up removes what is older. Agree the periods with your legal and compliance people first: removed tickets cannot be brought back.',
          '**Backups** are daily, encrypted and checked, with a monthly restore test. The passphrase is shown once at install: keep it in your password vault (see the README, Backup and restore).',
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
        ['tender.contribute', 'Work on a tender'], ['pipeline.view', 'See the pipeline'], ['pipeline.manage', 'Create and change deals'], ['pipeline.escalate', 'Escalate a deal'], ['quote.view', 'See quotes'], ['quote.manage', 'Create and send quotes'], ['supplier.view', 'See suppliers and contractors'], ['supplier.manage', 'Register suppliers, upload their documents, put them on projects and tenders'], ['lpo.view', 'See purchase orders (LPOs)'], ['lpo.manage', 'Raise and issue purchase orders (LPOs)'], ['project.view', 'See projects'], ['project.manage', 'Create and change projects'],
        ['project.contribute', 'Update tasks of own projects'], ['operations.view', 'Operations Overview'], ['operations.manage', 'Write the weekly highlights'], ['mail.view', 'See the e-mail page'], ['mail.manage', 'Change mailboxes'], ['kb.view', 'Read the Knowledge Base'], ['kb.write', 'Write and edit articles'], ['kb.publish', 'Publish and archive articles'],
        ['user.manage', 'Manage users and Active Directory'], ['settings.manage', 'Change settings'], ['audit.view', 'See the audit log'],
      ] }],
    },
    {
      id: 'demo', title: 'Demo data: trying the system', who: 'staff',
      intro: 'A test system can be filled with sample data so every screen has something to show. It is for trying and training only, and an administrator removes it before real work starts.',
      blocks: [
        { p: 'An administrator loads it on the server with **node scripts/demo-data.js load**, checks it with **status** and removes it with **remove** (see the README, Demo data). Everything sample is easy to recognise: customer names end in **(Demo)**, people\'s addresses end in **@' + demoInfo().domain + '**, and notes start with **[DEMO]**. Nothing is e-mailed while it is loaded.' },
        { h: 'Signing in as a demo person' },
        { p: 'Every demo person uses the same password: **' + demoInfo().password + '**. Sign in as the role you want to try:' },
        { table: { head: ['Sign in as', 'Role', 'Good for trying'], rows: demoInfo().rows } },
        { h: 'What is in it' },
        { list: [
          '**Service desk**: three customers with sites, CSIDs, services, contracts and SLA policies; about 64 tickets over the last eight weeks (some breached, some at risk, some waiting for the customer), two e-mails waiting on **Verification**, replies written with the formatting toolbar, and seven Knowledge Base articles with readers\' votes.',
          '**Contracts**: customer and supplier contracts with SLA targets and three months of measured performance, obligations (one overdue), a quarterly payment schedule, approvals (one asking for changes), a variation and an extension, and one expired contract.',
          '**Pipeline and quotes**: ten deals at every stage (one escalated), with engineering tasks, proposals, solution designs and engineer effort; five quotes (sent, revised with a discount, accepted, draft).',
          '**Tenders**: eight tenders from identified to awarded and unsuccessful, with bid tasks, approvals before submission, clarifications and evaluation scores.',
          '**Projects** and the **Operations Overview**: five projects in different health (one escalated) with tasks and milestones, and this and last week\'s highlights.',
          '**Suppliers & Contractors**: three suppliers on projects and a tender, their documents (a quote, a tax clearance and a delivery note you can open), and purchase orders at every stage of the **LPO tracker**: draft, awaiting delivery, late, received, closed and cancelled.',
        ] },
        { tip: 'Requests without signing in: each demo customer has an e-mail domain (for example **kcb.demo.invalid**) and a CSID, so the request page accepts them, but the one-time code is e-mailed and those addresses cannot receive mail. To try it to the end, an administrator adds your own e-mail domain to a demo customer (Customers, the customer, E-mail domains) and removes it again afterwards.' },
      ],
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
