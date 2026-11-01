'use strict';
// Attributable audit trail for privileged and sensitive actions (AUD-001, AUD-002, NFR-004).
async function audit(db, actor, action, entity = '', entityId = '', detail = '', customerId = null, ip = '') {
  await db.query(
    `insert into audit_log (actor_id, actor_email, action, entity, entity_id, customer_id, detail, ip)
     values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [actor ? actor.id : null, actor ? actor.email : 'system', action, entity, String(entityId || ''), customerId, String(detail).slice(0, 1000), ip || ''],
  );
}
module.exports = audit;
