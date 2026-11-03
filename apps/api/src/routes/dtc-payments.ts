// apps/api/src/routes/dtc-payments.ts
// ═══════════════════════════════════════════════════════════════════════
// DTC Billing → Payments and advances
//
//   GET  /api/v1/dtc/payments/pending          approved bills not yet paid
//   GET  /api/v1/dtc/payments?from&to          payment history
//   POST /api/v1/dtc/payments                  { billIds, paidOn, mode, reference }
//   POST /api/v1/dtc/payments/:id/reverse      { reason }
//   GET  /api/v1/dtc/advances                  advances and whether recovered
//   POST /api/v1/dtc/advances                  record an advance paid
//   POST /api/v1/dtc/advances/:id/cancel       { reason }
//
// A bill is paid in full, once (unique live payment per bill). Several bills
// of one contractor can share one bank transfer / UTR. Bills on hold, not yet
// approved, or with nothing payable cannot be paid.
// ═══════════════════════════════════════════════════════════════════════
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { isoDate, istToday } from "../lib/ist-date.js";
import { HttpError, logEvent, monthParam, requestAdmin, type Sql } from "../lib/dtc.js";
import { dtcRoute, parseWith } from "../lib/dtc-http.js";

const MODES = ["neft", "rtgs", "imps", "upi", "cheque", "cash"] as const;
const uuidParam = z.object({ id: z.string().uuid() });

export async function dtcPaymentRoutes(app: FastifyInstance) {
  dtcRoute(app, "get", "/api/v1/dtc/payments/pending", "dtc.view", async () => {
    const rows = await pgClient`
      SELECT b.id AS "billId", to_char(r.bill_month, 'YYYY-MM') AS month,
             b.route_code AS "routeCode", b.route_name AS "routeName",
             b.contractor_id AS "contractorId", COALESCE(c.name, b.contractor_name) AS "contractorName",
             c.code AS "contractorCode", c.bank_name AS "bankName", c.account_no AS "accountNo",
             c.ifsc_code AS "ifscCode", b.payable_amount::float8 AS payable,
             b.on_hold AS "onHold", b.hold_reason AS "holdReason"
        FROM dtc_bills b
        JOIN dtc_bill_runs r ON r.id = b.run_id
        LEFT JOIN contractors c ON c.id = b.contractor_id
       WHERE r.status = 'approved' AND b.payable_amount > 0
         AND NOT EXISTS (SELECT 1 FROM dtc_payments pm WHERE pm.bill_id = b.id AND pm.reversed_at IS NULL)
       ORDER BY r.bill_month, COALESCE(c.name, b.contractor_name), b.route_code
    `;
    return { data: rows };
  });

  dtcRoute(app, "get", "/api/v1/dtc/payments", "dtc.view", async (request) => {
    const q = parseWith(z.object({ from: isoDate.optional(), to: isoDate.optional(), month: monthParam.optional() }), request.query);
    const rows = await pgClient`
      SELECT pm.id, pm.bill_id AS "billId", pm.amount::float8 AS amount, pm.paid_on::text AS "paidOn",
             pm.mode, pm.reference, pm.notes, pm.created_at AS "createdAt", u.name AS "createdByName",
             pm.reversed_at AS "reversedAt", ru.name AS "reversedByName", pm.reverse_reason AS "reverseReason",
             to_char(r.bill_month, 'YYYY-MM') AS month, b.route_code AS "routeCode", b.route_name AS "routeName",
             COALESCE(c.name, b.contractor_name) AS "contractorName"
        FROM dtc_payments pm
        JOIN dtc_bills b ON b.id = pm.bill_id
        JOIN dtc_bill_runs r ON r.id = b.run_id
        LEFT JOIN contractors c ON c.id = pm.contractor_id
        LEFT JOIN users u ON u.id = pm.created_by
        LEFT JOIN users ru ON ru.id = pm.reversed_by
       WHERE (${q.from ?? null}::date IS NULL OR pm.paid_on >= ${q.from ?? null}::date)
         AND (${q.to ?? null}::date IS NULL OR pm.paid_on <= ${q.to ?? null}::date)
         AND (${q.month ? q.month + "-01" : null}::date IS NULL OR r.bill_month = ${q.month ? q.month + "-01" : null}::date)
       ORDER BY pm.paid_on DESC, pm.created_at DESC
       LIMIT 500
    `;
    return { data: rows };
  });

  dtcRoute(app, "post", "/api/v1/dtc/payments", "dtc.pay", async (request, reply) => {
    const body = parseWith(z.object({
      billIds: z.array(z.string().uuid()).min(1).max(500),
      paidOn: isoDate,
      mode: z.enum(MODES),
      reference: z.string().trim().max(100).optional().nullable(),
      notes: z.string().trim().max(300).optional().nullable(),
    }), request.body);
    if (body.paidOn > istToday()) throw new HttpError(400, "Validation Error", "The payment date can't be in the future.");
    if (body.mode !== "cash" && !(body.reference ?? "").trim()) {
      throw new HttpError(400, "Validation Error", "Enter the UTR / cheque number.");
    }
    const { userId } = requestAdmin(request);
    const ids = Array.from(new Set(body.billIds));

    const result = await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const bills = await tx`
        SELECT b.id, b.run_id, b.contractor_id, b.route_code, b.payable_amount::float8 AS payable, b.on_hold,
               r.status, EXISTS (SELECT 1 FROM dtc_payments pm WHERE pm.bill_id = b.id AND pm.reversed_at IS NULL) AS paid
          FROM dtc_bills b JOIN dtc_bill_runs r ON r.id = b.run_id
         WHERE b.id = ANY(string_to_array(${ids.join(",")}, ',')::uuid[])
         FOR UPDATE OF b
      ` as any[];
      if (bills.length !== ids.length) throw new HttpError(404, "Not found", "Some bills were not found. Refresh the page.");
      for (const b of bills) {
        if (b.status !== "approved") throw new HttpError(409, "Not approved", `${b.route_code}: the bill is not approved yet.`);
        if (b.on_hold) throw new HttpError(409, "On hold", `${b.route_code}: the bill is on hold.`);
        if (b.paid) throw new HttpError(409, "Already paid", `${b.route_code}: the bill is already paid.`);
        if (!(b.payable > 0)) throw new HttpError(409, "Nothing to pay", `${b.route_code}: nothing is payable.`);
      }
      let total = 0;
      for (const b of bills) {
        await tx`
          INSERT INTO dtc_payments (bill_id, contractor_id, amount, paid_on, mode, reference, notes, created_by)
          VALUES (${b.id}::uuid, ${b.contractor_id}::uuid, ${b.payable.toFixed(2)}::numeric, ${body.paidOn}::date,
                  ${body.mode}, ${body.reference ?? null}, ${body.notes ?? null}, ${userId}::uuid)
        `;
        await logEvent(tx, {
          runId: b.run_id, billId: b.id, action: "paid",
          detail: `Paid ₹${b.payable.toFixed(2)} by ${body.mode.toUpperCase()}${body.reference ? ` (${body.reference})` : ""} on ${body.paidOn}`,
          userId,
        });
        total += b.payable;
      }
      return { count: bills.length, total };
    });
    return reply.status(201).send({
      message: `Recorded payment of ₹${result.total.toFixed(2)} for ${result.count} bill${result.count === 1 ? "" : "s"}`,
      ...result,
    });
  });

  dtcRoute(app, "post", "/api/v1/dtc/payments/:id/reverse", "dtc.pay", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const { reason } = parseWith(z.object({ reason: z.string().trim().min(5, "Say why (at least 5 characters)").max(300) }), request.body);
    const { userId } = requestAdmin(request);
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const [pm] = await tx`
        UPDATE dtc_payments SET reversed_at = now(), reversed_by = ${userId}::uuid, reverse_reason = ${reason}
         WHERE id = ${id}::uuid AND reversed_at IS NULL
        RETURNING bill_id, amount::float8 AS amount
      ` as any[];
      if (!pm) throw new HttpError(404, "Not found", "Payment not found or already reversed.");
      const [b] = await tx`SELECT run_id FROM dtc_bills WHERE id = ${pm.bill_id}::uuid` as any[];
      await logEvent(tx, {
        runId: b?.run_id, billId: pm.bill_id, action: "payment_reversed",
        detail: `Payment of ₹${pm.amount.toFixed(2)} reversed: ${reason}`, userId,
      });
    });
    return { message: "Payment reversed; the bill is unpaid again" };
  });

  // ── Advances ──
  dtcRoute(app, "get", "/api/v1/dtc/advances", "dtc.view", async () => {
    const rows = await pgClient`
      SELECT a.id, a.contractor_id AS "contractorId", c.name AS "contractorName",
             a.route_id AS "routeId", rt.code AS "routeCode",
             a.paid_on::text AS "paidOn", a.amount::float8 AS amount, a.mode, a.reference,
             to_char(a.recover_month, 'YYYY-MM') AS "recoverMonth", a.notes,
             a.cancelled_at AS "cancelledAt", a.cancel_reason AS "cancelReason",
             a.created_at AS "createdAt", u.name AS "createdByName",
             rec.month AS "recoveredInMonth", rec.status AS "recoveredRunStatus"
        FROM dtc_advances a
        JOIN contractors c ON c.id = a.contractor_id
        LEFT JOIN routes rt ON rt.id = a.route_id
        LEFT JOIN users u ON u.id = a.created_by
        LEFT JOIN LATERAL (
          SELECT to_char(r.bill_month, 'YYYY-MM') AS month, r.status
            FROM dtc_bill_lines l JOIN dtc_bills b ON b.id = l.bill_id JOIN dtc_bill_runs r ON r.id = b.run_id
           WHERE l.head = 'advance' AND l.source_ref = a.id
           ORDER BY r.bill_month LIMIT 1
        ) rec ON true
       ORDER BY a.paid_on DESC, a.created_at DESC
       LIMIT 500
    `;
    return { data: rows };
  });

  dtcRoute(app, "post", "/api/v1/dtc/advances", "dtc.pay", async (request, reply) => {
    const body = parseWith(z.object({
      contractorId: z.string().uuid(),
      routeId: z.string().uuid().optional().nullable(),
      paidOn: isoDate,
      amount: z.number().positive().max(1e8),
      mode: z.enum(MODES),
      reference: z.string().trim().max(100).optional().nullable(),
      recoverMonth: monthParam,
      notes: z.string().trim().max(300).optional().nullable(),
    }), request.body);
    if (body.recoverMonth < body.paidOn.slice(0, 7)) {
      throw new HttpError(400, "Validation Error", "Recover the advance in the month it was paid or later.");
    }
    const { userId } = requestAdmin(request);
    const [run] = await pgClient`
      SELECT status FROM dtc_bill_runs WHERE bill_month = ${body.recoverMonth + "-01"}::date
    ` as any[];
    if (run && run.status !== "draft") {
      throw new HttpError(409, "Month locked", "That month's bills are already sent for approval. Pick a later month to recover it.");
    }
    await pgClient`
      INSERT INTO dtc_advances (contractor_id, route_id, paid_on, amount, mode, reference, recover_month, notes, created_by)
      VALUES (${body.contractorId}::uuid, ${body.routeId ?? null}::uuid, ${body.paidOn}::date,
              ${body.amount.toFixed(2)}::numeric, ${body.mode}, ${body.reference ?? null},
              ${body.recoverMonth + "-01"}::date, ${body.notes ?? null}, ${userId}::uuid)
    `;
    return reply.status(201).send({
      message: run
        ? "Advance recorded. Regenerate that month's bills to add the recovery."
        : "Advance recorded. It will be recovered when that month's bills are prepared.",
    });
  });

  dtcRoute(app, "post", "/api/v1/dtc/advances/:id/cancel", "dtc.pay", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const { reason } = parseWith(z.object({ reason: z.string().trim().min(5, "Say why (at least 5 characters)").max(300) }), request.body);
    const { userId } = requestAdmin(request);
    const [used] = await pgClient`
      SELECT r.status FROM dtc_bill_lines l JOIN dtc_bills b ON b.id = l.bill_id JOIN dtc_bill_runs r ON r.id = b.run_id
       WHERE l.head = 'advance' AND l.source_ref = ${id}::uuid AND r.status <> 'draft' LIMIT 1
    `;
    if (used) throw new HttpError(409, "Already recovered", "This advance is recovered on bills already sent for approval.");
    const [a] = await pgClient`
      UPDATE dtc_advances SET cancelled_at = now(), cancelled_by = ${userId}::uuid, cancel_reason = ${reason}
       WHERE id = ${id}::uuid AND cancelled_at IS NULL RETURNING id
    `;
    if (!a) throw new HttpError(404, "Not found", "Advance not found or already cancelled.");
    return { message: "Advance cancelled. Regenerate the draft month's bills if it was already added." };
  });
}
