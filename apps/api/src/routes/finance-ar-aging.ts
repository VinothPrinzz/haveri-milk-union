// apps/api/src/routes/finance-ar-aging.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → AR Aging / Outstanding
//
//   GET /api/v1/finance/ar-aging              — paginated dealer rollup
//   GET /api/v1/finance/ar-aging/summary      — KPI tiles
//   GET /api/v1/finance/ar-aging/dealers/:id  — invoice-level breakdown
//
// Invoice-level aging bucketed by days past due_date, rolled up per
// dealer. All endpoints require finance.view.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function financeArAgingRoutes(app: FastifyInstance) {
  // ── GET /api/v1/finance/ar-aging ──
  app.get(
    "/api/v1/finance/ar-aging",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        routeId: z.string().uuid().optional(),
        bucket:  z.enum(["current", "b1_30", "b31_60", "b61_90", "b90_plus"]).optional(),
        search:  z.string().optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);

      const routeId = q.routeId ?? null;
      const bucket  = q.bucket ?? null;
      const search  = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        WITH unpaid_invoices AS (
          SELECT
            i.dealer_id,
            i.id AS invoice_id,
            (i.total_amount - i.paid_amount)::numeric AS outstanding,
            GREATEST(0, (CURRENT_DATE - i.due_date)) AS days_overdue,
            CASE
              WHEN i.due_date >= CURRENT_DATE                    THEN 'current'
              WHEN (CURRENT_DATE - i.due_date) BETWEEN 1  AND 30 THEN 'b1_30'
              WHEN (CURRENT_DATE - i.due_date) BETWEEN 31 AND 60 THEN 'b31_60'
              WHEN (CURRENT_DATE - i.due_date) BETWEEN 61 AND 90 THEN 'b61_90'
              ELSE 'b90_plus'
            END AS bucket
          FROM invoices i
          WHERE i.payment_status <> 'paid'
            AND i.due_date IS NOT NULL
            AND (i.total_amount - i.paid_amount) > 0
        )
        SELECT
          d.id, d.code, d.name,
          r.name AS "routeName",
          COALESCE(d.credit_limit, 0)::float8 AS "creditLimit",
          COALESCE(SUM(ui.outstanding) FILTER (WHERE ui.bucket = 'current'),  0)::float8 AS "currentAmount",
          COALESCE(SUM(ui.outstanding) FILTER (WHERE ui.bucket = 'b1_30'),    0)::float8 AS "b1_30",
          COALESCE(SUM(ui.outstanding) FILTER (WHERE ui.bucket = 'b31_60'),   0)::float8 AS "b31_60",
          COALESCE(SUM(ui.outstanding) FILTER (WHERE ui.bucket = 'b61_90'),   0)::float8 AS "b61_90",
          COALESCE(SUM(ui.outstanding) FILTER (WHERE ui.bucket = 'b90_plus'), 0)::float8 AS "b90Plus",
          COALESCE(SUM(ui.outstanding), 0)::float8 AS "totalOutstanding",
          COALESCE(SUM(ui.outstanding) FILTER (WHERE ui.bucket <> 'current'), 0)::float8 AS "totalOverdue",
          COUNT(ui.invoice_id)::int AS "invoiceCount",
          MAX(ui.days_overdue)::int AS "maxDaysOverdue",
          CASE
            WHEN MAX(ui.days_overdue) > 90 THEN 'b90_plus'
            WHEN MAX(ui.days_overdue) > 60 THEN 'b61_90'
            WHEN MAX(ui.days_overdue) > 30 THEN 'b31_60'
            WHEN MAX(ui.days_overdue) > 0  THEN 'b1_30'
            ELSE 'current'
          END AS "worstBucket"
        FROM dealers d
        -- Inner join: only dealers with money still outstanding reach this
        -- report. No deleted_at / active filter — a debt does not disappear
        -- because the dealer was deactivated or removed from the masters.
        JOIN unpaid_invoices ui ON ui.dealer_id = d.id
        LEFT JOIN routes r ON r.id = d.route_id
        WHERE (${routeId}::uuid IS NULL OR d.route_id = ${routeId}::uuid)
          AND (${search}::text  IS NULL OR d.name ILIKE ${search}::text OR d.code ILIKE ${search}::text)
        GROUP BY d.id, d.code, d.name, d.credit_limit, r.name
        HAVING (${bucket}::text IS NULL OR
                COUNT(*) FILTER (WHERE ui.bucket = ${bucket}::text) > 0)
        ORDER BY MAX(ui.days_overdue) DESC, SUM(ui.outstanding) DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        WITH unpaid_invoices AS (
          SELECT
            i.dealer_id, i.id AS invoice_id,
            CASE
              WHEN i.due_date >= CURRENT_DATE                    THEN 'current'
              WHEN (CURRENT_DATE - i.due_date) BETWEEN 1  AND 30 THEN 'b1_30'
              WHEN (CURRENT_DATE - i.due_date) BETWEEN 31 AND 60 THEN 'b31_60'
              WHEN (CURRENT_DATE - i.due_date) BETWEEN 61 AND 90 THEN 'b61_90'
              ELSE 'b90_plus'
            END AS bucket
          FROM invoices i
          WHERE i.payment_status <> 'paid'
            AND i.due_date IS NOT NULL
            AND (i.total_amount - i.paid_amount) > 0
        )
        SELECT count(*)::int AS count FROM (
          SELECT d.id
          FROM dealers d
          JOIN unpaid_invoices ui ON ui.dealer_id = d.id
          WHERE (${routeId}::uuid IS NULL OR d.route_id = ${routeId}::uuid)
            AND (${search}::text  IS NULL OR d.name ILIKE ${search}::text OR d.code ILIKE ${search}::text)
          GROUP BY d.id
          HAVING (${bucket}::text IS NULL OR
                  COUNT(*) FILTER (WHERE ui.bucket = ${bucket}::text) > 0)
        ) sub
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // ── GET /api/v1/finance/ar-aging/summary ──
  app.get(
    "/api/v1/finance/ar-aging/summary",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (_request, reply) => {
      const [s] = await pgClient`
        WITH unpaid_invoices AS (
          SELECT
            i.dealer_id,
            (i.total_amount - i.paid_amount)::numeric AS outstanding,
            CASE
              WHEN i.due_date >= CURRENT_DATE                    THEN 'current'
              WHEN (CURRENT_DATE - i.due_date) BETWEEN 1  AND 30 THEN 'b1_30'
              WHEN (CURRENT_DATE - i.due_date) BETWEEN 31 AND 60 THEN 'b31_60'
              WHEN (CURRENT_DATE - i.due_date) BETWEEN 61 AND 90 THEN 'b61_90'
              ELSE 'b90_plus'
            END AS bucket
          FROM invoices i
          WHERE i.payment_status <> 'paid'
            AND i.due_date IS NOT NULL
            AND (i.total_amount - i.paid_amount) > 0
        )
        SELECT
          COALESCE(SUM(outstanding), 0)::float8 AS "totalOutstanding",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket <> 'current'), 0)::float8 AS "totalOverdue",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'b90_plus'), 0)::float8 AS "criticalAmount",
          COUNT(DISTINCT dealer_id)::int AS "dealersWithDues",
          COUNT(DISTINCT dealer_id) FILTER (WHERE bucket = 'b90_plus')::int AS "dealers90PlusCount",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'current'),  0)::float8 AS "bucketCurrent",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'b1_30'),    0)::float8 AS "bucket1_30",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'b31_60'),   0)::float8 AS "bucket31_60",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'b61_90'),   0)::float8 AS "bucket61_90",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'b90_plus'), 0)::float8 AS "bucket90Plus"
        FROM unpaid_invoices
      `;
      return reply.send({ summary: s });
    }
  );

  // ── GET /api/v1/finance/ar-aging/dealers/:id ──
  app.get(
    "/api/v1/finance/ar-aging/dealers/:id",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const rows = await pgClient`
        SELECT
          i.id,
          i.invoice_number              AS "invoiceNumber",
          i.invoice_date                AS "invoiceDate",
          i.due_date                    AS "dueDate",
          i.total_amount::float8        AS "totalAmount",
          i.paid_amount::float8         AS "paidAmount",
          (i.total_amount - i.paid_amount)::float8 AS outstanding,
          GREATEST(0, (CURRENT_DATE - i.due_date)) AS "daysOverdue",
          i.payment_status              AS "paymentStatus",
          (SELECT MAX(p.received_date) FROM payments p WHERE p.invoice_id = i.id) AS "lastReceiptDate"
        FROM invoices i
        WHERE i.dealer_id     = ${id}::uuid
          AND i.payment_status <> 'paid'
          AND (i.total_amount - i.paid_amount) > 0
        ORDER BY i.due_date ASC, i.invoice_date ASC
      `;
      return reply.send({ data: rows });
    }
  );
}
