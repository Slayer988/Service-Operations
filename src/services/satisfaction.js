'use strict';
// Customer satisfaction: a rating from 1 to 5 with a comment, given when the customer confirms a resolved ticket in the portal, or from
// the links in the resolution e-mail without signing in (each link is signed for that ticket and that address). A poor rating (1 or 2)
// is told to the service managers at once, so someone can call the customer back.
const crypto = require('crypto');
const config = require('../config');
const u = require('../lib/util');
const notifications = require('./notifications');
const { UserError } = require('./tickets');

const LABELS = { 5: 'Excellent', 4: 'Good', 3: 'OK', 2: 'Poor', 1: 'Very poor' };
const WINDOW_DAYS = 30;

const sign = (t) => crypto.createHmac('sha256', `${config.sessionSecret}:satisfaction`).update(`${t.id}:${String(t.requester_email || '').toLowerCase()}`).digest('base64url').slice(0, 32);
function valid(t, token) {
  if (!t || !t.requester_email || typeof token !== 'string' || token.length !== 32) return false;
  const a = Buffer.from(sign(t)); const b = Buffer.from(token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const link = (t, score) => `${config.baseUrl}/rate/${t.ref}/${sign(t)}${score ? `?score=${score}` : ''}`;

/** The lines added to the resolution e-mail. */
function emailBlock(t) {
  if (!t.requester_email) return '';
  return `\nHow did we do? Choose a rating (one click, no sign-in):\n${[5, 4, 3, 2, 1].map((n) => `  ${n} ${LABELS[n]}: ${link(t, n)}`).join('\n')}\n`;
}

/** Can this ticket still be rated? */
function open(t) {
  if (!['resolved', 'closed'].includes(t.status)) return false;
  const since = t.resolved_at || t.closed_at;
  return !since || (Date.now() - new Date(since).getTime()) / 86400000 <= WINDOW_DAYS;
}

async function rate(db, t, score, comment, via, actor = null) {
  const n = u.intIn(score, 1, 5);
  if (!n) throw new UserError('Choose a rating from 1 to 5.');
  if (!open(t)) throw new UserError(`This ticket can no longer be rated (ratings are taken up to ${WINDOW_DAYS} days after it is resolved).`);
  const text = u.str(comment, 1000);
  const before = t.satisfaction;
  await db.query('update tickets set satisfaction = $2, satisfaction_comment = $3, satisfaction_at = now(), satisfaction_via = $4 where id = $1', [t.id, n, text, via]);
  await db.query(`insert into ticket_events (ticket_id, actor_id, kind, text, internal) values ($1,$2,'rating',$3,true)`,
    [t.id, actor ? actor.id : null, `${t.requester_name || 'The customer'} rated the service ${n}/5 (${LABELS[n]})${before ? `, changing the earlier ${before}/5` : ''}${text ? `: "${text}"` : '.'}`]);
  if (n <= 2 && !(before && before <= 2)) {
    const tickets = require('./tickets');
    const full = await tickets.summary(db, t.id);
    for (const s of await notifications.supervisors(db, full.queue)) {
      await notifications.enqueue(db, { kind: 'poor_rating', ticketId: t.id, to: s, dedupeKey: `poor-rating-${t.id}-${s.email}`,
        subject: `[${t.ref}] Poor rating ${n}/5 from ${full.customer_name || full.requester_name || 'a customer'}`.slice(0, 200),
        body: `${full.requester_name || 'The customer'} rated ${t.ref} ${n}/5 (${LABELS[n]}).\n\n${text ? `Their words: "${text}"\n\n` : ''}Handled by: ${full.assignee_name || 'nobody'}\nSubject: ${full.subject}\n${notifications.link(s, t.ref)}\n\nConsider calling them back.\n` });
    }
  }
  return n;
}

module.exports = { LABELS, WINDOW_DAYS, sign, valid, link, emailBlock, open, rate };
