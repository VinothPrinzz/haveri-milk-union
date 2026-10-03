// ═══════════════════════════════════════════════════════════════════════
// diag-cancel-two-dispatched-2026-08-08.ts — one-off: cancel two DISPATCHED
// orders from 2026-08-08 and refund each dealer to their available balance
// (the "wallet" the dealer app shows), restoring stock.
//
//   98e70c98 — M70 MANJUNATH BASTI   ₹707.39   (PD0125×4, PD0274×6, PD0277×12)
//   dbbecb23 — R76 RABBANI CHANNAPUR ₹1256.11  (PD0124×20, PD0276×20, PD0277×30)
//
// Both are identical in shape:
//   • payment_mode = 'upi' — the dealer really paid through Razorpay
//     (status 'paid', amount_refunded ₹0.00), so the money is real and
//     unreturned. Crediting the balance is NOT a phantom credit (contrast
//     the wallet-cancel hazard, where payment_mode='wallet' orders get
//     grand_total credited even when placement never debited).
//   • ZERO dealer_ledger rows exist for either dealer — the UPI payment
//     posted no credit and the order posted no placement debit, so
//     available balance and dealer_wallets.balance are both ₹0.00.
//   • an invoice was minted for each. Cancelling deliberately LEAVES it in
//     place — that is the codebase's convention (orders.ts GET /:id/invoice:
//     "an existing invoice for a since-cancelled order is still returned for
//     viewing"). Nothing here voids or deletes an invoice.
//
// ── Why adminCancelOrder(..., "balance") ──────────────────────────────
// For a upi order with a captured payment, "balance" resolves to
// plan = { to: "ledger", amount: paidRemaining } (cancel-order.ts:241-244) —
// the documented "online-paid order, but the admin chose store credit over a
// bank refund" case. That posts ONE dealer_ledger credit, which is what the
// dealer app shows as their wallet: credit_available = GREATEST(0, ledger
// closing_balance) (dealers.ts:813), rendered as "₹… in wallet" by
// IndentCheckoutScreen — NOT dealer_wallets, which stays ₹0.00 deliberately
// (crediting both would double-count in the finance views). No Razorpay call
// is made, so the cash stays with the union as store credit.
//
// ── Why a script rather than the admin UI ─────────────────────────────
// POST /orders/:id/cancel refuses these: its window guard rejects any order
// whose delivery window has closed, and these are yesterday's. This makes the
// SAME adminCancelOrder call the route would make, bypassing only that guard.
//
// ── Stock ─────────────────────────────────────────────────────────────
// cancelOrderWithReversal → restoreOrderStock clears orders.stock_deducted
// and adds the lines back to the vestigial products.stock counter. The FGS
// daily model (the number the dealer app and Stock Entry actually show) keys
// its outflow on `stock_deducted = true AND status <> 'cancelled'`, bucketed by
// DELIVERY DATE — so the restore lands on 2026-08-08's sheet (that day's
// dispatch drops, its closing rises) and carries forward into today's opening,
// making the units available again today. Verified below per SKU.
//
// performed_by is NULL (system correction; the column is nullable).
//
// USAGE (from apps/api):
//   npx tsx src/diag-cancel-two-dispatched-2026-08-08.ts            ← dry run
//   npx tsx src/diag-cancel-two-dispatched-2026-08-08.ts --apply    ← execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { adminCancelOrder } from "./lib/cancel-order.js";

const APPLY = process.argv.includes("--apply");

const REASON = "Cancelled by admin — refunded to dealer available balance as store credit";
const PERFORMED_BY = null as unknown as string; // system correction → NULL

interface Target {
  orderId: string;
  dealerId: string;
  dealerCode: string;
  expectedTotal: number;
}

const TARGETS: Target[] = [
  {
    orderId: "98e70c98-bfba-4465-8f12-e1e9d9f6d9f3",
    dealerId: "7260b972-4e3b-40f4-87b7-789ee8f5b68e",
    dealerCode: "M70",
    expectedTotal: 707.39,
  },
  {
    orderId: "dbbecb23-195c-429b-a54c-4459a20d1943",
    dealerId: "6f01f5ed-a1e5-4448-804f-bd7cfdbfa2bc",
    dealerCode: "R76",
    expectedTotal: 1256.11,
  },
];

/** What the dealer app shows as "wallet": GREATEST(0, ledger closing balance). */
async function availableBalance(dealerId: string): Promise<number> {
  const [row] = await pgClient`
    SELECT GREATEST(0,
             COALESCE(d.opening_balance, 0)
             + COALESCE((SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount
                                         WHEN dl.type='debit'  THEN -dl.amount END)
                          FROM dealer_ledger dl
                         WHERE dl.dealer_id = d.id
                           AND COALESCE(dl.voucher_type,'') <> 'Opening'), 0)
           )::numeric AS avail
      FROM dealers d WHERE d.id = ${dealerId}::uuid
  `;
  return parseFloat(row!.avail);
}

interface Line {
  productId: string;
  stockProductId: string;
  productCode: string;
  productName: string;
  quantity: number;
}

async function orderLines(orderId: string): Promise<Line[]> {
  const rows = await pgClient`
    SELECT oi.product_id::text AS "productId",
           COALESCE(p.stock_source_product_id, p.id)::text AS "stockProductId",
           p.code AS "productCode", oi.product_name AS "productName",
           oi.quantity::int AS quantity
      FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ${orderId}::uuid
     ORDER BY p.code
  `;
  return rows as unknown as Line[];
}

/** FGS availability for a SKU on a given date, plus the raw products.stock counter. */
async function stockSnapshot(stockProductId: string, deliveryDate: string) {
  const [f] = await pgClient`
    SELECT fgs_available(${stockProductId}::uuid, ${deliveryDate}::date) AS "availDelivery",
           fgs_available(${stockProductId}::uuid,
                         (now() AT TIME ZONE 'Asia/Kolkata')::date)     AS "availToday"
  `;
  const [d] = await pgClient`
    SELECT dispatched, closing
      FROM fgs_day(${deliveryDate}::date) WHERE product_id = ${stockProductId}::uuid
  `;
  const [p] = await pgClient`
    SELECT stock::numeric AS stock FROM products WHERE id = ${stockProductId}::uuid
  `;
  return {
    availDelivery: Number(f!.availDelivery),
    availToday: Number(f!.availToday),
    dayDispatched: Number(d?.dispatched ?? 0),
    dayClosing: Number(d?.closing ?? 0),
    productsStock: parseFloat(p!.stock),
  };
}

async function processOne(t: Target): Promise<boolean> {
  console.log("\n════════════════════════════════════════════════════════");
  console.log(`ORDER ${t.orderId}  (${t.dealerCode})`);
  console.log("════════════════════════════════════════════════════════");

  const [ord] = await pgClient`
    SELECT o.id::text, o.dealer_id::text AS "dealerId", o.status::text AS status,
           o.payment_mode::text AS "paymentMode", o.grand_total::numeric AS "grandTotal",
           o.delivery_date::text AS "deliveryDate", o.stock_deducted AS "stockDeducted",
           d.name AS "dealerName", d.code AS "dealerCode"
      FROM orders o JOIN dealers d ON d.id = o.dealer_id
     WHERE o.id = ${t.orderId}::uuid
  `;
  if (!ord) { console.log("✗ order not found — skipping"); return false; }

  console.log(`dealer  : ${ord.dealerCode} ${ord.dealerName}`);
  console.log(`status  : ${ord.status}   payment_mode: ${ord.paymentMode}   total: ₹${ord.grandTotal}`);
  console.log(`delivery: ${ord.deliveryDate}   stock_deducted: ${ord.stockDeducted}`);

  // ── Guards: every premise must still hold at apply time ──
  if (ord.status === "cancelled") { console.log("\n✓ already cancelled — nothing to do"); return true; }
  if (ord.dealerId !== t.dealerId) { console.log("\n✗ dealer changed — refusing"); return false; }
  if (ord.dealerCode !== t.dealerCode) { console.log("\n✗ dealer code changed — refusing"); return false; }
  if (ord.status !== "dispatched") { console.log(`\n✗ status is '${ord.status}', expected 'dispatched' — refusing`); return false; }
  if (ord.paymentMode !== "upi") { console.log(`\n✗ payment_mode is '${ord.paymentMode}', expected 'upi' — refusing`); return false; }
  if (Math.abs(parseFloat(ord.grandTotal) - t.expectedTotal) > 0.001) {
    console.log(`\n✗ grand_total ₹${ord.grandTotal} ≠ expected ₹${t.expectedTotal} — refusing`); return false;
  }
  if (ord.deliveryDate !== "2026-08-08") { console.log(`\n✗ delivery_date ${ord.deliveryDate} ≠ 2026-08-08 — refusing`); return false; }
  if (ord.stockDeducted !== true) { console.log("\n✗ stock_deducted is false — stock was never committed; re-inspect. Refusing"); return false; }

  const [rp] = await pgClient`
    SELECT amount::numeric AS amount, amount_refunded::numeric AS refunded,
           status::text AS status, razorpay_payment_id AS "rzpId"
      FROM razorpay_payments
     WHERE order_id = ${t.orderId}::uuid AND kind = 'order_payment' AND status = 'paid'
  `;
  if (!rp) { console.log("\n✗ no captured 'paid' razorpay_payments row — the store-credit premise is wrong; refusing"); return false; }
  const paidRemaining = parseFloat(rp.amount) - parseFloat(rp.refunded);
  console.log(`\ngateway : ${rp.rzpId} ${rp.status} ₹${rp.amount} refunded=₹${rp.refunded} → unrefunded ₹${paidRemaining.toFixed(2)}`);
  if (paidRemaining <= 0.001) { console.log("✗ nothing left unrefunded — refusing"); return false; }
  if (Math.abs(paidRemaining - t.expectedTotal) > 0.001) {
    console.log(`✗ unrefunded ₹${paidRemaining.toFixed(2)} ≠ order total ₹${t.expectedTotal} — refusing`); return false;
  }

  // No ledger row may already reference this order (would mean it was already
  // credited by some other path).
  const [{ n: refRows }] = await pgClient`
    SELECT count(*)::int AS n FROM dealer_ledger WHERE reference_id = ${t.orderId}::uuid
  ` as any[];
  if (refRows !== 0) {
    console.log(`\n✗ ${refRows} dealer_ledger row(s) already reference this order — a credit may exist. Refusing`); return false;
  }

  const lines = await orderLines(t.orderId);
  const before = new Map<string, Awaited<ReturnType<typeof stockSnapshot>>>();
  console.log("\nLINES + stock BEFORE:");
  for (const l of lines) {
    const s = await stockSnapshot(l.stockProductId, ord.deliveryDate);
    before.set(l.stockProductId, s);
    console.log(`  ${l.productCode} ${l.productName} ×${l.quantity}`);
    console.log(`     FGS avail @2026-08-08 = ${s.availDelivery} | @today = ${s.availToday}`
      + ` | day dispatched = ${s.dayDispatched}, closing = ${s.dayClosing} | products.stock = ${s.productsStock}`);
  }

  const beforeBal = await availableBalance(t.dealerId);
  console.log(`\navailable balance BEFORE: ₹${beforeBal.toFixed(2)}`);
  console.log(`\nPLAN: adminCancelOrder(order, reason, NULL, "balance")`);
  console.log(`      → cancel + clear stock_deducted + restore ${lines.map(l => `${l.quantity}×${l.productCode}`).join(", ")}`);
  console.log(`      → dealer_ledger credit ₹${paidRemaining.toFixed(2)}; balance ₹${beforeBal.toFixed(2)} → ₹${(beforeBal + paidRemaining).toFixed(2)}`);
  console.log(`      → NO Razorpay refund (cash stays with the union as store credit)`);

  if (!APPLY) { console.log("\n— dry run — re-run with --apply to execute."); return true; }

  const summary = await adminCancelOrder(t.orderId, REASON, PERFORMED_BY, "balance");
  console.log("\n✓ adminCancelOrder returned:", JSON.stringify(summary));

  // ── Verify ──
  const [after] = await pgClient`
    SELECT status::text AS status, stock_deducted AS "stockDeducted",
           cancelled_at::text AS "cancelledAt", cancellation_reason AS reason
      FROM orders WHERE id = ${t.orderId}::uuid
  `;
  console.log("  order now:", JSON.stringify(after));

  const leds = await pgClient`
    SELECT type::text, amount::numeric AS amount, voucher_type AS "vType",
           reference_type::text AS "refType", description,
           balance_after::numeric AS "balAfter"
      FROM dealer_ledger WHERE dealer_id = ${t.dealerId}::uuid ORDER BY created_at
  `;
  console.log(`  dealer_ledger rows for ${t.dealerCode} now (${leds.length}):`);
  for (const l of leds as any[])
    console.log(`    ${l.type} ₹${l.amount} voucher=${l.vType} ref=${l.refType} bal_after=₹${l.balAfter} :: ${l.description}`);

  const [rpAfter] = await pgClient`
    SELECT status::text AS status, amount_refunded::numeric AS refunded
      FROM razorpay_payments WHERE order_id = ${t.orderId}::uuid AND kind = 'order_payment'
  `;
  console.log(`  razorpay_payments: status=${rpAfter!.status} amount_refunded=₹${rpAfter!.refunded} (expected: paid / ₹0.00 — no bank refund)`);

  console.log("\n  stock AFTER:");
  let stockOk = true;
  for (const l of lines) {
    const b = before.get(l.stockProductId)!;
    const a = await stockSnapshot(l.stockProductId, ord.deliveryDate);
    const dDisp = a.dayDispatched - b.dayDispatched;
    const dClose = a.dayClosing - b.dayClosing;
    const dToday = a.availToday - b.availToday;
    const dCounter = a.productsStock - b.productsStock;
    console.log(`    ${l.productCode} ×${l.quantity}: day dispatched ${b.dayDispatched}→${a.dayDispatched} (Δ${dDisp}),`
      + ` closing ${b.dayClosing}→${a.dayClosing} (Δ+${dClose}),`
      + ` avail@today ${b.availToday}→${a.availToday} (Δ+${dToday}),`
      + ` products.stock ${b.productsStock}→${a.productsStock} (Δ+${dCounter})`);
    if (dDisp !== -l.quantity || dClose !== l.quantity || dToday !== l.quantity || dCounter !== l.quantity) {
      stockOk = false;
      console.log(`      ⚠ expected Δ dispatched -${l.quantity}, Δ closing/avail/counter +${l.quantity}`);
    }
  }

  const afterBal = await availableBalance(t.dealerId);
  console.log(`\n  available balance AFTER: ₹${afterBal.toFixed(2)}  (Δ ₹${(afterBal - beforeBal).toFixed(2)}, expected ₹${paidRemaining.toFixed(2)})`);

  const ok = after!.status === "cancelled"
    && after!.stockDeducted === false
    && Math.abs((afterBal - beforeBal) - paidRemaining) < 0.001
    && parseFloat(rpAfter!.refunded) === 0
    && stockOk;
  console.log(ok
    ? `\n  ✓ verified: cancelled, ₹${paidRemaining.toFixed(2)} credited to available balance, stock restored, no bank refund.`
    : "\n  ⚠ UNEXPECTED — investigate!");
  return ok;
}

async function main() {
  console.log(APPLY
    ? "CANCEL 2 DISPATCHED ORDERS (2026-08-08) + BALANCE CREDIT — APPLY"
    : "CANCEL 2 DISPATCHED ORDERS (2026-08-08) + BALANCE CREDIT — DRY RUN (inspect only)");

  let allOk = true;
  for (const t of TARGETS) {
    const ok = await processOne(t);
    if (!ok) allOk = false;
  }

  console.log("\n════════════════════════════════════════════════════════");
  console.log(allOk ? "ALL OK" : "⚠ ONE OR MORE ORDERS DID NOT COMPLETE — see above");
  await pgClient.end();
  if (!allOk) process.exit(1);
}

main().catch((err) => { console.error("\n✗ ERROR:", err); process.exit(1); });
