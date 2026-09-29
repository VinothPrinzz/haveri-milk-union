// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/routes/dealer-payments.ts  —  BUILD-FIXED VERSION
//
// FIXES vs the previous version:
//   1. CRITICAL: `pgClient.begin` callback now casts the transaction
//      handle (`const tx = _tx as unknown as typeof pgClient`) — the
//      postgres lib's TransactionSql type drops the tagged-template
//      call signature, so `tx`...`` was a TYPE ERROR that failed the
//      whole `tsc` build.
//   2. The `addContentTypeParser("application/json", ...)` call is
//      now guarded with `hasContentTypeParser` so it can never throw
//      FST_ERR_CTP_ALREADY_PRESENT and crash the server on boot.
//   3. The webhook degrades gracefully when rawBody is unavailable
//      (the synchronous /verify endpoints are the primary path).
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { dealerAuth } from "../middleware/dealer-auth.js";
import {
  createRazorpayOrder,
  getRazorpayKeyId,
  isRazorpayConfigured,
  verifyPaymentSignature,
  verifyWebhookSignature,
  fetchRazorpayPayment,
  captureRazorpayPayment,
} from "../lib/razorpay-client.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";
import {
  deductOrderStockCapped,
  describeShortfalls,
  restoreOrderStock,
} from "../lib/stock-check.js";
import { enqueuePDFInvoice } from "../lib/queue.js";
import { reissueDirectSaleInvoiceIfExists } from "../lib/invoice-pdf.js";
import { getDealerRouteId, NO_ROUTE_RESPONSE } from "../lib/dealer-route.js";
import {
  cancelSupersededSiblings,
  SUPERSEDE_REASON_PREFIX,
} from "../lib/supersede-orders.js";

// ── Helpers ─────────────────────────────────────────────────────────

function getDealerId(request: FastifyRequest): string {
  const d = (request as unknown as { dealer?: { dealerId: string } }).dealer;
  if (!d?.dealerId) throw new Error("dealerAuth middleware not set");
  return d.dealerId;
}

function require503IfUnconfigured(reply: any): boolean {
  if (!isRazorpayConfigured()) {
    reply.status(503).send({
      error: "Service unavailable",
      message: "Online payments are not enabled. Please contact support.",
    });
    return true;
  }
  return false;
}

/**
 * Confirm with Razorpay that a payment actually reached 'captured'
 * (money taken), capturing it first if it is only 'authorized'.
 *
 * The checkout signature only proves the (order_id, payment_id) pair is
 * authentic — it does NOT prove the payment succeeded. Without this
 * check an authorized-but-uncaptured payment (the default when the
 * account is in manual-capture mode) flips the order to 'confirmed'
 * even though no money was settled, and Razorpay later auto-voids it.
 *
 * Returns `{ ok: true }` only when the payment is genuinely captured for
 * the right order and amount.
 *
 * On failure, `indeterminate` distinguishes the two very different cases the
 * caller must NOT conflate:
 *   • indeterminate: false — Razorpay gave a definitive negative answer
 *     (payment failed/refunded, wrong order, amount mismatch). The money is
 *     NOT ours; it is safe to mark the row 'failed' and tell the dealer.
 *   • indeterminate: true  — we could NOT get a definitive answer (the fetch
 *     timed out, the network dropped, or the payment is authorized-but-not-
 *     yet-captured). The money MAY have been taken. Do NOT mark 'failed'
 *     (that hides the row from the reconcile sweep and wrongly tells the
 *     dealer the payment failed); leave it recoverable for the webhook /
 *     reconciliation job to resolve.
 */
export async function ensureCaptured(opts: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  expectedAmountPaise: number;
}): Promise<
  | { ok: true }
  | { ok: false; indeterminate: boolean; status: string; message: string }
> {
  let payment;
  try {
    payment = await fetchRazorpayPayment(opts.razorpayPaymentId);
  } catch {
    // Could not reach Razorpay to confirm — this is NOT proof of failure.
    return {
      ok: false,
      indeterminate: true,
      status: "unknown",
      message: "Could not verify payment status with Razorpay",
    };
  }

  // The payment must belong to the order we created and match its amount.
  // These are definitive Razorpay answers — this payment is not the one we
  // are trying to settle — so they are NOT indeterminate.
  if (payment.order_id && payment.order_id !== opts.razorpayOrderId) {
    return {
      ok: false,
      indeterminate: false,
      status: payment.status,
      message: "Payment does not belong to this order",
    };
  }
  if (payment.amount !== opts.expectedAmountPaise) {
    return {
      ok: false,
      indeterminate: false,
      status: payment.status,
      message: "Payment amount does not match the order",
    };
  }

  if (payment.status === "captured") return { ok: true };

  if (payment.status === "authorized") {
    try {
      const cap = await captureRazorpayPayment(
        opts.razorpayPaymentId,
        opts.expectedAmountPaise,
        payment.currency || "INR"
      );
      if (cap.status === "captured") return { ok: true };
      // Capture returned but the money is still only authorized/held —
      // reconcile can re-capture it, so keep the row recoverable.
      return {
        ok: false,
        indeterminate: true,
        status: cap.status,
        message: "Payment could not be captured",
      };
    } catch (e) {
      // The capture call itself failed (network/timeout). The money is at
      // least authorized and may even be captured — do not declare failure.
      return {
        ok: false,
        indeterminate: true,
        status: "authorized",
        message:
          e instanceof Error ? e.message : "Payment capture failed",
      };
    }
  }

  // created / failed / refunded / etc. — never treat as paid. Only a
  // definitive 'failed'/'refunded' is a genuine dead end; anything else
  // (e.g. still 'created') might yet settle, so keep it recoverable.
  const definitivelyDead =
    payment.status === "failed" || payment.status === "refunded";
  return {
    ok: false,
    indeterminate: !definitivelyDead,
    status: payment.status,
    message:
      payment.error_description ?? `Payment is ${payment.status}, not captured`,
  };
}

// The worker's auto-discard reason for unpaid online orders at window close
// (mirror of the literal in apps/worker/src/jobs/auto-confirm-drafts.ts —
// keep the two in sync). confirmPaidOrder uses it to recognise — and revive —
// a paid order that the worker discarded before the payment finished applying.
export const AUTO_DISCARD_REASON =
  "Online payment not completed before window close";

// The app cancels an order the moment its online payment attempt ends
// without success (sheet dismissed / payment failed) — there is no
// "awaiting payment" limbo for the dealer to come back to. Like
// AUTO_DISCARD_REASON this is a SYSTEM cancel that can race a capture, so
// confirmPaidOrder treats it as revivable: a payment that lands late (via
// the webhook or the reconcile sweep) reinstates the order rather than
// leaving the dealer paid with nothing placed.
export const ABANDONED_PAYMENT_REASON =
  "Online payment not completed - indent cancelled";

/**
 * Cancel an indent whose online payment failed or was never completed, and
 * give back the stock it latched. Returns true only if THIS call cancelled
 * it (already-cancelled / already-placed → false, never an error).
 *
 * Called from every point where an online payment is known to be over
 * without money: the app when the Razorpay sheet is dismissed or errors,
 * /pay-now/verify when the gateway definitively says "not captured", and
 * the payment.failed webhook (the only signal left when the app is gone).
 *
 * NEVER cancels an order that has money against it: the UPDATE itself
 * requires no 'paid' razorpay_payments row and no order debit, so a
 * capture that is still settling is left alone. A capture that lands AFTER
 * the cancel is recovered — confirmPaidOrder revives the order on
 * ABANDONED_PAYMENT_REASON, exactly as it does for the worker's
 * window-close discard, and the reconcile sweep looks for it too. That is
 * also what makes cancelling on payment.failed safe when the dealer
 * retries a second attempt inside the same Razorpay sheet and it succeeds.
 *
 * Caller is responsible for authorising the cancel (the dealer route
 * checks ownership first); the webhook and verify paths already hold the
 * order via its own razorpay_payments row.
 */
export async function cancelUnpaidOrder(orderId: string): Promise<boolean> {
  return await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    const rows = await tx`
      UPDATE orders o
         SET status = 'cancelled',
             cancellation_reason = ${ABANDONED_PAYMENT_REASON},
             cancelled_at = now(),
             updated_at = now()
       WHERE o.id = ${orderId}::uuid
         AND o.status IN ('draft', 'payment_required')
         AND NOT EXISTS (
               SELECT 1 FROM razorpay_payments rp
                WHERE rp.order_id = o.id AND rp.status = 'paid'
             )
         AND NOT EXISTS (
               SELECT 1 FROM dealer_ledger dl
                WHERE dl.reference_id = o.id
                  AND dl.reference_type = 'order'
                  AND dl.type = 'debit'
             )
      RETURNING o.id::text AS id
    `;
    if (rows.count === 0) return false;
    // A cart-UPI order latches its stock at creation. Guarded on
    // stock_deducted, so an order that never deducted is a no-op and a
    // second call can never restore twice.
    await restoreOrderStock(tx, orderId);
    return true;
  });
}

/**
 * Flip a paid-for order to 'confirmed' (idempotent) and deduct its stock.
 *
 * Never assume the guarded UPDATE hit a row: order HMU-2A9B
 * (pay_T9JpSPmjHL5BBW) had its receipt committed while this confirm matched
 * 0 rows, stayed 'payment_required', and was auto-discarded at window close
 * as "unpaid" — with the dealer's ₹4,846 captured. So the row count is now
 * checked and every miss is handled explicitly:
 *   • already confirmed/dispatched/delivered → fine, another path won
 *   • cancelled by the worker's unpaid-at-close discard → REVIVE it (the
 *     money was captured; the discard raced the payment)
 *   • anything else → ERROR log; finance must refund or reinstate by hand
 */
async function confirmPaidOrder(
  tx: typeof pgClient,
  orderId: string,
  rzpPaymentId: string
): Promise<void> {
  // cancel_window_ends_at = LEAST(now + 30 min, route's close_time for the
  // delivery date). Same rule as the credit-confirm path so online-paid
  // orders are cancellable for the same window.
  const confirmed = await tx`
    UPDATE orders
       SET status = 'confirmed',
           payment_mode = 'upi',
           payment_reference = ${rzpPaymentId},
           confirmed_at = COALESCE(confirmed_at, now()),
           updated_at = now(),
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
     WHERE orders.id = ${orderId}::uuid
       AND orders.dealer_id = d.id
       AND orders.status IN ('draft', 'payment_required')
    RETURNING orders.id
  `;

  if (confirmed.count === 0) {
    const [ord] = await tx`
      SELECT status::text AS status, cancellation_reason AS reason
        FROM orders WHERE id = ${orderId}::uuid
    `;
    if (!ord) {
      console.error(
        `[apply-payment] captured payment ${rzpPaymentId} references missing order ${orderId}`
      );
      return;
    }
    if (["confirmed", "dispatched", "delivered"].includes(ord.status)) {
      return; // another path already confirmed it — nothing to do
    }
    const autoCancelled =
      ord.status === "cancelled" &&
      (ord.reason === AUTO_DISCARD_REASON ||
        ord.reason === ABANDONED_PAYMENT_REASON ||
        (ord.reason ?? "").startsWith(SUPERSEDE_REASON_PREFIX));
    if (autoCancelled) {
      // A system cancel raced the payment: either the window-close worker
      // discarded it as "unpaid", or the supersede rule cancelled it as a
      // twin — in both cases BEFORE the capture landed. Money is captured,
      // so the order stands — reinstate it. Zero cancel grace: the
      // window/day has moved on, same as worker auto-confirms.
      const revived = await tx`
        UPDATE orders
           SET status = 'confirmed',
               payment_mode = 'upi',
               payment_reference = ${rzpPaymentId},
               confirmed_at = COALESCE(confirmed_at, now()),
               cancelled_at = NULL,
               cancellation_reason = NULL,
               cancel_window_ends_at = now(),
               updated_at = now()
         WHERE id = ${orderId}::uuid
           AND status = 'cancelled'
           AND cancellation_reason = ${ord.reason}
        RETURNING id
      `;
      if (revived.count > 0) {
        console.warn(
          `[apply-payment] revived order ${orderId}: it was cancelled (${ord.reason}) but payment ${rzpPaymentId} WAS captured`
        );
      }
    } else {
      // Cancelled by the dealer/admin (or some unexpected state) with money
      // captured — never swallow that silently. Finance must refund/resolve.
      console.error(
        `[apply-payment] ORDER NOT CONFIRMED: order ${orderId} is '${ord.status}' ` +
          `but payment ${rzpPaymentId} is captured — needs manual review (refund or reinstate)`
      );
      return;
    }
  }

  // Move physical stock now that the order is confirmed. Money is
  // already captured, so we never block here — deduct capped at 0
  // (never negative) and log any oversell for ops. Idempotent: the
  // cart path that deducted at creation already set the latch, so a
  // cart-UPI order is a no-op here (no double-deduct).
  const oversold = await deductOrderStockCapped(tx, orderId);
  if (oversold.length > 0) {
    console.warn(
      `[pay-now] order ${orderId} oversold (paid, stock capped at 0): ` +
        describeShortfalls(oversold)
    );
  }

  // The paid order is now the day's placed order — cancel any stranded
  // twin (duplicate draft / unpaid payment_required) for the same date.
  await cancelSupersededSiblings(tx, orderId);
}

export interface ApplyPaidPaymentResult {
  alreadyApplied: boolean;
  dealerId: string;
  kind: "credit_topup" | "order_payment" | "gate_pass";
  amount: number;
  orderId: string | null;
  /** Set only for kind='gate_pass'. */
  directSaleId: string | null;
}

/**
 * Apply a verified Razorpay payment to internal tables. Idempotent —
 * checks the payments table before inserting.
 */
export async function applyPaidPayment(
  rzpRowId: string
): Promise<ApplyPaidPaymentResult> {
  // Gate-pass counter payments (migration 0068) share this table but not
  // this code path: they book a `payments` receipt and stamp the sale, and
  // never write a dealer_ledger credit — the sale is already billed at its
  // grand_total in direct_sales, so crediting the agent's balance too would
  // hand him money he never paid. Dispatch here rather than at each call
  // site so the webhook, the reconciliation job and the diag scripts stay
  // unaware.
  const [kindRow] = await pgClient`
    SELECT kind::text AS kind
      FROM razorpay_payments
     WHERE id = ${rzpRowId}::uuid
  `;
  if (kindRow?.kind === "gate_pass") {
    return applyPaidGatePassPayment(rzpRowId);
  }

  const result = await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    const [row] = await tx`
      SELECT id, dealer_id::text AS "dealerId", kind::text AS kind,
             amount::numeric AS amount, order_id::text AS "orderId",
             status::text AS status, razorpay_payment_id AS "rzpPaymentId"
        FROM razorpay_payments
       WHERE id = ${rzpRowId}::uuid
       FOR UPDATE
    `;

    if (!row) throw new Error(`razorpay_payments row ${rzpRowId} not found`);
    if (row.status !== "paid") {
      throw new Error(
        `razorpay_payments row ${rzpRowId} is ${row.status}, expected 'paid'`
      );
    }

    const [existing] = await tx`
      SELECT id FROM payments
       WHERE reference = ${row.rzpPaymentId}
         AND mode = 'upi'
       LIMIT 1
    `;

    if (existing) {
      // The receipt is already booked — but the ORDER may still be stuck.
      // HMU-2A9B: the receipt committed while the confirm matched 0 rows, and
      // every retry (webhook, reconcile) then short-circuited HERE, so nothing
      // could ever heal the order and the worker discarded it as unpaid.
      // The confirm is idempotent, so always give the order another chance to
      // advance before declaring this apply a no-op.
      if (row.kind === "order_payment" && row.orderId) {
        await confirmPaidOrder(tx, row.orderId, row.rzpPaymentId);
      }
      return {
        alreadyApplied: true,
        dealerId: row.dealerId,
        kind: row.kind as any,
        amount: parseFloat(row.amount),
        orderId: row.orderId,
        directSaleId: null,
      };
    }

    const amount = parseFloat(row.amount);

    // === FIX C: Decide whether to write ledger credit ===
    let writeLedgerCredit = row.kind === "credit_topup";

    if (row.kind === "order_payment" && row.orderId) {
      // Only post credit if this order was previously placed on credit
      // (i.e., has a matching debit entry)
      const [debit] = await tx`
        SELECT 1 FROM dealer_ledger
         WHERE reference_type = 'order' 
           AND reference_id = ${row.orderId}::uuid
           AND type = 'debit' 
         LIMIT 1
      `;
      writeLedgerCredit = !!debit;
    }

    // === Insert Payment (always done) ===
    const [paymentRow] = await tx`
      INSERT INTO payments (
        dealer_id, received_date, amount, mode, reference
      ) VALUES (
        ${row.dealerId}::uuid,
        (now() AT TIME ZONE 'Asia/Kolkata')::date,
        ${amount.toFixed(2)}::numeric,
        'upi',
        ${row.rzpPaymentId}
      )
      RETURNING id
    `;

    // === Insert Ledger Credit (only when appropriate) ===
    if (writeLedgerCredit) {
      // Calculate correct balance_after
      const [bal] = await tx`
        SELECT COALESCE(d.opening_balance, 0)
             + COALESCE((
                 SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                                 WHEN dl.type = 'debit'  THEN -dl.amount END)
                   FROM dealer_ledger dl
                  WHERE dl.dealer_id = d.id
                    AND COALESCE(dl.voucher_type, '') <> 'Opening'
               ), 0) AS bal
          FROM dealers d
         WHERE d.id = ${row.dealerId}::uuid
      `;

      const balanceAfter = parseFloat(bal!.bal) + amount;

      const description =
        row.kind === "credit_topup"
          ? `Razorpay top-up via app (${row.rzpPaymentId})`
          : `Razorpay payment for order (${row.rzpPaymentId})`;

      const refType: string =
        row.kind === "credit_topup" ? "wallet_topup" : "order";

      await tx`
        INSERT INTO dealer_ledger (
          dealer_id, type, amount,
          reference_id, reference_type,
          description, balance_after,
          voucher_no, voucher_type, particulars, voucher_date
        ) VALUES (
          ${row.dealerId}::uuid, 'credit',
          ${amount.toFixed(2)}::numeric,
          ${paymentRow!.id}::uuid,
          ${refType}::ledger_ref_type,
          ${description},
          ${balanceAfter.toFixed(2)}::numeric,
          ${`RP-${String(row.rzpPaymentId).slice(-8).toUpperCase()}`},
          'Receipt', ${description},
          (now() AT TIME ZONE 'Asia/Kolkata')::date
        )
      `;
    }

    // === Update Order Status (always done for order_payment) ===
    // confirmPaidOrder verifies the confirm actually landed (row count),
    // revives a wrongly auto-discarded order, and deducts stock — never
    // assume the guarded UPDATE hit a row (see the HMU-2A9B incident).
    if (row.kind === "order_payment" && row.orderId) {
      await confirmPaidOrder(tx, row.orderId, row.rzpPaymentId);
    }

    return {
      alreadyApplied: false,
      dealerId: row.dealerId,
      kind: row.kind as any,
      amount,
      orderId: row.orderId,
      directSaleId: null,
    };
  });

  // Online-paid orders need an invoice row so they appear in the admin
  // "all invoices" list — the credit-confirm and cart paths already
  // enqueue one. Fire after commit; a failure here must never fail the
  // payment (the on-demand /invoices/by-order path is still a fallback).
  if (!result.alreadyApplied && result.kind === "order_payment" && result.orderId) {
    try {
      await enqueuePDFInvoice(result.orderId);
    } catch (err) {
      console.warn("[pay-now] invoice enqueue failed:", err);
    }
  }

  return result;
}

/**
 * Apply a paid gate-pass counter QR payment (migration 0068).
 *
 * The entire internal effect is stamping the reference onto the sale —
 * the sale itself was already booked at its grand_total in direct_sales
 * when the operator saved it, so there is nothing to post. This replaces
 * the UPI reference the operator used to type by hand.
 *
 * Idempotent via a guarded UPDATE: re-delivery of the same webhook
 * matches the already-stamped reference and changes nothing.
 *
 * The sale's invoice is reissued afterwards, outside the transaction. A gate
 * pass is invoiced the moment it is raised, which for the QR path is BEFORE
 * the customer scans — so the invoice minted there says unpaid. Without this
 * it would stay that way for good: it would read NOT PAID on screen and age
 * in AR Aging as a receivable that was in fact collected at the counter.
 */
export async function applyPaidGatePassPayment(
  rzpRowId: string
): Promise<ApplyPaidPaymentResult> {
  const result = await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    const [row] = await tx`
      SELECT id,
             dealer_id::text       AS "dealerId",
             direct_sale_id::text  AS "directSaleId",
             amount::numeric       AS amount,
             status::text          AS status,
             razorpay_payment_id   AS "rzpPaymentId",
             -- Resolved to an IST date STRING here, never handed back as a
             -- Date: postgres.js cannot serialize a JS Date into an
             -- explicitly cast timestamptz bind parameter and throws at Bind,
             -- which inside this transaction would roll the whole apply back.
             to_char(COALESCE(paid_at, now()) AT TIME ZONE 'Asia/Kolkata',
                     'YYYY-MM-DD') AS "receivedDate"
        FROM razorpay_payments
       WHERE id = ${rzpRowId}::uuid
       FOR UPDATE
    `;

    if (!row) throw new Error(`razorpay_payments row ${rzpRowId} not found`);
    if (row.status !== "paid") {
      throw new Error(
        `razorpay_payments row ${rzpRowId} is ${row.status}, expected 'paid'`
      );
    }
    if (!row.directSaleId) {
      throw new Error(
        `razorpay_payments row ${rzpRowId} is kind='gate_pass' but has no direct_sale_id`
      );
    }
    if (!row.rzpPaymentId) {
      throw new Error(
        `razorpay_payments row ${rzpRowId} is paid but carries no razorpay_payment_id`
      );
    }

    const amount = parseFloat(row.amount);

    const [sale] = await tx`
      SELECT id,
             gp_no                AS "gpNo",
             grand_total::numeric AS "grandTotal",
             payment_ref          AS "paymentRef",
             status::text         AS status
        FROM direct_sales
       WHERE id = ${row.directSaleId}::uuid
       FOR UPDATE
    `;
    if (!sale) {
      throw new Error(
        `direct_sale ${row.directSaleId} not found for razorpay row ${rzpRowId}`
      );
    }

    // Money against a CANCELLED sale should be impossible — cancelling closes
    // the live QR at Razorpay first, precisely so nothing can still be
    // scanned. If it happens anyway (a scan that raced the close), the money
    // is already taken: record it and shout, never block.
    if ((sale as any).status === "cancelled") {
      console.error(
        `[gate-pass-qr] PAYMENT ON CANCELLED SALE: ${row.directSaleId} was cancelled but ` +
          `payment ${row.rzpPaymentId} (Rs.${amount.toFixed(2)}) was credited — refund it by hand`
      );
    }

    // A sale may legitimately take MORE THAN ONE payment: raising an
    // already-paid gate pass on the modify screen mints a balance QR for the
    // difference (see the mint endpoint's `isTopUp`). So the test is no
    // longer "does this payment equal the sale total" but "does everything
    // collected still fit inside it". Money is already taken by the time
    // this runs, so an overshoot is never blocked — it is surfaced for
    // finance to settle.
    const saleTotal = parseFloat(sale.grandTotal);
    const [collectedRow] = await tx`
      SELECT COALESCE(SUM(rp.amount - rp.amount_refunded), 0)::float8 AS collected
        FROM razorpay_payments rp
       WHERE rp.direct_sale_id = ${row.directSaleId}::uuid
         AND rp.kind = 'gate_pass'
         AND rp.status IN ('paid', 'refunded')
    `;
    const collected = Number((collectedRow as any)?.collected ?? 0);

    if (collected - saleTotal > 0.001) {
      console.error(
        `[gate-pass-qr] OVERPAID: sale ${row.directSaleId} totals ` +
          `Rs.${saleTotal.toFixed(2)} but Rs.${collected.toFixed(2)} has been ` +
          `collected (latest payment ${row.rzpPaymentId}, Rs.${amount.toFixed(2)}) — ` +
          `refund the difference or reconcile by hand`
      );
    }

    // ── Book the receipt ──
    // Every other Razorpay rail writes a `payments` row the moment it
    // captures (see the order path above); the gate-pass rail never did, so
    // Rs.20,657 of counter UPI collections across 15 passes sat in
    // razorpay_payments alone and showed nowhere in Payments Overview, which
    // reads `payments` and nothing else. The receipt is the money; the
    // reference stamp below is only a label on the sale.
    //
    // Keyed on the gateway payment id, which is unique per capture, so the
    // webhook, the counter screen's poll and the reconcile job can all call
    // this and only the first books it. A balance top-up on an edited pass
    // carries its OWN payment id and is therefore a second, correct receipt.
    const [alreadyBooked] = await tx`
      SELECT id FROM payments
       WHERE reference = ${row.rzpPaymentId} AND mode = 'upi'
       LIMIT 1
    `;
    //
    // invoice_id is deliberately LEFT NULL, exactly as the order rail's
    // Razorpay insert leaves it. invoice-settlement.ts counts a `payments`
    // row twice when it carries both a gateway reference and an invoice link:
    // once in rail 1 (matched on payments.reference) and again in rail 3
    // (matched on payments.invoice_id). The gate pass number goes in `notes`
    // instead, so the receipt is still readable on Payments Overview without
    // creating that trap. recordCounterCashReceipt escapes it only because a
    // cash pass has no payment_ref for rail 1 to match.
    if (!alreadyBooked) {
      await tx`
        INSERT INTO payments
          (dealer_id, received_date, amount, mode, reference, notes)
        VALUES (
          ${row.dealerId}::uuid,
          ${String((row as any).receivedDate)}::date,
          ${amount.toFixed(2)}::numeric,
          'upi',
          ${row.rzpPaymentId},
          ${`Counter UPI for gate pass ${(sale as any).gpNo ?? row.directSaleId}`}
        )
      `;
    }

    // Stamp the sale's reference. The FIRST payment's reference is the one
    // every downstream report reads, so a later balance top-up leaves it
    // alone rather than overwriting it — the individual payments are all on
    // razorpay_payments, keyed to this sale.
    const stamped = await tx`
      UPDATE direct_sales
         SET payment_mode = 'upi'::payment_mode,
             payment_ref  = ${row.rzpPaymentId},
             updated_at   = now()
       WHERE id = ${row.directSaleId}::uuid
         AND (payment_ref IS NULL OR payment_ref = ${row.rzpPaymentId})
      RETURNING id
    `;

    if (stamped.length === 0) {
      console.info(
        `[gate-pass-qr] balance payment ${row.rzpPaymentId} (Rs.${amount.toFixed(2)}) ` +
          `applied to sale ${row.directSaleId}, which already carries reference ` +
          `'${sale.paymentRef}'. Collected Rs.${collected.toFixed(2)} of Rs.${saleTotal.toFixed(2)}.`
      );
    }

    return {
      alreadyApplied: stamped.length === 0 || sale.paymentRef === row.rzpPaymentId,
      dealerId: row.dealerId,
      kind: "gate_pass" as const,
      amount,
      orderId: null,
      directSaleId: row.directSaleId,
    };
  });

  // Re-read the money rails onto the invoice now the capture is committed.
  // Never throws and no-ops when the sale was never invoiced; the number and
  // the legal issue date survive untouched.
  if (result.directSaleId) {
    await reissueDirectSaleInvoiceIfExists(result.directSaleId);
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════

export async function dealerPaymentsRoutes(app: FastifyInstance) {
  // Webhook raw-body capture — GUARDED so it never throws
  // FST_ERR_CTP_ALREADY_PRESENT. In practice Fastify already has a
  // JSON parser, so this is usually a no-op and the webhook degrades
  // gracefully (see the handler below). To fully enable the webhook,
  // register a raw-body JSON parser at the server level instead.
  // DELETE this whole block — the server-level parser handles it now:
  if (!app.hasContentTypeParser("application/json")) {
    app.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (_req, body, done) => { /* ... */ }
    );
  }

  // ── POST /api/v1/dealer/credit-topup/order ──
  app.post(
    "/api/v1/dealer/credit-topup/order",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      if (require503IfUnconfigured(reply)) return;
      const dealerId = getDealerId(request);

      const body = z
        .object({ amount: z.number().int().min(1).max(500_000) })
        .parse(request.body);

      const [dealer] = await pgClient`
        SELECT code FROM dealers WHERE id = ${dealerId}::uuid
      `;
      const receipt = `topup-${dealer?.code ?? dealerId.slice(0, 8)}-${Date.now()}`;

      const rzpOrder = await createRazorpayOrder({
        amountInRupees: body.amount,
        receipt,
        notes: {
          dealerId,
          dealerCode: dealer?.code ?? "",
          kind: "credit_topup",
        },
      });

      await pgClient`
        INSERT INTO razorpay_payments (
          dealer_id, razorpay_order_id, amount, currency,
          kind, status, notes
        ) VALUES (
          ${dealerId}::uuid, ${rzpOrder.id},
          ${body.amount.toFixed(2)}::numeric, 'INR',
          'credit_topup', 'created',
          ${JSON.stringify({ receipt })}::jsonb
        )
      `;

      return reply.status(201).send({
        razorpayOrderId: rzpOrder.id,
        amount: body.amount,
        amountPaise: rzpOrder.amount,
        currency: rzpOrder.currency,
        keyId: getRazorpayKeyId(),
      });
    }
  );

  // ── POST /api/v1/dealer/credit-topup/verify ──
  app.post(
    "/api/v1/dealer/credit-topup/verify",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      if (require503IfUnconfigured(reply)) return;
      const dealerId = getDealerId(request);

      const body = z
        .object({
          razorpayOrderId: z.string().min(1),
          razorpayPaymentId: z.string().min(1),
          razorpaySignature: z.string().min(1),
        })
        .parse(request.body);

      if (!verifyPaymentSignature(body)) {
        return reply.status(400).send({
          error: "Invalid signature",
          message: "Payment signature could not be verified",
        });
      }

      const [row] = await pgClient`
        SELECT id::text, kind::text, dealer_id::text AS "dealerId", status::text,
               amount::numeric AS amount
          FROM razorpay_payments
         WHERE razorpay_order_id = ${body.razorpayOrderId}
         LIMIT 1
      `;
      if (!row) return reply.status(404).send({ error: "Payment not found" });
      if (row.dealerId !== dealerId)
        return reply.status(403).send({ error: "Forbidden" });
      if (row.kind !== "credit_topup") {
        return reply.status(400).send({
          error: "Wrong endpoint",
          message: "This razorpay order is not a credit-topup",
        });
      }

      // Signature only proves authenticity — confirm the money was
      // actually captured before crediting the dealer's ledger.
      const capture = await ensureCaptured({
        razorpayOrderId: body.razorpayOrderId,
        razorpayPaymentId: body.razorpayPaymentId,
        expectedAmountPaise: Math.round(parseFloat(row.amount) * 100),
      });
      if (!capture.ok) {
        if (capture.indeterminate) {
          // Couldn't get a definitive answer from Razorpay (timeout / network
          // / authorized-not-yet-captured). The money may have been taken, so
          // DON'T mark the row 'failed' — that would both hide it from the
          // reconciliation sweep and wrongly tell the dealer the payment
          // failed. Record the reason, leave the row recoverable, and return a
          // 'pending' signal. The webhook or the reconcile job will confirm it
          // within minutes if the capture really happened.
          await pgClient`
            UPDATE razorpay_payments
               SET razorpay_payment_id = COALESCE(razorpay_payment_id, ${body.razorpayPaymentId}),
                   error_description = ${capture.message},
                   updated_at = now()
             WHERE id = ${row.id}::uuid
               AND status IN ('created', 'attempted')
          `;
          return reply.status(202).send({
            status: "pending",
            pending: true,
            message:
              "We couldn't confirm your payment instantly. If the amount was debited, it will be credited automatically within a few minutes.",
            paymentStatus: capture.status,
          });
        }
        // Definitive failure — Razorpay says the payment failed / was refunded
        // / doesn't match. Safe to mark the row failed and tell the dealer.
        await pgClient`
          UPDATE razorpay_payments
             SET status = 'failed',
                 razorpay_payment_id = COALESCE(razorpay_payment_id, ${body.razorpayPaymentId}),
                 error_description = ${capture.message},
                 updated_at = now()
           WHERE id = ${row.id}::uuid
             AND status IN ('created', 'attempted')
        `;
        return reply.status(402).send({
          error: "Payment not captured",
          message: capture.message,
          paymentStatus: capture.status,
        });
      }

      // Include 'failed' in the guard: a Razorpay order can have multiple
      // payment attempts. If an earlier attempt's payment.failed webhook
      // already flipped this (single, per-order) row to 'failed', a later
      // successful retry must still be able to recover it. Capture is
      // independently proven by ensureCaptured() above, and we overwrite
      // razorpay_payment_id with the CAPTURED id, so this is safe.
      await pgClient`
        UPDATE razorpay_payments
           SET status = 'paid',
               razorpay_payment_id = ${body.razorpayPaymentId},
               razorpay_signature  = ${body.razorpaySignature},
               paid_at = COALESCE(paid_at, now()),
               updated_at = now()
         WHERE id = ${row.id}::uuid
           AND status IN ('created', 'attempted', 'failed')
      `;

      const applied = await applyPaidPayment(row.id);
      return reply.send({
        ok: true,
        alreadyApplied: applied.alreadyApplied,
        amount: applied.amount,
      });
    }
  );

  // ── POST /api/v1/dealer/orders/:id/pay-now ──
  app.post(
    "/api/v1/dealer/orders/:id/pay-now",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      if (require503IfUnconfigured(reply)) return;
      const dealerId = getDealerId(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);

      const [order] = await pgClient`
        SELECT id::text, dealer_id::text AS "dealerId",
               status::text AS status, grand_total::numeric AS "grandTotal",
               delivery_date::text AS "deliveryDate"
          FROM orders
         WHERE id = ${params.id}::uuid
         LIMIT 1
      `;
      if (!order) return reply.status(404).send({ error: "Order not found" });
      if (order.dealerId !== dealerId)
        return reply.status(403).send({ error: "Forbidden" });
      // No delivery route ⇒ order is undeliverable; don't take a payment for it.
      if (!(await getDealerRouteId(dealerId))) {
        return reply.status(403).send(NO_ROUTE_RESPONSE);
      }
      if (!["draft", "payment_required"].includes(order.status)) {
        return reply.status(400).send({
          error: "Order not payable",
          message: `Order is in ${order.status} state; pay-now only works for draft or payment_required orders.`,
        });
      }

      const amount = parseFloat(order.grandTotal);
      const [dealer] = await pgClient`
        SELECT code FROM dealers WHERE id = ${dealerId}::uuid
      `;

      const rzpOrder = await createRazorpayOrder({
        amountInRupees: amount,
        receipt: `order-${params.id.slice(0, 8)}`,
        notes: {
          dealerId,
          dealerCode: dealer?.code ?? "",
          kind: "order_payment",
          orderId: params.id,
          deliveryDate: order.deliveryDate,
        },
      });

      await pgClient`
        INSERT INTO razorpay_payments (
          dealer_id, razorpay_order_id, amount, currency,
          kind, status, order_id, notes
        ) VALUES (
          ${dealerId}::uuid, ${rzpOrder.id},
          ${amount.toFixed(2)}::numeric, 'INR',
          'order_payment', 'created',
          ${params.id}::uuid,
          ${JSON.stringify({ deliveryDate: order.deliveryDate })}::jsonb
        )
      `;

      // Mark the order as awaiting online payment the moment checkout
      // starts. This is what stops an ABANDONED Razorpay sheet from
      // leaving a plain credit 'draft' that the window-close auto-confirm
      // would silently place on credit. Now an unfinished payment stays
      // 'payment_required' (+ 'upi') — the dealer can retry from the
      // Orders screen, and if it's still unpaid at window close the
      // worker discards it. A successful pay flips it to 'confirmed'.
      // Only a still-editable order (draft / already payment_required)
      // is touched — never a confirmed one.
      await pgClient`
        UPDATE orders
           SET status = 'payment_required',
               payment_mode = 'upi',
               updated_at = now()
         WHERE id = ${params.id}::uuid
           AND status IN ('draft', 'payment_required')
      `;

      return reply.status(201).send({
        razorpayOrderId: rzpOrder.id,
        amount,
        amountPaise: rzpOrder.amount,
        currency: rzpOrder.currency,
        keyId: getRazorpayKeyId(),
        orderId: params.id,
      });
    }
  );

  // ── POST /api/v1/dealer/orders/:id/pay-now/verify ──
  app.post(
    "/api/v1/dealer/orders/:id/pay-now/verify",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      if (require503IfUnconfigured(reply)) return;
      const dealerId = getDealerId(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);

      const body = z
        .object({
          razorpayOrderId: z.string().min(1),
          razorpayPaymentId: z.string().min(1),
          razorpaySignature: z.string().min(1),
        })
        .parse(request.body);

      if (!verifyPaymentSignature(body)) {
        return reply.status(400).send({
          error: "Invalid signature",
          message: "Payment signature could not be verified",
        });
      }

      const [row] = await pgClient`
        SELECT id::text, kind::text, dealer_id::text AS "dealerId",
               order_id::text AS "orderId", status::text,
               amount::numeric AS amount
          FROM razorpay_payments
         WHERE razorpay_order_id = ${body.razorpayOrderId}
         LIMIT 1
      `;
      if (!row) return reply.status(404).send({ error: "Payment not found" });
      if (row.dealerId !== dealerId)
        return reply.status(403).send({ error: "Forbidden" });
      if (row.kind !== "order_payment" || row.orderId !== params.id) {
        return reply.status(400).send({
          error: "Mismatched payment",
          message: "This razorpay payment is for a different order",
        });
      }

      // Signature only proves authenticity — confirm the money was
      // actually captured before flipping the order to 'confirmed'.
      const capture = await ensureCaptured({
        razorpayOrderId: body.razorpayOrderId,
        razorpayPaymentId: body.razorpayPaymentId,
        expectedAmountPaise: Math.round(parseFloat(row.amount) * 100),
      });
      if (!capture.ok) {
        if (capture.indeterminate) {
          // Couldn't get a definitive answer from Razorpay (timeout / network
          // / authorized-not-yet-captured). The money may have been taken, so
          // DON'T mark the row 'failed' — that would both hide it from the
          // reconciliation sweep and wrongly tell the dealer the payment
          // failed. Leave the order in 'payment_required' and the row
          // recoverable; the webhook or the reconcile job will confirm the
          // order within minutes if the capture really happened.
          await pgClient`
            UPDATE razorpay_payments
               SET razorpay_payment_id = COALESCE(razorpay_payment_id, ${body.razorpayPaymentId}),
                   error_description = ${capture.message},
                   updated_at = now()
             WHERE id = ${row.id}::uuid
               AND status IN ('created', 'attempted')
          `;
          return reply.status(202).send({
            status: "pending",
            pending: true,
            message:
              "We couldn't confirm your payment instantly. If the amount was debited, your order will be confirmed automatically within a few minutes.",
            paymentStatus: capture.status,
            orderId: params.id,
          });
        }
        // Definitive failure — Razorpay says the payment failed / was refunded
        // / doesn't match. Safe to mark the row failed and tell the dealer.
        await pgClient`
          UPDATE razorpay_payments
             SET status = 'failed',
                 razorpay_payment_id = COALESCE(razorpay_payment_id, ${body.razorpayPaymentId}),
                 error_description = ${capture.message},
                 updated_at = now()
           WHERE id = ${row.id}::uuid
             AND status IN ('created', 'attempted')
        `;
        // The payment definitively did not happen, so the indent is
        // cancelled here and now rather than parked as "awaiting payment"
        // for the dealer to come back to. Doing it server-side means it
        // still happens when the app dies before it can ask.
        await cancelUnpaidOrder(params.id);
        return reply.status(402).send({
          error: "Payment not captured",
          message: capture.message,
          paymentStatus: capture.status,
        });
      }

      // Include 'failed' in the guard: a Razorpay order can have multiple
      // payment attempts. If an earlier attempt's payment.failed webhook
      // already flipped this (single, per-order) row to 'failed', a later
      // successful retry must still be able to recover it. Capture is
      // independently proven by ensureCaptured() above, and we overwrite
      // razorpay_payment_id with the CAPTURED id, so this is safe.
      await pgClient`
        UPDATE razorpay_payments
           SET status = 'paid',
               razorpay_payment_id = ${body.razorpayPaymentId},
               razorpay_signature  = ${body.razorpaySignature},
               paid_at = COALESCE(paid_at, now()),
               updated_at = now()
         WHERE id = ${row.id}::uuid
           AND status IN ('created', 'attempted', 'failed')
      `;

      const applied = await applyPaidPayment(row.id);
      return reply.send({
        ok: true,
        alreadyApplied: applied.alreadyApplied,
        orderId: applied.orderId,
      });
    }
  );

  // ── POST /api/v1/dealer/orders/:id/cancel-unpaid ──
  //
  // The dealer app has no "awaiting payment" state any more: the moment an
  // online payment attempt ends without success (sheet dismissed, payment
  // failed) the app calls this and the indent is cancelled outright. A
  // lingering 'payment_required' order otherwise locks the day's draft
  // against edits AND holds FGS stock until window close, so the dealer
  // can neither pay nor re-order.
  //
  // This NEVER cancels an order that has money against it. A capture can
  // still be settling (verify answered 202, or the webhook is in flight),
  // so both the pre-read and the cancel UPDATE itself require no 'paid'
  // razorpay_payments row and no order debit. If a capture lands AFTER the
  // cancel, confirmPaidOrder revives the order on ABANDONED_PAYMENT_REASON
  // exactly as it does for the worker's window-close discard.
  app.post(
    "/api/v1/dealer/orders/:id/cancel-unpaid",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);

      const [order] = await pgClient`
        SELECT id::text, dealer_id::text AS "dealerId", status::text AS status
          FROM orders
         WHERE id = ${params.id}::uuid
         LIMIT 1
      `;
      if (!order) return reply.status(404).send({ error: "Order not found" });
      if (order.dealerId !== dealerId)
        return reply.status(403).send({ error: "Forbidden" });

      // Already cancelled — the app retrying after a dropped response is a
      // no-op, not an error (dealers are on slow rural links).
      if (order.status === "cancelled") {
        return reply.send({ ok: true, cancelled: false, status: order.status });
      }
      if (!["draft", "payment_required"].includes(order.status)) {
        return reply.status(409).send({
          error: "Order not cancellable",
          message: `Order is in ${order.status} state; only an unpaid indent can be cancelled from the app.`,
          status: order.status,
        });
      }

      const cancelled = await cancelUnpaidOrder(params.id);

      if (!cancelled) {
        // A payment landed between the read and the write. Leave the order
        // alone — the confirm path owns it from here.
        return reply.status(409).send({
          error: "Order not cancellable",
          message: "A payment for this indent is being processed.",
        });
      }

      return reply.send({ ok: true, cancelled: true });
    }
  );

  // ── GET /api/v1/dealer/razorpay-payments ──
  app.get(
    "/api/v1/dealer/razorpay-payments",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const q = paginationSchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);
      const dealerId = getDealerId(request);
  
      const rows = await pgClient`
        SELECT
          id::text,
          razorpay_order_id   AS "razorpayOrderId",
          razorpay_payment_id AS "razorpayPaymentId",
          amount::float8      AS amount,
          currency, kind::text AS kind, status::text AS status,
          order_id::text      AS "orderId",
          to_char(paid_at    AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "paidAt",
          to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "createdAt",
          error_description   AS "errorDescription"
        FROM razorpay_payments
        WHERE dealer_id = ${dealerId}::uuid
        ORDER BY created_at DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;
      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM razorpay_payments WHERE dealer_id = ${dealerId}::uuid
      `;
      return reply.send({
        payments: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // ── POST /api/v1/razorpay/webhook ──
  app.post("/api/v1/razorpay/webhook", async (request, reply) => {
    const sigHeader = request.headers["x-razorpay-signature"];
    const rawBody = (request as any).rawBody as string | undefined;

    // The webhook is the server-side safety net that applies payments the
    // synchronous /verify call misses (app closed, network drop, etc.). If
    // it silently stops working the software quietly stops recording
    // captured payments — so every failure here is logged at ERROR level so
    // a broken webhook is visible instead of rotting unnoticed.
    if (!rawBody) {
      request.log.error(
        "[razorpay-webhook] rawBody unavailable — the raw-body parser is not wired, so signatures can't be verified. Captured payments will only apply via synchronous /verify or the reconciliation job."
      );
      return reply.status(200).send({ ok: true, skipped: true });
    }
    if (!sigHeader || typeof sigHeader !== "string") {
      request.log.error("[razorpay-webhook] missing x-razorpay-signature header");
      return reply.status(400).send({ error: "Missing signature" });
    }
    if (!verifyWebhookSignature(rawBody, sigHeader)) {
      request.log.error(
        "[razorpay-webhook] signature verification FAILED — check RAZORPAY_WEBHOOK_SECRET matches the Razorpay dashboard webhook secret. No payments will apply via webhook until this is fixed."
      );
      return reply.status(400).send({ error: "Invalid signature" });
    }

    const payload = request.body as any;
    const event = payload?.event as string | undefined;
    const paymentEntity = payload?.payload?.payment?.entity;
    const orderId = paymentEntity?.order_id;
    const paymentId = paymentEntity?.id;

    // ── qr_code.credited — gate-pass counter payments (migration 0068) ──
    //
    // MUST be handled before the !orderId guard below. A QR payment has no
    // Razorpay order at all: its payment entity carries order_id: null, so
    // the guard would silently drop every rupee taken at the counter. The
    // row is found by QR id instead — payload.qr_code.entity.id.
    if (event === "qr_code.credited") {
      const qrId = payload?.payload?.qr_code?.entity?.id as string | undefined;
      const qrPaymentId = paymentEntity?.id as string | undefined;

      if (!qrId || !qrPaymentId) {
        request.log.error(
          { qrId, qrPaymentId },
          "[razorpay-webhook] qr_code.credited without a qr id or payment id — cannot attribute this payment"
        );
        return reply.status(200).send({ ok: true, ignored: true });
      }

      const [qrRow] = await pgClient`
        SELECT id::text, status::text
          FROM razorpay_payments
         WHERE razorpay_qr_code_id = ${qrId}
         LIMIT 1
      `;

      if (!qrRow) {
        // Money landed on a QR this system did not mint — the standing
        // counter standee, or a QR made by hand in the dashboard. It is
        // real money with no sale attached, so it must not pass quietly.
        request.log.error(
          {
            qrId,
            paymentId: qrPaymentId,
            amountPaise: paymentEntity?.amount ?? null,
          },
          "[razorpay-webhook] qr_code.credited for an UNKNOWN QR — payment received against a QR with no gate-pass sale; book it by hand"
        );
        return reply.status(200).send({ ok: true, unknownQr: true });
      }

      const qrPromoted = await pgClient`
        UPDATE razorpay_payments
           SET status = 'paid',
               razorpay_payment_id = ${qrPaymentId},
               paid_at = COALESCE(paid_at, now()),
               webhook_received = true,
               updated_at = now()
         WHERE id = ${qrRow.id}::uuid
           AND status IN ('created', 'attempted', 'failed')
        RETURNING id
      `;
      if (qrPromoted.length === 0) {
        await pgClient`
          UPDATE razorpay_payments SET webhook_received = true, updated_at = now()
           WHERE id = ${qrRow.id}::uuid
        `;
      }

      // Same contract as the captured branch: never let an apply error
      // 500 this handler, or Razorpay retries it forever.
      if (qrPromoted.length > 0 || qrRow.status === "paid") {
        try {
          await applyPaidGatePassPayment(qrRow.id);
        } catch (err) {
          request.log.error(
            { err, rzpRowId: qrRow.id, qrId, paymentId: qrPaymentId },
            "[razorpay-webhook] applyPaidGatePassPayment failed after QR credit — the sale is unstamped, reconcile by hand"
          );
        }
      }
      return reply.status(200).send({ ok: true });
    }

    // ── qr_code.closed — a counter QR expired or was cancelled ──────────
    // Retires the row so the counter screen can say "expired, issue a new
    // one" instead of spinning. Guarded on the unpaid statuses: 'closed'
    // also fires immediately after a single_use QR is PAID, and that must
    // never undo the payment.
    if (event === "qr_code.closed") {
      const closedQrId = payload?.payload?.qr_code?.entity?.id as string | undefined;
      if (!closedQrId) {
        return reply.status(200).send({ ok: true, ignored: true });
      }
      await pgClient`
        UPDATE razorpay_payments
           SET status = 'failed',
               error_description = 'QR closed or expired before payment',
               webhook_received = true,
               updated_at = now()
         WHERE razorpay_qr_code_id = ${closedQrId}
           AND status IN ('created', 'attempted')
      `;
      return reply.status(200).send({ ok: true });
    }

    if (!event || !orderId) {
      return reply.status(200).send({ ok: true, ignored: true });
    }

    const [row] = await pgClient`
      SELECT id::text, status::text,
             order_id::text AS "internalOrderId",
             kind::text     AS kind
        FROM razorpay_payments
       WHERE razorpay_order_id = ${orderId}
       LIMIT 1
    `;
    if (!row) {
      return reply.status(200).send({ ok: true, unknownOrder: true });
    }

    // 'payment.captured' fires when money is taken; 'order.paid' is the
    // most reliable "this order is fully paid" signal. Treat both the same.
    if (event === "payment.captured" || event === "order.paid") {
      // Promote created/attempted/failed → paid, pointing the row at the
      // CAPTURED payment id. 'failed' is included so a prior failed attempt
      // on the same razorpay order (which set this single per-order row to
      // 'failed') cannot block the successful capture. Overwrite (not
      // COALESCE) so the stored reference is the captured id, never a
      // failed attempt's id.
      const promoted = paymentId
        ? await pgClient`
            UPDATE razorpay_payments
               SET status = 'paid',
                   razorpay_payment_id = ${paymentId},
                   paid_at = COALESCE(paid_at, now()),
                   webhook_received = true,
                   updated_at = now()
             WHERE id = ${row.id}::uuid
               AND status IN ('created', 'attempted', 'failed')
            RETURNING id
          `
        : [];
      if (promoted.length === 0) {
        // Already paid/refunded (idempotent re-delivery), or no paymentId in
        // the payload — just record that the webhook landed.
        await pgClient`
          UPDATE razorpay_payments SET webhook_received = true, updated_at = now()
           WHERE id = ${row.id}::uuid
        `;
      }

      // Apply internal effects only when the row is genuinely paid. Never let
      // an apply error 500 this handler — Razorpay would retry forever, and
      // the reconciliation job is the backstop for a transient failure.
      const paidNow = promoted.length > 0 || row.status === "paid";
      if (paidNow) {
        try {
          await applyPaidPayment(row.id);
        } catch (err) {
          request.log.error(
            { err, rzpRowId: row.id, orderId },
            "[razorpay-webhook] applyPaidPayment failed after capture — will be retried by the reconciliation job"
          );
        }
      }
      return reply.status(200).send({ ok: true });
    }

    if (event === "payment.failed") {
      await pgClient`
        UPDATE razorpay_payments
           SET status = 'failed',
               razorpay_payment_id = COALESCE(razorpay_payment_id, ${paymentId}),
               error_code = ${paymentEntity?.error_code ?? null},
               error_description = ${paymentEntity?.error_description ?? null},
               webhook_received = true,
               updated_at = now()
         WHERE id = ${row.id}::uuid
           AND status NOT IN ('paid', 'refunded')
      `;
      // A failed payment cancels its indent — this is the only signal left
      // when the app died before it could ask. Razorpay fires this per
      // ATTEMPT, so a dealer retrying inside the same sheet can trip it and
      // then succeed; that is recovered by confirmPaidOrder, which revives
      // an order cancelled with ABANDONED_PAYMENT_REASON once the capture
      // lands. Never let a cancel error 500 the handler — Razorpay would
      // retry forever, and the window-close discard is the backstop.
      if (row.kind === "order_payment" && row.internalOrderId) {
        try {
          await cancelUnpaidOrder(row.internalOrderId);
        } catch (err) {
          request.log.error(
            { err, rzpRowId: row.id, orderId: row.internalOrderId },
            "[razorpay-webhook] could not cancel the indent behind a failed payment"
          );
        }
      }
      return reply.status(200).send({ ok: true });
    }

    if (event === "refund.processed" || event === "refund.failed") {
      const refundEntity = payload?.payload?.refund?.entity;
      const refundId = refundEntity?.id;
      if (refundId) {
        const newStatus = event === "refund.processed" ? "processed" : "failed";
        await pgClient`
          UPDATE razorpay_refunds
             SET status = ${newStatus}::razorpay_refund_status,
                 error_description = ${refundEntity?.error_description ?? null},
                 processed_at = COALESCE(processed_at, now()),
                 updated_at = now()
           WHERE razorpay_refund_id = ${refundId}
             AND status = 'pending'
        `;
      }
      return reply.status(200).send({ ok: true });
    }

    return reply.status(200).send({ ok: true, ignored: true, event });
  });
}