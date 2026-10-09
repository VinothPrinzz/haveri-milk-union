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
import {
  postLedgerAdjustment, reverseLedgerAdjustment, AdjustmentError,
} from "../lib/ledger-adjustments.js";

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

      if (body.voucherType === "Write-off" && body.reason !== "write_off") {
        return reply.status(400).send({
          error: "Reason mismatch",
          message: "Write-off vouchers must use the 'write_off' reason.",
        });
      }

      try {
        const r = await pgClient.begin((tx) =>
          postLedgerAdjustment(tx as unknown as typeof pgClient, {
            ...body,
            userId: adminUserId(request),
          }),
        );
        return reply.status(201).send({ message: `${body.voucherType} posted`, ...r });
      } catch (e) {
        if (e instanceof AdjustmentError) {
          return reply.status(e.status).send({ error: e.error, message: e.message });
        }
        throw e;
      }
    }
  );

  // ── POST /api/v1/finance/adjustments/:id/reverse ──
  app.post(
    "/api/v1/finance/adjustments/:id/reverse",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ reasonText: z.string().min(5, "Reason text is required") }).parse(request.body);

      try {
        const r = await pgClient.begin((tx) =>
          reverseLedgerAdjustment(tx as unknown as typeof pgClient, {
            adjustmentId: id,
            reasonText: body.reasonText,
            userId: adminUserId(request),
          }),
        );
        return reply.status(201).send({ message: "Adjustment reversed", ...r });
      } catch (e) {
        if (e instanceof AdjustmentError) {
          return reply.status(e.status).send({ error: e.error, message: e.message });
        }
        throw e;
      }
    }
  );
}
