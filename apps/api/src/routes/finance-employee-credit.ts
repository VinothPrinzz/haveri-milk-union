// apps/api/src/routes/finance-employee-credit.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Employee Credit
//
//   GET   /api/v1/finance/employee-credit-control            — paginated list
//   GET   /api/v1/finance/employee-credit-control/summary    — KPI tiles
//   PATCH /api/v1/finance/employee-credit-control/:id/limit  — set credit limit
//   POST  /api/v1/finance/employee-orders/:id/release        — release a held
//                                                               (payment_required)
//                                                               employee indent
//
// The employee mirror of finance-credit-control.ts. Employees have their own
// credit_limit / opening_balance (0048) and employee_ledger. Same closing-
// balance maths as the dealer credit pages.
//
// Reads require finance.view. Credit-limit mutation + held-order release
// require finance.manage (accountant / super_admin). Employees have no app /
// payment flow, so when an auto-placed indent goes over limit it parks as
// 'payment_required' and a finance user releases it here.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function financeEmployeeCreditRoutes(app: FastifyInstance) {
  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/employee-credit-control                      │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/employee-credit-control",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        routeId: z.string().uuid().optional(),
        search: z.string().optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);

      const routeId = q.routeId ?? null;
      const search = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        WITH emp_balance AS (
          SELECT
            e.id,
            e.employee_code AS code,
            e.name,
            r.id   AS route_id,
            r.name AS route_name,
            COALESCE(e.credit_limit, 0)::numeric AS credit_limit,
            (
              COALESCE(e.opening_balance, 0)
              + COALESCE((
                  SELECT SUM(CASE WHEN el.type = 'credit' THEN el.amount
                                  WHEN el.type = 'debit'  THEN -el.amount END)
                    FROM employee_ledger el
                   WHERE el.employee_id = e.id
                     AND COALESCE(el.voucher_type, '') <> 'Opening'
                ), 0)
            )::numeric AS closing_balance,
            (
              SELECT COUNT(*) FROM employee_orders eo
               WHERE eo.employee_id = e.id AND eo.status = 'payment_required'
            )::int AS held_count
          FROM employees e
          LEFT JOIN routes r ON r.id = e.route_id AND r.deleted_at IS NULL
          WHERE e.deleted_at IS NULL AND e.active = true
        )
        SELECT
          id, code, name, route_id, route_name,
          credit_limit::float8                                AS "creditLimit",
          GREATEST(0, -closing_balance)::float8               AS outstanding,
          closing_balance::float8                             AS "closingBalance",
          GREATEST(0, credit_limit + closing_balance)::float8 AS "availableCredit",
          held_count                                          AS "heldCount",
          CASE
            WHEN credit_limit = 0                        THEN 'no_limit'
            WHEN -closing_balance > credit_limit         THEN 'over_limit'
            WHEN -closing_balance >= credit_limit * 0.90 THEN 'critical'
            WHEN -closing_balance >= credit_limit * 0.75 THEN 'warning'
            ELSE 'healthy'
          END                                                 AS "statusBucket"
        FROM emp_balance
        WHERE
          (${routeId}::uuid IS NULL OR route_id = ${routeId}::uuid)
          AND (${search}::text IS NULL OR name ILIKE ${search}::text OR code ILIKE ${search}::text)
        ORDER BY
          CASE WHEN -closing_balance > credit_limit AND credit_limit > 0 THEN 0 ELSE 1 END,
          name
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
          FROM employees e
          LEFT JOIN routes r ON r.id = e.route_id AND r.deleted_at IS NULL
         WHERE e.deleted_at IS NULL AND e.active = true
           AND (${routeId}::uuid IS NULL OR e.route_id = ${routeId}::uuid)
           AND (${search}::text IS NULL OR e.name ILIKE ${search}::text OR e.employee_code ILIKE ${search}::text)
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/employee-credit-control/summary              │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/employee-credit-control/summary",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (_request, reply) => {
      const [s] = await pgClient`
        WITH emp_balance AS (
          SELECT
            COALESCE(e.credit_limit, 0)::numeric AS credit_limit,
            (
              COALESCE(e.opening_balance, 0)
              + COALESCE((
                  SELECT SUM(CASE WHEN el.type = 'credit' THEN el.amount
                                  WHEN el.type = 'debit'  THEN -el.amount END)
                    FROM employee_ledger el
                   WHERE el.employee_id = e.id
                     AND COALESCE(el.voucher_type, '') <> 'Opening'
                ), 0)
            )::numeric AS closing_balance
          FROM employees e
          WHERE e.deleted_at IS NULL AND e.active = true
        )
        SELECT
          COALESCE(SUM(GREATEST(0, -closing_balance)), 0)::float8 AS "totalExposure",
          COALESCE(SUM(GREATEST(0, credit_limit + closing_balance)), 0)::float8 AS "totalAvailable",
          COALESCE(SUM(credit_limit), 0)::float8 AS "totalLimitSanctioned",
          COUNT(*) FILTER (WHERE credit_limit > 0 AND -closing_balance > credit_limit)::int AS "overLimitCount",
          (SELECT COUNT(*) FROM employee_orders WHERE status = 'payment_required')::int AS "heldCount"
        FROM emp_balance
      `;
      return reply.send({ summary: s });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/employee-orders/held                         │
  // │  Indents parked as 'payment_required' (over credit limit), the    │
  // │  worklist finance releases from.                                  │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/employee-orders/held",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (_request, reply) => {
      const rows = await pgClient`
        SELECT
          eo.id,
          eo.delivery_date::text     AS "deliveryDate",
          eo.grand_total::float8     AS "grandTotal",
          eo.item_count              AS "itemCount",
          eo.created_at              AS "createdAt",
          e.id                       AS "employeeId",
          e.name                     AS "employeeName",
          e.employee_code            AS "employeeCode"
        FROM employee_orders eo
        JOIN employees e ON e.id = eo.employee_id
        WHERE eo.status = 'payment_required'
        ORDER BY eo.delivery_date DESC, e.name
        LIMIT 500
      `;
      return reply.send({ data: rows });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  PATCH /api/v1/finance/employee-credit-control/:employeeId/limit  │
  // └─────────────────────────────────────────────────────────────────┘
  app.patch(
    "/api/v1/finance/employee-credit-control/:employeeId/limit",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { employeeId } = z
        .object({ employeeId: z.string().uuid() })
        .parse(request.params);
      const { creditLimit } = z
        .object({ creditLimit: z.number().min(0).max(100_000_000) })
        .parse(request.body);

      const [updated] = await pgClient`
        UPDATE employees
           SET credit_limit = ${creditLimit}, updated_at = now()
         WHERE id = ${employeeId} AND deleted_at IS NULL
         RETURNING id, name, employee_code AS code, COALESCE(credit_limit, 0)::float8 AS "creditLimit"
      `;

      if (!updated) {
        return reply.status(404).send({ error: "Not Found", message: "Employee not found" });
      }
      return reply.send({ employee: updated });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  POST /api/v1/finance/employee-orders/:id/release                 │
  // │  Force-confirm a held (payment_required) employee indent and post │
  // │  the employee_ledger debit. Finance override of the credit limit. │
  // └─────────────────────────────────────────────────────────────────┘
  app.post(
    "/api/v1/finance/employee-orders/:id/release",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const [order] = await pgClient`
        SELECT id, employee_id AS "employeeId", status::text AS status,
               grand_total::numeric AS grand_total, item_count
          FROM employee_orders
         WHERE id = ${id}::uuid
         LIMIT 1
      `;
      if (!order) {
        return reply.status(404).send({ error: "Employee order not found" });
      }
      if (order.status !== "payment_required" && order.status !== "draft") {
        return reply.status(409).send({
          error: "Not releasable",
          message: `Order is '${order.status}', not awaiting release.`,
        });
      }
      if (order.item_count === 0) {
        return reply.status(400).send({ error: "Empty order", message: "Nothing to release." });
      }

      const grandTotal = parseFloat(order.grand_total);
      const performedBy = (request as any).admin?.userId ?? null;

      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        await tx`
          UPDATE employee_orders
             SET status = 'confirmed', payment_mode = 'credit',
                 confirmed_at = COALESCE(confirmed_at, now()), updated_at = now()
           WHERE id = ${id}::uuid
        `;

        const [bal] = await tx`
          SELECT
            COALESCE(e.opening_balance, 0)
            + COALESCE((SELECT SUM(CASE WHEN el.type = 'credit'
                                         AND COALESCE(el.voucher_type,'') <> 'Opening'
                                        THEN el.amount ELSE 0 END)
                          FROM employee_ledger el WHERE el.employee_id = e.id), 0)
            - COALESCE((SELECT SUM(CASE WHEN el.type = 'debit'
                                         AND COALESCE(el.voucher_type,'') <> 'Opening'
                                        THEN el.amount ELSE 0 END)
                          FROM employee_ledger el WHERE el.employee_id = e.id), 0)
            AS bal
          FROM employees e WHERE e.id = ${order.employeeId}
        `;
        const balanceAfter = parseFloat(bal!.bal) - grandTotal;

        await tx`
          INSERT INTO employee_ledger
            (employee_id, type, amount, reference_id, reference_type,
             voucher_type, voucher_date, description, balance_after, performed_by)
          VALUES
            (${order.employeeId}, 'debit', ${grandTotal.toFixed(2)}::numeric,
             ${id}, 'order', 'Invoice', now()::date,
             ${"Released employee standing-indent order " + id},
             ${balanceAfter.toFixed(2)}::numeric, ${performedBy})
        `;
      });

      return reply.send({ orderId: id, status: "confirmed", released: true });
    }
  );
}
