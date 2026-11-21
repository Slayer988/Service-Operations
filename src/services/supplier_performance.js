'use strict';
// Supplier performance (1.27.0), from the purchase orders: delivered on time (received by the deliver-by date, in the application time
// zone), how late the late ones were, orders past their date now, the quality rating given when the order was received, and the value
// ordered per currency. Cancelled and draft orders are not counted.
const config = require('../config');

const QUALITY = { 5: 'Excellent', 4: 'Good', 3: 'Acceptable', 2: 'Poor', 1: 'Unacceptable' };
const WATCH_ON_TIME = 80; // below this share delivered on time, or an average quality below 3, a supplier is marked "watch"

/** Per supplier (all, or one): { supplier_id, name, kind, orders, delivered, on_time, late, avg_days_late, open_late, rated, quality, spend: {CUR: n}, on_time_pct, watch }.
 *  since: 'YYYY-MM-DD' counts orders issued from that day (null: all). */
async function performance(db, { supplierId = null, since = null, today } = {}) {
  const params = [config.timezone, today]; const where = [`po.status in ('issued','received','closed')`];
  if (supplierId) { params.push(supplierId); where.push(`po.supplier_id = $${params.length}`); }
  if (since) { params.push(since); where.push(`po.issue_date >= $${params.length}::date`); }
  const rows = (await db.query(`
    with o as (
      select po.*, (po.received_at at time zone $1::text)::date as got
        from purchase_orders po where ${where.join(' and ')})
    select s.id as supplier_id, s.name, s.code, s.kind, s.status,
           count(o.id)::int as orders,
           count(o.got)::int as delivered,
           count(*) filter (where o.got is not null and (o.delivery_date is null or o.got <= o.delivery_date))::int as on_time,
           count(*) filter (where o.got is not null and o.got > o.delivery_date)::int as late,
           round(avg(o.got - o.delivery_date) filter (where o.got > o.delivery_date), 1) as avg_days_late,
           count(*) filter (where o.status = 'issued' and o.delivery_date < $2::date)::int as open_late,
           count(o.quality)::int as rated, round(avg(o.quality), 1) as quality
      from suppliers s join o on o.supplier_id = s.id
     group by s.id order by s.name`, params)).rows;
  const spend = (await db.query(`select po.supplier_id, po.currency, sum(po.subtotal) as amount from purchase_orders po where $1::text is not null and $2::date is not null and ${where.join(' and ')} group by 1, 2`, params)).rows;
  return rows.map((r) => {
    const out = { ...r, avg_days_late: r.avg_days_late === null ? null : Number(r.avg_days_late), quality: r.quality === null ? null : Number(r.quality), spend: {} };
    for (const x of spend) if (String(x.supplier_id) === String(r.supplier_id)) out.spend[x.currency] = Number(x.amount);
    out.on_time_pct = r.delivered ? Math.round((100 * r.on_time) / r.delivered) : null;
    out.watch = (out.on_time_pct !== null && r.delivered >= 2 && out.on_time_pct < WATCH_ON_TIME) || (out.quality !== null && out.quality < 3) || r.open_late > 0;
    return out;
  });
}

module.exports = { performance, QUALITY, WATCH_ON_TIME };
