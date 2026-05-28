// apps/api/src/routes/finance-refunds.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Refunds
//
//   GET  /api/v1/finance/refunds            — paginated list
//   GET  /api/v1/finance/refunds/summary    — KPI tiles
//   POST /api/v1/finance/refunds/:id/resync — pull latest status from Razorpay
//
// The write-path (issuing a refund) lives in finance-razorpay.ts. This
// file is read + follow-up. GETs require finance.view; resync requires
// finance.manage.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";
import { isRazorpayConfigured, fetchRazorpayRefund } from "../lib/razorpay-client.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export async function financeRefundsRoutes(app: FastifyInstance) {
  // ── GET /api/v1/finance/refunds ──
  app.get(
    "/api/v1/finance/refunds",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        status:      z.enum(["pending", "processed", "failed"]).optional(),
        dealerId:    z.string().uuid().optional(),
        initiatedBy: z.string().uuid().optional(),
        dateFrom:    isoDate.optional(),
        dateTo:      isoDate.optional(),
        search:      z.string().optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);

      const status      = q.status ?? null;
      const dealerId    = q.dealerId ?? null;
      const initiatedBy = q.initiatedBy ?? null;
      const dateFrom    = q.dateFrom ?? null;
      const dateTo      = q.dateTo ? q.dateTo + "T23:59:59Z" : null;
      const search      = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        SELECT
          rf.id,
          rf.razorpay_refund_id   AS "razorpayRefundId",
          rf.razorpay_payment_id  AS "razorpayPaymentId",
          rf.razorpay_payment_row AS "razorpayPaymentRowId",
          rf.amount::float8       AS amount,
          rf.currency,
          rf.status::text         AS status,
          rf.reason,
          rf.error_description    AS "errorDescription",
          rf.created_at           AS "createdAt",
          rf.processed_at         AS "processedAt",
          rf.ledger_entry_id      AS "ledgerEntryId",
          d.id                    AS "dealerId",
          d.name                  AS "dealerName",
          d.code                  AS "dealerCode",
          u.name                  AS "initiatedByName",
          dl.voucher_no           AS "voucherNo",
          rp.amount::float8       AS "originalPaymentAmount",
          rp.kind::text           AS "originalPaymentKind"
        FROM razorpay_refunds rf
        JOIN dealers d              ON d.id  = rf.dealer_id
        JOIN razorpay_payments rp   ON rp.id = rf.razorpay_payment_row
        LEFT JOIN users u           ON u.id  = rf.initiated_by
        LEFT JOIN dealer_ledger dl  ON dl.id = rf.ledger_entry_id
        WHERE
          (${status}::text   IS NULL OR rf.status::text = ${status}::text)
          AND (${dealerId}::uuid IS NULL OR rf.dealer_id = ${dealerId}::uuid)
          AND (${dateFrom}::timestamptz IS NULL OR rf.created_at >= ${dateFrom}::timestamptz)
          AND (${dateTo}::timestamptz   IS NULL OR rf.created_at <= ${dateTo}::timestamptz)
          AND (${initiatedBy}::uuid IS NULL OR rf.initiated_by = ${initiatedBy}::uuid)
          AND (${search}::text IS NULL OR
               d.name ILIKE ${search}::text OR
               d.code ILIKE ${search}::text OR
               rf.reason ILIKE ${search}::text OR
               rf.razorpay_refund_id ILIKE ${search}::text OR
               rf.razorpay_payment_id ILIKE ${search}::text)
        ORDER BY rf.created_at DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM razorpay_refunds rf
        JOIN dealers d ON d.id = rf.dealer_id
        WHERE
          (${status}::text   IS NULL OR rf.status::text = ${status}::text)
          AND (${dealerId}::uuid IS NULL OR rf.dealer_id = ${dealerId}::uuid)
          AND (${dateFrom}::timestamptz IS NULL OR rf.created_at >= ${dateFrom}::timestamptz)
          AND (${dateTo}::timestamptz   IS NULL OR rf.created_at <= ${dateTo}::timestamptz)
          AND (${initiatedBy}::uuid IS NULL OR rf.initiated_by = ${initiatedBy}::uuid)
          AND (${search}::text IS NULL OR
               d.name ILIKE ${search}::text OR
               d.code ILIKE ${search}::text OR
               rf.reason ILIKE ${search}::text OR
               rf.razorpay_refund_id ILIKE ${search}::text OR
               rf.razorpay_payment_id ILIKE ${search}::text)
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // ── GET /api/v1/finance/refunds/summary ──
  app.get(
    "/api/v1/finance/refunds/summary",
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
          COALESCE(SUM(amount) FILTER (WHERE status = 'processed'), 0)::float8 AS "totalRefunded",
          COUNT(*) FILTER (WHERE status = 'processed')::int                    AS "refundCount",
          COALESCE(SUM(amount) FILTER (WHERE status = 'pending'), 0)::float8   AS "pendingAmount",
          COUNT(*) FILTER (WHERE status = 'pending')::int                      AS "pendingCount",
          COALESCE(SUM(amount) FILTER (WHERE status = 'failed'), 0)::float8    AS "failedAmount",
          COUNT(*) FILTER (WHERE status = 'failed')::int                       AS "failedCount",
          COUNT(*) FILTER (WHERE status IN ('processed','pending')
                             AND ledger_entry_id IS NULL)::int                 AS "unlinkedCount"
        FROM razorpay_refunds
        WHERE (${dateFrom}::timestamptz IS NULL OR created_at >= ${dateFrom}::timestamptz)
          AND (${dateTo}::timestamptz   IS NULL OR created_at <= ${dateTo}::timestamptz)
      `;
      return reply.send({ summary: s });
    }
  );

  // ── POST /api/v1/finance/refunds/:id/resync ──
  // For 'pending' rows — re-fetch from Razorpay and update status.
  // Idempotent. No ledger writes (the ledger debit was posted at
  // initiation; status flip alone doesn't change the books).
  app.post(
    "/api/v1/finance/refunds/:id/resync",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request: FastifyRequest, reply) => {
      if (!isRazorpayConfigured()) {
        return reply.status(503).send({
          error: "Service unavailable",
          message: "Razorpay is not configured on this server.",
        });
      }
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const [rf] = await pgClient`
        SELECT id, razorpay_refund_id AS "razorpayRefundId", status::text AS status
          FROM razorpay_refunds WHERE id = ${id} LIMIT 1
      `;
      if (!rf) return reply.status(404).send({ error: "Refund not found" });
      if (!rf.razorpayRefundId) {
        return reply.status(400).send({ error: "No gateway id to resync" });
      }

      let fresh: { id: string; status: string; error_description: string | null };
      try {
        fresh = await fetchRazorpayRefund(rf.razorpayRefundId);
      } catch (err: any) {
        request.log.error(err, "[finance-refunds] Razorpay refund fetch failed");
        return reply.status(502).send({
          error: "Gateway error",
          message: err?.message ?? "Razorpay could not be reached.",
        });
      }

      const newStatus = fresh.status === "processed" ? "processed"
                      : fresh.status === "failed"    ? "failed"
                      : "pending";

      const [updated] = await pgClient`
        UPDATE razorpay_refunds
           SET status = ${newStatus}::razorpay_refund_status,
               error_description = ${fresh.error_description ?? null},
               processed_at = CASE WHEN ${newStatus} = 'processed'
                                     AND processed_at IS NULL
                                   THEN now() ELSE processed_at END,
               updated_at   = now()
         WHERE id = ${id}::uuid
        RETURNING id, status::text AS status, processed_at AS "processedAt"
      `;
      return reply.send({ message: "Resynced", ...updated });
    }
  );
}
