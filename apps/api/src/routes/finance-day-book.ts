// apps/api/src/routes/finance-day-book.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Day Book
//
//   GET /api/v1/finance/day-book?date=YYYY-MM-DD
//
// The classic daily cash book — every money movement for the chosen day
// plus a cash-position tally. v1: deposit-to-bank tracking is NOT
// persisted, so "cash to be banked" is shown and physical-count variance
// is computed client-side only. finance.view.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export async function financeDayBookRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/finance/day-book",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z.object({ date: isoDate.optional() }).parse(request.query);
      const date = q.date ?? new Date().toISOString().slice(0, 10);

      // 1. Receipts by mode for the day.
      const receiptsByMode = await pgClient`
        SELECT p.mode, COUNT(*)::int AS cnt, COALESCE(SUM(p.amount), 0)::float8 AS total
          FROM payments p
         WHERE p.received_date = ${date}::date
         GROUP BY p.mode
         ORDER BY total DESC
      `;

      // 2. Refunds out for the day.
      const [refundsOut] = await pgClient`
        SELECT COUNT(*)::int AS cnt, COALESCE(SUM(amount), 0)::float8 AS total
          FROM razorpay_refunds
         WHERE status = 'processed' AND processed_at::date = ${date}::date
      `;

      // 3. Adjustments posted that day.
      const adjustments = await pgClient`
        SELECT a.voucher_type AS "voucherType", dl.type::text AS type,
               COUNT(*)::int AS cnt, COALESCE(SUM(dl.amount), 0)::float8 AS total
          FROM ledger_adjustments a
          JOIN dealer_ledger dl ON dl.id = a.ledger_entry_id
         WHERE dl.voucher_date = ${date}::date
         GROUP BY a.voucher_type, dl.type
      `;

      // 4. Full transaction list for the day.
      const lines = await pgClient`
        SELECT
          p.id, p.received_date AS "date", p.mode, p.amount::float8 AS amount,
          p.reference, d.code AS "dealerCode", d.name AS "dealerName",
          i.invoice_number AS "invoiceNumber", u.name AS "receivedByName",
          r.name AS "routeName", p.created_at AS "createdAt"
        FROM payments p
        JOIN dealers d ON d.id = p.dealer_id
        LEFT JOIN invoices i ON i.id = p.invoice_id
        LEFT JOIN users u ON u.id = p.received_by
        LEFT JOIN routes r ON r.id = d.route_id
        WHERE p.received_date = ${date}::date
        ORDER BY p.created_at ASC
      `;

      // 5. Route-wise cash breakdown.
      const routeWise = await pgClient`
        SELECT r.id, r.name, COALESCE(SUM(p.amount), 0)::float8 AS collected,
               COUNT(*)::int AS receipts
          FROM payments p
          JOIN dealers d ON d.id = p.dealer_id
          LEFT JOIN routes r ON r.id = d.route_id
         WHERE p.received_date = ${date}::date AND p.mode = 'cash'
         GROUP BY r.id, r.name
         ORDER BY collected DESC
      `;

      // Totals strip.
      const byMode: Record<string, number> = {};
      let totalReceipts = 0, cashCollected = 0;
      for (const r of receiptsByMode as any[]) {
        byMode[r.mode] = r.total;
        totalReceipts += r.total;
        if (r.mode === "cash") cashCollected = r.total;
      }
      const net = totalReceipts - ((refundsOut as any)?.total ?? 0);

      return reply.send({
        date,
        receiptsByMode,
        refundsOut,
        adjustments,
        lines,
        routeWise,
        summary: {
          totalReceipts,
          byMode,
          refundsOut: (refundsOut as any)?.total ?? 0,
          net,
          cashCollected,
        },
      });
    }
  );
}
