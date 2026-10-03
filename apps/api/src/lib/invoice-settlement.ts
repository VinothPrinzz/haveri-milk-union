// ════════════════════════════════════════════════════════════════════
// apps/api/src/lib/invoice-settlement.ts
//
// How much has actually been collected against a dealer order — derived
// from evidence, never assumed from the payment mode.
//
// Why this exists: invoices.paid_amount defaults to 0 and payment_status
// to 'unpaid', and nothing but the manual Record Payment screen ever wrote
// to them. Every one of the 6,451 order invoices in prod therefore read
// "unpaid" no matter how the dealer had settled, which is what made AR
// Aging and the dashboard receivables report 0, and what filled the
// Record Payment invoice picker with already-settled invoices.
//
// The PDF beside the row had the opposite bug: renderInvoicePdf() stamps
// PAID for any order in confirmed/dispatched/delivered, so a genuine
// credit-institution receivable printed as PAID. Neither "always unpaid"
// nor "always paid" is right, so this resolves the three settlement rails
// separately:
//
//   1. Pay-per-order UPI. The dealer app collects through Razorpay before
//      the order is confirmed; the capture stamps orders.payment_reference
//      with the pay_* id and writes a payments row carrying that same id
//      in `reference`. That shared reference is the ONLY link between the
//      two - payments.invoice_id is null on all 7.3k rows - and it matches
//      for all 6,034 invoiced UPI orders in prod.
//
//   2. Settlement from the dealer's balance (the "wallet" in the dealer
//      app). orders.payment_mode stays 'credit' for these, and the money
//      movement is a dealer_ledger debit with reference_type='order'. The
//      funds were prepaid at top-up time, so the invoice is settled even
//      though no cash arrives at confirm.
//
//   3. Credit institutions ('Credit Inst-*' customer_type) buy on a
//      monthly account. They get the SAME ledger debit as rail 2, but for
//      them it books a receivable rather than spending prepaid funds - so
//      the debit must NOT count as payment. This is the distinction worth
//      590k+ of real receivables; collapsing it would make AR Aging read 0
//      by construction instead of by bug.
//
// Reversals net off within each rail (processed Razorpay refunds against
// rail 1, ledger credits back to the balance against rail 2), so a
// cancelled-and-refunded order settles back to unpaid on reissue.
// ════════════════════════════════════════════════════════════════════
import { pgClient } from "./db.js";

export type InvoicePaymentStatus = "paid" | "partial" | "unpaid";

export interface OrderSettlement {
  paidAmount: number;
  paymentStatus: InvoicePaymentStatus;
}

/** A dealer on a monthly credit account, not spending prepaid balance. */
export function isCreditInstitution(customerType: string | null | undefined): boolean {
  return String(customerType ?? "").startsWith("Credit Inst");
}

/**
 * Credit terms, in days from the invoice date.
 *
 * Nothing in the schema stores per-dealer terms — `dealers.credit_limit` is
 * the only credit field and it is unused (one dealer, ₹140) — so this rule
 * IS the terms until a credit_days column exists.
 *
 * 30 days for credit institutions, who buy on a monthly account: their book
 * was 23 days old when due dates were introduced, and a shorter term would
 * have reported ₹3.65L as overdue on day one for customers who are not late.
 * 7 days for everyone else, matching the term migration 0015 intended — they
 * pay up front by UPI or from balance, so an open invoice at all is unusual
 * and should surface quickly.
 */
export const CREDIT_INSTITUTION_TERM_DAYS = 30;
export const STANDARD_TERM_DAYS = 7;

export function resolveTermDays(customerType: string | null | undefined): number {
  return isCreditInstitution(customerType)
    ? CREDIT_INSTITUTION_TERM_DAYS
    : STANDARD_TERM_DAYS;
}

/**
 * Resolve what an order's invoice should carry in paid_amount /
 * payment_status.
 *
 * `grandTotal` is the invoice total the caller is about to write, so the
 * two always agree even on a reissue that re-totals the order.
 *
 * Safe to call repeatedly: it recomputes from scratch rather than
 * incrementing, so the mint's ON CONFLICT upsert stays idempotent and a
 * receipt keyed to the invoice is never double-counted or lost.
 */
export async function resolveOrderSettlement(args: {
  orderId: string;
  paymentReference: string | null | undefined;
  customerType: string | null | undefined;
  grandTotal: number;
}): Promise<OrderSettlement> {
  const { orderId, grandTotal } = args;
  // An empty reference must never match; payments.reference is nullable and
  // '' would collide with any other blank row.
  const reference = args.paymentReference?.trim() || null;
  const countLedger = !isCreditInstitution(args.customerType);

  const [row] = await pgClient`
    SELECT
      -- Rail 1: Razorpay captured, less anything refunded back.
      COALESCE((
        SELECT sum(p.amount)
          FROM payments p
         WHERE ${reference}::text IS NOT NULL
           AND p.reference = ${reference ?? ''}
      ), 0)
      - COALESCE((
        SELECT sum(rr.amount)
          FROM razorpay_refunds rr
         WHERE ${reference}::text IS NOT NULL
           AND rr.razorpay_payment_id = ${reference ?? ''}
           AND rr.status = 'processed'
      ), 0)                                              AS razorpay_net,

      -- Rail 2: prepaid balance spent on this order, less any credited back
      -- by a cancellation. Suppressed entirely for credit institutions.
      --
      -- cancelOrderWithReversal writes its reversal against the ORDER id under
      -- reference_type 'order' (store credit) or 'refund' (wallet), so both
      -- have to net off. The Razorpay-apply path also writes a 'credit'/
      -- 'order' row, but references the PAYMENT id rather than the order,
      -- so it correctly does not reverse anything here.
      --
      -- 'adjustment' is the modify-order delta. Editing a confirmed order
      -- debits the extra straight off the dealer's balance (routes/orders.ts,
      -- all four branches) and reissues the invoice at the new total — but the
      -- delta row is written as 'adjustment', so counting only 'order' left the
      -- invoice short by exactly the delta, forever. Eleven invoices carried
      -- ₹5,669.43 of such stubs, money the dealer had already paid, and AR
      -- Aging billed them for it a second time. The Adjustments screen
      -- (routes/finance-adjustments.ts) writes reference_id NULL, and Record
      -- Payment keys to the payment id, so neither can be picked up here.
      CASE WHEN ${countLedger}::boolean THEN COALESCE((
        SELECT sum(CASE
                     WHEN dl.type = 'debit'  AND dl.reference_type IN ('order', 'adjustment')
                       THEN  dl.amount
                     WHEN dl.type = 'credit' AND dl.reference_type IN ('order', 'refund', 'adjustment')
                       THEN -dl.amount
                     ELSE 0
                   END)
          FROM dealer_ledger dl
         WHERE dl.reference_id = ${orderId}::uuid
      ), 0) ELSE 0 END                                   AS ledger_net,

      -- Receipts an admin recorded against this invoice (Record Payment).
      -- The only rail that already worked, and the one that has to survive
      -- a reissue.
      --
      -- One receipt can settle several invoices: payment_allocations (0076)
      -- holds this invoice's share. Receipts linked only by
      -- payments.invoice_id (no allocation rows) count in full. Cheques that
      -- bounced or were cancelled were reversed, so they no longer count.
      COALESCE((
        SELECT sum(pa.amount)
          FROM payment_allocations pa
          JOIN invoices i ON i.id = pa.invoice_id
         WHERE i.order_id = ${orderId}::uuid
           AND NOT EXISTS (SELECT 1 FROM cheques c
                            WHERE c.payment_id = pa.payment_id
                              AND c.status IN ('bounced', 'cancelled'))
      ), 0)
      + COALESCE((
        SELECT sum(p.amount)
          FROM payments p
          JOIN invoices i ON i.id = p.invoice_id
         WHERE i.order_id = ${orderId}::uuid
           AND NOT EXISTS (SELECT 1 FROM payment_allocations x WHERE x.payment_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM cheques c
                            WHERE c.payment_id = p.id
                              AND c.status IN ('bounced', 'cancelled'))
      ), 0)                                              AS receipts
  `;

  const collected =
    Number(row?.razorpay_net ?? 0) +
    Number(row?.ledger_net ?? 0) +
    Number(row?.receipts ?? 0);

  // Never report an invoice as more than fully paid. A genuine overpayment
  // (dealer paid by UPI and an admin also recorded a receipt) belongs on the
  // dealer's balance, not on the invoice.
  const paidAmount = Math.max(0, Math.min(grandTotal, collected));

  // Tolerance of one paise: the rails round independently, so an exactly
  // settled order can land a hair under the total.
  const paymentStatus: InvoicePaymentStatus =
    paidAmount >= grandTotal - 0.01 && grandTotal > 0 ? "paid"
    : paidAmount > 0.01                               ? "partial"
    :                                                   "unpaid";

  return { paidAmount, paymentStatus };
}

/**
 * Re-derive an existing invoice's paid_amount / payment_status in place.
 *
 * The mint is the main write-back, but money can move against an order that
 * was invoiced days earlier — a cancellation refund being the common case.
 * Without this the invoice would keep reading "paid" after the dealer got
 * their money back. This touches only the two settlement columns, so it is
 * far cheaper than a full reissue and never re-renders or re-uploads a PDF.
 *
 * No-op when the order was never invoiced. Never throws: callers run it
 * after the money has already committed, and a settlement refresh must not
 * fail the cancel it is trailing.
 */
export async function refreshInvoiceSettlement(orderId: string): Promise<void> {
  try {
    const [inv] = await pgClient`
      SELECT i.id, i.total_amount, o.payment_reference, d.customer_type
        FROM invoices i
        JOIN orders o  ON o.id = i.order_id
        JOIN dealers d ON d.id = i.dealer_id
       WHERE i.order_id = ${orderId}::uuid
       LIMIT 1
    `;
    if (!inv) return;

    const { paidAmount, paymentStatus } = await resolveOrderSettlement({
      orderId,
      paymentReference: inv.payment_reference,
      customerType: inv.customer_type,
      grandTotal: parseFloat(inv.total_amount ?? "0"),
    });

    await pgClient`
      UPDATE invoices
         SET paid_amount    = ${paidAmount.toFixed(2)}::numeric,
             payment_status = ${paymentStatus}
       WHERE id = ${inv.id}::uuid
    `;
  } catch (err) {
    console.warn("[invoice] settlement refresh failed:", err);
  }
}
