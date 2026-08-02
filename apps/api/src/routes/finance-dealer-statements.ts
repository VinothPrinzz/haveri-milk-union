// apps/api/src/routes/finance-dealer-statements.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Dealer Statements
//
//   GET /api/v1/finance/dealer-statements           — dealer index
//   GET /api/v1/finance/dealer-statements/:id        — period statement (JSON)
//   GET /api/v1/finance/dealer-statements/:id/print  — printable HTML
//
// Statement of account for any date range: opening balance, day-by-day
// activity, every voucher, closing balance. All endpoints require
// finance.view.
//
// ── WHY THIS IS NOT A `dealer_ledger` REPORT ──────────────────────────
// It used to be, and that made it near-empty. `dealer_ledger` only ever
// receives a row when an order is settled against the LEDGER (credit
// indents, call-desk credit orders) or when a wallet top-up / manual
// adjustment is posted. The dominant flow at Haveri is pay-per-order UPI:
// the dealer is charged at checkout, a `payments` row is written, and
// NOTHING lands in `dealer_ledger`. Measured over the last 120 days:
//
//     payments with a ledger row      76  ≈ ₹6.06 L
//     payments with NO ledger row  3,061  ≈ ₹94.32 L      ← 94% of receipts
//     ledger order debits            170  ≈ ₹6.54 L
//     actual order sales                 ≈ ₹9 L / day
//
// So the statement is assembled from the SOURCE-OF-TRUTH tables instead,
// exactly like the Day Book:
//
//   DEBIT   invoice     `orders` (confirmed/dispatched/delivered), booked
//                       on delivery_date — the goods the dealer was billed
//   CREDIT  payment     `payments` — money received, any mode
//   CREDIT  topup       `payments` whose gateway kind / ledger ref says the
//                       money went into the wallet rather than at an order
//   DEBIT   refund      `razorpay_refunds` — money paid back to their bank
//   BOTH    adjustment  `dealer_ledger` rows that are GENUINE adjustments:
//                       cheque bounce / return charges / cancellation
//                       (voucher_no CB-/CC-/CX-) and manual credit / debit
//                       notes (they carry a `ledger_adjustments` row)
//
// ── WHAT IS DELIBERATELY EXCLUDED ─────────────────────────────────────
// Order-change ledger rows (modify up/down, cancel-to-balance, wallet
// cancellation refunds) are NOT statement lines. `orders.grand_total` is
// rewritten in place by a modify and a cancelled order drops out of the
// invoice side entirely, so the order line above is already net of the
// change — posting the ledger movement too would count the same rupees
// twice. Same rule the Day Book applies via `cashImpact`.
//
// ── SIGN CONVENTION ───────────────────────────────────────────────────
// balance = opening + credits − debits.  Positive = Cr = the dealer is in
// funds (wallet / advance). Negative = Dr = the dealer owes the union.
//
// A soft-deleted or inactive dealer keeps their statement: nothing here
// filters on deleted_at. A statement is a financial record.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

// A real calendar date, not just the right shape. `from` is compared in JS
// rather than handed to Postgres, so a syntactically-valid-but-impossible
// value like 2026-13-99 would otherwise sail through and silently produce a
// nonsense period instead of an error.
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(s + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a valid calendar date");

const periodSchema = z
  .object({ from: isoDate.optional(), to: isoDate.optional() })
  .refine((q) => !q.from || !q.to || q.from <= q.to, {
    message: "'from' must not be after 'to'",
    path: ["from"],
  });

/** IST calendar day — the union books everything on Asia/Kolkata dates. */
function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}
function defaultFrom(): string {
  return istToday().slice(0, 8) + "01";
}

function esc(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
function inr(n: number): string {
  return "₹" + n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
/** Blank instead of ₹0.00 — a statement column should only show movement. */
function inrOrBlank(n: number): string {
  return n ? inr(n) : "";
}
function drcrLabel(n: number): string {
  return `${inr(Math.abs(n))} ${n < 0 ? "Dr" : "Cr"}`;
}
/** postgres.js hands `date` columns back as JS Date — keep them ISO strings. */
function dayStr(v: unknown): string {
  return v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10);
}

export type StatementKind = "invoice" | "payment" | "topup" | "refund" | "adjustment";

type RawTxn = {
  id: string;
  voucherDate: string;
  at: string;
  kind: StatementKind;
  voucherType: string | null;
  voucherNo: string | null;
  particulars: string | null;
  type: "debit" | "credit";
  amount: number;
  mode: string | null;
  orderId: string | null;
};

export type StatementTxn = RawTxn & { balanceAfter: number };

export type StatementDay = {
  date: string;
  opening: number;
  invoiceDr: number;
  paymentCr: number;
  topupCr: number;
  refundDr: number;
  adjustmentDr: number;
  adjustmentCr: number;
  totalDr: number;
  totalCr: number;
  closing: number;
  count: number;
};

/**
 * Every statement transaction for a dealer from the beginning of their
 * history up to and including `to`. Ordered oldest-first so the caller can
 * fold a running balance over it in one pass and slice out the period.
 *
 * There is no lower bound on purpose: the opening balance IS the fold over
 * everything before `from`, and re-deriving it needs the same union. A
 * dealer's whole history is a few hundred rows (4.5k orders across 389
 * dealers today), so one scan is cheaper than two queries.
 */
async function loadTxns(dealerId: string, to: string): Promise<RawTxn[]> {
  const rows = await pgClient`
    -- 1. INVOICES (debit) — what the dealer was billed. Booked on the
    --    DELIVERY date, matching the Day Book: a standing indent
    --    materializes at 04:00 for tomorrow's delivery, so created-day
    --    booking lands the milk on the wrong day.
    SELECT
      'o:' || o.id::text                    AS id,
      COALESCE(o.delivery_date,
               (o.created_at AT TIME ZONE 'Asia/Kolkata')::date)
                                            AS "voucherDate",
      o.created_at                          AS at,
      'invoice'                             AS kind,
      'Invoice'                             AS "voucherType",
      COALESCE(inv.invoice_number, '#' || left(o.id::text, 8))
                                            AS "voucherNo",
      CASE
        WHEN inv.invoice_number IS NOT NULL
          THEN 'Invoice ' || inv.invoice_number
        ELSE 'Order #' || left(o.id::text, 8)
      END || ' — ' || COALESCE(itm.n, 0)::text
        || CASE WHEN COALESCE(itm.n, 0) = 1 THEN ' item' ELSE ' items' END
                                            AS particulars,
      'debit'                               AS type,
      o.grand_total::float8                 AS amount,
      o.payment_mode::text                  AS mode,
      o.id::text                            AS "orderId"
    FROM orders o
    LEFT JOIN LATERAL (
      SELECT i.invoice_number FROM invoices i WHERE i.order_id = o.id LIMIT 1
    ) inv ON true
    LEFT JOIN LATERAL (
      SELECT count(*)::int AS n FROM order_items oi WHERE oi.order_id = o.id
    ) itm ON true
    WHERE o.dealer_id = ${dealerId}::uuid
      -- Coarse bound so the planner can drop future monthly partitions;
      -- the delivery-date filter below is the real one.
      AND o.created_at < ${to}::date + interval '2 days'
      AND COALESCE(o.delivery_date,
                   (o.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= ${to}::date
      AND o.status IN ('confirmed', 'dispatched', 'delivered')

    UNION ALL

    -- 2. RECEIPTS (credit) — every rupee received, whichever way it came
    --    in. Split topup vs payment the same way the Day Book does: the
    --    linked ledger credit is authoritative, the gateway kind covers
    --    pay-now charges that never touch the ledger.
    SELECT
      'p:' || p.id::text,
      p.received_date,
      p.created_at,
      CASE
        WHEN dl.reference_type = 'wallet_topup' THEN 'topup'
        WHEN dl.reference_type = 'order'        THEN 'payment'
        WHEN rp.kind = 'credit_topup'           THEN 'topup'
        ELSE 'payment'
      END,
      'Receipt',
      COALESCE(NULLIF(dl.voucher_no, ''), 'RC-' || upper(right(p.id::text, 8))),
      CASE
        WHEN dl.reference_type = 'wallet_topup' OR rp.kind = 'credit_topup'
          THEN 'Wallet top-up'
        WHEN rp.kind = 'order_payment' THEN 'Payment at checkout'
        WHEN i.invoice_number IS NOT NULL
          THEN 'Receipt against invoice ' || i.invoice_number
        ELSE 'Receipt on account'
      END
      || ' (' || upper(p.mode) || ')'
      || COALESCE(' — ' || NULLIF(p.reference, ''), ''),
      'credit',
      p.amount::float8,
      p.mode,
      rp.order_id::text
    FROM payments p
    LEFT JOIN invoices i ON i.id = p.invoice_id
    LEFT JOIN LATERAL (
      SELECT l.reference_type::text AS reference_type, l.voucher_no
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
    WHERE p.dealer_id = ${dealerId}::uuid
      AND p.received_date <= ${to}::date

    UNION ALL

    -- 3. REFUNDS OUT (debit) — the gateway paid money back to the dealer's
    --    bank, so the union holds less of their money.
    SELECT
      'r:' || rf.id::text,
      COALESCE(rf.processed_at, rf.created_at)::date,
      COALESCE(rf.processed_at, rf.created_at),
      'refund',
      'Refund',
      'RF-' || upper(right(rf.razorpay_refund_id, 8)),
      'Refund to bank'
        || COALESCE(' — ' || NULLIF(rf.reason, ''), '')
        || ' (' || rf.razorpay_refund_id || ')',
      'debit',
      rf.amount::float8,
      'upi',
      NULL
    FROM razorpay_refunds rf
    WHERE rf.dealer_id = ${dealerId}::uuid
      AND rf.status = 'processed'
      AND COALESCE(rf.processed_at, rf.created_at)::date <= ${to}::date

    UNION ALL

    -- 4. ADJUSTMENTS — ledger rows that are NOT already represented by an
    --    order or a receipt. Two families only:
    --      • cheque lifecycle: bounce (CB-), return charges (CC-),
    --        cancellation (CX-) — each reverses or surcharges a receipt
    --        that section 2 already credited
    --      • manual credit / debit notes and write-offs, identified by
    --        their ledger_adjustments row
    --    Order modify / cancel movements are excluded — see header.
    SELECT
      'l:' || dl.id::text,
      COALESCE(dl.voucher_date,
               (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date),
      dl.created_at,
      'adjustment',
      COALESCE(dl.voucher_type, 'Adjustment'),
      dl.voucher_no,
      COALESCE(NULLIF(dl.particulars, ''), dl.description, 'Adjustment'),
      dl.type::text,
      dl.amount::float8,
      COALESCE(adj.voucher_type, 'adjustment'),
      NULL
    FROM dealer_ledger dl
    LEFT JOIN LATERAL (
      SELECT a.voucher_type FROM ledger_adjustments a
       WHERE a.ledger_entry_id = dl.id LIMIT 1
    ) adj ON true
    WHERE dl.dealer_id = ${dealerId}::uuid
      AND COALESCE(dl.voucher_type, '') <> 'Opening'
      AND COALESCE(dl.voucher_date,
                   (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date) <= ${to}::date
      AND ( dl.voucher_no LIKE 'CB-%'
         OR dl.voucher_no LIKE 'CC-%'
         OR dl.voucher_no LIKE 'CX-%'
         OR adj.voucher_type IS NOT NULL )

    ORDER BY "voucherDate" ASC, at ASC, id ASC
  `;

  return (rows as unknown as RawTxn[]).map((r) => ({
    ...r,
    voucherDate: dayStr(r.voucherDate),
  }));
}

/** Fold the running balance and roll the period up day by day. */
function buildStatement(
  txns: RawTxn[],
  openingBalance: number,
  from: string,
  to: string
) {
  let balance = openingBalance;
  let opening = openingBalance;
  const rows: StatementTxn[] = [];

  for (const t of txns) {
    balance += t.type === "credit" ? t.amount : -t.amount;
    // Everything before the period only moves the opening balance.
    if (t.voucherDate < from) { opening = balance; continue; }
    if (t.voucherDate > to) break;
    rows.push({ ...t, balanceAfter: balance });
  }

  const byDay = new Map<string, StatementDay>();
  let running = opening;
  for (const r of rows) {
    let day = byDay.get(r.voucherDate);
    if (!day) {
      day = {
        date: r.voucherDate, opening: running,
        invoiceDr: 0, paymentCr: 0, topupCr: 0, refundDr: 0,
        adjustmentDr: 0, adjustmentCr: 0,
        totalDr: 0, totalCr: 0, closing: running, count: 0,
      };
      byDay.set(r.voucherDate, day);
    }
    switch (r.kind) {
      case "invoice": day.invoiceDr += r.amount; break;
      case "payment": day.paymentCr += r.amount; break;
      case "topup":   day.topupCr   += r.amount; break;
      case "refund":  day.refundDr  += r.amount; break;
      case "adjustment":
        if (r.type === "credit") day.adjustmentCr += r.amount;
        else day.adjustmentDr += r.amount;
        break;
    }
    if (r.type === "credit") day.totalCr += r.amount;
    else day.totalDr += r.amount;
    day.count += 1;
    day.closing = r.balanceAfter;
    running = r.balanceAfter;
  }
  const daily = [...byDay.values()];

  const totals = {
    invoices: 0, payments: 0, topups: 0, refunds: 0,
    adjustmentsDr: 0, adjustmentsCr: 0,
    debits: 0, credits: 0,
    closingBalance: rows.length ? rows[rows.length - 1]!.balanceAfter : opening,
  };
  for (const r of rows) {
    switch (r.kind) {
      case "invoice": totals.invoices += r.amount; break;
      case "payment": totals.payments += r.amount; break;
      case "topup":   totals.topups   += r.amount; break;
      case "refund":  totals.refunds  += r.amount; break;
      case "adjustment":
        if (r.type === "credit") totals.adjustmentsCr += r.amount;
        else totals.adjustmentsDr += r.amount;
        break;
    }
    if (r.type === "credit") totals.credits += r.amount;
    else totals.debits += r.amount;
  }

  return { openingBalance: opening, rows, daily, totals };
}

/** Exported so diagnostics can exercise the statement without a session. */
export async function loadStatement(dealerId: string, from: string, to: string) {
  // Independent queries — issue both at once. Each is a sub-10ms index scan
  // in Mumbai, so the wall time here is almost entirely round trips.
  const [header, txns] = await Promise.all([
    pgClient`
    SELECT d.id, d.code, d.name, d.pay_mode::text AS "payMode",
           d.customer_type::text AS "customerType",
           d.gst_number AS "gstNumber", d.address, d.city, d.state,
           d.phone, d.credit_limit::float8 AS "creditLimit",
           COALESCE(d.opening_balance, 0)::float8 AS "openingBalanceSeed",
           r.name AS "routeName",
           COALESCE(w.balance, 0)::float8 AS "walletBalance",
           w.last_topup_at  AS "lastTopupAt",
           w.last_topup_amount::float8 AS "lastTopupAmount"
      FROM dealers d
      LEFT JOIN routes r ON r.id = d.route_id
      LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
     -- Deliberately not filtered on deleted_at: a statement is a financial
     -- record and must stay printable after the dealer is deactivated.
     WHERE d.id = ${dealerId}::uuid
     LIMIT 1
  `,
    loadTxns(dealerId, to),
  ]);

  const [dealer] = header;
  if (!dealer) return null;

  const built = buildStatement(
    txns,
    (dealer as any).openingBalanceSeed ?? 0,
    from,
    to
  );

  return {
    dealer,
    period: { from, to },
    wallet: {
      balance: (dealer as any).walletBalance ?? 0,
      lastTopupAt: (dealer as any).lastTopupAt ?? null,
      lastTopupAmount: (dealer as any).lastTopupAmount ?? null,
    },
    ...built,
  };
}

export async function financeDealerStatementsRoutes(app: FastifyInstance) {
  // ── GET /api/v1/finance/dealer-statements (index) ──
  // Closing balance uses the SAME model as the statement itself, per
  // dealer via LATERAL so only the requested page is aggregated (~220ms
  // for 50 dealers). Reading it off dealer_ledger — as this used to —
  // reported ₹0 for the 94% of dealers who only ever pay per order.
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

      // Page + count are independent — one round trip, not two.
      const [rows, [countRow]] = await Promise.all([
        pgClient`
        SELECT
          d.id, d.code, d.name,
          d.pay_mode::text AS "payMode",
          r.name AS "routeName",
          COALESCE(w.balance, 0)::float8 AS "walletBalance",
          (
            COALESCE(d.opening_balance, 0)
            + COALESCE(pay.amt, 0)
            - COALESCE(ord.amt, 0)
            - COALESCE(ref.amt, 0)
            + COALESCE(adj.amt, 0)
          )::float8 AS "closingBalance",
          COALESCE(ord.amt, 0)::float8 AS "billedTotal",
          COALESCE(pay.amt, 0)::float8 AS "receivedTotal",
          pay.last_at AS "lastPaymentAt"
        FROM dealers d
        LEFT JOIN routes r ON r.id = d.route_id
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        LEFT JOIN LATERAL (
          SELECT SUM(o.grand_total) AS amt
            FROM orders o
           WHERE o.dealer_id = d.id
             AND o.status IN ('confirmed', 'dispatched', 'delivered')
        ) ord ON true
        LEFT JOIN LATERAL (
          SELECT SUM(p.amount) AS amt, MAX(p.received_date) AS last_at
            FROM payments p WHERE p.dealer_id = d.id
        ) pay ON true
        LEFT JOIN LATERAL (
          SELECT SUM(rf.amount) AS amt
            FROM razorpay_refunds rf
           WHERE rf.dealer_id = d.id AND rf.status = 'processed'
        ) ref ON true
        LEFT JOIN LATERAL (
          SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                          ELSE -dl.amount END) AS amt
            FROM dealer_ledger dl
            LEFT JOIN ledger_adjustments a ON a.ledger_entry_id = dl.id
           WHERE dl.dealer_id = d.id
             AND COALESCE(dl.voucher_type, '') <> 'Opening'
             AND ( dl.voucher_no LIKE 'CB-%'
                OR dl.voucher_no LIKE 'CC-%'
                OR dl.voucher_no LIKE 'CX-%'
                OR a.id IS NOT NULL )
        ) adj ON true
        -- A soft-deleted dealer stays listed while they still have history,
        -- so their statement remains reachable.
        WHERE (d.deleted_at IS NULL
               OR EXISTS (SELECT 1 FROM dealer_ledger dl2 WHERE dl2.dealer_id = d.id)
               OR EXISTS (SELECT 1 FROM payments p2 WHERE p2.dealer_id = d.id))
          AND (${routeId}::uuid IS NULL OR d.route_id = ${routeId}::uuid)
          AND (${search}::text  IS NULL OR d.name ILIKE ${search}::text OR d.code ILIKE ${search}::text)
        ORDER BY d.name ASC
        LIMIT ${q.limit} OFFSET ${offset}
      `,
        pgClient`
        SELECT count(*)::int AS count FROM dealers d
        WHERE (d.deleted_at IS NULL
               OR EXISTS (SELECT 1 FROM dealer_ledger dl2 WHERE dl2.dealer_id = d.id)
               OR EXISTS (SELECT 1 FROM payments p2 WHERE p2.dealer_id = d.id))
          AND (${routeId}::uuid IS NULL OR d.route_id = ${routeId}::uuid)
          AND (${search}::text  IS NULL OR d.name ILIKE ${search}::text OR d.code ILIKE ${search}::text)
      `,
      ]);

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
      const q = periodSchema.parse(request.query);
      const from = q.from ?? defaultFrom();
      const to   = q.to ?? istToday();

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
      // 'daily' prints the day-wise summary, 'detail' every voucher,
      // 'both' (default) prints the summary followed by the vouchers.
      const q = periodSchema
        .and(z.object({ view: z.enum(["daily", "detail", "both"]).optional() }))
        .parse(request.query);
      const from = q.from ?? defaultFrom();
      const to   = q.to ?? istToday();
      const view = q.view ?? "both";

      const stmt = await loadStatement(id, from, to);
      if (!stmt) return reply.status(404).send({ error: "Dealer not found" });

      const d: any = stmt.dealer;
      const t = stmt.totals;

      const dailyRows = stmt.daily.map((r) => `
        <tr>
          <td>${esc(r.date)}</td>
          <td class="num">${drcrLabel(r.opening)}</td>
          <td class="num">${inrOrBlank(r.invoiceDr)}</td>
          <td class="num">${inrOrBlank(r.paymentCr)}</td>
          <td class="num">${inrOrBlank(r.topupCr)}</td>
          <td class="num">${inrOrBlank(r.adjustmentDr)}</td>
          <td class="num">${inrOrBlank(r.adjustmentCr)}</td>
          <td class="num">${inrOrBlank(r.refundDr)}</td>
          <td class="num"><b>${drcrLabel(r.closing)}</b></td>
        </tr>`).join("");

      const detailRows = stmt.rows.map((r) => `
        <tr>
          <td>${esc(r.voucherDate)}</td>
          <td class="mono">${esc(r.voucherNo ?? "")}</td>
          <td>${esc(r.voucherType ?? "")}</td>
          <td>${esc(r.particulars ?? "")}</td>
          <td class="num">${r.type === "debit" ? inr(r.amount) : ""}</td>
          <td class="num">${r.type === "credit" ? inr(r.amount) : ""}</td>
          <td class="num">${drcrLabel(r.balanceAfter)}</td>
        </tr>`).join("");

      const dailyBlock = `
        <h2>Daily activity</h2>
        <table>
          <thead><tr>
            <th>Date</th><th class="num">Opening</th>
            <th class="num">Invoice (Dr)</th><th class="num">Payment (Cr)</th>
            <th class="num">Top-up (Cr)</th>
            <th class="num">Adj (Dr)</th><th class="num">Adj (Cr)</th>
            <th class="num">Refund (Dr)</th><th class="num">Closing</th>
          </tr></thead>
          <tbody>${dailyRows || `<tr><td colspan="9" class="empty">No activity in this period</td></tr>`}</tbody>
          <tfoot><tr>
            <td>Total</td><td class="num">${drcrLabel(stmt.openingBalance)}</td>
            <td class="num">${inr(t.invoices)}</td>
            <td class="num">${inr(t.payments)}</td>
            <td class="num">${inr(t.topups)}</td>
            <td class="num">${inr(t.adjustmentsDr)}</td>
            <td class="num">${inr(t.adjustmentsCr)}</td>
            <td class="num">${inr(t.refunds)}</td>
            <td class="num">${drcrLabel(t.closingBalance)}</td>
          </tr></tfoot>
        </table>`;

      const detailBlock = `
        <h2>Transactions</h2>
        <table>
          <thead><tr>
            <th>Date</th><th>Voucher</th><th>Type</th><th>Particulars</th>
            <th class="num">Debit</th><th class="num">Credit</th><th class="num">Balance</th>
          </tr></thead>
          <tbody>
            <tr class="totrow">
              <td></td><td></td><td>Opening</td><td>Opening Balance</td>
              <td class="num"></td><td class="num"></td>
              <td class="num">${drcrLabel(stmt.openingBalance)}</td>
            </tr>
            ${detailRows}
          </tbody>
          <tfoot>
            <tr>
              <td colspan="4">Period totals</td>
              <td class="num">${inr(t.debits)}</td>
              <td class="num">${inr(t.credits)}</td>
              <td class="num"></td>
            </tr>
            <tr>
              <td colspan="6">Closing balance</td>
              <td class="num">${drcrLabel(t.closingBalance)}</td>
            </tr>
          </tfoot>
        </table>`;

      const html = `<!doctype html><html><head><meta charset="utf-8">
        <title>Statement — ${esc(d.name)}</title>
        <style>
          body{font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;margin:24px;}
          h1{font-size:18px;margin:0;} h2{font-size:13px;margin:18px 0 4px;}
          .sub{color:#555;font-size:12px;margin:2px 0 12px;}
          .hdr{border-bottom:2px solid #111;padding-bottom:8px;margin-bottom:8px;}
          .meta{margin:8px 0 12px;} .meta div{margin:2px 0;}
          .cards{display:flex;gap:8px;margin:10px 0;flex-wrap:wrap;}
          .card{border:1px solid #ccc;padding:6px 10px;min-width:120px;}
          .card .k{color:#666;font-size:10px;text-transform:uppercase;letter-spacing:.04em;}
          .card .v{font-size:14px;font-weight:bold;font-variant-numeric:tabular-nums;}
          table{width:100%;border-collapse:collapse;margin-top:4px;}
          th,td{border:1px solid #ccc;padding:5px 7px;text-align:left;}
          th{background:#f3f3f3;} .num{text-align:right;font-variant-numeric:tabular-nums;}
          .mono{font-family:"Courier New",monospace;font-size:11px;}
          .empty{text-align:center;color:#777;padding:14px;}
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
        <div class="cards">
          <div class="card"><div class="k">Opening</div><div class="v">${drcrLabel(stmt.openingBalance)}</div></div>
          <div class="card"><div class="k">Billed (Dr)</div><div class="v">${inr(t.invoices)}</div></div>
          <div class="card"><div class="k">Received (Cr)</div><div class="v">${inr(t.payments + t.topups)}</div></div>
          <div class="card"><div class="k">Closing</div><div class="v">${drcrLabel(t.closingBalance)}</div></div>
          <div class="card"><div class="k">Wallet</div><div class="v">${inr(stmt.wallet.balance)}</div></div>
        </div>
        ${view === "detail" ? "" : dailyBlock}
        ${view === "daily"  ? "" : detailBlock}
        <p class="sub">* Dr = dealer owes the union; Cr = the union holds the dealer's money.
           Invoices are booked on their delivery date; receipts on the day the money arrived.</p>
        <button onclick="window.print()">Print</button>
      </body></html>`;

      reply.header("Content-Type", "text/html; charset=utf-8");
      return reply.send(html);
    }
  );
}
