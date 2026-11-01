'use strict';
// The ticket engine. Every channel (portal, agent, e-mail) creates tickets through createTicket(), so CSID/service
// validation, priority, SLA timers, execution-engineer routing and notification behave identically (SLA-010).
const perms = require('../lib/perms');
const settings = require('../lib/settings');
const priorityLib = require('../lib/priority');
const sla = require('../lib/sla');
const notifications = require('./notifications');

class UserError extends Error {
  constructor(message, status = 400) { super(message); this.userMessage = message; this.status = status; }
}

const OPEN_STATUSES = ['new', 'open', 'in_progress', 'pending_customer', 'pending_vendor', 'restored'];
const ALL_STATUSES = [...OPEN_STATUSES, 'resolved', 'closed', 'cancelled'];
const STATUS_LABELS = {
  new: 'New', open: 'Open', in_progress: 'In progress', pending_customer: 'Waiting for customer', pending_vendor: 'Waiting for vendor',
  restored: 'Service restored', resolved: 'Resolved', closed: 'Closed', cancelled: 'Cancelled',
};

// ---------------------------------------------------------------- SLA policy loading
async function loadPolicy(db, policyId) {
  if (!policyId) return null;
  const p = await db.query(
    `select p.id, p.name, c.id as calendar_id, c.timezone, c.schedule from sla_policies p join calendars c on c.id = p.calendar_id where p.id = $1`,
    [policyId],
  );
  if (!p.rows[0]) return null;
  const h = await db.query('select day from holidays where calendar_id = $1', [p.rows[0].calendar_id]);
  const t = await db.query('select * from sla_targets where policy_id = $1', [policyId]);
  const targets = {};
  for (const r of t.rows) targets[r.priority] = { response: r.response_min, restoration: r.restoration_min, resolution: r.resolution_min };
  return {
    id: p.rows[0].id, name: p.rows[0].name, targets,
    calendar: sla.makeCalendar(p.rows[0], h.rows.map((x) => x.day)),
  };
}

function computeDues(policy, priority, type, from) {
  const t = policy && policy.targets[priority];
  if (!t) return { response_due: null, restoration_due: null, resolution_due: null };
  return {
    response_due: sla.addBusinessMinutes(from, t.response, policy.calendar),
    restoration_due: type === 'incident' ? sla.addBusinessMinutes(from, t.restoration, policy.calendar) : null,
    resolution_due: sla.addBusinessMinutes(from, t.resolution, policy.calendar),
  };
}

// ---------------------------------------------------------------- small helpers
async function patch(db, id, fields) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`);
  sets.push('updated_at = now()');
  const r = await db.query(`update tickets set ${sets.join(', ')} where id = $1 returning *`, [id, ...keys.map((k) => fields[k])]);
  return r.rows[0];
}

async function event(db, ticketId, actor, kind, text, internal = false) {
  await db.query('insert into ticket_events (ticket_id, actor_id, kind, text, internal) values ($1,$2,$3,$4,$5)',
    [ticketId, actor ? actor.id : null, kind, text, internal]);
}

/** Ticket with the names needed for notifications and screens. */
async function summary(db, id) {
  const r = await db.query(
    `select t.*, cu.name as customer_name, cs.csid as csid_code, s.name as service_name,
            a.name as assignee_name, e.name as exec_engineer_name, rq.name as requester_user_name
       from tickets t
       left join customers cu on cu.id = t.customer_id
       left join csids cs on cs.id = t.csid_id
       left join services s on s.id = t.service_id
       left join users a on a.id = t.assignee_id
       left join users e on e.id = t.exec_engineer_id
       left join users rq on rq.id = t.requester_id
      where t.id = $1`, [id]);
  return r.rows[0] || null;
}

function fmtDue(d) { return d ? new Date(d).toISOString().replace('T', ' ').slice(0, 16) + ' UTC' : 'n/a'; }

// ---------------------------------------------------------------- creation
/**
 * A service can be covered by many contracts. The one that governs a ticket is the newest in-force contract linked to the service
 * that carries an SLA policy (in force: not expired, suspended, terminated or closed, started, and not past its end date).
 */
async function governingContract(db, serviceId) {
  const r = await db.query(
    `select c.id, c.sla_policy_id from service_contracts sc join contracts c on c.id = sc.contract_id
      where sc.service_id = $1 and c.status in ('active','expiring_soon','renewal_in_progress') and c.start_date <= current_date
        and (c.end_date is null or c.end_date >= current_date) and c.sla_policy_id is not null
      order by c.start_date desc, c.id desc limit 1`, [serviceId]);
  return r.rows[0] || null;
}

async function validateRelations(db, { customerId, csidId, serviceId, siteId, enforceActive }) {
  let contractId = null;
  let contractPolicyId = null;
  let service = null;
  if (!customerId) {
    if (csidId || serviceId || siteId) throw new UserError('A CSID or service needs a customer.');
    return { contractId, contractPolicyId, service };
  }
  const cu = await db.query('select id, status from customers where id = $1', [customerId]);
  if (!cu.rows[0]) throw new UserError('Unknown customer.');
  if (csidId) {
    const c = await db.query('select id, status from csids where id = $1 and customer_id = $2', [csidId, customerId]);
    if (!c.rows[0]) throw new UserError('That CSID does not belong to this customer.');
    if (enforceActive && c.rows[0].status !== 'active') throw new UserError('That CSID is not active.');
  }
  if (serviceId) {
    if (!csidId) throw new UserError('Choose the CSID that the service belongs to.');
    const s = await db.query(
      'select id, status, sla_policy_id from services where id = $1 and csid_id = $2 and customer_id = $3',
      [serviceId, csidId, customerId]);
    if (!s.rows[0]) throw new UserError('That service does not belong to the selected CSID and customer.');
    if (enforceActive && s.rows[0].status !== 'active') throw new UserError('That service is not active.');
    service = s.rows[0];
    const gc = await governingContract(db, serviceId);
    if (gc) { contractId = gc.id; contractPolicyId = gc.sla_policy_id; }
  }
  if (siteId) {
    const si = await db.query('select id from sites where id = $1 and customer_id = $2', [siteId, customerId]);
    if (!si.rows[0]) throw new UserError('That site does not belong to this customer.');
  }
  return { contractId, contractPolicyId, service };
}

/**
 * Create a ticket. Must run inside a transaction (`db` is a client).
 * input: { type, queue, tier, customerId, csidId, serviceId, siteId, requester:{id,email,name}, subject, description,
 *          category, impact, urgency, priority?, source, mailboxId?, mailboxPolicyId?, needsVerification?, actor?, enforceActive? }
 */
async function createTicket(db, input) {
  const subject = String(input.subject || '').trim();
  if (!subject) throw new UserError('Enter a subject.');
  const type = input.type === 'request' ? 'request' : 'incident';
  const impact = [1, 2, 3].includes(input.impact) ? input.impact : 2;
  const urgency = [1, 2, 3].includes(input.urgency) ? input.urgency : 2;
  const st = await settings.getAll(db, ['priority_matrix', 'default_sla_policy']);
  const priority = input.priority || priorityLib.compute(st.priority_matrix, impact, urgency);

  const { contractId, contractPolicyId, service } = await validateRelations(db, {
    customerId: input.customerId, csidId: input.csidId, serviceId: input.serviceId, siteId: input.siteId, enforceActive: input.enforceActive,
  });

  let policyId = null;
  if (service && service.sla_policy_id) policyId = service.sla_policy_id;
  if (!policyId && contractPolicyId) policyId = contractPolicyId;
  if (!policyId) policyId = input.mailboxPolicyId || st.default_sla_policy || null;
  const policy = await loadPolicy(db, policyId);
  const now = new Date();
  const dues = computeDues(policy, priority, type, now);

  const n = (await db.query("select nextval('ticket_seq') as n")).rows[0].n;
  const ref = `${type === 'request' ? 'REQ' : 'INC'}-${String(n).padStart(6, '0')}`;
  const req = input.requester || {};
  const r = await db.query(
    `insert into tickets (ref, type, queue, tier, customer_id, csid_id, service_id, contract_id, site_id,
        requester_id, requester_email, requester_name, subject, description, category, impact, urgency, priority,
        source, mailbox_id, sla_policy_id, response_due, restoration_due, resolution_due, needs_verification)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
     returning id`,
    [ref, type, input.queue || 'it_services', input.tier || 'l1', input.customerId || null, input.csidId || null,
      input.serviceId || null, contractId, input.siteId || null, req.id || null, req.email || '', req.name || '',
      subject.slice(0, 200), String(input.description || '').slice(0, 20000), input.category || '', impact, urgency, priority,
      input.source, input.mailboxId || null, policy ? policy.id : null, dues.response_due, dues.restoration_due, dues.resolution_due,
      !!input.needsVerification],
  );
  const id = r.rows[0].id;
  await event(db, id, input.actor || null, 'created',
    `Ticket created via ${input.source}${input.actor ? ' by ' + input.actor.name : ''}. Priority ${priorityLib.LABELS[priority]}.`);
  if (input.needsVerification) {
    await event(db, id, null, 'verification', 'Sender could not be matched to a registered customer. Waiting for verification.', true);
  }
  let ticket = await summary(db, id);
  if (!input.needsVerification) ticket = (await routeEngineer(db, ticket)).ticket;
  return ticket;
}

// ---------------------------------------------------------------- execution engineer (SLA-009 to SLA-014)
async function currentAssignment(db, ticket) {
  const probes = [];
  if (ticket.service_id) probes.push(['service', 'service_id', ticket.service_id]);
  if (ticket.contract_id) probes.push(['contract', 'contract_id', ticket.contract_id]);
  for (const [entity, col, val] of probes) {
    const r = await db.query(
      `select * from engineer_assignments where entity = $1 and ${col} = $2
          and effective_from <= current_date and (effective_to is null or effective_to >= current_date)
        order by id desc limit 1`, [entity, val]);
    if (r.rows[0]) return r.rows[0];
  }
  return null;
}

function engineerMessage(ticket, engineer, redacted) {
  const url = notifications.link(engineer, ticket.ref);
  if (redacted) {
    return {
      subject: `[${ticket.ref}] New restricted ticket`,
      body: `A restricted ticket ${ticket.ref} was created for a service you are responsible for.\nFor security reasons the details are not sent by e-mail. Sign in to check whether you have access:\n${url}\n`,
    };
  }
  const lines = [
    `A new ticket was created for a service you are the execution engineer for.`, '',
    `Ticket:    ${ticket.ref}`,
    `Customer:  ${ticket.customer_name || 'not yet verified'}${ticket.csid_code ? ' / ' + ticket.csid_code : ''}`,
    `Service:   ${ticket.service_name || 'not specified'}`,
    `Priority:  ${priorityLib.LABELS[ticket.priority]}`,
    `Summary:   ${ticket.subject}`,
    `Response due:    ${fmtDue(ticket.response_due)}`,
    `Restoration due: ${fmtDue(ticket.restoration_due)}`,
    `Resolution due:  ${fmtDue(ticket.resolution_due)}`, '',
    `Open the ticket: ${url}`,
  ];
  return { subject: `[${ticket.ref}] New ${priorityLib.LABELS[ticket.priority]} ticket: ${ticket.subject}`.slice(0, 200), body: lines.join('\n') + '\n' };
}

/** Choose the engineer (primary, then backup, then supervisors) and notify (SLA-010, SLA-011, SLA-013, AUTO-006). */
async function routeEngineer(db, ticket) {
  const a = await currentAssignment(db, ticket);
  let chosen = null; let outcome = 'unassigned';
  if (a) {
    const ids = [a.engineer_id, a.backup_id].filter(Boolean);
    const users = (await db.query('select id, name, email, kind, role, active, available from users where id = any($1)', [ids])).rows;
    const byId = Object.fromEntries(users.map((u) => [u.id, u]));
    const usable = (u) => u && u.active && u.available && u.kind === 'staff';
    if (usable(byId[a.engineer_id])) { chosen = byId[a.engineer_id]; outcome = 'primary'; }
    else if (usable(byId[a.backup_id])) { chosen = byId[a.backup_id]; outcome = 'backup'; }
    else outcome = 'none_available';
  }

  if (chosen) {
    ticket = await patch(db, ticket.id, { exec_engineer_id: chosen.id, assignee_id: ticket.assignee_id || chosen.id });
    ticket = await summary(db, ticket.id);
    const redacted = ticket.queue === 'security' && !perms.can(chosen, 'security.view');
    const m = engineerMessage(ticket, chosen, redacted);
    await notifications.enqueue(db, {
      kind: 'engineer_new_ticket', ticketId: ticket.id, to: chosen, subject: m.subject, body: m.body,
      dedupeKey: `engineer:${ticket.id}:${chosen.id}`,
    });
    await event(db, ticket.id, null, 'engineer_routed',
      `${outcome === 'backup' ? 'Backup' : 'Execution'} engineer ${chosen.name} was assigned and notified.`, true);
  }
  if (outcome !== 'primary') {
    const why = { unassigned: 'No execution engineer is configured for this service or contract.',
      none_available: 'The execution engineer and backup are inactive or unavailable.',
      backup: 'The primary execution engineer is inactive or unavailable; the backup was used.' }[outcome];
    await event(db, ticket.id, null, 'engineer_routing', why, true);
    for (const s of await notifications.supervisors(db, ticket.queue)) {
      await notifications.enqueue(db, {
        kind: 'engineer_routing', ticketId: ticket.id, to: s, dedupeKey: `routing:${ticket.id}:${outcome}:${s.id}`,
        subject: `[${ticket.ref}] Needs attention: ${why}`.slice(0, 200),
        body: `${why}\n\nTicket: ${ticket.ref} - ${ticket.subject}\nCustomer: ${ticket.customer_name || 'not yet verified'}\nPriority: ${priorityLib.LABELS[ticket.priority]}\n${notifications.link(s, ticket.ref)}\n`,
      });
    }
  }
  return { ticket, engineer: chosen, outcome };
}

// ---------------------------------------------------------------- visibility and lookup
async function getVisible(db, user, ref) {
  const params = [String(ref).toUpperCase()];
  const vis = perms.ticketVisibility(user, params, 't');
  const r = await db.query(`select t.id from tickets t where t.ref = $1 and (${vis})`, params);
  return r.rows[0] ? summary(db, r.rows[0].id) : null;
}

// ---------------------------------------------------------------- lifecycle
async function setStatus(db, ticket, newStatus, actor, opts = {}) {
  if (!ALL_STATUSES.includes(newStatus)) throw new UserError('Unknown status.');
  const old = ticket.status;
  if (old === newStatus) return ticket;
  const isStaff = actor && actor.kind === 'staff';
  const st = await settings.getAll(db, ['sla_pause_statuses', 'reopen_window_days', 'resolution_codes']);
  const pauseSet = new Set(st.sla_pause_statuses || []);
  const now = new Date();
  const f = { status: newStatus };
  const wasDone = ['resolved', 'closed', 'cancelled'].includes(old);
  const nowDone = ['resolved', 'closed', 'cancelled'].includes(newStatus);

  if (wasDone && !nowDone) {
    // Reopening (INC-009): staff may reopen any time; customers only inside the policy window.
    if (old === 'cancelled') throw new UserError('A cancelled ticket cannot be reopened. Create a new one.');
    const ref = ticket.resolved_at || ticket.closed_at;
    const days = Number(st.reopen_window_days || 0);
    if (!isStaff && ref && (now - new Date(ref)) > days * 86400000) {
      throw new UserError(`This ticket was resolved more than ${days} days ago. Please create a new ticket and mention ${ticket.ref}.`);
    }
    const policy = await loadPolicy(db, ticket.sla_policy_id);
    Object.assign(f, computeDues(policy, ticket.priority, ticket.type, now), {
      resolved_at: null, closed_at: null, restored_at: null, sla_flags: JSON.stringify({}), paused_at: null, pause_reason: null, sla_remaining: null,
    });
  }
  if (!wasDone && isStaff && !ticket.responded_at && newStatus !== 'new') f.responded_at = now;
  if (newStatus === 'restored' && !ticket.restored_at) f.restored_at = now;
  if (newStatus === 'resolved') {
    if (isStaff && ticket.type === 'incident' && !(st.resolution_codes || []).includes(opts.resolutionCode)) {
      throw new UserError('Choose a resolution code before resolving an incident.');
    }
    f.resolved_at = now;
    if (!ticket.restored_at && ticket.type === 'incident') f.restored_at = now;
    if (!ticket.responded_at) f.responded_at = now;
    if (opts.resolutionCode) f.resolution_code = opts.resolutionCode;
    if (opts.resolutionNote !== undefined) f.resolution_note = String(opts.resolutionNote).slice(0, 5000);
  }
  if (newStatus === 'closed') { f.closed_at = now; if (!ticket.resolved_at) f.resolved_at = now; }
  if (newStatus === 'cancelled') f.closed_at = now;

  // Pause and resume the SLA clock (SLA-005): remaining supported time is frozen, then re-applied.
  const wasPaused = !!ticket.paused_at;
  const willPause = pauseSet.has(newStatus) && !nowDone;
  if (!wasPaused && willPause) {
    const policy = await loadPolicy(db, ticket.sla_policy_id);
    if (policy) {
      const remaining = {};
      const unmet = {
        response: !(f.responded_at || ticket.responded_at),
        restoration: ticket.type === 'incident' && !(f.restored_at || ticket.restored_at),
        resolution: !f.resolved_at && !ticket.resolved_at,
      };
      for (const k of sla.TARGETS) {
        const due = ticket[`${k}_due`];
        if (unmet[k] && due) remaining[k] = sla.businessMinutesBetween(now, new Date(due), policy.calendar);
      }
      f.paused_at = now; f.pause_reason = newStatus; f.sla_remaining = JSON.stringify(remaining);
    }
  } else if (wasPaused && !willPause && !(wasDone && !nowDone)) {
    const policy = await loadPolicy(db, ticket.sla_policy_id);
    const remaining = ticket.sla_remaining || {};
    if (policy) {
      for (const k of sla.TARGETS) {
        const metNow = k === 'response' ? (f.responded_at || ticket.responded_at)
          : k === 'restoration' ? (f.restored_at || ticket.restored_at) : (f.resolved_at || ticket.resolved_at);
        if (remaining[k] !== undefined && !metNow) f[`${k}_due`] = sla.addBusinessMinutes(now, remaining[k], policy.calendar);
      }
    }
    f.paused_at = null; f.pause_reason = null; f.sla_remaining = null;
  }
  if (nowDone && wasPaused) { f.paused_at = null; f.pause_reason = null; f.sla_remaining = null; }

  const updated = await patch(db, ticket.id, f);
  const who = actor ? actor.name : 'The system';
  await event(db, ticket.id, actor, 'status', `${who} changed the status from ${STATUS_LABELS[old]} to ${STATUS_LABELS[newStatus]}.`);
  if (wasPaused && !willPause) await event(db, ticket.id, null, 'sla', 'SLA clock resumed.');
  if (!wasPaused && willPause && f.paused_at) await event(db, ticket.id, null, 'sla', `SLA clock paused: ${STATUS_LABELS[newStatus]}.`);

  const full = await summary(db, updated.id);
  await notifyStatus(db, full, newStatus, actor);
  return full;
}

async function notifyStatus(db, t, newStatus, actor) {
  const customerFacing = t.requester_email && ['resolved', 'pending_customer'].includes(newStatus) && actor && actor.kind === 'staff';
  if (customerFacing) {
    const to = { id: t.requester_id, email: t.requester_email, name: t.requester_name, kind: 'customer' };
    const text = newStatus === 'resolved'
      ? `Your ticket has been marked as resolved. If it is fixed, please confirm. If not, you can reopen it within the allowed period.\n\nResolution: ${t.resolution_note || t.resolution_code || ''}`
      : 'We need more information from you before we can continue. Please reply to this message or add a comment in the portal.';
    await notifications.enqueue(db, {
      kind: 'ticket_update', ticketId: t.id, to, replyTo: await notifications.replyAddress(db, t.queue, t.mailbox_id), subject: `[${t.ref}] ${STATUS_LABELS[newStatus]}: ${t.subject}`.slice(0, 200),
      body: `${text}\n\n${t.ref}: ${t.subject}\n${notifications.link(to, t.ref)}\n`,
    });
  }
  if (actor && actor.kind === 'customer' && t.assignee_id && ['open', 'closed'].includes(newStatus)) {
    const a = (await db.query('select id, email, name, kind, role from users where id = $1 and active', [t.assignee_id])).rows[0];
    if (a) {
      await notifications.enqueue(db, {
        kind: 'ticket_update', ticketId: t.id, to: a, subject: `[${t.ref}] Customer ${newStatus === 'open' ? 'reopened' : 'confirmed resolution of'} the ticket`,
        body: `${actor.name} ${newStatus === 'open' ? 'reopened' : 'confirmed the resolution of'} ${t.ref}: ${t.subject}\n${notifications.link(a, t.ref)}\n`,
      });
    }
  }
}

/** Add a comment, applying SLA and status side effects. */
async function addComment(db, ticket, { author, authorLabel = '', body, internal = false, source = 'portal', messageId = null }) {
  const text = String(body || '').trim();
  if (!text) throw new UserError('A comment cannot be empty.');
  const isStaff = author && author.kind === 'staff';
  const isInternal = !!internal && isStaff;
  await db.query(
    `insert into ticket_comments (ticket_id, author_id, author_label, body, internal, source, message_id) values ($1,$2,$3,$4,$5,$6,$7)`,
    [ticket.id, author ? author.id : null, authorLabel || (author ? author.name : ''), text.slice(0, 20000), isInternal, source, messageId]);
  let t = ticket;
  const f = {};
  if (isStaff && !isInternal && !ticket.responded_at) f.responded_at = new Date();
  if (Object.keys(f).length) t = await patch(db, ticket.id, f); else await db.query('update tickets set updated_at = now() where id = $1', [ticket.id]);
  t = await summary(db, ticket.id);
  if (!isStaff && t.status === 'pending_customer') t = await setStatus(db, t, 'open', author);
  else if (isStaff && !isInternal && t.status === 'new') t = await setStatus(db, t, 'open', author);

  if (!isInternal) {
    if (isStaff && t.requester_email) {
      const to = { id: t.requester_id, email: t.requester_email, name: t.requester_name, kind: 'customer' };
      await notifications.enqueue(db, {
        kind: 'ticket_comment', ticketId: t.id, to, replyTo: await notifications.replyAddress(db, t.queue, t.mailbox_id), subject: `[${t.ref}] New update: ${t.subject}`.slice(0, 200),
        body: `${author.name} wrote:\n\n${text.slice(0, 3000)}\n\n${notifications.link(to, t.ref)}\n`,
      });
    } else if (!isStaff) {
      const targets = [t.assignee_id, t.exec_engineer_id].filter(Boolean);
      const users = (await db.query('select id, email, name, kind, role from users where id = any($1) and active', [[...new Set(targets)]])).rows;
      for (const u of users) {
        await notifications.enqueue(db, {
          kind: 'ticket_comment', ticketId: t.id, to: u, subject: `[${t.ref}] Customer replied: ${t.subject}`.slice(0, 200),
          body: `${authorLabel || (author && author.name) || 'The customer'} wrote:\n\n${text.slice(0, 3000)}\n\n${notifications.link(u, t.ref)}\n`,
        });
      }
    }
  }
  return t;
}

async function assign(db, ticket, assigneeId, actor) {
  let a = null;
  if (assigneeId) {
    a = (await db.query(`select id, name, email, kind, role from users where id = $1 and kind = 'staff' and active`, [assigneeId])).rows[0];
    if (!a) throw new UserError('Choose an active member of staff.');
    if (ticket.queue === 'security' && !perms.can(a, 'security.view')) throw new UserError('That person does not have access to the Security queue.');
  }
  await patch(db, ticket.id, { assignee_id: assigneeId || null });
  await event(db, ticket.id, actor, 'assign', `${actor.name} assigned the ticket to ${a ? a.name : 'nobody'}.`, true);
  if (a && a.id !== actor.id) {
    await notifications.enqueue(db, {
      kind: 'ticket_assigned', ticketId: ticket.id, to: a, subject: `[${ticket.ref}] Assigned to you: ${ticket.subject}`.slice(0, 200),
      body: `${actor.name} assigned ${ticket.ref} to you.\n\nSummary: ${ticket.subject}\n${notifications.link(a, ticket.ref)}\n`,
    });
  }
  return summary(db, ticket.id);
}

async function escalate(db, ticket, tier, actor, reason) {
  if (!['l1', 'l2', 'l3'].includes(tier)) throw new UserError('Unknown tier.');
  await patch(db, ticket.id, { tier });
  await event(db, ticket.id, actor, 'escalate', `${actor ? actor.name : 'The system'} moved the ticket to ${tier.toUpperCase()}${reason ? ': ' + reason : ''}.`, true);
  return summary(db, ticket.id);
}

/** Change impact/urgency. The SLA clock keeps its elapsed time; only the target changes. */
async function reprioritise(db, ticket, impact, urgency, actor) {
  if (ticket.paused_at) throw new UserError('Resume the ticket (change its status) before changing the priority.');
  const st = await settings.getAll(db, ['priority_matrix']);
  const priority = priorityLib.compute(st.priority_matrix, impact, urgency);
  const f = { impact, urgency, priority };
  const done = ['resolved', 'closed', 'cancelled'].includes(ticket.status);
  if (!done && priority !== ticket.priority) {
    const policy = await loadPolicy(db, ticket.sla_policy_id);
    const oldT = policy && policy.targets[ticket.priority]; const newT = policy && policy.targets[priority];
    if (oldT && newT) {
      const now = new Date();
      for (const k of sla.TARGETS) {
        const due = ticket[`${k}_due`];
        const met = k === 'response' ? ticket.responded_at : k === 'restoration' ? ticket.restored_at : ticket.resolved_at;
        if (!due || met) continue;
        const remainingOld = sla.businessMinutesBetween(now, new Date(due), policy.calendar);
        const elapsed = oldT[k] - remainingOld;
        const remainingNew = newT[k] - elapsed;
        f[`${k}_due`] = remainingNew <= 0 ? now : sla.addBusinessMinutes(now, remainingNew, policy.calendar);
      }
      f.sla_flags = JSON.stringify({});
    }
  }
  await patch(db, ticket.id, f);
  await event(db, ticket.id, actor, 'priority',
    `${actor.name} changed the priority from ${priorityLib.LABELS[ticket.priority]} to ${priorityLib.LABELS[priority]}.`);
  return summary(db, ticket.id);
}


/**
 * Attach an unverified (e-mail) ticket to a customer / CSID / service after a person has checked the sender (EMAIL-005).
 * The SLA clock is measured from the time the e-mail arrived, then the execution engineer is routed and notified.
 */
async function verifyTicket(db, ticket, { customerId, csidId, serviceId, siteId, requesterId }, actor) {
  if (!ticket.needs_verification) throw new UserError('This ticket is already verified.');
  const { contractId, contractPolicyId, service } = await validateRelations(db, { customerId, csidId, serviceId, siteId, enforceActive: false });
  if (!customerId) throw new UserError('Choose the customer.');
  let requester = null;
  if (requesterId) {
    requester = (await db.query(`select id, name, email from users where id = $1 and customer_id = $2 and kind = 'customer' and active`, [requesterId, customerId])).rows[0];
    if (!requester) throw new UserError('That contact does not belong to this customer.');
  }
  let policyId = (service && service.sla_policy_id) || null;
  if (!policyId && contractPolicyId) policyId = contractPolicyId;
  if (!policyId) policyId = ticket.sla_policy_id || (await settings.get(db, 'default_sla_policy', null));
  const policy = await loadPolicy(db, policyId);
  const dues = computeDues(policy, ticket.priority, ticket.type, new Date(ticket.created_at));
  const f = { customer_id: customerId, csid_id: csidId || null, service_id: serviceId || null, contract_id: contractId, site_id: siteId || null,
    needs_verification: false, sla_policy_id: policy ? policy.id : null, ...dues, sla_flags: JSON.stringify({}) };
  if (requester) Object.assign(f, { requester_id: requester.id, requester_email: requester.email, requester_name: requester.name });
  await patch(db, ticket.id, f);
  await db.query('update attachments set customer_id = $2 where ticket_id = $1', [ticket.id, customerId]);
  await event(db, ticket.id, actor, 'verification', `${actor.name} verified the sender and linked the ticket to the customer.`, true);
  return (await routeEngineer(db, await summary(db, ticket.id))).ticket;
}

module.exports = {
  verifyTicket, UserError, OPEN_STATUSES, ALL_STATUSES, STATUS_LABELS, loadPolicy, computeDues, createTicket, routeEngineer, currentAssignment,
  getVisible, summary, setStatus, addComment, assign, escalate, reprioritise, event, patch, validateRelations, governingContract,
};
