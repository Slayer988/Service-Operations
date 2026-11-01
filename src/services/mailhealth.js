'use strict';
// Shared-mailbox monitoring: decides whether each enabled mailbox is being read, and tells supervisors when one stops
// (and again when it recovers). One alert per outage: the alert_state column is claimed atomically before sending.
const config = require('../config');
const notifications = require('./notifications');

/** Pure: is this mailbox healthy right now? `mb` is a row from the mailboxes table. */
function assess(mb, now = Date.now()) {
  if (!mb.enabled) return { healthy: true, reason: 'disabled' };
  if (mb.consecutive_failures >= 3) {
    return { healthy: false, reason: `${mb.consecutive_failures} checks in a row failed: ${mb.last_error || mb.last_status}` };
  }
  // Allow at least three polling intervals before calling it stale, so a slow poll setting never causes false alarms.
  const limitMin = Math.max(mb.stale_minutes, Math.ceil((mb.poll_seconds * 3) / 60));
  if (mb.last_success_at) {
    const ageMin = (now - new Date(mb.last_success_at).getTime()) / 60000;
    if (ageMin > limitMin) return { healthy: false, reason: `no successful check for ${Math.round(ageMin)} minutes` };
  }
  return { healthy: true, reason: 'ok' };
}

async function check(db) {
  // A mailbox that was switched off no longer needs an open alert.
  await db.query(`update mailboxes set alert_state = 'ok' where not enabled and alert_state = 'alerted'`);
  const boxes = (await db.query('select * from mailboxes where enabled')).rows;
  let raised = 0;
  for (const mb of boxes) {
    const a = assess(mb);
    const name = mb.name || mb.key;
    if (!a.healthy && mb.alert_state === 'ok') {
      const claimed = await db.query(`update mailboxes set alert_state = 'alerted' where id = $1 and alert_state = 'ok' returning id`, [mb.id]);
      if (!claimed.rows.length) continue;
      raised++;
      for (const s of await notifications.supervisors(db, mb.queue)) {
        await notifications.enqueue(db, {
          kind: 'mailbox_down', to: s, dedupeKey: `mailbox_down:${mb.id}:${Date.now()}:${s.id}`,
          subject: `Shared mailbox is not being read: ${mb.address}`,
          body: `The ${name} mailbox (${mb.address}) is not being read, so customer e-mails are NOT becoming tickets.\nReason: ${a.reason}\nLast successful check: ${mb.last_success_at || 'never'}\nCheck it on the E-mail page: ${config.baseUrl}/mail\nYou will get another message when it recovers.`,
        });
      }
    } else if (a.healthy && mb.alert_state === 'alerted') {
      const claimed = await db.query(`update mailboxes set alert_state = 'ok' where id = $1 and alert_state = 'alerted' returning id`, [mb.id]);
      if (!claimed.rows.length) continue;
      for (const s of await notifications.supervisors(db, mb.queue)) {
        await notifications.enqueue(db, {
          kind: 'mailbox_recovered', to: s, dedupeKey: `mailbox_up:${mb.id}:${Date.now()}:${s.id}`,
          subject: `Shared mailbox is being read again: ${mb.address}`,
          body: `The ${name} mailbox (${mb.address}) is working again. Mail that arrived during the outage is picked up automatically.\n${config.baseUrl}/mail`,
        });
      }
    }
  }
  return raised;
}

module.exports = { assess, check };
