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
//   GET   /api/v1/finance/employee-recoveries/due            — who owes, per month
//   GET   /api/v1/finance/employee-recoveries                — recoveries in a month
//   POST  /api/v1/finance/employee-recoveries                — record salary deductions
//   POST  /api/v1/finance/employee-recoveries/:id/reverse    — undo one keyed in error
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
import { assertEmployeeOrderNoOversell } from "../lib/stock-check.js";
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
        // A draft commits its stock right here (migration 0072) — refuse if
        // the sheet can't cover it. A payment_required indent already holds it.
        if (order.status === "draft") await assertEmployeeOrderNoOversell(tx, id);

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

  // ════════════════════════════════════════════════════════════════════
  // Salary recovery
  //
  // Employee subsidy goods (the ghee sachet, HTM 1000ML sub …) are supplied
  // on credit: confirming the indent writes an employee_ledger DEBIT. The
  // money comes back by deduction from the employee's salary. Finance
  // records each deduction here as a CREDIT on the same ledger, so the
  // employee's outstanding falls as and when it is recovered.
  //
  //   reference_type 'salary_recovery'           — the recovery (credit)
  //   reference_type 'salary_recovery_reversal'  — undoing one keyed in
  //                                                error (a debit that
  //                                                points back at it)
  //
  // The ledger is append-only, so a mistake is reversed, never deleted.
  // ════════════════════════════════════════════════════════════════════

  // Closing balance of one employee (opening + credits − debits, the same
  // maths as the credit-control list above). Negative = the employee owes.
  const balanceOf = async (tx: typeof pgClient, employeeId: string) => {
    const [b] = await tx`
      SELECT
        COALESCE(e.opening_balance, 0)
        + COALESCE((SELECT SUM(CASE WHEN el.type = 'credit' THEN el.amount
                                    WHEN el.type = 'debit'  THEN -el.amount END)
                      FROM employee_ledger el
                     WHERE el.employee_id = e.id
                       AND COALESCE(el.voucher_type, '') <> 'Opening'), 0) AS bal
      FROM employees e WHERE e.id = ${employeeId}::uuid
    `;
    return b ? parseFloat(b.bal) : null;
  };

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/employee-recoveries/due                      │
  // │  Every active employee who owes money, with what is outstanding   │
  // │  and what has already been recovered in the given month.          │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/employee-recoveries/due",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        search: z.string().optional(),
      }).parse(request.query);
      const monthStart = `${q.month}-01`;
      const search = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        WITH bal AS (
          SELECT e.id, e.employee_code AS code, e.name, e.department,
                 r.name AS route_name,
                 (COALESCE(e.opening_balance, 0)
                  + COALESCE((SELECT SUM(CASE WHEN el.type = 'credit' THEN el.amount
                                              WHEN el.type = 'debit'  THEN -el.amount END)
                                FROM employee_ledger el
                               WHERE el.employee_id = e.id
                                 AND COALESCE(el.voucher_type, '') <> 'Opening'), 0))::numeric AS closing,
                 COALESCE((SELECT SUM(CASE WHEN el.reference_type = 'salary_recovery' THEN el.amount
                                           ELSE -el.amount END)
                             FROM employee_ledger el
                            WHERE el.employee_id = e.id
                              AND el.reference_type IN ('salary_recovery', 'salary_recovery_reversal')
                              AND el.voucher_date >= ${monthStart}::date
                              AND el.voucher_date <  ${monthStart}::date + interval '1 month'), 0)::numeric
                   AS recovered_in_month
          FROM employees e
          LEFT JOIN routes r ON r.id = e.route_id AND r.deleted_at IS NULL
          WHERE e.deleted_at IS NULL
            AND (${search}::text IS NULL OR e.name ILIKE ${search}::text OR e.employee_code ILIKE ${search}::text)
        )
        SELECT id, code, name, department, route_name AS "routeName",
               GREATEST(0, -closing)::float8   AS outstanding,
               recovered_in_month::float8      AS "recoveredInMonth"
          FROM bal
         WHERE closing < 0 OR recovered_in_month <> 0
         ORDER BY code NULLS LAST, name
      `;
      return reply.send({ month: q.month, data: rows });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  POST /api/v1/finance/employee-recoveries                         │
  // │  Record one or more salary deductions in a single transaction.    │
  // │  Each line is capped at what the employee owes, so a typo cannot  │
  // │  push an employee into credit.                                    │
  // └─────────────────────────────────────────────────────────────────┘
  app.post(
    "/api/v1/finance/employee-recoveries",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const body = z.object({
        recoveryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        salaryMonth: z.string().regex(/^\d{4}-\d{2}$/),
        note: z.string().max(200).optional(),
        items: z.array(z.object({
          employeeId: z.string().uuid(),
          amount: z.number().positive().max(10_000_000),
        })).min(1).max(1000),
      }).parse(request.body);

      const ids = body.items.map(i => i.employeeId);
      if (new Set(ids).size !== ids.length) {
        return reply.status(400).send({ error: "Duplicate employee", message: "Each employee may appear once per batch." });
      }

      const performedBy = (request as any).admin?.userId ?? null;
      const [y, m] = body.salaryMonth.split("-").map(Number);
      const monthLabel = new Date(Date.UTC(y!, m! - 1, 1))
        .toLocaleString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
      const note = body.note?.trim();

      type Problem = { employeeId: string; name: string; amount: number; outstanding: number };
      const problems: Problem[] = [];
      const posted: Array<{ employeeId: string; ledgerId: string; amount: number; balanceAfter: number }> = [];

      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        // Lock the employees in a fixed order so two finance users posting
        // overlapping batches serialise instead of deadlocking, and neither
        // can recover the same rupee twice.
        const emps = await tx`
          SELECT id, name FROM employees
           WHERE id = ANY(${ids}::uuid[]) AND deleted_at IS NULL
           ORDER BY id
           FOR UPDATE
        `;
        const nameById = new Map((emps as any[]).map(e => [e.id, e.name]));

        for (const item of body.items) {
          const name = nameById.get(item.employeeId);
          const bal = name === undefined ? null : await balanceOf(tx, item.employeeId);
          const outstanding = bal == null ? 0 : Math.max(0, Math.round(-bal * 100) / 100);
          const amount = Math.round(item.amount * 100) / 100;
          if (bal == null || amount > outstanding + 0.001) {
            problems.push({ employeeId: item.employeeId, name: name ?? "Unknown employee", amount, outstanding });
            continue;
          }
          const balanceAfter = Math.round((bal + amount) * 100) / 100;
          const [row] = await tx`
            INSERT INTO employee_ledger
              (employee_id, type, amount, reference_type, voucher_type, voucher_date,
               description, balance_after, performed_by)
            VALUES
              (${item.employeeId}::uuid, 'credit', ${amount.toFixed(2)}::numeric,
               'salary_recovery', 'Salary Recovery', ${body.recoveryDate}::date,
               ${`Salary recovery ${monthLabel}${note ? ` - ${note}` : ""}`},
               ${balanceAfter.toFixed(2)}::numeric, ${performedBy})
            RETURNING id
          `;
          posted.push({ employeeId: item.employeeId, ledgerId: row!.id, amount, balanceAfter });
        }

        // All or nothing: one bad line rolls the batch back, so finance
        // fixes it and posts again rather than chasing a half-posted run.
        if (problems.length > 0) throw new RecoveryRejected();
      }).catch((e: unknown) => {
        if (!(e instanceof RecoveryRejected)) throw e;
      });

      if (problems.length > 0) {
        return reply.status(409).send({
          error: "Recovery exceeds outstanding",
          message: problems
            .map(p => `${p.name}: ₹${p.amount.toFixed(2)} entered, ₹${p.outstanding.toFixed(2)} outstanding`)
            .join("; "),
          problems,
        });
      }
      return reply.status(201).send({
        posted: posted.length,
        total: Math.round(posted.reduce((s, p) => s + p.amount, 0) * 100) / 100,
        entries: posted,
      });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/finance/employee-recoveries?month=YYYY-MM            │
  // │  Recoveries posted in the month (by recovery date).               │
  // └─────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/finance/employee-recoveries",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(request.query);
      const monthStart = `${q.month}-01`;
      const rows = await pgClient`
        SELECT el.id,
               el.voucher_date::text AS "recoveryDate",
               el.amount::float8     AS amount,
               el.description,
               el.created_at         AS "createdAt",
               e.id                  AS "employeeId",
               e.employee_code       AS "employeeCode",
               e.name                AS "employeeName",
               u.name                AS "postedBy",
               rv.voucher_date::text AS "reversedOn"
          FROM employee_ledger el
          JOIN employees e ON e.id = el.employee_id
          LEFT JOIN users u ON u.id = el.performed_by
          LEFT JOIN employee_ledger rv
                 ON rv.reference_id = el.id AND rv.reference_type = 'salary_recovery_reversal'
         WHERE el.reference_type = 'salary_recovery'
           AND el.voucher_date >= ${monthStart}::date
           AND el.voucher_date <  ${monthStart}::date + interval '1 month'
         ORDER BY el.voucher_date DESC, el.created_at DESC
      `;
      return reply.send({ month: q.month, data: rows });
    }
  );

  // ┌─────────────────────────────────────────────────────────────────┐
  // │  POST /api/v1/finance/employee-recoveries/:id/reverse             │
  // │  Undo a recovery keyed in error: a matching debit that points     │
  // │  back at it. Each recovery can be reversed once.                  │
  // └─────────────────────────────────────────────────────────────────┘
  app.post(
    "/api/v1/finance/employee-recoveries/:id/reverse",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const performedBy = (request as any).admin?.userId ?? null;

      const result = await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        const [orig] = await tx`
          SELECT id, employee_id, amount::numeric AS amount
            FROM employee_ledger
           WHERE id = ${id}::uuid AND reference_type = 'salary_recovery'
           FOR UPDATE
        `;
        if (!orig) return { status: 404 as const };
        await tx`SELECT id FROM employees WHERE id = ${orig.employee_id} FOR UPDATE`;
        const [done] = await tx`
          SELECT 1 FROM employee_ledger
           WHERE reference_id = ${id}::uuid AND reference_type = 'salary_recovery_reversal'
           LIMIT 1
        `;
        if (done) return { status: 409 as const };

        const amount = parseFloat(orig.amount);
        const bal = (await balanceOf(tx, orig.employee_id)) ?? 0;
        await tx`
          INSERT INTO employee_ledger
            (employee_id, type, amount, reference_id, reference_type, voucher_type,
             voucher_date, description, balance_after, performed_by)
          VALUES
            (${orig.employee_id}, 'debit', ${amount.toFixed(2)}::numeric,
             ${id}::uuid, 'salary_recovery_reversal', 'Salary Recovery Reversal',
             (now() AT TIME ZONE 'Asia/Kolkata')::date,
             ${"Reversal of salary recovery " + id},
             ${(bal - amount).toFixed(2)}::numeric, ${performedBy})
        `;
        return { status: 200 as const };
      });

      if (result.status === 404) return reply.status(404).send({ error: "Recovery not found" });
      if (result.status === 409) return reply.status(409).send({ error: "Already reversed", message: "This recovery has already been reversed." });
      return reply.send({ id, reversed: true });
    }
  );
}

/** Thrown inside the recovery transaction to roll back a batch with a bad line. */
class RecoveryRejected extends Error {}
