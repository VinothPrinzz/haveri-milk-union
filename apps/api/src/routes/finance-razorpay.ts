// apps/api/src/routes/finance-razorpay.ts
// ═══════════════════════════════════════════════════════════════════════
// Admin / Finance-side Razorpay surfaces.
//
// 0032 shipped the DEALER side of Razorpay (credit top-up + pay-now).
// This file is the FINANCE side — what the accountant needs once money
// is flowing through the gateway:
//
//   GET  /api/v1/finance/online-payments          — list every gateway txn
//   GET  /api/v1/finance/online-payments/summary  — KPI tiles
//   GET  /api/v1/finance/online-payments/:id       — one txn + its refunds
//   POST /api/v1/finance/online-payments/:id/refund    — issue a refund
//   POST /api/v1/finance/online-payments/:id/reconcile — sign off a txn
//   GET  /api/v1/finance/reconciliation            — Razorpay ⇄ books report
//
// ── How this ties into the existing ledger ─────────────────────────────
// A captured Razorpay payment is turned into an internal `payments` row
// + a `dealer_ledger` credit by applyPaidPayment() in dealer-payments.ts.
// This file NEVER duplicates that. It only:
//   • READS razorpay_payments / payments / dealer_ledger to report.
//   • On REFUND, writes a reversing dealer_ledger DEBIT (voucher_type
//     'Refund') and a razorpay_refunds row, in one transaction — the
//     mirror image of the receipt flow.
//
// All endpoints require finance.view; mutations require finance.manage.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";
import {
  isRazorpayConfigured,
  createRazorpayRefund,
} from "../lib/razorpay-client.js";

// ── Helpers ─────────────────────────────────────────────────────────────

function adminUserId(request: FastifyRequest): string {
  const a = (request as unknown as { admin?: { userId: string } }).admin;
  if (!a?.userId) throw new Error("adminAuth middleware not set");
  return a.userId;
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export async function financeRazorpayRoutes(app: FastifyInstance) {

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/online-payments                              │
  // │  Paginated list of every Razorpay transaction.                    │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/online-payments",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        status:   z.enum(["created", "attempted", "paid", "failed", "refunded"]).optional(),
        kind:     z.enum(["credit_topup", "order_payment"]).optional(),
        dealerId: z.string().uuid().optional(),
        dateFrom: isoDate.optional(),
        dateTo:   isoDate.optional(),
        // 'unreconciled' = paid but reconciled_at IS NULL
        recon:    z.enum(["all", "reconciled", "unreconciled"]).optional(),
        search:   z.string().optional(), // dealer name / code / rzp order|payment id
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);

      const status   = q.status   ?? null;
      const kind     = q.kind     ?? null;
      const dealerId = q.dealerId ?? null;
      const dateFrom = q.dateFrom ?? null;
      const dateTo   = q.dateTo ? q.dateTo + "T23:59:59Z" : null;
      const recon    = q.recon ?? "all";
      const search   = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        SELECT
          rp.id,
          rp.razorpay_order_id    AS "razorpayOrderId",
          rp.razorpay_payment_id  AS "razorpayPaymentId",
          rp.amount::float8       AS amount,
          rp.amount_refunded::float8 AS "amountRefunded",
          rp.currency,
          rp.kind::text           AS kind,
          rp.status::text         AS status,
          rp.order_id             AS "orderId",
          rp.reconciled_at        AS "reconciledAt",
          rp.settlement_id        AS "settlementId",
          rp.error_description    AS "errorDescription",
          rp.webhook_received     AS "webhookReceived",
          rp.paid_at              AS "paidAt",
          rp.created_at           AS "createdAt",
          d.id                    AS "dealerId",
          d.name                  AS "dealerName",
          d.code                  AS "dealerCode",
          -- Does an internal payments row exist for this gateway txn?
          -- This is the single most important field on the screen:
          -- 'paid' in Razorpay but no internal row = money the books
          -- have not seen.
          EXISTS (
            SELECT 1 FROM payments p
            WHERE p.reference = rp.razorpay_payment_id AND p.mode = 'upi'
          )                       AS "postedToBooks"
        FROM razorpay_payments rp
        JOIN dealers d ON d.id = rp.dealer_id
        WHERE (${status}::text   IS NULL OR rp.status::text = ${status ?? ''})
          AND (${kind}::text     IS NULL OR rp.kind::text   = ${kind ?? ''})
          AND (${dealerId}::uuid IS NULL OR rp.dealer_id = ${dealerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${dateFrom}::timestamptz IS NULL OR rp.created_at >= ${dateFrom ?? '1970-01-01'}::timestamptz)
          AND (${dateTo}::timestamptz   IS NULL OR rp.created_at <= ${dateTo   ?? '2099-12-31'}::timestamptz)
          AND (${recon} = 'all'
               OR (${recon} = 'reconciled'   AND rp.reconciled_at IS NOT NULL)
               OR (${recon} = 'unreconciled' AND rp.status = 'paid' AND rp.reconciled_at IS NULL))
          AND (${search}::text IS NULL OR
               d.name ILIKE ${search ?? ''} OR
               d.code ILIKE ${search ?? ''} OR
               rp.razorpay_order_id   ILIKE ${search ?? ''} OR
               rp.razorpay_payment_id ILIKE ${search ?? ''})
        ORDER BY rp.created_at DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM razorpay_payments rp
        JOIN dealers d ON d.id = rp.dealer_id
        WHERE (${status}::text   IS NULL OR rp.status::text = ${status ?? ''})
          AND (${kind}::text     IS NULL OR rp.kind::text   = ${kind ?? ''})
          AND (${dealerId}::uuid IS NULL OR rp.dealer_id = ${dealerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${dateFrom}::timestamptz IS NULL OR rp.created_at >= ${dateFrom ?? '1970-01-01'}::timestamptz)
          AND (${dateTo}::timestamptz   IS NULL OR rp.created_at <= ${dateTo   ?? '2099-12-31'}::timestamptz)
          AND (${recon} = 'all'
               OR (${recon} = 'reconciled'   AND rp.reconciled_at IS NOT NULL)
               OR (${recon} = 'unreconciled' AND rp.status = 'paid' AND rp.reconciled_at IS NULL))
          AND (${search}::text IS NULL OR
               d.name ILIKE ${search ?? ''} OR
               d.code ILIKE ${search ?? ''} OR
               rp.razorpay_order_id   ILIKE ${search ?? ''} OR
               rp.razorpay_payment_id ILIKE ${search ?? ''})
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/online-payments/summary                      │
  // │  Header KPI tiles. Honours the same date window.                  │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/online-payments/summary",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z.object({
        dateFrom: isoDate.optional(),
        dateTo:   isoDate.optional(),
      }).parse(request.query);

      const dateFrom = q.dateFrom ?? null;
      const dateTo   = q.dateTo ? q.dateTo + "T23:59:59Z" : null;

      const [s] = await pgClient`
        SELECT
          COALESCE(SUM(CASE WHEN status = 'paid'
                       THEN amount - amount_refunded ELSE 0 END), 0)::float8 AS "netCollected",
          COALESCE(SUM(CASE WHEN status = 'paid'
                       THEN amount ELSE 0 END), 0)::float8                   AS "grossCollected",
          COALESCE(SUM(amount_refunded), 0)::float8                          AS "totalRefunded",
          COUNT(*) FILTER (WHERE status = 'paid')::int                       AS "paidCount",
          COUNT(*) FILTER (WHERE status = 'failed')::int                     AS "failedCount",
          COUNT(*) FILTER (WHERE status IN ('created','attempted'))::int     AS "pendingCount",
          COUNT(*) FILTER (WHERE status = 'paid'
                           AND reconciled_at IS NULL)::int                   AS "unreconciledCount",
          COALESCE(SUM(CASE WHEN status = 'paid' AND reconciled_at IS NULL
                       THEN amount - amount_refunded ELSE 0 END), 0)::float8  AS "unreconciledAmount",
          COALESCE(SUM(CASE WHEN status = 'paid'
                            AND paid_at::date = (now() AT TIME ZONE 'Asia/Kolkata')::date
                       THEN amount - amount_refunded ELSE 0 END), 0)::float8  AS "collectedToday"
        FROM razorpay_payments
        WHERE (${dateFrom}::timestamptz IS NULL OR created_at >= ${dateFrom ?? '1970-01-01'}::timestamptz)
          AND (${dateTo}::timestamptz   IS NULL OR created_at <= ${dateTo   ?? '2099-12-31'}::timestamptz)
      `;

      // Success rate over the window — a gateway health signal.
      const [r] = await pgClient`
        SELECT
          COUNT(*) FILTER (WHERE status = 'paid')::int   AS paid,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
        FROM razorpay_payments
        WHERE (${dateFrom}::timestamptz IS NULL OR created_at >= ${dateFrom ?? '1970-01-01'}::timestamptz)
          AND (${dateTo}::timestamptz   IS NULL OR created_at <= ${dateTo   ?? '2099-12-31'}::timestamptz)
      `;
      const attempted = (r?.paid ?? 0) + (r?.failed ?? 0);
      const successRate = attempted > 0 ? Math.round(((r?.paid ?? 0) / attempted) * 100) : null;

      return reply.send({ summary: { ...s, successRate } });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/online-payments/:id                          │
  // │  One transaction + its refunds + the internal ledger row(s).      │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/online-payments/:id",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const [payment] = await pgClient`
        SELECT
          rp.id,
          rp.razorpay_order_id    AS "razorpayOrderId",
          rp.razorpay_payment_id  AS "razorpayPaymentId",
          rp.razorpay_signature   AS "razorpaySignature",
          rp.amount::float8       AS amount,
          rp.amount_refunded::float8 AS "amountRefunded",
          rp.currency,
          rp.kind::text           AS kind,
          rp.status::text         AS status,
          rp.order_id             AS "orderId",
          rp.notes,
          rp.webhook_received     AS "webhookReceived",
          rp.error_code           AS "errorCode",
          rp.error_description    AS "errorDescription",
          rp.reconciled_at        AS "reconciledAt",
          rp.settlement_id        AS "settlementId",
          rp.paid_at              AS "paidAt",
          rp.created_at           AS "createdAt",
          d.id                    AS "dealerId",
          d.name                  AS "dealerName",
          d.code                  AS "dealerCode",
          d.phone                 AS "dealerPhone"
        FROM razorpay_payments rp
        JOIN dealers d ON d.id = rp.dealer_id
        WHERE rp.id = ${id}
        LIMIT 1
      `;
      if (!payment) return reply.status(404).send({ error: "Payment not found" });

      const refunds = await pgClient`
        SELECT
          rf.id,
          rf.razorpay_refund_id AS "razorpayRefundId",
          rf.amount::float8     AS amount,
          rf.status::text       AS status,
          rf.reason,
          rf.error_description  AS "errorDescription",
          rf.created_at         AS "createdAt",
          rf.processed_at       AS "processedAt",
          u.name                AS "initiatedByName"
        FROM razorpay_refunds rf
        LEFT JOIN users u ON u.id = rf.initiated_by
        WHERE rf.razorpay_payment_row = ${id}
        ORDER BY rf.created_at DESC
      `;

      // The internal `payments` + `dealer_ledger` rows this gateway
      // txn produced (via applyPaidPayment). Empty = not posted.
      const ledger = await pgClient`
        SELECT
          dl.id,
          dl.type,
          dl.amount::float8  AS amount,
          dl.voucher_no      AS "voucherNo",
          dl.voucher_type    AS "voucherType",
          dl.particulars,
          dl.created_at      AS "createdAt"
        FROM dealer_ledger dl
        WHERE dl.dealer_id = ${(payment as any).dealerId}
          AND dl.description LIKE ${'%' + ((payment as any).razorpayPaymentId ?? '___none___') + '%'}
        ORDER BY dl.created_at DESC
      `;

      return reply.send({ payment, refunds, ledger });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  POST /api/v1/finance/online-payments/:id/refund                  │
  // │  Issue a (partial or full) refund through Razorpay, write the     │
  // │  reversing ledger debit, and record a razorpay_refunds row.       │
  // └─────────────────────────────────────────────────────────────────┘
  app.post(
    "/api/v1/finance/online-payments/:id/refund",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      if (!isRazorpayConfigured()) {
        return reply.status(503).send({
          error: "Service unavailable",
          message: "Razorpay is not configured on this server.",
        });
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        // Omit `amount` for a full refund of the remaining balance.
        amount: z.number().positive().optional(),
        reason: z.string().min(3, "A reason is required for every refund"),
      }).parse(request.body);

      const [rp] = await pgClient`
        SELECT id, dealer_id::text AS "dealerId", kind::text AS kind,
               status::text AS status,
               amount::numeric AS amount,
               amount_refunded::numeric AS "amountRefunded",
               razorpay_payment_id AS "rzpPaymentId"
        FROM razorpay_payments
        WHERE id = ${id}
        LIMIT 1
      `;
      if (!rp) return reply.status(404).send({ error: "Payment not found" });
      if (rp.status !== "paid") {
        return reply.status(400).send({
          error: "Not refundable",
          message: `Only 'paid' payments can be refunded (this one is '${rp.status}').`,
        });
      }
      if (!rp.rzpPaymentId) {
        return reply.status(400).send({
          error: "Missing payment id",
          message: "This payment has no Razorpay payment id — cannot refund.",
        });
      }

      const total      = parseFloat(rp.amount);
      const refunded   = parseFloat(rp.amountRefunded);
      const remaining  = total - refunded;
      const refundAmt  = body.amount ?? remaining;

      if (refundAmt > remaining + 0.001) {
        return reply.status(400).send({
          error: "Amount too large",
          message: `Only ₹${remaining.toFixed(2)} remains refundable on this payment.`,
        });
      }

      // 1. Call Razorpay. Done BEFORE the DB transaction so a gateway
      //    failure leaves nothing half-written.
      let rzpRefund: { id: string; status: string };
      try {
        rzpRefund = await createRazorpayRefund({
          paymentId: rp.rzpPaymentId,
          amountInRupees: refundAmt,
          notes: { reason: body.reason, dealerId: rp.dealerId },
        });
      } catch (err: any) {
        request.log.error(err, "[finance-razorpay] Razorpay refund call failed");
        return reply.status(502).send({
          error: "Gateway error",
          message: err?.message ?? "Razorpay rejected the refund.",
        });
      }

      // 2. Persist: refund row + reversing ledger debit + counters.
      try {
        const result = await pgClient.begin(async (_tx) => {
          const tx = _tx as unknown as typeof pgClient;

          // Reverse the dealer_ledger credit, but only if a credit was
          // originally posted (credit_topup always posts; order_payment
          // only posts when the order was on credit). We detect it by
          // the description tag applyPaidPayment writes.
          const [origCredit] = await tx`
            SELECT id FROM dealer_ledger
            WHERE dealer_id = ${rp.dealerId}::uuid
              AND type = 'credit'
              AND description LIKE ${'%' + rp.rzpPaymentId + '%'}
            LIMIT 1
          `;

          let ledgerEntryId: string | null = null;
          if (origCredit) {
            // Running balance for balance_after (same formula as
            // applyPaidPayment — opening + net non-opening ledger).
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
               WHERE d.id = ${rp.dealerId}::uuid
            `;
            const balanceAfter = parseFloat(bal!.bal) - refundAmt;
            const desc = `Razorpay refund ${rzpRefund.id} for ${rp.rzpPaymentId} — ${body.reason}`;

            const [led] = await tx`
              INSERT INTO dealer_ledger (
                dealer_id, type, amount,
                reference_id, reference_type,
                description, balance_after,
                performed_by,
                voucher_no, voucher_type, particulars, voucher_date
              ) VALUES (
                ${rp.dealerId}::uuid, 'debit',
                ${refundAmt.toFixed(2)}::numeric,
                ${id}::uuid, 'refund'::ledger_ref_type,
                ${desc}, ${balanceAfter.toFixed(2)}::numeric,
                ${adminUserId(request)}::uuid,
                ${`RF-${rzpRefund.id.slice(-8).toUpperCase()}`},
                'Refund', ${desc},
                (now() AT TIME ZONE 'Asia/Kolkata')::date
              )
              RETURNING id
            `;
            ledgerEntryId = led!.id;
          }

          const [refundRow] = await tx`
            INSERT INTO razorpay_refunds (
              razorpay_payment_row, dealer_id,
              razorpay_refund_id, razorpay_payment_id,
              amount, status, reason, initiated_by, ledger_entry_id
            ) VALUES (
              ${id}::uuid, ${rp.dealerId}::uuid,
              ${rzpRefund.id}, ${rp.rzpPaymentId},
              ${refundAmt.toFixed(2)}::numeric,
              ${rzpRefund.status === "processed" ? "processed" : "pending"}::razorpay_refund_status,
              ${body.reason}, ${adminUserId(request)}::uuid, ${ledgerEntryId}::uuid
            )
            RETURNING id
          `;

          const newRefunded = refunded + refundAmt;
          const fullyRefunded = newRefunded >= total - 0.001;

          await tx`
            UPDATE razorpay_payments SET
              amount_refunded = ${newRefunded.toFixed(2)}::numeric,
              status = ${fullyRefunded ? "refunded" : "paid"}::razorpay_payment_status,
              updated_at = now()
            WHERE id = ${id}::uuid
          `;

          return { refundId: refundRow!.id, ledgerEntryId, fullyRefunded };
        });

        return reply.status(201).send({
          message: "Refund initiated",
          razorpayRefundId: rzpRefund.id,
          ...result,
        });
      } catch (err) {
        // The gateway refund already went through — surface loudly so
        // finance reconciles it by hand rather than silently losing it.
        request.log.error(
          err,
          `[finance-razorpay] DB write failed AFTER Razorpay refund ${rzpRefund.id} — needs manual reconciliation`
        );
        return reply.status(500).send({
          error: "Partial failure",
          message: `Razorpay refund ${rzpRefund.id} succeeded but recording it failed. Reconcile manually.`,
        });
      }
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  POST /api/v1/finance/online-payments/:id/reconcile               │
  // │  Finance sign-off: stamp reconciled_at once the txn is confirmed  │
  // │  against the books / bank. Idempotent.                            │
  // └─────────────────────────────────────────────────────────────────┘
  app.post(
    "/api/v1/finance/online-payments/:id/reconcile",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ reconciled: z.boolean().default(true) }).parse(request.body ?? {});

      const [row] = await pgClient`
        SELECT id, status::text AS status FROM razorpay_payments WHERE id = ${id} LIMIT 1
      `;
      if (!row) return reply.status(404).send({ error: "Payment not found" });
      if (body.reconciled && row.status !== "paid" && row.status !== "refunded") {
        return reply.status(400).send({
          error: "Not reconcilable",
          message: "Only paid / refunded payments can be reconciled.",
        });
      }

      const [updated] = body.reconciled
        ? await pgClient`
            UPDATE razorpay_payments
               SET reconciled_at = now(), updated_at = now()
             WHERE id = ${id}::uuid
            RETURNING id, reconciled_at AS "reconciledAt"
          `
        : await pgClient`
            UPDATE razorpay_payments
               SET reconciled_at = NULL, updated_at = now()
             WHERE id = ${id}::uuid
            RETURNING id, reconciled_at AS "reconciledAt"
          `;
      return reply.send({ message: body.reconciled ? "Marked reconciled" : "Reconciliation cleared", ...updated });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/reconciliation                               │
  // │  The Razorpay ⇄ internal-books discrepancy report.                │
  // │                                                                   │
  // │  Buckets every gateway txn so finance can act:                    │
  // │   • matched     — paid, posted to books, reconciled               │
  // │   • needs_review— paid, posted to books, NOT yet reconciled       │
  // │   • not_posted  — paid in Razorpay, NO internal payments row       │
  // │                   (applyPaidPayment failed — money unaccounted)   │
  // │   • stale       — created/attempted >24h ago, never paid          │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/reconciliation",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z.object({
        dateFrom: isoDate.optional(),
        dateTo:   isoDate.optional(),
        bucket:   z.enum(["all", "matched", "needs_review", "not_posted", "stale"]).optional(),
      }).parse(request.query);

      const dateFrom = q.dateFrom ?? null;
      const dateTo   = q.dateTo ? q.dateTo + "T23:59:59Z" : null;
      const bucket   = q.bucket ?? "all";

      const rows = await pgClient`
        WITH classified AS (
          SELECT
            rp.id,
            rp.razorpay_order_id   AS "razorpayOrderId",
            rp.razorpay_payment_id AS "razorpayPaymentId",
            rp.amount::float8      AS amount,
            rp.kind::text          AS kind,
            rp.status::text        AS status,
            rp.reconciled_at       AS "reconciledAt",
            rp.paid_at             AS "paidAt",
            rp.created_at          AS "createdAt",
            d.name                 AS "dealerName",
            d.code                 AS "dealerCode",
            (SELECT p.id FROM payments p
              WHERE p.reference = rp.razorpay_payment_id AND p.mode = 'upi'
              LIMIT 1)             AS "internalPaymentId",
            CASE
              WHEN rp.status = 'paid' AND rp.reconciled_at IS NOT NULL
                   AND EXISTS (SELECT 1 FROM payments p
                               WHERE p.reference = rp.razorpay_payment_id AND p.mode = 'upi')
                THEN 'matched'
              WHEN rp.status IN ('paid','refunded')
                   AND EXISTS (SELECT 1 FROM payments p
                               WHERE p.reference = rp.razorpay_payment_id AND p.mode = 'upi')
                THEN 'needs_review'
              WHEN rp.status IN ('paid','refunded')
                THEN 'not_posted'
              WHEN rp.status IN ('created','attempted')
                   AND rp.created_at < now() - interval '24 hours'
                THEN 'stale'
              ELSE 'open'
            END AS bucket
          FROM razorpay_payments rp
          JOIN dealers d ON d.id = rp.dealer_id
          WHERE (${dateFrom}::timestamptz IS NULL OR rp.created_at >= ${dateFrom ?? '1970-01-01'}::timestamptz)
            AND (${dateTo}::timestamptz   IS NULL OR rp.created_at <= ${dateTo   ?? '2099-12-31'}::timestamptz)
        )
        SELECT * FROM classified
        WHERE (${bucket} = 'all' OR bucket = ${bucket})
          AND bucket <> 'open'
        ORDER BY
          CASE bucket
            WHEN 'not_posted'   THEN 0
            WHEN 'needs_review' THEN 1
            WHEN 'stale'        THEN 2
            ELSE 3
          END,
          "createdAt" DESC
        LIMIT 500
      `;

      // Counts per bucket for the header strip.
      const counts = await pgClient`
        WITH classified AS (
          SELECT
            CASE
              WHEN rp.status = 'paid' AND rp.reconciled_at IS NOT NULL
                   AND EXISTS (SELECT 1 FROM payments p
                               WHERE p.reference = rp.razorpay_payment_id AND p.mode = 'upi')
                THEN 'matched'
              WHEN rp.status IN ('paid','refunded')
                   AND EXISTS (SELECT 1 FROM payments p
                               WHERE p.reference = rp.razorpay_payment_id AND p.mode = 'upi')
                THEN 'needs_review'
              WHEN rp.status IN ('paid','refunded')
                THEN 'not_posted'
              WHEN rp.status IN ('created','attempted')
                   AND rp.created_at < now() - interval '24 hours'
                THEN 'stale'
              ELSE 'open'
            END AS bucket,
            rp.amount AS amount
          FROM razorpay_payments rp
          WHERE (${dateFrom}::timestamptz IS NULL OR rp.created_at >= ${dateFrom ?? '1970-01-01'}::timestamptz)
            AND (${dateTo}::timestamptz   IS NULL OR rp.created_at <= ${dateTo   ?? '2099-12-31'}::timestamptz)
        )
        SELECT bucket,
               count(*)::int AS count,
               COALESCE(SUM(amount), 0)::float8 AS amount
        FROM classified
        GROUP BY bucket
      `;

      const summary: Record<string, { count: number; amount: number }> = {
        matched:      { count: 0, amount: 0 },
        needs_review: { count: 0, amount: 0 },
        not_posted:   { count: 0, amount: 0 },
        stale:        { count: 0, amount: 0 },
      };
      for (const c of counts as any[]) {
        if (summary[c.bucket]) summary[c.bucket] = { count: c.count, amount: c.amount };
      }

      return reply.send({ data: rows, summary });
    }
  );
}