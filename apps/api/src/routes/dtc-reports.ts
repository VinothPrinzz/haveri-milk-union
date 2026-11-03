// apps/api/src/routes/dtc-reports.ts
// ═══════════════════════════════════════════════════════════════════════
// DTC Billing → Reports
//
//   GET /api/v1/dtc/reports/cost-per-litre?from=YYYY-MM&to=YYYY-MM
//       route × month transport cost per litre (from the prepared bills)
//   GET /api/v1/dtc/reports/ledger?contractorId&from=YYYY-MM&to=YYYY-MM
//       one contractor's bills, deductions, payments, advances, deposit
//
// The Consolidated DTC Bill, Earnings Sheet, Deductions Sheet and the
// contractor bill slips are drawn from GET /api/v1/dtc/runs/:month.
// ═══════════════════════════════════════════════════════════════════════
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { HttpError, monthParam, round2, round3 } from "../lib/dtc.js";
import { dtcRoute, parseWith } from "../lib/dtc-http.js";

const rangeSchema = z.object({ from: monthParam, to: monthParam })
  .refine(q => q.from <= q.to, { message: "'From' month must be on or before 'To'" });

export async function dtcReportRoutes(app: FastifyInstance) {
  dtcRoute(app, "get", "/api/v1/dtc/reports/cost-per-litre", "dtc.view", async (request) => {
    const q = parseWith(rangeSchema, request.query);
    const rows = await pgClient`
      SELECT to_char(r.bill_month, 'YYYY-MM') AS month, r.status, r.cost_basis AS "costBasis",
             b.route_id AS "routeId", b.route_code AS "routeCode", b.route_name AS "routeName",
             b.contractor_name AS "contractorName", b.billing_type AS "billingType",
             b.qty_litres::float8 AS qty, b.gross_amount::float8 AS gross,
             b.total_earnings::float8 AS "totalEarnings", b.cost_per_litre::float8 AS "costPerLitre"
        FROM dtc_bills b JOIN dtc_bill_runs r ON r.id = b.run_id
       WHERE r.bill_month >= ${q.from + "-01"}::date AND r.bill_month <= ${q.to + "-01"}::date
       ORDER BY b.route_code, r.bill_month
    ` as any[];

    const months = Array.from(new Set(rows.map(r => r.month as string))).sort();
    const monthStatus = Object.fromEntries(rows.map(r => [r.month, r.status]));
    const basis = rows[0]?.costBasis ?? "total_earnings";
    const byRoute = new Map<string, any>();
    for (const r of rows) {
      const cur = byRoute.get(r.routeId) ?? {
        routeId: r.routeId, routeCode: r.routeCode, routeName: r.routeName,
        contractorName: r.contractorName, billingType: r.billingType,
        months: {} as Record<string, { qty: number; amount: number; costPerLitre: number }>,
        qty: 0, amount: 0,
      };
      const amount = r.costBasis === "gross" ? r.gross : r.totalEarnings;
      cur.months[r.month] = { qty: r.qty, amount, costPerLitre: r.costPerLitre };
      cur.qty += r.qty;
      cur.amount += amount;
      cur.contractorName = r.contractorName;
      cur.billingType = r.billingType;
      byRoute.set(r.routeId, cur);
    }
    const routes = Array.from(byRoute.values()).map(r => ({
      ...r, qty: round3(r.qty), amount: round2(r.amount), costPerLitre: r.qty > 0 ? round2(r.amount / r.qty) : 0,
    }));
    const monthTotals = Object.fromEntries(months.map(m => {
      const inMonth = routes.map(r => r.months[m]).filter(Boolean);
      const qty = inMonth.reduce((s, x) => s + x.qty, 0);
      const amount = inMonth.reduce((s, x) => s + x.amount, 0);
      return [m, { qty: round3(qty), amount: round2(amount), costPerLitre: qty > 0 ? round2(amount / qty) : 0 }];
    }));
    const qty = routes.reduce((s, r) => s + r.qty, 0);
    const amount = routes.reduce((s, r) => s + r.amount, 0);
    return {
      from: q.from, to: q.to, basis, months, monthStatus, routes, monthTotals,
      totals: { qty: round3(qty), amount: round2(amount), costPerLitre: qty > 0 ? round2(amount / qty) : 0 },
    };
  });

  dtcRoute(app, "get", "/api/v1/dtc/reports/ledger", "dtc.view", async (request) => {
    const q = parseWith(z.object({ contractorId: z.string().uuid(), from: monthParam, to: monthParam })
      .refine(x => x.from <= x.to, { message: "'From' month must be on or before 'To'" }), request.query);
    const from = q.from + "-01";
    const to = q.to + "-01";
    const [contractor] = await pgClient`
      SELECT id, code, name, phone, bank_name AS "bankName", account_no AS "accountNo", ifsc_code AS "ifscCode",
             pan_number AS "panNumber", tds_entity_type AS "tdsEntityType", tds_declaration_fy AS "tdsDeclarationFy"
        FROM contractors WHERE id = ${q.contractorId}::uuid
    ` as any[];
    if (!contractor) throw new HttpError(404, "Not found", "Contractor not found.");

    const bills = await pgClient`
      SELECT b.id, to_char(r.bill_month, 'YYYY-MM') AS month, r.status AS "runStatus",
             b.route_code AS "routeCode", b.route_name AS "routeName", b.billing_type AS "billingType",
             b.days, b.qty_litres::float8 AS qty, b.gross_amount::float8 AS gross,
             b.other_earnings::float8 AS "otherEarnings", b.total_earnings::float8 AS "totalEarnings",
             b.total_deductions::float8 AS "totalDeductions", b.net_amount::float8 AS net,
             b.payable_amount::float8 AS payable, b.carry_forward::float8 AS "carryForward",
             b.on_hold AS "onHold",
             pm.paid_on::text AS "paidOn", pm.reference AS "paymentReference", pm.mode AS "paymentMode",
             COALESCE((SELECT json_object_agg(x.head, x.amount) FROM (
               SELECT l.head, SUM(l.amount)::float8 AS amount FROM dtc_bill_lines l
                WHERE l.bill_id = b.id AND l.kind = 'deduction' GROUP BY l.head) x), '{}'::json) AS deductions
        FROM dtc_bills b
        JOIN dtc_bill_runs r ON r.id = b.run_id
        LEFT JOIN dtc_payments pm ON pm.bill_id = b.id AND pm.reversed_at IS NULL
       WHERE b.contractor_id = ${q.contractorId}::uuid
         AND r.bill_month >= ${from}::date AND r.bill_month <= ${to}::date
       ORDER BY r.bill_month, b.route_code
    ` as any[];

    const advances = await pgClient`
      SELECT a.id, a.paid_on::text AS "paidOn", a.amount::float8 AS amount, a.mode, a.reference,
             to_char(a.recover_month, 'YYYY-MM') AS "recoverMonth", a.cancelled_at AS "cancelledAt"
        FROM dtc_advances a
       WHERE a.contractor_id = ${q.contractorId}::uuid
         AND a.recover_month >= ${from}::date AND a.recover_month <= ${to}::date
       ORDER BY a.paid_on
    `;
    const [deposit] = await pgClient`
      SELECT d.target_amount::float8 AS "targetAmount", d.monthly_instalment::float8 AS "monthlyInstalment",
             d.opening_collected::float8 AS "openingCollected", d.status,
             d.refunded_amount::float8 AS "refundedAmount", d.refunded_on::text AS "refundedOn",
             COALESCE((SELECT SUM(l.amount) FROM dtc_bill_lines l JOIN dtc_bills b ON b.id = l.bill_id
                        JOIN dtc_bill_runs r ON r.id = b.run_id
                       WHERE l.head = 'security_deposit' AND b.contractor_id = d.contractor_id
                         AND r.status = 'approved'), 0)::float8 AS "collectedApproved"
        FROM dtc_security_deposits d WHERE d.contractor_id = ${q.contractorId}::uuid
    ` as any[];

    const sum = (k: string) => round2(bills.reduce((s, b) => s + (Number(b[k]) || 0), 0));
    const paid = round2(bills.filter(b => b.paidOn).reduce((s, b) => s + b.payable, 0));
    return {
      contractor, from: q.from, to: q.to, bills, advances,
      deposit: deposit
        ? { ...deposit, collected: round2(deposit.openingCollected + deposit.collectedApproved) }
        : null,
      totals: {
        gross: sum("gross"), otherEarnings: sum("otherEarnings"), totalEarnings: sum("totalEarnings"),
        totalDeductions: sum("totalDeductions"), payable: sum("payable"), paid,
        outstanding: round2(bills.filter(b => b.runStatus === "approved" && !b.paidOn).reduce((s, b) => s + b.payable, 0)),
      },
    };
  });
}
