// ═══════════════════════════════════════════════════════════════════════
// diag-backfill-gate-pass-receipts.ts
//
// Books the `payments` receipt that applyPaidGatePassPayment never wrote.
//
// Counter UPI collections on the gate-pass rail landed in razorpay_payments
// and stopped there: the apply stamped direct_sales.payment_ref and posted no
// receipt, so Payments Overview (which reads `payments` and nothing else)
// showed none of them. Every other Razorpay rail books one at capture.
//
// invoice_id is left NULL, matching the live path and the order rail:
// invoice-settlement.ts would otherwise count the row twice (rail 1 on
// reference, rail 3 on invoice_id). The gate pass number is in `notes`.
//
// One row per CAPTURED gateway payment, keyed on razorpay_payment_id, which
// is exactly the idempotency key the fixed apply path now uses — so this
// backfill and the live path can never double-book the same capture.
//
// DRY RUN by default. Pass --commit to write.
//   npx tsx src/diag-backfill-gate-pass-receipts.ts
//   npx tsx src/diag-backfill-gate-pass-receipts.ts --commit
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";

const COMMIT = process.argv.includes("--commit");

const missing = await pgClient`
  SELECT rp.id::text                       AS "rzpRowId",
         rp.razorpay_payment_id            AS "paymentId",
         rp.dealer_id::text                AS "dealerId",
         (rp.amount - rp.amount_refunded)::float8 AS "net",
         rp.amount::float8                 AS "gross",
         rp.amount_refunded::float8        AS "refunded",
         to_char(COALESCE(rp.paid_at, rp.created_at) AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD') AS "receivedDate",
         ds.id::text                       AS "saleId",
         ds.gp_no                          AS "gpNo",
         ds.status::text                   AS "saleStatus",
         d.name                            AS "dealer"
    FROM razorpay_payments rp
    JOIN direct_sales ds ON ds.id = rp.direct_sale_id
    LEFT JOIN dealers d  ON d.id = rp.dealer_id
   WHERE rp.kind = 'gate_pass'
     AND rp.status IN ('paid','refunded')
     AND rp.razorpay_payment_id IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM payments p
        WHERE p.reference = rp.razorpay_payment_id AND p.mode = 'upi'
     )
   ORDER BY 7
`;

console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — gate-pass captures with no payments receipt: ${missing.length}\n`);
let total = 0;
for (const m of missing as any[]) {
  total += Number(m.gross);
  const note = Number(m.refunded) > 0.001 ? `  (refunded Rs.${Number(m.refunded).toFixed(2)} since)` : "";
  console.log(`  ${m.receivedDate}  ${(m.gpNo ?? m.saleId.slice(0,8)).padEnd(8)} ${String(m.dealer ?? "?").padEnd(32)} Rs.${Number(m.gross).toFixed(2).padStart(9)}  ${m.paymentId}  [${m.saleStatus}]${note}`);
}
console.log(`\nTotal to book: Rs.${total.toFixed(2)}`);

if (!COMMIT) {
  console.log("\nDry run. Re-run with --commit to write these receipts.");
  await pgClient.end();
  process.exit(0);
}

// The receipt records what was RECEIVED, gross. A later refund is its own
// event on razorpay_refunds and must not silently shrink the receipt — that
// is how the order rail already behaves.
let booked = 0;
await pgClient.begin(async (_tx) => {
  const tx = _tx as unknown as typeof pgClient;
  for (const m of missing as any[]) {
    const res = await tx`
      INSERT INTO payments
        (dealer_id, received_date, amount, mode, reference, notes)
      SELECT ${m.dealerId}::uuid,
             ${m.receivedDate}::date,
             ${Number(m.gross).toFixed(2)}::numeric,
             'upi',
             ${m.paymentId},
             ${`Counter UPI for gate pass ${m.gpNo ?? m.saleId}`}
       WHERE NOT EXISTS (
         SELECT 1 FROM payments p
          WHERE p.reference = ${m.paymentId} AND p.mode = 'upi'
       )
      RETURNING id
    `;
    if (res.count > 0) booked++;
  }
});
console.log(`\nBooked ${booked} receipts.`);

const [check] = await pgClient`
  SELECT count(*)::int AS n, COALESCE(SUM(p.amount),0)::float8 AS total
    FROM payments p
   WHERE p.mode = 'upi'
     AND p.reference IN (SELECT razorpay_payment_id FROM razorpay_payments
                          WHERE kind='gate_pass' AND razorpay_payment_id IS NOT NULL)
`;
console.log(`Gate-pass UPI receipts now in payments: ${(check as any).n} totalling Rs.${Number((check as any).total).toFixed(2)}`);
await pgClient.end();
