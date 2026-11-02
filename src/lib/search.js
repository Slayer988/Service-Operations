'use strict';
// The search box in the top bar. One rule for what "matches a ticket" so the box, the Tickets list and the customer's list agree.

/** The text to look for, trimmed and limited; '' when it is too short to search. */
function term(v) {
  const s = String(v === undefined || v === null ? '' : v).replace(/[\u0000-\u001F]/g, ' ').trim().slice(0, 100);
  return s.length >= 2 ? s : '';
}

/** An ilike pattern with the wildcard characters of the text itself made harmless. */
const like = (text) => `%${text.replace(/[%_\\]/g, '\\$&')}%`;

/** Looks like a ticket reference (INC-000123), so Enter can open that ticket directly. */
const looksLikeRef = (text) => /^[A-Za-z]{2,5}-[A-Za-z0-9]{3,12}$/.test(text);

/**
 * SQL for "this ticket matches the pattern in parameter $n". Staff match on subject, reference, sender (name and address), customer name,
 * CSID and what was written on the ticket; customers (internal = false) match the same except that internal notes are never searched.
 * The ticket table must be aliased `t`.
 */
function ticketClause(n, { internal = false } = {}) {
  return `(t.subject ilike $${n} or t.ref ilike $${n} or t.requester_email ilike $${n} or t.requester_name ilike $${n}
    or exists (select 1 from customers sc where sc.id = t.customer_id and sc.name ilike $${n})
    or exists (select 1 from csids sx where sx.id = t.csid_id and sx.csid ilike $${n})
    or exists (select 1 from ticket_comments tc where tc.ticket_id = t.id${internal ? '' : ' and not tc.internal'} and tc.body ilike $${n}))`;
}

module.exports = { term, like, looksLikeRef, ticketClause };
