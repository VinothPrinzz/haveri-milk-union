// apps/web/src/services/dtc.ts
// ══════════════════════════════════════════════════════════════════
// DTC Billing API (transport contractor monthly bills). Backend:
// apps/api/src/routes/dtc-*.ts. Kept apart from services/api.ts so the
// module stays self-contained.
// ══════════════════════════════════════════════════════════════════
import { get, post, patch, del, put } from "@/lib/apiClient";

export type BillingType = "km" | "trip" | "litre";
export type RunStatus = "draft" | "submitted" | "pre_audited" | "mktg_approved" | "approved";
export type CostBasis = "total_earnings" | "gross";
export type PayMode = "neft" | "rtgs" | "imps" | "upi" | "cheque" | "cash";

// ── Lookups & settings ──
export interface DtcLookupRoute { id: string; code: string; name: string; contractorId: string | null; contractorName: string | null }
export interface DtcLookupContractor {
  id: string; code: string | null; name: string; phone: string; active: boolean;
  bankName: string | null; accountNo: string | null; ifscCode: string | null; panNumber: string | null;
}
export const fetchDtcLookups = () =>
  get<{ routes: DtcLookupRoute[]; contractors: DtcLookupContractor[] }>("/dtc/lookups");

export interface DtcSettings { costPerLitreBasis: CostBasis; tdsEnabled: boolean; signatures: string[] }
export const fetchDtcSettings = () => get<DtcSettings>("/dtc/settings");
export const saveDtcSettings = (body: DtcSettings) => put<{ message: string }>("/dtc/settings", body);

// ── Route terms ──
export interface RouteTerms {
  id: string; routeId: string; effectiveFrom: string; active: boolean;
  billingType: BillingType; rate: number; kmPerDay: number;
  vehicleCapacityMt: number | null; vehicleNumber: string | null;
  agreementNo: string | null; contractStart: string | null; contractEnd: string | null;
  insulated: boolean; cashCollection: boolean; notes: string | null; createdAt: string;
  createdByName?: string | null; usedInBills?: boolean;
}
export interface RouteTermsRow {
  routeId: string; routeCode: string; routeName: string;
  contractorId: string | null; contractorName: string | null;
  versionCount: number; current: RouteTerms | null; upcoming: RouteTerms | null;
}
export type RouteTermsInput = Omit<RouteTerms, "id" | "createdAt" | "createdByName" | "usedInBills">;
export const fetchRouteTerms = () => get<{ today: string; data: RouteTermsRow[] }>("/dtc/route-terms");
export const fetchRouteTermsHistory = async (routeId: string) =>
  (await get<{ data: RouteTerms[] }>(`/dtc/route-terms/${routeId}/history`)).data;
export const saveRouteTerms = (body: RouteTermsInput) => post<{ message: string; id: string }>("/dtc/route-terms", body);
export const deleteRouteTerms = (id: string) => del<{ message: string }>(`/dtc/route-terms/${id}`);

// ── Crate rates ──
export interface CrateRate { id: string; effectiveFrom: string; rate: number; notes: string | null; createdAt: string; createdByName: string | null }
export const fetchCrateRates = () => get<{ today: string; data: CrateRate[] }>("/dtc/crate-rates");
export const saveCrateRate = (body: { effectiveFrom: string; rate: number; notes?: string | null }) =>
  post<{ message: string }>("/dtc/crate-rates", body);
export const deleteCrateRate = (id: string) => del<{ message: string }>(`/dtc/crate-rates/${id}`);

// ── Recurring charges ──
export interface RecurringCharge {
  id: string; routeId: string; routeCode: string; routeName: string;
  head: "gps" | "other_deduction"; description: string; monthlyAmount: number;
  fromMonth: string; toMonth: string | null; active: boolean; used: boolean;
}
export type RecurringChargeInput = Pick<RecurringCharge, "routeId" | "head" | "description" | "monthlyAmount" | "fromMonth" | "toMonth" | "active">;
export const fetchCharges = async () => (await get<{ data: RecurringCharge[] }>("/dtc/charges")).data;
export const createCharge = (body: RecurringChargeInput) => post<{ message: string }>("/dtc/charges", body);
export const updateCharge = (id: string, body: RecurringChargeInput) => patch<{ message: string }>(`/dtc/charges/${id}`, body);
export const deleteCharge = (id: string) => del<{ message: string }>(`/dtc/charges/${id}`);

// ── Security deposits ──
export interface DepositPlan {
  id: string; contractorId: string; contractorCode: string | null; contractorName: string;
  targetAmount: number; monthlyInstalment: number; openingCollected: number;
  status: "active" | "paused" | "closed";
  refundedAmount: number; refundedOn: string | null; refundReference: string | null; notes: string | null;
  collectedApproved: number; collectedPending: number; collected: number; balanceDue: number;
}
export const fetchDeposits = async () => (await get<{ data: DepositPlan[] }>("/dtc/deposits")).data;
export const saveDeposit = (body: {
  contractorId: string; targetAmount: number; monthlyInstalment: number; openingCollected: number;
  status: DepositPlan["status"]; notes?: string | null;
}) => post<{ message: string }>("/dtc/deposits", body);
export const refundDeposit = (id: string, body: { amount: number; refundedOn: string; reference?: string | null }) =>
  post<{ message: string }>(`/dtc/deposits/${id}/refund`, body);

// ── Runs & bills ──
export interface RunSummary {
  id: string; month: string; status: RunStatus; costBasis: CostBasis; returnedComment: string | null;
  generatedAt: string; generatedByName: string | null;
  submittedAt: string | null; submittedByName: string | null;
  preAuditedAt: string | null; preAuditedByName: string | null;
  mktgApprovedAt: string | null; mktgApprovedByName: string | null;
  approvedAt: string | null; approvedByName: string | null;
  updatedAt: string;
  billCount: number; contractorCount: number; gross: number; totalEarnings: number;
  totalDeductions: number; payable: number; onHoldCount: number; paidCount: number; paidAmount: number;
}
export interface BillSegment {
  key: string; termsId: string; from: string; to: string; billingType: BillingType;
  rate: number; kmPerDay: number; autoDays: number; daysOverride: number | null; qty: number; amount: number;
  runDates?: string[];
}
export interface BillLine {
  id: string; billId: string; kind: "earning" | "deduction"; head: string;
  qty: number | null; rate: number | null; amount: number; remarks: string | null;
  source: "manual" | "auto"; sourceRef: string | null; createdAt: string; createdByName: string | null;
}
export interface Bill {
  id: string; runId: string; routeId: string; routeCode: string; routeName: string;
  contractorId: string | null; contractorName: string | null;
  vehicleNumber: string | null; vehicleCapacityMt: number | null;
  billingType: BillingType; rate: number; kmPerDay: number;
  segments: BillSegment[]; days: number; qtyLitres: number;
  gross: number; otherEarnings: number; totalEarnings: number; totalDeductions: number;
  net: number; payable: number; carryForward: number; costPerLitre: number;
  cashCollection: boolean; suppressedAuto: string[]; onHold: boolean; holdReason: string | null;
  heldAt: string | null; notes: string | null; updatedAt: string;
  contractorCode?: string | null; contractorPhone?: string | null;
  bankName?: string | null; accountNo?: string | null; ifscCode?: string | null; panNumber?: string | null;
  paymentId?: string | null; paidOn?: string | null; paymentMode?: string | null;
  paymentReference?: string | null; paidAmount?: number | null;
  lines: BillLine[];
}
export interface DtcEvent { id: string; action: string; detail: string | null; billId?: string | null; createdAt: string; userName: string | null }
export interface RunDetail { run: RunSummary; signatures: string[]; crateRate: number; bills: Bill[]; events: DtcEvent[] }

export const fetchRuns = async () => (await get<{ data: RunSummary[] }>("/dtc/runs")).data;
export const createRun = (month: string) =>
  post<{ message: string; id: string; month: string; billCount: number }>("/dtc/runs", { month });
export const fetchRun = (key: string) => get<RunDetail>(`/dtc/runs/${key}`);
export const regenerateRun = (id: string) => post<{ message: string }>(`/dtc/runs/${id}/regenerate`);
export const deleteRun = (id: string) => del<{ message: string }>(`/dtc/runs/${id}`);
export type RunAction = "submit" | "pre_audit" | "mktg_approve" | "approve" | "send_back" | "reopen";
export const runAction = (id: string, action: RunAction, comment?: string) =>
  post<{ message: string }>(`/dtc/runs/${id}/action`, { action, comment: comment ?? null });

export interface BillDetail {
  bill: Bill & {
    month: string; runStatus: RunStatus; tdsEntityType: string | null; tdsDeclarationFy: string | null;
  };
  crateRate: number;
  routeSales: number;
  events: DtcEvent[];
  payments: {
    id: string; amount: number; paidOn: string; mode: PayMode; reference: string | null; notes: string | null;
    reversedAt: string | null; reverseReason: string | null; createdByName: string | null;
  }[];
}
export const fetchBill = (id: string) => get<BillDetail>(`/dtc/bills/${id}`);
export const updateBill = (id: string, body: { segments?: { key: string; daysOverride: number | null }[]; notes?: string | null }) =>
  patch<{ message: string }>(`/dtc/bills/${id}`, body);
export interface LineInput { head: string; qty?: number | null; rate?: number | null; amount?: number | null; remarks?: string | null }
export const addBillLine = (id: string, body: LineInput) => post<{ message: string }>(`/dtc/bills/${id}/lines`, body);
export const updateBillLine = (id: string, lineId: string, body: Omit<LineInput, "head">) =>
  patch<{ message: string }>(`/dtc/bills/${id}/lines/${lineId}`, body);
export const deleteBillLine = (id: string, lineId: string) => del<{ message: string }>(`/dtc/bills/${id}/lines/${lineId}`);
export const restoreAutoLines = (id: string) => post<{ message: string }>(`/dtc/bills/${id}/restore-auto`);
export const holdBill = (id: string, onHold: boolean, reason?: string) =>
  post<{ message: string }>(`/dtc/bills/${id}/hold`, { onHold, reason: reason ?? null });

// ── Payments & advances ──
export interface PendingBill {
  billId: string; month: string; routeCode: string; routeName: string;
  contractorId: string | null; contractorName: string | null; contractorCode: string | null;
  bankName: string | null; accountNo: string | null; ifscCode: string | null;
  payable: number; onHold: boolean; holdReason: string | null;
}
export interface PaymentRow {
  id: string; billId: string; amount: number; paidOn: string; mode: PayMode; reference: string | null;
  notes: string | null; createdAt: string; createdByName: string | null;
  reversedAt: string | null; reversedByName: string | null; reverseReason: string | null;
  month: string; routeCode: string; routeName: string; contractorName: string | null;
}
export const fetchPendingPayments = async () => (await get<{ data: PendingBill[] }>("/dtc/payments/pending")).data;
export const fetchPayments = async (q: { from?: string; to?: string; month?: string } = {}) =>
  (await get<{ data: PaymentRow[] }>("/dtc/payments", q)).data;
export const recordPayment = (body: { billIds: string[]; paidOn: string; mode: PayMode; reference?: string | null; notes?: string | null }) =>
  post<{ message: string; count: number; total: number }>("/dtc/payments", body);
export const reversePayment = (id: string, reason: string) => post<{ message: string }>(`/dtc/payments/${id}/reverse`, { reason });

export interface Advance {
  id: string; contractorId: string; contractorName: string; routeId: string | null; routeCode: string | null;
  paidOn: string; amount: number; mode: PayMode; reference: string | null; recoverMonth: string; notes: string | null;
  cancelledAt: string | null; cancelReason: string | null; createdAt: string; createdByName: string | null;
  recoveredInMonth: string | null; recoveredRunStatus: RunStatus | null;
}
export const fetchAdvances = async () => (await get<{ data: Advance[] }>("/dtc/advances")).data;
export const recordAdvance = (body: {
  contractorId: string; routeId?: string | null; paidOn: string; amount: number; mode: PayMode;
  reference?: string | null; recoverMonth: string; notes?: string | null;
}) => post<{ message: string }>("/dtc/advances", body);
export const cancelAdvance = (id: string, reason: string) => post<{ message: string }>(`/dtc/advances/${id}/cancel`, { reason });

// ── Reports ──
export interface CostPerLitreReport {
  from: string; to: string; basis: CostBasis; months: string[]; monthStatus: Record<string, RunStatus>;
  routes: {
    routeId: string; routeCode: string; routeName: string; contractorName: string | null; billingType: BillingType;
    months: Record<string, { qty: number; amount: number; costPerLitre: number }>;
    qty: number; amount: number; costPerLitre: number;
  }[];
  monthTotals: Record<string, { qty: number; amount: number; costPerLitre: number }>;
  totals: { qty: number; amount: number; costPerLitre: number };
}
export const fetchCostPerLitre = (q: { from: string; to: string }) => get<CostPerLitreReport>("/dtc/reports/cost-per-litre", q);

export interface LedgerReport {
  contractor: {
    id: string; code: string | null; name: string; phone: string; bankName: string | null; accountNo: string | null;
    ifscCode: string | null; panNumber: string | null; tdsEntityType: string | null; tdsDeclarationFy: string | null;
  };
  from: string; to: string;
  bills: {
    id: string; month: string; runStatus: RunStatus; routeCode: string; routeName: string; billingType: BillingType;
    days: number; qty: number; gross: number; otherEarnings: number; totalEarnings: number; totalDeductions: number;
    net: number; payable: number; carryForward: number; onHold: boolean;
    paidOn: string | null; paymentReference: string | null; paymentMode: string | null;
    deductions: Record<string, number>;
  }[];
  advances: { id: string; paidOn: string; amount: number; mode: PayMode; reference: string | null; recoverMonth: string; cancelledAt: string | null }[];
  deposit: null | {
    targetAmount: number; monthlyInstalment: number; openingCollected: number; status: string;
    refundedAmount: number; refundedOn: string | null; collectedApproved: number; collected: number;
  };
  totals: { gross: number; otherEarnings: number; totalEarnings: number; totalDeductions: number; payable: number; paid: number; outstanding: number };
}
export const fetchLedger = (q: { contractorId: string; from: string; to: string }) => get<LedgerReport>("/dtc/reports/ledger", q);
