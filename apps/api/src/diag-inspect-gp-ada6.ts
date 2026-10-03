// READ ONLY. Everything the employee subsidy indent the web UI labels
// "GP-ADA6" touches, before moving it from cash to credit.
//
// The label is the UI's fallback for a sale with no gp_no:
// `GP-${id.slice(-4).toUpperCase()}` (apps/web/src/services/api.ts).
import { pgClient } from "./lib/db.js";

const ORDER_ID = "55069931-371e-4b06-9649-c6474c77ada6";

const [eo] = (await pgClient`
  SELECT eo.id::text AS id,
         eo.employee_id::text AS "employeeId",
         eo.route_id::text AS "routeId",
         eo.delivery_date::text AS "deliveryDate",
         eo.status::text AS status,
         eo.payment_mode::text AS mode,
         eo.subtotal::float8 AS subtotal,
         eo.total_gst::float8 AS gst,
         eo.grand_total::float8 AS total,
         eo.item_count AS "itemCount",
         eo.notes,
         eo.placed_by::text AS "placedBy",
         eo.created_at::text AS "createdAt",
         eo.updated_at::text AS "updatedAt",
         e.name AS "employeeName", e.employee_code AS "employeeCode",
         e.opening_balance::float8 AS "openingBalance"
    FROM employee_orders eo
    LEFT JOIN employees e ON e.id = eo.employee_id
   WHERE eo.id = ${ORDER_ID}::uuid
`) as any[];
console.log("── The employee indent ──");
console.log(eo);

const items = (await pgClient`
  SELECT product_name, quantity, unit_price::float8 AS "unitPrice",
         gst_percent::float8 AS "gstPct", gst_amount::float8 AS "gstAmount",
         line_total::float8 AS "lineTotal",
         subsidy_percent::float8 AS "subsidyPct", mrp_reference::float8 AS mrp
    FROM employee_order_items WHERE employee_order_id = ${ORDER_ID}::uuid
   ORDER BY product_name
`) as any[];
console.log("\n── Lines ──");
console.table(items);

const el = (await pgClient`
  SELECT id::text AS id, type::text AS type, amount::float8 AS amount,
         reference_type::text AS "refType", voucher_type AS "voucherType",
         voucher_date::text AS "voucherDate", description,
         balance_after::float8 AS "balanceAfter", created_at::text AS "createdAt"
    FROM employee_ledger
   WHERE reference_id::text = ${ORDER_ID}
   ORDER BY created_at
`) as any[];
console.log("\n── employee_ledger rows against this indent ──");
console.table(el);

const inv = (await pgClient`
  SELECT i.id::text AS id, i.invoice_number AS "invoiceNumber",
         i.invoice_date::text AS "invoiceDate", i.due_date::text AS "dueDate",
         i.total_amount::float8 AS total, i.paid_amount::float8 AS paid,
         i.payment_status::text AS "paymentStatus", i.dealer_id::text AS "dealerId"
    FROM invoices i WHERE i.order_id = ${ORDER_ID}::uuid
`) as any[];
console.log("\n── invoice(s) ──");
console.table(inv);

// Did the cash mode post anything anywhere? It should not have — the
// employee-subsidy endpoint only posts on credit.
const pays = (await pgClient`
  SELECT p.id::text AS id, p.received_date::text AS "receivedDate",
         p.amount::float8 AS amount, p.mode::text AS mode, p.reference,
         p.invoice_id::text AS "invoiceId", p.notes
    FROM payments p
   WHERE p.notes ILIKE ${"%" + ORDER_ID + "%"}
      OR p.reference ILIKE ${"%" + ORDER_ID + "%"}
      OR p.invoice_id IN (SELECT id FROM invoices WHERE order_id = ${ORDER_ID}::uuid)
`) as any[];
console.log("\n── payments receipts touching this indent ──");
console.table(pays);

const dl = (await pgClient`
  SELECT id::text AS id, type::text AS type, amount::float8 AS amount,
         reference_type::text AS "refType", description
    FROM dealer_ledger WHERE reference_id = ${ORDER_ID}::uuid
`) as any[];
console.log("\n── dealer_ledger rows (should be none, employees are not dealers) ──");
console.table(dl);

// The employee's ledger tail and current balance, by the same formula the
// endpoint uses when it stamps balance_after.
const [bal] = (await pgClient`
  SELECT
    COALESCE(e.opening_balance, 0)
    + COALESCE((SELECT SUM(CASE WHEN el.type = 'credit'
                                 AND COALESCE(el.voucher_type,'') <> 'Opening'
                                THEN el.amount ELSE 0 END)
                  FROM employee_ledger el WHERE el.employee_id = e.id), 0)
    - COALESCE((SELECT SUM(CASE WHEN el.type = 'debit'
                                 AND COALESCE(el.voucher_type,'') <> 'Opening'
                                THEN el.amount ELSE 0 END)
                  FROM employee_ledger el WHERE el.employee_id = e.id), 0)
    AS bal
  FROM employees e WHERE e.id = ${eo.employeeId}::uuid
`) as any[];
console.log(`\n── ${eo.employeeCode ?? ""} ${eo.employeeName} balance: ₹${Number(bal.bal).toFixed(2)}`);

const tail = (await pgClient`
  SELECT id::text AS id, type::text AS type, amount::float8 AS amount,
         reference_type::text AS "refType", voucher_date::text AS "voucherDate",
         description, balance_after::float8 AS "balanceAfter",
         created_at::text AS "createdAt"
    FROM employee_ledger
   WHERE employee_id = ${eo.employeeId}::uuid
   ORDER BY created_at DESC
   LIMIT 10
`) as any[];
console.log("\n── Employee's last 10 ledger rows (newest first) ──");
console.table(tail);

// Every OTHER employee subsidy indent, so the cash-vs-credit convention on
// this rail is visible rather than assumed.
const peers = (await pgClient`
  SELECT eo.id::text AS id, eo.delivery_date::text AS date,
         eo.status::text AS status, eo.payment_mode::text AS mode,
         eo.grand_total::float8 AS total,
         e.name AS "employeeName",
         COALESCE((SELECT SUM(CASE WHEN el.type='debit' THEN el.amount ELSE -el.amount END)
                     FROM employee_ledger el
                    WHERE el.reference_id::text = eo.id::text), 0)::float8 AS "ledgerNet"
    FROM employee_orders eo
    LEFT JOIN employees e ON e.id = eo.employee_id
   ORDER BY eo.delivery_date DESC, eo.created_at DESC
   LIMIT 30
`) as any[];
console.log("\n── Recent employee indents: mode vs what it posted ──");
console.table(peers);

await pgClient.end();
