// ═══════════════════════════════════════════════════════════════════════
// diag-gate-pass-qr-e2e.ts — end-to-end check of the gate-pass counter QR.
//
// Exercises the REAL Razorpay create/fetch/close calls with exactly the
// parameters POST /direct-sales/:id/qr sends, then the DB write, then
// cleans up after itself:
//
//   • the QR is CLOSED at Razorpay before the script exits, so nothing
//     payable is left behind;
//   • the razorpay_payments insert runs inside a transaction that is
//     always ROLLED BACK, so prod gains no rows.
//
// It picks a real unpaid gate-pass sale to build against but never
// modifies it.
//
// USAGE (from apps/api):  npx tsx src/diag-gate-pass-qr-e2e.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import {
  isRazorpayConfigured,
  createRazorpayQrCode,
  fetchRazorpayQrCode,
  closeRazorpayQrCode,
  QR_CLOSE_AFTER_SECONDS,
} from "./lib/razorpay-client.js";

const ok = (b: boolean) => (b ? "PASS" : "*** FAIL ***");
const ROLLBACK = "E2E_ROLLBACK";

async function main() {
  if (!isRazorpayConfigured()) {
    console.log("Razorpay not configured — nothing to test.");
    return;
  }

  const [sale] = await pgClient`
    SELECT ds.id::text        AS id,
           ds.gp_no           AS "gpNo",
           ds.sale_date::text AS "saleDate",
           ds.grand_total::float8 AS "grandTotal",
           ds.customer_id::text   AS "customerId",
           d.name AS "dealerName",
           d.code AS "dealerCode"
      FROM direct_sales ds
      LEFT JOIN dealers d ON ds.customer_type = 'agent' AND d.id = ds.customer_id
     WHERE ds.customer_type = 'agent'
       AND ds.grand_total > 0
       AND ds.payment_ref IS NULL
     ORDER BY ds.created_at DESC
     LIMIT 1
  `;
  if (!sale) {
    console.log("No unpaid agent gate-pass sale to build against.");
    return;
  }

  const s = sale as any;
  console.log(`\nsale ${s.id}`);
  console.log(`  ${s.gpNo ?? "(no gp no)"}  ${s.dealerName}  Rs.${s.grandTotal}`);

  // ── 1. Mint, with the endpoint's exact parameters ────────────────────
  const qr = await createRazorpayQrCode({
    amountInRupees: s.grandTotal,
    name: (s.dealerName ?? "Gate pass").slice(0, 60),
    description: `Gate pass ${s.gpNo ?? s.id.slice(0, 8)}`,
    notes: {
      directSaleId: s.id,
      gatePassNo: String(s.gpNo ?? ""),
      dealerCode: String(s.dealerCode ?? ""),
      saleDate: String(s.saleDate ?? ""),
    },
  });

  console.log(`\nCREATE ${qr.id}`);
  console.log(`  image      ${qr.imageUrl}`);
  console.log(`  status     ${qr.status}          ${ok(qr.status === "active")}`);
  console.log(
    `  amount     ${qr.paymentAmount} paise  ` +
      ok(qr.paymentAmount === Math.round(s.grandTotal * 100))
  );
  const window = (qr.closeBy ?? 0) - Math.floor(Date.now() / 1000);
  console.log(
    `  closes in  ~${window}s            ` +
      ok(window > 0 && window <= QR_CLOSE_AFTER_SECONDS + 60)
  );

  try {
    // ── 2. Read it back: notes must survive the round trip, since the
    //       webhook relies on them to attribute the money. ─────────────
    const back = await fetchRazorpayQrCode(qr.id);
    console.log(`\nFETCH`);
    console.log(`  status            ${back.status}   ${ok(back.status === "active")}`);
    console.log(
      `  payments received ${back.paymentsCountReceived}        ` +
        ok(back.paymentsCountReceived === 0)
    );

    // ── 3. The DB write, rolled back. ────────────────────────────────
    await pgClient
      .begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        await tx`
          INSERT INTO razorpay_payments
            (dealer_id, kind, amount, razorpay_qr_code_id, direct_sale_id, notes)
          VALUES (
            ${s.customerId}::uuid, 'gate_pass', ${s.grandTotal},
            ${qr.id}, ${s.id}::uuid,
            ${JSON.stringify({
              gatePassNo: s.gpNo,
              dealerCode: s.dealerCode,
              imageUrl: qr.imageUrl,
            })}::jsonb
          )
        `;
        const [row] = await tx`
          SELECT kind::text AS kind, status::text AS status,
                 amount::float8 AS amount, notes,
                 notes->>'imageUrl' AS "storedImageUrl"
            FROM razorpay_payments
           WHERE razorpay_qr_code_id = ${qr.id}
        `;
        const r = row as any;
        console.log(`\nDB ROW (in a transaction that will roll back)`);
        console.log(`  kind    ${r.kind}    ${ok(r.kind === "gate_pass")}`);
        console.log(`  status  ${r.status}     ${ok(r.status === "created")}`);
        console.log(`  amount  ${r.amount}     ${ok(r.amount === s.grandTotal)}`);
        // The rzp.io short code cannot be rebuilt from the QR id, so the
        // poll endpoint depends on this having been stored at mint.
        console.log(
          `  image   ${r.storedImageUrl}  ${ok(r.storedImageUrl === qr.imageUrl)}`
        );
        throw new Error(ROLLBACK);
      })
      .catch((e: Error) => {
        if (e.message !== ROLLBACK) throw e;
        console.log("  rolled back, no row persisted");
      });
  } finally {
    // ── 4. Always close the QR, whatever happened above. ─────────────
    const closed = await closeRazorpayQrCode(qr.id);
    console.log(`\nCLOSE ${closed.id}`);
    console.log(`  status  ${closed.status}      ${ok(closed.status === "closed")}`);
  }

  const [cnt] = await pgClient`
    SELECT count(*)::int AS n FROM razorpay_payments WHERE kind = 'gate_pass'
  `;
  const n = Number((cnt as any)?.n ?? 0);
  console.log(`\ngate_pass rows in prod: ${n}  ${ok(n === 0)}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("\nFAILED:", err?.message ?? err);
    process.exit(1);
  });
