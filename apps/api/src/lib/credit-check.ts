// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/lib/credit-check.ts
//
// Single source of truth for "can this dealer afford this order?".
// Called from:
//   • POST /api/v1/dealer/drafts/:date/confirm   (Phase 2A)
//   • POST /api/v1/orders                         (existing — same logic)
//   • Worker auto-confirm                         (Phase 3)
//
// Prepaid balance model (no credit limit):
//   closing_balance = opening_balance + Σ(credit receipts) − Σ(debit orders)
//                     over non-'Opening' dealer_ledger rows
//   available       = max(0, closing_balance)
//
// A customer can only spend what they have topped up (advance payments,
// recorded as 'credit' ledger receipts). There is NO credit limit — the
// `creditLimit`/`outstanding` fields below are kept for response-shape
// compatibility only and no longer affect availability.
//
// EXCEPTION — credit institutions (dealers.customer_type 'Credit Inst-MRP'
// or 'Credit Inst-Dealer'): they buy on monthly credit and clear the bill
// at month end, so `sufficient` is ALWAYS true for them. Their ledger
// balance simply goes negative as purchases accumulate (that negative
// balance IS the month's bill — see dealer statements / AR aging).
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./db.js";

export interface CreditCheckResult {
  /** Hard limit set by admin (numeric, INR) */
  creditLimit: number;
  /** Currently outstanding (sum of un-delivered credit orders, INR) */
  outstanding: number;
  /** Limit minus outstanding (INR, never negative) */
  available: number;
  /** Order total being checked (INR) */
  orderTotal: number;
  /** True if the order fits within available credit */
  sufficient: boolean;
  /** orderTotal - available, only set when !sufficient (INR) */
  shortfall: number;
  /** True when the dealer is a credit institution (billed monthly) */
  creditInstitution: boolean;
}

/**
 * Check whether a dealer can absorb `orderTotal` against their
 * credit limit. Pure read — does not mutate any state.
 *
 * The caller is responsible for taking action on the result:
 *   • sufficient=true → proceed with the credit-mode order
 *   • sufficient=false → either prompt for Razorpay payment, or mark
 *     the order as 'payment_required' (worker path)
 */
export async function checkDealerCredit(
  dealerId: string,
  orderTotal: number
): Promise<CreditCheckResult> {
  const [row] = await pgClient`
    SELECT
      COALESCE(d.credit_limit, 0)::numeric AS credit_limit,
      d.customer_type::text AS customer_type,
      (
        COALESCE(d.opening_balance, 0)
        + COALESCE((
            SELECT SUM(CASE WHEN dl.type = 'credit' THEN dl.amount
                            WHEN dl.type = 'debit'  THEN -dl.amount END)
              FROM dealer_ledger dl
            WHERE dl.dealer_id = d.id
              AND COALESCE(dl.voucher_type, '') <> 'Opening'
          ), 0)
      )::numeric AS closing_balance
    FROM dealers d
    WHERE d.id = ${dealerId} AND d.deleted_at IS NULL
  `;

  if (!row) {
    throw new Error(`Dealer ${dealerId} not found`);
  }

  const creditLimit = parseFloat(row.credit_limit);
  const closing     = parseFloat(row.closing_balance);
  const creditInstitution = isCreditInstitutionType(row.customer_type);
  const outstanding = closing < 0 ? -closing : 0;
  const available   = Math.max(0, closing);   // prepaid: balance only, no limit
  // Credit institutions are billed monthly — never blocked by balance.
  const sufficient = creditInstitution || orderTotal <= available;
  const shortfall = sufficient ? 0 : Math.round((orderTotal - available) * 100) / 100;

  return {
    creditLimit: round2(creditLimit),
    outstanding: round2(outstanding),
    available: round2(available),
    orderTotal: round2(orderTotal),
    sufficient,
    shortfall,
    creditInstitution,
  };
}

/** 'Credit Inst-MRP' / 'Credit Inst-Dealer' dealers buy on monthly credit. */
export function isCreditInstitutionType(
  customerType: string | null | undefined
): boolean {
  return !!customerType && customerType.startsWith("Credit Inst");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Employee mirror of checkDealerCredit. Employees have their own
 * credit_limit / opening_balance (migration 0048) and an append-only
 * employee_ledger. Same closing-balance maths:
 *
 *   closing   = opening_balance + Σ(credit) − Σ(debit)   [non-'Opening' rows]
 *   available = max(0, credit_limit + closing)
 *
 * Pure read — does not mutate state.
 */
export async function checkEmployeeCredit(
  employeeId: string,
  orderTotal: number
): Promise<CreditCheckResult> {
  const [row] = await pgClient`
    SELECT
      COALESCE(e.credit_limit, 0)::numeric AS credit_limit,
      (
        COALESCE(e.opening_balance, 0)
        + COALESCE((
            SELECT SUM(CASE WHEN el.type = 'credit' THEN el.amount
                            WHEN el.type = 'debit'  THEN -el.amount END)
              FROM employee_ledger el
            WHERE el.employee_id = e.id
              AND COALESCE(el.voucher_type, '') <> 'Opening'
          ), 0)
      )::numeric AS closing_balance
    FROM employees e
    WHERE e.id = ${employeeId} AND e.deleted_at IS NULL
  `;

  if (!row) {
    throw new Error(`Employee ${employeeId} not found`);
  }

  const creditLimit = parseFloat(row.credit_limit);
  const closing     = parseFloat(row.closing_balance);
  const outstanding = closing < 0 ? -closing : 0;
  const available   = Math.max(0, creditLimit + closing);
  const sufficient  = orderTotal <= available;
  const shortfall   = sufficient ? 0 : Math.round((orderTotal - available) * 100) / 100;

  return {
    creditLimit: round2(creditLimit),
    outstanding: round2(outstanding),
    available: round2(available),
    orderTotal: round2(orderTotal),
    sufficient,
    shortfall,
    creditInstitution: false,
  };
}