// READ ONLY. Proves the gate-pass payment mode now lands on the right side
// of every money surface: AR Aging, the cash/credit split the sales reports
// share, and the dealer statement.
import { pgClient } from "./lib/db.js";

// ── 1. AR Aging, with the predicate the endpoint actually uses ──
const [ar] = (await pgClient`
  SELECT count(*)::int AS n,
         COALESCE(SUM(i.total_amount - COALESCE(i.paid_amount, 0)), 0)::float8 AS outstanding
    FROM invoices i
   WHERE i.payment_status <> 'paid'
     AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
     AND NOT EXISTS (SELECT 1 FROM direct_sales ds
                      WHERE ds.id = i.order_id AND ds.status = 'cancelled')
     AND EXISTS (SELECT 1 FROM direct_sales ds2 WHERE ds2.id = i.order_id)
`) as any[];
console.log("── AR Aging, direct-sale rail (cancelled excluded) ──");
console.log(`  ${ar.n} open invoice(s), ₹${Number(ar.outstanding).toFixed(2)}`);
console.log("  (was 3 / ₹25,384.85 — GP-0044's cancelled ₹1,385.77 should be gone)\n");

// ── 2. The cash / credit split every sales report shares ──
const split = (await pgClient`
  SELECT CASE WHEN ds.customer_type::text = 'employee_subsidy'
                OR ds.payment_mode::text = 'credit'
              THEN 'credit' ELSE 'cash' END AS side,
         ds.payment_mode::text AS mode,
         count(*)::int AS n,
         SUM(ds.grand_total)::float8 AS amount
    FROM direct_sales ds
   WHERE ds.status = 'confirmed'
   GROUP BY 1, 2
   ORDER BY 1, 2
`) as any[];
console.log("── Direct sales by report side ──");
console.table(split);

// ── 3. Every confirmed agent pass, and what backs it ──
const passes = (await pgClient`
  SELECT ds.gp_no AS "gpNo", ds.sale_date::text AS date,
         ds.payment_mode::text AS mode,
         ds.grand_total::float8 AS total,
         COALESCE((SELECT SUM(CASE WHEN dl.type='debit' THEN dl.amount ELSE -dl.amount END)
                     FROM dealer_ledger dl
                    WHERE dl.reference_id = ds.id
                      AND dl.reference_type IN ('order','refund')), 0)::float8 AS "ledgerDr",
         COALESCE((SELECT SUM(p.amount) FROM payments p
                    WHERE p.mode = 'cash'
                      AND p.notes = 'Counter cash for gate pass ' || COALESCE(ds.gp_no, ds.id::text)
                  ), 0)::float8 AS "cashRcpt",
         COALESCE((SELECT SUM(rp.amount - rp.amount_refunded) FROM razorpay_payments rp
                    WHERE rp.direct_sale_id = ds.id AND rp.kind='gate_pass'
                      AND rp.status IN ('paid','refunded')), 0)::float8 AS "qrIn"
    FROM direct_sales ds
   WHERE ds.customer_type = 'agent' AND ds.status = 'confirmed' AND ds.grand_total > 0
   ORDER BY ds.sale_date
`) as any[];
console.log("\n── Every confirmed agent gate pass, and what backs it ──");
console.table(
  passes.map((p) => ({
    ...p,
    backed:
      p.mode === "credit"
        ? Math.abs(p.ledgerDr - p.total) < 0.01 ? "billed (receivable)" : "MISMATCH"
        : p.mode === "wallet"
          ? Math.abs(p.ledgerDr - p.total) < 0.01 ? "balance drawn" : "MISMATCH"
          : p.mode === "cash"
            ? Math.abs(p.cashRcpt - p.total) < 0.01 ? "cash receipt" : "MISMATCH"
            : Math.abs(p.qrIn - p.total) < 0.01 ? "QR collected" : "QR unpaid",
  })),
);

const bad = passes.filter((p) => {
  if (p.mode === "credit" || p.mode === "wallet") return Math.abs(p.ledgerDr - p.total) >= 0.01;
  if (p.mode === "cash") return Math.abs(p.cashRcpt - p.total) >= 0.01;
  return false;
});
console.log(bad.length === 0
  ? "\nAll wallet / credit / cash passes are backed by their posting."
  : `\n${bad.length} pass(es) MISMATCHED — see above.`);

// ── 4. Dealer statement coherence: billed vs received per agent ──
// Reproduces the index page's model so a gate pass cannot leave a dealer
// looking as though they paid for goods nobody billed them for.
const stmt = (await pgClient`
  SELECT d.code, d.name,
         COALESCE(ord.amt,0)::float8 AS "orderBilled",
         COALESCE(gp.amt,0)::float8  AS "gatePassBilled",
         COALESCE(pay.amt,0)::float8 AS "receipts",
         COALESCE(qr.amt,0)::float8  AS "qrCollected"
    FROM dealers d
    LEFT JOIN LATERAL (SELECT SUM(o.grand_total) AS amt FROM orders o
                        WHERE o.dealer_id = d.id
                          AND o.status IN ('confirmed','dispatched','delivered')) ord ON true
    LEFT JOIN LATERAL (SELECT SUM(ds.grand_total) AS amt FROM direct_sales ds
                        WHERE ds.customer_type='agent' AND ds.customer_id = d.id
                          AND ds.status='confirmed') gp ON true
    LEFT JOIN LATERAL (SELECT SUM(p.amount) AS amt FROM payments p
                        WHERE p.dealer_id = d.id) pay ON true
    LEFT JOIN LATERAL (SELECT SUM(rp.amount) AS amt FROM razorpay_payments rp
                        WHERE rp.dealer_id = d.id AND rp.kind='gate_pass'
                          AND rp.status IN ('paid','refunded') AND rp.paid_at IS NOT NULL) qr ON true
   WHERE EXISTS (SELECT 1 FROM direct_sales ds2
                  WHERE ds2.customer_type='agent' AND ds2.customer_id = d.id
                    AND ds2.status='confirmed')
   ORDER BY d.code
`) as any[];
console.log("\n── Agents with gate passes: statement inputs ──");
console.table(stmt);

await pgClient.end();
