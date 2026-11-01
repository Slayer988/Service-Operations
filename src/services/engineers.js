'use strict';
// Execution engineer assignment per service or contract, with full history (SLA-009, SLA-014).
const audit = require('../lib/audit');
const { UserError } = require('./tickets');

async function assignEngineer(db, { entity, entityId, engineerId, backupId, effectiveFrom, reason, actor, ip }) {
  if (!['service', 'contract'].includes(entity)) throw new UserError('Unknown entity.');
  if (!engineerId) throw new UserError('Choose the execution engineer.');
  if (backupId && backupId === engineerId) throw new UserError('The backup engineer must be a different person.');
  if (!reason) throw new UserError('Give a reason for the change.');
  const col = entity === 'service' ? 'service_id' : 'contract_id';
  const ids = [engineerId, backupId].filter(Boolean);
  const staff = (await db.query(`select id from users where id = any($1) and kind = 'staff' and active`, [ids])).rows;
  if (staff.length !== ids.length) throw new UserError('Engineers must be active members of staff.');
  const table = entity === 'service' ? 'services' : 'contracts';
  const target = (await db.query(`select id, customer_id from ${table} where id = $1`, [entityId])).rows[0];
  if (!target) throw new UserError('Not found.', 404);
  const from = effectiveFrom || new Date().toISOString().slice(0, 10);
  const prev = (await db.query(
    `select engineer_id, backup_id from engineer_assignments where entity = $1 and ${col} = $2
        and effective_from <= current_date and (effective_to is null or effective_to >= current_date) order by id desc limit 1`, [entity, entityId])).rows[0];
  await db.query(
    `update engineer_assignments set effective_to = ($3::date - 1) where entity = $1 and ${col} = $2 and (effective_to is null or effective_to >= $3::date)`,
    [entity, entityId, from]);
  await db.query(
    `insert into engineer_assignments (entity, ${col}, engineer_id, backup_id, effective_from, reason, changed_by) values ($1,$2,$3,$4,$5,$6,$7)`,
    [entity, entityId, engineerId, backupId || null, from, reason.slice(0, 500), actor.id]);
  await audit(db, actor, 'engineer_assigned', entity, entityId,
    `engineer ${prev ? prev.engineer_id : 'none'} -> ${engineerId}; backup ${prev && prev.backup_id ? prev.backup_id : 'none'} -> ${backupId || 'none'}; from ${from}; reason: ${reason}`, target.customer_id, ip || '');
}

async function history(db, entity, entityId) {
  const col = entity === 'service' ? 'service_id' : 'contract_id';
  return (await db.query(
    `select a.*, e.name as engineer_name, b.name as backup_name, c.name as changed_by_name
       from engineer_assignments a join users e on e.id = a.engineer_id left join users b on b.id = a.backup_id left join users c on c.id = a.changed_by
      where a.entity = $1 and a.${col} = $2 order by a.id desc`, [entity, entityId])).rows;
}

module.exports = { assignEngineer, history };
