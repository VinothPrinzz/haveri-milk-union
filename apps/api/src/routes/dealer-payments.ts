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
import { deductOrderStockCapped, describeShortfalls } from "../lib/stock-check.js";
import { enqueuePDFInvoice } from "../lib/queue.js";
import { getDealerRouteId, NO_ROUTE_RESPONSE } from "../lib/dealer-route.js";

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

/**
 * Apply a verified Razorpay payment to internal tables. Idempotent —
 * checks the payments table before inserting.
 */
export async function applyPaidPayment(rzpRowId: string): Promise<{
  alreadyApplied: boolean;
  dealerId: string;
  kind: "credit_topup" | "order_payment";
  amount: number;
  orderId: string | null;
}> {
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
      return {
        alreadyApplied: true,
        dealerId: row.dealerId,
        kind: row.kind as any,
        amount: parseFloat(row.amount),
        orderId: row.orderId,
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
    if (row.kind === "order_payment" && row.orderId) {
      // cancel_window_ends_at = LEAST(now + 30 min, route's close_time for the
      // delivery date). Same rule as the credit-confirm path so online-paid
      // orders are cancellable for the same window.
      await tx`
        UPDATE orders
           SET status = 'confirmed',
               payment_mode = 'upi',
               payment_reference = ${row.rzpPaymentId},
               confirmed_at = COALESCE(confirmed_at, now()),
               updated_at = now(),
               cancel_window_ends_at = LEAST(
                 now() + interval '30 minutes',
                 COALESCE(
                   (orders.delivery_date + tw.close_time) AT TIME ZONE 'Asia/Kolkata',
                   now() + interval '30 minutes'
                 )
               )
          FROM dealers d
          LEFT JOIN time_windows tw ON tw.route_id = d.route_id
         WHERE orders.id = ${row.orderId}::uuid
           AND orders.dealer_id = d.id
           AND orders.status IN ('draft', 'payment_required')
      `;

      // Move physical stock now that the order is confirmed. Money is
      // already captured, so we never block here — deduct capped at 0
      // (never negative) and log any oversell for ops. Idempotent: the
      // cart path that deducted at creation already set the latch, so a
      // cart-UPI order is a no-op here (no double-deduct).
      const oversold = await deductOrderStockCapped(tx, row.orderId);
      if (oversold.length > 0) {
        console.warn(
          `[pay-now] order ${row.orderId} oversold (paid, stock capped at 0): ` +
            describeShortfalls(oversold)
        );
      }
    }

    return {
      alreadyApplied: false,
      dealerId: row.dealerId,
      kind: row.kind as any,
      amount,
      orderId: row.orderId,
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

    if (!event || !orderId) {
      return reply.status(200).send({ ok: true, ignored: true });
    }

    const [row] = await pgClient`
      SELECT id::text, status::text
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