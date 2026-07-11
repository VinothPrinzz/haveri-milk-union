// apps/api/src/routes/finance-day-book.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Day Book
//
//   GET /api/v1/finance/day-book?date=YYYY-MM-DD&routeId=<uuid|unassigned>
//
// The classic daily cash book — every money movement for the chosen day:
// receipts (typed: top-up / order payment / invoice payment / on-account),
// sales (dealer orders + counter sales), refunds and adjustments, plus a
// cash-position tally and a route-wise breakdown. Receipts ≠ sales — a
// dealer may top up ₹150 and order for ₹133.33, leaving ₹16.67 in his
// wallet — so both totals are reported side by side. finance.view.
//
// Dates: receipts/sales are booked on the IST calendar day (received_date
// and voucher_date are already written IST elsewhere; order timestamps are
// converted here). v1: deposit-to-bank tracking is NOT persisted, so
// physical-count variance is computed client-side only.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

type DayBookLine = {
  id: string;
  at: string;
  kind: "receipt" | "sale" | "refund" | "adjustment";
  type: string;
  mode: string | null;
  amount: number;
  reference: string | null;
  docNo: string | null;
  dealerCode: string | null;
  dealerName: string | null;
  routeId: string | null;
  routeName: string | null;
  byName: string | null;
};

export async function financeDayBookRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/finance/day-book",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = z
        .object({
          date: isoDate.optional(),
          routeId: z
            .union([z.string().uuid(), z.literal("unassigned")])
            .optional(),
        })
        .parse(request.query);
      const date = q.date ?? new Date().toISOString().slice(0, 10);
      // Scalar param only — the transaction pooler can't Bind array/json
      // params, and the in-SQL null-check keeps one prepared shape.
      const route = q.routeId ?? null;

      // 1. Receipts — every payments row, classified by what the money was
      //    for. The linked ledger credit (reference_id = payments.id) is
      //    authoritative; Razorpay rows fill in pay-now order payments that
      //    never touch the ledger; invoice_id catches manual receipts.
      const receipts = await pgClient`
        SELECT
          p.id, p.created_at AS at, 'receipt' AS kind,
          CASE
            WHEN dl.reference_type = 'wallet_topup' THEN 'topup'
            WHEN dl.reference_type = 'order'        THEN 'order_payment'
            WHEN rp.kind = 'credit_topup'           THEN 'topup'
            WHEN rp.kind = 'order_payment'          THEN 'order_payment'
            WHEN p.invoice_id IS NOT NULL           THEN 'invoice_payment'
            ELSE 'on_account'
          END AS type,
          p.mode, p.amount::float8 AS amount,
          p.reference, i.invoice_number AS "docNo",
          d.code AS "dealerCode", d.name AS "dealerName",
          r.id::text AS "routeId", r.name AS "routeName",
          u.name AS "byName"
        FROM payments p
        JOIN dealers d ON d.id = p.dealer_id
        LEFT JOIN invoices i ON i.id = p.invoice_id
        LEFT JOIN users u ON u.id = p.received_by
        LEFT JOIN routes r ON r.id = d.route_id
        LEFT JOIN LATERAL (
          SELECT l.reference_type::text AS reference_type
            FROM dealer_ledger l
           WHERE l.reference_id = p.id AND l.type = 'credit'
           ORDER BY l.created_at
           LIMIT 1
        ) dl ON true
        LEFT JOIN LATERAL (
          SELECT x.kind::text AS kind
            FROM razorpay_payments x
           WHERE p.reference IS NOT NULL
             AND x.razorpay_payment_id = p.reference
           LIMIT 1
        ) rp ON true
        WHERE p.received_date = ${date}::date
          AND ( ${route}::text IS NULL
                OR (${route}::text = 'unassigned' AND d.route_id IS NULL)
                OR d.route_id::text = ${route}::text )
        ORDER BY p.created_at ASC
      `;

      // 1b. Wallet credits WITHOUT a payments row (e.g. the admin
      //     /wallet/topup path writes only a ledger credit). Money that
      //     entered a wallet with no receipt behind it — finance must see
      //     these, but they are kept OUT of the receipts totals.
      const ledgerTopups = await pgClient`
        SELECT
          dl.id, dl.created_at AS at, 'receipt' AS kind,
          'topup_ledger' AS type,
          NULL AS mode, dl.amount::float8 AS amount,
          dl.description AS reference, dl.voucher_no AS "docNo",
          d.code AS "dealerCode", d.name AS "dealerName",
          r.id::text AS "routeId", r.name AS "routeName",
          u.name AS "byName"
        FROM dealer_ledger dl
        JOIN dealers d ON d.id = dl.dealer_id
        LEFT JOIN routes r ON r.id = d.route_id
        LEFT JOIN users u ON u.id = dl.performed_by
        WHERE dl.type = 'credit'
          AND dl.reference_type = 'wallet_topup'
          AND COALESCE(dl.voucher_date,
                       (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date)
              = ${date}::date
          AND (dl.reference_id IS NULL
               OR NOT EXISTS (SELECT 1 FROM payments p WHERE p.id = dl.reference_id))
          AND ( ${route}::text IS NULL
                OR (${route}::text = 'unassigned' AND d.route_id IS NULL)
                OR d.route_id::text = ${route}::text )
        ORDER BY dl.created_at ASC
      `;

      // 2. Sales — dealer orders placed (IST day) that are live. The coarse
      //    created_at bounds let the planner prune monthly partitions; the
      //    AT TIME ZONE expression is the exact filter.
      const orderSales = await pgClient`
        SELECT
          o.id, o.created_at AS at, 'sale' AS kind, 'order_sale' AS type,
          o.payment_mode::text AS mode, o.grand_total::float8 AS amount,
          ('#' || left(o.id::text, 8)) AS reference,
          inv.invoice_number AS "docNo",
          d.code AS "dealerCode", d.name AS "dealerName",
          r.id::text AS "routeId", r.name AS "routeName",
          u.name AS "byName"
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        LEFT JOIN routes r ON r.id = d.route_id
        LEFT JOIN users u ON u.id = o.placed_by
        LEFT JOIN LATERAL (
          SELECT i.invoice_number FROM invoices i
           WHERE i.order_id = o.id LIMIT 1
        ) inv ON true
        WHERE o.created_at >= ${date}::date - interval '1 day'
          AND o.created_at <  ${date}::date + interval '2 days'
          AND (o.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${date}::date
          AND o.status IN ('confirmed', 'dispatched', 'delivered')
          AND ( ${route}::text IS NULL
                OR (${route}::text = 'unassigned' AND d.route_id IS NULL)
                OR d.route_id::text = ${route}::text )
        ORDER BY o.created_at ASC
      `;

      // 2b. Counter / direct sales (gate pass, cash customers, VIP,
      //     employee subsidy). Their cash never enters `payments`, so they
      //     count toward sales but not receipts.
      const counterSales = await pgClient`
        SELECT
          ds.id, ds.created_at AS at, 'sale' AS kind, 'counter_sale' AS type,
          ds.payment_mode::text AS mode, ds.grand_total::float8 AS amount,
          ds.payment_ref AS reference, NULL AS "docNo",
          dd.code AS "dealerCode",
          COALESCE(dd.name, cc.name,
                   initcap(replace(ds.customer_type::text, '_', ' ')))
            AS "dealerName",
          r.id::text AS "routeId", r.name AS "routeName",
          u.name AS "byName"
        FROM direct_sales ds
        LEFT JOIN dealers dd
               ON ds.customer_type = 'agent' AND dd.id = ds.customer_id
        LEFT JOIN cash_customers cc
               ON ds.customer_type <> 'agent' AND cc.id = ds.customer_id
        LEFT JOIN routes r ON r.id = ds.route_id
        LEFT JOIN users u ON u.id = ds.officer_id
        WHERE ds.sale_date = ${date}::date
          AND ( ${route}::text IS NULL
                OR (${route}::text = 'unassigned' AND ds.route_id IS NULL)
                OR ds.route_id::text = ${route}::text )
        ORDER BY ds.created_at ASC
      `;

      // 3. Refunds out (processed that day).
      const refunds = await pgClient`
        SELECT
          rf.id, COALESCE(rf.processed_at, rf.created_at) AS at,
          'refund' AS kind, 'refund' AS type,
          'upi' AS mode, rf.amount::float8 AS amount,
          COALESCE(rf.razorpay_refund_id, rf.razorpay_payment_id) AS reference,
          NULL AS "docNo",
          d.code AS "dealerCode", d.name AS "dealerName",
          r.id::text AS "routeId", r.name AS "routeName",
          u.name AS "byName"
        FROM razorpay_refunds rf
        JOIN dealers d ON d.id = rf.dealer_id
        LEFT JOIN routes r ON r.id = d.route_id
        LEFT JOIN users u ON u.id = rf.initiated_by
        WHERE rf.status = 'processed'
          AND rf.processed_at::date = ${date}::date
          AND ( ${route}::text IS NULL
                OR (${route}::text = 'unassigned' AND d.route_id IS NULL)
                OR d.route_id::text = ${route}::text )
        ORDER BY rf.processed_at ASC
      `;

      // 4. Manual ledger adjustments posted that day (journal, credit/debit
      //    notes). Receipt-backed ledger credits are excluded by sourcing
      //    from ledger_adjustments, which only holds true adjustments.
      const adjustments = await pgClient`
        SELECT
          dl.id, dl.created_at AS at, 'adjustment' AS kind,
          CASE dl.type::text WHEN 'credit' THEN 'adjustment_credit'
                             ELSE 'adjustment_debit' END AS type,
          a.voucher_type AS mode, dl.amount::float8 AS amount,
          a.reason_text AS reference, dl.voucher_no AS "docNo",
          d.code AS "dealerCode", d.name AS "dealerName",
          r.id::text AS "routeId", r.name AS "routeName",
          u.name AS "byName"
        FROM ledger_adjustments a
        JOIN dealer_ledger dl ON dl.id = a.ledger_entry_id
        JOIN dealers d ON d.id = dl.dealer_id
        LEFT JOIN routes r ON r.id = d.route_id
        LEFT JOIN users u ON u.id = a.initiated_by
        WHERE dl.voucher_date = ${date}::date
          AND ( ${route}::text IS NULL
                OR (${route}::text = 'unassigned' AND d.route_id IS NULL)
                OR d.route_id::text = ${route}::text )
        ORDER BY dl.created_at ASC
      `;

      // ── Merge + summarize ──
      const lines = [
        ...(receipts as unknown as DayBookLine[]),
        ...(ledgerTopups as unknown as DayBookLine[]),
        ...(orderSales as unknown as DayBookLine[]),
        ...(counterSales as unknown as DayBookLine[]),
        ...(refunds as unknown as DayBookLine[]),
        ...(adjustments as unknown as DayBookLine[]),
      ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

      const byMode: Record<string, number> = {};
      const byType: Record<string, number> = {};
      let totalReceipts = 0;
      for (const l of receipts as unknown as DayBookLine[]) {
        totalReceipts += l.amount;
        if (l.mode) byMode[l.mode] = (byMode[l.mode] ?? 0) + l.amount;
        byType[l.type] = (byType[l.type] ?? 0) + l.amount;
      }
      const cashCollected = byMode["cash"] ?? 0;

      const ledgerTopupTotal = (ledgerTopups as unknown as DayBookLine[])
        .reduce((s, l) => s + l.amount, 0);

      const salesByMode: Record<string, number> = {};
      let ordersTotal = 0;
      for (const l of orderSales as unknown as DayBookLine[]) {
        ordersTotal += l.amount;
        if (l.mode) salesByMode[l.mode] = (salesByMode[l.mode] ?? 0) + l.amount;
      }
      const counterTotal = (counterSales as unknown as DayBookLine[])
        .reduce((s, l) => s + l.amount, 0);

      const refundsTotal = (refunds as unknown as DayBookLine[])
        .reduce((s, l) => s + l.amount, 0);

      let adjCredit = 0, adjDebit = 0;
      for (const l of adjustments as unknown as DayBookLine[]) {
        if (l.type === "adjustment_credit") adjCredit += l.amount;
        else adjDebit += l.amount;
      }

      // Route-wise breakdown (receipts + sales), built from the same lines
      // so the table always ties out with the list below it.
      const routeMap = new Map<string, {
        id: string | null; name: string | null;
        receipts: number; collected: number; cash: number;
        orders: number; sales: number;
      }>();
      const routeBucket = (l: DayBookLine) => {
        const key = l.routeId ?? "unassigned";
        let r = routeMap.get(key);
        if (!r) {
          r = { id: l.routeId, name: l.routeName, receipts: 0, collected: 0,
                cash: 0, orders: 0, sales: 0 };
          routeMap.set(key, r);
        }
        return r;
      };
      for (const l of receipts as unknown as DayBookLine[]) {
        const r = routeBucket(l);
        r.receipts += 1;
        r.collected += l.amount;
        if (l.mode === "cash") r.cash += l.amount;
      }
      for (const l of [...orderSales, ...counterSales] as unknown as DayBookLine[]) {
        const r = routeBucket(l);
        r.orders += 1;
        r.sales += l.amount;
      }
      const routeWise = [...routeMap.values()]
        .sort((a, b) => (b.collected + b.sales) - (a.collected + a.sales));

      return reply.send({
        date,
        routeId: route,
        lines,
        routeWise,
        summary: {
          totalReceipts,
          byMode,
          byType,
          cashCollected,
          refundsOut: refundsTotal,
          refundsCount: (refunds as unknown as DayBookLine[]).length,
          net: totalReceipts - refundsTotal,
          sales: {
            total: ordersTotal + counterTotal,
            ordersTotal,
            ordersCount: (orderSales as unknown as DayBookLine[]).length,
            counterTotal,
            counterCount: (counterSales as unknown as DayBookLine[]).length,
            byMode: salesByMode,
          },
          ledgerTopups: {
            count: (ledgerTopups as unknown as DayBookLine[]).length,
            total: ledgerTopupTotal,
          },
          adjustments: {
            count: (adjustments as unknown as DayBookLine[]).length,
            creditTotal: adjCredit,
            debitTotal: adjDebit,
          },
        },
      });
    }
  );
}
