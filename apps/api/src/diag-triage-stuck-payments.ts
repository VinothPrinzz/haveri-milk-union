// ═══════════════════════════════════════════════════════════════════════
// diag-triage-stuck-payments.ts — READ-ONLY triage of the stuck
// razorpay_payments backlog (status created/attempted/failed).
//
// For each stuck row it asks Razorpay which payment attempts exist against
// that order and classifies the row by what the MONEY actually did:
//
//   CAPTURED   — money was taken but our DB never recorded it. Real exposure.
//                Reconcile/applyPaidPayment would book it.
//   AUTHORIZED — money is held but not captured (manual-capture accounts).
//                Razorpay auto-voids these after a few days if not captured.
//   MISMATCH   — a captured attempt exists but for a different amount.
//   NONE       — only created/failed attempts: genuinely abandoned, no money.
//   FETCH_ERROR— couldn't reach Razorpay for this row.
//
// It also flags rows whose captured payment id ALREADY has an internal
// receipt (money is in fact booked; only the gateway row's status is stale)
// and prints each linked order's current status for context.
//
// STRICTLY READ-ONLY: it never writes to our DB and never calls capture.
// Use it to size the problem; then apply with the reconcile sweep.
//
// USAGE (from apps/api):
//   npx tsx src/diag-triage-stuck-payments.ts
//   npx tsx src/diag-triage-stuck-payments.ts --limit 500
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { fetchRazorpayOrderPayments } from "./lib/razorpay-client.js";

const LIMIT = (() => {
  const i = process.argv.indexOf("--limit");
  const n = i >= 0 ? parseInt(process.argv[i + 1] ?? "", 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 1000;
})();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const inr = (n: number) => "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

type Verdict = "CAPTURED" | "AUTHORIZED" | "MISMATCH" | "NONE" | "FETCH_ERROR";

interface Result {
  rzpOrderId: string;
  dbStatus: string;
  kind: string;
  expected: number;          // rupees we charged
  orderId: string | null;
  orderStatus: string | null;
  createdIST: string;
  verdict: Verdict;
  paymentId?: string;
  gotPaise?: number;
  alreadyBooked?: boolean;   // captured id already has an internal receipt
  detail?: string;
}

async function main() {
  // Which Razorpay account are we hitting? (prefix is not secret; length is.)
  const keyId = process.env.RAZORPAY_KEY_ID ?? "";
  const mode = keyId.startsWith("rzp_live_") ? "LIVE" : keyId.startsWith("rzp_test_") ? "TEST" : "UNKNOWN";
  console.log(`Razorpay key mode: ${mode} (${keyId.slice(0, 9)}…)`);
  if (mode !== "LIVE") {
    console.log("⚠  Not a LIVE key — fetches against production order ids will likely return nothing. Aborting.");
    await pgClient.end();
    return;
  }

  const rows = await pgClient`
    SELECT id::text AS id,
           razorpay_order_id  AS "rzpOrderId",
           order_id::text     AS "orderId",
           kind::text         AS kind,
           status::text       AS status,
           amount::numeric    AS amount,
           to_char(created_at AT TIME ZONE 'Asia/Kolkata','YYYY-MM-DD HH24:MI') AS "createdIST"
      FROM razorpay_payments
     WHERE status IN ('created','attempted','failed')
     ORDER BY created_at DESC
     LIMIT ${LIMIT}
  ` as any[];

  console.log(`Scanning ${rows.length} stuck razorpay_payments rows against Razorpay…\n`);

  const results: Result[] = [];

  for (const row of rows) {
    const expectedPaise = Math.round(parseFloat(row.amount) * 100);
    const base: Result = {
      rzpOrderId: row.rzpOrderId,
      dbStatus: row.status,
      kind: row.kind,
      expected: parseFloat(row.amount),
      orderId: row.orderId,
      orderStatus: null,
      createdIST: row.createdIST,
      verdict: "NONE",
    };

    // Linked order status for context (order_payment only).
    if (row.orderId) {
      const [o] = await pgClient`SELECT status::text AS status FROM orders WHERE id = ${row.orderId}::uuid`;
      base.orderStatus = o?.status ?? "(missing)";
    }

    let payments;
    try {
      payments = await fetchRazorpayOrderPayments(row.rzpOrderId);
    } catch (err) {
      base.verdict = "FETCH_ERROR";
      base.detail = err instanceof Error ? err.message : String(err);
      results.push(base);
      continue;
    }

    const captured = payments.find((p) => p.status === "captured");
    const authorized = payments.find((p) => p.status === "authorized");

    if (captured) {
      base.paymentId = captured.id;
      base.gotPaise = captured.amount;
      if (captured.amount !== expectedPaise) {
        base.verdict = "MISMATCH";
        base.detail = `captured ${captured.amount}p vs expected ${expectedPaise}p`;
      } else {
        base.verdict = "CAPTURED";
        // Is this captured id already booked internally? (money not actually lost)
        const [rcpt] = await pgClient`
          SELECT 1 FROM payments WHERE reference = ${captured.id} AND mode = 'upi' LIMIT 1
        `;
        base.alreadyBooked = !!rcpt;
      }
    } else if (authorized) {
      base.verdict = "AUTHORIZED";
      base.paymentId = authorized.id;
      base.gotPaise = authorized.amount;
      base.detail = authorized.amount === expectedPaise ? "held; not captured" : `held ${authorized.amount}p vs ${expectedPaise}p`;
    } else {
      base.verdict = "NONE";
      base.detail = payments.length ? `attempts: ${payments.map((p) => p.status).join(",")}` : "no attempts";
    }

    results.push(base);
    await sleep(120); // be gentle with the Razorpay API
  }

  // ── Report ──────────────────────────────────────────────────────────
  const order = { CAPTURED: 0, AUTHORIZED: 1, MISMATCH: 2, FETCH_ERROR: 3, NONE: 4 } as const;
  results.sort((a, b) => order[a.verdict] - order[b.verdict] || b.expected - a.expected);

  const money = results.filter((r) => r.verdict === "CAPTURED" || r.verdict === "AUTHORIZED" || r.verdict === "MISMATCH");
  console.log("──────────────────────────────────────────────────────────");
  console.log(`ROWS WITH MONEY AT RAZORPAY (${money.length}):\n`);
  for (const r of money) {
    const booked = r.verdict === "CAPTURED" ? (r.alreadyBooked ? " [already booked internally]" : " [UNRECORDED]") : "";
    console.log(
      `  ${r.verdict.padEnd(10)} ${inr(r.expected).padStart(13)}  ${r.kind.padEnd(13)} ` +
      `order=${r.orderStatus ?? "-"} db=${r.dbStatus}  ${r.rzpOrderId}  ${r.paymentId ?? ""}${booked}` +
      (r.detail ? `  (${r.detail})` : "")
    );
  }

  const errors = results.filter((r) => r.verdict === "FETCH_ERROR");
  if (errors.length) {
    console.log(`\nFETCH ERRORS (${errors.length}) — re-run to retry these:`);
    for (const r of errors) console.log(`  ${r.rzpOrderId}  ${r.detail}`);
  }

  // ── Totals ──────────────────────────────────────────────────────────
  const sum = (v: Verdict, onlyUnrecorded = false) =>
    results.filter((r) => r.verdict === v && (!onlyUnrecorded || !r.alreadyBooked))
           .reduce((s, r) => s + r.expected, 0);
  const count = (v: Verdict) => results.filter((r) => r.verdict === v).length;

  const capturedUnrecorded = results.filter((r) => r.verdict === "CAPTURED" && !r.alreadyBooked);
  const capturedUnrecOrderPay = capturedUnrecorded.filter((r) => r.kind === "order_payment").reduce((s, r) => s + r.expected, 0);
  const capturedUnrecTopup = capturedUnrecorded.filter((r) => r.kind === "credit_topup").reduce((s, r) => s + r.expected, 0);

  console.log("\n──────────────────────────────────────────────────────────");
  console.log("SUMMARY");
  console.log(`  Scanned stuck rows            : ${results.length}`);
  console.log(`  CAPTURED (money taken)        : ${count("CAPTURED")}  = ${inr(sum("CAPTURED"))}`);
  console.log(`    ↳ UNRECORDED in our books   : ${capturedUnrecorded.length}  = ${inr(sum("CAPTURED", true))}`);
  console.log(`        • order payments        : ${inr(capturedUnrecOrderPay)}`);
  console.log(`        • wallet top-ups        : ${inr(capturedUnrecTopup)}`);
  console.log(`  AUTHORIZED (held, auto-voids) : ${count("AUTHORIZED")}  = ${inr(sum("AUTHORIZED"))}`);
  console.log(`  MISMATCH (wrong amount)       : ${count("MISMATCH")}`);
  console.log(`  NONE (abandoned, no money)    : ${count("NONE")}`);
  console.log(`  FETCH_ERROR                   : ${count("FETCH_ERROR")}`);
  console.log("\nNo changes were made. The CAPTURED-UNRECORDED + AUTHORIZED rows are what the reconcile sweep would book/capture.");

  await pgClient.end();
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
