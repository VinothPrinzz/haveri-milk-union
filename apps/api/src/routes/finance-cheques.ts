// apps/api/src/routes/finance-cheques.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Cheque Register
//
//   GET  /api/v1/finance/cheques                — list + filters
//   GET  /api/v1/finance/cheques/summary        — KPI tiles
//   GET  /api/v1/finance/cheques/deposit-slip    — printable slip (HTML)
//   GET  /api/v1/finance/cheques/:id            — detail
//   POST /api/v1/finance/cheques/:id/deposit    — mark deposited
//   POST /api/v1/finance/cheques/:id/clear      — mark cleared
//   POST /api/v1/finance/cheques/:id/bounce     — mark bounced (+ ledger reversal)
//   POST /api/v1/finance/cheques/:id/cancel     — void before deposit
//
// Lifecycle model = "post on receipt, reverse on bounce" (Option B).
// GETs require finance.view; transitions require finance.manage.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

function adminUserId(request: FastifyRequest): string {
  const a = (request as unknown as { admin?: { userId: string } }).admin;
  if (!a?.userId) throw new Error("adminAuth middleware not set");
  return a.userId;
}
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function inr(n: number): string {
  return "₹" + Number(n).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Running closing-balance for a dealer (same formula as checkDealerCredit).
async function dealerBalance(tx: typeof pgClient, dealerId: string): Promise<number> {
  const [bal] = await tx`
    SELECT COALESCE(d.opening_balance, 0)
         + COALESCE((
             SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                             WHEN dl.type = 'debit'  THEN -dl.amount END)
               FROM dealer_ledger dl
              WHERE dl.dealer_id = d.id
                AND COALESCE(dl.voucher_type, '') <> 'Opening'
           ), 0)::numeric AS bal
      FROM dealers d WHERE d.id = ${dealerId}::uuid
  `;
  return parseFloat((bal as any).bal);
}

export async function financeChequesRoutes(app: FastifyInstance) {
  // ── GET /api/v1/finance/cheques ──
  app.get(
    "/api/v1/finance/cheques",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        status:   z.enum(["received", "deposited", "cleared", "bounced", "stopped", "cancelled"]).optional(),
        dealerId: z.string().uuid().optional(),
        bankName: z.string().optional(),
        dateFrom: isoDate.optional(),
        dateTo:   isoDate.optional(),
        search:   z.string().optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);

      const status   = q.status ?? null;
      const dealerId = q.dealerId ?? null;
      const bankName = q.bankName ? `%${q.bankName}%` : null;
      const dateFrom = q.dateFrom ?? null;
      const dateTo   = q.dateTo ?? null;
      const search   = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        SELECT
          c.id,
          c.cheque_number     AS "chequeNumber",
          c.cheque_date       AS "chequeDate",
          c.bank_name         AS "bankName",
          c.branch,
          c.amount::float8    AS amount,
          c.status::text      AS status,
          c.received_date     AS "receivedDate",
          c.deposited_date    AS "depositedDate",
          c.deposit_slip_no   AS "depositSlipNo",
          c.deposited_to_bank AS "depositedToBank",
          c.cleared_date      AS "clearedDate",
          c.bounced_date      AS "bouncedDate",
          c.bounce_reason     AS "bounceReason",
          c.bank_charges::float8 AS "bankCharges",
          CASE c.status
            WHEN 'received'  THEN CURRENT_DATE - c.received_date
            WHEN 'deposited' THEN CURRENT_DATE - c.deposited_date
            ELSE 0
          END                 AS "ageingDays",
          d.id                AS "dealerId",
          d.code              AS "dealerCode",
          d.name              AS "dealerName",
          p.id                AS "paymentId",
          p.invoice_id        AS "invoiceId",
          i.invoice_number    AS "invoiceNumber"
        FROM cheques c
        JOIN dealers d  ON d.id = c.dealer_id
        JOIN payments p ON p.id = c.payment_id
        LEFT JOIN invoices i ON i.id = p.invoice_id
        WHERE
          (${status}::text   IS NULL OR c.status::text = ${status}::text)
          AND (${dealerId}::uuid IS NULL OR c.dealer_id = ${dealerId}::uuid)
          AND (${bankName}::text IS NULL OR c.bank_name ILIKE ${bankName}::text)
          AND (${dateFrom}::date IS NULL OR c.received_date >= ${dateFrom}::date)
          AND (${dateTo}::date   IS NULL OR c.received_date <= ${dateTo}::date)
          AND (${search}::text   IS NULL OR
               d.name ILIKE ${search}::text OR d.code ILIKE ${search}::text OR
               c.cheque_number ILIKE ${search}::text OR c.bank_name ILIKE ${search}::text)
        ORDER BY
          CASE c.status WHEN 'received'  THEN 1
                        WHEN 'deposited' THEN 2
                        WHEN 'bounced'   THEN 3
                        WHEN 'stopped'   THEN 4
                        WHEN 'cleared'   THEN 5
                        WHEN 'cancelled' THEN 6 END,
          c.received_date DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM cheques c
        JOIN dealers d ON d.id = c.dealer_id
        WHERE
          (${status}::text   IS NULL OR c.status::text = ${status}::text)
          AND (${dealerId}::uuid IS NULL OR c.dealer_id = ${dealerId}::uuid)
          AND (${bankName}::text IS NULL OR c.bank_name ILIKE ${bankName}::text)
          AND (${dateFrom}::date IS NULL OR c.received_date >= ${dateFrom}::date)
          AND (${dateTo}::date   IS NULL OR c.received_date <= ${dateTo}::date)
          AND (${search}::text   IS NULL OR
               d.name ILIKE ${search}::text OR d.code ILIKE ${search}::text OR
               c.cheque_number ILIKE ${search}::text OR c.bank_name ILIKE ${search}::text)
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // ── GET /api/v1/finance/cheques/summary ──
  app.get(
    "/api/v1/finance/cheques/summary",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z.object({ dateFrom: isoDate.optional(), dateTo: isoDate.optional() }).parse(request.query);
      const dateFrom = q.dateFrom ?? "1970-01-01";
      const dateTo   = q.dateTo ?? "9999-12-31";

      const [s] = await pgClient`
        SELECT
          COUNT(*) FILTER (WHERE status = 'received')::int                     AS "inHandCount",
          COALESCE(SUM(amount) FILTER (WHERE status = 'received'), 0)::float8  AS "inHandAmount",
          COUNT(*) FILTER (WHERE status = 'deposited')::int                    AS "inBankCount",
          COALESCE(SUM(amount) FILTER (WHERE status = 'deposited'), 0)::float8 AS "inBankAmount",
          COUNT(*) FILTER (WHERE status = 'cleared'
                             AND cleared_date BETWEEN ${dateFrom}::date AND ${dateTo}::date)::int AS "clearedCount",
          COALESCE(SUM(amount) FILTER (WHERE status = 'cleared'
                             AND cleared_date BETWEEN ${dateFrom}::date AND ${dateTo}::date), 0)::float8 AS "clearedAmount",
          COUNT(*) FILTER (WHERE status = 'bounced'
                             AND bounced_date BETWEEN ${dateFrom}::date AND ${dateTo}::date)::int AS "bouncedCount",
          COALESCE(SUM(amount) FILTER (WHERE status = 'bounced'
                             AND bounced_date BETWEEN ${dateFrom}::date AND ${dateTo}::date), 0)::float8 AS "bouncedAmount",
          COUNT(*) FILTER (WHERE status = 'received'
                             AND received_date < CURRENT_DATE - 3)::int        AS "stagnantInHandCount"
        FROM cheques
      `;
      return reply.send({ summary: s });
    }
  );

  // ── GET /api/v1/finance/cheques/deposit-slip (printable HTML) ──
  app.get(
    "/api/v1/finance/cheques/deposit-slip",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z.object({ ids: z.string().optional() }).parse(request.query);
      const ids = q.ids ? q.ids.split(",").map((x) => x.trim()).filter(Boolean) : null;

      const rows = await pgClient`
        SELECT c.cheque_number AS "chequeNumber", c.bank_name AS "bankName",
               c.branch, c.amount::float8 AS amount, c.received_date AS "receivedDate",
               d.name AS "dealerName", d.code AS "dealerCode"
          FROM cheques c
          JOIN dealers d ON d.id = c.dealer_id
         WHERE c.status = 'received'
           AND (${ids}::uuid[] IS NULL OR c.id = ANY(${ids}::uuid[]))
         ORDER BY c.bank_name, c.cheque_number
      `;

      const total = (rows as any[]).reduce((a, r) => a + r.amount, 0);
      const body = (rows as any[]).map((r, i) => `
        <tr>
          <td>${i + 1}</td>
          <td>${esc(r.dealerCode)} — ${esc(r.dealerName)}</td>
          <td>${esc(r.bankName)}${r.branch ? " / " + esc(r.branch) : ""}</td>
          <td>${esc(r.chequeNumber)}</td>
          <td class="num">${inr(r.amount)}</td>
        </tr>`).join("");

      const html = `<!doctype html><html><head><meta charset="utf-8">
        <title>Deposit Slip</title>
        <style>
          body{font-family:Arial,sans-serif;font-size:12px;margin:24px;color:#111;}
          h1{font-size:16px;} table{width:100%;border-collapse:collapse;margin-top:10px;}
          th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;}
          th{background:#f3f3f3;} .num{text-align:right;}
          tfoot td{font-weight:bold;background:#fafafa;}
          @media print{button{display:none;}}
        </style></head><body>
        <h1>HAVERI MILK UNION — Cheque Deposit Slip</h1>
        <div>Date: ${esc(new Date().toISOString().slice(0, 10))} · Cheques: ${rows.length}</div>
        <table>
          <thead><tr><th>#</th><th>Dealer</th><th>Bank</th><th>Cheque No.</th><th class="num">Amount</th></tr></thead>
          <tbody>${body || `<tr><td colspan="5">No cheques in hand</td></tr>`}</tbody>
          <tfoot><tr><td colspan="4">Total</td><td class="num">${inr(total)}</td></tr></tfoot>
        </table>
        <button onclick="window.print()">Print</button>
      </body></html>`;
      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply.send(html);
    }
  );

  // ── GET /api/v1/finance/cheques/:id (detail) ──
  app.get(
    "/api/v1/finance/cheques/:id",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const [c] = await pgClient`
        SELECT
          c.id, c.cheque_number AS "chequeNumber", c.cheque_date AS "chequeDate",
          c.bank_name AS "bankName", c.branch, c.amount::float8 AS amount,
          c.status::text AS status, c.received_date AS "receivedDate",
          c.deposited_date AS "depositedDate", c.deposited_to_bank AS "depositedToBank",
          c.deposit_slip_no AS "depositSlipNo", c.cleared_date AS "clearedDate",
          c.bounced_date AS "bouncedDate", c.bounce_reason AS "bounceReason",
          c.bank_charges::float8 AS "bankCharges", c.notes,
          c.reversal_ledger_entry_id AS "reversalLedgerEntryId",
          d.id AS "dealerId", d.code AS "dealerCode", d.name AS "dealerName",
          p.id AS "paymentId", p.invoice_id AS "invoiceId", i.invoice_number AS "invoiceNumber",
          ru.name AS "receivedByName", du.name AS "depositedByName",
          cu.name AS "markedClearedByName", bu.name AS "markedBouncedByName"
        FROM cheques c
        JOIN dealers d  ON d.id = c.dealer_id
        JOIN payments p ON p.id = c.payment_id
        LEFT JOIN invoices i ON i.id = p.invoice_id
        LEFT JOIN users ru ON ru.id = c.received_by
        LEFT JOIN users du ON du.id = c.deposited_by
        LEFT JOIN users cu ON cu.id = c.marked_cleared_by
        LEFT JOIN users bu ON bu.id = c.marked_bounced_by
        WHERE c.id = ${id}::uuid
        LIMIT 1
      `;
      if (!c) return reply.status(404).send({ error: "Cheque not found" });
      return reply.send({ cheque: c });
    }
  );

  // ── POST /api/v1/finance/cheques/:id/deposit ──
  app.post(
    "/api/v1/finance/cheques/:id/deposit",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        depositedDate:   isoDate,
        depositedToBank: z.string().min(1),
        depositSlipNo:   z.string().optional(),
      }).parse(request.body);

      const [c] = await pgClient`SELECT status::text AS status FROM cheques WHERE id = ${id}::uuid LIMIT 1`;
      if (!c) return reply.status(404).send({ error: "Cheque not found" });
      if (c.status !== "received") {
        return reply.status(400).send({ error: "Invalid transition", message: `Cannot deposit a cheque in status '${c.status}'.` });
      }
      const [updated] = await pgClient`
        UPDATE cheques SET
          status = 'deposited'::cheque_status,
          deposited_date = ${body.depositedDate}::date,
          deposited_to_bank = ${body.depositedToBank},
          deposit_slip_no = ${body.depositSlipNo ?? null},
          deposited_by = ${adminUserId(request)}::uuid,
          updated_at = now()
        WHERE id = ${id}::uuid
        RETURNING id, status::text AS status
      `;
      return reply.send({ message: "Cheque deposited", ...updated });
    }
  );

  // ── POST /api/v1/finance/cheques/:id/clear ──
  app.post(
    "/api/v1/finance/cheques/:id/clear",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ clearedDate: isoDate }).parse(request.body);

      const [c] = await pgClient`SELECT status::text AS status FROM cheques WHERE id = ${id}::uuid LIMIT 1`;
      if (!c) return reply.status(404).send({ error: "Cheque not found" });
      if (c.status !== "deposited") {
        return reply.status(400).send({ error: "Invalid transition", message: `Cannot clear a cheque in status '${c.status}'.` });
      }
      const [updated] = await pgClient`
        UPDATE cheques SET
          status = 'cleared'::cheque_status,
          cleared_date = ${body.clearedDate}::date,
          marked_cleared_by = ${adminUserId(request)}::uuid,
          updated_at = now()
        WHERE id = ${id}::uuid
        RETURNING id, status::text AS status
      `;
      return reply.send({ message: "Cheque cleared", ...updated });
    }
  );

  // ── POST /api/v1/finance/cheques/:id/bounce ──
  // Reverses the ledger credit posted on receipt, rolls back the invoice,
  // and (optionally) passes bank charges to the dealer. One transaction.
  app.post(
    "/api/v1/finance/cheques/:id/bounce",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        bouncedDate:         isoDate,
        bounceReason:        z.string().min(3),
        bankCharges:         z.number().min(0).default(0),
        passChargesToDealer: z.boolean().default(false),
      }).parse(request.body);

      return await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        const [c] = await tx`
          SELECT c.*, p.invoice_id AS "invoiceId"
            FROM cheques c
            JOIN payments p ON p.id = c.payment_id
           WHERE c.id = ${id}::uuid
           FOR UPDATE
        `;
        if (!c) return reply.status(404).send({ error: "Cheque not found" });
        if (c.status !== "deposited" && c.status !== "received") {
          return reply.status(400).send({
            error: "Invalid transition",
            message: `Cannot bounce a cheque in status '${c.status}'.`,
          });
        }

        const amount = parseFloat(c.amount);
        const bal = await dealerBalance(tx, c.dealer_id);
        const balanceAfter = bal - amount;

        const [reversal] = await tx`
          INSERT INTO dealer_ledger (
            dealer_id, type, amount,
            reference_id, reference_type,
            description, balance_after, performed_by,
            voucher_no, voucher_type, particulars, voucher_date
          ) VALUES (
            ${c.dealer_id}::uuid, 'debit', ${amount.toFixed(2)}::numeric,
            ${c.id}::uuid, 'adjustment'::ledger_ref_type,
            ${`Cheque bounced — ${c.cheque_number} from ${c.bank_name} — ${body.bounceReason}`},
            ${balanceAfter.toFixed(2)}::numeric, ${adminUserId(request)}::uuid,
            ${`CB-${c.cheque_number}`}, 'Adjustment',
            ${`Cheque ${c.cheque_number} returned: ${body.bounceReason}`},
            ${body.bouncedDate}::date
          )
          RETURNING id
        `;

        await tx`
          UPDATE cheques SET
            status = 'bounced'::cheque_status,
            bounced_date = ${body.bouncedDate}::date,
            bounce_reason = ${body.bounceReason},
            bank_charges = ${body.bankCharges.toFixed(2)}::numeric,
            marked_bounced_by = ${adminUserId(request)}::uuid,
            reversal_ledger_entry_id = ${(reversal as any).id}::uuid,
            updated_at = now()
          WHERE id = ${id}::uuid
        `;

        if (c.invoiceId) {
          await tx`
            UPDATE invoices
               SET paid_amount = GREATEST(0, paid_amount - ${amount.toFixed(2)}::numeric),
                   payment_status = CASE
                     WHEN GREATEST(0, paid_amount - ${amount.toFixed(2)}::numeric) = 0 THEN 'unpaid'
                     WHEN GREATEST(0, paid_amount - ${amount.toFixed(2)}::numeric) >= total_amount THEN 'paid'
                     ELSE 'partial'
                   END
             WHERE id = ${c.invoiceId}::uuid
          `;
        }

        if (body.passChargesToDealer && body.bankCharges > 0) {
          const after = balanceAfter - body.bankCharges;
          await tx`
            INSERT INTO dealer_ledger (
              dealer_id, type, amount,
              reference_id, reference_type,
              description, balance_after, performed_by,
              voucher_no, voucher_type, particulars, voucher_date
            ) VALUES (
              ${c.dealer_id}::uuid, 'debit', ${body.bankCharges.toFixed(2)}::numeric,
              ${c.id}::uuid, 'adjustment'::ledger_ref_type,
              ${`Cheque return charges — ${c.cheque_number}`},
              ${after.toFixed(2)}::numeric, ${adminUserId(request)}::uuid,
              ${`CC-${c.cheque_number}`}, 'Adjustment',
              ${`Bank charges for returned cheque ${c.cheque_number}`},
              ${body.bouncedDate}::date
            )
          `;
        }

        return reply.send({
          message: "Cheque marked bounced and ledger reversed",
          chequeId: id,
          reversalLedgerEntryId: (reversal as any).id,
        });
      });
    }
  );

  // ── POST /api/v1/finance/cheques/:id/cancel ──
  // Only when status='received'. Reverses the original ledger credit and
  // rolls back the linked invoice. The payment row is kept (audit).
  app.post(
    "/api/v1/finance/cheques/:id/cancel",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ reason: z.string().min(3) }).parse(request.body);

      return await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        const [c] = await tx`
          SELECT c.*, p.invoice_id AS "invoiceId"
            FROM cheques c
            JOIN payments p ON p.id = c.payment_id
           WHERE c.id = ${id}::uuid
           FOR UPDATE
        `;
        if (!c) return reply.status(404).send({ error: "Cheque not found" });
        if (c.status !== "received") {
          return reply.status(400).send({
            error: "Invalid transition",
            message: "Cancel is only allowed before a cheque is deposited.",
          });
        }

        const amount = parseFloat(c.amount);
        const bal = await dealerBalance(tx, c.dealer_id);
        const balanceAfter = bal - amount;

        const [reversal] = await tx`
          INSERT INTO dealer_ledger (
            dealer_id, type, amount,
            reference_id, reference_type,
            description, balance_after, performed_by,
            voucher_no, voucher_type, particulars, voucher_date
          ) VALUES (
            ${c.dealer_id}::uuid, 'debit', ${amount.toFixed(2)}::numeric,
            ${c.id}::uuid, 'adjustment'::ledger_ref_type,
            ${`Cheque cancelled — ${c.cheque_number} — ${body.reason}`},
            ${balanceAfter.toFixed(2)}::numeric, ${adminUserId(request)}::uuid,
            ${`CX-${c.cheque_number}`}, 'Adjustment',
            ${`Cheque ${c.cheque_number} cancelled: ${body.reason}`},
            ${new Date().toISOString().slice(0, 10)}::date
          )
          RETURNING id
        `;

        await tx`
          UPDATE cheques SET
            status = 'cancelled'::cheque_status,
            reversal_ledger_entry_id = ${(reversal as any).id}::uuid,
            notes = COALESCE(notes || E'\n', '') || ${`Cancelled: ${body.reason}`},
            updated_at = now()
          WHERE id = ${id}::uuid
        `;

        if (c.invoiceId) {
          await tx`
            UPDATE invoices
               SET paid_amount = GREATEST(0, paid_amount - ${amount.toFixed(2)}::numeric),
                   payment_status = CASE
                     WHEN GREATEST(0, paid_amount - ${amount.toFixed(2)}::numeric) = 0 THEN 'unpaid'
                     WHEN GREATEST(0, paid_amount - ${amount.toFixed(2)}::numeric) >= total_amount THEN 'paid'
                     ELSE 'partial'
                   END
             WHERE id = ${c.invoiceId}::uuid
          `;
        }

        return reply.send({ message: "Cheque cancelled and ledger reversed", chequeId: id });
      });
    }
  );
}
