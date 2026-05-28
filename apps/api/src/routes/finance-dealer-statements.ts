// apps/api/src/routes/finance-dealer-statements.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Dealer Statements
//
//   GET /api/v1/finance/dealer-statements           — dealer index
//   GET /api/v1/finance/dealer-statements/:id        — period statement (JSON)
//   GET /api/v1/finance/dealer-statements/:id/print  — printable HTML
//
// Statement of account for any date range: opening balance, vouchers,
// closing balance. Same closing-balance math as Credit Control.
// All endpoints require finance.view.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

function defaultFrom(): string {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`;
}
function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function inr(n: number): string {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function loadStatement(dealerId: string, from: string, to: string) {
  const [dealer] = await pgClient`
    SELECT d.id, d.code, d.name, d.pay_mode::text AS "payMode",
           d.gst_number AS "gstNumber", d.address, d.city, d.state,
           r.name AS "routeName"
      FROM dealers d
      LEFT JOIN routes r ON r.id = d.route_id
     WHERE d.id = ${dealerId}::uuid AND d.deleted_at IS NULL
     LIMIT 1
  `;
  if (!dealer) return null;

  const [openingRow] = await pgClient`
    SELECT
      COALESCE(d.opening_balance, 0)::numeric
      + COALESCE((
          SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                          WHEN dl.type = 'debit'  THEN -dl.amount END)
            FROM dealer_ledger dl
           WHERE dl.dealer_id = d.id
             AND COALESCE(dl.voucher_type, '') <> 'Opening'
             AND COALESCE(dl.voucher_date, dl.created_at::date) < ${from}::date
        ), 0)::float8 AS "openingBalance"
      FROM dealers d WHERE d.id = ${dealerId}::uuid
  `;
  const opening = openingRow?.openingBalance ?? 0;

  const rows = await pgClient`
    SELECT
      dl.id,
      COALESCE(dl.voucher_date, dl.created_at::date) AS "voucherDate",
      dl.voucher_no   AS "voucherNo",
      dl.voucher_type AS "voucherType",
      dl.particulars,
      dl.type,
      dl.amount::float8 AS amount,
      (
        ${opening}::numeric
        + SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                   WHEN dl.type = 'debit'  THEN -dl.amount END)
          OVER (ORDER BY COALESCE(dl.voucher_date, dl.created_at::date), dl.created_at, dl.id
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW)
      )::float8 AS "balanceAfter"
    FROM dealer_ledger dl
    WHERE dl.dealer_id = ${dealerId}::uuid
      AND COALESCE(dl.voucher_type, '') <> 'Opening'
      AND COALESCE(dl.voucher_date, dl.created_at::date) BETWEEN ${from}::date AND ${to}::date
    ORDER BY COALESCE(dl.voucher_date, dl.created_at::date), dl.created_at, dl.id
  `;

  let debits = 0, credits = 0;
  for (const r of rows as any[]) {
    if (r.type === "debit") debits += r.amount;
    else if (r.type === "credit") credits += r.amount;
  }
  const closing = opening + credits - debits;

  return {
    dealer,
    period: { from, to },
    openingBalance: opening,
    rows,
    totals: { debits, credits, closingBalance: closing },
  };
}

export async function financeDealerStatementsRoutes(app: FastifyInstance) {
  // ── GET /api/v1/finance/dealer-statements (index) ──
  app.get(
    "/api/v1/finance/dealer-statements",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        routeId: z.string().uuid().optional(),
        search:  z.string().optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);
      const routeId = q.routeId ?? null;
      const search  = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        SELECT
          d.id, d.code, d.name,
          d.pay_mode::text AS "payMode",
          r.name AS "routeName",
          (
            COALESCE(d.opening_balance, 0)
            + COALESCE((
                SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                                WHEN dl.type = 'debit'  THEN -dl.amount END)
                  FROM dealer_ledger dl
                 WHERE dl.dealer_id = d.id
                   AND COALESCE(dl.voucher_type, '') <> 'Opening'
              ), 0)
          )::float8 AS "closingBalance",
          (SELECT MAX(received_date) FROM payments WHERE dealer_id = d.id) AS "lastPaymentAt"
        FROM dealers d
        LEFT JOIN routes r ON r.id = d.route_id
        WHERE d.deleted_at IS NULL
          AND (${routeId}::uuid IS NULL OR d.route_id = ${routeId}::uuid)
          AND (${search}::text  IS NULL OR d.name ILIKE ${search}::text OR d.code ILIKE ${search}::text)
        ORDER BY d.name ASC
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM dealers d
        WHERE d.deleted_at IS NULL
          AND (${routeId}::uuid IS NULL OR d.route_id = ${routeId}::uuid)
          AND (${search}::text  IS NULL OR d.name ILIKE ${search}::text OR d.code ILIKE ${search}::text)
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // ── GET /api/v1/finance/dealer-statements/:id (period statement) ──
  app.get(
    "/api/v1/finance/dealer-statements/:id",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(request.query);
      const from = q.from ?? defaultFrom();
      const to   = q.to ?? today();

      const stmt = await loadStatement(id, from, to);
      if (!stmt) return reply.status(404).send({ error: "Dealer not found" });
      return reply.send(stmt);
    }
  );

  // ── GET /api/v1/finance/dealer-statements/:id/print (HTML) ──
  app.get(
    "/api/v1/finance/dealer-statements/:id/print",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const q = z.object({ from: isoDate.optional(), to: isoDate.optional() }).parse(request.query);
      const from = q.from ?? defaultFrom();
      const to   = q.to ?? today();

      const stmt = await loadStatement(id, from, to);
      if (!stmt) return reply.status(404).send({ error: "Dealer not found" });

      const d: any = stmt.dealer;
      const closing = stmt.totals.closingBalance;
      const drcr = closing < 0 ? `${inr(-closing)} Dr` : `${inr(closing)} Cr`;

      const lines = (stmt.rows as any[]).map((r) => `
        <tr>
          <td>${esc(r.voucherDate)}</td>
          <td>${esc(r.voucherNo ?? "")}</td>
          <td>${esc(r.voucherType ?? "")}</td>
          <td>${esc(r.particulars ?? "")}</td>
          <td class="num">${r.type === "debit" ? inr(r.amount) : ""}</td>
          <td class="num">${r.type === "credit" ? inr(r.amount) : ""}</td>
          <td class="num">${inr(Math.abs(r.balanceAfter))} ${r.balanceAfter < 0 ? "Dr" : "Cr"}</td>
        </tr>`).join("");

      const openAbs = Math.abs(stmt.openingBalance);
      const html = `<!doctype html><html><head><meta charset="utf-8">
        <title>Statement — ${esc(d.name)}</title>
        <style>
          body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:24px;}
          h1{font-size:18px;margin:0;} .sub{color:#555;font-size:12px;margin:2px 0 12px;}
          .hdr{border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:8px;}
          .meta{margin:8px 0 16px;} .meta div{margin:2px 0;}
          table{width:100%;border-collapse:collapse;margin-top:8px;}
          th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;}
          th{background:#f3f3f3;} .num{text-align:right;font-variant-numeric:tabular-nums;}
          tfoot td{font-weight:bold;background:#fafafa;}
          .totrow td{font-weight:bold;}
          @media print{button{display:none;}}
        </style></head><body>
        <div class="hdr">
          <h1>HAVERI MILK UNION</h1>
          <div class="sub">Statement of Account · Period: ${esc(from)} to ${esc(to)}</div>
        </div>
        <div class="meta">
          <div><b>Dealer:</b> ${esc(d.code)} — ${esc(d.name)}</div>
          <div><b>Route:</b> ${esc(d.routeName ?? "—")}</div>
          <div><b>GSTIN:</b> ${esc(d.gstNumber ?? "—")}</div>
        </div>
        <table>
          <thead><tr>
            <th>Date</th><th>Voucher</th><th>Type</th><th>Particulars</th>
            <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th>
          </tr></thead>
          <tbody>
            <tr class="totrow">
              <td></td><td></td><td>Opening</td><td>Opening Balance</td>
              <td class="num"></td><td class="num"></td>
              <td class="num">${inr(openAbs)} ${stmt.openingBalance < 0 ? "Dr" : "Cr"}</td>
            </tr>
            ${lines}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4">Period totals</td>
              <td class="num">${inr(stmt.totals.debits)}</td>
              <td class="num">${inr(stmt.totals.credits)}</td>
              <td class="num"></td>
            </tr>
            <tr>
              <td colspan="6">Closing balance</td>
              <td class="num">${drcr}</td>
            </tr>
          </tfoot>
        </table>
        <p class="sub">* Dr = dealer owes us; Cr = we hold a credit for them.</p>
        <button onclick="window.print()">Print</button>
      </body></html>`;

      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply.send(html);
    }
  );
}
