import { get } from "@/lib/apiClient";

// ── Shared types ──
export interface ProductLite {
  id: string;
  reportAlias: string;
  sortOrder: number;
}

export interface RouteLite {
  id: string;
  code: string;
  name: string;
}

// ═══════════════════════════════════════════════════════════════
// A1. Route Sheet
// ═══════════════════════════════════════════════════════════════
export interface RouteSheetAcrossProduct {
  id: string;
  code: string;
  reportAlias: string;
  category: string;
  packetsCrate: number;
  packSize: number;
  unit: string;
}
 
export interface RouteSheetOtherProduct {
  id: string;
  code: string;
  reportAlias: string;
  category: string;
  packetsCrate: number;
  packSize: number;
  unit: string;
}
 
export interface RouteSheetCustomer {
  sl: number;
  id: string;
  code: string;
  name: string;
  acrossQty: Record<string, number>;
  othersText: string;
  othersQty: number;
  netAmount: number;
  crates: number;
}
 
export interface RouteSheetAbstractItem {
  productId: string;
  alias: string;
  sortOrder: number;
  packetsCrate: number;
  packSize: number;
  unit: string;
  crates: number;
  packets: number;
  kgLtr: number;
  amount: number;
  pktPlus: number;
  pktMinus: number;
}
 
export interface RouteSheetAbstract {
  items: RouteSheetAbstractItem[];
  totals: {
    packets: number;
    kgLtr: number;
    amount: number;
    crates: number;
    pktPlus: number;
    pktMinus: number;
  };
}
 
export interface RouteSheetRoute {
  id: string;
  code: string;
  name: string;
  contractor: {
    id: string | null;
    name: string | null;
    vehicleNumber: string | null;
  };
  dispatchTime: string | null;
  batchName: string | null;
  batchCode: string | null;
  customers: RouteSheetCustomer[];
  totals: {
    acrossQty: Record<string, number>;
    othersQty: number;
    netAmount: number;
    crates: number;
    totalAcrossQty: number;
    totalAllQty: number;
  };
  abstract: RouteSheetAbstract;
}
 
export interface RouteSheetResponse {
  date: string;
  batch: {
    id: string;
    name: string;
    batchNumber: string | null;
    dispatchTime: string | null;
  } | null;
  acrossProducts: RouteSheetAcrossProduct[];
  otherProducts: RouteSheetOtherProduct[];
  routes: RouteSheetRoute[];
}
 
export const fetchRouteSheet = (params: {
  date: string;
  batchId?: string;
  routeId?: string;   // all routes
}) => get<RouteSheetResponse>("/reports/route-sheet", params);

// ═══════════════════════════════════════════════════════════════
// A2. Gate Pass Report
// ═══════════════════════════════════════════════════════════════
export interface GatePassRow {
  gpNo: string;
  date: string;
  agentName: string;
  routeName: string;
  items: Array<{ name: string; qty: number }>;
  itemsText: string;
  amount: number;
}

export interface GatePassResponse {
  rows: GatePassRow[];
  totalAmount: number;
  total: number;
  page: number;
  limit: number;
  totalPages?: number;
}

export const fetchGatePassReport = (params: { from: string; to: string; page?: number; limit?: number }) =>
  get<GatePassResponse>("/reports/gate-pass", { page: 1, limit: 100, ...params });

// ═══════════════════════════════════════════════════════════════
// B1. Daily Sales Statement
// ═══════════════════════════════════════════════════════════════
export interface DailyStatementRow {
  date: string;
  qty: Record<string, number>;
  totalAmount: number;
}

export interface DailyStatementGroup {
  key: "milk" | "curd" | "lassi";
  label: string;
  products: ProductLite[];
  rows: DailyStatementRow[];
  totals: { qty: Record<string, number>; totalAmount: number };
}

export interface DailyStatementResponse {
  from: string;
  to: string;
  dates: string[];
  groups: DailyStatementGroup[];
}

export const fetchDailyStatement = (params: { from: string; to: string }) =>
  get<DailyStatementResponse>("/reports/sales-reports/daily-statement", params);

// ═══════════════════════════════════════════════════════════════
// B2. Day / Route Wise Cash Sales
// ═══════════════════════════════════════════════════════════════
export interface DayRouteCashResponse {
  from: string;
  to: string;
  dates: string[];
  routes: RouteLite[];
  matrix: Record<string, Record<string, number>>; // date → routeId → amount
  routeTotals: Record<string, number>;
  dayTotals: Record<string, number>;
  grandTotal: number;
}

export const fetchDayRouteCash = (params: { from: string; to: string }) =>
  get<DayRouteCashResponse>("/reports/sales-reports/day-route-cash", params);

// ═══════════════════════════════════════════════════════════════
// B3. Officer Wise Sales (Qty)
// ═══════════════════════════════════════════════════════════════
export interface OfficerWiseResponse {
  from: string;
  to: string;
  products: ProductLite[];
  officers: Array<{ id: string; name: string }>;
  matrix: Record<string, Record<string, number>>; // productId → officerId → qty
  officerTotals: Record<string, number>;
  productTotals: Record<string, number>;
  grandTotal: number;
}

export const fetchOfficerWise = (params: { from: string; to: string }) =>
  get<OfficerWiseResponse>("/reports/sales-reports/officer-wise", params);

// ═══════════════════════════════════════════════════════════════
// B4 + B6. Cash Sales + Sales Register (same shape)
// ═══════════════════════════════════════════════════════════════
export interface SalesGridRoute {
  id: string;
  code: string;
  name: string;
  contractorName: string | null;
  qty: Record<string, number>;
  amount: Record<string, number>;
  milkAmount: number;
  productAmount: number;
  total: number;
}

export interface SalesGridResponse {
  from: string;
  to: string;
  products: ProductLite[];
  routes: SalesGridRoute[];
  totals: {
    qty: Record<string, number>;
    amount: Record<string, number>;
    milkAmount: number;
    productAmount: number;
    total: number;
  };
}

export const fetchCashSales = (params: { from: string; to: string }) =>
  get<SalesGridResponse>("/reports/sales-reports/cash-sales", params);

export const fetchSalesRegister = (params: { from: string; to: string }) =>
  get<SalesGridResponse>("/reports/sales-reports/register", params);

// ═══════════════════════════════════════════════════════════════
// B5. Credit Sales — legacy bill format
// ═══════════════════════════════════════════════════════════════
export interface CreditBillProduct {
  id: string;
  code: string;
  reportAlias: string;
  category: string;    // e.g. "MILK", "CURD" (uppercase)
  hsn: string;
  rate: number;
  packSize: number;    // e.g. 500 for "500ml"
  gstPct: number;      // combined GST %
}

export interface CreditBillDailyRow {
  day: string;         // "01" .. "31"
  date: string;        // ISO YYYY-MM-DD
  qty: number[];       // aligned with products[]
  dayTotal: number;
}

export interface CreditBillTotals {
  pkts: number[];
  kgLtr: number[];
  basic: number[];
  cgstPct: number[];
  cgst: number[];
  sgstPct: number[];
  sgst: number[];
  amount: number[];
  basicGrand: number;
  cgstGrand: number;
  sgstGrand: number;
  amountGrand: number;
}

export interface CreditBillCustomer {
  id: string;
  code: string;
  name: string;
  address: string | null;
  city: string | null;
  gstNumber: string | null;
  billNo: string;         // "A2\3\26"
  periodFrom: string;     // "01-03-2026"
  periodTo: string;       // "31-03-2026"
  rateCategory: string | null;
  products: CreditBillProduct[];
  dailyRows: CreditBillDailyRow[];
  totals: CreditBillTotals;
}

export interface CreditSalesResponse {
  from: string;
  to: string;
  periodFrom: string;
  periodTo: string;
  customers: CreditBillCustomer[];
  summary: Array<{ sl: number; code: string; name: string; total: number }>;
  summaryTotal: number;
}

export const fetchCreditSales = (params: { from: string; to: string }) =>
  get<CreditSalesResponse>("/reports/sales-reports/credit-sales", params);

// ═══════════════════════════════════════════════════════════════
// B7. Taluka / Agent Wise
// ═══════════════════════════════════════════════════════════════
export interface TalukaCustomerDetailed {
  sl: number;
  code: string;
  name: string;
  qty: Record<string, number>;
  total: number;
}

export interface TalukaCustomerSummary {
  sl: number;
  code: string;
  name: string;
  cookies20: number;
  butterCookies100: number;
  kodubale180: number;
  paneerNippattu400: number;
  milkTotalQty: number;
  curdTotalQty: number;
  totalAmount: number;
}

export interface TalukaBlock {
  name: string;
  customers: TalukaCustomerDetailed[];
  detailedTotals: { qty: Record<string, number>; total: number };
  summary: TalukaCustomerSummary[];
  summaryTotals: {
    cookies20: number;
    butterCookies100: number;
    kodubale180: number;
    paneerNippattu400: number;
    milkTotalQty: number;
    curdTotalQty: number;
    totalAmount: number;
  };
}

export interface TalukaAgentResponse {
  from: string;
  to: string;
  products: ProductLite[];
  fixedSummaryProducts: Array<{ code: string; label: string; id: string | null }>;
  talukas: TalukaBlock[];
}

export const fetchTalukaAgent = (params: { from: string; to: string }) =>
  get<TalukaAgentResponse>("/reports/sales-reports/taluka-agent", params);

// ═══════════════════════════════════════════════════════════════
// B8. Adhoc Sales Abstract
// ═══════════════════════════════════════════════════════════════
export interface AdhocRow {
  sl: number;
  indentDate: string;
  gpNo: string;
  customerName: string;
  amount: number;
}

export interface AdhocResponse {
  rows: AdhocRow[];
  totalAmount: number;
  total: number;
  page: number;
  limit: number;
  totalPages?: number;
}

export const fetchAdhocSales = (params: { from: string; to: string; page?: number; limit?: number }) =>
  get<AdhocResponse>("/reports/sales-reports/adhoc", { page: 1, limit: 100, ...params });

// ═══════════════════════════════════════════════════════════════
// B9. GST Sales Statement
// ═══════════════════════════════════════════════════════════════
export interface GstStatementRow {
  sl: number;
  productId: string;
  productName: string;
  hsn: string;
  qty: number;
  gstPct: number;
  taxableValue: number;
  cgst: number;
  sgst: number;
  totalTax: number;
  invoiceValue: number;
}

export interface GstStatementResponse {
  from: string;
  to: string;
  rows: GstStatementRow[];
  totals: {
    qty: number;
    taxableValue: number;
    cgst: number;
    sgst: number;
    totalTax: number;
    invoiceValue: number;
  };
}

export const fetchGstStatement = (params: { from: string; to: string }) =>
  get<GstStatementResponse>("/reports/sales-reports/gst-statement", params);

// ═══════════════════════════════════════════════════════════════
// B10. Employee Subsidy Statement
// ═══════════════════════════════════════════════════════════════
export interface EmployeeSubsidyProduct {
  id: string;
  code: string;
  name: string;
  label: string;
}

export interface EmployeeSubsidyProductRow {
  employeeId: string;
  employeeCode: string | null;
  employeeName: string;
  qty: number;
  totalAmount: number;
}

export interface EmployeeSubsidyCombinedRow {
  employeeId: string;
  employeeCode: string | null;
  employeeName: string;
  perProduct: Record<string, { qty: number; amount: number }>;
  totalAmount: number;
}

export interface EmployeeSubsidyReportResponse {
  from: string;
  to: string;
  products: EmployeeSubsidyProduct[];
  employees: Array<{ id: string; code: string | null; name: string }>;
  perProduct: Record<string, EmployeeSubsidyProductRow[]>;
  combined: EmployeeSubsidyCombinedRow[];
  totals: {
    perProduct: Record<string, number>;
    grandTotal: number;
  };
}

export const fetchEmployeeSubsidyReport = (params: { from: string; to: string }) =>
  get<EmployeeSubsidyReportResponse>(
    "/reports/sales-reports/employee-subsidy",
    params,
  );