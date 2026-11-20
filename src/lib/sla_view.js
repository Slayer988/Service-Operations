'use strict';
// How the SLA of one ticket is shown to staff: each target with its state and the time left or over, and one overall state for the card
// and the banner under the ticket title, so the agent sees at a glance what needs attention.
//   met       met on time                 missed    met, but late (or missed earlier, before a reopen or priority change)
//   breached  not met and past due        risk      not met, due within the hour or with less than a quarter of its time left
//   running   not met, time left          paused    the clock is stopped (waiting for the customer or a vendor)

const RISK_SHARE = 0.25;
const RISK_MINUTES = 60;

/** "2d 3h", "3h 05m", "12m", "under a minute". */
function span(ms) {
  const m = Math.max(0, Math.round(Math.abs(ms) / 60000));
  if (m < 1) return 'under a minute';
  const d = Math.floor(m / 1440); const h = Math.floor((m % 1440) / 60); const mm = m % 60;
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${String(mm).padStart(2, '0')}m`;
  return `${mm}m`;
}

function target(name, key, due, met, ticket, now) {
  if (!due) return null;
  const dueD = new Date(due);
  const earlier = (ticket.sla_breaches || {})[key];
  if (met) {
    const late = new Date(met) - dueD;
    if (late > 0) return { name, key, due, state: 'missed', label: 'Missed', detail: `met ${span(late)} late` };
    if (earlier) return { name, key, due, state: 'missed', label: 'Missed earlier', detail: `was due ${new Date(earlier.due).toISOString()}`, earlierDue: earlier.due };
    return { name, key, due, state: 'met', label: 'Met', detail: `${span(-late)} early` };
  }
  if (ticket.paused_at) return { name, key, due, state: earlier ? 'missed' : 'paused', label: earlier ? 'Missed earlier' : 'Paused', detail: earlier ? '' : 'clock stopped', earlierDue: earlier && earlier.due };
  const left = dueD - now;
  if (left <= 0) return { name, key, due, state: 'breached', label: 'Breached', detail: `overdue by ${span(left)}` };
  if (earlier) return { name, key, due, state: 'missed', label: 'Missed earlier', detail: `${span(left)} left on the new target`, earlierDue: earlier.due };
  const total = dueD - new Date(ticket.created_at || now);
  const risk = left <= RISK_MINUTES * 60000 || (total > 0 && left / total <= RISK_SHARE);
  return { name, key, due, state: risk ? 'risk' : 'running', label: risk ? 'At risk' : 'On track', detail: `${span(left)} left` };
}

const ORDER = ['breached', 'missed', 'risk', 'paused', 'running', 'met'];

/** { rows, state, headline } for a ticket. state is the worst of the rows (see ORDER); 'none' when the ticket has no SLA. */
function view(ticket, now = new Date()) {
  const rows = [
    target('Response', 'response', ticket.response_due, ticket.responded_at, ticket, now),
    target('Restoration', 'restoration', ticket.type === 'request' ? null : ticket.restoration_due, ticket.restored_at, ticket, now),
    target('Resolution', 'resolution', ticket.resolution_due, ticket.resolved_at, ticket, now),
  ].filter(Boolean);
  if (!rows.length) return { rows, state: 'none', headline: 'No SLA applies to this ticket.' };
  const worst = ORDER.find((s) => rows.some((r) => r.state === s));
  const first = rows.find((r) => r.state === worst);
  const closed = ['closed', 'cancelled'].includes(ticket.status);
  const headline = {
    breached: `SLA breached: ${first.name.toLowerCase()} is overdue by ${first.detail.replace('overdue by ', '')}.`,
    missed: `SLA missed: the ${first.name.toLowerCase()} target was not met in time.`,
    risk: `SLA at risk: ${first.name.toLowerCase()} is due in ${first.detail.replace(' left', '')}.`,
    paused: 'SLA clock paused while waiting. It restarts when the ticket is back in progress.',
    running: `SLA on track: next target ${first.name.toLowerCase()}, ${first.detail}.`,
    met: closed ? 'All SLA targets were met.' : 'All SLA targets met so far.',
  }[worst];
  return { rows, state: worst, headline };
}

module.exports = { view, span, RISK_SHARE, RISK_MINUTES };
