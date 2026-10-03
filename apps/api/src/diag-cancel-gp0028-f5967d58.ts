// ═══════════════════════════════════════════════════════════════════════
// diag-cancel-gp0028-f5967d58.ts — one-off: cancel gate-pass sale GP-0028
// (direct_sales f5967d58-…), which was booked as a UPI sale but never paid.
//
// ── What this sale is ────────────────────────────────────────────────
//   GP-0028, agent S121 S P BANDI, HANGAL ROUTE, sale_date 2026-08-06
//   1 × PD0191 HTM 1000ML @ ₹44.650 = ₹44.65, payment_mode 'upi'
//   payment_ref = NULL, dispatched_at = NULL
//
// ── Why it is safe to remove ─────────────────────────────────────────
// NO money was collected, on any rail:
//   • razorpay_payments: one kind='gate_pass' row, status 'created',
//     qr_TMNQIns8C5Xat9, razorpay_payment_id NULL, amount_refunded ₹0 —
//     the counter QR was minted and never scanned. applyPaidGatePassPayment
//     stamps direct_sales.payment_ref on payment; it is NULL, so no
//     qr_code.credited ever landed.
//   • payments (Day Book receipts): none reference this sale.
//   • dealer_ledger: none reference this sale.
//   • invoices: none.
// So there is no refund to make and no receipt to reverse — deleting the
// sale removes revenue that was never real, not money the agent is owed.
//
// ── Why DELETE rather than a cancelled flag ──────────────────────────
// direct_sales has no status / cancelled_at / deleted_at column — there is
// no soft-cancel state in the schema, so removing the row is the only way
// to stop it counting as a sale in Recent Sales, the Day Book, the sales
// reports, the Gate Pass Report and the Dispatch Sheet. GP-0028 becomes a
// gap in the gp_no sequence, which is what a cancelled document looks like.
//
// ── Order of operations (matters) ────────────────────────────────────
// 1. CLOSE THE QR AT RAZORPAY FIRST. It was minted with close_by = mint +
//    RAZORPAY_QR_CLOSE_AFTER_SECONDS (default 1800s), so it can still be
//    scanned until ~06:28 UTC. Deleting the sale under a live QR is the one
//    ordering that could take ₹44.65 with no row to attribute it to — the
//    qr_code.credited webhook would hit applyPaidGatePassPayment and throw
//    "direct_sale … not found". Same ordering the counter's own
//    POST /direct-sales/:id/qr/close uses (direct-sales.ts:704-715).
// 2. RE-CHECK for money after closing (DB + the gateway's own view of the
//    QR). Anything received → abort, nothing is deleted.
// 3. Delete, in one transaction:
//      • the razorpay_payments QR row — forced: its FK is ON DELETE
//        RESTRICT, and the razorpay_payments_shape_matches_kind CHECK
//        requires kind='gate_pass' to keep direct_sale_id NOT NULL, so it
//        can be neither kept nor detached. It is an unpaid, closed QR with
//        no gateway payment id, so nothing financial is lost.
//      • the direct_sales row — direct_sale_items and gate_pass_items
//        cascade (both FKs are ON DELETE CASCADE).
// 4. Restore the 1 unit of PD0191 to products.stock, the inverse of the
//    deduction the gate-pass create path does (direct-sales.ts:342-348).
//    NOTE: FGS is untouched by design — fgs_day()/fgs_available() count
//    `orders` only, never direct_sales, so this sale never moved the
//    day-aware stock the app gates on. products.stock is the vestigial
//    counter, restored purely for consistency with how the sale was made.
//
// USAGE (from apps/api):
//   npx tsx src/diag-cancel-gp0028-f5967d58.ts            ← dry run
//   npx tsx src/diag-cancel-gp0028-f5967d58.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js"; // loads the root .env (Razorpay keys)

const APPLY = process.argv.includes("--apply");

const SALE_ID = "f5967d58-48c6-4a27-afdf-dd59c6b99b7d";
const EXPECTED_GP = "GP-0028";
const EXPECTED_TOTAL = 44.65;
const EXPECTED_QR = "qr_TMNQIns8C5Xat9";
const EXPECTED_PRODUCT = "PD0191";
const EXPECTED_QTY = 1;

function bail(msg: string): never {
  console.log(`\n✗ ${msg}`);
  throw new Error("ABORT");
}

async function main() {
  console.log(APPLY ? "CANCEL GP-0028 — APPLY" : "CANCEL GP-0028 — DRY RUN (inspect only)");
  console.log("────────────────────────────────────────────────────────");

  // ── Guards: the premise must still hold ──
  const [sale] = (await pgClient`
    SELECT ds.id::text AS id, ds.gp_no AS "gpNo",
           ds.customer_type::text AS "customerType",
           ds.payment_mode::text AS "paymentMode", ds.payment_ref AS "paymentRef",
           ds.grand_total::numeric AS total, ds.sale_date::text AS "saleDate",
           ds.dispatched_at::text AS "dispatchedAt",
           d.code AS "dealerCode", d.name AS "dealerName"
      FROM direct_sales ds
      LEFT JOIN dealers d ON ds.customer_type = 'agent' AND d.id = ds.customer_id
     WHERE ds.id = ${SALE_ID}::uuid
  `) as any[];

  if (!sale) {
    console.log("✓ sale no longer exists — nothing to do (already cancelled?)");
    await pgClient.end();
    return;
  }

  console.log(`sale   : ${sale.gpNo}  ${sale.dealerCode} ${sale.dealerName}`);
  console.log(`money  : ₹${sale.total}  mode=${sale.paymentMode}  ref=${sale.paymentRef ?? "NULL"}`);
  console.log(`dates  : sale_date=${sale.saleDate}  dispatched=${sale.dispatchedAt ?? "-"}`);

  if (sale.gpNo !== EXPECTED_GP) bail(`gp_no is ${sale.gpNo}, expected ${EXPECTED_GP} — refusing`);
  if (Math.abs(parseFloat(sale.total) - EXPECTED_TOTAL) > 0.001)
    bail(`grand_total ₹${sale.total} ≠ expected ₹${EXPECTED_TOTAL} — the sale changed; refusing`);
  if (sale.paymentRef)
    bail(`payment_ref is '${sale.paymentRef}' — this sale IS paid. Refusing; it needs a refund, not a delete.`);
  if (sale.dispatchedAt)
    bail(`dispatched_at is ${sale.dispatchedAt} — the goods left the gate. Refusing.`);

  // ── No money on any rail ──
  const paid = (await pgClient`
    SELECT id::text AS id, status::text AS status, amount::numeric AS amount,
           razorpay_payment_id AS "rzpId", razorpay_qr_code_id AS "qrId"
      FROM razorpay_payments WHERE direct_sale_id = ${SALE_ID}::uuid
  `) as any[];
  console.log(`\nrazorpay_payments rows: ${paid.length}`);
  for (const p of paid)
    console.log(`  ${p.status} ₹${p.amount} qr=${p.qrId ?? "-"} pay=${p.rzpId ?? "-"}`);

  const settled = paid.filter((p) => p.status === "paid" || p.rzpId);
  if (settled.length) bail("a PAID gateway row exists — money was taken. Refusing.");
  if (paid.length > 1) bail("more than one gateway row — re-inspect by hand. Refusing.");
  if (paid.length === 1 && paid[0].qrId !== EXPECTED_QR)
    bail(`QR is ${paid[0].qrId}, expected ${EXPECTED_QR} — a new QR was minted. Refusing.`);

  const [{ n: nPay }] = (await pgClient`
    SELECT count(*)::int AS n FROM payments
     WHERE reference ILIKE ${"%" + SALE_ID + "%"} OR notes ILIKE ${"%" + SALE_ID + "%"}
  `) as any[];
  const [{ n: nLed }] = (await pgClient`
    SELECT count(*)::int AS n FROM dealer_ledger WHERE reference_id = ${SALE_ID}::uuid
  `) as any[];
  const [{ n: nInv }] = (await pgClient`
    SELECT count(*)::int AS n FROM invoices WHERE order_id = ${SALE_ID}::uuid
  `) as any[];
  console.log(`receipts=${nPay}  ledger rows=${nLed}  invoices=${nInv}  (all must be 0)`);
  if (nPay || nLed || nInv) bail("money artefacts exist for this sale — refusing.");

  // ── What will be removed ──
  const items = (await pgClient`
    SELECT p.code, dsi.quantity, dsi.line_total::numeric AS line,
           dsi.product_id::text AS "productId"
      FROM direct_sale_items dsi JOIN products p ON p.id = dsi.product_id
     WHERE dsi.direct_sale_id = ${SALE_ID}::uuid
  `) as any[];
  const [{ n: nGpi }] = (await pgClient`
    SELECT count(*)::int AS n FROM gate_pass_items WHERE direct_sale_id = ${SALE_ID}::uuid
  `) as any[];

  console.log(`\nlines to remove (${items.length}), gate_pass_items ${nGpi}:`);
  for (const i of items) console.log(`  ${i.code} qty=${i.quantity} ₹${i.line}`);
  if (items.length !== 1 || items[0].code !== EXPECTED_PRODUCT || items[0].quantity !== EXPECTED_QTY)
    bail(`expected exactly 1 × ${EXPECTED_QTY} ${EXPECTED_PRODUCT} — the sale changed; refusing.`);

  const [stockBefore] = (await pgClient`
    SELECT stock::numeric AS stock FROM products WHERE id = ${items[0].productId}::uuid
  `) as any[];
  console.log(`\nPD0191 products.stock BEFORE: ${stockBefore.stock}  (will become ${parseFloat(stockBefore.stock) + EXPECTED_QTY})`);
  console.log("FGS: untouched — fgs_day()/fgs_available() read `orders` only, never direct_sales.");

  console.log("\nPLAN:");
  console.log(`  1. close ${EXPECTED_QR} at Razorpay (it is payable until ~30 min after mint)`);
  console.log("  2. re-verify no payment landed (DB + gateway)");
  console.log("  3. delete razorpay_payments QR row, then direct_sales row (items cascade)");
  console.log(`  4. products.stock += ${EXPECTED_QTY} for ${EXPECTED_PRODUCT}`);

  if (!APPLY) {
    console.log("\n— dry run — re-run with --apply to execute.");
    await pgClient.end();
    return;
  }

  // ── 1. Close the QR at Razorpay, FIRST ──
  const rzp = await import("./lib/razorpay-client.js");
  if (!rzp.isRazorpayConfigured()) {
    bail(
      "Razorpay is not configured in this environment, so the live QR cannot be closed. " +
        "Refusing to delete the sale while its QR is still scannable — close it from the " +
        "counter screen (POST /direct-sales/:id/qr/close) or wait for close_by, then re-run.",
    );
  }

  if (paid.length === 1) {
    console.log(`\n1. closing ${EXPECTED_QR} at Razorpay …`);
    try {
      const closed = await rzp.closeRazorpayQrCode(EXPECTED_QR);
      console.log(`   ✓ QR ${closed.id} is now '${closed.status}'`);
    } catch (err: any) {
      bail(`could not close the QR at Razorpay (${err?.message ?? err}) — refusing to delete while it may still be payable.`);
    }

    // ── 2. Re-verify against the gateway itself ──
    console.log("\n2. re-verifying no payment landed …");
    try {
      const live = await rzp.fetchRazorpayQrCode(EXPECTED_QR);
      console.log(`   gateway: status=${live.status} received=₹${(live.paymentsAmountReceived / 100).toFixed(2)} count=${live.paymentsCountReceived}`);
      if (live.paymentsCountReceived > 0 || live.paymentsAmountReceived > 0)
        bail("the gateway reports money received on this QR — refusing to delete. Reconcile it instead.");
    } catch (err: any) {
      bail(`could not read the QR back from Razorpay (${err?.message ?? err}) — refusing to delete without confirming it took nothing.`);
    }
  } else {
    console.log("\n1-2. no QR row — nothing to close at Razorpay");
  }

  // ── 3 + 4. Delete and restore stock, in one transaction ──
  console.log("\n3. deleting …");
  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    // Re-read under lock: a webhook could have landed while we were talking
    // to Razorpay.
    const [live] = (await tx`
      SELECT payment_ref AS "paymentRef" FROM direct_sales
       WHERE id = ${SALE_ID}::uuid FOR UPDATE
    `) as any[];
    if (!live) throw new Error("sale vanished mid-transaction — aborting");
    if (live.paymentRef)
      throw new Error(`payment_ref '${live.paymentRef}' appeared while closing the QR — aborting, this sale was paid`);

    const stillUnpaid = (await tx`
      SELECT id FROM razorpay_payments
       WHERE direct_sale_id = ${SALE_ID}::uuid
         AND (status = 'paid' OR razorpay_payment_id IS NOT NULL)
    `) as any[];
    if (stillUnpaid.length) throw new Error("a paid gateway row appeared — aborting");

    const delRzp = await tx`
      DELETE FROM razorpay_payments WHERE direct_sale_id = ${SALE_ID}::uuid RETURNING id
    `;
    const delSale = await tx`
      DELETE FROM direct_sales WHERE id = ${SALE_ID}::uuid RETURNING id
    `;
    console.log(`   razorpay_payments deleted: ${delRzp.length}`);
    console.log(`   direct_sales deleted: ${delSale.length} (items + gate_pass_items cascaded)`);

    await tx`
      UPDATE products SET stock = stock + ${EXPECTED_QTY}, updated_at = now()
       WHERE id = ${items[0].productId}::uuid
    `;
  });

  // ── Verify ──
  console.log("\n── verify ──");
  const [{ n: saleLeft }] = (await pgClient`
    SELECT count(*)::int AS n FROM direct_sales WHERE id = ${SALE_ID}::uuid
  `) as any[];
  const [{ n: itemsLeft }] = (await pgClient`
    SELECT count(*)::int AS n FROM direct_sale_items WHERE direct_sale_id = ${SALE_ID}::uuid
  `) as any[];
  const [{ n: gpiLeft }] = (await pgClient`
    SELECT count(*)::int AS n FROM gate_pass_items WHERE direct_sale_id = ${SALE_ID}::uuid
  `) as any[];
  const [{ n: rzpLeft }] = (await pgClient`
    SELECT count(*)::int AS n FROM razorpay_payments WHERE direct_sale_id = ${SALE_ID}::uuid
  `) as any[];
  const [stockAfter] = (await pgClient`
    SELECT stock::numeric AS stock FROM products WHERE id = ${items[0].productId}::uuid
  `) as any[];

  console.log(`  direct_sales rows      : ${saleLeft} (expect 0)`);
  console.log(`  direct_sale_items rows : ${itemsLeft} (expect 0)`);
  console.log(`  gate_pass_items rows   : ${gpiLeft} (expect 0)`);
  console.log(`  razorpay_payments rows : ${rzpLeft} (expect 0)`);
  console.log(`  PD0191 products.stock  : ${stockBefore.stock} → ${stockAfter.stock} (expect +${EXPECTED_QTY})`);

  const ok =
    saleLeft === 0 && itemsLeft === 0 && gpiLeft === 0 && rzpLeft === 0 &&
    parseFloat(stockAfter.stock) === parseFloat(stockBefore.stock) + EXPECTED_QTY;
  console.log(ok ? "\n✓ GP-0028 cancelled: sale removed, QR closed, 1 × PD0191 back on the counter." : "\n⚠ UNEXPECTED — investigate!");

  await pgClient.end();
}

main().catch(async (err) => {
  if (err?.message !== "ABORT") console.error("\n✗ ERROR:", err);
  try { await pgClient.end(); } catch {}
  process.exit(1);
});
