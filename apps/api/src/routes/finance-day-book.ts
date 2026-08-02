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
// Dates: receipts are booked on the IST day the money arrived; dealer
// ORDER sales are booked on the order's DELIVERY date. Booking them by
// created date double-counted the union subsidy line: the standing
// subsidy order materializes at 04:00 for TOMORROW's delivery, so on any
// day D the book showed D's subsidy (re-homed into the cart order) AND
// D+1's standing order — twice on D, missing on D+1. v1: deposit-to-bank
// tracking is NOT persisted, so physical-count variance is client-side.
//
// Route: every line that traces back to an ORDER is attributed to that
// order's SNAPSHOTTED route (orders.route_id), never the dealer's current
// primary route. A dealer who is re-routed, deactivated or deleted must
// not retroactively move — or lose — money already posted to a route.
// dealers.route_id is only the fallback for lines with no order behind
// them (wallet top-ups, on-account receipts, manual adjustments) and for
// pre-0040 orders that were never stamped.
//
// A soft-deleted / inactive dealer's rows stay in the book: nothing here
// filters on d.deleted_at or d.active. Day Book is a money record.
//
// Cash impact: a dealer's wallet is a LIABILITY, not cash. Real money moves
// only when a payment arrives (receipt, 'in') or a gateway refund is paid
// back to his bank ('out'). Everything after a top-up — the wallet debit at
// checkout, the credit-back when an indent is modified down, a cancellation
// refund — only reshuffles that liability, so it carries 'none'. Those lines
// must never be netted as money out: a modify-down already shrinks the order's
// grand_total, so the sale below is reported net of the change; counting the
// credit-back again would subtract the same rupees twice.
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
  // Did real money enter / leave the union's cash & bank today? 'none' covers
  // both revenue lines (the cash leg is the receipt, booked separately) and
  // internal wallet-liability movements. See the header note.
  cashImpact: "in" | "out" | "none";
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
          'in' AS "cashImpact",
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
        LEFT JOIN LATERAL (
          SELECT l.reference_type::text AS reference_type
            FROM dealer_ledger l
           WHERE l.reference_id = p.id AND l.type = 'credit'
           ORDER BY l.created_at
           LIMIT 1
        ) dl ON true
        LEFT JOIN LATERAL (
          SELECT x.kind::text AS kind, x.order_id
            FROM razorpay_payments x
           WHERE p.reference IS NOT NULL
             AND x.razorpay_payment_id = p.reference
           LIMIT 1
        ) rp ON true
        -- Order behind the receipt, if any: a pay-now gateway charge
        -- (razorpay_payments.order_id) or a receipt settling an invoice
        -- (invoices.order_id). Its snapshotted route wins over the
        -- dealer's current one. Lookup is by orders PK (id, created_at)
        -- so every monthly partition probes its own index.
        LEFT JOIN LATERAL (
          SELECT o.route_id
            FROM orders o
           WHERE o.id = COALESCE(rp.order_id, i.order_id)
           LIMIT 1
        ) ord ON true
        LEFT JOIN routes r ON r.id = COALESCE(ord.route_id, d.route_id)
        WHERE p.received_date = ${date}::date
          AND ( ${route}::text IS NULL
                OR (${route}::text = 'unassigned' AND COALESCE(ord.route_id, d.route_id) IS NULL)
                OR COALESCE(ord.route_id, d.route_id)::text = ${route}::text )
        ORDER BY p.created_at ASC
      `;

      // 1b. Wallet credits WITHOUT a payments row (e.g. the admin
      //     /wallet/topup path writes only a ledger credit). Money that
      //     entered a wallet with no receipt behind it — finance must see
      //     these, but they are kept OUT of the receipts totals.
      const ledgerTopups = await pgClient`
        SELECT
          dl.id, dl.created_at AS at, 'receipt' AS kind,
          -- Wallet credit with no receipt behind it: the liability went up,
          -- but no cash was recorded as arriving.
          'none' AS "cashImpact",
          'topup_ledger' AS type,
          NULL AS mode, dl.amount::float8 AS amount,
          dl.description AS reference, dl.voucher_no AS "docNo",
          d.code AS "dealerCode", d.name AS "dealerName",
          r.id::text AS "routeId", r.name AS "routeName",
          u.name AS "byName"
        FROM dealer_ledger dl
        JOIN dealers d ON d.id = dl.dealer_id
        -- No order behind a top-up — the dealer's own route is the only
        -- attribution there is.
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

      // 2. Sales — live dealer orders booked on their DELIVERY date (the
      //    day the milk actually goes out; see header note on the subsidy
      //    double count). Orders predating the delivery_date column fall
      //    back to their IST creation day. The coarse created_at bounds let
      //    the planner prune monthly partitions — standing-indent orders
      //    are created at most a day ahead, admin indents a few days.
      const orderSales = await pgClient`
        SELECT
          o.id, o.created_at AS at, 'sale' AS kind, 'order_sale' AS type,
          -- Revenue, not a treasury movement: the money arrived as a receipt
          -- (top-up or pay-now charge) and is counted there.
          'none' AS "cashImpact",
          -- Settlement bucket for the day book. Real "credit" is reserved for
          -- credit-institution dealers (customer_type 'Credit Inst-*', billed
          -- monthly). Every other dealer pays with their own money — either
          -- drawn from wallet balance/top-ups ('wallet') or a pay-now UPI
          -- charge ('upi'). The stored payment_mode='credit' that ledger-
          -- settled orders carry is a technical marker, NOT real credit, so it
          -- must not surface as "on credit" for ordinary dealers.
          CASE
            WHEN d.customer_type::text LIKE 'Credit Inst%' THEN 'credit'
            WHEN o.payment_mode::text = 'upi'              THEN 'upi'
            ELSE 'wallet'
          END AS mode,
          o.grand_total::float8 AS amount,
          ('#' || left(o.id::text, 8)) AS reference,
          inv.invoice_number AS "docNo",
          d.code AS "dealerCode", d.name AS "dealerName",
          r.id::text AS "routeId", r.name AS "routeName",
          u.name AS "byName"
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        LEFT JOIN routes r ON r.id = COALESCE(o.route_id, d.route_id)
        LEFT JOIN users u ON u.id = o.placed_by
        LEFT JOIN LATERAL (
          SELECT i.invoice_number FROM invoices i
           WHERE i.order_id = o.id LIMIT 1
        ) inv ON true
        WHERE o.created_at >= ${date}::date - interval '31 days'
          AND o.created_at <  ${date}::date + interval '2 days'
          AND COALESCE(o.delivery_date,
                       (o.created_at AT TIME ZONE 'Asia/Kolkata')::date)
              = ${date}::date
          AND o.status IN ('confirmed', 'dispatched', 'delivered')
          AND ( ${route}::text IS NULL
                OR (${route}::text = 'unassigned' AND COALESCE(o.route_id, d.route_id) IS NULL)
                OR COALESCE(o.route_id, d.route_id)::text = ${route}::text )
        ORDER BY o.created_at ASC
      `;

      // 2b. Counter / direct sales (gate pass, cash customers, VIP,
      //     employee subsidy). Their cash never enters `payments`, so they
      //     count toward sales but not receipts.
      const counterSales = await pgClient`
        SELECT
          ds.id, ds.created_at AS at, 'sale' AS kind, 'counter_sale' AS type,
          -- Revenue line. Counter cash never lands in the payments table, so
          -- it stays out of the cash section here exactly as it always has.
          'none' AS "cashImpact",
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

      // 3. Refunds out (processed that day) — the ONLY refund path that
      //    actually takes money out of the union: the gateway pays it back to
      //    the dealer's bank.
      const refunds = await pgClient`
        SELECT
          rf.id, COALESCE(rf.processed_at, rf.created_at) AS at,
          'refund' AS kind, 'out' AS "cashImpact", 'refund' AS type,
          'upi' AS mode, rf.amount::float8 AS amount,
          COALESCE(rf.razorpay_refund_id, rf.razorpay_payment_id) AS reference,
          NULL AS "docNo",
          d.code AS "dealerCode", d.name AS "dealerName",
          r.id::text AS "routeId", r.name AS "routeName",
          u.name AS "byName"
        FROM razorpay_refunds rf
        JOIN dealers d ON d.id = rf.dealer_id
        LEFT JOIN users u ON u.id = rf.initiated_by
        -- A refund reverses a gateway payment; when that payment was for an
        -- order, the money goes back out of that order's route.
        LEFT JOIN razorpay_payments rp ON rp.id = rf.razorpay_payment_row
        LEFT JOIN LATERAL (
          SELECT o.route_id FROM orders o WHERE o.id = rp.order_id LIMIT 1
        ) ord ON true
        LEFT JOIN routes r ON r.id = COALESCE(ord.route_id, d.route_id)
        WHERE rf.status = 'processed'
          AND rf.processed_at::date = ${date}::date
          AND ( ${route}::text IS NULL
                OR (${route}::text = 'unassigned' AND COALESCE(ord.route_id, d.route_id) IS NULL)
                OR COALESCE(ord.route_id, d.route_id)::text = ${route}::text )
        ORDER BY rf.processed_at ASC
      `;

      // 3b. Order-change balance movements — the ledger rows an indent
      //     modification or cancellation writes straight into dealer_ledger
      //     with no payments / razorpay_refunds / ledger_adjustments row,
      //     so none of the other sections ever saw them:
      //       • modify up   → debit,  reference_type 'adjustment'
      //       • modify down → credit, reference_type 'adjustment'
      //         (also the admin subsidy-revise credit)
      //       • cancel of a wallet order → credit, reference_type 'refund'
      //       • cancel to available balance → credit, reference_type
      //         'order' with voucher 'Adjustment'
      //       • cheque bounce / return charges / cancellation → debit,
      //         reference_type 'adjustment', voucher 'Adjustment' (labelled
      //         from the CB-/CC-/CX- voucher prefix; order changes never set
      //         voucher_no, so the prefixes can't collide)
      //     Razorpay refund reversals are debits on 'refund' → excluded;
      //     manual notes carry a ledger_adjustments row → excluded.
      //
      //     NON-WALLET RECEIPTS ARE EXCLUDED BY voucher_type. A cash/cheque/
      //     on-account receipt also lands on reference_type 'adjustment'
      //     (finance.ts: only wallet-mode receipts get 'wallet_topup'), so
      //     without the guard every one of them was double-counted here as a
      //     'modify_refund' — money IN reported as money OUT, on top of its
      //     correct row in section 1.
      const orderChanges = await pgClient`
        SELECT
          dl.id, dl.created_at AS at,
          CASE WHEN dl.type = 'credit' THEN 'refund' ELSE 'adjustment' END AS kind,
          -- Wallet-liability movements only: the rupees never leave (or enter)
          -- the union's cash & bank, and the order row above already carries
          -- the modified grand_total.
          'none' AS "cashImpact",
          CASE
            WHEN dl.voucher_no LIKE 'CB-%'          THEN 'cheque_bounce'
            WHEN dl.voucher_no LIKE 'CC-%'          THEN 'cheque_charges'
            WHEN dl.voucher_no LIKE 'CX-%'          THEN 'cheque_cancel'
            WHEN dl.type = 'debit'                  THEN 'modify_debit'
            WHEN dl.reference_type = 'adjustment'   THEN 'modify_refund'
            ELSE 'cancel_refund'
          END AS type,
          'balance' AS mode, dl.amount::float8 AS amount,
          dl.description AS reference, dl.voucher_no AS "docNo",
          d.code AS "dealerCode", d.name AS "dealerName",
          r.id::text AS "routeId", r.name AS "routeName",
          u.name AS "byName"
        FROM dealer_ledger dl
        JOIN dealers d ON d.id = dl.dealer_id
        LEFT JOIN users u ON u.id = dl.performed_by
        -- Every row selected below is written by an order modify/cancel with
        -- reference_id = the order id ('order', 'adjustment', and the cancel
        -- 'refund' credit all follow that convention), so the movement is
        -- booked to the order's own route.
        LEFT JOIN LATERAL (
          SELECT o.route_id FROM orders o WHERE o.id = dl.reference_id LIMIT 1
        ) ord ON true
        LEFT JOIN routes r ON r.id = COALESCE(ord.route_id, d.route_id)
        WHERE (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date = ${date}::date
          AND dl.amount > 0
          AND (
                dl.reference_type = 'adjustment'
             OR (dl.type = 'credit' AND dl.reference_type = 'refund')
             OR (dl.type = 'credit' AND dl.reference_type = 'order'
                 AND dl.voucher_type = 'Adjustment')
              )
          AND COALESCE(dl.voucher_type, '') <> 'Receipt'
          AND NOT EXISTS (
                SELECT 1 FROM payments p WHERE p.id = dl.reference_id
              )
          AND NOT EXISTS (
                SELECT 1 FROM ledger_adjustments a
                 WHERE a.ledger_entry_id = dl.id
              )
          AND ( ${route}::text IS NULL
                OR (${route}::text = 'unassigned' AND COALESCE(ord.route_id, d.route_id) IS NULL)
                OR COALESCE(ord.route_id, d.route_id)::text = ${route}::text )
        ORDER BY dl.created_at ASC
      `;

      // 4. Manual ledger adjustments posted that day (journal, credit/debit
      //    notes). Receipt-backed ledger credits are excluded by sourcing
      //    from ledger_adjustments, which only holds true adjustments.
      const adjustments = await pgClient`
        SELECT
          dl.id, dl.created_at AS at, 'adjustment' AS kind,
          -- Journal / credit / debit notes post to the ledger only.
          'none' AS "cashImpact",
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
        -- Manual journal / credit / debit notes are posted against the
        -- dealer, not an order — dealer route is the correct attribution.
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
        ...(orderChanges as unknown as DayBookLine[]),
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

      // Composition card breaks dealer orders down by how each was settled:
      //   • 'credit' → credit-institution orders (billed monthly)
      //   • 'wallet' → paid from wallet balance / top-ups (the dealer's own
      //                money that was already sitting in the wallet)
      //   • online methods ('upi', 'card', …) → paid now at checkout via the
      //     gateway. Each surfaces as its own line and is NOT folded into
      //     wallet. (Today the gateway path only records 'upi'; any other
      //     method appears automatically if it is ever captured.)
      // The buckets sum to the full dealer-orders total.
      const salesByMode: Record<string, number> = {};
      let ordersTotal = 0;
      for (const l of orderSales as unknown as DayBookLine[]) {
        ordersTotal += l.amount;
        const bucket = l.mode ?? "wallet";
        salesByMode[bucket] = (salesByMode[bucket] ?? 0) + l.amount;
      }
      const counterTotal = (counterSales as unknown as DayBookLine[])
        .reduce((s, l) => s + l.amount, 0);

      const refundsTotal = (refunds as unknown as DayBookLine[])
        .reduce((s, l) => s + l.amount, 0);

      // Balance-side money from order changes: refunds credited back to the
      // dealer's available balance (modify down / cancellations) and extra
      // debits taken from it (modify up). NOT cash — see the header note. They
      // are reported on their own so finance can see the wallet liability
      // move without them polluting refundsOut / net.
      let ocRefunds = 0, ocRefundsCount = 0, ocDebits = 0, ocDebitsCount = 0;
      for (const l of orderChanges as unknown as DayBookLine[]) {
        if (l.kind === "refund") { ocRefunds += l.amount; ocRefundsCount += 1; }
        else { ocDebits += l.amount; ocDebitsCount += 1; }
      }

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
          // Bank refunds only. Wallet credit-backs live under orderChanges and
          // are deliberately excluded here and from `net`.
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
          orderChanges: {
            refundsToBalance: ocRefunds,
            refundsCount: ocRefundsCount,
            extraDebits: ocDebits,
            debitsCount: ocDebitsCount,
            // Net rupees the day's order changes pushed back into dealer
            // wallets (negative = pulled out of them). Liability movement.
            netToWallet: ocRefunds - ocDebits,
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
