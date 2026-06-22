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
 */
async function ensureCaptured(opts: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  expectedAmountPaise: number;
}): Promise<{ ok: true } | { ok: false; status: string; message: string }> {
  let payment;
  try {
    payment = await fetchRazorpayPayment(opts.razorpayPaymentId);
  } catch {
    return {
      ok: false,
      status: "unknown",
      message: "Could not verify payment status with Razorpay",
    };
  }

  // The payment must belong to the order we created and match its amount.
  if (payment.order_id && payment.order_id !== opts.razorpayOrderId) {
    return {
      ok: false,
      status: payment.status,
      message: "Payment does not belong to this order",
    };
  }
  if (payment.amount !== opts.expectedAmountPaise) {
    return {
      ok: false,
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
      return {
        ok: false,
        status: cap.status,
        message: "Payment could not be captured",
      };
    } catch (e) {
      return {
        ok: false,
        status: "authorized",
        message:
          e instanceof Error ? e.message : "Payment capture failed",
      };
    }
  }

  // created / failed / refunded / etc. — never treat as paid.
  return {
    ok: false,
    status: payment.status,
    message:
      payment.error_description ?? `Payment is ${payment.status}, not captured`,
  };
}

/**
 * Apply a verified Razorpay payment to internal tables. Idempotent —
 * checks the payments table before inserting.
 */
async function applyPaidPayment(rzpRowId: string): Promise<{
  alreadyApplied: boolean;
  dealerId: string;
  kind: "credit_topup" | "order_payment";
  amount: number;
  orderId: string | null;
}> {
  return await pgClient.begin(async (_tx) => {
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

      await pgClient`
        UPDATE razorpay_payments
           SET status = 'paid',
               razorpay_payment_id = ${body.razorpayPaymentId},
               razorpay_signature  = ${body.razorpaySignature},
               paid_at = COALESCE(paid_at, now()),
               updated_at = now()
         WHERE id = ${row.id}::uuid
           AND status IN ('created', 'attempted')
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

      await pgClient`
        UPDATE razorpay_payments
           SET status = 'paid',
               razorpay_payment_id = ${body.razorpayPaymentId},
               razorpay_signature  = ${body.razorpaySignature},
               paid_at = COALESCE(paid_at, now()),
               updated_at = now()
         WHERE id = ${row.id}::uuid
           AND status IN ('created', 'attempted')
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

    // Graceful degradation — if rawBody wasn't captured, the webhook
    // fallback isn't wired. The synchronous /verify endpoints still
    // confirm payments. Acknowledge so Razorpay stops retrying.
    if (!rawBody) {
      request.log.warn("[razorpay-webhook] rawBody unavailable — skipped");
      return reply.status(200).send({ ok: true, skipped: true });
    }
    if (!sigHeader || typeof sigHeader !== "string") {
      return reply.status(400).send({ error: "Missing signature" });
    }
    if (!verifyWebhookSignature(rawBody, sigHeader)) {
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

    if (event === "payment.captured") {
      if (row.status === "created" || row.status === "attempted") {
        await pgClient`
          UPDATE razorpay_payments
             SET status = 'paid',
                 razorpay_payment_id = COALESCE(razorpay_payment_id, ${paymentId}),
                 paid_at = COALESCE(paid_at, now()),
                 webhook_received = true,
                 updated_at = now()
           WHERE id = ${row.id}::uuid
             AND status IN ('created', 'attempted')
        `;
      } else {
        await pgClient`
          UPDATE razorpay_payments SET webhook_received = true, updated_at = now()
           WHERE id = ${row.id}::uuid
        `;
      }
      await applyPaidPayment(row.id);
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