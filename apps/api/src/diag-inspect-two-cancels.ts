// ═══════════════════════════════════════════════════════════════════════
// diag-inspect-two-cancels.ts — READ-ONLY inspection of the two dispatched
// orders the admin wants cancelled + refunded to available balance/wallet.
//
// Establishes, per order: dealer, status, payment_mode, totals, delivery
// date, stock_deducted latch, line items, whether money actually changed
// hands (razorpay_payments / payments / dealer_ledger), whether an invoice
// was minted, and what the FGS day rows look like for the affected SKUs.
//
// USAGE (from apps/api):  npx tsx src/diag-inspect-two-cancels.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const ORDER_IDS = [
  "98e70c98-bfba-4465-8f12-e1e9d9f6d9f3",
  "dbbecb23-195c-429b-a54c-4459a20d1943",
];

async function main() {
  for (const id of ORDER_IDS) {
    console.log("\n════════════════════════════════════════════════════════");
    console.log(`ORDER ${id}`);
    console.log("════════════════════════════════════════════════════════");

    const [o] = await pgClient`
      SELECT o.id::text,
             o.dealer_id::text AS "dealerId", o.status::text AS status,
             o.payment_mode::text AS "paymentMode",
             o.subtotal::numeric AS "subtotal",
             o.total_gst::numeric AS "totalGst",
             o.grand_total::numeric AS "grandTotal",
             o.delivery_date::text AS "deliveryDate",
             o.order_date::text AS "orderDate",
             o.stock_deducted AS "stockDeducted",
             o.created_at, o.updated_at, o.dispatched_at,
             o.cancelled_at, o.cancellation_reason,
             o.route_id::text AS "routeId",
             d.code AS "dealerCode", d.name AS "dealerName",
             d.customer_type::text AS "customerType",
             d.opening_balance::numeric AS "openingBalance"
        FROM orders o JOIN dealers d ON d.id = o.dealer_id
       WHERE o.id = ${id}::uuid
    `;
    if (!o) { console.log("✗ NOT FOUND"); continue; }
    console.log(JSON.stringify(o, null, 2));

    const items = await pgClient`
      SELECT oi.product_id::text AS "productId", oi.product_name AS "productName",
             oi.quantity, oi.unit_price::numeric AS "unitPrice",
             oi.line_total::numeric AS "totalPrice",
             p.code AS "productCode",
             COALESCE(p.stock_source_product_id, p.id)::text AS "stockProductId",
             p.stock::numeric AS "productsStockNow"
        FROM order_items oi JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = ${id}::uuid
       ORDER BY oi.product_name
    `;
    console.log("\nLINES:");
    for (const it of items as any[]) {
      console.log(`  ${it.productCode} ${it.productName}  qty=${it.quantity} @ ₹${it.unitPrice} = ₹${it.totalPrice}`
        + `  stockSrc=${it.stockProductId === it.productId ? "self" : it.stockProductId} products.stock=${it.productsStockNow}`);
    }

    const rzp = await pgClient`
      SELECT id::text, kind::text, status::text, amount::numeric AS amount,
             amount_refunded::numeric AS "amountRefunded",
             razorpay_payment_id AS "rzpPaymentId", created_at
        FROM razorpay_payments WHERE order_id = ${id}::uuid ORDER BY created_at
    `;
    console.log(`\nrazorpay_payments (${rzp.length}):`);
    for (const r of rzp as any[]) console.log("  " + JSON.stringify(r));

    // `payments` has no order_id — receipts tie to the order via reference or invoice.
    const pays = await pgClient`
      SELECT p.id::text, p.amount::numeric AS amount, p.mode::text AS mode,
             p.reference, p.received_date::text AS "receivedDate", p.notes, p.created_at
        FROM payments p
        LEFT JOIN invoices i ON i.id = p.invoice_id
       WHERE p.reference ILIKE ${"%" + id + "%"}
          OR p.notes ILIKE ${"%" + id + "%"}
          OR i.order_id = ${id}::uuid
       ORDER BY p.created_at
    `;
    console.log(`\npayments receipts tied to this order (${pays.length}):`);
    for (const p of pays as any[]) console.log("  " + JSON.stringify(p));

    const leds = await pgClient`
      SELECT id::text, type::text, amount::numeric AS amount,
             reference_type::text AS "refType", reference_id::text AS "refId",
             voucher_type AS "voucherType", description,
             balance_after::numeric AS "balanceAfter", created_at
        FROM dealer_ledger
       WHERE reference_id = ${id}::uuid
       ORDER BY created_at
    `;
    console.log(`\ndealer_ledger rows referencing THIS order (${leds.length}):`);
    for (const l of leds as any[]) console.log("  " + JSON.stringify(l));

    const inv = await pgClient`
      SELECT id::text, invoice_number::text AS "invoiceNumber",
             invoice_date::text AS "invoiceDate",
             total_amount::numeric AS "totalAmount",
             payment_status::text AS "paymentStatus",
             paid_amount::numeric AS "paidAmount"
        FROM invoices WHERE order_id = ${id}::uuid
    `;
    console.log(`\ninvoices (${inv.length}):`);
    for (const i of inv as any[]) console.log("  " + JSON.stringify(i));

    // Dealer-side money state
    const [bal] = await pgClient`
      SELECT COALESCE(d.opening_balance, 0)
           + COALESCE((SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount
                                       WHEN dl.type='debit'  THEN -dl.amount END)
                         FROM dealer_ledger dl
                        WHERE dl.dealer_id = d.id
                          AND COALESCE(dl.voucher_type,'') <> 'Opening'), 0) AS "closingBalance",
             (SELECT count(*)::int FROM dealer_ledger dl WHERE dl.dealer_id = d.id) AS "ledgerRows"
        FROM dealers d WHERE d.id = ${o.dealerId}::uuid
    `;
    const [w] = await pgClient`
      SELECT balance::numeric AS balance FROM dealer_wallets WHERE dealer_id = ${o.dealerId}::uuid
    `;
    console.log(`\nDEALER MONEY: ledger closing = ₹${bal!.closingBalance}  (ledger rows: ${bal!.ledgerRows})`);
    console.log(`              dealer_wallets.balance = ${w ? "₹" + w.balance : "(no row)"}`);

    // FGS state for each stock SKU on the order's delivery date + today
    console.log("\nFGS (delivery date vs today):");
    for (const it of items as any[]) {
      const [f] = await pgClient`
        SELECT fgs_available(${it.stockProductId}::uuid, ${o.deliveryDate}::date) AS "availDelivery",
               fgs_available(${it.stockProductId}::uuid, (now() AT TIME ZONE 'Asia/Kolkata')::date) AS "availToday"
      `;
      console.log(`  ${it.productCode}: avail@${o.deliveryDate} = ${f!.availDelivery}   avail@today = ${f!.availToday}`);
      const days = await pgClient`
        SELECT opening, received, dispatched, wastage, closing
          FROM fgs_day(${o.deliveryDate}::date) WHERE product_id = ${it.stockProductId}::uuid
      `;
      console.log(`    fgs_day(${o.deliveryDate}) = ${JSON.stringify(days[0] ?? null)}`);
      const daysT = await pgClient`
        SELECT opening, received, dispatched, wastage, closing
          FROM fgs_day((now() AT TIME ZONE 'Asia/Kolkata')::date) WHERE product_id = ${it.stockProductId}::uuid
      `;
      console.log(`    fgs_day(today)      = ${JSON.stringify(daysT[0] ?? null)}`);
    }
  }

  await pgClient.end();
}

main().catch((e) => { console.error("ERROR:", e); process.exit(1); });
