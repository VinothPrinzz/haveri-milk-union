// READ ONLY. Gate-pass invoices vs what was actually collected. AR Aging reads
// `invoices` on ALL rails, but invoice-settlement.ts only resolves the ORDERS
// rail, so a direct-sale invoice can sit at paid_amount 0 forever.
import { pgClient } from "./lib/db.js";

const rows = (await pgClient`
  SELECT i.invoice_number  AS "invNo",
         ds.gp_no          AS "gpNo",
         ds.sale_date::text AS date,
         ds.payment_mode::text AS mode,
         ds.status::text   AS "saleStatus",
         d.code            AS "dealerCode",
         i.total_amount::float8  AS total,
         COALESCE(i.paid_amount, 0)::float8 AS paid,
         i.payment_status  AS "payStatus",
         i.due_date::text  AS "dueDate",
         COALESCE((
           SELECT SUM(rp.amount - rp.amount_refunded)::float8
             FROM razorpay_payments rp
            WHERE rp.direct_sale_id = ds.id
              AND rp.kind = 'gate_pass'
              AND rp.status IN ('paid','refunded')
         ), 0) AS "qrCollected"
    FROM invoices i
    JOIN direct_sales ds ON ds.id = i.order_id
    LEFT JOIN dealers d  ON d.id = ds.customer_id
   ORDER BY ds.sale_date DESC, i.invoice_number
`) as any[];
console.log("── invoices whose order_id points at a direct_sale ──");
console.table(rows);

const mismatched = rows.filter(
  (r) => Number(r.qrCollected) > 0.01 && Number(r.paid) < Number(r.qrCollected) - 0.01,
);
console.log(
  `\nQR money collected but invoice not marked paid: ${mismatched.length} invoice(s), ` +
    `₹${mismatched.reduce((s, r) => s + Number(r.qrCollected), 0).toFixed(2)} overstated in AR Aging`,
);

// What AR Aging currently thinks is owed on the direct-sale rail.
const [ar] = (await pgClient`
  SELECT count(*)::int AS n,
         COALESCE(SUM(i.total_amount - COALESCE(i.paid_amount, 0)), 0)::float8 AS outstanding
    FROM invoices i
    JOIN direct_sales ds ON ds.id = i.order_id
   WHERE i.payment_status <> 'paid'
     AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
`) as any[];
console.log(`\nAR Aging, direct-sale rail: ${ar.n} open invoice(s), ₹${Number(ar.outstanding).toFixed(2)}`);

// Cancelled sales that still carry a live invoice.
const cancelled = rows.filter((r) => r.saleStatus === "cancelled");
console.log(`\nCancelled sales still holding an invoice: ${cancelled.length}`);
console.table(cancelled);

await pgClient.end();
