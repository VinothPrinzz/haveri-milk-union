// Read-only: compare Day Book order-sales under the OLD basis (created
// IST day) vs the NEW basis (delivery date) for 2026-07-02..17 — subsidy
// (PD0191S) value per day should be exactly one line per dealer under the
// new basis. Also lists the order-change ledger lines the new 3b query
// will surface.
import { pgClient } from "./lib/db.js";

async function main() {
  const days: string[] = [];
  for (let d = 2; d <= 17; d++) days.push(`2026-07-${String(d).padStart(2, "0")}`);

  console.log("date        | old sales ₹ | new sales ₹ | old subsidy ₹ | new subsidy ₹ | subsidy dealers (new)");
  for (const date of days) {
    const [oldRow] = await pgClient`
      SELECT COALESCE(SUM(o.grand_total),0)::numeric AS total,
             COALESCE(SUM((SELECT SUM(oi.line_total) FROM order_items oi
                            JOIN products p ON p.id = oi.product_id
                           WHERE oi.order_id = o.id AND p.code = 'PD0191S')),0)::numeric AS sub
        FROM orders o
       WHERE o.created_at >= ${date}::date - interval '1 day'
         AND o.created_at <  ${date}::date + interval '2 days'
         AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${date}::date
         AND o.status IN ('confirmed','dispatched','delivered')
    `;
    const [newRow] = await pgClient`
      SELECT COALESCE(SUM(o.grand_total),0)::numeric AS total,
             COALESCE(SUM((SELECT SUM(oi.line_total) FROM order_items oi
                            JOIN products p ON p.id = oi.product_id
                           WHERE oi.order_id = o.id AND p.code = 'PD0191S')),0)::numeric AS sub,
             COUNT(DISTINCT o.dealer_id) FILTER (WHERE EXISTS (
               SELECT 1 FROM order_items oi JOIN products p ON p.id = oi.product_id
                WHERE oi.order_id = o.id AND p.code = 'PD0191S')) AS subdealers
        FROM orders o
       WHERE o.created_at >= ${date}::date - interval '31 days'
         AND o.created_at <  ${date}::date + interval '2 days'
         AND COALESCE(o.delivery_date,
                      (o.created_at AT TIME ZONE 'Asia/Kolkata')::date) = ${date}::date
         AND o.status IN ('confirmed','dispatched','delivered')
    `;
    console.log(
      `${date}  | ${Number(oldRow!.total).toFixed(2).padStart(10)} | ${Number(newRow!.total).toFixed(2).padStart(10)} | ` +
      `${Number(oldRow!.sub).toFixed(2).padStart(9)} | ${Number(newRow!.sub).toFixed(2).padStart(9)} | ${newRow!.subdealers}`
    );
  }

  // Per-dealer sanity under the NEW basis: any dealer-date where subsidy
  // value exceeds one line's worth (i.e. still double-counted)?
  const bad = await pgClient`
    SELECT o.delivery_date::text AS dd, d.code,
           SUM(oi.line_total)::numeric AS sub, COUNT(*) AS lines
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id AND p.code = 'PD0191S'
      JOIN dealers d ON d.id = o.dealer_id
     WHERE o.delivery_date >= '2026-07-02'::date
       AND o.status IN ('confirmed','dispatched','delivered')
     GROUP BY o.delivery_date, d.code
    HAVING COUNT(*) > 1
     ORDER BY dd
  `;
  console.log(`\nDealer-days with >1 subsidy line under NEW basis: ${bad.length}`);
  for (const b of bad) console.log(`  ${b.dd} ${b.code} lines=${b.lines} ₹${Number(b.sub).toFixed(2)}`);

  // Order-change lines the new 3b query surfaces (whole range).
  const oc = await pgClient`
    SELECT (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date::text AS day,
           dl.type::text AS t, dl.reference_type::text AS rt,
           dl.amount::numeric AS a, d.code, LEFT(dl.description, 60) AS descr
      FROM dealer_ledger dl
      JOIN dealers d ON d.id = dl.dealer_id
     WHERE dl.created_at >= '2026-07-01'::timestamptz
       AND (
             dl.reference_type = 'adjustment'
          OR (dl.type = 'credit' AND dl.reference_type = 'refund')
          OR (dl.type = 'credit' AND dl.reference_type = 'order'
              AND dl.voucher_type = 'Adjustment')
           )
       AND NOT EXISTS (SELECT 1 FROM ledger_adjustments a WHERE a.ledger_entry_id = dl.id)
     ORDER BY dl.created_at
  `;
  console.log(`\nOrder-change lines that will now appear (${oc.length}):`);
  for (const l of oc) {
    console.log(`  ${l.day}  ${l.code.padEnd(5)} ${l.t === "credit" ? "refund " : "extra-debit"} ₹${Number(l.a).toFixed(2).padStart(8)}  ${l.descr}`);
  }
  await pgClient.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
