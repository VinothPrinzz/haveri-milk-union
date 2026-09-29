// apps/api/src/routes/finance-dashboard.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Dashboard
//
//   GET /api/v1/finance/dashboard?period=mtd
//
// Aggregates the summary queries from every other finance page into one
// payload, plus a prioritised "attention" exception feed. finance.view.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { istToday } from "../lib/ist-date.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

function rangeForPeriod(period: string, from?: string, to?: string): { from: string; to: string } {
  const todayStr = istToday();
  if (period === "custom" && from && to) return { from, to };
  if (period === "today") return { from: todayStr, to: todayStr };
  if (period === "last30") {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 30);
    return { from: d.toISOString().slice(0, 10), to: todayStr };
  }
  // mtd (default)
  const d = new Date();
  return { from: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-01`, to: todayStr };
}

export async function financeDashboardRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/finance/dashboard",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z.object({
        period: z.enum(["today", "mtd", "last30", "custom"]).default("mtd"),
        from:   isoDate.optional(),
        to:     isoDate.optional(),
      }).parse(request.query);
      const { from, to } = rangeForPeriod(q.period, q.from, q.to);

      // ── Receivables (AR aging) ──
      const [recv] = await pgClient`
        WITH unpaid_invoices AS (
          SELECT
            i.dealer_id,
            (i.total_amount - COALESCE(i.paid_amount, 0))::numeric AS outstanding,
            -- COALESCE, not a due_date IS NOT NULL filter: the column was NULL
            -- on every invoice, so this block reported ₹0 receivables rather
            -- than admitting it had nothing to age. See finance-ar-aging.ts.
            CASE
              WHEN ag.due >= ag.today                    THEN 'current'
              WHEN (ag.today - ag.due) BETWEEN 1  AND 30 THEN 'b1_30'
              WHEN (ag.today - ag.due) BETWEEN 31 AND 60 THEN 'b31_60'
              WHEN (ag.today - ag.due) BETWEEN 61 AND 90 THEN 'b61_90'
              ELSE 'b90_plus'
            END AS bucket
          FROM invoices i
          -- The date this invoice ages from, and today, both on the IST
          -- calendar day. Mirrors finance-ar-aging.ts, which this tile links
          -- through to, so the two cannot drift a day apart.
          CROSS JOIN LATERAL (
            SELECT COALESCE(i.due_date,
                            (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date) AS due,
                   (now() AT TIME ZONE 'Asia/Kolkata')::date                    AS today
          ) ag
          WHERE i.payment_status <> 'paid'
            -- Employee subsidy indents carry no dealer and are recovered from
            -- salary off-system; AR aging excludes them, so this must too.
            AND i.dealer_id IS NOT NULL
            AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
            -- A cancelled sale is not a receivable on either rail, and neither
            -- is a draft. Same clauses as finance-ar-aging.ts, which this tile
            -- links through to: without them the tile read ₹27,737.14 higher
            -- than the report it opens.
            AND NOT EXISTS (SELECT 1 FROM direct_sales ds
                             WHERE ds.id = i.order_id AND ds.status = 'cancelled')
            AND NOT EXISTS (SELECT 1 FROM orders o
                             WHERE o.id = i.order_id
                               AND o.status IN ('cancelled', 'draft'))
        )
        SELECT
          COALESCE(SUM(outstanding), 0)::float8 AS "totalOutstanding",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket <> 'current'), 0)::float8 AS "totalOverdue",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'b90_plus'), 0)::float8 AS "overdue90Plus",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'current'),  0)::float8 AS "current",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'b1_30'),    0)::float8 AS "b1_30",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'b31_60'),   0)::float8 AS "b31_60",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'b61_90'),   0)::float8 AS "b61_90",
          COALESCE(SUM(outstanding) FILTER (WHERE bucket = 'b90_plus'), 0)::float8 AS "b90Plus",
          COUNT(DISTINCT dealer_id)::int AS "dealersWithDues"
        FROM unpaid_invoices
      `;

      // ── Collections ──
      const [coll] = await pgClient`
        SELECT
          COALESCE(SUM(amount) FILTER (
            WHERE received_date = (now() AT TIME ZONE 'Asia/Kolkata')::date
          ), 0)::float8 AS "today",
          COALESCE(SUM(amount) FILTER (
            WHERE received_date >= date_trunc('month', (now() AT TIME ZONE 'Asia/Kolkata')::date)
          ), 0)::float8 AS "thisMonth",
          COALESCE(SUM(amount) FILTER (WHERE mode = 'cash'),   0)::float8 AS "cash",
          COALESCE(SUM(amount) FILTER (WHERE mode = 'upi'),    0)::float8 AS "upi",
          COALESCE(SUM(amount) FILTER (WHERE mode = 'cheque'), 0)::float8 AS "cheque",
          COALESCE(SUM(amount) FILTER (WHERE mode = 'neft'),   0)::float8 AS "neft",
          COALESCE(SUM(amount) FILTER (WHERE mode = 'rtgs'),   0)::float8 AS "rtgs",
          COALESCE(SUM(amount) FILTER (WHERE mode = 'wallet'), 0)::float8 AS "wallet"
        FROM payments
        WHERE received_date BETWEEN ${from}::date AND ${to}::date
      `;

      // ── Online (Razorpay) ──
      const [online] = await pgClient`
        SELECT
          COALESCE(SUM(amount - amount_refunded) FILTER (
            WHERE status = 'paid' AND settlement_id IS NULL), 0)::float8 AS "pendingSettlement",
          COUNT(*) FILTER (
            WHERE status IN ('paid','refunded') AND reconciled_at IS NULL
              AND EXISTS (SELECT 1 FROM payments p WHERE p.reference = razorpay_payment_id AND p.mode='upi'))::int AS "needsReview",
          COUNT(*) FILTER (
            WHERE status IN ('paid','refunded')
              AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.reference = razorpay_payment_id AND p.mode='upi'))::int AS "notPosted"
        FROM razorpay_payments
      `;

      // ── Cheques ──
      const [chq] = await pgClient`
        SELECT
          COALESCE(SUM(amount) FILTER (WHERE status='received'), 0)::float8 AS "inHandAmount",
          COUNT(*) FILTER (WHERE status='received')::int AS "inHandCount",
          COALESCE(SUM(amount) FILTER (WHERE status='deposited'), 0)::float8 AS "inBankAmount",
          COUNT(*) FILTER (WHERE status='deposited')::int AS "inBankCount",
          COALESCE(SUM(amount) FILTER (WHERE status='bounced'
            AND bounced_date >= date_trunc('month',
                                           (now() AT TIME ZONE 'Asia/Kolkata')::date)),
            0)::float8 AS "bouncedThisMonth"
        FROM cheques
      `;

      // ── Credit control ──
      const [cc] = await pgClient`
        WITH dealer_balance AS (
          SELECT
            COALESCE(d.credit_limit, 0)::numeric AS credit_limit,
            (
              COALESCE(d.opening_balance, 0)
              + COALESCE((
                  SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount
                                  WHEN dl.type='debit'  THEN -dl.amount END)
                    FROM dealer_ledger dl
                   WHERE dl.dealer_id = d.id AND COALESCE(dl.voucher_type,'') <> 'Opening'
                ), 0)
            )::numeric AS closing_balance
          FROM dealers d WHERE d.deleted_at IS NULL
        )
        SELECT
          -- Prepaid model: "overLimit" is now "customers carrying a negative
          -- (owed) balance"; available is the sum of positive balances.
          COUNT(*) FILTER (WHERE closing_balance < 0)::int AS "overLimitCount",
          COALESCE(SUM(GREATEST(0, -closing_balance)), 0)::float8 AS "totalExposure",
          COALESCE(SUM(GREATEST(0, closing_balance)), 0)::float8 AS "totalAvailable"
        FROM dealer_balance
      `;

      // ── Attention feed ──
      const attention = await pgClient`
        SELECT * FROM (
          SELECT 'critical' AS severity, 'Online payments not posted to books' AS label,
                 COUNT(*)::int AS count, '/finance/reconciliation?bucket=not_posted' AS link, 1 AS ord
          FROM razorpay_payments
          WHERE status IN ('paid','refunded')
            AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.reference = razorpay_payment_id AND p.mode='upi')
          HAVING COUNT(*) > 0
          UNION ALL
          SELECT 'high', 'Customers with a negative balance', x.cnt, '/finance/credit-control?statusBucket=empty', 2
          FROM (
            SELECT COUNT(*)::int AS cnt FROM (
              SELECT (COALESCE(d.opening_balance,0)
                + COALESCE((SELECT SUM(CASE WHEN dl.type='credit' THEN dl.amount WHEN dl.type='debit' THEN -dl.amount END)
                    FROM dealer_ledger dl WHERE dl.dealer_id=d.id AND COALESCE(dl.voucher_type,'')<>'Opening'),0)) AS closing
              FROM dealers d WHERE d.deleted_at IS NULL
            ) y WHERE closing < 0
          ) x WHERE x.cnt > 0
          UNION ALL
          SELECT 'medium', 'Cheques in hand awaiting deposit > 3 days', COUNT(*)::int, '/finance/cheques?status=received', 3
          FROM cheques WHERE status='received' AND received_date < (now() AT TIME ZONE 'Asia/Kolkata')::date - 3
          HAVING COUNT(*) > 0
          UNION ALL
          SELECT 'medium', 'Refunds pending at gateway', COUNT(*)::int, '/finance/refunds?status=pending', 3
          FROM razorpay_refunds WHERE status='pending'
          HAVING COUNT(*) > 0
          UNION ALL
          SELECT 'high', '90+ day overdue dealers', COUNT(DISTINCT dealer_id)::int, '/finance/ar-aging?bucket=b90_plus', 2
          FROM invoices i
           WHERE i.payment_status <> 'paid'
             AND COALESCE(i.due_date,
                          (i.invoice_date AT TIME ZONE 'Asia/Kolkata')::date)
                   < (now() AT TIME ZONE 'Asia/Kolkata')::date - 90
             AND (i.total_amount - COALESCE(i.paid_amount, 0)) > 0
             AND i.dealer_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM direct_sales ds
                              WHERE ds.id = i.order_id AND ds.status = 'cancelled')
             AND NOT EXISTS (SELECT 1 FROM orders o
                              WHERE o.id = i.order_id
                                AND o.status IN ('cancelled', 'draft'))
          HAVING COUNT(*) > 0
        ) feed
        ORDER BY ord, label
      `;

      // ── Recent activity ──
      const recent = await pgClient`
        SELECT dl.voucher_date AS "date", d.name AS "dealerName",
               dl.voucher_type AS "voucherType", dl.type::text AS "type",
               dl.amount::float8 AS amount, dl.voucher_no AS "voucherNo"
          FROM dealer_ledger dl
          JOIN dealers d ON d.id = dl.dealer_id
          -- Play Store demo route: a reviewer's test activity is not the union's
          -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
          AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                           WHERE demo_rt.code = 'DEMO'
                             AND demo_rt.id = d.route_id)
         ORDER BY dl.created_at DESC
         LIMIT 15
      `;

      const c: any = coll;
      return reply.send({
        period: { period: q.period, from, to },
        receivables: {
          totalOutstanding: (recv as any).totalOutstanding,
          totalOverdue:     (recv as any).totalOverdue,
          overdue90Plus:    (recv as any).overdue90Plus,
          aging: {
            current: (recv as any).current, b1_30: (recv as any).b1_30,
            b31_60: (recv as any).b31_60, b61_90: (recv as any).b61_90,
            b90Plus: (recv as any).b90Plus,
          },
          dealersWithDues: (recv as any).dealersWithDues,
        },
        collections: {
          today: c.today, thisMonth: c.thisMonth,
          byMode: { cash: c.cash, upi: c.upi, cheque: c.cheque, neft: c.neft, rtgs: c.rtgs, wallet: c.wallet },
        },
        online,
        cheques: chq,
        creditControl: cc,
        attention,
        recent,
      });
    }
  );
}
