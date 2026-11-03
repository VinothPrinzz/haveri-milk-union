// apps/api/src/routes/dtc-bills.ts
// ═══════════════════════════════════════════════════════════════════════
// DTC Billing → Monthly bills
//
//   GET    /api/v1/dtc/runs                      every month's run with totals
//   POST   /api/v1/dtc/runs                      { month } create + generate bills
//   GET    /api/v1/dtc/runs/:key                 one run (uuid or YYYY-MM): bills + lines
//   POST   /api/v1/dtc/runs/:id/regenerate       refresh days, litres, terms, auto lines
//   DELETE /api/v1/dtc/runs/:id                  discard a draft run
//   POST   /api/v1/dtc/runs/:id/action           submit / pre_audit / mktg_approve /
//                                                approve / send_back / reopen
//   GET    /api/v1/dtc/bills/:id                 one route's bill with context
//   PATCH  /api/v1/dtc/bills/:id                 day overrides, notes
//   POST   /api/v1/dtc/bills/:id/lines           add an earning / deduction
//   PATCH  /api/v1/dtc/bills/:id/lines/:lineId
//   DELETE /api/v1/dtc/bills/:id/lines/:lineId
//   POST   /api/v1/dtc/bills/:id/restore-auto    bring back removed automatic lines
//   POST   /api/v1/dtc/bills/:id/hold            hold / release for payment
//
// Approval chain (one step per signature box on the printed bill):
//   draft ─submit→ submitted ─pre_audit→ pre_audited ─mktg_approve→
//   mktg_approved ─approve→ approved (locked)
// "send_back" returns a submitted run to draft with a comment; "reopen"
// unlocks an approved run that has no payments yet.
// ═══════════════════════════════════════════════════════════════════════
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { roleHasPermission } from "../middleware/admin-auth.js";
import {
  DEDUCTION_HEADS, EARNING_HEADS, HEAD_LABELS, HttpError, crateRateOn, generateRunBills,
  loadDispatchDates, loadDtcSettings, loadRouteDailyQty, logEvent, monthBounds, monthLabel,
  monthParam, recomputeBill, requestAdmin, round2, runDates, type Segment, type Sql,
} from "../lib/dtc.js";
import { istToday } from "../lib/ist-date.js";
import { dtcRoute, parseWith } from "../lib/dtc-http.js";

const uuidParam = z.object({ id: z.string().uuid() });
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Action = "submit" | "pre_audit" | "mktg_approve" | "approve" | "send_back" | "reopen";
const STEPS: Record<Exclude<Action, "send_back" | "reopen">, { from: string; to: string; permission: string; stamp: string; label: string }> = {
  submit:       { from: "draft",         to: "submitted",     permission: "dtc.prepare",         stamp: "submitted",     label: "Submitted for pre-audit" },
  pre_audit:    { from: "submitted",     to: "pre_audited",   permission: "dtc.audit",           stamp: "pre_audited",   label: "Pre-audited" },
  mktg_approve: { from: "pre_audited",   to: "mktg_approved", permission: "dtc.approve_mktg",    stamp: "mktg_approved", label: "Approved by Marketing" },
  approve:      { from: "mktg_approved", to: "approved",      permission: "dtc.approve_finance", stamp: "approved",      label: "Approved by Finance (locked)" },
};
/** Who may send a run back at each stage: whoever acts on that stage. */
const SEND_BACK_PERMISSION: Record<string, string> = {
  submitted: "dtc.audit", pre_audited: "dtc.approve_mktg", mktg_approved: "dtc.approve_finance",
};

/** Lock a run row; throws unless it is a draft. */
async function lockDraftRun(tx: Sql, runId: string) {
  const [run] = await tx`
    SELECT id, status, bill_month::text AS bill_month FROM dtc_bill_runs WHERE id = ${runId}::uuid FOR UPDATE
  ` as any[];
  if (!run) throw new HttpError(404, "Not found", "Bill run not found.");
  if (run.status !== "draft") {
    throw new HttpError(409, "Locked", "This month's bills have been sent for approval. Ask the approver to send them back to edit.");
  }
  return run as { id: string; status: string; bill_month: string };
}

/** Lock a bill's run (must be draft) and return the bill. */
async function lockDraftBill(tx: Sql, billId: string) {
  const [b] = await tx`SELECT id, run_id, route_code, suppressed_auto, segments, billing_type, rate::float8 AS rate
                         FROM dtc_bills WHERE id = ${billId}::uuid` as any[];
  if (!b) throw new HttpError(404, "Not found", "Bill not found.");
  const run = await lockDraftRun(tx, b.run_id);
  return { bill: b, run };
}

async function resolveRunId(key: string): Promise<string | null> {
  if (/^[0-9a-f-]{36}$/i.test(key)) return key;
  if (/^\d{4}-\d{2}$/.test(key)) {
    const [r] = await pgClient`SELECT id FROM dtc_bill_runs WHERE bill_month = ${key + "-01"}::date`;
    return (r as any)?.id ?? null;
  }
  return null;
}

const runSummarySql = (where: ReturnType<typeof pgClient>) => pgClient`
  SELECT r.id, to_char(r.bill_month, 'YYYY-MM') AS month, r.status, r.cost_basis AS "costBasis",
         r.returned_comment AS "returnedComment",
         r.generated_at AS "generatedAt", gu.name AS "generatedByName",
         r.submitted_at AS "submittedAt", su.name AS "submittedByName",
         r.pre_audited_at AS "preAuditedAt", pu.name AS "preAuditedByName",
         r.mktg_approved_at AS "mktgApprovedAt", mu.name AS "mktgApprovedByName",
         r.approved_at AS "approvedAt", au.name AS "approvedByName",
         r.updated_at AS "updatedAt",
         COALESCE(t.bill_count, 0)::int AS "billCount",
         COALESCE(t.contractor_count, 0)::int AS "contractorCount",
         COALESCE(t.gross, 0)::float8 AS gross,
         COALESCE(t.total_earnings, 0)::float8 AS "totalEarnings",
         COALESCE(t.total_deductions, 0)::float8 AS "totalDeductions",
         COALESCE(t.payable, 0)::float8 AS payable,
         COALESCE(t.on_hold, 0)::int AS "onHoldCount",
         COALESCE(p.paid_count, 0)::int AS "paidCount",
         COALESCE(p.paid_amount, 0)::float8 AS "paidAmount"
    FROM dtc_bill_runs r
    LEFT JOIN users gu ON gu.id = r.generated_by
    LEFT JOIN users su ON su.id = r.submitted_by
    LEFT JOIN users pu ON pu.id = r.pre_audited_by
    LEFT JOIN users mu ON mu.id = r.mktg_approved_by
    LEFT JOIN users au ON au.id = r.approved_by
    LEFT JOIN LATERAL (
      SELECT count(*) AS bill_count, count(DISTINCT b.contractor_id) AS contractor_count,
             SUM(b.gross_amount) AS gross, SUM(b.total_earnings) AS total_earnings,
             SUM(b.total_deductions) AS total_deductions, SUM(b.payable_amount) AS payable,
             count(*) FILTER (WHERE b.on_hold) AS on_hold
        FROM dtc_bills b WHERE b.run_id = r.id
    ) t ON true
    LEFT JOIN LATERAL (
      SELECT count(*) AS paid_count, SUM(pm.amount) AS paid_amount
        FROM dtc_payments pm JOIN dtc_bills b ON b.id = pm.bill_id
       WHERE b.run_id = r.id AND pm.reversed_at IS NULL
    ) p ON true
   ${where}
   ORDER BY r.bill_month DESC
`;

const BILL_COLUMNS = `
  b.id, b.run_id AS "runId", b.route_id AS "routeId", b.route_code AS "routeCode", b.route_name AS "routeName",
  b.contractor_id AS "contractorId", b.contractor_name AS "contractorName",
  b.vehicle_number AS "vehicleNumber", b.vehicle_capacity_mt::float8 AS "vehicleCapacityMt",
  b.billing_type AS "billingType", b.rate::float8 AS rate, b.km_per_day::float8 AS "kmPerDay",
  b.segments, b.days, b.qty_litres::float8 AS "qtyLitres",
  b.gross_amount::float8 AS gross, b.other_earnings::float8 AS "otherEarnings",
  b.total_earnings::float8 AS "totalEarnings", b.total_deductions::float8 AS "totalDeductions",
  b.net_amount::float8 AS net, b.payable_amount::float8 AS payable, b.carry_forward::float8 AS "carryForward",
  b.cost_per_litre::float8 AS "costPerLitre", b.cash_collection AS "cashCollection",
  b.suppressed_auto AS "suppressedAuto", b.on_hold AS "onHold", b.hold_reason AS "holdReason",
  b.held_at AS "heldAt", b.notes, b.updated_at AS "updatedAt"
`;

async function linesForBills(billIds: string[]) {
  if (billIds.length === 0) return new Map<string, any[]>();
  const rows = await pgClient`
    SELECT l.id, l.bill_id AS "billId", l.kind, l.head, l.qty::float8 AS qty, l.rate::float8 AS rate,
           l.amount::float8 AS amount, l.remarks, l.source, l.source_ref AS "sourceRef",
           l.created_at AS "createdAt", u.name AS "createdByName"
      FROM dtc_bill_lines l LEFT JOIN users u ON u.id = l.created_by
     WHERE l.bill_id = ANY(string_to_array(${billIds.join(",")}, ',')::uuid[])
     ORDER BY l.kind DESC, l.created_at
  `;
  const map = new Map<string, any[]>();
  for (const l of rows as any[]) {
    if (!map.has(l.billId)) map.set(l.billId, []);
    map.get(l.billId)!.push(l);
  }
  return map;
}

const lineSchema = z.object({
  head: z.enum([...EARNING_HEADS, ...DEDUCTION_HEADS] as [string, ...string[]]),
  qty: z.number().min(0).max(1e8).optional().nullable(),
  rate: z.number().min(0).max(1e8).optional().nullable(),
  amount: z.number().min(0).max(1e9).optional().nullable(),
  remarks: z.string().trim().max(300).optional().nullable(),
});

/** Amount = qty × rate when both are given, else the amount typed. */
function lineAmount(b: z.infer<typeof lineSchema>): number {
  if (b.qty != null && b.rate != null) return round2(b.qty * b.rate);
  if (b.amount != null) return round2(b.amount);
  throw new HttpError(400, "Validation Error", "Enter the quantity and rate, or the amount.");
}
const lineText = (head: string, qty: number | null | undefined, rate: number | null | undefined, amount: number) =>
  `${HEAD_LABELS[head] ?? head}: ${qty != null && rate != null ? `${qty} × ${inr(rate)} = ` : ""}${inr(amount)}`;

export async function dtcBillRoutes(app: FastifyInstance) {
  // ── Runs ──
  dtcRoute(app, "get", "/api/v1/dtc/runs", "dtc.view", async () => {
    const rows = await runSummarySql(pgClient``);
    return { data: rows };
  });

  dtcRoute(app, "post", "/api/v1/dtc/runs", "dtc.prepare", async (request, reply) => {
    const { month } = parseWith(z.object({ month: monthParam }), request.body);
    if (month > istToday().slice(0, 7)) {
      throw new HttpError(400, "Future month", "Bills can be prepared for the current month or earlier.");
    }
    const { userId } = requestAdmin(request);
    const result = await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const settings = await loadDtcSettings(tx);
      const [run] = await tx`
        INSERT INTO dtc_bill_runs (bill_month, cost_basis, generated_by)
        VALUES (${month + "-01"}::date, ${settings.costPerLitreBasis}, ${userId}::uuid)
        ON CONFLICT (bill_month) DO NOTHING
        RETURNING id
      ` as any[];
      if (!run) throw new HttpError(409, "Already prepared", `Bills for ${monthLabel(month + "-01")} already exist. Open them from the list.`);
      const { billCount } = await generateRunBills(tx, run.id, month + "-01");
      await logEvent(tx, { runId: run.id, action: "generated", detail: `${billCount} route bills generated`, userId });
      return { id: run.id as string, billCount };
    });
    return reply.status(201).send({
      message: result.billCount
        ? `Prepared ${result.billCount} route bills for ${monthLabel(month + "-01")}`
        : "No route has billing terms for this month yet. Set them up in Route Billing Setup, then regenerate.",
      id: result.id, month, billCount: result.billCount,
    });
  });

  dtcRoute(app, "get", "/api/v1/dtc/runs/:key", "dtc.view", async (request) => {
    const { key } = parseWith(z.object({ key: z.string() }), request.params);
    const id = await resolveRunId(key);
    if (!id) throw new HttpError(404, "Not found", "No bills prepared for this month yet.");
    const [run] = await runSummarySql(pgClient`WHERE r.id = ${id}::uuid`) as any[];
    if (!run) throw new HttpError(404, "Not found", "No bills prepared for this month yet.");

    const bills = await pgClient`
      SELECT ${pgClient.unsafe(BILL_COLUMNS)},
             c.code AS "contractorCode", c.phone AS "contractorPhone", c.bank_name AS "bankName",
             c.account_no AS "accountNo", c.ifsc_code AS "ifscCode", c.pan_number AS "panNumber",
             pm.id AS "paymentId", pm.paid_on::text AS "paidOn", pm.mode AS "paymentMode",
             pm.reference AS "paymentReference", pm.amount::float8 AS "paidAmount"
        FROM dtc_bills b
        LEFT JOIN contractors c ON c.id = b.contractor_id
        LEFT JOIN dtc_payments pm ON pm.bill_id = b.id AND pm.reversed_at IS NULL
       WHERE b.run_id = ${id}::uuid
       ORDER BY b.route_code
    ` as any[];
    const lines = await linesForBills(bills.map(b => b.id));
    const events = await pgClient`
      SELECT e.id, e.action, e.detail, e.bill_id AS "billId", e.created_at AS "createdAt", u.name AS "userName"
        FROM dtc_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.run_id = ${id}::uuid AND e.bill_id IS NULL
       ORDER BY e.created_at DESC LIMIT 50
    `;
    const settings = await loadDtcSettings(pgClient);
    const { end } = monthBounds(run.month);
    return {
      run,
      signatures: settings.signatures,
      crateRate: await crateRateOn(pgClient, end),
      bills: bills.map(b => ({ ...b, lines: lines.get(b.id) ?? [] })),
      events,
    };
  });

  dtcRoute(app, "post", "/api/v1/dtc/runs/:id/regenerate", "dtc.prepare", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const { userId } = requestAdmin(request);
    const r = await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const run = await lockDraftRun(tx, id);
      const { billCount } = await generateRunBills(tx, id, run.bill_month);
      await logEvent(tx, { runId: id, action: "regenerated", detail: `${billCount} route bills refreshed`, userId });
      return billCount;
    });
    return { message: `Refreshed ${r} route bills (days, litres, rates and automatic deductions)` };
  });

  dtcRoute(app, "delete", "/api/v1/dtc/runs/:id", "dtc.prepare", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      await lockDraftRun(tx, id);
      await tx`DELETE FROM dtc_bill_runs WHERE id = ${id}::uuid`;
    });
    return { message: "Draft bills discarded" };
  });

  dtcRoute(app, "post", "/api/v1/dtc/runs/:id/action", "dtc.view", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const body = parseWith(z.object({
      action: z.enum(["submit", "pre_audit", "mktg_approve", "approve", "send_back", "reopen"]),
      comment: z.string().trim().max(500).optional().nullable(),
    }), request.body);
    const { userId, role } = requestAdmin(request);

    const message = await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const [run] = await tx`
        SELECT id, status, bill_month::text AS bill_month FROM dtc_bill_runs WHERE id = ${id}::uuid FOR UPDATE
      ` as any[];
      if (!run) throw new HttpError(404, "Not found", "Bill run not found.");
      const label = monthLabel(run.bill_month);

      if (body.action === "send_back" || body.action === "reopen") {
        const comment = (body.comment ?? "").trim();
        if (comment.length < 5) throw new HttpError(400, "Validation Error", "Say why (at least 5 characters).");
        if (body.action === "send_back") {
          const perm = SEND_BACK_PERMISSION[run.status];
          if (!perm) throw new HttpError(409, "Wrong stage", "Only bills waiting for approval can be sent back.");
          if (!roleHasPermission(role, perm)) throw new HttpError(403, "Forbidden", "You can't act on this stage.");
        } else {
          if (run.status !== "approved") throw new HttpError(409, "Wrong stage", "Only approved bills can be reopened.");
          if (!roleHasPermission(role, "dtc.approve_finance")) throw new HttpError(403, "Forbidden", "Only Finance can reopen approved bills.");
          const [paid] = await tx`
            SELECT count(*)::int AS n FROM dtc_payments pm JOIN dtc_bills b ON b.id = pm.bill_id
             WHERE b.run_id = ${id}::uuid AND pm.reversed_at IS NULL
          ` as any[];
          if (paid.n > 0) throw new HttpError(409, "Already paid", `${paid.n} bills of this month are paid. Reverse those payments first.`);
          const [recovered] = await tx`
            SELECT 1 FROM dtc_bill_lines l
              JOIN dtc_bills b2 ON b2.id = l.bill_id JOIN dtc_bill_runs r2 ON r2.id = b2.run_id
             WHERE l.head = 'carry_forward' AND r2.id <> ${id}::uuid AND r2.status <> 'draft'
               AND l.source_ref IN (SELECT b.id FROM dtc_bills b WHERE b.run_id = ${id}::uuid)
             LIMIT 1
          `;
          if (recovered) throw new HttpError(409, "In use", "A later month already recovers a negative balance from these bills.");
        }
        await tx`
          UPDATE dtc_bill_runs SET status = 'draft', returned_comment = ${comment},
            submitted_by = NULL, submitted_at = NULL, pre_audited_by = NULL, pre_audited_at = NULL,
            mktg_approved_by = NULL, mktg_approved_at = NULL, approved_by = NULL, approved_at = NULL,
            updated_at = now()
          WHERE id = ${id}::uuid
        `;
        await logEvent(tx, { runId: id, action: body.action, detail: comment, userId });
        return body.action === "send_back" ? `${label} bills sent back for correction` : `${label} bills reopened for correction`;
      }

      const step = STEPS[body.action];
      if (run.status !== step.from) {
        throw new HttpError(409, "Wrong stage", "These bills are not at that stage any more. Refresh the page.");
      }
      if (!roleHasPermission(role, step.permission)) throw new HttpError(403, "Forbidden", "You can't approve this stage.");
      if (body.action === "submit") {
        const [n] = await tx`SELECT count(*)::int AS n FROM dtc_bills WHERE run_id = ${id}::uuid` as any[];
        if (n.n === 0) throw new HttpError(400, "No bills", "There are no route bills in this month to submit.");
      }
      const stampBy = pgClient.unsafe(`${step.stamp}_by`);
      const stampAt = pgClient.unsafe(`${step.stamp}_at`);
      await tx`
        UPDATE dtc_bill_runs SET status = ${step.to}, ${stampBy} = ${userId}::uuid, ${stampAt} = now(),
          returned_comment = CASE WHEN ${body.action === "submit"} THEN NULL ELSE returned_comment END,
          updated_at = now()
        WHERE id = ${id}::uuid
      `;
      await logEvent(tx, { runId: id, action: body.action, detail: body.comment ?? step.label, userId });
      return `${label}: ${step.label}`;
    });
    return { message };
  });

  // ── One bill ──
  dtcRoute(app, "get", "/api/v1/dtc/bills/:id", "dtc.view", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const [bill] = await pgClient`
      SELECT ${pgClient.unsafe(BILL_COLUMNS)},
             to_char(r.bill_month, 'YYYY-MM') AS month, r.status AS "runStatus",
             c.code AS "contractorCode", c.phone AS "contractorPhone", c.bank_name AS "bankName",
             c.account_no AS "accountNo", c.ifsc_code AS "ifscCode", c.pan_number AS "panNumber",
             c.tds_entity_type AS "tdsEntityType", c.tds_declaration_fy AS "tdsDeclarationFy"
        FROM dtc_bills b
        JOIN dtc_bill_runs r ON r.id = b.run_id
        LEFT JOIN contractors c ON c.id = b.contractor_id
       WHERE b.id = ${id}::uuid
    ` as any[];
    if (!bill) throw new HttpError(404, "Not found", "Bill not found.");
    const { start, end } = monthBounds(bill.month);
    const lines = (await linesForBills([id])).get(id) ?? [];

    // Which dates count as days, per segment (for the clerk to check).
    const qty = await loadRouteDailyQty(pgClient, start, end);
    const dispatch = await loadDispatchDates(pgClient, start, end);
    const segments = (bill.segments as Segment[]).map(s => ({
      ...s, runDates: runDates(bill.routeId, s.from, s.to, qty, dispatch),
    }));

    // Sales billed on the route this month — a reference for dues on
    // cash-collection routes.
    const [sales] = await pgClient`
      SELECT COALESCE(SUM(x.amount), 0)::float8 AS amount FROM (
        SELECT o.grand_total AS amount FROM orders o JOIN dealers d ON d.id = o.dealer_id
         WHERE COALESCE(o.route_id, d.route_id) = ${bill.routeId}::uuid
           AND o.delivery_date >= ${start}::date AND o.delivery_date <= ${end}::date
           AND o.created_at >= ${start}::date - interval '31 days' AND o.created_at < ${end}::date + interval '2 days'
           AND o.status IN ('confirmed', 'dispatched', 'delivered')
        UNION ALL
        SELECT ds.grand_total FROM direct_sales ds
         WHERE ds.route_id = ${bill.routeId}::uuid AND ds.status = 'confirmed'
           AND ds.sale_date >= ${start}::date AND ds.sale_date <= ${end}::date
      ) x
    ` as any[];

    const events = await pgClient`
      SELECT e.id, e.action, e.detail, e.created_at AS "createdAt", u.name AS "userName"
        FROM dtc_events e LEFT JOIN users u ON u.id = e.user_id
       WHERE e.bill_id = ${id}::uuid ORDER BY e.created_at DESC LIMIT 100
    `;
    const payments = await pgClient`
      SELECT pm.id, pm.amount::float8 AS amount, pm.paid_on::text AS "paidOn", pm.mode, pm.reference,
             pm.notes, pm.reversed_at AS "reversedAt", pm.reverse_reason AS "reverseReason",
             u.name AS "createdByName"
        FROM dtc_payments pm LEFT JOIN users u ON u.id = pm.created_by
       WHERE pm.bill_id = ${id}::uuid ORDER BY pm.created_at DESC
    `;
    return {
      bill: { ...bill, segments, lines },
      crateRate: await crateRateOn(pgClient, end),
      routeSales: Number(sales?.amount ?? 0),
      events,
      payments,
    };
  });

  dtcRoute(app, "patch", "/api/v1/dtc/bills/:id", "dtc.prepare", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const body = parseWith(z.object({
      segments: z.array(z.object({
        key: z.string(),
        daysOverride: z.number().int().min(0).max(31).nullable(),
      })).optional(),
      notes: z.string().trim().max(500).optional().nullable(),
    }), request.body);
    const { userId } = requestAdmin(request);
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const { bill, run } = await lockDraftBill(tx, id);
      const changes: string[] = [];
      if (body.segments) {
        const segs = bill.segments as Segment[];
        for (const u of body.segments) {
          const s = segs.find(x => x.key === u.key);
          if (!s) throw new HttpError(400, "Validation Error", "That part of the month no longer exists. Refresh the page.");
          const calendarDays = Math.round((Date.parse(s.to) - Date.parse(s.from)) / 86400000) + 1;
          if (u.daysOverride != null && u.daysOverride > calendarDays) {
            throw new HttpError(400, "Validation Error", `At most ${calendarDays} days between ${s.from} and ${s.to}.`);
          }
          const before = s.daysOverride ?? s.autoDays;
          s.daysOverride = u.daysOverride != null && u.daysOverride === s.autoDays ? null : u.daysOverride;
          const after = s.daysOverride ?? s.autoDays;
          if (before !== after) changes.push(`Days ${before} → ${after}${s.daysOverride == null ? " (automatic)" : ""}`);
        }
        await tx`UPDATE dtc_bills SET segments = ${JSON.stringify(segs)}::jsonb WHERE id = ${id}::uuid`;
      }
      if (body.notes !== undefined) {
        await tx`UPDATE dtc_bills SET notes = ${body.notes ?? null} WHERE id = ${id}::uuid`;
        changes.push("Notes updated");
      }
      await recomputeBill(tx, id);
      if (changes.length) await logEvent(tx, { runId: run.id, billId: id, action: "edited", detail: changes.join("; "), userId });
    });
    return { message: "Bill updated" };
  });

  dtcRoute(app, "post", "/api/v1/dtc/bills/:id/lines", "dtc.prepare", async (request, reply) => {
    const { id } = parseWith(uuidParam, request.params);
    const body = parseWith(lineSchema, request.body);
    const { userId } = requestAdmin(request);
    const amount = lineAmount(body);
    if (!(amount > 0)) throw new HttpError(400, "Validation Error", "The amount must be more than zero.");
    const kind = (EARNING_HEADS as readonly string[]).includes(body.head) ? "earning" : "deduction";
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const { run } = await lockDraftBill(tx, id);
      await tx`
        INSERT INTO dtc_bill_lines (bill_id, kind, head, qty, rate, amount, remarks, source, created_by)
        VALUES (${id}::uuid, ${kind}, ${body.head}, ${body.qty ?? null}::numeric, ${body.rate ?? null}::numeric,
                ${amount.toFixed(2)}::numeric, ${body.remarks ?? null}, 'manual', ${userId}::uuid)
      `;
      await recomputeBill(tx, id);
      await logEvent(tx, {
        runId: run.id, billId: id, action: "line_added",
        detail: `Added ${kind} ${lineText(body.head, body.qty, body.rate, amount)}${body.remarks ? ` (${body.remarks})` : ""}`,
        userId,
      });
    });
    return reply.status(201).send({ message: "Added" });
  });

  dtcRoute(app, "patch", "/api/v1/dtc/bills/:id/lines/:lineId", "dtc.prepare", async (request) => {
    const { id, lineId } = parseWith(z.object({ id: z.string().uuid(), lineId: z.string().uuid() }), request.params);
    const body = parseWith(lineSchema.omit({ head: true }), request.body);
    const { userId } = requestAdmin(request);
    const amount = lineAmount({ ...body, head: "other_earning" });
    if (!(amount > 0)) throw new HttpError(400, "Validation Error", "The amount must be more than zero.");
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const { run } = await lockDraftBill(tx, id);
      const [line] = await tx`
        SELECT head, source, source_ref, amount::float8 AS amount FROM dtc_bill_lines
         WHERE id = ${lineId}::uuid AND bill_id = ${id}::uuid
      ` as any[];
      if (!line) throw new HttpError(404, "Not found", "Line not found.");
      if (line.source === "auto" && line.head === "tds") {
        throw new HttpError(400, "Automatic", "TDS is worked out from the earnings. Remove it, or change the contractor's TDS details.");
      }
      // An edited automatic line becomes manual, and regeneration stops re-adding it.
      if (line.source === "auto") {
        await tx`
          UPDATE dtc_bills SET suppressed_auto = array_append(suppressed_auto, ${`${line.head}:${line.source_ref ?? ""}`})
           WHERE id = ${id}::uuid
        `;
      }
      await tx`
        UPDATE dtc_bill_lines SET qty = ${body.qty ?? null}::numeric, rate = ${body.rate ?? null}::numeric,
          amount = ${amount.toFixed(2)}::numeric, remarks = ${body.remarks ?? null}, source = 'manual',
          created_by = ${userId}::uuid, updated_at = now()
        WHERE id = ${lineId}::uuid
      `;
      await recomputeBill(tx, id);
      await logEvent(tx, {
        runId: run.id, billId: id, action: "line_edited",
        detail: `${HEAD_LABELS[line.head] ?? line.head}: ${inr(line.amount)} → ${lineText(line.head, body.qty, body.rate, amount)}`,
        userId,
      });
    });
    return { message: "Updated" };
  });

  dtcRoute(app, "delete", "/api/v1/dtc/bills/:id/lines/:lineId", "dtc.prepare", async (request) => {
    const { id, lineId } = parseWith(z.object({ id: z.string().uuid(), lineId: z.string().uuid() }), request.params);
    const { userId } = requestAdmin(request);
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const { run } = await lockDraftBill(tx, id);
      const [line] = await tx`
        DELETE FROM dtc_bill_lines WHERE id = ${lineId}::uuid AND bill_id = ${id}::uuid
        RETURNING head, source, source_ref, amount::float8 AS amount, remarks
      ` as any[];
      if (!line) throw new HttpError(404, "Not found", "Line not found.");
      if (line.source === "auto") {
        await tx`
          UPDATE dtc_bills SET suppressed_auto = array_append(suppressed_auto, ${`${line.head}:${line.source_ref ?? ""}`})
           WHERE id = ${id}::uuid
        `;
      }
      await recomputeBill(tx, id);
      await logEvent(tx, {
        runId: run.id, billId: id, action: "line_removed",
        detail: `Removed ${HEAD_LABELS[line.head] ?? line.head} ${inr(line.amount)}${line.source === "auto" ? " (automatic)" : ""}`,
        userId,
      });
    });
    return { message: "Removed" };
  });

  dtcRoute(app, "post", "/api/v1/dtc/bills/:id/restore-auto", "dtc.prepare", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const { userId } = requestAdmin(request);
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const { run } = await lockDraftBill(tx, id);
      await tx`UPDATE dtc_bills SET suppressed_auto = '{}' WHERE id = ${id}::uuid`;
      await generateRunBills(tx, run.id, run.bill_month);
      await logEvent(tx, { runId: run.id, billId: id, action: "auto_restored", detail: "Automatic lines restored", userId });
    });
    return { message: "Automatic lines restored" };
  });

  dtcRoute(app, "post", "/api/v1/dtc/bills/:id/hold", "dtc.pay", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const body = parseWith(z.object({
      onHold: z.boolean(), reason: z.string().trim().max(300).optional().nullable(),
    }), request.body);
    if (body.onHold && (body.reason ?? "").length < 5) {
      throw new HttpError(400, "Validation Error", "Say why the bill is held (at least 5 characters).");
    }
    const { userId } = requestAdmin(request);
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const [b] = await tx`SELECT run_id FROM dtc_bills WHERE id = ${id}::uuid FOR UPDATE` as any[];
      if (!b) throw new HttpError(404, "Not found", "Bill not found.");
      const [paid] = await tx`SELECT 1 FROM dtc_payments WHERE bill_id = ${id}::uuid AND reversed_at IS NULL`;
      if (paid) throw new HttpError(409, "Already paid", "This bill is already paid.");
      await tx`
        UPDATE dtc_bills SET on_hold = ${body.onHold}, hold_reason = ${body.onHold ? body.reason ?? null : null},
          held_by = ${body.onHold ? userId : null}::uuid, held_at = ${body.onHold ? new Date().toISOString() : null}::timestamptz,
          updated_at = now()
        WHERE id = ${id}::uuid
      `;
      await logEvent(tx, {
        runId: b.run_id, billId: id, action: body.onHold ? "held" : "released",
        detail: body.onHold ? `Held for payment: ${body.reason}` : "Released for payment", userId,
      });
    });
    return { message: body.onHold ? "Bill held" : "Bill released for payment" };
  });
}
