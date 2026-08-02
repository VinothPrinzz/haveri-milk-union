// ══════════════════════════════════════════════════════════════════
// API Service — Phase 3: Real fetch calls to Fastify backend.
// Same function signatures as the mock version — pages need NO changes.
// ══════════════════════════════════════════════════════════════════
import { get, post, patch, del, put } from "@/lib/apiClient";
// ── Re-export types so pages don't need to change imports ──
export type {
  Customer,
  Contractor,
  Route,
  Batch,
  Product,
  PriceChartEntry,
  Indent,
  IndentItem,
  StockEntry,
  DirectSale,
  TimeWindow,
  NotificationSetting,
  Banner,
  SystemUser,
} from "@/data/mockData";
import type { StockBucket } from "@/lib/stock-buckets";

// ── Normalizers: map snake_case API → camelCase UI ──
function normalizeCustomer(d: Record<string, unknown>) {
  const code = (d.code ?? "") as string;
  const routes = ((d.routes as Record<string, unknown>[]) ?? []).map((r) => ({
    routeId: (r.routeId ?? r.route_id) as string,
    routeCode: (r.routeCode ?? r.route_code) as string,
    routeName: (r.routeName ?? r.route_name) as string,
    isPrimary: Boolean(r.isPrimary ?? r.is_primary ?? false),
    position:  (r.position as number | null | undefined) ?? null,
  }));
  return {
    id: d.id as string,
    code,
    name: d.name as string,
    type: (d.customer_type ?? d.type ?? "Retail-Dealer") as string,
    routeId: (d.route_id ?? d.routeId ?? "") as string,
    routeName: (d.route_name ?? d.routeName ?? "") as string,
    routeCode: (d.route_code ?? d.routeCode ?? "") as string,
    routes,
    rateCategory: (d.rate_category ?? d.rateCategory ?? "Retail-Dealer") as string,
    payMode: (d.pay_mode ?? d.payMode ?? "Cash") as "Cash" | "Credit",
    officerName: (d.officer_name ?? d.officerName ?? undefined) as string | undefined,
    phone: (d.phone ?? "") as string,

    // ── Marketing v1.4 additions ──
    email:       (d.email ?? "") as string,
    accountNo:   (d.account_no ?? d.accountNo ?? "") as string,
    creditLimit: parseFloat(String(d.credit_limit ?? d.creditLimit ?? 0)) || 0,
    addressType: (d.address_type ?? d.addressType ?? "") as "Office" | "Residence" | "",
    state:       (d.state ?? "") as string,
    zoneId:      (d.zone_id ?? d.zoneId ?? "") as string,
    zoneName:    (d.zone_name ?? d.zoneName ?? "") as string,
    area:        (d.area ?? "") as string,
    houseNo:     (d.house_no ?? d.houseNo ?? "") as string,
    street:      (d.street ?? "") as string,
    pinCode:     (d.pin_code ?? d.pinCode ?? "") as string,
    lastIndentAt: (d.last_indent_at ?? d.lastIndentAt ?? null) as string | null,

    city:    (d.city ?? "") as string,
    address: (d.address ?? "") as string,
    bank:    d.bank as string | undefined,
    // ── Credit accounting (ledger-derived; wallet_balance retired) ──
    openingBalance:  parseFloat(String(d.opening_balance  ?? d.openingBalance  ?? 0)) || 0,
    currentBalance:  parseFloat(String(d.current_balance  ?? d.currentBalance  ?? 0)) || 0,
    outstanding:     parseFloat(String(d.outstanding      ?? 0)) || 0,
    creditAvailable: parseFloat(String(d.credit_available ?? d.creditAvailable ?? 0)) || 0,
    // Back-compat alias so any old call site still rendering
    // `creditBalance` keeps working — it now means "current balance".
    creditBalance:   parseFloat(String(d.current_balance  ?? d.currentBalance  ?? 0)) || 0,
    status:
      d.active !== false && d.active !== null
        ? ("Active" as const)
        : ("Inactive" as const),
  };
}

function normalizeContractor(d: Record<string, unknown>) {
  const rawRoutes = ((d.assigned_routes ?? d.assignedRoutes) as Record<string, unknown>[]) ?? [];
  const routeRates = rawRoutes.map((r) => ({
    routeId:       (r.id ?? r.route_id) as string,
    totalKmPerDay: parseFloat(String(r.total_km_per_day ?? r.totalKmPerDay ?? 0)) || 0,
    ratePerTrip:   parseFloat(String(r.rate_per_trip   ?? r.ratePerTrip   ?? 0)) || 0,
  }));
  const assignedRoutes = routeRates.map((r) => r.routeId);
  return {
    id:            d.id as string,
    code:          (d.code ?? "") as string,
    name:          d.name as string,
    phone:         (d.phone ?? "") as string,
    email:         (d.email ?? "") as string,
    licenseNumber: (d.license_number ?? d.licenseNumber ?? "") as string,
    address:       (d.address ?? "") as string,
    vehicleNumber: (d.vehicle_number ?? d.vehicleNumber ?? "") as string,
    routeIds:      ((d.route_ids ?? d.routeIds ?? assignedRoutes) as string[]) ?? [],
    routeRates,

    // v1.4 additions
    bankName:    (d.bank_name ?? d.bankName ?? "") as string,
    accountNo:   (d.account_no ?? d.accountNo ?? "") as string,
    ratePerKm:   parseFloat(String(d.rate_per_km ?? d.ratePerKm ?? 0)) || 0,
    periodFrom:  (d.period_from ?? d.periodFrom ?? null) as string | null,
    periodTo:    (d.period_to   ?? d.periodTo   ?? null) as string | null,
    addressType: (d.address_type ?? d.addressType ?? "") as "Office" | "Residence" | "",
    state:       (d.state ?? "") as string,
    city:        (d.city ?? "") as string,
    area:        (d.area ?? "") as string,
    houseNo:     (d.house_no ?? d.houseNo ?? "") as string,
    street:      (d.street ?? "") as string,

    status: d.active !== false ? ("Active" as const) : ("Inactive" as const),
  };
}

export interface Supplier {
  id: string;
  code: string;
  name: string;
  phone: string;
  gstNo: string;
  accountNo: string;
  address: string;
  status: "Active" | "Inactive";
}

function normalizeSupplier(d: Record<string, unknown>): Supplier {
  return {
    id:        d.id as string,
    code:      (d.code ?? "") as string,
    name:      d.name as string,
    phone:     (d.phone ?? "") as string,
    gstNo:     (d.gst_no ?? d.gstNo ?? "") as string,
    accountNo: (d.account_no ?? d.accountNo ?? "") as string,
    address:   (d.address ?? "") as string,
    status:    d.active !== false ? "Active" : "Inactive",
  };
}

function normalizeRoute(d: Record<string, unknown>) {
  // Postgres returns "HH:MM:SS"; the time input wants "HH:MM"
  const rawDispatch = (d.dispatch_time ?? d.dispatchTime ?? "") as string;
  const dispatchTime = rawDispatch ? String(rawDispatch).slice(0, 5) : "";
  return {
    id:             d.id as string,
    code:           (d.code ?? "") as string,
    name:           (d.name ?? "") as string,
    contractorId:   (d.contractor_id ?? d.contractorId ?? "") as string,
    contractorName: (d.contractor_name ?? "") as string,
    dealerCount:    parseInt(String(d.dealer_count ?? 0)),
    ratePerTrip:    parseFloat(String(d.rate_per_trip ?? d.ratePerTrip ?? 0)) || 0,
    totalKmPerDay:  parseFloat(String(d.total_km_per_day ?? d.totalKmPerDay ?? 0)) || 0,
    dispatchTime,
    primaryBatchId: (d.primary_batch_id ?? d.primaryBatchId ?? null) as string | null,
    status: d.active !== false ? ("Active" as const) : ("Inactive" as const),
    // removed: taluka, zoneId
  };
}

function normalizeBatch(d: Record<string, unknown>) {
  return {
    id:         d.id as string,
    batchCode:  (d.batch_number ?? d.batch_code ?? d.batchCode ?? "") as string,
    whichBatch: (d.which_batch ?? d.whichBatch ?? d.name ?? "") as string,
    timing:     (d.timing ?? "") as string,
    routeIds:   (d.route_ids ?? d.routeIds ?? []) as string[],
    status:
      d.status === "active" || d.active !== false
        ? ("Active" as const)
        : ("Inactive" as const),
  };
}

function normalizeProduct(d: Record<string, unknown> | null | undefined) {
  if (!d) {
    return {
      id: "", code: "", name: "", reportAlias: "", category: "",
      packSize: 0, unit: "pcs",
      basePrice: 0, dealerPrice: 0, mrp: 0,   // ← three prices
      gstPercent: 0, hsnNo: "", stock: 0, sortOrder: 0, abstractPosition: 0,
      printDirection: "Across" as const, packetsCrate: 0,
      status: "Inactive" as const, terminated: false,
      rateCategories: {} as Record<string, number>,
    };
  }

  // Three-tier pricing
  const basePrice =
    parseFloat(String(d.basePrice ?? d.base_price ?? 0)) || 0;
  const dealerPrice =
    parseFloat(String(d.dealerPrice ?? d.dealer_price ?? basePrice)) || basePrice;
  const mrp =
    parseFloat(String(d.mrp ?? dealerPrice)) || dealerPrice;

  // Per-rate-category prices default to Basic Price when no override exists.
  const rd = parseFloat(String(d.retailDealerPrice    ?? d.retail_dealer_price    ?? basePrice)) || basePrice;
  const cm = parseFloat(String(d.creditInstMrpPrice   ?? d.credit_inst_mrp_price  ?? basePrice)) || basePrice;
  const cd = parseFloat(String(d.creditInstDealerPrice?? d.credit_inst_dealer_price?? basePrice)) || basePrice;
  const pd = parseFloat(String(d.parlourDealerPrice   ?? d.parlour_dealer_price   ?? basePrice)) || basePrice;

  return {
    id: (d.id ?? "") as string,
    code: (d.code ?? "") as string,
    name: (d.name ?? "") as string,
    reportAlias: (d.reportAlias ?? d.report_alias ?? d.name ?? "") as string,
    category: (d.categoryName ?? d.category_name ?? d.category ?? "") as string,
    categoryId: (d.categoryId ?? d.category_id ?? "") as string,
    packSize: parseFloat(String(d.packSize ?? d.pack_size ?? 0)) || 0,
    unit: (d.unit ?? "pcs") as string,
    basePrice,
    dealerPrice,
    mrp,
    gstPercent: parseFloat(String(d.gstPercent ?? d.gst_percent ?? 0)) || 0,
    hsnNo: (d.hsnNo ?? d.hsn_no ?? "") as string,
    stock: Number(d.stock ?? 0),
    sortOrder: Number(d.sortOrder ?? d.sort_order ?? 0),
    abstractPosition: Number(d.abstractPosition ?? d.abstract_position ?? 0),
    printDirection: (d.printDirection ?? d.print_direction ?? "Across") as "Across" | "Down",
    packetsCrate: Number(d.packetsCrate ?? d.packets_crate ?? 0),
    status: d.available !== false ? ("Active" as const) : ("Inactive" as const),
    terminated: Boolean(d.terminated ?? false),
    imageUrl: (d.imageUrl ?? d.image_url ?? null) as string | null,
    rateCategories: {
      "Retail-Dealer": rd,
      "Credit Inst-MRP": cm,
      "Credit Inst-Dealer": cd,
      "Parlour-Dealer": pd,
    } as Record<string, number>,
  };
}

function normalizeIndent(d: Record<string, unknown>) {
  const items = ((d.items as Record<string, unknown>[]) ?? []).map((i) => ({
    productId: (i.product_id ?? i.productId) as string,
    productName: (i.product_name ?? i.productName ?? "") as string,
    qty: Number(i.quantity ?? i.qty ?? 0),
    rate: parseFloat(String(i.unit_price ?? i.rate ?? 0)) || 0,
    quantity: Number(i.quantity ?? i.qty ?? 0),
  }));
  const rawId = (d.id ?? "") as string;
  const formattedId = rawId ? `#HMU-${rawId.slice(-4).toUpperCase()}` : "";

  // Prefer delivery_date (the operational/delivery day) so this row lines up
  // with the route sheet & dispatch sheet, which key on delivery_date.
  // Fall back to created_at for older rows / sources without a delivery_date.
  const rawDate = d.delivery_date ?? d.created_at ?? d.date ?? "";
  const formattedDate = rawDate
    ? (() => {
        const dt = new Date(String(rawDate));
        if (isNaN(dt.getTime())) return String(rawDate).split("T")[0];
        return `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
      })()
    : "";

  // Display label for every order_status. Previously only confirmed /
  // dispatched / delivered / cancelled were mapped and every other state
  // (draft / pending / payment_required) fell through to the "Confirmed"
  // default below — which made every indent read "Confirmed". Map the full
  // lifecycle so the list shows the TRUE status, and title-case any unknown
  // value rather than masking it as Confirmed.
  const rawStatus = String(d.status ?? "").toLowerCase();
  const statusMap: Record<string, string> = {
    draft: "Draft",
    pending: "Pending",
    payment_required: "Payment Required",
    confirmed: "Confirmed",
    dispatched: "Dispatched",
    delivered: "Delivered",
    cancelled: "Cancelled",
  };
  const statusLabel =
    statusMap[rawStatus] ??
    (rawStatus
      ? rawStatus.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
      : "Confirmed");

  return {
    id: rawId,
    indentNo: formattedId,
    // 'dealer' | 'employee'. Employee-subsidy indents live in employee_orders,
    // so the dealer-only actions (Update / Cancel, which post to the orders
    // endpoints) must not be offered on them.
    partyType: (d.party_type ?? d.partyType ?? "dealer") as string,
    customerId: (d.dealer_id ?? d.customer_id ?? d.customerId ?? "") as string,
    customerName: (d.dealer_name ??
      d.customer_name ??
      d.customerName ??
      "") as string,
    routeId: (d.route_id ?? d.routeId ?? "") as string,
    routeCode: (d.route_code ?? d.routeCode ?? "") as string,
    routeName: (d.route_name ?? d.routeName ?? "") as string,
    batchId: (d.batch_id ?? d.batchId ?? "") as string,
    date: formattedDate,
    rawDate: String(rawDate).split("T")[0],
    agentCode: (d.agent_code ?? d.agentCode ?? "") as string,
    status: statusLabel,
    rawStatus,
    paymentMode: (d.payment_mode ?? d.paymentMode ?? "") as string,
    // Dealer's customer_type — the Payment column shows "Credit" only for
    // credit institutions (buy on monthly account); every other dealer pays
    // from their available balance, shown as "Wallet".
    customerType: (d.customer_type ?? d.customerType ?? "") as string,
    // The tax invoice for this indent, when one exists. Lets the indent #
    // link straight to /sales/invoices/:invoiceId; null rows resolve on click.
    invoiceId: (d.invoice_id ?? d.invoiceId ?? null) as string | null,
    invoiceNumber: (d.invoice_number ?? d.invoiceNumber ?? null) as string | null,
    // True only while the delivery window is still open (today-not-yet-closed
    // or future dates). Drives whether the admin Cancel action is offered.
    windowOpen: Boolean(d.window_open ?? d.windowOpen ?? false),
    items,
    total: parseFloat(String(d.grand_total ?? d.total ?? 0)) || 0,
    totalAmount: parseFloat(String(d.grand_total ?? d.total ?? 0)) || 0,
    gstAmount: parseFloat(String(d.total_gst ?? d.gstAmount ?? 0)) || 0,
  };
}

function normalizeStockEntry(d: Record<string, unknown>) {
  return {
    id: (d.id ?? d.product_id) as string,
    // Fall back to d.id — /fgs/overview returns the product row where `id` IS the product id.
    productId: (d.product_id ?? d.productId ?? d.id) as string,
    productName: (d.name ?? d.product_name ?? d.productName ?? "") as string,
    category: (d.category_name ?? d.category ?? "") as string,
    date: String(d.date ?? new Date().toISOString()).split("T")[0],
    opening: (d.opening ?? 0) as number,
    received: (d.received ?? 0) as number,
    dispatched: (d.dispatched ?? 0) as number,
    wastage: (d.wastage ?? 0) as number,
    closing: (d.closing ?? d.stock ?? 0) as number,
    type: "Production" as string,
    quantity: (d.stock ?? 0) as number,
    batchRef: "" as string,
    notes: "" as string,
    modifiedBy: "" as string,
    // GRN receipt lines for this product/day (supplier + cost). [] when none.
    receipts: ((d.receipts as Record<string, unknown>[]) ?? []).map((r) => ({
      id:           (r.id ?? "") as string,
      supplierId:   (r.supplierId ?? r.supplier_id ?? null) as string | null,
      supplierName: (r.supplierName ?? r.supplier_name ?? "") as string,
      quantity:     Number(r.quantity ?? 0),
      unitCost:     r.unitCost ?? r.unit_cost ?? null,
      totalCost:    r.totalCost ?? r.total_cost ?? null,
    })),
  };
}

function normalizeDirectSale(d: Record<string, unknown>) {
  const items = ((d.items as Record<string, unknown>[]) ?? []).map((i) => ({
    productId: (i.product_id ?? i.productId) as string,
    productName: (i.product_name ?? i.productName ?? "") as string,
    qty: (i.quantity ?? i.qty ?? 0) as number,
    rate: parseFloat(String(i.unit_price ?? i.rate ?? 0)),
  }));
  const rawId = (d.id ?? "") as string;
  const rawCustomerType = String(d.customer_type ?? "agent");    // ← keep raw
  return {
    id: rawId,
    gpNo: (d.gp_no ?? d.gpNo ?? (rawId ? `GP-${rawId.slice(-4).toUpperCase()}` : "")) as string,
    invoiceId: (d.invoice_id ?? d.invoiceId ?? null) as string | null,   // ← surface invoice_id
    customerId: (d.customer_id ?? d.customerId) as string,
    customerName: (d.customer_name ?? d.customerName ?? "") as string,
    customerType: rawCustomerType as "agent" | "cash" | "vip_sample" | "employee_subsidy",
    type: (rawCustomerType === "cash" ? "cash" : "agent") as "agent" | "cash",  // back-compat
    routeId: (d.route_id ?? d.routeId ?? "") as string,
    routeCode: (d.route_code ?? d.routeCode ?? "") as string,
    routeName: (d.route_name ?? d.routeName ?? "") as string,
    date: String(d.sale_date ?? d.date ?? "").split("T")[0],
    items,
    total: parseFloat(String(d.grand_total ?? d.total ?? 0)),
    payMode: (d.payment_mode === "credit" ? "Credit" : "Cash") as "Cash" | "Credit",
  };
}

// ══════════════════════════════════════
// CUSTOMERS (= Dealers in the API)
// ══════════════════════════════════════
export const fetchCustomers = async () => {
  const PAGE_SIZE = 100;
  const all: Record<string, unknown>[] = [];
 
  // Pull first page to discover totalPages
  const first = await get<{
    data: Record<string, unknown>[];
    page?: number;
    totalPages?: number;
    total?: number;
  }>("/dealers", { limit: PAGE_SIZE, page: 1 });
 
  all.push(...(first.data ?? []));
  const totalPages = first.totalPages
    ?? (first.total ? Math.ceil(first.total / PAGE_SIZE) : 1);
 
  // Fetch remaining pages in parallel (cap at 50 pages = 5000 dealers)
  if (totalPages > 1) {
    const pages = Array.from(
      { length: Math.min(totalPages - 1, 49) },
      (_, i) => i + 2,
    );
    const rest = await Promise.all(
      pages.map(p =>
        get<{ data: Record<string, unknown>[] }>("/dealers", {
          limit: PAGE_SIZE,
          page: p,
        }),
      ),
    );
    rest.forEach(r => all.push(...(r.data ?? [])));
  }
  return all.map(normalizeCustomer);
};
 
// ── NEW: server-side paginated fetch for All Customers list ───────
export type DealerListParams = {
  page?: number;
  limit?: number;          // backend max = 100
  search?: string;         // matches code | name | phone
  customerType?: string;   // dealers `customer_type`
  payMode?: string;        // 'Cash' | 'Credit'
  routeId?: string;
  zoneId?: string;
  activeFilter?: "true" | "false";
};
 
export const fetchCustomersPage = async (params: DealerListParams = {}) => {
  const limit = Math.min(Math.max(params.limit ?? 25, 1), 100);
  const page  = Math.max(params.page ?? 1, 1);
  const data  = await get<{
    data: Record<string, unknown>[];
    page: number;
    totalPages: number;
    total: number;
  }>("/dealers", {
    page,
    limit,
    ...(params.search       ? { search: params.search }             : {}),
    ...(params.customerType ? { customerType: params.customerType } : {}),
    ...(params.payMode      ? { payMode: params.payMode }           : {}),
    ...(params.routeId      ? { routeId: params.routeId }           : {}),
    ...(params.zoneId       ? { zoneId: params.zoneId }             : {}),
    ...(params.activeFilter  ? { activeFilter: params.activeFilter } : {}),
  });
  return {
    rows: (data.data ?? []).map(normalizeCustomer),
    page: data.page ?? page,
    totalPages: data.totalPages ?? 1,
    total: data.total ?? (data.data?.length ?? 0),
  };
};

export const getAgents = () => {
  return [] as ReturnType<typeof normalizeCustomer>[];
};

export const createCustomer = async (body: Record<string, unknown>) => {
  const data = await post<{ dealer: Record<string, unknown> }>("/dealers", {
    name: body.name,
    phone: body.phone,
    email: body.email || undefined,
    customerType: body.type,
    rateCategory: body.rateCategory,
    payMode: body.payMode,
    officerName: body.officerName || undefined,
    bank: body.bank || undefined,
    accountNo: body.accountNo || undefined,
    addressType: body.addressType || undefined,
    state: body.state || undefined,
    city: body.city || undefined,
    area: body.area || undefined,
    houseNo: body.houseNo || undefined,
    street: body.street || undefined,
    pinCode: body.pinCode || undefined,
    address: body.address || undefined,
    code: body.code,
    active: body.active !== false,
    ...(body.zoneId ? { zoneId: body.zoneId } : {}),
    ...(body.routeId ? { routeId: body.routeId } : {}),
  });
  return normalizeCustomer(data.dealer);
};

// ── NEW ──
// services/api.ts — add this export
export const updateCustomer = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ dealer: Record<string, unknown> }>(`/dealers/${id}`, {
    name: body.name, phone: body.phone, email: body.email || undefined,
    customerType: body.type, rateCategory: body.rateCategory, payMode: body.payMode,
    officerName: body.officerName || undefined, bank: body.bank || undefined,
    accountNo: body.accountNo || undefined,
    addressType: body.addressType || undefined, state: body.state || undefined,
    city: body.city || undefined, area: body.area || undefined,
    houseNo: body.houseNo || undefined, street: body.street || undefined,
    pinCode: body.pinCode || undefined,
    address: body.address || undefined,
    gstNumber: body.gstNumber || undefined,
    active: body.active !== false,
    ...(body.zoneId ? { zoneId: body.zoneId } : {}),
    ...(body.routeId ? { routeId: body.routeId } : {}),
  });
  return data.dealer;
};

// Soft-delete a customer (dealer). Preserves financial history; the record
// disappears from every list (all reads filter deleted_at). Requires the
// dealers.manage role on the server.
export const deleteCustomer = async (id: string) => {
  await del<{ id: string; deleted: boolean }>(`/dealers/${id}`);
};

// Issue #2 — ADD a route (keeps existing routes intact).
export const assignCustomerToRoute = async (
  customerId: string,
  routeId: string,
) => {
  const data = await post<{ dealerId: string; routes: unknown[] }>(
    `/dealers/${customerId}/routes`,
    { routeId },
  );
  return data.routes;
};

// Remove a single route assignment (uses the new DELETE endpoint).
export const removeCustomerFromRoute = async (
  customerId: string,
  routeId: string,
) => {
  await del(`/dealers/${customerId}/routes/${routeId}`);
};

// Assign an employee to a route (Option A: one route per employee).
export const assignEmployeeToRoute = async (employeeId: string, routeId: string) => {
  const data = await post<{ employee: Record<string, unknown> }>(
    `/employees/${employeeId}/route`,
    { routeId },
  );
  return data.employee;
};

// Remove an employee's route assignment.
export const removeEmployeeFromRoute = async (employeeId: string) => {
  await del(`/employees/${employeeId}/route`);
};

// ══════════════════════════════════════
// CONTRACTORS
// ══════════════════════════════════════
export const fetchContractors = async () => {
  const data = await get<{ data: Record<string, unknown>[] }>("/contractors", {
    limit: 100,
  });
  return (data.data ?? []).map(normalizeContractor);
};

export const createContractor = async (body: Record<string, unknown>) => {
  const data = await post<{ contractor: Record<string, unknown> }>("/contractors", {
    name: body.name,
    phone: body.phone,
    email: body.email || undefined,
    licenseNumber: body.licenseNumber || undefined,
    bankName: body.bankName || undefined,
    accountNo: body.accountNo || undefined,
    vehicleNumber: body.vehicleNumber || undefined,
    periodFrom: body.periodFrom || undefined,
    periodTo: body.periodTo || undefined,
    addressType: body.addressType || undefined,
    state: body.state || undefined,
    city: body.city || undefined,
    area: body.area || undefined,
    houseNo: body.houseNo || undefined,
    street: body.street || undefined,
    address: body.address || undefined,
    code: body.code,
    routeRates: body.routeRates ?? [],
    routeIds: ((body.routeRates as any[]) ?? []).map((r) => r.routeId),
    active: body.active !== false,
  });
  return normalizeContractor(data.contractor);
};

// ── NEW ──
export const updateContractor = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ contractor: Record<string, unknown> }>(`/contractors/${id}`, {
    name: body.name,
    phone: body.phone,
    email: body.email || null,
    licenseNumber: body.licenseNumber || null,
    bankName: body.bankName || null,
    accountNo: body.accountNo || null,
    vehicleNumber: body.vehicleNumber || null,
    periodFrom: body.periodFrom || null,
    periodTo: body.periodTo || null,
    addressType: body.addressType || null,
    state: body.state || null,
    city: body.city || null,
    area: body.area || null,
    houseNo: body.houseNo || null,
    street: body.street || null,
    address: body.address || null,
    routeRates: body.routeRates ?? [],
    routeIds: ((body.routeRates as any[]) ?? []).map((r) => r.routeId),
    active: body.active !== false,
  });
  return normalizeContractor(data.contractor);
};

export const deleteContractor = async (id: string) => {
  await del(`/contractors/${id}`);
};

// ══════════════════════════════════════
// SUPPLIERS (stock vendors master)
// ══════════════════════════════════════
export const fetchSuppliers = async () => {
  const data = await get<{ data: Record<string, unknown>[] }>("/suppliers", {
    limit: 100,
  });
  return (data.data ?? []).map(normalizeSupplier);
};

export const createSupplier = async (body: Record<string, unknown>) => {
  const data = await post<{ supplier: Record<string, unknown> }>("/suppliers", {
    name: body.name,
    phone: body.phone || undefined,
    gstNo: body.gstNo || undefined,
    accountNo: body.accountNo || undefined,
    address: body.address || undefined,
    active: body.active !== false,
  });
  return normalizeSupplier(data.supplier);
};

export const updateSupplier = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ supplier: Record<string, unknown> }>(`/suppliers/${id}`, {
    name: body.name,
    phone: body.phone || null,
    gstNo: body.gstNo || null,
    accountNo: body.accountNo || null,
    address: body.address || null,
    active: body.active !== false,
  });
  return normalizeSupplier(data.supplier);
};

export const deleteSupplier = async (id: string) => {
  await del(`/suppliers/${id}`);
};

// ══════════════════════════════════════
// ROUTES
// ══════════════════════════════════════
export const fetchRoutes = async () => {
  const data = await get<{ routes: Record<string, unknown>[] }>("/routes");
  return (data.routes ?? []).map(normalizeRoute);
};

export const fetchZones = async () => {
  const data = await get<{ zones?: Record<string, unknown>[] }>("/zones");
  if (data.zones) {
    return data.zones.map((z) => ({
      id: z.id as string,
      name: (z.name ?? "") as string,
      slug: (z.slug ?? "") as string,
      // Sales officer assigned to this taluka (empty when unassigned).
      officerName: (z.officerName ?? z.officer_name ?? "") as string,
    }));
  }
  return [];
};

// ══════════════════════════════════════
// OFFICERS (Masters → Officers)
// Field sales officers assigned to talukas (zones).
// ══════════════════════════════════════
export interface OfficerTaluka { id: string; name: string; slug: string; }
export interface Officer {
  id: string;
  name: string;
  phone: string;
  active: boolean;
  talukas: OfficerTaluka[];
}

function normalizeOfficer(d: Record<string, unknown>): Officer {
  return {
    id: d.id as string,
    name: (d.name ?? "") as string,
    phone: (d.phone ?? "") as string,
    active: d.active !== false,
    talukas: ((d.talukas as Record<string, unknown>[]) ?? []).map((t) => ({
      id: t.id as string,
      name: (t.name ?? "") as string,
      slug: (t.slug ?? "") as string,
    })),
  };
}

export const fetchOfficers = async (): Promise<Officer[]> => {
  const data = await get<{ officers?: Record<string, unknown>[] }>("/officers");
  return (data.officers ?? []).map(normalizeOfficer);
};

export const createOfficer = async (body: {
  name: string; phone?: string; active?: boolean; talukaIds?: string[];
}) => {
  const data = await post<{ officer: Record<string, unknown> }>("/officers", {
    name: body.name,
    phone: body.phone || null,
    active: body.active !== false,
    talukaIds: body.talukaIds ?? [],
  });
  return data.officer;
};

export const updateOfficer = async (id: string, body: {
  name?: string; phone?: string; active?: boolean; talukaIds?: string[];
}) => {
  const data = await patch<{ officer: Record<string, unknown> }>(`/officers/${id}`, {
    name: body.name,
    phone: body.phone ?? null,
    active: body.active,
    talukaIds: body.talukaIds,
  });
  return data.officer;
};

export const createRoute = async (body: Record<string, unknown>) => {
  const data = await post<{ route: Record<string, unknown> }>("/routes", {
    name:           body.name,
    code:           body.code,
    contractorId:   body.contractorId || undefined,
    primaryBatchId: body.primaryBatchId || undefined,
    dispatchTime:   body.dispatchTime || null,
    active:         body.active !== false,
    stopDetails:    [],
  });
  return normalizeRoute(data.route);
};

export const updateRoute = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ route: Record<string, unknown> }>(`/routes/${id}`, {
    name:           body.name,
    contractorId:   body.contractorId || null,
    primaryBatchId: body.primaryBatchId || null,
    dispatchTime:   body.dispatchTime || null,
    active:         body.active !== false,
  });
  return normalizeRoute(data.route);
};

export const deleteRoute = async (id: string) => {
  await del(`/routes/${id}`);
};

// ══════════════════════════════════════
// BATCHES
// ══════════════════════════════════════
export const fetchBatches = async () => {
  const data = await get<{ data: Record<string, unknown>[] }>("/batches", {
    limit: 100,
  });
  return (data.data ?? []).map(normalizeBatch);
};

// Existing createBatch — replace to pass dispatchTime too
export const createBatch = async (body: Record<string, unknown>) => {
  const data = await post<{ batch: Record<string, unknown> }>("/batches", {
    batchNumber: body.batchCode,
    name: body.whichBatch,
    whichBatch: body.whichBatch,
    timing: body.timing || null,
    routeIds: body.routeIds ?? [],
  });
  return normalizeBatch(data.batch);
};

// ── NEW ──
export const updateBatch = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ batch: Record<string, unknown> }>(`/batches/${id}`, {
    whichBatch: body.whichBatch,
    timing: body.timing ?? null,
  });
  return normalizeBatch(data.batch);
};

export const deleteBatch = async (id: string) => {
  await del(`/batches/${id}`);
};

// Remove a single route from a batch (we do it via PATCH of the full routeIds
// array, which the existing backend endpoint supports).
export const removeRouteFromBatch = async (batchId: string, routeId: string) => {
  // Fetch current batch → filter routeIds → PATCH with new list
  const current = await get<{ batch: Record<string, unknown> }>(`/batches/${batchId}`);
  const currentIds = (current.batch.route_ids ?? current.batch.routeIds ?? []) as string[];
  const nextIds = currentIds.filter(id => id !== routeId);
  const data = await patch<{ batch: Record<string, unknown> }>(`/batches/${batchId}`, {
    routeIds: nextIds,
  });
  return normalizeBatch(data.batch);
};

// ══════════════════════════════════════
// PRODUCTS
// ══════════════════════════════════════
export const fetchProducts = async () => {
  const data = await get<{ products: Record<string, unknown>[] }>("/products");
  return (data.products ?? []).map(normalizeProduct);   // ← Uses updated normalizer
};

export const fetchProductCategories = async () => {
  const data = await get<{ categories: { id: string; name: string; icon: string | null; sortOrder: number }[] }>("/categories");
  return data.categories ?? [];
};

export const createProduct = async (body: Record<string, unknown>) => {
  const data = await post<{ product: Record<string, unknown> }>("/products", {
    name: body.name,
    categoryId: body.categoryId || body.category,
    icon: body.icon,
    unit: body.unit,
    dealerPrice: Number(body.dealerPrice ?? 0),
    mrp:         Number(body.mrp ?? body.dealerPrice ?? 0),
    gstPercent: Number(body.gstPercent ?? 0),
    stock: 0,
    available: true,
    code: body.code || undefined,
    hsnNo: body.hsnNo || undefined,
    packSize: body.packSize !== undefined ? Number(body.packSize) : undefined,
    printDirection: body.printDirection || undefined,
    packetsCrate: body.packetsCrate !== undefined ? Number(body.packetsCrate) : undefined,
    abstractPosition: body.abstractPosition !== undefined ? Number(body.abstractPosition) : undefined,
    reportAlias: body.reportAlias || body.name || undefined,
    imageUrl: body.imageUrl || null,
  });
  return normalizeProduct(data.product);
};

/** Get a short-lived presigned PUT URL to upload a product image directly to R2. */
export const getProductImagePresignUrl = async (
  filename: string,
  contentType: "image/jpeg" | "image/png" | "image/webp",
): Promise<{ uploadUrl: string; publicUrl: string }> => {
  return post<{ uploadUrl: string; publicUrl: string }>(
    "/admin/products/image-presign",
    { filename, contentType },
  );
};

// ══════════════════════════════════════
// PRICE CHART
// ══════════════════════════════════════
export const fetchPriceChart = async () => {
  const data = await get<{ data: Record<string, unknown>[] }>("/price-chart");
  return (data.data ?? []).map((r) => ({
    productId: (r.productId ?? "") as string,
    productName: (r.productName ?? "") as string,
    reportAlias: (r.reportAlias ?? r.productName ?? "") as string,
    code: (r.code ?? "") as string,
    packSize: parseFloat(String(r.packSize ?? 0)) || 0,
    unit: (r.unit ?? "") as string,
    category: (r.category ?? "") as string,
    gstPercent: parseFloat(String(r.gstPercent ?? 0)) || 0,
    mrp: parseFloat(String(r.mrp ?? 0)) || 0,
    "Retail-Dealer": parseFloat(String(r["Retail-Dealer"] ?? r.mrp ?? 0)) || 0,
    "Credit Inst-MRP":
      parseFloat(String(r["Credit Inst-MRP"] ?? r.mrp ?? 0)) || 0,
    "Credit Inst-Dealer":
      parseFloat(String(r["Credit Inst-Dealer"] ?? r.mrp ?? 0)) || 0,
    "Parlour-Dealer":
      parseFloat(String(r["Parlour-Dealer"] ?? r.mrp ?? 0)) || 0,
  }));
};

export const getRateCategories = () => [
  "Retail-Dealer",
  "Credit Inst-MRP",
  "Credit Inst-Dealer",
  "Parlour-Dealer",
];

// ══════════════════════════════════════
// INDENTS (= Orders in the API)
// ══════════════════════════════════════
export const fetchIndents = async (filters?: {
  status?: string;
  routeId?: string;
  batchId?: string;
  date?: string;
  dealerId?: string;
  from?: string;
  to?: string;
}) => {
  const params: Record<string, string | number | boolean | undefined> = { limit: 100, page: 1 };
  if (filters?.status) params.status = filters.status.toLowerCase();
  if (filters?.routeId) params.routeId = filters.routeId;
  if (filters?.batchId) params.batchId = filters.batchId;
  if (filters?.date) params.date = filters.date; // YYYY-MM-DD (exact delivery day)
  if (filters?.from) params.from = filters.from; // YYYY-MM-DD (delivery_date >= from)
  if (filters?.to) params.to = filters.to;       // YYYY-MM-DD (delivery_date <= to)
  if (filters?.dealerId) params.dealerId = filters.dealerId;
  const data = await get<{ data: Record<string, unknown>[] }>(
    "/orders",
    params,
  );
  return (data.data ?? []).map(normalizeIndent);
};

// Paginated + server-searched variant for the All-Indents page. Unlike
// fetchIndents (which caps at 100 rows on one page), this threads page /
// limit / search through to the API so search and totals span the WHOLE
// dataset, not just the rows already loaded. Returns the page rows plus
// pagination meta.
export const fetchIndentsPage = async (filters?: {
  status?: string;
  routeId?: string;
  from?: string;
  to?: string;
  search?: string;
  page?: number;
  limit?: number;
}) => {
  const params: Record<string, string | number | boolean | undefined> = {
    page: filters?.page ?? 1,
    limit: filters?.limit ?? 50,
  };
  if (filters?.status) params.status = filters.status.toLowerCase();
  if (filters?.routeId) params.routeId = filters.routeId;
  if (filters?.from) params.from = filters.from;
  if (filters?.to) params.to = filters.to;
  if (filters?.search) params.search = filters.search;
  const data = await get<{
    data: Record<string, unknown>[];
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  }>("/orders", params);
  return {
    rows: (data.data ?? []).map(normalizeIndent),
    total: data.total ?? 0,
    page: data.page ?? 1,
    totalPages: data.totalPages ?? 1,
  };
};

// Resolve an indent (order) to its tax-invoice id, generating the invoice on
// demand if it doesn't exist yet. Powers the clickable indent # when the list
// row has no invoice_id. Throws (409) for orders that aren't placed yet.
export const resolveIndentInvoice = async (orderId: string) =>
  get<{ invoiceId: string; invoiceNumber: string | null }>(
    `/orders/${orderId}/invoice`,
  );

// Issue #11
export const modifyIndent = async (
  id: string,
  items: Array<{ productId: string; quantity: number }>,
) => {
  const data = await patch<{ order: Record<string, unknown> }>(
    `/orders/${id}/items`,
    { items },
  );
  return data.order;
};

export const createIndent = async (b: {
  customerId: string;
  routeId?: string | null;
  paymentMode: "upi" | "credit";
  paymentReference?: string;                        
  notes?: string;
  items: Array<{ productId: string; quantity: number }>;
}) => {
  return post("/orders/admin-place", {
    dealerId: b.customerId,
    // The route the admin picked from the dealer's assigned routes. The
    // order is dispatched/reported under this route, not the dealer's
    // primary. Omit → server defaults to the dealer's primary route.
    ...(b.routeId ? { routeId: b.routeId } : {}),
    items: b.items,
    paymentMode: b.paymentMode,
    paymentReference: b.paymentReference,
    notes: b.notes,
  });
};

// ══════════════════════════════════════
// SUBSIDY INDENTS — HTM 1000ML (sub)
// ══════════════════════════════════════
export interface SubsidyProduct {
  id: string;
  name: string;
  unitPrice: number;
  gstPercent: number;
  available: boolean;
}

export const fetchSubsidyProduct = async () => {
  const { product } = await get<{ product: SubsidyProduct }>("/orders/subsidy-product");
  return product;
};

export const placeSubsidyIndent = async (b: {
  customerId: string;
  routeId?: string | null;
  paymentMode: "upi" | "credit" | "cash";
  paymentReference?: string;
  notes?: string;
  quantity: number;
  deliveryDate?: string;
}) =>
  post<{
    message: string;
    orderId: string;
    appended: boolean;
    lineTotal: string;
    invoiceNumber: string | null;
    invoicePdfUrl: string | null;
  }>("/orders/subsidy-place", b);

export interface CancelIndentResult {
  message: string;
  orderId: string;
  paymentMode: string;
  refund: {
    method: "wallet" | "credit" | "razorpay" | "none";
    amount: number;
    razorpayRefundId?: string;
    status?: string;
  };
}

// Admin cancels an indent. `refundMethod` chooses where the money goes:
// "razorpay" (to the dealer's bank, only for online-paid orders) or
// "balance" (store credit on the dealer's available balance). Omitting it
// falls back to the backend auto-rule.
export type RefundMethod = "razorpay" | "balance";
export const cancelIndent = async (
  id: string,
  reason: string,
  refundMethod?: RefundMethod,
) =>
  post<CancelIndentResult>(`/orders/${id}/admin-cancel`, { reason, refundMethod });

export const resetIndents = async () => {};

// ══════════════════════════════════════
// DIRECT SALES
// ══════════════════════════════════════
export const fetchDirectSales = async (filters?: {
  customerType?: string;   // "agent" | "cash"
  routeId?: string;
  dateFrom?: string;       // ISO YYYY-MM-DD
  dateTo?: string;
  officerId?: string;
}) => {
  const params: Record<string, string | number | boolean | undefined> = { limit: 100, page: 1 };
  if (filters?.customerType) params.customerType = filters.customerType;
  if (filters?.routeId)      params.routeId      = filters.routeId;
  if (filters?.dateFrom)     params.dateFrom     = filters.dateFrom;
  if (filters?.dateTo)       params.dateTo       = filters.dateTo;
  if (filters?.officerId)    params.officerId    = filters.officerId;
  const data = await get<{ data: Record<string, unknown>[] }>("/direct-sales", params);
  return (data.data ?? []).map(normalizeDirectSale);
};

export const fetchRecentDirectSales = async (customerType?: string) => {
  const params: Record<string, string | number | boolean | undefined> = { limit: 100 };
  if (customerType) {
    params.customerType = customerType.toLowerCase();
  }
  const data = await get<{ data: Record<string, unknown>[] }>(
    "/direct-sales",
    params,
  );
  return (data.data ?? []).map(normalizeDirectSale);
};

export const fetchGatePassReport = async (
  filters?: Record<string, unknown>,
) => {
  const params: Record<string, string | number | boolean | undefined> = {
    limit: 100,
    ...((filters || {}) as Record<string, string | number | boolean | undefined>),
  };
  if (params.customerType) {
    params.customerType = (params.customerType as string).toLowerCase();
  }
  const data = await get<{ data: Record<string, unknown>[] }>(
    "/direct-sales",
    params,
  );
  return (data.data ?? []).map(normalizeDirectSale);
};

export const createGatePassSale = async (body: {
  customerId: string; // dealer.id
  routeId?: string;
  batchId?: string;
  saleDate?: string;
  paymentMode?: "wallet" | "upi" | "credit" | "cash";
  notes?: string;
  items: Array<{ productId: string; quantity: number }>;
}) => {
  const data = await post<{ sale: Record<string, unknown> }>(
    "/direct-sales/gate-pass",
    body,
  );
  return normalizeDirectSale(data.sale);
};

export const createCashSale = async (body: {
  customerId: string; // cash_customers.id
  routeId?: string;
  batchId?: string;
  saleDate?: string;
  paymentMode?: "cash" | "upi";
  notes?: string;
  items: Array<{ productId: string; quantity: number }>;
}) => {
  const data = await post<{ sale: Record<string, unknown> }>(
    "/direct-sales/cash",
    body,
  );
  return normalizeDirectSale(data.sale);
};

// ══════════════════════════════════════════════════════
// VIP CONTACTS
// ══════════════════════════════════════════════════════
export const fetchVipContacts = async (search?: string) => {
  const data = await get<{ data: Record<string, unknown>[] }>(
    "/vip-contacts",
    search ? { search } : undefined,
  );
  return data.data ?? [];
};

export const createVipContact = async (body: {
  name: string; phone?: string; designation?: string; notes?: string;
}) => {
  const data = await post<{ contact: Record<string, unknown> }>("/vip-contacts", body);
  return data.contact;
};

export const updateVipContact = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ contact: Record<string, unknown> }>(`/vip-contacts/${id}`, body);
  return data.contact;
};

export const deleteVipContact = async (id: string) => {
  await del(`/vip-contacts/${id}`);
};

// ══════════════════════════════════════════════════════
// EMPLOYEES
// ══════════════════════════════════════════════════════
export const fetchEmployees = async (opts?: { search?: string; activeOnly?: boolean }) => {
  const data = await get<{ data: Record<string, unknown>[] }>("/employees", {
    ...(opts?.search ? { search: opts.search } : {}),
    activeOnly: opts?.activeOnly ?? true,
  });
  return data.data ?? [];
};

export const createEmployee = async (body: {
  employeeCode?: string; name: string; phone?: string;
  department?: string; designation?: string; active?: boolean;
}) => {
  const data = await post<{ employee: Record<string, unknown> }>("/employees", body);
  return data.employee;
};

export const updateEmployee = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ employee: Record<string, unknown> }>(`/employees/${id}`, body);
  return data.employee;
};

export const deleteEmployee = async (id: string) => {
  await del(`/employees/${id}`);
};

export const fetchEmployeeCredit = async (employeeId: string) => {
  return get<{
    creditLimit: number;
    closingBalance: number;
    outstanding: number;
    availableCredit: number;
  }>(`/employees/${employeeId}/credit`);
};

export const fetchEmployeeSubsidyRules = async () => {
  const data = await get<{ data: Array<{
    id: string; product_id: string; subsidy_price: string;
    subsidy_percent: string | null; active: boolean;
    product_name: string; product_code: string;
    base_price: string; gst_percent: string; unit: string;
  }> }>("/employee-subsidy-rules");
  return (data.data ?? []).map(r => ({
    id:             r.id,
    productId:      r.product_id,
    productName:    r.product_name,
    productCode:    r.product_code,
    // GST-inclusive unit price the employee pays (source of truth).
    subsidyPrice:   parseFloat(r.subsidy_price),
    subsidyPercent: r.subsidy_percent != null ? parseFloat(r.subsidy_percent) : null,
    basePrice:      parseFloat(r.base_price),
    gstPercent:     parseFloat(r.gst_percent),
    unit:           r.unit,
    active:         r.active,
  }));
};

export const createEmployeeSubsidyRule = (
  body: { productId: string; subsidyPrice: number },
) => post<{ rule: Record<string, unknown> }>("/employee-subsidy-rules", body);

export const updateEmployeeSubsidyRule = (
  id: string, body: { subsidyPrice?: number; active?: boolean },
) => patch<{ rule: Record<string, unknown> }>(`/employee-subsidy-rules/${id}`, body);

export const deleteEmployeeSubsidyRule = (id: string) =>
  del(`/employee-subsidy-rules/${id}`);

// ══════════════════════════════════════════════════════
// DIRECT SALES — VIP + EMPLOYEE
// ══════════════════════════════════════════════════════
export const createVipSampleSale = async (body: {
  customerId: string;          // vip_contacts.id
  routeId?: string;
  batchId?: string;
  saleDate?: string;
  notes?: string;
  items: Array<{ productId: string; quantity: number }>;
}) => {
  const data = await post<{ sale: Record<string, unknown> }>(
    "/direct-sales/vip-sample",
    body,
  );
  return data.sale;
};

// Places an employee-subsidy INDENT (employee_orders), not a direct sale:
// it dispatches on a route, shows in All Indents, and raises a tax invoice.
// routeId is required — the dispatch sheet is keyed by route.
export const createEmployeeSubsidySale = async (body: {
  customerId: string;          // employees.id
  routeId: string;
  saleDate?: string;
  paymentMode: "cash" | "upi" | "credit";
  paymentRef?: string;
  notes?: string;
  items: Array<{ productId: string; quantity: number }>;
}) =>
  post<{
    orderId: string;
    deliveryDate: string;
    status: string;
    appended: boolean;
    grandTotal: string;
    invoiceNumber: string | null;
    invoicePdfUrl: string | null;
  }>("/direct-sales/employee-subsidy", body);

// ══════════════════════════════════════
// FGS STOCK
// ══════════════════════════════════════

// A single GRN receipt line — who the received stock was purchased from + cost.
export interface StockReceiptLine {
  supplierId?: string | null;
  quantity: number;
  unitCost?: number | null;
}

// Accepts an array of entries — matches backend Zod schema { date, entries: [...] }
// `receipts` (optional) carries the supplier/cost breakdown of `received`; when
// present the backend derives `received` from the line quantities.
export const updateStockEntries = async (
  date: string,
  entries: Array<{
    productId: string;
    opening: number;
    received: number;
    dispatched: number;
    wastage: number;
    receipts?: StockReceiptLine[];
  }>,
) => {
  return await post<{ message: string; entries: unknown[] }>("/fgs/update", {
    date,
    entries,
  });
};

// Backwards-compatible single-row helper (some pages still use this)
export const updateStockEntry = async (
  productId: string,
  body: Record<string, unknown>,
) => {
  return updateStockEntries(
    (body.date as string) || new Date().toISOString().split("T")[0],
    [
      {
        productId,
        opening: Number(body.opening ?? 0),
        received: Number(body.received ?? 0),
        dispatched: Number(body.dispatched ?? 0),
        wastage: Number(body.wastage ?? 0),
      },
    ],
  );
};

export const fetchStockEntries = async (date?: string, bucket?: StockBucket) => {
  const params: Record<string, string> = {};
  if (date)   params.date   = date;
  if (bucket) params.bucket = bucket;
  const data = await get<{ products: Record<string, unknown>[] }>(
    "/fgs/overview",
    Object.keys(params).length ? params : undefined,
  );
  return (data.products ?? []).map(normalizeStockEntry);
};

// ══════════════════════════════════════
// DISPATCH
// ══════════════════════════════════════

export const fetchDispatchAssignments = async (date?: string) => {
  const params = date ? { date } : undefined;
  const data = await get<{ data: Record<string, unknown>[] }>(
    "/dispatch/assignments",
    params,
  );
  return (data.data ?? []).map((a) => {
    const dealers = (a.dealers as Record<string, unknown>[]) ?? [];
    // Compute actual totals from the orders embedded under this assignment.
    const totalAmount = dealers.reduce(
      (s, dlr) => s + parseFloat(String(dlr.grand_total ?? 0)),
      0,
    );
    const totalIndents = dealers.length;
    const totalItems = dealers.reduce(
      (s, dlr) => s + Number(dlr.item_count ?? 0),
      0,
    );
    const totalCrates = Math.ceil(totalItems / 24); // ~24 items/crate

    // Departure time — backend returns "HH:MM:SS" or null.
    // Replace the `rawTime` / `dispatchTime` block with:
    const actualIso = (a.actual_departure_time ?? "") as string;
    const plannedRaw = (a.departure_time ?? "") as string;

    const dispatchTime = actualIso
      ? (() => {
          const dt = new Date(actualIso);
          let h = dt.getHours();
          const m = dt.getMinutes();
          const ampm = h >= 12 ? "PM" : "AM";
          h = h % 12 || 12;
          return `${h}:${String(m).padStart(2, "0")} ${ampm}`;
        })()
      : plannedRaw
      ? (() => {
          const [h, m] = plannedRaw.split(":").map(Number);
          const ampm = h >= 12 ? "PM" : "AM";
          const h12 = h % 12 || 12;
          return `${h12}:${String(m).padStart(2, "0")} ${ampm}`;
        })()
      : "—";

    return {
      id: a.id as string,
      routeId: (a.route_id ?? a.routeId ?? "") as string,
      routeCode: (a.route_code ?? a.routeCode ?? "") as string,
      routeName: (a.route_name ?? a.routeName ?? "") as string,
      zoneName: (a.zone_name ?? "") as string,
      date: String(a.date ?? "").split("T")[0],
      vehicleNumber: (a.vehicle_number ?? "") as string,
      driverName: (a.driver_name ?? "") as string,
      departureTime: plannedRaw || actualIso || "",
      dispatchTime, // formatted "5:30 AM" for display
      dealerCount: Number(a.dealer_count ?? 0),
      itemCount: Number(a.item_count ?? 0),
      status: String(a.status ?? "scheduled"),
      dealers, // keep the raw list for detail drawers
      // Aggregated fields for the dispatch sheet table:
      totalAmount, // ₹ sum of grand_total
      totalIndents, // orders count
      totalItems, // line-item count
      totalCrates, // ~24 items/crate
    };
  });
};

// ══════════════════════════════════════
// TIME WINDOWS
// ══════════════════════════════════════
export const fetchTimeWindows = async () => {
  const data = await get<{ windows: Record<string, unknown>[] }>("/time-windows");
  return (data.windows ?? []).map((w) => ({
    // time_windows row id (null when no window configured for this route yet)
    id:             (w.id ?? null) as string | null,
    routeId:        w.route_id as string,
    routeName:      (w.route_name ?? "") as string,
    routeCode:      (w.route_code ?? "") as string,
    zoneName:       (w.zone_name ?? "") as string,
    openTime:       (w.open_time ?? "06:00") as string,
    warningMinutes: Number(w.warning_minutes ?? 20),
    closeTime:      (w.close_time ?? "08:00") as string,
    active:         w.active !== false,
    configured:     Boolean(w.configured),
  }));
};

export const updateTimeWindow = async (
  routeId: string,
  body: { openTime: string; warningMinutes: number; closeTime: string; active: boolean },
) => {
  const data = await patch<{ window: Record<string, unknown> }>(`/time-windows/route/${routeId}`, body);
  return data.window;
};

// ══════════════════════════════════════
// NOTIFICATIONS
// ══════════════════════════════════════
export const fetchNotificationSettings = async () => {
  const data = await get<{ config: Record<string, unknown>[] }>(
    "/notification-config",
  );
  return (data.config ?? []).map((n) => ({
    id: n.id as string,
    type: (n.event ?? n.event_name ?? n.type ?? "") as string,
    description: (n.description ?? "") as string, // Issue #17
    sendToAdmin: (n.send_to_admin ?? n.sendToAdmin ?? false) as boolean,
    sendToDealer: (n.send_to_dealer ?? n.sendToDealer ?? false) as boolean,
    sendToContractor: (n.send_to_contractor ??
      n.sendToContractor ??
      false) as boolean,
    enabled: n.enabled !== false,
  }));
};

export const sendNotification = async (body: {
  title: string;
  message: string;
  target?: { type: "all" | "dealer" | "zone"; id?: string };
  channel?: "push" | "sms" | "email";
}) => {
  const target = body.target ?? { type: "all" };
  // Only include `id` if it's a non-empty string — otherwise Zod rejects "" as invalid UUID.
  const payload: Record<string, unknown> = {
    title: body.title,
    message: body.message,
    channel: body.channel ?? "push",
    target: target.id
      ? { type: target.type, id: target.id }
      : { type: target.type },
  };
  return await post<{
    id: string;
    targetType: string;
    targetId: string | null;
  }>("/notifications/send", payload);
};

export const sendDealerNotification = async (b: {
  title: string;
  message: string;
  target?: { type: "all" | "dealer" | "zone"; id?: string };
  channel?: "push" | "sms" | "email";
}) => post("/notifications/send", b);

export const fetchDealersLite = async () => {
  const PAGE_SIZE = 100;
  const all: any[] = [];
  const first = await get<{ data: any[]; totalPages?: number }>(
    "/dealers", { limit: PAGE_SIZE, page: 1 },
  );
  all.push(...(first.data ?? []));
  const totalPages = first.totalPages ?? 1;
  if (totalPages > 1) {
    const pages = Array.from({ length: Math.min(totalPages - 1, 49) },
      (_, i) => i + 2);
    const rest = await Promise.all(pages.map(p =>
      get<{ data: any[] }>("/dealers", { limit: PAGE_SIZE, page: p }),
    ));
    rest.forEach(r => all.push(...(r.data ?? [])));
  }
  return all.map((d: any) => ({
    id: d.id, name: d.name, code: d.code,
    zoneId: d.zone_id, zoneName: d.zone_name,
  }));
};

// ══════════════════════════════════════
// BANNERS
// ══════════════════════════════════════
export const fetchBanners = async () => {
  const data = await get<
    Record<string, unknown>[] | { banners?: Record<string, unknown>[] }
  >("/banners");
  const list: Record<string, unknown>[] = Array.isArray(data)
    ? data
    : (data.banners ?? []);
  return list.map((b) => ({
    id: b.id as string,
    title: (b.title ?? "") as string,
    category: (b.category ?? "Announcement") as string,
    imageUrl: (b.image_url ?? b.imageUrl ?? "/placeholder.svg") as string,
    linkUrl: (b.link_url ?? b.linkUrl ?? "#") as string,
    status: b.active !== false ? ("Active" as const) : ("Inactive" as const),
    startDate: String(b.start_date ?? b.startDate ?? ""),
    endDate: String(b.end_date ?? b.endDate ?? ""),
  }));
};

export const createBanner = async (body: {
  title: string;
  subtitle?: string;
  category?: string;
  imageUrl?: string;
  linkUrl?: string;
  startDate: string;
  endDate: string;
  zoneId?: string | null;
  active?: boolean;
}) => {
  const data = await post<{ banner: Record<string, unknown> }>(
    "/banners",
    body,
  );
  const b = data.banner;
  return {
    id: b.id as string,
    title: (b.title ?? "") as string,
    category: (b.category ?? "Announcement") as string,
    imageUrl: (b.image_url ?? "/placeholder.svg") as string,
    linkUrl: (b.link_url ?? "#") as string,
    status: b.active !== false ? ("Active" as const) : ("Inactive" as const),
    startDate: String(b.start_date ?? ""),
    endDate: String(b.end_date ?? ""),
  };
};

export const updateBanner = async (
  id: string,
  body: Record<string, unknown>,
) => {
  const data = await patch<{ banner: Record<string, unknown> }>(
    `/banners/${id}`,
    body,
  );
  return data.banner;
};

export const deleteBanner = async (id: string) => {
  await del(`/banners/${id}`);
};

// ══════════════════════════════════════
// SYSTEM USERS
// ══════════════════════════════════════
export const fetchSystemUsers = async () => {
  const data = await get<{ data: Record<string, unknown>[] }>("/users", {
    limit: 100,
  });
  return (data.data ?? []).map((u) => ({
    id: u.id as string,
    name: (u.name ?? "") as string,
    email: (u.email ?? "") as string,
    role: (u.role ?? "call_desk") as string,
    zone: u.zone_id ? "Assigned Zone" : "All Zones",
    status: u.active !== false ? ("Active" as const) : ("Inactive" as const),
    // FIX #28: Improved handling for last_login_at (snake_case from DB)
    lastLogin: u.last_login_at
      ? new Date(u.last_login_at as string).toLocaleString("en-IN", {
          dateStyle: "medium",
          timeStyle: "short",
        })
      : u.lastLoginAt
        ? new Date(u.lastLoginAt as string).toLocaleString("en-IN", {
            dateStyle: "medium",
            timeStyle: "short",
          })
        : "—",
  }));
};

export const createUser = async (body: {
  name: string;
  email: string;
  password: string;
  role:
    | "super_admin"
    | "manager"
    | "dispatch_officer"
    | "accountant"
    | "call_desk";
  phone?: string;
  zoneId?: string;
}) => {
  const data = await post<{ user: Record<string, unknown> }>("/users", body);
  return data.user;
};

export const updateUser = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ user: Record<string, unknown> }>(
    `/users/${id}`,
    body,
  );
  return data.user;
};

export const resetUserPassword = async (id: string, password: string) => {
  return await patch(`/users/${id}/reset-password`, { password });
};

// ══════════════════════════════════════
// CASH CUSTOMERS
// ══════════════════════════════════════
export const fetchCashCustomers = async () => {
  const data = await get<{ data: Record<string, unknown>[] }>("/cash-customers", {
    limit: 100,
  });
  return (data.data ?? []).map(normalizeCashCustomer);
};

export const createCashCustomer = async (body: { name: string; phone?: string; address?: string }) => {
  const data = await post<{ customer: Record<string, unknown> }>("/cash-customers", {
    name: body.name,
    phone: body.phone || undefined,
    address: body.address || undefined,
  });
  return normalizeCashCustomer(data.customer);
};

function normalizeCashCustomer(d: Record<string, unknown>) {
  return {
    id:      d.id as string,
    name:    (d.name ?? "") as string,
    phone:   (d.phone ?? "") as string,
    address: (d.address ?? "") as string,
    createdAt: (d.created_at ?? d.createdAt ?? null) as string | null,
  };
}

// ══════════════════════════════════════
// ROLES (static — managed server-side)
// ══════════════════════════════════════
export const fetchRoles = async () => [
  {
    role: "Super Admin",
    permissions: ["dashboard", "masters", "sales", "fgs", "reports", "system"],
  },
  {
    role: "Manager",
    permissions: ["dashboard", "masters", "sales", "fgs", "reports"],
  },
  {
    role: "Dispatch Officer",
    permissions: ["dashboard", "fgs", "sales.dispatch"],
  },
  {
    role: "FGS — Milk & Curd",
    permissions: ["dashboard", "fgs.stock.milk-curd"],
  },
  {
    role: "FGS — Other Products",
    permissions: ["dashboard", "fgs.stock.others"],
  },
  { role: "Accountant", permissions: ["dashboard", "reports", "sales.view"] },
  {
    role: "Call Desk",
    permissions: [
      "dashboard",
      "sales.record-indents",
      "masters.customers.view",
    ],
  },
];

export const updateRolePermissions = async (
  _role: string,
  _permissions: string[],
) => {};

// ══════════════════════════════════════
// MARKETING SETTINGS (states, cities, etc.)
// ══════════════════════════════════════
export interface MarketingSettings {
  states: string[];
  address_types: string[];
  talukas: string[];
  cities: string[];
}

export const fetchMarketingSettings = async (): Promise<MarketingSettings> => {
  const data = await get<Record<string, unknown>>("/system-settings/marketing");
  return {
    states:        (data.states        as string[]) ?? ["Karnataka", "Kerala", "Maharashtra"],
    address_types: (data.address_types as string[]) ?? ["Office", "Residence"],
    talukas:       (data.talukas       as string[]) ?? [],
    cities:        (data.cities        as string[]) ?? [],
  };
};

// ══════════════════════════════════════
// DISPATCH SHEET (revamp)
// ══════════════════════════════════════
 
export interface DispatchSheetItem {
  productId:       string;
  productName:     string;
  category:        string;
  unit:            string;
  packSize:        number | null;
  totalPackets:    number;
  packetsPerCrate: number;
  crates:          number;
  loosePackets:    number;
}
 
export interface DispatchSheetRoute {
  routeId:        string;
  routeCode:      string;
  routeName:      string;
  contractorName: string | null;
  vehicleNumber:  string | null;
  driverName:     string | null;
  dispatchTime:   string | null;   // "HH:MM:SS"
  status:         "pending" | "loading" | "dispatched" | "delivered";
  assignmentId:   string | null;
  dealerCount:    number;
  lineCount:      number;
  totalAmount:    number;
  items:          DispatchSheetItem[];
  totals:         { packets: number; crates: number };
}
 
export interface DispatchSheetResponse {
  date: string;                   // "YYYY-MM-DD"
  summary: {
    totalItems:   number;
    totalPackets: number;
    totalCrates:  number;
    totalRoutes:  number;
  };
  routes: DispatchSheetRoute[];
}
 
export const fetchDispatchSheet = async (filters?: {
  date?: string;
  routeId?: string;
  batchId?: string;
  bucket?: StockBucket;
}): Promise<DispatchSheetResponse> => {
  const params: Record<string, string | undefined> = {};
  if (filters?.date)    params.date    = filters.date;
  if (filters?.routeId) params.routeId = filters.routeId;
  if (filters?.batchId) params.batchId = filters.batchId;
  if (filters?.bucket)  params.bucket  = filters.bucket;
  return await get<DispatchSheetResponse>("/dispatch-sheet", params);
};
 
export const createDispatch = async (body: {
  date: string;                   // "YYYY-MM-DD"
  routeId: string;
  batchId?: string | null;
  dispatchTime?: string | null;   // "HH:MM"
  vehicleNumber?: string | null;
  driverName?: string | null;
  driverPhone?: string | null;
  notes?: string | null;
  indentIds: string[];
}) => {
  return await post<{
    message: string;
    assignment: Record<string, unknown>;
    confirmedCount: number;
    totals: { dealerCount: number; itemCount: number; totalAmount: number };
  }>("/dispatch/create", body);
};
 
export const markRouteDispatched = async (body: {
  routeId: string;
  date: string;
}) => {
  return await post<{
    message: string;
    assignment: Record<string, unknown>;
    dispatchedOrderCount: number;
  }>("/dispatch-sheet/mark-dispatched", body);
};
 
 
// ══════════════════════════════════════
// PRICE REVISIONS
// ══════════════════════════════════════
 
export interface PriceRevisionRow {
  id:             string;
  productId:      string;
  productCode:    string;
  productName:    string;
  unit:           string;
  oldPrice:       string;       // keep as string — numeric(10,2)
  newPrice:       string;
  oldGst:         string;
  newGst:         string;
  effectiveFrom:  string;       // "YYYY-MM-DD"
  reason:         string | null;
  changedBy:      string | null;
  changedByName:  string | null;
  createdAt:      string;
}
 
export interface ProductWithPricing {
  id:                     string;
  code:                   string | null;
  name:                   string;
  unit:                   string;
  packSize:               string | null;
  hsnNo:                  string | null;
  basePrice:              string;
  gstPercent:             string;
  categoryId:             string;
  categoryName:           string;
  retailDealerPrice:      string;
  creditInstMrpPrice:     string;
  creditInstDealerPrice:  string;
  parlourDealerPrice:     string;
  sortOrder:              number;
  lastRevisedAt:          string | null;
}
 
export const fetchPriceRevisions = async (filters?: {
  productId?: string;
  dateFrom?:  string;
  dateTo?:    string;
  page?:      number;
  limit?:     number;
}) => {
  const params: Record<string, string | number | undefined> = {
    page:  filters?.page  ?? 1,
    limit: filters?.limit ?? 50,
  };
  if (filters?.productId) params.productId = filters.productId;
  if (filters?.dateFrom)  params.dateFrom  = filters.dateFrom;
  if (filters?.dateTo)    params.dateTo    = filters.dateTo;
  return await get<{
    data: PriceRevisionRow[];
    total: number; page: number; limit: number; totalPages: number;
  }>("/price-revisions", params);
};
 
export const fetchProductsWithPricing = async () => {
  const data = await get<{ data: ProductWithPricing[] }>("/products/with-pricing");
  return data.data ?? [];
};
 
export const createPriceRevisions = async (body: {
  revisions: Array<{
    productId:     string;
    newPrice:      number | string;
    newGstPercent?: number | string;
    effectiveFrom?: string;       // "YYYY-MM-DD"
  }>;
  reason?: string;
}) => {
  return await post<{
    message: string;
    results: Array<{ productId: string; oldPrice: string; newPrice: string }>;
  }>("/price-revisions", body);
};
 
 
// ══════════════════════════════════════
// INVOICES v2
// ══════════════════════════════════════
 
export interface InvoiceListRow {
  id:               string;
  invoiceNumber:    string;
  orderId:          string;
  invoiceDate:      string;
  dueDate:          string | null;
  taxableAmount:    string;
  cgst:             string;
  sgst:             string;
  totalTax:         string;
  totalAmount:      string;
  paidAmount:       string;
  paymentStatus:    "paid" | "unpaid" | "partial";
  pdfUrl:           string | null;
  dealerId:         string;
  dealerName:       string;
  dealerCode:       string | null;
  dealerGstNumber:  string | null;
  routeId:          string | null;
  routeCode:        string | null;
  routeName:        string | null;
  paymentMode:      string | null;
  itemCount:        number;
  deliveryDate:     string | null;
  overdueDays:      number;
}
 
export interface InvoiceDetailItem {
  productId:    string;
  productName:  string;
  hsnNo:        string;
  packSize:     string;
  quantity:     number;
  unitPrice:    string;
  gstPercent:   string;
  cgstAmount:   string;
  sgstAmount:   string;
  cgstPercent:  string;
  sgstPercent:  string;
  gstAmount:    string;
  lineTotal:    string;
  basic:        string;
}
 
export interface InvoiceDetail {
  invoice: {
    id:                    string;
    invoiceNumber:         string;
    orderId:               string;
    invoiceDate:           string;
    dueDate:               string | null;
    taxableAmount:         string;
    cgst:                  string;
    sgst:                  string;
    totalTax:              string;
    totalAmount:           string;
    paidAmount:            string;
    paymentStatus:         "paid" | "unpaid" | "partial";
    pdfUrl:                string | null;
    dealerName:            string;
    dealerGstNumber:       string | null;
    dealerAddressSnapshot: string | null;
    routeId:               string | null;
    orderStatus:           string | null;
    paymentMode:           string | null;
    itemCount:             number | null;
    deliveryDate:          string | null;
    orderSubtotal:         string | null;
    orderTotalGst:         string | null;
    orderGrandTotal:       string | null;
    dealerId:              string;
    dealerCode:            string | null;
    currentDealerName:     string;
    dealerPhone:           string | null;
    dealerCurrentGst:      string | null;
    dealerAddress:         string | null;
    dealerCity:            string | null;
    dealerState:           string | null;
    dealerPincode:         string | null;
    routeCode:             string | null;
    routeName:             string | null;
  };
  items: InvoiceDetailItem[];
  payments: Array<{
    id:           string;
    receivedDate: string;
    amount:       string;
    mode:         string;
    reference:    string | null;
    notes:        string | null;
    createdAt:    string;
  }>;
}
 
export const fetchInvoicesList = async (filters?: {
  dealer?:        string;
  dateFrom?:      string;
  dateTo?:        string;
  routeId?:       string;
  paymentStatus?: "paid" | "unpaid" | "partial";
  search?:        string;
  page?:          number;
  limit?:         number;
}) => {
  const params: Record<string, string | number | undefined> = {
    page:  filters?.page  ?? 1,
    limit: filters?.limit ?? 50,
  };
  if (filters?.dealer)        params.dealer        = filters.dealer;
  if (filters?.dateFrom)      params.dateFrom      = filters.dateFrom;
  if (filters?.dateTo)        params.dateTo        = filters.dateTo;
  if (filters?.routeId)       params.routeId       = filters.routeId;
  if (filters?.paymentStatus) params.paymentStatus = filters.paymentStatus;
  if (filters?.search)        params.search        = filters.search;
  return await get<{
    data: InvoiceListRow[];
    total: number; page: number; limit: number; totalPages: number;
  }>("/invoices", params);
};
 
export const fetchInvoiceById = async (id: string) => {
  return await get<InvoiceDetail>(`/invoices/${id}`);
};
 
 
// ══════════════════════════════════════
// PAYMENTS
// ══════════════════════════════════════
 
export type PaymentMode =
  | "cash" | "upi" | "cheque" | "neft" | "rtgs" | "credit" | "wallet";
 
export type PaymentStatus =
  | "completed"   // cash/upi/neft/rtgs/wallet/credit — one-shot receipt
  | "received"    // cheque in hand
  | "deposited"   // cheque deposited, awaiting clearance
  | "cleared"     // cheque cleared
  | "bounced"     // cheque returned by bank (ledger reversed)
  | "cancelled";  // cheque voided before deposit (ledger reversed)

export interface PaymentRow {
  id:              string;
  receivedDate:    string;
  overdueDays:     number;
  dealerId:        string;
  dealerName:      string;
  dealerCode:      string | null;
  mode:            PaymentMode;
  chequeStatus:    string | null;   // raw cheque lifecycle status, null for non-cheque
  status:          PaymentStatus;    // derived display status (cheque-aware)
  reference:       string | null;
  amount:          string;
  invoiceId:       string | null;
  invoiceNumber:   string | null;
  notes:           string | null;
  receivedByName:  string | null;
  createdAt:       string;
}
 
export interface PaymentsResponse {
  data: PaymentRow[];
  summary: {
    totalReceived: number;
    totalCount:    number;
    receivedToday: number;
  };
  total: number; page: number; limit: number; totalPages: number;
}
 
export const fetchPayments = async (filters?: {
  dateFrom?: string;
  dateTo?:   string;
  mode?:     PaymentMode;
  dealerId?: string;
  search?:   string;
  page?:     number;
  limit?:    number;
}) => {
  const params: Record<string, string | number | undefined> = {
    page:  filters?.page  ?? 1,
    limit: filters?.limit ?? 50,
  };
  if (filters?.dateFrom) params.dateFrom = filters.dateFrom;
  if (filters?.dateTo)   params.dateTo   = filters.dateTo;
  if (filters?.mode)     params.mode     = filters.mode;
  if (filters?.dealerId) params.dealerId = filters.dealerId;
  if (filters?.search)   params.search   = filters.search;
  return await get<PaymentsResponse>("/payments", params);
};
 
export const recordPayment = async (body: {
  dealerId:      string;
  amount:        number;
  mode:          PaymentMode;
  receivedDate?: string;
  invoiceId?:    string | null;
  reference?:    string;
  notes?:        string;
}) => {
  return await post<{
    message: string;
    payment: Record<string, unknown>;
    voucherNo: string;
  }>("/payments", body);
};


// ══════════════════════════════════════
// FINANCE — RAZORPAY ONLINE PAYMENTS
// ══════════════════════════════════════
 
export type RazorpayStatus =
  | "created" | "attempted" | "paid" | "failed" | "refunded";
export type RazorpayKind = "credit_topup" | "order_payment";
 
export interface OnlinePaymentRow {
  id:                string;
  razorpayOrderId:   string;
  razorpayPaymentId: string | null;
  amount:            number;
  amountRefunded:    number;
  currency:          string;
  kind:              RazorpayKind;
  status:            RazorpayStatus;
  orderId:           string | null;
  reconciledAt:      string | null;
  settlementId:      string | null;
  errorDescription:  string | null;
  webhookReceived:   boolean;
  paidAt:            string | null;
  createdAt:         string;
  dealerId:          string;
  dealerName:        string;
  dealerCode:        string | null;
  postedToBooks:     boolean;
}
 
export interface OnlinePaymentsResponse {
  data:  OnlinePaymentRow[];
  total: number; page: number; limit: number; totalPages: number;
}
 
export const fetchOnlinePayments = async (filters?: {
  status?:   RazorpayStatus;
  kind?:     RazorpayKind;
  dealerId?: string;
  dateFrom?: string;
  dateTo?:   string;
  recon?:    "all" | "reconciled" | "unreconciled";
  search?:   string;
  page?:     number;
  limit?:    number;
}) => {
  const params: Record<string, string | number | undefined> = {
    page:  filters?.page  ?? 1,
    limit: filters?.limit ?? 50,
  };
  if (filters?.status)   params.status   = filters.status;
  if (filters?.kind)     params.kind     = filters.kind;
  if (filters?.dealerId) params.dealerId = filters.dealerId;
  if (filters?.dateFrom) params.dateFrom = filters.dateFrom;
  if (filters?.dateTo)   params.dateTo   = filters.dateTo;
  if (filters?.recon)    params.recon    = filters.recon;
  if (filters?.search)   params.search   = filters.search;
  return await get<OnlinePaymentsResponse>("/finance/online-payments", params);
};
 
export interface OnlinePaymentsSummary {
  netCollected:        number;
  grossCollected:      number;
  totalRefunded:       number;
  paidCount:           number;
  failedCount:         number;
  pendingCount:        number;
  unreconciledCount:   number;
  unreconciledAmount:  number;
  collectedToday:      number;
  successRate:         number | null;
}
 
export const fetchOnlinePaymentsSummary = async (filters?: {
  dateFrom?: string; dateTo?: string;
}) => {
  const params: Record<string, string | undefined> = {};
  if (filters?.dateFrom) params.dateFrom = filters.dateFrom;
  if (filters?.dateTo)   params.dateTo   = filters.dateTo;
  return (await get<{ summary: OnlinePaymentsSummary }>(
    "/finance/online-payments/summary", params
  )).summary;
};
 
export interface OnlinePaymentDetail {
  payment: OnlinePaymentRow & {
    razorpaySignature: string | null;
    notes:             Record<string, unknown> | null;
    errorCode:         string | null;
    dealerPhone:       string | null;
  };
  refunds: Array<{
    id:               string;
    razorpayRefundId: string | null;
    amount:           number;
    status:           "pending" | "processed" | "failed";
    reason:           string;
    errorDescription: string | null;
    createdAt:        string;
    processedAt:      string | null;
    initiatedByName:  string | null;
  }>;
  ledger: Array<{
    id:          string;
    type:        "credit" | "debit";
    amount:      number;
    voucherNo:   string | null;
    voucherType: string | null;
    particulars: string | null;
    createdAt:   string;
  }>;
}
 
export const fetchOnlinePayment = async (id: string) =>
  await get<OnlinePaymentDetail>(`/finance/online-payments/${id}`);
 
export const refundOnlinePayment = async (
  id: string,
  body: { amount?: number; reason: string }
) =>
  await post<{
    message: string;
    razorpayRefundId: string;
    refundId: string;
    fullyRefunded: boolean;
  }>(`/finance/online-payments/${id}/refund`, body);
 
export const reconcileOnlinePayment = async (
  id: string,
  reconciled = true
) =>
  await post<{ message: string; id: string; reconciledAt: string | null }>(
    `/finance/online-payments/${id}/reconcile`, { reconciled }
  );
 
// ── Reconciliation report ────────────────────────────────────────────
 
export type ReconBucket = "matched" | "needs_review" | "not_posted" | "stale";
 
export interface ReconRow {
  id:                string;
  razorpayOrderId:   string;
  razorpayPaymentId: string | null;
  amount:            number;
  kind:              RazorpayKind;
  status:            RazorpayStatus;
  reconciledAt:      string | null;
  paidAt:            string | null;
  createdAt:         string;
  dealerName:        string;
  dealerCode:        string | null;
  internalPaymentId: string | null;
  bucket:            ReconBucket;
}
 
export interface ReconResponse {
  data: ReconRow[];
  summary: Record<ReconBucket, { count: number; amount: number }>;
}
 
export const fetchRazorpayReconciliation = async (filters?: {
  dateFrom?: string;
  dateTo?:   string;
  bucket?:   "all" | ReconBucket;
}) => {
  const params: Record<string, string | undefined> = {};
  if (filters?.dateFrom) params.dateFrom = filters.dateFrom;
  if (filters?.dateTo)   params.dateTo   = filters.dateTo;
  if (filters?.bucket)   params.bucket   = filters.bucket;
  return await get<ReconResponse>("/finance/reconciliation", params);
};
 
 
// ══════════════════════════════════════
// DEALER LEDGER v2
// ══════════════════════════════════════
 
export interface LedgerRow {
  id:             string;
  type:           "credit" | "debit";
  amount:         string;
  referenceId:    string | null;
  referenceType:  string | null;
  description:    string | null;
  voucherNo:      string | null;
  voucherType:    "Invoice" | "Receipt" | "Adjustment" | "Opening" | "Refund" | null;
  particulars:    string | null;
  voucherDate:    string | null;
  createdAt:      string;
  storedBalance:  string;        // balance_after snapshot at insert time
  running_delta:  string;        // computed cumulative (window fn, filtered range)
}
 
export interface LedgerSummary {
  dealer: { id: string; name: string; code: string | null };
  period: { from: string | null; to: string | null };
  summary: {
    openingBalance:  number;
    totalDebits:     number;
    totalCredits:    number;
    closingBalance:  number;
    creditLimit:     number;
    availableCredit: number;
  };
}
 
export const fetchDealerLedger = async (
  dealerId: string,
  filters?: {
    from?:  string;
    to?:    string;
    page?:  number;
    limit?: number;
  }
) => {
  const params: Record<string, string | number | undefined> = {
    page:  filters?.page  ?? 1,
    limit: filters?.limit ?? 100,
  };
  if (filters?.from) params.from = filters.from;
  if (filters?.to)   params.to   = filters.to;
  return await get<{
    data: LedgerRow[];
    total: number; page: number; limit: number; totalPages: number;
  }>(`/dealers/${dealerId}/ledger`, params);
};
 
export const fetchDealerLedgerSummary = async (
  dealerId: string,
  filters?: { from?: string; to?: string }
) => {
  const params: Record<string, string | undefined> = {};
  if (filters?.from) params.from = filters.from;
  if (filters?.to)   params.to   = filters.to;
  return await get<LedgerSummary>(
    `/dealers/${dealerId}/ledger/summary`,
    params
  );
};

// ── Admin: dealer standing indents & drafts ──────────────────────────

export interface AdminStandingIndentItem {
  productId: string;
  productName: string;
  unit: string;
  icon: string | null;
  imageUrl: string | null;
  basePrice: number;
  gstPercent: number;
  productAvailable: boolean;
  categoryName?: string | null;
  defaultQty: number;
  active: boolean;
  inTemplate: boolean;
}

export interface AdminDraftItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  gstPercent: number;
  lineTotal: number;
  unit: string;
  icon: string | null;
  imageUrl: string | null;
  categoryName?: string | null;
}

export interface CreditSnapshot {
  creditLimit: number;
  outstanding: number;
  available: number;
  orderTotal: number;
  sufficient: boolean;
  shortfall: number;
}

export const fetchDealerStandingIndents = (dealerId: string, routeId?: string | null) =>
  get<{ dealer: { id: string; name: string; code: string | null };
        routeId: string | null;
        items: AdminStandingIndentItem[] }>(
    `/admin/dealers/${dealerId}/standing-indents${routeId ? `?routeId=${routeId}` : ""}`,
  );

export const saveDealerStandingIndents = (
  dealerId: string,
  body: {
    items: { productId: string; defaultQty: number; active: boolean }[];
    routeId?: string | null;
  },
) => put<{ updated: number; routeId: string | null }>(
  `/admin/dealers/${dealerId}/standing-indents`, body,
);

export const fetchDealerDraft = (dealerId: string, date: string, routeId?: string | null) =>
  get<{
    dealer: { id: string; name: string; code: string | null };
    deliveryDate: string;
    exists: boolean;
    paused: boolean;
    pausedReason?: string | null;
    orderId?: string;
    status: string;
    editable: boolean;
    items: AdminDraftItem[];
    totals: { subtotal: number; totalGst: number; grandTotal: number };
    credit: CreditSnapshot;
  }>(`/admin/dealers/${dealerId}/drafts/${date}${routeId ? `?routeId=${routeId}` : ""}`);

export const patchDealerDraft = (
  dealerId: string,
  date: string,
  body: { items: { productId: string; quantity: number }[]; routeId?: string | null },
) => patch<{ orderId: string; status: string;
             totals: { subtotal: number; totalGst: number; grandTotal: number };
             itemCount: number }>(
  `/admin/dealers/${dealerId}/drafts/${date}`, body,
);

export const confirmDealerDraft = (
  dealerId: string,
  date: string,
  body: { force?: boolean; routeId?: string | null } = {},
) => post<{ orderId: string; status: string; deliveryDate: string;
            credit?: CreditSnapshot; forced?: boolean;
            alreadyConfirmed?: boolean }>(
  `/admin/dealers/${dealerId}/drafts/${date}/confirm`, body,
);

// ── Admin: employee standing indents & drafts (subsidized pricing) ───

export interface EmployeeStandingIndentItem {
  productId: string;
  productName: string;
  unit: string;
  icon: string | null;
  imageUrl: string | null;
  basePrice: number;       // MRP reference
  subsidyPrice: number;    // GST-inclusive employee price (source of truth)
  subsidyPercent: number;  // effective discount vs MRP (informational)
  unitPrice: number;       // taxable (pre-GST) unit price
  gstPercent: number;
  productAvailable: boolean;
  defaultQty: number;
  active: boolean;
  inTemplate: boolean;
}

export interface EmployeeDraftItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  gstPercent: number;
  subsidyPercent: number;
  lineTotal: number;
  unit: string;
  icon: string | null;
  imageUrl: string | null;
}

export const fetchEmployeeStandingIndents = (employeeId: string) =>
  get<{ employee: { id: string; name: string; code: string | null };
        items: EmployeeStandingIndentItem[] }>(
    `/admin/employees/${employeeId}/standing-indents`,
  );

export const saveEmployeeStandingIndents = (
  employeeId: string,
  body: { items: { productId: string; defaultQty: number; active: boolean }[] },
) => put<{ updated: number }>(
  `/admin/employees/${employeeId}/standing-indents`, body,
);

export const fetchEmployeeDraft = (employeeId: string, date: string) =>
  get<{
    employee: { id: string; name: string; code: string | null };
    deliveryDate: string;
    exists: boolean;
    orderId?: string;
    status: string;
    editable: boolean;
    items: EmployeeDraftItem[];
    totals: { subtotal: number; totalGst: number; grandTotal: number };
    credit: CreditSnapshot;
  }>(`/admin/employees/${employeeId}/drafts/${date}`);

export const patchEmployeeDraft = (
  employeeId: string,
  date: string,
  body: { items: { productId: string; quantity: number }[] },
) => patch<{ orderId: string; status: string;
             totals: { subtotal: number; totalGst: number; grandTotal: number };
             itemCount: number }>(
  `/admin/employees/${employeeId}/drafts/${date}`, body,
);

export const confirmEmployeeDraft = (
  employeeId: string,
  date: string,
  body: { force?: boolean } = {},
) => post<{ orderId: string; status: string; deliveryDate: string;
            credit?: CreditSnapshot; forced?: boolean;
            alreadyConfirmed?: boolean }>(
  `/admin/employees/${employeeId}/drafts/${date}/confirm`, body,
);

// ══════════════════════════════════════
// STATIC HELPERS
// ══════════════════════════════════════
export const getOfficers = () => [
  { id: "o1", name: "Ravi Kumar" },
  { id: "o2", name: "Suresh Patil" },
  { id: "o3", name: "Mohan Reddy" },
];

// ══════════════════════════════════════
// STUB EXPORTS (used by pages, not yet implemented on backend)
// ══════════════════════════════════════
export const updateProduct = async (id: string, body: Record<string, unknown>) => {
  const mapped = { ...body, categoryId: body.categoryId || body.category };
  const data = await patch<{ product: Record<string, unknown> }>(`/products/${id}`, mapped);
  return normalizeProduct(data.product);
};

export const deleteProduct = async (id: string) => {
  await del(`/products/${id}`);
};

export const upsertProductRate = async (productId: string, categoryId: string, rate: number) => {
  return await post<{ message: string }>(`/products/${productId}/rates`, { categoryId, rate });
};

export const sendInvoice = async (id: string) => {
  return await post<{ message: string }>(`/invoices/${id}/send`, {});
};

export const cancelInvoice = async (id: string) => {
  return await post<{ message: string }>(`/invoices/${id}/cancel`, {});
};

export const fetchInvoice = async (id: string) => {
  return await get<Record<string, unknown>>(`/invoices/${id}`);
};

export const fetchInvoicesForCustomer = async (customerId: string) => {
  const data = await get<{ data: Record<string, unknown>[] }>("/invoices", { dealer: customerId, limit: 100 });
  return data.data ?? [];
};

export const sendBroadcast = async (body: {
  title: string;
  message: string;
  audience?: string;
  channel?: string;
}) => {
  return await post<{ message: string; id: string }>("/notifications/send", {
    title: body.title,
    message: body.message,
    channel: body.channel ?? "push",
    target: { type: "all" },
  });
};

export const fetchNotifications = async () => {
  const data = await get<{ data: Record<string, unknown>[] }>("/notifications", { limit: 100 });
  return (data.data ?? []).map((n) => ({
    id: n.id as string,
    title: (n.title ?? "") as string,
    audience: (n.target_type ?? n.audience ?? "all") as string,
    channel: (n.channel ?? "push") as string,
    sent: Number(n.sent ?? 0),
    delivered: Number(n.delivered ?? 0),
    failed: Number(n.failed ?? 0),
    createdAt: (n.created_at ?? n.createdAt ?? "") as string,
  }));
};

export const fetchDealerNotifications = async () => {
  const data = await get<{ data: Record<string, unknown>[] }>("/notifications/dealer-log", { limit: 100 });
  return (data.data ?? []).map((n) => ({
    id: n.id as string,
    dealerName: (n.dealer_name ?? n.dealerName ?? "") as string,
    title: (n.title ?? "") as string,
    channel: (n.channel ?? "push") as string,
    status: (n.status ?? "pending") as string,
    sentAt: (n.sent_at ?? n.sentAt ?? n.created_at ?? "") as string,
  }));
};

export const fetchUsers = fetchSystemUsers;

export const deleteUser = async (id: string) => {
  await del(`/users/${id}`);
};

export const createRole = async (body: { name: string; permissions: string[] }) => {
  return await post<{ role: Record<string, unknown> }>("/roles", body);
};

// ══════════════════════════════════════════════════════════════════
// Finance — Credit Control, Refunds, AR Aging, Statements, Cheques,
// Adjustments, Dashboard, Day Book. All endpoints return camelCase.
// ══════════════════════════════════════════════════════════════════

export interface Paginated<T> {
  data: T[]; total: number; page: number; limit: number; totalPages: number;
}

// Authenticated fetch that returns raw text (for server-rendered print HTML).
async function getText(path: string, params?: Record<string, string | undefined>): Promise<string> {
  const base = `${import.meta.env.VITE_API_URL ?? ""}/api/v1`;
  const url = new URL(base + path, window.location.origin);
  if (params) Object.entries(params).forEach(([k, v]) => { if (v !== undefined) url.searchParams.set(k, v); });
  const token = localStorage.getItem("hmu_session");
  const res = await fetch(url.toString(), {
    credentials: "include",
    headers: token ? { "x-session-token": token } : {},
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

// Open server-rendered HTML in a new tab (auth via blob, then print-ready).
async function openPrintWindow(path: string, params?: Record<string, string | undefined>) {
  const html = await getText(path, params);
  const blob = new Blob([html], { type: "text/html" });
  const blobUrl = URL.createObjectURL(blob);
  window.open(blobUrl, "_blank");
  setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
}

// ── Employee credit status buckets (employees still use limits) ──
export type CreditStatusBucket = "over_limit" | "critical" | "warning" | "healthy" | "no_limit";

// ── Available Balances (customers — prepaid, no limit) ──
export type BalanceBucket = "empty" | "funded";
export interface CreditControlRow {
  id: string; code: string; name: string; pay_mode: string;
  route_id: string | null; route_name: string | null; zone_name: string | null;
  availableBalance: number; outstanding: number; closingBalance: number;
  statusBucket: BalanceBucket;
  lastPaymentAt: string | null; lastOrderAt: string | null; daysSinceLastPayment: number | null;
}
export interface CreditControlSummary {
  totalPrepaid: number; totalExposure: number;
  fundedCount: number; emptyCount: number; negativeCount: number; dormantWithDuesCount: number;
}
export const fetchCreditControl = (f?: {
  routeId?: string; payMode?: "Cash" | "Credit"; statusBucket?: BalanceBucket;
  search?: string; page?: number; limit?: number;
}) => get<Paginated<CreditControlRow>>("/finance/credit-control", {
  page: f?.page ?? 1, limit: f?.limit ?? 50,
  routeId: f?.routeId, payMode: f?.payMode, statusBucket: f?.statusBucket, search: f?.search,
});
export const fetchCreditControlSummary = async () =>
  (await get<{ summary: CreditControlSummary }>("/finance/credit-control/summary")).summary;

// ── Employee Credit Control (finance) ──
export interface EmployeeCreditRow {
  id: string; code: string | null; name: string;
  route_id: string | null; route_name: string | null;
  creditLimit: number; outstanding: number; closingBalance: number;
  availableCredit: number; heldCount: number; statusBucket: CreditStatusBucket;
}
export interface EmployeeCreditSummary {
  totalExposure: number; totalAvailable: number; totalLimitSanctioned: number;
  overLimitCount: number; heldCount: number;
}
export const fetchEmployeeCreditControl = (f?: {
  routeId?: string; search?: string; page?: number; limit?: number;
}) => get<Paginated<EmployeeCreditRow>>("/finance/employee-credit-control", {
  page: f?.page ?? 1, limit: f?.limit ?? 50,
  routeId: f?.routeId, search: f?.search,
});
export const fetchEmployeeCreditSummary = async () =>
  (await get<{ summary: EmployeeCreditSummary }>("/finance/employee-credit-control/summary")).summary;
export const updateEmployeeCreditLimit = async (employeeId: string, creditLimit: number) =>
  (await patch<{ employee: { id: string; name: string; code: string | null; creditLimit: number } }>(
    `/finance/employee-credit-control/${employeeId}/limit`,
    { creditLimit },
  )).employee;
export interface HeldEmployeeOrder {
  id: string; deliveryDate: string; grandTotal: number; itemCount: number;
  createdAt: string; employeeId: string; employeeName: string; employeeCode: string | null;
}
export const fetchHeldEmployeeOrders = async () =>
  (await get<{ data: HeldEmployeeOrder[] }>("/finance/employee-orders/held")).data;
export const releaseEmployeeOrder = async (orderId: string) =>
  post<{ orderId: string; status: string; released: boolean }>(
    `/finance/employee-orders/${orderId}/release`, {},
  );

// ── Refunds ──
export interface RefundRow {
  id: string; razorpayRefundId: string | null; razorpayPaymentId: string;
  razorpayPaymentRowId: string; amount: number; currency: string;
  status: "pending" | "processed" | "failed"; reason: string; errorDescription: string | null;
  createdAt: string; processedAt: string | null; ledgerEntryId: string | null;
  dealerId: string; dealerName: string; dealerCode: string; initiatedByName: string | null;
  voucherNo: string | null; originalPaymentAmount: number; originalPaymentKind: string;
}
export interface RefundsSummary {
  totalRefunded: number; refundCount: number; pendingAmount: number; pendingCount: number;
  failedAmount: number; failedCount: number; unlinkedCount: number;
}
export const fetchRefunds = (f?: {
  status?: "pending" | "processed" | "failed"; dealerId?: string; initiatedBy?: string;
  dateFrom?: string; dateTo?: string; search?: string; page?: number; limit?: number;
}) => get<Paginated<RefundRow>>("/finance/refunds", {
  page: f?.page ?? 1, limit: f?.limit ?? 50,
  status: f?.status, dealerId: f?.dealerId, initiatedBy: f?.initiatedBy,
  dateFrom: f?.dateFrom, dateTo: f?.dateTo, search: f?.search,
});
export const fetchRefundsSummary = async (f?: { dateFrom?: string; dateTo?: string }) =>
  (await get<{ summary: RefundsSummary }>("/finance/refunds/summary", { dateFrom: f?.dateFrom, dateTo: f?.dateTo })).summary;
export const resyncRefund = (id: string) =>
  post<{ message: string; status: string }>(`/finance/refunds/${id}/resync`, {});

// ── AR Aging ──
export type AgingBucket = "current" | "b1_30" | "b31_60" | "b61_90" | "b90_plus";
export interface ArAgingRow {
  id: string; code: string; name: string; routeName: string | null; creditLimit: number;
  currentAmount: number; b1_30: number; b31_60: number; b61_90: number; b90Plus: number;
  totalOutstanding: number; totalOverdue: number; invoiceCount: number; maxDaysOverdue: number;
  worstBucket: AgingBucket;
}
export interface ArAgingSummary {
  totalOutstanding: number; totalOverdue: number; criticalAmount: number;
  dealersWithDues: number; dealers90PlusCount: number;
  bucketCurrent: number; bucket1_30: number; bucket31_60: number; bucket61_90: number; bucket90Plus: number;
}
export interface ArInvoiceRow {
  id: string; invoiceNumber: string; invoiceDate: string; dueDate: string;
  totalAmount: number; paidAmount: number; outstanding: number; daysOverdue: number;
  paymentStatus: string; lastReceiptDate: string | null;
}
export const fetchArAging = (f?: {
  routeId?: string; bucket?: AgingBucket; search?: string; page?: number; limit?: number;
}) => get<Paginated<ArAgingRow>>("/finance/ar-aging", {
  page: f?.page ?? 1, limit: f?.limit ?? 50, routeId: f?.routeId, bucket: f?.bucket, search: f?.search,
});
export const fetchArAgingSummary = async () =>
  (await get<{ summary: ArAgingSummary }>("/finance/ar-aging/summary")).summary;
export const fetchArAgingDealer = (id: string) =>
  get<{ data: ArInvoiceRow[] }>(`/finance/ar-aging/dealers/${id}`);

// ── Dealer Statements ──
// Assembled from orders + payments + refunds + genuine ledger adjustments,
// NOT from dealer_ledger alone: 94% of receipts are pay-per-order UPI that
// never writes a ledger row. Sign convention: Cr (+) = dealer is in funds,
// Dr (−) = dealer owes the union.
export interface StatementIndexRow {
  id: string; code: string; name: string; payMode: string;
  routeName: string | null; closingBalance: number; lastPaymentAt: string | null;
  walletBalance: number; billedTotal: number; receivedTotal: number;
}
export type StatementKind = "invoice" | "payment" | "topup" | "refund" | "adjustment";
export interface StatementRow {
  id: string; voucherDate: string; voucherNo: string | null; voucherType: string | null;
  particulars: string | null; type: "credit" | "debit"; amount: number; balanceAfter: number;
  kind: StatementKind; mode: string | null; orderId: string | null;
}
export interface StatementDay {
  date: string; opening: number;
  invoiceDr: number; paymentCr: number; topupCr: number; refundDr: number;
  adjustmentDr: number; adjustmentCr: number;
  totalDr: number; totalCr: number; closing: number; count: number;
}
export interface StatementResponse {
  dealer: { id: string; code: string; name: string; payMode: string; customerType: string | null;
            gstNumber: string | null; address: string | null; city: string | null; state: string | null;
            phone: string | null; creditLimit: number; routeName: string | null };
  period: { from: string; to: string };
  wallet: { balance: number; lastTopupAt: string | null; lastTopupAmount: number | null };
  openingBalance: number;
  rows: StatementRow[];
  daily: StatementDay[];
  totals: {
    invoices: number; payments: number; topups: number; refunds: number;
    adjustmentsDr: number; adjustmentsCr: number;
    debits: number; credits: number; closingBalance: number;
  };
}
export const fetchDealerStatementIndex = (f?: { routeId?: string; search?: string; page?: number; limit?: number }) =>
  get<Paginated<StatementIndexRow>>("/finance/dealer-statements", {
    page: f?.page ?? 1, limit: f?.limit ?? 50, routeId: f?.routeId, search: f?.search,
  });
export const fetchDealerStatement = (id: string, from?: string, to?: string) =>
  get<StatementResponse>(`/finance/dealer-statements/${id}`, { from, to });
export const printDealerStatement = (
  id: string, from?: string, to?: string, view?: "daily" | "detail" | "both",
) => openPrintWindow(`/finance/dealer-statements/${id}/print`, { from, to, view });

// ── Cheques ──
export type ChequeStatus = "received" | "deposited" | "cleared" | "bounced" | "stopped" | "cancelled";
export interface ChequeRow {
  id: string; chequeNumber: string; chequeDate: string; bankName: string; branch: string | null;
  amount: number; status: ChequeStatus; receivedDate: string; depositedDate: string | null;
  depositSlipNo: string | null; depositedToBank: string | null; clearedDate: string | null;
  bouncedDate: string | null; bounceReason: string | null; bankCharges: number; ageingDays: number;
  dealerId: string; dealerCode: string; dealerName: string;
  paymentId: string; invoiceId: string | null; invoiceNumber: string | null;
}
export interface ChequesSummary {
  inHandCount: number; inHandAmount: number; inBankCount: number; inBankAmount: number;
  clearedCount: number; clearedAmount: number; bouncedCount: number; bouncedAmount: number;
  stagnantInHandCount: number;
}
export const fetchCheques = (f?: {
  status?: ChequeStatus; dealerId?: string; bankName?: string; dateFrom?: string; dateTo?: string;
  search?: string; page?: number; limit?: number;
}) => get<Paginated<ChequeRow>>("/finance/cheques", {
  page: f?.page ?? 1, limit: f?.limit ?? 50,
  status: f?.status, dealerId: f?.dealerId, bankName: f?.bankName,
  dateFrom: f?.dateFrom, dateTo: f?.dateTo, search: f?.search,
});
export const fetchChequesSummary = async (f?: { dateFrom?: string; dateTo?: string }) =>
  (await get<{ summary: ChequesSummary }>("/finance/cheques/summary", { dateFrom: f?.dateFrom, dateTo: f?.dateTo })).summary;
export const fetchCheque = (id: string) => get<{ cheque: Record<string, unknown> }>(`/finance/cheques/${id}`);
export const depositCheque = (id: string, body: { depositedDate: string; depositedToBank: string; depositSlipNo?: string }) =>
  post<{ message: string }>(`/finance/cheques/${id}/deposit`, body);
export const clearCheque = (id: string, body: { clearedDate: string }) =>
  post<{ message: string }>(`/finance/cheques/${id}/clear`, body);
export const bounceCheque = (id: string, body: { bouncedDate: string; bounceReason: string; bankCharges?: number; passChargesToDealer?: boolean }) =>
  post<{ message: string }>(`/finance/cheques/${id}/bounce`, body);
export const cancelCheque = (id: string, body: { reason: string }) =>
  post<{ message: string }>(`/finance/cheques/${id}/cancel`, body);
export const printDepositSlip = (ids?: string[]) =>
  openPrintWindow("/finance/cheques/deposit-slip", { ids: ids && ids.length ? ids.join(",") : undefined });

// ── Adjustments ──
export type AdjustmentVoucherType = "Credit Note" | "Debit Note" | "Write-off";
export interface AdjustmentRow {
  id: string; voucherType: AdjustmentVoucherType; reason: string; reasonText: string;
  attachmentUrl: string | null; createdAt: string; ledgerEntryId: string; voucherNo: string | null;
  voucherDate: string; ledgerType: "credit" | "debit"; amount: number; balanceAfter: number;
  dealerId: string; dealerCode: string; dealerName: string;
  invoiceId: string | null; invoiceNumber: string | null; initiatedByName: string | null;
  isReversed: boolean; isReversal: boolean;
}
export interface AdjustmentsSummary {
  creditNoteCount: number; creditNoteAmount: number; debitNoteCount: number; debitNoteAmount: number;
  writeOffCount: number; writeOffAmount: number; reversalCount: number;
}
export const fetchAdjustments = (f?: {
  voucherType?: AdjustmentVoucherType; reason?: string; dealerId?: string;
  dateFrom?: string; dateTo?: string; search?: string; page?: number; limit?: number;
}) => get<Paginated<AdjustmentRow>>("/finance/adjustments", {
  page: f?.page ?? 1, limit: f?.limit ?? 50,
  voucherType: f?.voucherType, reason: f?.reason, dealerId: f?.dealerId,
  dateFrom: f?.dateFrom, dateTo: f?.dateTo, search: f?.search,
});
export const fetchAdjustmentsSummary = async (f?: { dateFrom?: string; dateTo?: string }) =>
  (await get<{ summary: AdjustmentsSummary }>("/finance/adjustments/summary", { dateFrom: f?.dateFrom, dateTo: f?.dateTo })).summary;
export const createAdjustment = (body: {
  dealerId: string; voucherType: AdjustmentVoucherType; reason: string; reasonText: string;
  amount: number; voucherDate?: string; invoiceId?: string | null;
}) => post<{ message: string; voucherNo: string; balanceAfter: number }>("/finance/adjustments", body);
export const reverseAdjustment = (id: string, body: { reasonText: string }) =>
  post<{ message: string; voucherNo: string }>(`/finance/adjustments/${id}/reverse`, body);

// ── Finance Dashboard ──
export interface FinanceDashboard {
  period: { period: string; from: string; to: string };
  receivables: {
    totalOutstanding: number; totalOverdue: number; overdue90Plus: number;
    aging: { current: number; b1_30: number; b31_60: number; b61_90: number; b90Plus: number };
    dealersWithDues: number;
  };
  collections: { today: number; thisMonth: number; byMode: Record<string, number> };
  online: { pendingSettlement: number; needsReview: number; notPosted: number };
  cheques: { inHandAmount: number; inHandCount: number; inBankAmount: number; inBankCount: number; bouncedThisMonth: number };
  creditControl: { overLimitCount: number; totalExposure: number; totalAvailable: number };
  attention: Array<{ severity: "critical" | "high" | "medium"; label: string; count: number; link: string }>;
  recent: Array<{ date: string; dealerName: string; voucherType: string | null; type: string; amount: number; voucherNo: string | null }>;
}
export const fetchFinanceDashboard = (f?: { period?: string; from?: string; to?: string }) =>
  get<FinanceDashboard>("/finance/dashboard", { period: f?.period, from: f?.from, to: f?.to });

// ── Day Book ──
export type DayBookKind = "receipt" | "sale" | "refund" | "adjustment";
export interface DayBookLine {
  id: string; at: string; kind: DayBookKind;
  // Did real money enter/leave the union's cash & bank? Wallet movements
  // (credit-backs on modify/cancel, extra debits) are 'none' — the dealer's
  // wallet is a liability, so nothing left the till. Only receipts are 'in'
  // and only gateway refunds to a bank account are 'out'.
  cashImpact: "in" | "out" | "none";
  // topup | topup_ledger | order_payment | invoice_payment | on_account |
  // order_sale | counter_sale | refund | modify_refund | modify_debit |
  // cancel_refund | adjustment_credit | adjustment_debit
  type: string;
  mode: string | null; amount: number;
  reference: string | null; docNo: string | null;
  dealerCode: string | null; dealerName: string | null;
  routeId: string | null; routeName: string | null;
  byName: string | null;
}
export interface DayBook {
  date: string;
  routeId: string | null;
  lines: DayBookLine[];
  routeWise: Array<{
    id: string | null; name: string | null;
    receipts: number; collected: number; cash: number;
    orders: number; sales: number;
  }>;
  summary: {
    totalReceipts: number;
    byMode: Record<string, number>;
    byType: Record<string, number>;
    cashCollected: number;
    /** Bank refunds only — wallet credit-backs are under orderChanges. */
    refundsOut: number; refundsCount: number;
    net: number;
    sales: {
      total: number;
      ordersTotal: number; ordersCount: number;
      counterTotal: number; counterCount: number;
      byMode: Record<string, number>;
    };
    ledgerTopups: { count: number; total: number };
    orderChanges: {
      refundsToBalance: number; refundsCount: number;
      extraDebits: number; debitsCount: number;
      /** refundsToBalance − extraDebits; net movement of wallet liability. */
      netToWallet: number;
    };
    adjustments: { count: number; creditTotal: number; debitTotal: number };
  };
}
export const fetchDayBook = (date?: string, routeId?: string | null) =>
  get<DayBook>("/finance/day-book", { date, routeId: routeId ?? undefined });
