// apps/api/src/routes/finance-credit-control.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Credit Control
//
//   GET   /api/v1/finance/credit-control          — paginated dealer list
//   GET   /api/v1/finance/credit-control/summary  — KPI tiles
//   PATCH /api/v1/finance/credit-control/:dealerId/limit — set credit limit
//
// One row per dealer: credit limit, closing balance, outstanding,
// available headroom, utilisation. Uses the SAME closing-balance math
// as checkDealerCredit() (opening_balance + non-Opening ledger net), so
// a dealer the system blocks at checkout also shows as over-limit here.
//
// Reads require finance.view. The ONLY credit-limit mutation in the whole
// API lives here and requires finance.manage (accountant / super_admin) —
// the dealer-master endpoints deliberately do NOT accept credit_limit, so
// managers cannot change it. Credit limits are a finance responsibility.
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
        statusBucket: z.enum(["over_limit", "critical", "warning", "healthy", "no_limit"]).optional(),
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
            d.id,
            d.code,
            d.name,
            d.pay_mode::text                    AS pay_mode,
            COALESCE(d.credit_limit, 0)::numeric AS credit_limit,
            COALESCE(d.opening_balance, 0)::numeric AS opening_balance,
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
          credit_limit::float8                                  AS "creditLimit",
          GREATEST(0, -closing_balance)::float8                 AS outstanding,
          GREATEST(0,  closing_balance)::float8                 AS prepaid,
          closing_balance::float8                               AS "closingBalance",
          GREATEST(0, credit_limit + closing_balance)::float8   AS "availableCredit",
          CASE
            WHEN credit_limit > 0
              THEN ROUND(LEAST(999, GREATEST(0, -closing_balance) / credit_limit * 100))::int
            ELSE NULL
          END                                                   AS "utilizationPct",
          CASE
            WHEN credit_limit = 0                        THEN 'no_limit'
            WHEN -closing_balance > credit_limit         THEN 'over_limit'
            WHEN -closing_balance >= credit_limit * 0.90 THEN 'critical'
            WHEN -closing_balance >= credit_limit * 0.75 THEN 'warning'
            ELSE 'healthy'
          END                                                   AS "statusBucket",
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
               CASE
                 WHEN credit_limit = 0                        THEN 'no_limit'
                 WHEN -closing_balance > credit_limit         THEN 'over_limit'
                 WHEN -closing_balance >= credit_limit * 0.90 THEN 'critical'
                 WHEN -closing_balance >= credit_limit * 0.75 THEN 'warning'
                 ELSE 'healthy'
               END = ${statusBucket}::text)
        ORDER BY
          CASE
            WHEN credit_limit = 0                        THEN 5
            WHEN -closing_balance > credit_limit         THEN 1
            WHEN -closing_balance >= credit_limit * 0.90 THEN 2
            WHEN -closing_balance >= credit_limit * 0.75 THEN 3
            ELSE 4
          END,
          -closing_balance DESC NULLS LAST
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        WITH dealer_balance AS (
          SELECT
            d.pay_mode::text AS pay_mode,
            d.name, d.code,
            COALESCE(d.credit_limit, 0)::numeric AS credit_limit,
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
               CASE
                 WHEN credit_limit = 0                        THEN 'no_limit'
                 WHEN -closing_balance > credit_limit         THEN 'over_limit'
                 WHEN -closing_balance >= credit_limit * 0.90 THEN 'critical'
                 WHEN -closing_balance >= credit_limit * 0.75 THEN 'warning'
                 ELSE 'healthy'
               END = ${statusBucket}::text)
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
            COALESCE(d.credit_limit, 0)::numeric AS credit_limit,
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
          COALESCE(SUM(GREATEST(0, -closing_balance)), 0)::float8 AS "totalExposure",
          COALESCE(SUM(GREATEST(0,  closing_balance)), 0)::float8 AS "totalPrepaid",
          COALESCE(SUM(GREATEST(0, credit_limit + closing_balance)), 0)::float8 AS "totalAvailable",
          COALESCE(SUM(credit_limit), 0)::float8 AS "totalLimitSanctioned",
          COUNT(*) FILTER (WHERE credit_limit > 0 AND -closing_balance > credit_limit)::int AS "overLimitCount",
          COUNT(*) FILTER (WHERE credit_limit > 0
                             AND -closing_balance >= credit_limit * 0.90
                             AND -closing_balance <= credit_limit)::int AS "criticalCount",
          COUNT(*) FILTER (WHERE credit_limit > 0
                             AND -closing_balance >= credit_limit * 0.75
                             AND -closing_balance <  credit_limit * 0.90)::int AS "warningCount",
          COUNT(*) FILTER (WHERE (last_payment_at IS NULL OR last_payment_at < CURRENT_DATE - 30)
                             AND -closing_balance > 0)::int AS "dormantWithDuesCount"
        FROM dealer_balance
      `;
      return reply.send({ summary: s });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  PATCH /api/v1/finance/credit-control/:dealerId/limit             │
  // │  Set a dealer's credit limit. Finance-only (finance.manage).      │
  // └─────────────────────────────────────────────────────────────────┘
  app.patch(
    "/api/v1/finance/credit-control/:dealerId/limit",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { dealerId } = z
        .object({ dealerId: z.string().uuid() })
        .parse(request.params);
      const { creditLimit } = z
        .object({ creditLimit: z.number().min(0).max(100_000_000) })
        .parse(request.body);

      const [updated] = await pgClient`
        UPDATE dealers
           SET credit_limit = ${creditLimit}, updated_at = now()
         WHERE id = ${dealerId} AND deleted_at IS NULL
         RETURNING id, name, code, COALESCE(credit_limit, 0)::float8 AS "creditLimit"
      `;

      if (!updated) {
        return reply.status(404).send({ error: "Not Found", message: "Dealer not found" });
      }
      return reply.send({ dealer: updated });
    }
  );
}
