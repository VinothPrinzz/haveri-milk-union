// READ ONLY. What payment modes do gate passes actually carry, and what did
// each mode post? Feeds the decision on making gate-pass payment modes behave
// like the indent rail (credit → ledger debit, cash/QR → receipt).
import { pgClient } from "./lib/db.js";

const byMode = (await pgClient`
  SELECT ds.customer_type::text AS "customerType",
         ds.payment_mode::text  AS mode,
         ds.status::text        AS status,
         count(*)::int          AS n,
         SUM(ds.grand_total)::float8 AS total,
         MIN(ds.sale_date)::text AS "firstDate",
         MAX(ds.sale_date)::text AS "lastDate"
    FROM direct_sales ds
   GROUP BY 1, 2, 3
   ORDER BY 1, 2, 3
`) as any[];
console.log("── direct_sales by (customer_type, payment_mode, status) ──");
console.table(byMode);

// Did any gate pass ever post a dealer_ledger row or a payments receipt?
const posted = (await pgClient`
  SELECT ds.payment_mode::text AS mode,
         count(*)::int AS n,
         SUM(CASE WHEN EXISTS (
               SELECT 1 FROM dealer_ledger dl WHERE dl.reference_id = ds.id
             ) THEN 1 ELSE 0 END)::int AS "withLedgerRow",
         SUM(CASE WHEN EXISTS (
               SELECT 1 FROM payments pm WHERE pm.reference = ds.id::text
             ) THEN 1 ELSE 0 END)::int AS "withPaymentRow",
         SUM(CASE WHEN EXISTS (
               SELECT 1 FROM razorpay_payments rp
                WHERE rp.direct_sale_id = ds.id AND rp.status IN ('paid','refunded')
             ) THEN 1 ELSE 0 END)::int AS "withRzpPaid",
         SUM(CASE WHEN EXISTS (
               SELECT 1 FROM invoices i WHERE i.order_id = ds.id
             ) THEN 1 ELSE 0 END)::int AS "withInvoice"
    FROM direct_sales ds
   WHERE ds.customer_type = 'agent'
   GROUP BY 1
   ORDER BY 1
`) as any[];
console.log("\n── agent gate passes: what each mode actually posted ──");
console.table(posted);

// The credit ones in detail — these are the receivable that may be missing.
const creditPasses = (await pgClient`
  SELECT ds.gp_no AS "gpNo", ds.sale_date::text AS date,
         d.code AS "dealerCode", d.name AS dealer,
         COALESCE(d.customer_type::text,'') AS "dealerType",
         ds.grand_total::float8 AS total,
         ds.status::text AS status,
         ds.route_id IS NULL AS "noRoute"
    FROM direct_sales ds
    LEFT JOIN dealers d ON d.id = ds.customer_id
   WHERE ds.customer_type = 'agent'
     AND ds.payment_mode::text = 'credit'
   ORDER BY ds.sale_date DESC
   LIMIT 50
`) as any[];
console.log(`\n── credit gate passes (${creditPasses.length} shown) ──`);
console.table(creditPasses);

await pgClient.end();
