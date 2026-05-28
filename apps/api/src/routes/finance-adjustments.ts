// apps/api/src/routes/finance-adjustments.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Credit Notes & Adjustments
//
//   GET  /api/v1/finance/adjustments              — list + filters
//   GET  /api/v1/finance/adjustments/summary      — KPI tiles
//   GET  /api/v1/finance/adjustments/:id          — detail
//   POST /api/v1/finance/adjustments              — issue CN / DN / Write-off
//   POST /api/v1/finance/adjustments/:id/reverse  — append a reversing entry
//
// Direction is driven by voucher_type, not user input:
//   Credit Note + Write-off → ledger credit; Debit Note → ledger debit.
// GETs require finance.view; mutations require finance.manage.
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

const REASONS = [
  "sale_return", "billing_error", "goodwill", "damaged_goods",
  "rate_difference", "late_fee", "interest", "bounce_charges",
  "missed_billing", "write_off", "other",
] as const;

export async function financeAdjustmentsRoutes(app: FastifyInstance) {
  // ── GET /api/v1/finance/adjustments ──
  app.get(
    "/api/v1/finance/adjustments",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        voucherType: z.enum(["Credit Note", "Debit Note", "Write-off"]).optional(),
        reason:      z.enum(REASONS).optional(),
        dealerId:    z.string().uuid().optional(),
        dateFrom:    isoDate.optional(),
        dateTo:      isoDate.optional(),
        search:      z.string().optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);

      const voucherType = q.voucherType ?? null;
      const reason      = q.reason ?? null;
      const dealerId    = q.dealerId ?? null;
      const dateFrom    = q.dateFrom ?? null;
      const dateTo      = q.dateTo ?? null;
      const search      = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        SELECT
          a.id,
          a.voucher_type           AS "voucherType",
          a.reason::text           AS reason,
          a.reason_text            AS "reasonText",
          a.attachment_url         AS "attachmentUrl",
          a.created_at             AS "createdAt",
          dl.id                    AS "ledgerEntryId",
          dl.voucher_no            AS "voucherNo",
          dl.voucher_date          AS "voucherDate",
          dl.type::text            AS "ledgerType",
          dl.amount::float8        AS amount,
          dl.balance_after::float8 AS "balanceAfter",
          d.id                     AS "dealerId",
          d.code                   AS "dealerCode",
          d.name                   AS "dealerName",
          i.id                     AS "invoiceId",
          i.invoice_number         AS "invoiceNumber",
          u.name                   AS "initiatedByName",
          EXISTS (
            SELECT 1 FROM ledger_adjustments a2
            WHERE a2.reverses_ledger_entry_id = a.ledger_entry_id
          )                        AS "isReversed",
          (a.reverses_ledger_entry_id IS NOT NULL) AS "isReversal"
        FROM ledger_adjustments a
        JOIN dealer_ledger dl ON dl.id = a.ledger_entry_id
        JOIN dealers d        ON d.id  = a.dealer_id
        LEFT JOIN invoices i  ON i.id  = a.invoice_id
        LEFT JOIN users u     ON u.id  = a.initiated_by
        WHERE
          (${voucherType}::text IS NULL OR a.voucher_type = ${voucherType}::text)
          AND (${reason}::text    IS NULL OR a.reason::text = ${reason}::text)
          AND (${dealerId}::uuid  IS NULL OR a.dealer_id = ${dealerId}::uuid)
          AND (${dateFrom}::date  IS NULL OR dl.voucher_date >= ${dateFrom}::date)
          AND (${dateTo}::date    IS NULL OR dl.voucher_date <= ${dateTo}::date)
          AND (${search}::text    IS NULL OR
               d.name ILIKE ${search}::text OR d.code ILIKE ${search}::text OR
               dl.voucher_no ILIKE ${search}::text OR a.reason_text ILIKE ${search}::text)
        ORDER BY dl.voucher_date DESC, a.created_at DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM ledger_adjustments a
        JOIN dealer_ledger dl ON dl.id = a.ledger_entry_id
        JOIN dealers d        ON d.id  = a.dealer_id
        WHERE
          (${voucherType}::text IS NULL OR a.voucher_type = ${voucherType}::text)
          AND (${reason}::text    IS NULL OR a.reason::text = ${reason}::text)
          AND (${dealerId}::uuid  IS NULL OR a.dealer_id = ${dealerId}::uuid)
          AND (${dateFrom}::date  IS NULL OR dl.voucher_date >= ${dateFrom}::date)
          AND (${dateTo}::date    IS NULL OR dl.voucher_date <= ${dateTo}::date)
          AND (${search}::text    IS NULL OR
               d.name ILIKE ${search}::text OR d.code ILIKE ${search}::text OR
               dl.voucher_no ILIKE ${search}::text OR a.reason_text ILIKE ${search}::text)
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // ── GET /api/v1/finance/adjustments/summary ──
  app.get(
    "/api/v1/finance/adjustments/summary",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z.object({ dateFrom: isoDate.optional(), dateTo: isoDate.optional() }).parse(request.query);
      const dateFrom = q.dateFrom ?? null;
      const dateTo   = q.dateTo ?? null;

      const [s] = await pgClient`
        SELECT
          COUNT(*) FILTER (WHERE a.voucher_type = 'Credit Note')::int AS "creditNoteCount",
          COALESCE(SUM(dl.amount) FILTER (WHERE a.voucher_type = 'Credit Note'), 0)::float8 AS "creditNoteAmount",
          COUNT(*) FILTER (WHERE a.voucher_type = 'Debit Note')::int AS "debitNoteCount",
          COALESCE(SUM(dl.amount) FILTER (WHERE a.voucher_type = 'Debit Note'), 0)::float8 AS "debitNoteAmount",
          COUNT(*) FILTER (WHERE a.voucher_type = 'Write-off')::int AS "writeOffCount",
          COALESCE(SUM(dl.amount) FILTER (WHERE a.voucher_type = 'Write-off'), 0)::float8 AS "writeOffAmount",
          COUNT(*) FILTER (WHERE a.reverses_ledger_entry_id IS NOT NULL)::int AS "reversalCount"
        FROM ledger_adjustments a
        JOIN dealer_ledger dl ON dl.id = a.ledger_entry_id
        WHERE (${dateFrom}::date IS NULL OR dl.voucher_date >= ${dateFrom}::date)
          AND (${dateTo}::date   IS NULL OR dl.voucher_date <= ${dateTo}::date)
      `;
      return reply.send({ summary: s });
    }
  );

  // ── GET /api/v1/finance/adjustments/:id ──
  app.get(
    "/api/v1/finance/adjustments/:id",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const [a] = await pgClient`
        SELECT
          a.id, a.voucher_type AS "voucherType", a.reason::text AS reason,
          a.reason_text AS "reasonText", a.attachment_url AS "attachmentUrl",
          a.created_at AS "createdAt", a.order_id AS "orderId",
          a.reverses_ledger_entry_id AS "reversesLedgerEntryId",
          dl.id AS "ledgerEntryId", dl.voucher_no AS "voucherNo",
          dl.voucher_date AS "voucherDate", dl.type::text AS "ledgerType",
          dl.amount::float8 AS amount, dl.balance_after::float8 AS "balanceAfter",
          dl.particulars,
          d.id AS "dealerId", d.code AS "dealerCode", d.name AS "dealerName",
          i.id AS "invoiceId", i.invoice_number AS "invoiceNumber",
          u.name AS "initiatedByName",
          (a.reverses_ledger_entry_id IS NOT NULL) AS "isReversal",
          EXISTS (SELECT 1 FROM ledger_adjustments a2
                  WHERE a2.reverses_ledger_entry_id = a.ledger_entry_id) AS "isReversed"
        FROM ledger_adjustments a
        JOIN dealer_ledger dl ON dl.id = a.ledger_entry_id
        JOIN dealers d        ON d.id  = a.dealer_id
        LEFT JOIN invoices i  ON i.id  = a.invoice_id
        LEFT JOIN users u     ON u.id  = a.initiated_by
        WHERE a.id = ${id}::uuid
        LIMIT 1
      `;
      if (!a) return reply.status(404).send({ error: "Adjustment not found" });
      return reply.send({ adjustment: a });
    }
  );

  // ── POST /api/v1/finance/adjustments ──
  app.post(
    "/api/v1/finance/adjustments",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const body = z.object({
        dealerId:     z.string().uuid(),
        voucherType:  z.enum(["Credit Note", "Debit Note", "Write-off"]),
        reason:       z.enum(REASONS),
        reasonText:   z.string().min(5, "Reason text is required"),
        amount:       z.number().positive(),
        voucherDate:  isoDate.optional(),
        invoiceId:    z.string().uuid().optional().nullable(),
        orderId:      z.string().uuid().optional().nullable(),
        attachmentUrl: z.string().url().optional().nullable(),
      }).parse(request.body);

      const ledgerType: "credit" | "debit" =
        body.voucherType === "Debit Note" ? "debit" : "credit";

      if (body.voucherType === "Write-off" && body.reason !== "write_off") {
        return reply.status(400).send({
          error: "Reason mismatch",
          message: "Write-off vouchers must use the 'write_off' reason.",
        });
      }

      return await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        const [bal] = await tx`
          SELECT COALESCE(d.opening_balance, 0)
               + COALESCE((
                   SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                                   WHEN dl.type = 'debit'  THEN -dl.amount END)
                     FROM dealer_ledger dl
                    WHERE dl.dealer_id = d.id
                      AND COALESCE(dl.voucher_type, '') <> 'Opening'
                 ), 0)::numeric AS bal
            FROM dealers d WHERE d.id = ${body.dealerId}::uuid AND d.deleted_at IS NULL
        `;
        if (!bal) return reply.status(404).send({ error: "Dealer not found" });

        const delta = ledgerType === "credit" ? body.amount : -body.amount;
        const newBalance = parseFloat((bal as any).bal) + delta;
        const voucherDate = body.voucherDate ?? new Date().toISOString().slice(0, 10);

        const prefix = body.voucherType === "Credit Note" ? "CN"
                     : body.voucherType === "Debit Note"  ? "DN"
                     :                                       "WO";
        const [seq] = await tx`
          SELECT COALESCE(MAX(
            (regexp_match(voucher_no, ${prefix} || '-\\d{8}-(\\d+)$'))[1]::int
          ), 0) + 1 AS next
          FROM dealer_ledger
          WHERE voucher_no LIKE ${prefix + "-" + voucherDate.replace(/-/g, "") + "-%"}
        `;
        const voucherNo = `${prefix}-${voucherDate.replace(/-/g, "")}-${String((seq as any).next).padStart(3, "0")}`;

        const [led] = await tx`
          INSERT INTO dealer_ledger (
            dealer_id, type, amount,
            reference_id, reference_type,
            description, balance_after, performed_by,
            voucher_no, voucher_type, particulars, voucher_date
          ) VALUES (
            ${body.dealerId}::uuid, ${ledgerType}::ledger_type,
            ${body.amount.toFixed(2)}::numeric,
            NULL, 'adjustment'::ledger_ref_type,
            ${`${body.voucherType}: ${body.reasonText}`},
            ${newBalance.toFixed(2)}::numeric,
            ${adminUserId(request)}::uuid,
            ${voucherNo}, ${body.voucherType}, ${body.reasonText}, ${voucherDate}::date
          )
          RETURNING id
        `;

        const [adj] = await tx`
          INSERT INTO ledger_adjustments (
            ledger_entry_id, dealer_id, voucher_type, reason, reason_text,
            invoice_id, order_id, attachment_url, initiated_by
          ) VALUES (
            ${(led as any).id}::uuid, ${body.dealerId}::uuid,
            ${body.voucherType}, ${body.reason}::adjustment_reason,
            ${body.reasonText},
            ${body.invoiceId ?? null}::uuid, ${body.orderId ?? null}::uuid,
            ${body.attachmentUrl ?? null}, ${adminUserId(request)}::uuid
          )
          RETURNING id
        `;

        if (body.invoiceId) {
          const sign = ledgerType === "credit" ? 1 : -1;
          await tx`
            UPDATE invoices SET
              paid_amount = LEAST(total_amount,
                              GREATEST(0, paid_amount + ${(sign * body.amount).toFixed(2)}::numeric)),
              payment_status = CASE
                WHEN LEAST(total_amount,
                       GREATEST(0, paid_amount + ${(sign * body.amount).toFixed(2)}::numeric))
                     >= total_amount THEN 'paid'
                WHEN LEAST(total_amount,
                       GREATEST(0, paid_amount + ${(sign * body.amount).toFixed(2)}::numeric))
                     > 0 THEN 'partial'
                ELSE 'unpaid'
              END
            WHERE id = ${body.invoiceId}::uuid
          `;
        }

        return reply.status(201).send({
          message: `${body.voucherType} posted`,
          ledgerEntryId: (led as any).id,
          adjustmentId:  (adj as any).id,
          voucherNo,
          balanceAfter:  newBalance,
        });
      });
    }
  );

  // ── POST /api/v1/finance/adjustments/:id/reverse ──
  app.post(
    "/api/v1/finance/adjustments/:id/reverse",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ reasonText: z.string().min(5, "Reason text is required") }).parse(request.body);

      return await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        const [src] = await tx`
          SELECT a.id, a.dealer_id, a.voucher_type, a.invoice_id,
                 a.reverses_ledger_entry_id,
                 dl.id AS ledger_entry_id, dl.type::text AS ledger_type,
                 dl.amount::numeric AS amount
            FROM ledger_adjustments a
            JOIN dealer_ledger dl ON dl.id = a.ledger_entry_id
           WHERE a.id = ${id}::uuid
           FOR UPDATE
        `;
        if (!src) return reply.status(404).send({ error: "Adjustment not found" });
        if ((src as any).reverses_ledger_entry_id) {
          return reply.status(400).send({
            error: "Cannot reverse a reversal",
            message: "This entry is already a reversal of another voucher.",
          });
        }
        const [already] = await tx`
          SELECT 1 FROM ledger_adjustments
           WHERE reverses_ledger_entry_id = ${(src as any).ledger_entry_id}::uuid LIMIT 1
        `;
        if (already) {
          return reply.status(400).send({ error: "Already reversed", message: "This voucher has already been reversed." });
        }

        const amount = parseFloat((src as any).amount);
        const flipped: "credit" | "debit" = (src as any).ledger_type === "credit" ? "debit" : "credit";

        const [bal] = await tx`
          SELECT COALESCE(d.opening_balance, 0)
               + COALESCE((
                   SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                                   WHEN dl.type = 'debit'  THEN -dl.amount END)
                     FROM dealer_ledger dl
                    WHERE dl.dealer_id = d.id
                      AND COALESCE(dl.voucher_type, '') <> 'Opening'
                 ), 0)::numeric AS bal
            FROM dealers d WHERE d.id = ${(src as any).dealer_id}::uuid
        `;
        const delta = flipped === "credit" ? amount : -amount;
        const newBalance = parseFloat((bal as any).bal) + delta;
        const voucherDate = new Date().toISOString().slice(0, 10);
        const voucherNo = `REV-${voucherDate.replace(/-/g, "")}-${String((src as any).ledger_entry_id).slice(0, 6).toUpperCase()}`;

        const [led] = await tx`
          INSERT INTO dealer_ledger (
            dealer_id, type, amount,
            reference_id, reference_type,
            description, balance_after, performed_by,
            voucher_no, voucher_type, particulars, voucher_date
          ) VALUES (
            ${(src as any).dealer_id}::uuid, ${flipped}::ledger_type,
            ${amount.toFixed(2)}::numeric,
            NULL, 'adjustment'::ledger_ref_type,
            ${`Reversal of ${(src as any).voucher_type}: ${body.reasonText}`},
            ${newBalance.toFixed(2)}::numeric, ${adminUserId(request)}::uuid,
            ${voucherNo}, ${(src as any).voucher_type}, ${body.reasonText}, ${voucherDate}::date
          )
          RETURNING id
        `;

        const [adj] = await tx`
          INSERT INTO ledger_adjustments (
            ledger_entry_id, dealer_id, voucher_type, reason, reason_text,
            invoice_id, reverses_ledger_entry_id, initiated_by
          ) VALUES (
            ${(led as any).id}::uuid, ${(src as any).dealer_id}::uuid,
            ${(src as any).voucher_type}, 'reversal'::adjustment_reason,
            ${body.reasonText},
            ${(src as any).invoice_id ?? null}::uuid,
            ${(src as any).ledger_entry_id}::uuid,
            ${adminUserId(request)}::uuid
          )
          RETURNING id
        `;

        if ((src as any).invoice_id) {
          // Reverse the original invoice effect: flip the sign.
          const sign = flipped === "credit" ? 1 : -1;
          await tx`
            UPDATE invoices SET
              paid_amount = LEAST(total_amount,
                              GREATEST(0, paid_amount + ${(sign * amount).toFixed(2)}::numeric)),
              payment_status = CASE
                WHEN LEAST(total_amount,
                       GREATEST(0, paid_amount + ${(sign * amount).toFixed(2)}::numeric))
                     >= total_amount THEN 'paid'
                WHEN LEAST(total_amount,
                       GREATEST(0, paid_amount + ${(sign * amount).toFixed(2)}::numeric))
                     > 0 THEN 'partial'
                ELSE 'unpaid'
              END
            WHERE id = ${(src as any).invoice_id}::uuid
          `;
        }

        return reply.status(201).send({
          message: "Adjustment reversed",
          ledgerEntryId: (led as any).id,
          adjustmentId:  (adj as any).id,
          voucherNo,
          balanceAfter:  newBalance,
        });
      });
    }
  );
}
