// diag-double-refunded-orders.ts - read-only audit of the two refund rails.
//
// For every captured order payment it reports:
//   OVER-OFFER - what Finance > Online Payments would have let an operator
//                refund to the bank ON TOP of money the dealer had already
//                been given back on the balance rail. Closed in code by
//                lib/refund-accounting.ts; this measures the old exposure.
//   REALIZED   - orders where the total handed back (bank + balance) already
//                EXCEEDS what was paid. Real money out of the door.
//
// USAGE (from apps/api):
//   npx tsx src/diag-double-refunded-orders.ts
//   npx tsx src/diag-double-refunded-orders.ts --list   (itemise the over-offers)
import { pgClient } from "./lib/db.js";

const BAL = `
  SELECT dl.reference_id AS order_id,
         SUM(CASE WHEN dl.type = 'credit' THEN dl.amount ELSE -dl.amount END) AS net
    FROM dealer_ledger dl
   WHERE COALESCE(dl.voucher_type, '') <> 'Receipt'
     AND ( dl.reference_type = 'adjustment'
        OR (dl.type = 'credit' AND dl.reference_type = 'refund')
        OR (dl.type = 'credit' AND dl.reference_type = 'order'
            AND dl.voucher_type = 'Adjustment') )
   GROUP BY dl.reference_id`;

async function main() {
  const [tot] = await pgClient.unsafe(`
    WITH bal AS (${BAL})
    SELECT count(*)::int AS n,
           COALESCE(SUM(GREATEST(0, rp.amount - rp.amount_refunded)
                        - GREATEST(0, (rp.amount - rp.amount_refunded)
                                      - GREATEST(0, COALESCE(bal.net, 0)))), 0)::float8 AS "overOffer"
      FROM razorpay_payments rp
      LEFT JOIN bal ON bal.order_id = rp.order_id
     WHERE rp.kind = 'order_payment' AND rp.order_id IS NOT NULL
       AND rp.status IN ('paid','refunded')
       AND GREATEST(0, rp.amount - rp.amount_refunded)
           - GREATEST(0, (rp.amount - rp.amount_refunded)
                         - GREATEST(0, COALESCE(bal.net, 0))) > 0.01`);
  console.log(`OVER-OFFER (refund the finance screen would have allowed but shouldn't):`);
  console.log(`  ${tot!.n} payments, Rs ${Number(tot!.overOffer).toFixed(2)} of exposure now blocked\n`);
  if (process.argv.includes("--list")) {
    const rows = await pgClient.unsafe(`
      WITH bal AS (${BAL})
      SELECT rp.order_id::text AS "orderId", o.status::text AS "orderStatus",
             rp.amount::float8 AS paid, COALESCE(bal.net,0)::float8 AS "balanceRefunded",
             o.grand_total::float8 AS "grandTotal",
             d.code AS "dealerCode", d.name AS "dealerName",
             (GREATEST(0, rp.amount - rp.amount_refunded)
              - GREATEST(0, (rp.amount - rp.amount_refunded)
                            - GREATEST(0, COALESCE(bal.net, 0))))::float8 AS "overOffer"
        FROM razorpay_payments rp
        LEFT JOIN bal ON bal.order_id = rp.order_id
        LEFT JOIN orders o ON o.id = rp.order_id
        LEFT JOIN dealers d ON d.id = rp.dealer_id
       WHERE rp.kind = 'order_payment' AND rp.order_id IS NOT NULL
         AND rp.status IN ('paid','refunded')
         AND GREATEST(0, rp.amount - rp.amount_refunded)
             - GREATEST(0, (rp.amount - rp.amount_refunded)
                           - GREATEST(0, COALESCE(bal.net, 0))) > 0.01
       ORDER BY 8 DESC`);
    for (const r of rows)
      console.log(`   ${r.dealerCode} ${r.dealerName}  order ${r.orderId} (${r.orderStatus})  ` +
        `paid ${r.paid.toFixed(2)}  balance-refunded ${r.balanceRefunded.toFixed(2)}  ` +
        `grand_total ${Number(r.grandTotal ?? 0).toFixed(2)}  ->  over-offer Rs ${r.overOffer.toFixed(2)}`);
  }
  console.log("");

  const dbl = await pgClient.unsafe(`
    WITH bal AS (${BAL})
    SELECT rp.order_id::text AS "orderId", rp.razorpay_payment_id AS "payId",
           rp.amount::float8 AS paid, rp.amount_refunded::float8 AS "gatewayRefunded",
           (COALESCE(bal.net, 0) - COALESCE(rev.net, 0))::float8 AS "balanceRefunded",
           (rp.amount_refunded
            + GREATEST(0, COALESCE(bal.net, 0) - COALESCE(rev.net, 0))
            - rp.amount)::float8 AS excess,
           o.status::text AS "orderStatus", d.code AS "dealerCode", d.name AS "dealerName"
      FROM razorpay_payments rp
      LEFT JOIN bal ON bal.order_id = rp.order_id
      -- Ledger debits that REVERSE a gateway refund point at the
      -- razorpay_payments row, not the order, so they need their own join or
      -- a corrected balance leg still reads as outstanding store credit.
      LEFT JOIN LATERAL (
        SELECT SUM(dl.amount) AS net FROM dealer_ledger dl
         WHERE dl.reference_id = rp.id AND dl.type = 'debit'
           AND dl.reference_type = 'refund'
      ) rev ON true
      LEFT JOIN orders o ON o.id = rp.order_id
      LEFT JOIN dealers d ON d.id = rp.dealer_id
     WHERE rp.kind = 'order_payment' AND rp.order_id IS NOT NULL
       AND rp.status IN ('paid','refunded')
       AND rp.amount_refunded
           + GREATEST(0, COALESCE(bal.net, 0) - COALESCE(rev.net, 0))
           - rp.amount > 0.01
     ORDER BY 6 DESC`);
  console.log(`REALIZED DOUBLE REFUNDS (given back MORE than was paid):`);
  if (dbl.length === 0) console.log("  none");
  for (const r of dbl)
    console.log(`  ⚠ ${r.dealerCode} ${r.dealerName} order ${r.orderId} (${r.orderStatus})\n` +
      `     paid ${r.paid.toFixed(2)}  bank ${r.gatewayRefunded.toFixed(2)}  ` +
      `balance ${r.balanceRefunded.toFixed(2)}  → OVERPAID Rs ${r.excess.toFixed(2)}`);
  await pgClient.end();
}
main().catch(async e => { console.error(e); await pgClient.end(); process.exit(1); });
