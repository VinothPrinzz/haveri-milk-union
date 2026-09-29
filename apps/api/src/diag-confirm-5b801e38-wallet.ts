// ═══════════════════════════════════════════════════════════════════════
// diag-confirm-5b801e38-wallet.ts — one-off: confirm ONE order and settle
// it from the dealer's WALLET (a dealer_ledger debit).
//
// THIS ORDER'S STATE: K56 / KRISHNAPPA G CHOUDAPPANAVAR, 2026-08-24,
// 2 x HTM 1000ML (Subsidy) = Rs 44.66. The dealer chose "Pay online", never
// completed the UPI intent, and the window-close worker discarded it
// ('cancelled', reason = AUTO_DISCARD_REASON). It is NOT a superseded
// subsidy twin, so [[subsidy-rehome-daily-task]] does not apply: there is no
// live order for that date to re-home the line onto — this IS the day's only
// order, and reviving it is what keeps one live order per (dealer, date).
//
// "Wallet" and "credit" are the SAME settlement path in this system: the
// dealer's prepaid balance is drawn down by a dealer_ledger 'order' debit,
// and orders.payment_mode stays 'credit' (the cancel/refund path branches on
// that value to know how to reverse the money — see lib/cancel-order.ts).
// Writing payment_mode='wallet' is what produced the phantom-credit-on-cancel
// bug, so this script never does.
//
// The revive half mirrors confirmPaidOrder's auto-discard branch in
// routes/dealer-payments.ts (clear cancelled_at + cancellation_reason,
// cancel_window_ends_at = now() — zero cancel grace, because the window has
// already closed). The confirm half replicates the admin confirm path
// (routes/admin-indents.ts) step for step, importing the SAME libs it uses so
// behaviour cannot drift:
//   1. min-order-qty + FGS stock pre-checks (advisory)
//   2. status -> 'confirmed', payment_mode -> 'credit', confirmed_at, route
//      stamp, cancel window
//   3. dealer_ledger debit of grand_total (voucher_type 'Invoice')
//   4. cancelSupersededSiblings  (BEFORE the stock deduct — a live twin's
//      reservation would otherwise double-count against this order)
//   5. deductOrderStock          (FGS-gated, advisory-locked)
//   6. enqueuePDFInvoice
//
// SAFETY GUARDS — the script aborts with no writes if any fail:
//   • order is in 'draft' / 'payment_required', OR 'cancelled' with exactly
//     the auto-discard reason (a dealer/admin cancel is NEVER revived here)
//   • no OTHER live order for the same dealer + delivery_date + route
//   • dealer is not soft-deleted, order has line items
//   • NO existing dealer_ledger 'order' debit (never double-charge)
//   • NO captured razorpay payment (would charge the dealer twice)
//   • wallet balance covers grand_total (waived for credit institutions)
// The whole write is one transaction, re-locked and re-checked inside it
// (a live worker mutates order state on this DB); the stock guard throwing
// rolls it all back.
//
// USAGE (from apps/api):
//   npx tsx src/diag-confirm-5b801e38-wallet.ts           <- dry run
//   npx tsx src/diag-confirm-5b801e38-wallet.ts --apply   <- execute
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";
import { checkDealerCredit } from "./lib/credit-check.js";
import {
  getOrderStockShortfalls,
  deductOrderStock,
  describeShortfalls,
  StockConflictError,
} from "./lib/stock-check.js";
import { cancelSupersededSiblings } from "./lib/supersede-orders.js";
import {
  findOrderMinQtyViolations,
  minQtyErrorMessage,
} from "./lib/min-order-qty.js";
import { enqueuePDFInvoice } from "./lib/queue.js";

const ORDER_ID = "5b801e38-be64-4590-84ac-becf78b8848d";
const APPLY = process.argv.includes("--apply");

// Mirror of AUTO_DISCARD_REASON in routes/dealer-payments.ts and the literal
// in apps/worker/src/jobs/auto-confirm-drafts.ts — keep all three in sync.
const AUTO_DISCARD_REASON = "Online payment not completed before window close";

const CONFIRMABLE = ["draft", "payment_required"];
const money = (n: number) => "Rs " + n.toFixed(2);

async function abort(msg: string): Promise<never> {
  console.error("\nABORT - " + msg + "\n(no changes made)");
  await pgClient.end();
  process.exit(1);
}

async function main() {
  console.log("========================================================");
  console.log(APPLY ? "CONFIRM + WALLET DEBIT - APPLY" : "CONFIRM + WALLET DEBIT - DRY RUN");
  console.log("order", ORDER_ID);
  console.log("========================================================");

  // ── 1. The order ──
  const ordRows = (await pgClient`
    SELECT o.id::text             AS id,
           o.dealer_id::text      AS "dealerId",
           o.status::text         AS status,
           o.payment_mode::text   AS "paymentMode",
           o.grand_total::numeric AS "grandTotal",
           o.item_count           AS "itemCount",
           o.stock_deducted       AS "stockDeducted",
           o.delivery_date::text  AS "deliveryDate",
           o.created_at           AS "createdAt",
           o.cancelled_at         AS "cancelledAt",
           o.cancellation_reason  AS "cancelReason",
           o.route_id::text       AS "routeId",
           r.name                 AS "routeName"
      FROM orders o
      LEFT JOIN routes r ON r.id = o.route_id
     WHERE o.id = ${ORDER_ID}::uuid
  `) as any[];

  if (ordRows.length === 0) await abort("no order with this id");
  if (ordRows.length > 1) await abort(`order has ${ordRows.length} physical rows - inspect manually`);
  const ord = ordRows[0];

  const [dealer] = (await pgClient`
    SELECT d.id::text            AS id,
           d.name                AS name,
           d.code                AS code,
           d.customer_type::text AS "customerType",
           d.deleted_at          AS "deletedAt"
      FROM dealers d WHERE d.id = ${ord.dealerId}::uuid LIMIT 1
  `) as any[];
  if (!dealer) await abort("dealer not found");

  const items = (await pgClient`
    SELECT p.code AS code, oi.product_name AS "productName", oi.quantity AS quantity,
           oi.line_total::numeric AS "lineTotal"
      FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE oi.order_id = ${ORDER_ID}::uuid
     ORDER BY p.code
  `) as any[];

  const grandTotal = parseFloat(ord.grandTotal);
  const isRevive = ord.status === "cancelled";

  console.log(`\nDealer:   ${dealer.name} (${dealer.code})  [${dealer.customerType ?? "-"}]`);
  console.log(`Status:   ${ord.status}   payment_mode: ${ord.paymentMode ?? "-"}`);
  if (ord.cancelReason) console.log(`Cancelled:${ord.cancelledAt}  reason: ${ord.cancelReason}`);
  console.log(`Delivery: ${ord.deliveryDate}   route: ${ord.routeName ?? "(none on order)"}`);
  console.log(`Stock:    stock_deducted = ${ord.stockDeducted}`);
  console.log(`Total:    ${money(grandTotal)}  (${ord.itemCount} lines)`);
  for (const it of items) {
    console.log(`   - ${it.quantity} x ${it.productName} [${it.code}]  ${money(parseFloat(it.lineTotal))}`);
  }

  // ── 2. State guards ──
  if (ord.status === "confirmed") {
    console.log("\nOrder is ALREADY confirmed - nothing to do.");
    await pgClient.end();
    return;
  }
  if (isRevive) {
    // Only the window-close worker's "unpaid at close" discard is revivable.
    // A dealer or admin cancel is a human decision - never undo it silently.
    if (ord.cancelReason !== AUTO_DISCARD_REASON) {
      await abort(
        `order was cancelled as "${ord.cancelReason}" - only an auto-discard ` +
        `("${AUTO_DISCARD_REASON}") is revived by this script`
      );
    }
    console.log(`\nThis is a REVIVE: the window-close worker discarded it as unpaid.`);
  } else if (!CONFIRMABLE.includes(ord.status)) {
    await abort(`cannot confirm an order in '${ord.status}' state`);
  }
  if (dealer.deletedAt) await abort("dealer is soft-deleted");
  if (!items.length || Number(ord.itemCount) === 0) await abort("order has no line items");

  // One live order per (dealer, delivery_date, route). A draft/payment_required
  // twin is superseded below; a placed one means this revive is the wrong fix
  // (that would be the re-home case - see the header).
  const liveTwins = (await pgClient`
    SELECT o.id::text AS id, o.status::text AS status,
           o.grand_total::numeric AS "grandTotal"
      FROM orders o JOIN orders w ON w.id = ${ORDER_ID}::uuid
     WHERE o.dealer_id = w.dealer_id
       AND o.delivery_date = w.delivery_date
       AND o.route_id IS NOT DISTINCT FROM w.route_id
       AND o.id <> w.id
       AND o.status NOT IN ('cancelled', 'draft', 'payment_required')
  `) as any[];
  if (liveTwins.length) {
    await abort(
      `dealer already has a PLACED order for ${ord.deliveryDate} on this route ` +
      `(${liveTwins.map((t) => t.id.slice(0, 8) + "/" + t.status).join(", ")}) - ` +
      `reviving this one would break one-live-order-per-date. Re-home the line ` +
      `onto that order instead (diag-rehome-subsidy-credit.ts).`
    );
  }

  // ── 3. Money guards ──
  const [existingDebit] = (await pgClient`
    SELECT id::text AS id, amount::numeric AS amount, created_at AS "createdAt"
      FROM dealer_ledger
     WHERE reference_id = ${ORDER_ID}::uuid
       AND reference_type = 'order' AND type = 'debit'
     LIMIT 1
  `) as any[];
  if (existingDebit) {
    await abort(
      `order already carries a wallet debit of ${money(parseFloat(existingDebit.amount))} ` +
      `(${existingDebit.createdAt}) - debiting again would double-charge`
    );
  }

  const [paid] = (await pgClient`
    SELECT id::text AS id, amount::numeric AS amount
      FROM razorpay_payments
     WHERE order_id = ${ORDER_ID}::uuid AND status = 'paid'
     LIMIT 1
  `) as any[];
  if (paid) {
    await abort(
      `order has a CAPTURED online payment of ${money(parseFloat(paid.amount))} - ` +
      `debiting the wallet as well would charge the dealer twice`
    );
  }

  const openAttempts = (await pgClient`
    SELECT razorpay_order_id AS "rzpOrderId", status::text AS status
      FROM razorpay_payments
     WHERE order_id = ${ORDER_ID}::uuid AND status NOT IN ('paid', 'failed')
  `) as any[];
  if (openAttempts.length) {
    console.log(
      `\nNOTE: ${openAttempts.length} un-captured online payment attempt(s) still on file ` +
      `(${openAttempts.map((a) => a.rzpOrderId + "/" + a.status).join(", ")}).`
    );
    console.log("  Left as-is so a genuinely-captured late payment can still reconcile.");
    console.log("  If one IS paid later it books as a receipt on the dealer's account,");
    console.log("  not a second charge on this order - but watch for it in reconciliation.");
  }

  // ── 4. Business gates (same order as the admin confirm route) ──
  const minQty = await findOrderMinQtyViolations(ORDER_ID);
  if (minQty.length > 0) {
    console.log(`\nWARNING (min order qty): ${minQtyErrorMessage(minQty)}`);
    console.log("  The dealer/admin UI would refuse this. Confirming anyway is an override.");
  }

  const shortfalls = await getOrderStockShortfalls(pgClient, ORDER_ID);
  if (shortfalls.length > 0) {
    await abort(`insufficient stock (FGS, ${ord.deliveryDate}): ${describeShortfalls(shortfalls)}`);
  }
  console.log(`\nStock gate: OK (FGS covers every line on ${ord.deliveryDate})`);

  const credit = await checkDealerCredit(dealer.id, grandTotal);
  console.log(
    `Wallet:     balance ${money(credit.available)}` +
    (credit.outstanding > 0 ? `  (outstanding ${money(credit.outstanding)})` : "") +
    (credit.creditInstitution ? "  [credit institution - balance gate waived]" : "")
  );
  if (!credit.sufficient) {
    await abort(
      `insufficient wallet balance - order ${money(grandTotal)} exceeds available ` +
      `${money(credit.available)} by ${money(credit.shortfall)}. Top up first.`
    );
  }

  // ── 5. Siblings this confirm will supersede ──
  const siblings = (await pgClient`
    SELECT o.id::text AS id, o.status::text AS status
      FROM orders o JOIN orders w ON w.id = ${ORDER_ID}::uuid
     WHERE o.dealer_id = w.dealer_id
       AND o.delivery_date = w.delivery_date
       AND o.route_id IS NOT DISTINCT FROM w.route_id
       AND o.id <> w.id
       AND o.status IN ('draft', 'payment_required')
       AND NOT EXISTS (SELECT 1 FROM razorpay_payments rp
                        WHERE rp.order_id = o.id AND rp.status = 'paid')
       AND NOT EXISTS (SELECT 1 FROM dealer_ledger dl
                        WHERE dl.reference_id = o.id
                          AND dl.reference_type = 'order' AND dl.type = 'debit')
  `) as any[];
  console.log(
    `Supersede:  ${siblings.length} same-day same-route twin(s)` +
    (siblings.length ? " -> " + siblings.map((s) => s.id.slice(0, 8) + "/" + s.status).join(", ") : "")
  );

  console.log("\nPLAN:");
  console.log(`  status        ${ord.status} -> confirmed` + (isRevive ? "  (cancelled_at + reason cleared)" : ""));
  console.log(`  payment_mode  ${ord.paymentMode ?? "-"} -> credit  (wallet settlement rail)`);
  console.log(`  wallet debit  ${money(grandTotal)}   balance after ${money(credit.available - grandTotal)}`);
  console.log(`  stock         ${ord.stockDeducted ? "already deducted (no-op)" : "deduct now (FGS-gated)"}`);
  console.log(`  cancel window ${isRevive ? "now() - the delivery window has already closed" : "LEAST(now+30m, route close)"}`);
  console.log(`  invoice       enqueue PDF generation`);

  if (!APPLY) {
    console.log("\n-- DRY RUN -- re-run with --apply to execute.");
    await pgClient.end();
    return;
  }

  // ── 6. APPLY (one transaction) ──
  let superseded: string[] = [];
  try {
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;

      // Re-lock and re-verify inside the tx: a live worker (auto-confirm)
      // mutates order state on this DB, so a read from above can be stale.
      const [lock] = (await tx`
        SELECT status::text AS status, cancellation_reason AS reason
          FROM orders WHERE id = ${ORDER_ID}::uuid FOR UPDATE
      `) as any[];
      const revivable =
        lock?.status === "cancelled" && lock?.reason === AUTO_DISCARD_REASON;
      if (!lock || !(CONFIRMABLE.includes(lock.status) || revivable)) {
        throw new Error(
          `order moved to '${lock?.status}' (${lock?.reason ?? "-"}) - aborting`
        );
      }
      const [dbt] = (await tx`
        SELECT 1 FROM dealer_ledger
         WHERE reference_id = ${ORDER_ID}::uuid
           AND reference_type = 'order' AND type = 'debit' LIMIT 1
      `) as any[];
      if (dbt) throw new Error("order already debited - aborting");
      const [cap] = (await tx`
        SELECT 1 FROM razorpay_payments
         WHERE order_id = ${ORDER_ID}::uuid AND status = 'paid' LIMIT 1
      `) as any[];
      if (cap) throw new Error("a captured online payment landed - aborting");

      // 1. Confirm (reviving if the worker had discarded it). Zero cancel
      //    grace on a revive: the window has closed, same rule the paid-order
      //    revive in dealer-payments.ts uses. The route's close_time is a
      //    CORRELATED SCALAR SUBQUERY, not a FROM-clause join: Postgres
      //    rejects a join that references the UPDATE target (42P01), and only
      //    at runtime.
      const confirmed = await tx`
        UPDATE orders
           SET status              = 'confirmed',
               payment_mode        = 'credit',
               payment_reference   = NULL,
               confirmed_at        = COALESCE(orders.confirmed_at, now()),
               cancelled_at        = NULL,
               cancellation_reason = NULL,
               updated_at          = now(),
               route_id            = COALESCE(orders.route_id, d.route_id),
               cancel_window_ends_at = LEAST(
                 now() + interval '30 minutes',
                 COALESCE(
                   (orders.delivery_date + (
                      SELECT tw.close_time FROM time_windows tw
                       WHERE tw.route_id = COALESCE(orders.route_id, d.route_id)
                       ORDER BY tw.close_time DESC LIMIT 1
                    )) AT TIME ZONE 'Asia/Kolkata',
                   now() + interval '30 minutes'
                 )
               )
         FROM dealers d
         WHERE orders.id = ${ORDER_ID}::uuid
           AND orders.dealer_id = d.id
        RETURNING orders.id
      `;
      if (confirmed.count !== 1) {
        throw new Error(`confirm UPDATE hit ${confirmed.count} rows - aborting`);
      }

      // 2. Wallet debit - recompute the running balance inside the tx.
      const [bal] = (await tx`
        SELECT
          COALESCE(d.opening_balance, 0)
          + COALESCE((SELECT SUM(CASE WHEN dl.type = 'credit'
                                       AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                      THEN dl.amount ELSE 0 END)
                        FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
          - COALESCE((SELECT SUM(CASE WHEN dl.type = 'debit'
                                       AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                      THEN dl.amount ELSE 0 END)
                        FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
          AS bal
        FROM dealers d WHERE d.id = ${ord.dealerId}::uuid
      `) as any[];
      const balanceAfter = parseFloat(bal!.bal) - grandTotal;

      await tx`
        INSERT INTO dealer_ledger
          (dealer_id, type, amount,
           reference_id, reference_type,
           voucher_type, voucher_date,
           description, balance_after)
        VALUES
          (${ord.dealerId}::uuid, 'debit', ${grandTotal.toFixed(2)}::numeric,
           ${ORDER_ID}::uuid, 'order',
           'Invoice', now()::date,
           ${"Standing-indent order " + ORDER_ID},
           ${balanceAfter.toFixed(2)}::numeric)
      `;

      // 3. Free stranded twins BEFORE the stock check (their reservation
      //    would otherwise double-count against this order).
      superseded = await cancelSupersededSiblings(tx, ORDER_ID);

      // 4. Physical stock last - its FGS guard is what can abort the confirm.
      await deductOrderStock(tx, ORDER_ID);
    });
  } catch (err: any) {
    if (err instanceof StockConflictError) {
      await abort(`insufficient stock at commit: ${describeShortfalls(err.shortfalls)}`);
    }
    console.error("\nERROR:", err?.message || err);
    await pgClient.end();
    process.exit(1);
  }
  if (superseded.length) console.log("  superseded:", superseded.join(", "));

  // Invoice, same queue every other confirm path uses.
  await enqueuePDFInvoice(ORDER_ID);

  // ── 7. Verify ──
  const [after] = (await pgClient`
    SELECT status::text AS status, payment_mode::text AS "paymentMode",
           confirmed_at AS "confirmedAt", stock_deducted AS "stockDeducted",
           cancelled_at AS "cancelledAt", cancellation_reason AS "cancelReason",
           cancel_window_ends_at AS "cancelWindow", route_id::text AS "routeId"
      FROM orders WHERE id = ${ORDER_ID}::uuid
  `) as any[];
  const [led] = (await pgClient`
    SELECT amount::numeric AS amount, balance_after::numeric AS "balanceAfter",
           created_at AS "createdAt"
      FROM dealer_ledger
     WHERE reference_id = ${ORDER_ID}::uuid AND reference_type = 'order' AND type = 'debit'
     LIMIT 1
  `) as any[];
  const [job] = (await pgClient`
    SELECT id::text AS id, status::text AS status FROM background_jobs
     WHERE queue = 'pdf-invoice' AND data->>'orderId' = ${ORDER_ID}
     ORDER BY created_at DESC LIMIT 1
  `) as any[];
  const walletAfter = await checkDealerCredit(ord.dealerId, 0);

  console.log("\nDONE.");
  console.log(`  status ${after?.status}   payment_mode ${after?.paymentMode}   stock_deducted ${after?.stockDeducted}`);
  console.log(`  cancelled_at ${after?.cancelledAt ?? "cleared"}   reason ${after?.cancelReason ?? "cleared"}`);
  console.log(`  confirmed_at ${after?.confirmedAt}`);
  console.log(`  cancel window ends ${after?.cancelWindow}`);
  console.log(`  wallet debit ${led ? money(parseFloat(led.amount)) : "MISSING"}  balance_after ${led ? money(parseFloat(led.balanceAfter)) : "-"}`);
  console.log(`  wallet balance now ${money(walletAfter.available)}`);
  console.log(`  invoice job ${job ? job.id.slice(0, 8) + " (" + job.status + ")" : "NOT ENQUEUED"}`);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
