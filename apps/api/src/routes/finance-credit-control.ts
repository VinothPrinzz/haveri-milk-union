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
// ── AS-ON DATE ────────────────────────────────────────────────────────
// Every figure on this screen is computed as at the END of the `asOf` IST
// calendar day, defaulting to today. Finance reconciles a route's
// collections for a past period against the balances customers were
// actually holding then, so "now" is not good enough.
//
// This is reconstructable because `dealer_ledger` is append-only in
// application code and a row's voucher/created date never changes: the
// balance on any past date is just the same fold with an upper bound. That
// is also why the ledger model is kept here rather than switching to the
// orders+payments derivation Dealer Statements uses — this expression is
// the one checkDealerCredit gates indents on, and the two must agree.
//
// Reads require finance.view. (The old set-credit-limit mutation was removed
// when limits were dropped in favour of the prepaid balance model.)
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";
import { isoDate, istToday } from "../lib/ist-date.js";

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
        asOf:         isoDate.optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);

      const routeId      = q.routeId ?? null;
      const payMode      = q.payMode ?? null;
      const statusBucket = q.statusBucket ?? null;
      const search       = q.search ? `%${q.search}%` : null;
      const asOf         = q.asOf ?? istToday();

      // NOTE: the balance fold below is repeated verbatim in the count and
      // summary queries. Do NOT extract it into a nested pgClient fragment:
      // diag-explain-changed-queries.ts sweeps each tagged literal statically,
      // so a fragment would be EXPLAINed on its own as a bare expression and
      // fail. If you edit one copy, edit all three.
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
                     -- COALESCE is load-bearing: several insert paths (the
                     -- wallet top-up among them) write no voucher_date, so
                     -- bounding voucher_date alone would drop those rows.
                     AND COALESCE(dl.voucher_date,
                                  (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date)
                         <= ${asOf}::date
                ), 0)
            )::numeric AS closing_balance,
            (SELECT MAX(p.received_date) FROM payments p
               WHERE p.dealer_id = d.id
                 AND p.received_date <= ${asOf}::date)                             AS last_payment_at,
            (SELECT MAX(o.created_at) FROM orders o
               WHERE o.dealer_id = d.id AND o.status <> 'cancelled'
                 AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date <= ${asOf}::date) AS last_order_at
          FROM dealers d
          LEFT JOIN routes r ON r.id = d.route_id
          LEFT JOIN zones  z ON z.id = d.zone_id
          -- Membership is judged AS AT the as-on date, at BOTH ends of the
          -- customer's life. One onboarded after it did not exist then, and
          -- would otherwise show up carrying a phantom opening balance. One
          -- deleted after it was still on the books then, and their balance
          -- belongs in that day's total: testing deleted_at IS NULL on its
          -- own evaluates deletion at QUERY time, so removing a dealer
          -- silently rewrote every PAST month's closing balance and stranded
          -- whatever they still held.
          -- NOTE: no backticks in these comments - the whole query is a
          -- tagged template literal and a backtick would terminate it.
          WHERE (d.deleted_at IS NULL
                 OR (d.deleted_at AT TIME ZONE 'Asia/Kolkata')::date > ${asOf}::date)
            AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date <= ${asOf}::date
            -- Play Store demo route: a reviewer's test activity is not the union's
            -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
            AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                             WHERE demo_rt.code = 'DEMO'
                               AND demo_rt.id = d.route_id)
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
               ELSE (${asOf}::date - last_payment_at) END        AS "daysSinceLastPayment"
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
                     AND COALESCE(dl.voucher_date,
                                  (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date)
                         <= ${asOf}::date
                ), 0)
            )::numeric AS closing_balance
          FROM dealers d
          LEFT JOIN routes r ON r.id = d.route_id
          WHERE (d.deleted_at IS NULL
                 OR (d.deleted_at AT TIME ZONE 'Asia/Kolkata')::date > ${asOf}::date)
            AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date <= ${asOf}::date
            -- Play Store demo route: a reviewer's test activity is not the union's
            -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
            AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                             WHERE demo_rt.code = 'DEMO'
                               AND demo_rt.id = d.route_id)
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
  // The tiles are a "this route, as at this date" rollup, so they follow
  // `asOf` and `routeId` only. `search`, `payMode` and `statusBucket` are
  // deliberately NOT applied: statusBucket in particular would make the
  // funded/empty counts self-referential.
  app.get(
    "/api/v1/finance/credit-control/summary",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z.object({
        routeId: z.string().uuid().optional(),
        asOf:    isoDate.optional(),
      }).parse(request.query);

      const routeId = q.routeId ?? null;
      const asOf    = q.asOf ?? istToday();

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
                     AND COALESCE(dl.voucher_date,
                                  (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date)
                         <= ${asOf}::date
                ), 0)
            )::numeric AS closing_balance,
            (SELECT MAX(p.received_date) FROM payments p
               WHERE p.dealer_id = d.id
                 AND p.received_date <= ${asOf}::date) AS last_payment_at
          FROM dealers d
          LEFT JOIN routes r ON r.id = d.route_id
          WHERE (d.deleted_at IS NULL
                 OR (d.deleted_at AT TIME ZONE 'Asia/Kolkata')::date > ${asOf}::date)
            AND (d.created_at AT TIME ZONE 'Asia/Kolkata')::date <= ${asOf}::date
            -- Play Store demo route: a reviewer's test activity is not the union's
            -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
            AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                             WHERE demo_rt.code = 'DEMO'
                               AND demo_rt.id = d.route_id)
            AND (${routeId}::uuid IS NULL OR r.id = ${routeId}::uuid)
        )
        SELECT
          COALESCE(SUM(GREATEST(0,  closing_balance)), 0)::float8 AS "totalPrepaid",
          COALESCE(SUM(GREATEST(0, -closing_balance)), 0)::float8 AS "totalExposure",
          COUNT(*) FILTER (WHERE closing_balance >  0)::int AS "fundedCount",
          COUNT(*) FILTER (WHERE closing_balance <= 0)::int AS "emptyCount",
          COUNT(*) FILTER (WHERE closing_balance <  0)::int AS "negativeCount",
          COUNT(*) FILTER (WHERE (last_payment_at IS NULL OR last_payment_at < ${asOf}::date - 30)
                             AND -closing_balance > 0)::int AS "dormantWithDuesCount"
        FROM dealer_balance
      `;
      return reply.send({ summary: s });
    }
  );
}
