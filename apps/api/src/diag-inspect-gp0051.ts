// READ ONLY. Everything GP-0051 touches, before moving it from cash to credit.
import { pgClient } from "./lib/db.js";

const GP = "GP-0051";

const [sale] = (await pgClient`
  SELECT ds.id::text AS id, ds.gp_no AS "gpNo",
         ds.sale_date::text AS "saleDate",
         ds.status::text AS status,
         ds.customer_type::text AS "customerType",
         ds.customer_id::text AS "customerId",
         ds.payment_mode::text AS mode,
         ds.payment_ref AS "paymentRef",
         ds.subtotal::float8 AS subtotal,
         ds.total_gst::float8 AS gst,
         ds.grand_total::float8 AS total,
         ds.route_id::text AS "routeId",
         ds.notes,
         ds.created_at::text AS "createdAt",
         d.code AS "dealerCode", d.name AS "dealerName",
         d.customer_type::text AS "dealerCustType",
         d.opening_balance::float8 AS "openingBalance"
    FROM direct_sales ds
    LEFT JOIN dealers d ON d.id = ds.customer_id
   WHERE ds.gp_no = ${GP}
   LIMIT 1
`) as any[];

if (!sale) {
  console.log(`No direct_sales row with gp_no = ${GP}`);
  await pgClient.end();
  process.exit(1);
}
console.log("== The sale ==");
console.log(sale);

const items = (await pgClient`
  SELECT product_name, quantity, unit_price::float8 AS "unitPrice",
         gst_percent::float8 AS "gstPct", line_total::float8 AS "lineTotal"
    FROM direct_sale_items WHERE direct_sale_id = ${sale.id}::uuid
   ORDER BY product_name
`) as any[];
console.log("\n== Lines ==");
console.table(items);

const ledger = (await pgClient`
  SELECT id::text AS id, type::text AS type, amount::float8 AS amount,
         reference_type::text AS "refType", voucher_type AS "voucherType",
         voucher_date::text AS "voucherDate", description,
         balance_after::float8 AS "balanceAfter", created_at::text AS "createdAt"
    FROM dealer_ledger
   WHERE reference_id = ${sale.id}::uuid
   ORDER BY created_at
`) as any[];
console.log("\n== dealer_ledger rows against this sale ==");
console.table(ledger);

const pays = (await pgClient`
  SELECT p.id::text AS id, p.received_date::text AS "receivedDate",
         p.amount::float8 AS amount, p.mode::text AS mode,
         p.reference, p.invoice_id::text AS "invoiceId", p.notes,
         p.created_at::text AS "createdAt"
    FROM payments p
   WHERE p.notes = ${"Counter cash for gate pass " + GP}
      OR p.notes = ${"Counter cash for gate pass " + sale.id}
      OR p.reference = ${GP}
      OR p.invoice_id IN (SELECT i.id FROM invoices i WHERE i.order_id = ${sale.id}::uuid)
   ORDER BY p.created_at
`) as any[];
console.log("\n== payments receipts tied to this pass ==");
console.table(pays);

const rzp = (await pgClient`
  SELECT id::text AS id, kind::text AS kind, status::text AS status,
         amount::float8 AS amount, amount_refunded::float8 AS "amountRefunded",
         razorpay_qr_code_id AS "qrId", razorpay_payment_id AS "rzpPaymentId",
         created_at::text AS "createdAt"
    FROM razorpay_payments
   WHERE direct_sale_id = ${sale.id}::uuid
   ORDER BY created_at
`) as any[];
console.log("\n== razorpay_payments (counter QR) ==");
console.table(rzp);

const inv = (await pgClient`
  SELECT i.id::text AS id, i.invoice_number AS "invoiceNumber",
         i.invoice_date::text AS "invoiceDate", i.due_date::text AS "dueDate",
         i.total_amount::float8 AS total, i.paid_amount::float8 AS paid,
         i.payment_status::text AS "paymentStatus",
         i.dealer_id::text AS "dealerId"
    FROM invoices i WHERE i.order_id = ${sale.id}::uuid
`) as any[];
console.log("\n== invoice(s) ==");
console.table(inv);

const gpItems = (await pgClient`
  SELECT p.name AS product_name, gpi.quantity, gpi.returned_quantity
    FROM gate_pass_items gpi
    JOIN products p ON p.id = gpi.product_id
   WHERE gpi.direct_sale_id = ${sale.id}::uuid
   ORDER BY p.name
`) as any[];
console.log("\n== gate_pass_items ==");
console.table(gpItems);

const [bal] = (await pgClient`
  SELECT
    COALESCE(d.opening_balance, 0)
    + COALESCE((SELECT SUM(CASE WHEN dl.type='credit'
          AND COALESCE(dl.voucher_type,'') <> 'Opening'
          THEN dl.amount ELSE 0 END)
        FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
    - COALESCE((SELECT SUM(CASE WHEN dl.type='debit'
          AND COALESCE(dl.voucher_type,'') <> 'Opening'
          THEN dl.amount ELSE 0 END)
        FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
    AS bal
  FROM dealers d WHERE d.id = ${sale.customerId}::uuid
`) as any[];
console.log(`\n== Dealer ${sale.dealerCode} ${sale.dealerName} balance: Rs.${Number(bal.bal).toFixed(2)} (customer_type ${sale.dealerCustType})`);

const tail = (await pgClient`
  SELECT id::text AS id, type::text AS type, amount::float8 AS amount,
         reference_type::text AS "refType", voucher_date::text AS "voucherDate",
         description, balance_after::float8 AS "balanceAfter",
         created_at::text AS "createdAt"
    FROM dealer_ledger
   WHERE dealer_id = ${sale.customerId}::uuid
   ORDER BY created_at DESC
   LIMIT 8
`) as any[];
console.log("\n== Dealer's last 8 ledger rows (newest first) ==");
console.table(tail);

// How every other recent gate pass is backed, so the cash/credit convention
// is visible rather than assumed.
const peers = (await pgClient`
  SELECT ds.gp_no AS "gpNo", ds.sale_date::text AS date, ds.status::text AS status,
         ds.payment_mode::text AS mode, ds.grand_total::float8 AS total,
         d.code AS "dealerCode",
         COALESCE((SELECT SUM(CASE WHEN dl.type='debit' THEN dl.amount ELSE -dl.amount END)
                     FROM dealer_ledger dl WHERE dl.reference_id = ds.id
                       AND dl.reference_type IN ('order','refund')), 0)::float8 AS "ledgerDr",
         COALESCE((SELECT SUM(p.amount) FROM payments p
                    WHERE p.mode = 'cash'
                      AND p.notes = 'Counter cash for gate pass ' || COALESCE(ds.gp_no, ds.id::text)
                  ), 0)::float8 AS "cashRcpt",
         COALESCE((SELECT SUM(rp.amount - rp.amount_refunded) FROM razorpay_payments rp
                    WHERE rp.direct_sale_id = ds.id AND rp.kind='gate_pass'
                      AND rp.status IN ('paid','refunded')), 0)::float8 AS "qrIn"
    FROM direct_sales ds
    LEFT JOIN dealers d ON d.id = ds.customer_id
   WHERE ds.customer_type = 'agent'
   ORDER BY ds.sale_date DESC, ds.created_at DESC
   LIMIT 20
`) as any[];
console.log("\n== Recent agent gate passes: mode vs what backs it ==");
console.table(peers);

await pgClient.end();
