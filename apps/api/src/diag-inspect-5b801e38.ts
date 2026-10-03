// Read-only: why is 5b801e38 cancelled, and what else exists for this dealer
// on its delivery date? (Feeds the decision in [[subsidy-rehome-daily-task]]:
// a cancelled subsidy-only order is re-homed onto its superseder, never
// resurrected.)
import { pgClient } from "./lib/db.js";

const ID = "5b801e38-be64-4590-84ac-becf78b8848d";

async function main() {
  const [src] = (await pgClient`
    SELECT o.id::text AS id, o.dealer_id::text AS "dealerId",
           o.status::text AS status, o.payment_mode::text AS "paymentMode",
           o.delivery_date::text AS "deliveryDate",
           o.grand_total::numeric AS "grandTotal", o.item_count AS "itemCount",
           o.stock_deducted AS "stockDeducted",
           o.created_at AS "createdAt", o.cancelled_at AS "cancelledAt",
           o.cancellation_reason AS "cancelReason",
           o.route_id::text AS "routeId", r.name AS "routeName"
      FROM orders o LEFT JOIN routes r ON r.id = o.route_id
     WHERE o.id = ${ID}::uuid
  `) as any[];
  console.log("── SOURCE ──");
  console.log(JSON.stringify(src, null, 2));

  const lines = (await pgClient`
    SELECT p.code, oi.product_name AS name, oi.quantity AS qty,
           oi.unit_price::numeric AS price, oi.gst_percent::numeric AS gst,
           oi.line_total::numeric AS total,
           COALESCE(p.stock_source_product_id, p.id)::text AS "stockProductId"
      FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ${ID}::uuid ORDER BY p.code
  `) as any[];
  console.log("\n── SOURCE LINES ──");
  for (const l of lines) {
    console.log(`  ${l.code}  ${l.qty} x ${l.name}  price=${l.price} gst=${l.gst}% total=${l.total}  stockSKU=${l.stockProductId.slice(0, 8)}`);
  }

  console.log("\n── ALL ORDERS for this dealer on this delivery date ──");
  const sibs = (await pgClient`
    SELECT o.id::text AS id, o.status::text AS status,
           o.payment_mode::text AS "paymentMode",
           o.grand_total::numeric AS "grandTotal", o.item_count AS "itemCount",
           o.stock_deducted AS "stockDeducted",
           o.created_at AS "createdAt", o.confirmed_at AS "confirmedAt",
           o.cancellation_reason AS "cancelReason",
           r.name AS "routeName"
      FROM orders o LEFT JOIN routes r ON r.id = o.route_id
     WHERE o.dealer_id = ${src.dealerId}::uuid
       AND o.delivery_date = ${src.deliveryDate}::date
     ORDER BY o.created_at
  `) as any[];
  for (const s of sibs) {
    const mark = s.id === ID ? " <-- source" : "";
    console.log(`  ${s.id.slice(0, 8)}  ${s.status.padEnd(17)} ${String(s.paymentMode ?? "-").padEnd(8)} Rs ${s.grandTotal}  items=${s.itemCount} stockDeducted=${s.stockDeducted} route=${s.routeName ?? "-"}${mark}`);
    console.log(`            created ${s.createdAt}  confirmed ${s.confirmedAt ?? "-"}`);
    if (s.cancelReason) console.log(`            reason: ${s.cancelReason}`);
    const sl = (await pgClient`
      SELECT p.code, oi.quantity AS qty, oi.line_total::numeric AS total
        FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ${s.id}::uuid ORDER BY p.code
    `) as any[];
    console.log("            lines: " + (sl.map((x) => `${x.code} x${x.qty} (Rs ${x.total})`).join(", ") || "(none)"));
  }

  console.log("\n── money already posted against these orders ──");
  for (const s of sibs) {
    const led = (await pgClient`
      SELECT type::text AS type, amount::numeric AS amount,
             reference_type::text AS "refType", voucher_type AS "voucherType",
             created_at AS "createdAt"
        FROM dealer_ledger WHERE reference_id = ${s.id}::uuid
    `) as any[];
    const rzp = (await pgClient`
      SELECT status::text AS status, amount::numeric AS amount
        FROM razorpay_payments WHERE order_id = ${s.id}::uuid
    `) as any[];
    const inv = (await pgClient`
      SELECT invoice_number AS "invoiceNumber", grand_total::numeric AS total
        FROM invoices WHERE order_id = ${s.id}::uuid
    `) as any[];
    if (led.length || rzp.length || inv.length) {
      console.log(`  ${s.id.slice(0, 8)}: ledger=${JSON.stringify(led)} rzp=${JSON.stringify(rzp)} invoice=${JSON.stringify(inv)}`);
    } else {
      console.log(`  ${s.id.slice(0, 8)}: nothing posted`);
    }
  }

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
