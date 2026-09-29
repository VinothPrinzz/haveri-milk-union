// Read-only follow-up on 5b801e38: it was auto-discarded ("Online payment not
// completed before window close"), NOT superseded, and it is the dealer's only
// order for 2026-08-24. Before reviving it onto the wallet rail, check the
// three things that decide whether that is safe: no captured online payment,
// enough wallet balance, enough FGS stock on the base SKU.
import { pgClient } from "./lib/db.js";
import { fgsAvailable } from "./lib/stock-check.js";
import { checkDealerCredit } from "./lib/credit-check.js";

const ID = "5b801e38-be64-4590-84ac-becf78b8848d";
const DEALER = "531fab89-034a-457b-9327-4056522cc7a6";
const DATE = "2026-08-24";
const BASE_SKU = "430b7727"; // stock source of PD0191S, resolved below

async function main() {
  console.log("── razorpay attempts on this order (ANY status) ──");
  const rzp = (await pgClient`
    SELECT razorpay_order_id AS "rzpOrderId", razorpay_payment_id AS "rzpPaymentId",
           amount::numeric AS amount, status::text AS status, kind::text AS kind,
           created_at AS "createdAt", updated_at AS "updatedAt"
      FROM razorpay_payments WHERE order_id = ${ID}::uuid
     ORDER BY created_at
  `) as any[];
  if (!rzp.length) console.log("  none");
  for (const p of rzp) {
    console.log(`  ${p.status.padEnd(10)} ${p.kind}  Rs ${p.amount}  rzpOrder=${p.rzpOrderId ?? "-"} payment=${p.rzpPaymentId ?? "-"}  ${p.createdAt}`);
  }

  console.log("\n── invoice rows for this order ──");
  const inv = (await pgClient`
    SELECT invoice_number AS "invoiceNumber", total_amount::numeric AS total,
           invoice_date AS "invoiceDate"
      FROM invoices WHERE order_id = ${ID}::uuid
  `) as any[];
  console.log(inv.length ? JSON.stringify(inv) : "  none");

  console.log("\n── ledger rows against this order ──");
  const led = (await pgClient`
    SELECT type::text AS type, amount::numeric AS amount,
           reference_type::text AS "refType", voucher_type AS "voucherType",
           description, created_at AS "createdAt"
      FROM dealer_ledger WHERE reference_id = ${ID}::uuid
  `) as any[];
  console.log(led.length ? JSON.stringify(led, null, 2) : "  none");

  console.log("\n── dealer wallet ──");
  const credit = await checkDealerCredit(DEALER, 44.66);
  console.log(`  available Rs ${credit.available.toFixed(2)}  outstanding Rs ${credit.outstanding.toFixed(2)}  sufficient=${credit.sufficient}  creditInstitution=${credit.creditInstitution}`);
  const recent = (await pgClient`
    SELECT type::text AS type, amount::numeric AS amount,
           reference_type::text AS "refType", voucher_type AS "voucherType",
           voucher_date::text AS "voucherDate", balance_after::numeric AS "balanceAfter"
      FROM dealer_ledger WHERE dealer_id = ${DEALER}::uuid
     ORDER BY created_at DESC LIMIT 8
  `) as any[];
  console.log("  last 8 ledger rows:");
  for (const r of recent) {
    console.log(`    ${r.voucherDate}  ${r.type.padEnd(6)} Rs ${String(r.amount).padStart(10)}  ${r.refType}/${r.voucherType ?? "-"}  balAfter=${r.balanceAfter}`);
  }

  console.log("\n── stock: PD0191S draws from its base SKU ──");
  const [sku] = (await pgClient`
    SELECT p.code, p.name,
           COALESCE(p.stock_source_product_id, p.id)::text AS "stockProductId",
           b.code AS "baseCode", b.name AS "baseName"
      FROM products p
      LEFT JOIN products b ON b.id = COALESCE(p.stock_source_product_id, p.id)
     WHERE p.code = 'PD0191S'
  `) as any[];
  console.log(`  ${sku.code} (${sku.name}) -> ${sku.baseCode} (${sku.baseName})  id=${sku.stockProductId}`);
  const availToday = await fgsAvailable(pgClient, sku.stockProductId, DATE);
  console.log(`  fgs_available on ${DATE}: ${availToday}  (order needs 2)`);
  const [fgs] = (await pgClient`
    SELECT opening, received, dispatched, wastage, closing
      FROM fgs_day(${DATE}::date) WHERE product_id = ${sku.stockProductId}::uuid
  `) as any[];
  console.log(`  fgs_day: ${JSON.stringify(fgs)}`);

  console.log("\n── the dealer's standing subsidy template ──");
  const st = (await pgClient`
    SELECT p.code, s.quantity, r.name AS "routeName", s.is_active AS "isActive"
      FROM dealer_standing_indents s
      JOIN products p ON p.id = s.product_id
      LEFT JOIN routes r ON r.id = s.route_id
     WHERE s.dealer_id = ${DEALER}::uuid
     ORDER BY p.code
  `) as any[];
  console.log(st.length ? JSON.stringify(st) : "  none");

  console.log("\n── this dealer's recent order history ──");
  const hist = (await pgClient`
    SELECT delivery_date::text AS "deliveryDate", status::text AS status,
           payment_mode::text AS "paymentMode", grand_total::numeric AS total,
           item_count AS items, cancellation_reason AS reason
      FROM orders WHERE dealer_id = ${DEALER}::uuid
     ORDER BY delivery_date DESC, created_at DESC LIMIT 12
  `) as any[];
  for (const h of hist) {
    console.log(`  ${h.deliveryDate}  ${h.status.padEnd(17)} ${String(h.paymentMode ?? "-").padEnd(7)} Rs ${String(h.total).padStart(9)}  items=${h.items}  ${h.reason ?? ""}`);
  }

  await pgClient.end();
}

main().catch(async (e) => { console.error(e); await pgClient.end(); process.exit(1); });
