// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/routes/dealer-payments.ts
//
// Phase 2B — Razorpay-backed dealer payment flows.
//
// Routes added:
//   POST /api/v1/dealer/credit-topup/order             create RZP order for top-up
//   POST /api/v1/dealer/credit-topup/verify            verify signature + credit ledger
//   POST /api/v1/dealer/orders/:id/pay-now             create RZP order for stuck order
//   POST /api/v1/dealer/orders/:id/pay-now/verify      verify + mark order confirmed
//   GET  /api/v1/dealer/razorpay-payments              dealer's recent RZP txns
//   POST /api/v1/razorpay/webhook                      async confirmation (NOT auth'd;
//                                                       uses HMAC signature)
//
// Mounted in apps/api/src/server.ts:
//   import { dealerPaymentsRoutes } from "./routes/dealer-payments.js";
//   app.register(dealerPaymentsRoutes);
//
// Idempotency:
//   The webhook can fire multiple times for the same event. Each
//   handler checks `razorpay_payments.status` and the existence of
//   the matching `payments` row before doing any side-effect.
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
} from "../lib/razorpay-client.js";

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
 * Ledger insert + (for order_payment) order status transition.
 * Called from both /verify and the webhook — must be idempotent.
 *
 * Idempotency strategy: row uniqueness on razorpay_payments.razorpay_order_id
 * is the gate. We check status='paid' BEFORE inserting into payments /
 * dealer_ledger. If already paid, no-op.
 */
async function applyPaidPayment(rzpRowId: string): Promise<{
  alreadyApplied: boolean;
  dealerId: string;
  kind: "credit_topup" | "order_payment";
  amount: number;
  orderId: string | null;
}> {
  return await pgClient.begin(async (tx) => {
    // 1. Lock the row + check status
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
      // Caller should have set status='paid' before invoking us
      throw new Error(
        `razorpay_payments row ${rzpRowId} is ${row.status}, expected 'paid'`
      );
    }

    // 2. Did we already insert the payments row for this RZP payment?
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

    // 3. Insert into payments — same shape the admin receipt flow uses
    const [paymentRow] = await tx`
      INSERT INTO payments (
        dealer_id, mode, amount, reference, status, received_at
      ) VALUES (
        ${row.dealerId}::uuid, 'upi',
        ${amount.toFixed(2)}::numeric,
        ${row.rzpPaymentId}, 'received',
        now()
      )
      RETURNING id
    `;

    if (!paymentRow) throw new Error("payments INSERT returned no row");

    // 4. Insert ledger entry (type='credit' = money coming TO the dealer's account)
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
        ${paymentRow.id}::uuid,
        ${refType}::ledger_ref_type,
        ${description},
        0::numeric,                          -- balance_after recomputed on read
        ${`RP-${row.rzpPaymentId.slice(-8).toUpperCase()}`},
        'Receipt', ${description},
        (now() AT TIME ZONE 'Asia/Kolkata')::date
      )
    `;

    // 5. For order_payment, transition the order
    if (row.kind === "order_payment" && row.orderId) {
      await tx`
        UPDATE orders
           SET status = 'confirmed',
               payment_mode = 'upi',
               payment_reference = ${row.rzpPaymentId},
               confirmed_at = COALESCE(confirmed_at, now()),
               updated_at = now()
         WHERE id = ${row.orderId}::uuid
           AND status IN ('draft', 'payment_required', 'pending')
      `;
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
  // ┌─────────────────────────────────────────────────┐
  // │  Webhook needs the raw body to verify HMAC.       │
  // │  Register a content-type parser that captures     │
  // │  the raw buffer onto request.rawBody.             │
  // └─────────────────────────────────────────────────┘
  // Only register if no JSON parser exists yet (it normally does —
  // Fastify ships one by default — so this is effectively a no-op,
  // and the webhook degrades gracefully below).
  if (!app.hasContentTypeParser("application/json")) {
    app.addContentTypeParser(
      "application/json",
      { parseAs: "buffer" },
      (req, body, done) => {
        try {
          (req as any).rawBody = (body as Buffer).toString("utf8");
          const parsed = body.length
            ? JSON.parse((body as Buffer).toString("utf8"))
            : {};
          done(null, parsed);
        } catch (err) {
          done(err as Error, undefined);
        }
      }
    );
  }
  // NOTE: this replaces the default parser. If your server already
  // registers a custom parser, merge that logic — both need to stash
  // the raw body for this webhook to work.


  // ┌─────────────────────────────────────────────────┐
  // │  POST /api/v1/dealer/credit-topup/order           │
  // │  Create a Razorpay order for credit top-up.       │
  // │  Body: { amount: number }   (rupees, min 1)       │
  // │  Returns: { razorpayOrderId, amount, keyId }      │
  // └─────────────────────────────────────────────────┘
  app.post(
    "/api/v1/dealer/credit-topup/order",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      if (require503IfUnconfigured(reply)) return;
      const dealerId = getDealerId(request);

      const body = z.object({
        amount: z.number().int().min(1).max(500_000),
      }).parse(request.body);

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
        amount: body.amount,           // rupees (mobile SDK takes paise)
        amountPaise: rzpOrder.amount,  // paise (what SDK actually wants)
        currency: rzpOrder.currency,
        keyId: getRazorpayKeyId(),
      });
    }
  );

  // ┌─────────────────────────────────────────────────┐
  // │  POST /api/v1/dealer/credit-topup/verify          │
  // │  Verify the payment signature returned by the     │
  // │  RZP SDK, then apply the ledger credit.           │
  // │  Body: { razorpayOrderId, razorpayPaymentId,      │
  // │          razorpaySignature }                      │
  // └─────────────────────────────────────────────────┘
  app.post(
    "/api/v1/dealer/credit-topup/verify",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      if (require503IfUnconfigured(reply)) return;
      const dealerId = getDealerId(request);

      const body = z.object({
        razorpayOrderId: z.string().min(1),
        razorpayPaymentId: z.string().min(1),
        razorpaySignature: z.string().min(1),
      }).parse(request.body);

      // 1. Verify signature
      if (!verifyPaymentSignature(body)) {
        return reply.status(400).send({
          error: "Invalid signature",
          message: "Payment signature could not be verified",
        });
      }

      // 2. Find the row + verify dealer ownership
      const [row] = await pgClient`
        SELECT id::text, kind::text, dealer_id::text AS "dealerId", status::text
          FROM razorpay_payments
         WHERE razorpay_order_id = ${body.razorpayOrderId}
         LIMIT 1
      `;
      if (!row) {
        return reply.status(404).send({ error: "Payment not found" });
      }
      if (row.dealerId !== dealerId) {
        return reply.status(403).send({ error: "Forbidden" });
      }
      if (row.kind !== "credit_topup") {
        return reply.status(400).send({
          error: "Wrong endpoint",
          message: "This razorpay order is not a credit-topup",
        });
      }

      // 3. Mark as paid (idempotent — webhook may have done this already)
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

      // 4. Apply the ledger (no-op if webhook already did)
      const applied = await applyPaidPayment(row.id);

      return reply.send({
        ok: true,
        alreadyApplied: applied.alreadyApplied,
        amount: applied.amount,
      });
    }
  );

  // ┌─────────────────────────────────────────────────┐
  // │  POST /api/v1/dealer/orders/:id/pay-now           │
  // │  Create RZP order to pay for a specific order.    │
  // │  Order must be in 'draft' or 'payment_required'.  │
  // └─────────────────────────────────────────────────┘
  app.post(
    "/api/v1/dealer/orders/:id/pay-now",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      if (require503IfUnconfigured(reply)) return;
      const dealerId = getDealerId(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);

      const [order] = await pgClient`
        SELECT id::text, dealer_id::text AS "dealerId",
               status::text, grand_total::numeric AS "grandTotal",
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

  // ┌─────────────────────────────────────────────────┐
  // │  POST /api/v1/dealer/orders/:id/pay-now/verify    │
  // └─────────────────────────────────────────────────┘
  app.post(
    "/api/v1/dealer/orders/:id/pay-now/verify",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      if (require503IfUnconfigured(reply)) return;
      const dealerId = getDealerId(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);

      const body = z.object({
        razorpayOrderId: z.string().min(1),
        razorpayPaymentId: z.string().min(1),
        razorpaySignature: z.string().min(1),
      }).parse(request.body);

      if (!verifyPaymentSignature(body)) {
        return reply.status(400).send({
          error: "Invalid signature",
          message: "Payment signature could not be verified",
        });
      }

      const [row] = await pgClient`
        SELECT id::text, kind::text, dealer_id::text AS "dealerId",
               order_id::text AS "orderId", status::text
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

  // ┌─────────────────────────────────────────────────┐
  // │  GET /api/v1/dealer/razorpay-payments             │
  // │  Last 50 RZP transactions for the dealer. Used    │
  // │  by the Profile screen's "Payment history" list.  │
  // └─────────────────────────────────────────────────┘
  app.get(
    "/api/v1/dealer/razorpay-payments",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);
      const rows = await pgClient`
        SELECT
          id::text,
          razorpay_order_id   AS "razorpayOrderId",
          razorpay_payment_id AS "razorpayPaymentId",
          amount::numeric     AS amount,
          currency,
          kind::text          AS kind,
          status::text        AS status,
          order_id::text      AS "orderId",
          paid_at             AS "paidAt",
          created_at          AS "createdAt",
          error_description   AS "errorDescription"
        FROM razorpay_payments
        WHERE dealer_id = ${dealerId}::uuid
        ORDER BY created_at DESC
        LIMIT 50
      `;
      return reply.send({ payments: rows });
    }
  );

  // ┌─────────────────────────────────────────────────┐
  // │  POST /api/v1/razorpay/webhook                    │
  // │                                                   │
  // │  Async confirmation from Razorpay. Used as a      │
  // │  fallback when the mobile client closes before    │
  // │  calling /verify. Events:                         │
  // │   • payment.captured  — success                   │
  // │   • payment.failed    — declined / cancelled      │
  // │                                                   │
  // │  Signature verified against the RAW request body  │
  // │  using RAZORPAY_WEBHOOK_SECRET (set in dashboard).│
  // │                                                   │
  // │  Idempotent — re-fires are safe.                  │
  // └─────────────────────────────────────────────────┘
  app.post("/api/v1/razorpay/webhook", async (request, reply) => {
    const sigHeader = request.headers["x-razorpay-signature"];
    const rawBody = (request as any).rawBody as string | undefined;

    // If rawBody wasn't captured, the webhook fallback isn't fully
    // wired. The synchronous /verify endpoints still confirm payments,
    // so just acknowledge so Razorpay stops retrying.
    if (!rawBody) {
        request.log.warn("[razorpay-webhook] rawBody unavailable — skipped");
        return reply.status(200).send({ ok: true, skipped: true });
    }

    if (!sigHeader || typeof sigHeader !== "string" || !rawBody) {
      return reply.status(400).send({ error: "Missing signature or body" });
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
      // Some webhook events (e.g. settlements) don't carry an order_id
      // — those aren't relevant to dealer payments. Acknowledge OK so
      // Razorpay stops retrying.
      return reply.status(200).send({ ok: true, ignored: true });
    }

    const [row] = await pgClient`
      SELECT id::text, status::text
        FROM razorpay_payments
       WHERE razorpay_order_id = ${orderId}
       LIMIT 1
    `;

    if (!row) {
      // Webhook fired for a Razorpay order we don't know about — could
      // be from a different env or a stale test. Ack and ignore.
      return reply.status(200).send({ ok: true, unknownOrder: true });
    }

    if (event === "payment.captured") {
      // Promote to paid only if not already terminal
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
      // Apply (idempotent — checks payments table first)
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

    // Unknown event — log + ack
    return reply.status(200).send({ ok: true, ignored: true, event });
  });
}