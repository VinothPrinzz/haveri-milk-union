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
//
// Aging keys on COALESCE(due_date, invoice_date) — never on due_date alone.
// These three queries used to filter `due_date IS NOT NULL`, and because the
// column was NULL on every invoice in the database, the whole report returned
// ₹0 and looked like "nobody owes us anything" rather than "this report is
// not working". Both mints now stamp due_date from the party's credit terms
// (lib/invoice-settlement.ts), but a row that slips through unstamped must
// still age from its issue date instead of vanishing.
//
// Cancelled sales are excluded on BOTH rails, and so are drafts.
// invoices.order_id is polymorphic (orders / employee_orders / direct_sales)
// and the invoice row is left exactly as issued when a sale is cancelled — it
// is a real GST document, so rewriting its figures would destroy the record of
// what was billed. It therefore has to stop being a receivable here instead.
// GP-0044 was ₹1,385.77 of phantom debt on a pass that had been cancelled.
//
// The orders rail needs the same treatment and for a while did not have it:
// cancelling an order re-derives its settlement to zero (cancel-order.ts calls
// refreshInvoiceSettlement), so the full invoice total reappeared here as
// debt. 20 cancelled orders and 3 never-confirmed drafts were billing dealers
// ₹26,351.37, several of them carrying cancellation reasons that say the money
// was refunded to the dealer's balance or to their bank.
//
// employee_orders needs no such clause: those invoices carry dealer_id NULL
// (the party is an employee), which every query here already drops.
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
            (i.total_amount - COALESCE(i.paid_amount, 0))::numeric AS outstanding,
            GREATEST(0, (ag.today - ag.due)) AS days_overdue,
            CASE
              WHEN ag.due >= ag.today                    THEN 'current'
              WHEN (ag.today - ag.due) BETWEEN 1  AND 30 THEN 'b1_30'
              WHEN (ag.today - ag.due) BETWEEN 31 AND 60 THEN 'b31_60'
              WHEN (ag.today - ag.due) BETWEEN 61 AND 90 THEN 'b61_90'
              ELSE 'b90_plus'
            END AS bucket
          FROM invoices i
          -- The date this invoice ages from, and today, both on the IST
          -- calendar day (00:00-23:59 Asia/Kolkata). A bare CURRENT_DATE or
          -- invoice_date::date would be a UTC day, which begins at 05:30 IST
          -- and would age everything a day late for that first half-hour.
          CROSS JOIN LATERAL (
            SELECT COALESCE(i.due_date,
                            (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date) AS due,
                   (now() AT TIME ZONE 'Asia/Kolkata')::date                    AS today
          ) ag
          WHERE i.payment_status <> 'paid'
            AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
            AND NOT EXISTS (SELECT 1 FROM direct_sales ds
                             WHERE ds.id = i.order_id AND ds.status = 'cancelled')
            AND NOT EXISTS (SELECT 1 FROM orders o
                             WHERE o.id = i.order_id
                               AND o.status IN ('cancelled', 'draft'))
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
        -- Play Store demo route: a reviewer's test activity is not the union's
        -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
        AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                         WHERE demo_rt.code = 'DEMO'
                           AND demo_rt.id = d.route_id)
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
              WHEN ag.due >= ag.today                    THEN 'current'
              WHEN (ag.today - ag.due) BETWEEN 1  AND 30 THEN 'b1_30'
              WHEN (ag.today - ag.due) BETWEEN 31 AND 60 THEN 'b31_60'
              WHEN (ag.today - ag.due) BETWEEN 61 AND 90 THEN 'b61_90'
              ELSE 'b90_plus'
            END AS bucket
          FROM invoices i
          -- The date this invoice ages from, and today, both on the IST
          -- calendar day (00:00-23:59 Asia/Kolkata). A bare CURRENT_DATE or
          -- invoice_date::date would be a UTC day, which begins at 05:30 IST
          -- and would age everything a day late for that first half-hour.
          CROSS JOIN LATERAL (
            SELECT COALESCE(i.due_date,
                            (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date) AS due,
                   (now() AT TIME ZONE 'Asia/Kolkata')::date                    AS today
          ) ag
          WHERE i.payment_status <> 'paid'
            AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
            AND NOT EXISTS (SELECT 1 FROM direct_sales ds
                             WHERE ds.id = i.order_id AND ds.status = 'cancelled')
            AND NOT EXISTS (SELECT 1 FROM orders o
                             WHERE o.id = i.order_id
                               AND o.status IN ('cancelled', 'draft'))
        )
        SELECT count(*)::int AS count FROM (
          SELECT d.id
          FROM dealers d
          JOIN unpaid_invoices ui ON ui.dealer_id = d.id
          WHERE (${routeId}::uuid IS NULL OR d.route_id = ${routeId}::uuid)
          -- Play Store demo route: a reviewer's test activity is not the union's
          -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
          AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                           WHERE demo_rt.code = 'DEMO'
                             AND demo_rt.id = d.route_id)
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
            (i.total_amount - COALESCE(i.paid_amount, 0))::numeric AS outstanding,
            CASE
              WHEN ag.due >= ag.today                    THEN 'current'
              WHEN (ag.today - ag.due) BETWEEN 1  AND 30 THEN 'b1_30'
              WHEN (ag.today - ag.due) BETWEEN 31 AND 60 THEN 'b31_60'
              WHEN (ag.today - ag.due) BETWEEN 61 AND 90 THEN 'b61_90'
              ELSE 'b90_plus'
            END AS bucket
          FROM invoices i
          -- The date this invoice ages from, and today, both on the IST
          -- calendar day (00:00-23:59 Asia/Kolkata). A bare CURRENT_DATE or
          -- invoice_date::date would be a UTC day, which begins at 05:30 IST
          -- and would age everything a day late for that first half-hour.
          CROSS JOIN LATERAL (
            SELECT COALESCE(i.due_date,
                            (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date) AS due,
                   (now() AT TIME ZONE 'Asia/Kolkata')::date                    AS today
          ) ag
          WHERE i.payment_status <> 'paid'
            -- Party-less invoices are employee subsidy indents, recovered from
            -- salary off-system. The dealer rollup drops them anyway via its
            -- inner join to dealers; without this the KPI tiles would total
            -- more than the table beneath them.
            AND i.dealer_id IS NOT NULL
            AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
            AND NOT EXISTS (SELECT 1 FROM direct_sales ds
                             WHERE ds.id = i.order_id AND ds.status = 'cancelled')
            AND NOT EXISTS (SELECT 1 FROM orders o
                             WHERE o.id = i.order_id
                               AND o.status IN ('cancelled', 'draft'))
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
          ag.due                        AS "dueDate",
          i.total_amount::float8        AS "totalAmount",
          COALESCE(i.paid_amount, 0)::float8 AS "paidAmount",
          (i.total_amount - COALESCE(i.paid_amount, 0))::float8 AS outstanding,
          GREATEST(0, (ag.today - ag.due)) AS "daysOverdue",
          i.payment_status              AS "paymentStatus",
          (SELECT MAX(p.received_date) FROM payments p
            WHERE p.invoice_id = i.id
               OR EXISTS (SELECT 1 FROM payment_allocations pa
                           WHERE pa.payment_id = p.id AND pa.invoice_id = i.id)) AS "lastReceiptDate"
        FROM invoices i
        -- Same IST aging pair as the list and summary queries above.
        CROSS JOIN LATERAL (
          SELECT COALESCE(i.due_date,
                          (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date) AS due,
                 (now() AT TIME ZONE 'Asia/Kolkata')::date                    AS today
        ) ag
        WHERE i.dealer_id     = ${id}::uuid
          AND i.payment_status <> 'paid'
          AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
          AND NOT EXISTS (SELECT 1 FROM direct_sales ds
                           WHERE ds.id = i.order_id AND ds.status = 'cancelled')
          AND NOT EXISTS (SELECT 1 FROM orders o
                           WHERE o.id = i.order_id
                             AND o.status IN ('cancelled', 'draft'))
        ORDER BY ag.due ASC, i.invoice_date ASC
      `;
      return reply.send({ data: rows });
    }
  );
}
