// apps/api/src/routes/finance-credit-control.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Available Balances (formerly Credit Control)
//
//   GET /api/v1/finance/credit-control          — paginated customer list
//   GET /api/v1/finance/credit-control/summary  — KPI tiles
//
// One row per customer: their prepaid Available Balance
//   closing_balance = opening_balance + Σ(top-up receipts) − Σ(purchases)
//   availableBalance = max(0, closing_balance)
// There is NO credit limit — customers spend only what they have topped up
// (same math as checkDealerCredit). A customer whose balance is ≤ 0
// ("empty") must record a payment before they can place an indent.
//
// Reads require finance.view. (The old set-credit-limit mutation was removed
// when limits were dropped in favour of the prepaid balance model.)
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function financeCreditControlRoutes(app: FastifyInstance) {
  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/credit-control                               │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/credit-control",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        routeId:      z.string().uuid().optional(),
        payMode:      z.enum(["Cash", "Credit"]).optional(),
        statusBucket: z.enum(["empty", "funded"]).optional(),
        search:       z.string().optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);

      const routeId      = q.routeId ?? null;
      const payMode      = q.payMode ?? null;
      const statusBucket = q.statusBucket ?? null;
      const search       = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        WITH dealer_balance AS (
          SELECT
            d.id, d.code, d.name,
            d.pay_mode::text                    AS pay_mode,
            r.id   AS route_id,
            r.name AS route_name,
            z.name AS zone_name,
            (
              COALESCE(d.opening_balance, 0)
              + COALESCE((
                  SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                                  WHEN dl.type = 'debit'  THEN -dl.amount END)
                    FROM dealer_ledger dl
                   WHERE dl.dealer_id = d.id
                     AND COALESCE(dl.voucher_type, '') <> 'Opening'
                ), 0)
            )::numeric AS closing_balance,
            (SELECT MAX(p.received_date) FROM payments p WHERE p.dealer_id = d.id) AS last_payment_at,
            (SELECT MAX(o.created_at) FROM orders o
               WHERE o.dealer_id = d.id AND o.status <> 'cancelled')               AS last_order_at
          FROM dealers d
          LEFT JOIN routes r ON r.id = d.route_id
          LEFT JOIN zones  z ON z.id = d.zone_id
          WHERE d.deleted_at IS NULL
        )
        SELECT
          id, code, name, pay_mode, route_id, route_name, zone_name,
          GREATEST(0,  closing_balance)::float8 AS "availableBalance",
          GREATEST(0, -closing_balance)::float8 AS outstanding,
          closing_balance::float8               AS "closingBalance",
          CASE WHEN closing_balance > 0 THEN 'funded' ELSE 'empty' END AS "statusBucket",
          last_payment_at AS "lastPaymentAt",
          last_order_at   AS "lastOrderAt",
          CASE WHEN last_payment_at IS NULL THEN NULL
               ELSE (CURRENT_DATE - last_payment_at) END        AS "daysSinceLastPayment"
        FROM dealer_balance
        WHERE
          (${routeId}::uuid IS NULL OR route_id = ${routeId}::uuid)
          AND (${payMode}::text IS NULL OR pay_mode = ${payMode}::text)
          AND (${search}::text  IS NULL OR name ILIKE ${search}::text OR code ILIKE ${search}::text)
          AND (${statusBucket}::text IS NULL OR
               (CASE WHEN closing_balance > 0 THEN 'funded' ELSE 'empty' END) = ${statusBucket}::text)
        ORDER BY closing_balance ASC NULLS LAST
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        WITH dealer_balance AS (
          SELECT
            d.pay_mode::text AS pay_mode,
            d.name, d.code,
            r.id AS route_id,
            (
              COALESCE(d.opening_balance, 0)
              + COALESCE((
                  SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                                  WHEN dl.type = 'debit'  THEN -dl.amount END)
                    FROM dealer_ledger dl
                   WHERE dl.dealer_id = d.id
                     AND COALESCE(dl.voucher_type, '') <> 'Opening'
                ), 0)
            )::numeric AS closing_balance
          FROM dealers d
          LEFT JOIN routes r ON r.id = d.route_id
          WHERE d.deleted_at IS NULL
        )
        SELECT count(*)::int AS count
        FROM dealer_balance
        WHERE
          (${routeId}::uuid IS NULL OR route_id = ${routeId}::uuid)
          AND (${payMode}::text IS NULL OR pay_mode = ${payMode}::text)
          AND (${search}::text  IS NULL OR name ILIKE ${search}::text OR code ILIKE ${search}::text)
          AND (${statusBucket}::text IS NULL OR
               (CASE WHEN closing_balance > 0 THEN 'funded' ELSE 'empty' END) = ${statusBucket}::text)
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/credit-control/summary                       │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/credit-control/summary",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (_request, reply) => {
      const [s] = await pgClient`
        WITH dealer_balance AS (
          SELECT
            (
              COALESCE(d.opening_balance, 0)
              + COALESCE((
                  SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                                  WHEN dl.type = 'debit'  THEN -dl.amount END)
                    FROM dealer_ledger dl
                   WHERE dl.dealer_id = d.id
                     AND COALESCE(dl.voucher_type, '') <> 'Opening'
                ), 0)
            )::numeric AS closing_balance,
            (SELECT MAX(p.received_date) FROM payments p WHERE p.dealer_id = d.id) AS last_payment_at
          FROM dealers d
          WHERE d.deleted_at IS NULL
        )
        SELECT
          COALESCE(SUM(GREATEST(0,  closing_balance)), 0)::float8 AS "totalPrepaid",
          COALESCE(SUM(GREATEST(0, -closing_balance)), 0)::float8 AS "totalExposure",
          COUNT(*) FILTER (WHERE closing_balance >  0)::int AS "fundedCount",
          COUNT(*) FILTER (WHERE closing_balance <= 0)::int AS "emptyCount",
          COUNT(*) FILTER (WHERE closing_balance <  0)::int AS "negativeCount",
          COUNT(*) FILTER (WHERE (last_payment_at IS NULL OR last_payment_at < CURRENT_DATE - 30)
                             AND -closing_balance > 0)::int AS "dormantWithDuesCount"
        FROM dealer_balance
      `;
      return reply.send({ summary: s });
    }
  );
}
