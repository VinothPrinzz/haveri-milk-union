// Read-only: post-apply verification for the 5b801e38 revive + wallet debit.
import { pgClient } from "./lib/db.js";
import { fgsAvailable } from "./lib/stock-check.js";

const ID = "5b801e38-be64-4590-84ac-becf78b8848d";
const DEALER = "531fab89-034a-457b-9327-4056522cc7a6";
const DATE = "2026-08-24";
const BASE = "430b7727-9927-4763-9367-8a708b996f36"; // PD0191

async function main() {
  const [o] = (await pgClient`
    SELECT status::text AS status, payment_mode::text AS "paymentMode",
           payment_reference AS "paymentRef",
           confirmed_at AS "confirmedAt", cancelled_at AS "cancelledAt",
           cancellation_reason AS "cancelReason", stock_deducted AS "stockDeducted",
           grand_total::numeric AS total, r.name AS "routeName"
      FROM orders o LEFT JOIN routes r ON r.id = o.route_id
     WHERE o.id = ${ID}::uuid
  `) as any[];
  console.log("order:", JSON.stringify(o, null, 2));

  console.log("\nledger rows on this order:");
  const led = (await pgClient`
    SELECT type::text AS type, amount::numeric AS amount, reference_type::text AS "refType",
           voucher_type AS "voucherType", voucher_date::text AS "voucherDate",
           balance_after::numeric AS "balanceAfter", created_at AS "createdAt"
      FROM dealer_ledger WHERE reference_id = ${ID}::uuid
  `) as any[];
  console.log(JSON.stringify(led, null, 2));

  console.log("\ninvoice:");
  const inv = (await pgClient`
    SELECT invoice_number AS "invoiceNumber", total_amount::numeric AS total,
           taxable_amount::numeric AS taxable, total_tax::numeric AS tax,
           due_date::text AS "dueDate", paid_amount::numeric AS "paidAmount",
           pdf_url AS "pdfUrl", invoice_date AS "invoiceDate"
      FROM invoices WHERE order_id = ${ID}::uuid
  `) as any[];
  console.log(inv.length ? JSON.stringify(inv, null, 2) : "  none yet");

  console.log("\npdf-invoice job:");
  const job = (await pgClient`
    SELECT id::text AS id, status::text AS status, attempts, last_error AS "lastError"
      FROM background_jobs
     WHERE queue = 'pdf-invoice' AND data->>'orderId' = ${ID}
     ORDER BY created_at DESC LIMIT 1
  `) as any[];
  console.log(JSON.stringify(job, null, 2));

  console.log("\nlive orders for this dealer on " + DATE + ":");
  const live = (await pgClient`
    SELECT id::text AS id, status::text AS status, payment_mode::text AS "paymentMode",
           grand_total::numeric AS total
      FROM orders WHERE dealer_id = ${DEALER}::uuid
       AND delivery_date = ${DATE}::date AND status <> 'cancelled'
  `) as any[];
  for (const l of live) console.log(`  ${l.id.slice(0, 8)}  ${l.status}  ${l.paymentMode}  Rs ${l.total}`);

  const [wal] = (await pgClient`
    SELECT (COALESCE(d.opening_balance, 0)
      + COALESCE((SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount
                                  WHEN dl.type='debit' THEN -dl.amount END)
                    FROM dealer_ledger dl WHERE dl.dealer_id = d.id
                     AND COALESCE(dl.voucher_type,'') <> 'Opening'), 0))::numeric AS bal
      FROM dealers d WHERE d.id = ${DEALER}::uuid
  `) as any[];
  console.log(`\nwallet balance: Rs ${wal.bal}`);

  console.log(`PD0191 fgs_available ${DATE}: ${await fgsAvailable(pgClient, BASE, DATE)}`);

  console.log("\ndispatch-sheet visibility (confirmed orders, this route/date):");
  const [ds] = (await pgClient`
    SELECT count(*)::int AS orders, COALESCE(SUM(oi.quantity), 0)::int AS "subsidyUnits"
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      JOIN products p ON p.id = oi.product_id
     WHERE o.delivery_date = ${DATE}::date
       AND o.status IN ('confirmed', 'dispatched', 'delivered')
       AND p.code = 'PD0191S'
  `) as any[];
  console.log(`  PD0191S on live orders today: ${ds.subsidyUnits} units across ${ds.orders} order-lines`);

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
