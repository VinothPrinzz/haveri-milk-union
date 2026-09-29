// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/lib/direct-sale-money.ts
//
// Money model for direct sales (counter sales + agent gate passes), and the
// cancellation that mirrors adminCancelOrder for the direct-sale rail.
//
// ── How a direct sale differs from an indent ─────────────────────────
// An indent posts money the moment it is placed: a wallet debit, a ledger
// debit, or a captured online payment. A DIRECT SALE POSTS NOTHING. Saving
// it writes the sale row and deducts stock, and that is all — there is no
// dealer_ledger row and no `payments` receipt (verified across all 27 sales
// on 2026-08-06: 0 ledger rows, 0 receipts). The sale row IS the revenue,
// booked by every report that reads direct_sales.
//
// The one exception is the counter QR: a scanned gate-pass QR writes a
// razorpay_payments row (kind='gate_pass') and stamps direct_sales.payment_ref.
// That is the ONLY money this rail can trace, and therefore the only money
// it can give back through the system.
//
// So "refund" here means exactly one thing: returning gateway money. For a
// cash pass the operator hands notes back across the counter, and for a
// credit or complimentary pass nothing was ever collected — crediting a
// dealer's balance in either case would invent money the union never took,
// the same phantom-credit trap that wallet order cancels fell into.
// `refund.method: "none"` with a `handBack` figure is the honest answer, and
// the UI states it in words.
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./db.js";
import { RefundError } from "./cancel-order.js";
import { recordBankRefund, type BankRefundIntent } from "./order-refund.js";
import {
  isRazorpayConfigured,
  createRazorpayRefund,
  closeRazorpayQrCode,
} from "./razorpay-client.js";

/** Sale types that can carry a counter QR, and therefore gateway money. */
export const QR_CAPABLE_TYPES = ["agent"] as const;

/** Payment modes where money physically changes hands at the counter. */
const CASH_LIKE = new Set(["cash", "upi"]);

// ── Gate-pass settlement, mirroring the indent rail ────────────────────
//
// A gate pass used to post nothing at all, whatever mode the operator
// picked. That left two holes: a pass taken against the dealer's prepaid
// balance never drew it down (so the same rupees could be spent again on
// an indent), and physical counter cash was recorded nowhere as a receipt.
// Both now post exactly what the equivalent indent posts:
//
//   wallet — the dealer spends prepaid balance. dealer_ledger debit,
//            reference_type 'order', gated on available balance. Money the
//            union already holds, so the invoice reads PAID.
//   credit — goods taken against a bill settled later. The SAME ledger
//            debit, but no balance gate and the debit does NOT count as
//            payment, so the invoice stays a receivable and ages in AR.
//            (invoice-settlement.ts draws the same wallet/credit-institution
//            distinction on the orders rail.)
//   cash   — a `payments` receipt, so the Day Book's cash position sees it.
//   upi    — unchanged: the counter QR writes razorpay_payments and the
//            Day Book reads those rows directly as counter collections.
//
// `complimentary` (VIP samples) posts nothing — there is no money.

/** Modes settled through the dealer's ledger rather than at the counter. */
export const LEDGER_SETTLED_MODES = new Set(["wallet", "credit"]);

/**
 * Is this gate pass a receivable rather than money already held?
 *
 * Only 'credit' is. 'wallet' spends funds the dealer topped up earlier, so
 * the union is already holding that money — the ledger debit is a drawdown,
 * not a bill. This is the direct-sale twin of the rail-2 / rail-3 split in
 * invoice-settlement.ts, and it decides which side of the cash / credit
 * split every sales report puts the pass on.
 */
export function isDirectSaleReceivable(paymentMode: string | null | undefined): boolean {
  return String(paymentMode ?? "") === "credit";
}

/**
 * Debit a dealer's balance for a gate pass, the mirror of
 * creditDealerBalance below and of the debit every credit indent writes
 * (see admin-indents.ts and POST /orders).
 *
 * balance_after is computed inside the caller's transaction so concurrent
 * passes cannot both stamp the same running balance.
 */
export async function debitDealerBalance(
  tx: typeof pgClient,
  dealerId: string,
  amount: number,
  saleId: string,
  description: string,
  performedBy: string | null,
): Promise<void> {
  const [bal] = (await tx`
    SELECT
      COALESCE(d.opening_balance, 0)
      + COALESCE((SELECT SUM(CASE WHEN dl.type='credit'
            AND COALESCE(dl.voucher_type,'') <> 'Opening'
            THEN dl.amount ELSE 0 END)
          FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      - COALESCE((SELECT SUM(CASE WHEN dl.type='debit'
            AND COALESCE(dl.voucher_type,'') <> 'Opening'
            THEN dl.amount ELSE 0 END)
          FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      AS bal
    FROM dealers d WHERE d.id = ${dealerId}::uuid
  `) as any[];
  if (!bal) throw new Error(`Dealer ${dealerId} not found`);
  const balanceAfter = parseFloat(bal.bal) - amount;

  await tx`
    INSERT INTO dealer_ledger
      (dealer_id, type, amount, reference_id, reference_type,
       voucher_type, voucher_date, description, balance_after, performed_by)
    VALUES
      (${dealerId}::uuid, 'debit', ${amount.toFixed(2)}::numeric,
       ${saleId}::uuid, 'order'::ledger_ref_type,
       'Invoice', (now() AT TIME ZONE 'Asia/Kolkata')::date,
       ${description}, ${balanceAfter.toFixed(2)}::numeric, ${performedBy}::uuid)
  `;
}

/**
 * Record counter cash as a real receipt.
 *
 * Until now a cash gate pass wrote nothing: the sale row carried the
 * revenue, but the Day Book — which reads `payments` for its receipts —
 * could not see a rupee of it, and said so in a comment. This covers the
 * cash rail; the QR rail books its own receipt at capture, in
 * applyPaidGatePassPayment. Both are read from `payments` and nowhere
 * else, which is what keeps a counter collection counted exactly once.
 *
 * `reference` carries the gate pass number rather than a gateway id, which
 * is what keeps it clear of resolveOrderSettlement's rail-1 match on
 * payments.reference = a pay_* id.
 */
export async function recordCounterCashReceipt(
  tx: typeof pgClient,
  args: {
    dealerId: string;
    amount: number;
    saleId: string;
    gpNo: string | null;
    saleDate: string;
    performedBy: string | null;
  },
): Promise<void> {
  await tx`
    INSERT INTO payments
      (dealer_id, received_date, amount, mode, reference, invoice_id, received_by, notes)
    VALUES
      (${args.dealerId}::uuid, ${args.saleDate}::date,
       ${args.amount.toFixed(2)}::numeric, 'cash',
       ${args.gpNo ?? `GP:${args.saleId.slice(0, 8)}`},
       (SELECT i.id FROM invoices i WHERE i.order_id = ${args.saleId}::uuid LIMIT 1),
       ${args.performedBy}::uuid,
       ${`Counter cash for gate pass ${args.gpNo ?? args.saleId}`})
  `;
}

export interface DirectSaleMoney {
  grandTotal: number;
  /** Gateway money received for this sale, net of refunds already made. */
  collected: number;
  /** Still to collect: grand_total − collected, never below zero. */
  outstanding: number;
  /** Collected beyond the sale total (an edit shrank an already-paid sale). */
  overpaid: number;
  /** How much of `collected` a bank refund could still draw on. */
  refundable: number;
}

/**
 * What has actually been collected against a sale through the gateway.
 *
 * Counts 'paid' AND 'refunded' rows: a fully-refunded row has
 * amount_refunded = amount, so it contributes zero on its own, but leaving
 * the status out would make a partially-refunded row vanish and overstate
 * what is still outstanding.
 */
export async function loadDirectSaleMoney(
  client: typeof pgClient,
  saleId: string,
): Promise<DirectSaleMoney> {
  const [row] = (await client`
    SELECT ds.grand_total::float8 AS "grandTotal",
           COALESCE((
             SELECT SUM(rp.amount - rp.amount_refunded)::float8
               FROM razorpay_payments rp
              WHERE rp.direct_sale_id = ds.id
                AND rp.kind = 'gate_pass'
                AND rp.status IN ('paid', 'refunded')
           ), 0) AS collected
      FROM direct_sales ds
     WHERE ds.id = ${saleId}::uuid
     LIMIT 1
  `) as any[];
  if (!row) throw new Error(`Direct sale ${saleId} not found`);

  const grandTotal = Number(row.grandTotal ?? 0);
  const collected = Number(row.collected ?? 0);
  return {
    grandTotal,
    collected,
    outstanding: Math.max(0, grandTotal - collected),
    overpaid: Math.max(0, collected - grandTotal),
    refundable: collected,
  };
}

/**
 * Put a direct sale's stock back. The inverse of the deduction every create
 * path does (`products.stock -= qty`).
 *
 * NOTE this rail does not touch FGS: fgs_day() and fgs_available() read
 * `orders` only, never direct_sales, so a gate pass never moved the day-aware
 * stock the app gates on. products.stock is the vestigial counter, kept
 * consistent here because the create path decrements it.
 */
export async function restoreDirectSaleStock(
  tx: typeof pgClient,
  saleId: string,
): Promise<void> {
  const items = (await tx`
    SELECT product_id, quantity FROM direct_sale_items WHERE direct_sale_id = ${saleId}::uuid
  `) as any[];
  for (const it of items) {
    await tx`
      UPDATE products SET stock = stock + ${it.quantity}, updated_at = now()
       WHERE id = ${it.product_id}
    `;
  }
}

/**
 * Close whatever counter QR is still live for a sale, so it cannot be
 * scanned after the sale stops existing in its current form.
 *
 * Razorpay FIRST, then our row — marking the row dead while the QR stayed
 * scannable is the one ordering that could take money with no live row to
 * attribute it to. Returns false when the gateway refused, so the caller can
 * abort rather than proceed under a payable QR.
 */
export async function closeLiveGatePassQr(
  saleId: string,
  reason: string,
): Promise<{ closed: boolean; qrId: string | null; error?: string }> {
  const [live] = (await pgClient`
    SELECT id::text AS id, razorpay_qr_code_id AS "qrId"
      FROM razorpay_payments
     WHERE direct_sale_id = ${saleId}::uuid
       AND kind = 'gate_pass'
       AND status IN ('created', 'attempted')
     ORDER BY created_at DESC
  `) as any[];

  if (!live) return { closed: true, qrId: null };
  if (!isRazorpayConfigured())
    return { closed: false, qrId: live.qrId, error: "Razorpay is not configured on this server." };

  try {
    await closeRazorpayQrCode(live.qrId);
  } catch (err: any) {
    return { closed: false, qrId: live.qrId, error: err?.message ?? "Razorpay refused to close the QR." };
  }

  await pgClient`
    UPDATE razorpay_payments
       SET status = 'failed', error_description = ${reason}, updated_at = now()
     WHERE direct_sale_id = ${saleId}::uuid
       AND kind = 'gate_pass'
       AND status IN ('created', 'attempted')
  `;
  return { closed: true, qrId: live.qrId };
}

export interface GatePassRefundPlan {
  intents: BankRefundIntent[];
  refunded: number;
  /** Asked-for amount the gateway could not cover (rows already refunded). */
  shortfall: number;
}

/**
 * Refund `amount` at Razorpay against a sale's captured QR payments, newest
 * first. MUST run BEFORE the DB transaction, as on the order rail.
 *
 * A sale can carry more than one captured payment once top-up QRs exist (an
 * upward edit on a paid sale mints a QR for the difference), so this may make
 * several gateway refunds. If a later one fails after an earlier one
 * succeeded, the successes are still returned rather than thrown away — the
 * money HAS moved, and the DB must record it or the two sides disagree
 * forever. Only a failure with nothing refunded raises RefundError.
 */
export async function initiateGatePassBankRefunds(
  saleId: string,
  amount: number,
  reason: string,
): Promise<GatePassRefundPlan> {
  if (amount <= 0.001) return { intents: [], refunded: 0, shortfall: 0 };

  if (!isRazorpayConfigured()) {
    throw new RefundError(
      "Razorpay is not configured, so this cannot be refunded to a bank account. Choose 'available balance' instead.",
    );
  }

  const rows = (await pgClient`
    SELECT id, dealer_id::text AS "dealerId",
           amount::float8 AS amount, amount_refunded::float8 AS "amountRefunded",
           razorpay_payment_id AS "rzpPaymentId"
      FROM razorpay_payments
     WHERE direct_sale_id = ${saleId}::uuid
       AND kind = 'gate_pass'
       AND status IN ('paid', 'refunded')
       AND razorpay_payment_id IS NOT NULL
     ORDER BY created_at DESC
  `) as any[];

  const available = rows.reduce(
    (s, r) => s + Math.max(0, Number(r.amount) - Number(r.amountRefunded)),
    0,
  );
  if (available <= 0.001) {
    throw new RefundError(
      "This sale has no refundable online payment, so it can't be refunded to a bank account.",
    );
  }

  const intents: BankRefundIntent[] = [];
  let remaining = Math.min(amount, available);
  let refunded = 0;
  let firstError: string | null = null;

  for (const r of rows) {
    if (remaining <= 0.001) break;
    const rowRemaining = Math.max(0, Number(r.amount) - Number(r.amountRefunded));
    if (rowRemaining <= 0.001) continue;
    const take = Math.min(remaining, rowRemaining);

    try {
      const rzpRefund = await createRazorpayRefund({
        paymentId: r.rzpPaymentId,
        amountInRupees: take,
        notes: { reason, directSaleId: saleId, dealerId: r.dealerId },
      });
      intents.push({
        rpRowId: r.id,
        rzpPaymentId: r.rzpPaymentId,
        dealerId: r.dealerId,
        refundAmt: take,
        rzpRefund,
      });
      refunded += take;
      remaining -= take;
    } catch (err: any) {
      firstError = err?.message ?? "Razorpay rejected the refund.";
      break;
    }
  }

  // Nothing moved at the gateway → abort cleanly, exactly as the order path
  // does, so the caller can 409 without having written anything.
  if (intents.length === 0) {
    throw new RefundError(firstError ?? "Razorpay rejected the refund.");
  }

  return { intents, refunded, shortfall: Math.max(0, amount - refunded) };
}

/**
 * Credit a refund onto an AGENT's available balance as store credit. Only
 * valid for agent sales, whose customer_id is a real dealer; a cash customer
 * has no ledger to credit.
 */
export async function creditDealerBalance(
  tx: typeof pgClient,
  dealerId: string,
  amount: number,
  saleId: string,
  description: string,
  performedBy: string | null,
): Promise<void> {
  const [bal] = (await tx`
    SELECT
      COALESCE(d.opening_balance, 0)
      + COALESCE((SELECT SUM(CASE WHEN dl.type='credit'
            AND COALESCE(dl.voucher_type,'') <> 'Opening'
            THEN dl.amount ELSE 0 END)
          FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      - COALESCE((SELECT SUM(CASE WHEN dl.type='debit'
            AND COALESCE(dl.voucher_type,'') <> 'Opening'
            THEN dl.amount ELSE 0 END)
          FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      AS bal
    FROM dealers d WHERE d.id = ${dealerId}::uuid
  `) as any[];
  const balanceAfter = parseFloat(bal!.bal) + amount;

  await tx`
    INSERT INTO dealer_ledger
      (dealer_id, type, amount, reference_id, reference_type,
       voucher_type, voucher_date, description, balance_after, performed_by)
    VALUES
      (${dealerId}::uuid, 'credit', ${amount.toFixed(2)}::numeric,
       ${saleId}::uuid, 'adjustment'::ledger_ref_type,
       'Adjustment', (now() AT TIME ZONE 'Asia/Kolkata')::date,
       ${description}, ${balanceAfter.toFixed(2)}::numeric, ${performedBy}::uuid)
  `;
}

/**
 * What this sale still has posted against the dealer's ledger: debits
 * placed for it, less anything already credited back. Reversing this rather
 * than the sale total is what keeps a cancel idempotent and stops a
 * re-run inventing money — the phantom-credit trap the wallet order cancel
 * fell into (it credited grand_total unconditionally).
 */
export async function ledgerPostedForSale(
  tx: typeof pgClient,
  saleId: string,
): Promise<number> {
  const [row] = (await tx`
    SELECT COALESCE(SUM(CASE
             WHEN dl.type = 'debit'  THEN  dl.amount
             WHEN dl.type = 'credit' THEN -dl.amount
             ELSE 0 END), 0)::float8 AS net
      FROM dealer_ledger dl
     WHERE dl.reference_id = ${saleId}::uuid
       AND dl.reference_type IN ('order', 'refund')
  `) as any[];
  return Math.max(0, Number(row?.net ?? 0));
}

/**
 * Undo the ledger drawdown a wallet or credit gate pass made. A credit row
 * against the same sale id, so `ledgerPostedForSale` nets to zero and a
 * second cancel reverses nothing.
 */
export async function reverseGatePassLedgerPosting(
  tx: typeof pgClient,
  args: { dealerId: string; saleId: string; gpNo: string | null; performedBy: string | null },
): Promise<number> {
  const posted = await ledgerPostedForSale(tx, args.saleId);
  if (posted <= 0.001) return 0;
  await creditDealerBalance(
    tx,
    args.dealerId,
    posted,
    args.saleId,
    `Cancellation credit for gate pass ${args.gpNo ?? args.saleId}`,
    args.performedBy,
  );
  return posted;
}

/**
 * Remove the counter cash receipt a cancelled sale wrote.
 *
 * Deleted rather than reversed because `payments` has a CHECK (amount > 0)
 * and no reversal concept, and because a cancelled sale is unwound
 * everywhere else as though it never happened (stock restored, gate pass
 * quantities zeroed, revenue excluded). Leaving the receipt behind would
 * show the dealer a credit on their statement whose matching debit had
 * gone, i.e. money they never paid.
 *
 * The notes prefix written at creation is what identifies our row, so a
 * receipt an admin recorded by hand against the same invoice is untouched.
 */
export async function reverseCounterCashReceipt(
  tx: typeof pgClient,
  saleId: string,
): Promise<number> {
  // Matches both note forms: the gate pass number when one was stamped, and
  // the sale id for a pass saved before gp_no was assigned.
  const rows = (await tx`
    DELETE FROM payments p
     WHERE p.mode = 'cash'
       AND p.notes IN (
         SELECT ${"Counter cash for gate pass "} || x
           FROM (
             SELECT ds.gp_no AS x FROM direct_sales ds WHERE ds.id = ${saleId}::uuid
             UNION ALL
             SELECT ${saleId}::text
           ) forms
          WHERE x IS NOT NULL
       )
    RETURNING p.amount::float8 AS amount
  `) as any[];
  return rows.reduce((s, r) => s + Number(r.amount), 0);
}

/** Where a direct-sale refund can go. */
export type DirectSaleRefundMethod = "razorpay" | "balance";

export interface DirectSaleRefundSummary {
  paymentMode: string;
  refund: {
    method: "razorpay" | "credit" | "none";
    amount: number;
    razorpayRefundIds?: string[];
    /** Set when nothing could be returned through the system: cash to hand
     *  back at the counter, or nothing collected at all. */
    handBack?: number;
    note?: string;
  };
  /** Balance given back when a wallet or credit pass was unwound. */
  ledgerReversed?: number;
  /** Counter cash receipt removed when a cash pass was unwound. */
  cashReceiptReversed?: number;
}

export class DirectSaleCancelError extends Error {
  statusCode: number;
  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "DirectSaleCancelError";
    this.statusCode = statusCode;
  }
}

/**
 * Cancel a direct sale: stop it counting as a sale, put its stock back, kill
 * any live counter QR, and return whatever gateway money it took.
 *
 * The sale row is KEPT (status='cancelled') rather than deleted, so the
 * cancellation is auditable and the gate pass number is not reused.
 *
 * `refundMethod` only matters when gateway money was actually collected:
 *   • "razorpay" → bank refund of the collected amount
 *   • "balance"  → store credit on the agent's available balance
 * With nothing collected the sale still cancels and the summary says what
 * the operator must hand back at the counter.
 */
export async function cancelDirectSale(
  saleId: string,
  reason: string,
  performedBy: string | null,
  refundMethod?: DirectSaleRefundMethod,
): Promise<DirectSaleRefundSummary> {
  const [sale] = (await pgClient`
    SELECT ds.id::text AS id, ds.status::text AS status,
           ds.customer_type::text AS "customerType",
           ds.customer_id::text AS "customerId",
           ds.payment_mode::text AS "paymentMode",
           ds.grand_total::float8 AS "grandTotal",
           ds.gp_no AS "gpNo"
      FROM direct_sales ds
     WHERE ds.id = ${saleId}::uuid
     LIMIT 1
  `) as any[];
  if (!sale) throw new DirectSaleCancelError("Sale not found", 404);
  if (sale.status === "cancelled")
    throw new DirectSaleCancelError("This sale is already cancelled", 400);

  // ── Kill any live QR before anything else ──
  // Cancelling under a scannable QR is how money lands on a sale that no
  // longer exists.
  const qr = await closeLiveGatePassQr(saleId, `Sale cancelled: ${reason}`);
  if (!qr.closed) {
    throw new DirectSaleCancelError(
      `This sale has a live counter QR (${qr.qrId}) that could not be closed: ${qr.error} ` +
        `Cancel aborted, because the QR is still payable.`,
      502,
    );
  }

  const money = await loadDirectSaleMoney(pgClient, saleId);
  const isAgent = sale.customerType === "agent";

  // ── Resolve where the refund goes ──
  let method: "razorpay" | "balance" | "none";
  if (money.refundable <= 0.001) {
    method = "none";
  } else if (refundMethod === "balance") {
    if (!isAgent) {
      throw new DirectSaleCancelError(
        "Only an agent gate pass can be refunded to an available balance; a counter customer has no ledger. Refund to the bank instead.",
        409,
      );
    }
    method = "balance";
  } else {
    method = "razorpay";
  }

  // ── Gateway work happens BEFORE the transaction ──
  let plan: GatePassRefundPlan | null = null;
  if (method === "razorpay") {
    try {
      plan = await initiateGatePassBankRefunds(
        saleId,
        money.refundable,
        `Cancel ${sale.gpNo ?? saleId}: ${reason}`,
      );
    } catch (err) {
      if (err instanceof RefundError) throw new DirectSaleCancelError(err.message, 409);
      throw err;
    }
  }

  let ledgerReversed = 0;
  let cashReceiptReversed = 0;

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    // Re-read under lock: a webhook could have landed while we were at the
    // gateway, which would change what is owed.
    const [live] = (await tx`
      SELECT status::text AS status FROM direct_sales
       WHERE id = ${saleId}::uuid FOR UPDATE
    `) as any[];
    if (!live) throw new DirectSaleCancelError("Sale not found", 404);
    if (live.status === "cancelled")
      throw new DirectSaleCancelError("This sale is already cancelled", 400);

    await tx`
      UPDATE direct_sales
         SET status = 'cancelled',
             cancelled_at = now(),
             cancellation_reason = ${reason},
             cancelled_by = ${performedBy}::uuid,
             updated_at = now()
       WHERE id = ${saleId}::uuid
    `;

    await restoreDirectSaleStock(tx, saleId);

    // A gate pass also tracks issued/returned quantities; zero the issued
    // side so the Gate Pass Report does not show goods still out.
    if (isAgent) {
      await tx`
        UPDATE gate_pass_items SET quantity = 0, updated_at = now()
         WHERE direct_sale_id = ${saleId}::uuid
      `;
    }

    if (plan) {
      for (const intent of plan.intents) {
        await recordBankRefund(tx, intent, `Cancel sale ${saleId}`, performedBy as string);
      }
    } else if (method === "balance") {
      await creditDealerBalance(
        tx,
        sale.customerId,
        money.refundable,
        saleId,
        `Cancellation credit for gate pass ${sale.gpNo ?? saleId}`,
        performedBy,
      );
    }

    // ── Unwind what the sale itself posted ──
    // Independent of the gateway refund above: that returns money the QR
    // took, this reverses the ledger drawdown or counter receipt the sale
    // wrote when it was issued. Both are keyed off what is actually posted,
    // never off grand_total, so a re-run reverses nothing a second time.
    if (isAgent && LEDGER_SETTLED_MODES.has(sale.paymentMode)) {
      ledgerReversed = await reverseGatePassLedgerPosting(tx, {
        dealerId: sale.customerId,
        saleId,
        gpNo: sale.gpNo,
        performedBy,
      });
    }
    if (sale.paymentMode === "cash") {
      cashReceiptReversed = await reverseCounterCashReceipt(tx, saleId);
    }

    // NOTE the tax invoice is deliberately left exactly as issued. It is a
    // real GST document that was handed over, and rewriting its figures
    // would destroy the record of what was billed. It stops being a
    // receivable at the read edge instead: AR Aging skips invoices whose
    // sale is cancelled (finance-ar-aging.ts). Before that, GP-0044 aged as
    // Rs.1,385.77 of phantom debt.
  });

  // Carried on every branch: unwinding the sale's own posting is separate
  // from returning gateway money, and both can happen on one cancel.
  const unwound = {
    ...(ledgerReversed > 0.001 ? { ledgerReversed } : {}),
    ...(cashReceiptReversed > 0.001 ? { cashReceiptReversed } : {}),
  };

  if (method === "razorpay" && plan) {
    return {
      paymentMode: sale.paymentMode,
      ...unwound,
      refund: {
        method: "razorpay",
        amount: plan.refunded,
        razorpayRefundIds: plan.intents.map((i) => i.rzpRefund.id),
        ...(plan.shortfall > 0.001
          ? {
              note:
                `₹${plan.shortfall.toFixed(2)} of the collected amount could not be refunded at ` +
                `the gateway and needs settling by hand.`,
            }
          : {}),
      },
    };
  }

  if (method === "balance") {
    return {
      paymentMode: sale.paymentMode,
      ...unwound,
      refund: { method: "credit", amount: money.refundable },
    };
  }

  // A wallet or credit pass took no cash, but it DID draw on the dealer's
  // balance — reversing that is the whole refund, and it is reported as one
  // rather than as "nothing to refund" (which is what this said before the
  // ledger posting existed).
  if (ledgerReversed > 0.001) {
    return {
      paymentMode: sale.paymentMode,
      ...unwound,
      refund: {
        method: "credit",
        amount: ledgerReversed,
        note:
          sale.paymentMode === "credit"
            ? `The ₹${ledgerReversed.toFixed(2)} billed to this agent's account has been written back.`
            : `₹${ledgerReversed.toFixed(2)} has been returned to the agent's available balance.`,
      },
    };
  }

  // Nothing was collected through the system. Say what the counter owes.
  const handBack = CASH_LIKE.has(sale.paymentMode) ? Number(sale.grandTotal) : 0;
  return {
    paymentMode: sale.paymentMode,
    ...unwound,
    refund: {
      method: "none",
      amount: 0,
      handBack,
      note:
        handBack > 0
          ? cashReceiptReversed > 0.001
            ? `This sale was settled in cash at the counter, so hand back ₹${handBack.toFixed(2)}. The counter receipt has been reversed.`
            : `This sale was settled in ${sale.paymentMode} at the counter and posts no ledger entry, so hand back ₹${handBack.toFixed(2)}.`
          : `Nothing was collected for this ${sale.paymentMode} sale, so there is nothing to refund.`,
    },
  };
}
