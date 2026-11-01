'use strict';
// Service catalogue: the services the business offers. Editable by service managers; shown on dashboards and the customer portal.
const { UserError } = require('./tickets');
const audit = require('../lib/audit');

const ICONS = ['grid', 'laptop', 'lock', 'mail', 'wifi', 'printer', 'server', 'shield', 'user', 'clipboard', 'code', 'headset', 'pulse', 'building', 'file', 'chart'];

async function featured(q) {
  return (await q(`select name, category, icon, description, request_type from service_catalogue where active and featured order by sort_order, name limit 8`)).rows;
}

function read(b, categories) {
  const name = String(b.name || '').trim().slice(0, 100);
  if (!name) throw new UserError('Enter a service name.');
  const code = String(b.code || '').trim().toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 20);
  const sort = Number.parseInt(b.sort_order, 10);
  return {
    code, name,
    category: categories.includes(b.category) ? b.category : '',
    description: String(b.description || '').trim().slice(0, 500),
    icon: ICONS.includes(b.icon) ? b.icon : 'grid',
    request_type: b.request_type === 'incident' ? 'incident' : 'request',
    sla_policy_id: Number.parseInt(b.sla_policy_id, 10) || null,
    owner_team: String(b.owner_team || '').trim().slice(0, 100),
    featured: b.featured === 'on',
    active: b.active !== undefined ? b.active === 'on' : true,
    sort_order: Number.isInteger(sort) ? Math.max(0, Math.min(9999, sort)) : 100,
  };
}

async function create(db, actor, ip, b, categories) {
  const f = read(b, categories);
  const code = f.code || `CAT-${Date.now().toString(36).toUpperCase().slice(-6)}`;
  try {
    const r = await db.query(
      `insert into service_catalogue (code, name, category, description, icon, request_type, sla_policy_id, owner_team, featured, active, sort_order, created_by)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning id`,
      [code, f.name, f.category, f.description, f.icon, f.request_type, f.sla_policy_id, f.owner_team, f.featured, f.active, f.sort_order, actor.id]);
    await audit(db, actor, 'catalogue_created', 'catalogue', r.rows[0].id, f.name, null, ip || '');
    return r.rows[0].id;
  } catch (e) {
    if (e.code === '23505') throw new UserError('A catalogue entry with that name or code already exists.');
    if (e.code === '23503') throw new UserError('Unknown SLA policy.');
    throw e;
  }
}

async function update(db, actor, ip, id, b, categories) {
  const f = read(b, categories);
  try {
    const r = await db.query(
      `update service_catalogue set name = $2, category = $3, description = $4, icon = $5, request_type = $6, sla_policy_id = $7, owner_team = $8,
              featured = $9, active = $10, sort_order = $11, code = coalesce(nullif($12, ''), code), updated_at = now() where id = $1 returning id`,
      [id, f.name, f.category, f.description, f.icon, f.request_type, f.sla_policy_id, f.owner_team, f.featured, f.active, f.sort_order, f.code]);
    if (!r.rows[0]) throw new UserError('Catalogue entry not found.', 404);
    // keep the display type of customer services in step with the catalogue name
    await db.query('update services set service_type = $2 where catalogue_id = $1', [id, f.name]);
    await audit(db, actor, 'catalogue_updated', 'catalogue', id, f.name, null, ip || '');
  } catch (e) {
    if (e.code === '23505') throw new UserError('A catalogue entry with that name or code already exists.');
    throw e;
  }
}

/** Delete only when no customer service uses the entry; otherwise it is retired (inactive) so history stays readable. */
async function remove(db, actor, ip, id) {
  const e = (await db.query('select name from service_catalogue where id = $1', [id])).rows[0];
  if (!e) throw new UserError('Catalogue entry not found.', 404);
  const used = (await db.query('select count(*)::int as n from services where catalogue_id = $1', [id])).rows[0].n;
  if (used) {
    await db.query('update service_catalogue set active = false, featured = false, updated_at = now() where id = $1', [id]);
    await audit(db, actor, 'catalogue_retired', 'catalogue', id, e.name, null, ip || '');
    return { deleted: false, used };
  }
  await db.query('delete from service_catalogue where id = $1', [id]);
  await audit(db, actor, 'catalogue_deleted', 'catalogue', id, e.name, null, ip || '');
  return { deleted: true, used: 0 };
}

module.exports = { ICONS, featured, read, create, update, remove };
