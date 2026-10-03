// Read-only: apply the new refund ceiling (lib/refund-accounting.ts) to every
// captured order payment, set-based, and list any where the gateway counter
// alone would still offer money the dealer already had back on the balance rail.
import { pgClient } from "./lib/db.js";

async function main() {
  const rows = await pgClient`
    WITH bal AS (
      SELECT dl.reference_id AS order_id,
             SUM(CASE WHEN dl.type = 'credit' THEN dl.amount ELSE -dl.amount END) AS net
        FROM dealer_ledger dl
       WHERE COALESCE(dl.voucher_type, '') <> 'Receipt'
         AND ( dl.reference_type = 'adjustment'
            OR (dl.type = 'credit' AND dl.reference_type = 'refund')
            OR (dl.type = 'credit' AND dl.reference_type = 'order'
                AND dl.voucher_type = 'Adjustment') )
       GROUP BY dl.reference_id
    )
    SELECT rp.order_id::text AS "orderId", rp.status::text AS status,
           rp.amount::float8 AS amount, rp.amount_refunded::float8 AS refunded,
           GREATEST(0, rp.amount - rp.amount_refunded)::float8 AS "gatewayRemaining",
           COALESCE(bal.net, 0)::float8 AS "balanceRefunded",
           GREATEST(0, (rp.amount - rp.amount_refunded)
                       - GREATEST(0, COALESCE(bal.net, 0)))::float8 AS "newCeiling",
           o.status::text AS "orderStatus", o.grand_total::float8 AS "grandTotal",
           d.code AS "dealerCode", d.name AS "dealerName"
      FROM razorpay_payments rp
      LEFT JOIN bal ON bal.order_id = rp.order_id
      LEFT JOIN orders o ON o.id = rp.order_id
      LEFT JOIN dealers d ON d.id = rp.dealer_id
     WHERE rp.kind = 'order_payment' AND rp.order_id IS NOT NULL
       AND rp.status IN ('paid', 'refunded')
       AND GREATEST(0, rp.amount - rp.amount_refunded)
           - GREATEST(0, (rp.amount - rp.amount_refunded)
                         - GREATEST(0, COALESCE(bal.net, 0))) > 0.01
     ORDER BY rp.created_at
  `;
  if (rows.length === 0) {
    console.log("✓ no captured order payment over-offers a refund under the new ceiling");
  } else {
    console.log(`${rows.length} payment(s) the gateway counter overstates:\n`);
    for (const r of rows) {
      console.log(
        `⚠ ${r.dealerCode} ${r.dealerName} order ${r.orderId} (order ${r.orderStatus}, payment ${r.status})\n` +
        `   paid ${r.amount.toFixed(2)}  gateway-refunded ${r.refunded.toFixed(2)}  ` +
        `balance-refunded ${r.balanceRefunded.toFixed(2)}  grand_total ${Number(r.grandTotal ?? 0).toFixed(2)}\n` +
        `   old ceiling Rs ${r.gatewayRemaining.toFixed(2)} → new ceiling Rs ${r.newCeiling.toFixed(2)}` +
        `  (was over-offering Rs ${(r.gatewayRemaining - r.newCeiling).toFixed(2)})\n`
      );
    }
  }
  await pgClient.end();
}
main().catch(async e => { console.error(e); await pgClient.end(); process.exit(1); });
