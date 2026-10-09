// apps/api/src/lib/ledger-adjustments.ts
// ═══════════════════════════════════════════════════════════════════════
// Credit Note / Debit Note / Write-off posting, shared by
//   • Finance → Credit/Debit Notes   (routes/finance-adjustments.ts)
//   • Finance → Leakage Incentive    (routes/finance-leakage-incentive.ts)
//
// Each voucher is one dealer_ledger row (the money) + one ledger_adjustments
// row (reason, links, audit). dealers.current_balance follows via the
// dealer_ledger trigger (0037). Both helpers expect to run INSIDE the
// caller's transaction (pgClient.begin) so a batch posts all-or-nothing.
// ═══════════════════════════════════════════════════════════════════════

import type { pgClient } from "./db.js";
import { istToday } from "./ist-date.js";

type Sql = typeof pgClient;

export type AdjustmentVoucherType = "Credit Note" | "Debit Note" | "Write-off";

export class AdjustmentError extends Error {
  constructor(public status: number, public error: string, message?: string) {
    super(message ?? error);
  }
}

/** opening_balance + net of every non-Opening ledger row. */
async function runningBalance(tx: Sql, dealerId: string, requireLive: boolean): Promise<number | null> {
  const [bal] = requireLive
    ? await tx`
        SELECT COALESCE(d.opening_balance, 0)
             + COALESCE((
                 SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                                 WHEN dl.type = 'debit'  THEN -dl.amount END)
                   FROM dealer_ledger dl
                  WHERE dl.dealer_id = d.id
                    AND COALESCE(dl.voucher_type, '') <> 'Opening'
               ), 0)::numeric AS bal
          FROM dealers d WHERE d.id = ${dealerId}::uuid AND d.deleted_at IS NULL
      `
    : await tx`
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
  return bal ? parseFloat((bal as any).bal) : null;
}

export interface PostAdjustmentInput {
  dealerId: string;
  voucherType: AdjustmentVoucherType;
  reason: string;            // adjustment_reason enum value
  reasonText: string;
  amount: number;            // positive; direction comes from voucherType
  voucherDate?: string | undefined;      // YYYY-MM-DD, defaults to today (IST)
  invoiceId?: string | null | undefined;
  orderId?: string | null | undefined;
  attachmentUrl?: string | null | undefined;
  userId: string;
  /** Pre-assigned voucher number (batch posting — see nextVoucherSeq). */
  voucherNo?: string | undefined;
}

export interface PostAdjustmentResult {
  ledgerEntryId: string;
  adjustmentId: string;
  voucherNo: string;
  balanceAfter: number;
}

/** Issue one CN / DN / Write-off. Throws AdjustmentError(404) for an unknown dealer. */
export async function postLedgerAdjustment(tx: Sql, input: PostAdjustmentInput): Promise<PostAdjustmentResult> {
  const ledgerType: "credit" | "debit" =
    input.voucherType === "Debit Note" ? "debit" : "credit";

  const bal = await runningBalance(tx, input.dealerId, true);
  if (bal == null) throw new AdjustmentError(404, "Dealer not found");

  const delta = ledgerType === "credit" ? input.amount : -input.amount;
  const newBalance = bal + delta;
  const voucherDate = input.voucherDate ?? istToday();

  const voucherNo = input.voucherNo
    ?? formatVoucherNo(input.voucherType, voucherDate,
                       await nextVoucherSeq(tx, input.voucherType, voucherDate));

  const [led] = await tx`
    INSERT INTO dealer_ledger (
      dealer_id, type, amount,
      reference_id, reference_type,
      description, balance_after, performed_by,
      voucher_no, voucher_type, particulars, voucher_date
    ) VALUES (
      ${input.dealerId}::uuid, ${ledgerType}::ledger_type,
      ${input.amount.toFixed(2)}::numeric,
      NULL, 'adjustment'::ledger_ref_type,
      ${`${input.voucherType}: ${input.reasonText}`},
      ${newBalance.toFixed(2)}::numeric,
      ${input.userId}::uuid,
      ${voucherNo}, ${input.voucherType}, ${input.reasonText}, ${voucherDate}::date
    )
    RETURNING id
  `;

  const [adj] = await tx`
    INSERT INTO ledger_adjustments (
      ledger_entry_id, dealer_id, voucher_type, reason, reason_text,
      invoice_id, order_id, attachment_url, initiated_by
    ) VALUES (
      ${(led as any).id}::uuid, ${input.dealerId}::uuid,
      ${input.voucherType}, ${input.reason}::adjustment_reason,
      ${input.reasonText},
      ${input.invoiceId ?? null}::uuid, ${input.orderId ?? null}::uuid,
      ${input.attachmentUrl ?? null}, ${input.userId}::uuid
    )
    RETURNING id
  `;

  if (input.invoiceId) {
    await applyToInvoice(tx, input.invoiceId, ledgerType === "credit" ? input.amount : -input.amount);
  }

  return {
    ledgerEntryId: (led as any).id,
    adjustmentId: (adj as any).id,
    voucherNo,
    balanceAfter: newBalance,
  };
}

/**
 * Append the mirror-image entry for an adjustment. Throws AdjustmentError
 * for an unknown adjustment (404), a reversal (400) or one already reversed (400).
 */
export async function reverseLedgerAdjustment(
  tx: Sql,
  input: { adjustmentId: string; reasonText: string; userId: string },
): Promise<PostAdjustmentResult> {
  const [src] = await tx`
    SELECT a.id, a.dealer_id, a.voucher_type, a.invoice_id,
           a.reverses_ledger_entry_id,
           dl.id AS ledger_entry_id, dl.type::text AS ledger_type,
           dl.amount::numeric AS amount
      FROM ledger_adjustments a
      JOIN dealer_ledger dl ON dl.id = a.ledger_entry_id
     WHERE a.id = ${input.adjustmentId}::uuid
     FOR UPDATE
  `;
  if (!src) throw new AdjustmentError(404, "Adjustment not found");
  if ((src as any).reverses_ledger_entry_id) {
    throw new AdjustmentError(400, "Cannot reverse a reversal",
      "This entry is already a reversal of another voucher.");
  }
  const [already] = await tx`
    SELECT 1 FROM ledger_adjustments
     WHERE reverses_ledger_entry_id = ${(src as any).ledger_entry_id}::uuid LIMIT 1
  `;
  if (already) {
    throw new AdjustmentError(400, "Already reversed", "This voucher has already been reversed.");
  }

  const amount = parseFloat((src as any).amount);
  const flipped: "credit" | "debit" = (src as any).ledger_type === "credit" ? "debit" : "credit";

  const bal = (await runningBalance(tx, (src as any).dealer_id, false)) ?? 0;
  const delta = flipped === "credit" ? amount : -amount;
  const newBalance = bal + delta;
  const voucherDate = istToday();
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
      ${`Reversal of ${(src as any).voucher_type}: ${input.reasonText}`},
      ${newBalance.toFixed(2)}::numeric, ${input.userId}::uuid,
      ${voucherNo}, ${(src as any).voucher_type}, ${input.reasonText}, ${voucherDate}::date
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
      ${input.reasonText},
      ${(src as any).invoice_id ?? null}::uuid,
      ${(src as any).ledger_entry_id}::uuid,
      ${input.userId}::uuid
    )
    RETURNING id
  `;

  if ((src as any).invoice_id) {
    // Reverse the original invoice effect: flip the sign.
    await applyToInvoice(tx, (src as any).invoice_id, flipped === "credit" ? amount : -amount);
  }

  return {
    ledgerEntryId: (led as any).id,
    adjustmentId: (adj as any).id,
    voucherNo,
    balanceAfter: newBalance,
  };
}

const PREFIX: Record<AdjustmentVoucherType, string> = {
  "Credit Note": "CN", "Debit Note": "DN", "Write-off": "WO",
};

/** Next free running number for <prefix>-<yyyymmdd>-NNN on that voucher date. */
export async function nextVoucherSeq(tx: Sql, voucherType: AdjustmentVoucherType, voucherDate: string): Promise<number> {
  const prefix = PREFIX[voucherType];
  const [seq] = await tx`
    SELECT COALESCE(MAX(
      (regexp_match(voucher_no, ${prefix} || '-\\d{8}-(\\d+)$'))[1]::int
    ), 0) + 1 AS next
    FROM dealer_ledger
    WHERE voucher_no LIKE ${prefix + "-" + voucherDate.replace(/-/g, "") + "-%"}
  `;
  return Number((seq as any).next);
}

export function formatVoucherNo(voucherType: AdjustmentVoucherType, voucherDate: string, seq: number): string {
  return `${PREFIX[voucherType]}-${voucherDate.replace(/-/g, "")}-${String(seq).padStart(3, "0")}`;
}

/** Move an invoice's paid_amount by `signedAmount`, clamped to [0, total]. */
async function applyToInvoice(tx: Sql, invoiceId: string, signedAmount: number) {
  const s = signedAmount.toFixed(2);
  await tx`
    UPDATE invoices SET
      paid_amount = LEAST(total_amount,
                      GREATEST(0, paid_amount + ${s}::numeric)),
      payment_status = CASE
        WHEN LEAST(total_amount,
               GREATEST(0, paid_amount + ${s}::numeric))
             >= total_amount THEN 'paid'
        WHEN LEAST(total_amount,
               GREATEST(0, paid_amount + ${s}::numeric))
             > 0 THEN 'partial'
        ELSE 'unpaid'
      END
    WHERE id = ${invoiceId}::uuid
  `;
}
