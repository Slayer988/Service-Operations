'use strict';
// Project budget against actual (1.27.0). The cost side is the purchase orders raised for the project: committed (issued or received,
// not yet closed) and spent (closed: invoiced by the supplier and settled). The income side is what was invoiced to the customer for the
// project. All figures are before tax, in the project's currency; orders and invoices in another currency are listed apart, not converted.

const WARN_PCT = 90;

const zero = () => ({ committed: 0, spent: 0, billed: 0, paid: 0, other: {} });

/** Budget against actual for some projects: Map id -> figures. projects: rows with id, budget, currency. */
async function forProjects(db, projects) {
  const out = new Map(); if (!projects.length) return out;
  const ids = projects.map((p) => p.id);
  const cur = new Map(projects.map((p) => [String(p.id), p]));
  for (const p of projects) out.set(String(p.id), zero());
  const lpo = (await db.query(`select project_id, currency, status, coalesce(sum(subtotal), 0) as amount, count(*)::int as n from purchase_orders
                                 where project_id = any($1::bigint[]) and status in ('issued','received','closed') group by 1, 2, 3`, [ids])).rows;
  for (const r of lpo) {
    const f = out.get(String(r.project_id)); const p = cur.get(String(r.project_id));
    if (r.currency !== p.currency) { f.other[r.currency] = f.other[r.currency] || { cost: 0, billed: 0 }; f.other[r.currency].cost += Number(r.amount); continue; }
    if (r.status === 'closed') f.spent += Number(r.amount); else f.committed += Number(r.amount);
  }
  const inv = (await db.query(`select project_id, currency, coalesce(sum(subtotal), 0) as amount, coalesce(sum(paid_total * case when total > 0 then subtotal / total else 0 end), 0) as paid
                                 from invoices where project_id = any($1::bigint[]) and status in ('issued','part_paid','paid') group by 1, 2`, [ids])).rows;
  for (const r of inv) {
    const f = out.get(String(r.project_id)); const p = cur.get(String(r.project_id));
    if (r.currency !== p.currency) { f.other[r.currency] = f.other[r.currency] || { cost: 0, billed: 0 }; f.other[r.currency].billed += Number(r.amount); continue; }
    f.billed += Number(r.amount); f.paid += Number(r.paid);
  }
  for (const p of projects) {
    const f = out.get(String(p.id));
    const r2 = (n) => Math.round(n * 100) / 100;
    f.committed = r2(f.committed); f.spent = r2(f.spent); f.billed = r2(f.billed); f.paid = r2(f.paid);
    f.actual = r2(f.committed + f.spent);
    f.budget = p.budget === null || p.budget === undefined ? null : Number(p.budget);
    f.remaining = f.budget === null ? null : r2(f.budget - f.actual);
    f.pct = f.budget ? Math.round((100 * f.actual) / f.budget) : null;
    f.state = f.budget === null ? 'none' : f.actual > f.budget ? 'over' : f.pct >= WARN_PCT ? 'warn' : 'ok';
    f.margin = f.billed ? r2(f.billed - f.actual) : null;
    f.currency = p.currency;
  }
  return out;
}

async function forProject(db, p) { return (await forProjects(db, [p])).get(String(p.id)); }

module.exports = { forProjects, forProject, WARN_PCT };
