// Read-only: run the day-book route's NEW orderSales + orderChanges SQL
// verbatim (same binds) for a few dates to prove the route executes.
import { pgClient } from "./lib/db.js";

async function run(date: string, route: string | null) {
  const orderSales = await pgClient`
    SELECT
      o.id, o.created_at AS at, 'sale' AS kind, 'order_sale' AS type,
      CASE
        WHEN d.customer_type::text LIKE 'Credit Inst%' THEN 'credit'
        WHEN o.payment_mode::text = 'upi'              THEN 'upi'
        ELSE 'wallet'
      END AS mode,
      o.grand_total::float8 AS amount,
      ('#' || left(o.id::text, 8)) AS reference,
      inv.invoice_number AS "docNo",
      d.code AS "dealerCode", d.name AS "dealerName",
      r.id::text AS "routeId", r.name AS "routeName",
      u.name AS "byName"
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    LEFT JOIN routes r ON r.id = d.route_id
    LEFT JOIN users u ON u.id = o.placed_by
    LEFT JOIN LATERAL (
      SELECT i.invoice_number FROM invoices i
       WHERE i.order_id = o.id LIMIT 1
    ) inv ON true
    WHERE o.created_at >= ${date}::date - interval '31 days'
      AND o.created_at <  ${date}::date + interval '2 days'
      AND COALESCE(o.delivery_date,
                   (o.created_at AT TIME ZONE 'Asia/Kolkata')::date)
          = ${date}::date
      AND o.status IN ('confirmed', 'dispatched', 'delivered')
      AND ( ${route}::text IS NULL
            OR (${route}::text = 'unassigned' AND d.route_id IS NULL)
            OR d.route_id::text = ${route}::text )
    ORDER BY o.created_at ASC
  `;
  const orderChanges = await pgClient`
    SELECT
      dl.id, dl.created_at AS at,
      CASE WHEN dl.type = 'credit' THEN 'refund' ELSE 'adjustment' END AS kind,
      CASE
        WHEN dl.type = 'debit'                  THEN 'modify_debit'
        WHEN dl.reference_type = 'adjustment'   THEN 'modify_refund'
        ELSE 'cancel_refund'
      END AS type,
      'balance' AS mode, dl.amount::float8 AS amount,
      dl.description AS reference, dl.voucher_no AS "docNo",
      d.code AS "dealerCode", d.name AS "dealerName",
      r.id::text AS "routeId", r.name AS "routeName",
      u.name AS "byName"
    FROM dealer_ledger dl
    JOIN dealers d ON d.id = dl.dealer_id
    LEFT JOIN routes r ON r.id = d.route_id
    LEFT JOIN users u ON u.id = dl.performed_by
    WHERE (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${date}::date
      AND dl.amount > 0
      AND (
            dl.reference_type = 'adjustment'
         OR (dl.type = 'credit' AND dl.reference_type = 'refund')
         OR (dl.type = 'credit' AND dl.reference_type = 'order'
             AND dl.voucher_type = 'Adjustment')
          )
      AND NOT EXISTS (
            SELECT 1 FROM ledger_adjustments a
             WHERE a.ledger_entry_id = dl.id
          )
      AND ( ${route}::text IS NULL
            OR (${route}::text = 'unassigned' AND d.route_id IS NULL)
            OR d.route_id::text = ${route}::text )
    ORDER BY dl.created_at ASC
  `;
  const c13 = (orderSales as any[]).filter((l) => l.dealerCode === "C13");
  console.log(`${date}: sales=${orderSales.length} rows  changes=${orderChanges.length} rows`);
  for (const l of c13) console.log(`   C13 sale ${String(l.reference)} ₹${l.amount.toFixed(2)} mode=${l.mode}`);
  for (const l of orderChanges as any[]) console.log(`   change ${l.type} ${l.dealerCode} ₹${l.amount.toFixed(2)}`);
}

async function main() {
  await run("2026-07-09", null);
  await run("2026-07-10", null);
  await run("2026-07-17", null);
  await pgClient.end();
}
main().catch((e) => { console.error(e); process.exit(1); });
