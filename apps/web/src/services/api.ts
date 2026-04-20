// ══════════════════════════════════════════════════════════════════
// API Service — Phase 3: Real fetch calls to Fastify backend.
// Same function signatures as the mock version — pages need NO changes.
// ══════════════════════════════════════════════════════════════════
import { get, post, patch, del } from "@/lib/apiClient";
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
  CancellationRequest,
  TimeWindow,
  NotificationSetting,
  Banner,
  SystemUser,
} from "@/data/mockData";

// ── Normalizers: map snake_case API → camelCase UI ──
function normalizeCustomer(d: Record<string, unknown>) {
  const code = (d.code ?? "") as string;
  const routes = ((d.routes as Record<string, unknown>[]) ?? []).map((r) => ({
    routeId: (r.routeId ?? r.route_id) as string,
    routeCode: (r.routeCode ?? r.route_code) as string,
    routeName: (r.routeName ?? r.route_name) as string,
    isPrimary: Boolean(r.isPrimary ?? r.is_primary ?? false),
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
    lastIndentAt: (d.last_indent_at ?? d.lastIndentAt ?? null) as string | null,

    city:    (d.city ?? "") as string,
    address: (d.address ?? "") as string,
    bank:    d.bank as string | undefined,
    creditBalance: parseFloat(
      String(d.wallet_balance ?? d.credit_balance ?? d.creditBalance ?? 0)
    ),
    status:
      d.active !== false && d.active !== null
        ? ("Active" as const)
        : ("Inactive" as const),
  };
}

function normalizeContractor(d: Record<string, unknown>) {
  const assignedRoutes = ((d.assignedRoutes as Record<string, unknown>[]) ?? []).map(
    (r) => (r.id ?? r.route_id) as string
  );
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

function normalizeRoute(d: Record<string, unknown>) {
  return {
    id:             d.id as string,
    code:           (d.code ?? "") as string,
    name:           (d.name ?? "") as string,
    taluka:         (d.zone_name ?? d.taluka ?? "") as string,
    zoneId:         (d.zone_id ?? d.zoneId ?? "") as string,
    contractorId:   (d.contractor_id ?? d.contractorId ?? "") as string,
    contractorName: (d.contractor_name ?? "") as string,
    dealerCount:    parseInt(String(d.dealer_count ?? 0)),
    dispatchTime:   (d.dispatch_time ?? d.dispatchTime ?? "") as string,

    // v1.4
    primaryBatchId: (d.primary_batch_id ?? d.primaryBatchId ?? null) as string | null,

    status: d.active !== false ? ("Active" as const) : ("Inactive" as const),
  };
}

function normalizeBatch(d: Record<string, unknown>) {
  return {
    id:           d.id as string,
    batchCode:    (d.batch_number ?? d.batch_code ?? d.batchCode ?? "") as string,
    whichBatch:   (d.which_batch ?? d.whichBatch ?? d.name ?? "") as string,
    timing:       (d.timing ?? "") as string,
    dispatchTime: (d.dispatch_time ?? d.dispatchTime ?? "") as string, // v1.4
    routeIds:     (d.route_ids ?? d.routeIds ?? []) as string[],
    status:
      d.status === "active" || d.active !== false
        ? ("Active" as const)
        : ("Inactive" as const),
  };
}

function normalizeProduct(d: Record<string, unknown> | null | undefined) {
  if (!d) {
    return {
      id: "",
      code: "",
      name: "",
      reportAlias: "",
      category: "",
      packSize: 0,
      unit: "pcs",
      mrp: 0,
      gstPercent: 0,
      hsnNo: "",
      stock: 0,
      sortOrder: 0,
      printDirection: "Across" as const,
      packetsCrate: 0,
      status: "Inactive" as const,
      terminated: false,
      rateCategories: {} as Record<string, number>,
    };
  }
  const mrp =
    parseFloat(
      String(
        d.basePrice ?? d.base_price ?? d.mrp ?? 0, // ← reads camelCase first (Issue #4, #6)
      ),
    ) || 0;

  // Issue #6: each rate category defaults to MRP if backend didn't send a per-category override.
  const rd =
    parseFloat(String(d.retailDealerPrice ?? d.retail_dealer_price ?? mrp)) ||
    mrp;
  const cm =
    parseFloat(
      String(d.creditInstMrpPrice ?? d.credit_inst_mrp_price ?? mrp),
    ) || mrp;
  const cd =
    parseFloat(
      String(d.creditInstDealerPrice ?? d.credit_inst_dealer_price ?? mrp),
    ) || mrp;
  const pd =
    parseFloat(String(d.parlourDealerPrice ?? d.parlour_dealer_price ?? mrp)) ||
    mrp;

  return {
    id: (d.id ?? "") as string,
    code: (d.code ?? "") as string,
    name: (d.name ?? "") as string,
    reportAlias: (d.reportAlias ?? d.report_alias ?? d.name ?? "") as string,
    category: (d.categoryName ?? d.category_name ?? d.category ?? "") as string, // ← Issue #4
    packSize: parseFloat(String(d.packSize ?? d.pack_size ?? 0)) || 0,
    unit: (d.unit ?? "pcs") as string,
    mrp,
    gstPercent: parseFloat(String(d.gstPercent ?? d.gst_percent ?? 0)) || 0,
    hsnNo: (d.hsnNo ?? d.hsn_no ?? "") as string,
    stock: Number(d.stock ?? 0),
    sortOrder: Number(d.sortOrder ?? d.sort_order ?? 0),
    printDirection: (d.printDirection ?? d.print_direction ?? "Across") as
      | "Across"
      | "Down",
    packetsCrate: Number(d.packetsCrate ?? d.packets_crate ?? 0),
    status: d.available !== false ? ("Active" as const) : ("Inactive" as const),
    terminated: Boolean(d.terminated ?? false),
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

  const rawDate = d.created_at ?? d.date ?? "";
  const formattedDate = rawDate
    ? (() => {
        const dt = new Date(String(rawDate));
        if (isNaN(dt.getTime())) return String(rawDate).split("T")[0];
        return `${String(dt.getDate()).padStart(2, "0")}/${String(dt.getMonth() + 1).padStart(2, "0")}/${dt.getFullYear()}`;
      })()
    : "";

  const rawStatus = String(d.status ?? "pending").toLowerCase();
  const statusMap: Record<
    string,
    "Pending" | "Posted" | "Dispatched" | "Cancelled"
  > = {
    pending: "Pending",
    confirmed: "Posted",
    dispatched: "Dispatched",
    delivered: "Dispatched",
    cancelled: "Cancelled",
  };

  return {
    id: rawId,
    indentNo: formattedId,
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
    status: statusMap[rawStatus] ?? "Pending",
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
  return {
    id: rawId,
    gpNo: (d.gp_no ??
      d.gpNo ??
      (rawId ? `GP-${rawId.slice(-4).toUpperCase()}` : "")) as string, // Issue #12
    customerId: (d.customer_id ?? d.customerId) as string,
    customerName: (d.customer_name ?? d.customerName ?? "") as string,
    type: (d.customer_type === "cash" ? "cash" : "agent") as "agent" | "cash",
    routeId: (d.route_id ?? d.routeId ?? "") as string, // Issue #12
    routeCode: (d.route_code ?? d.routeCode ?? "") as string,
    routeName: (d.route_name ?? d.routeName ?? "") as string,
    date: String(d.sale_date ?? d.date ?? "").split("T")[0],
    items,
    total: parseFloat(String(d.grand_total ?? d.total ?? 0)),
    payMode: (d.payment_mode === "credit" ? "Credit" : "Cash") as
      | "Cash"
      | "Credit",
  };
}

function normalizeCancellation(d: Record<string, unknown>) {
  const rawId = (d.id ?? "") as string;
  const rawOrderId = (d.order_id ?? d.indentId ?? "") as string;
  const cancellationId = rawId ? `#CR-${rawId.slice(-4).toUpperCase()}` : "";
  const indentId = rawOrderId
    ? `#HMU-${rawOrderId.slice(-4).toUpperCase()}`
    : "";

  const rawTime = d.created_at ?? d.requestTime ?? "";
  const formattedTime = rawTime
    ? (() => {
        const dt = new Date(String(rawTime));
        if (isNaN(dt.getTime())) return String(rawTime);
        const dd = String(dt.getDate()).padStart(2, "0");
        const mm = String(dt.getMonth() + 1).padStart(2, "0");
        const yyyy = dt.getFullYear();
        let hours = dt.getHours();
        const mins = String(dt.getMinutes()).padStart(2, "0");
        const ampm = hours >= 12 ? "PM" : "AM";
        hours = hours % 12 || 12;
        return `${dd}/${mm}/${yyyy} ${String(hours).padStart(2, "0")}:${mins} ${ampm}`;
      })()
    : "";

  const items = ((d.items as Record<string, unknown>[]) ?? []).map((i) => ({
    productId: (i.product_id ?? i.productId ?? "") as string,
    productName: (i.product_name ?? i.productName ?? "") as string,
    quantity: Number(i.quantity ?? 0),
    unitPrice: parseFloat(String(i.unit_price ?? 0)) || 0,
    lineTotal: parseFloat(String(i.line_total ?? 0)) || 0,
    icon: (i.icon ?? "📦") as string,
    unit: (i.unit ?? "") as string,
  }));

  const rawStatus = String(d.status ?? "pending").toLowerCase();
  const statusMap: Record<string, "Pending" | "Approved" | "Rejected"> = {
    pending: "Pending",
    approved: "Approved",
    rejected: "Rejected",
  };

  const reasonText = String(d.reason ?? "").toLowerCase();
  const type: "Cancel" | "Modify" =
    reasonText.includes("modif") ||
    reasonText.includes("reduce") ||
    reasonText.includes("change")
      ? "Modify"
      : "Cancel";

  return {
    id: rawId,
    cancellationId,
    indentId,
    orderId: rawOrderId,
    customerId: (d.dealer_id ?? d.customerId ?? "") as string,
    customerName: (d.dealer_name ?? d.customer_name ?? "") as string,
    agentCode: (d.agent_code ?? d.agentCode ?? "") as string,
    routeId: (d.route_id ?? d.routeId ?? "") as string,
    routeCode: (d.route_code ?? d.routeCode ?? "") as string,
    routeName: (d.route_name ?? d.routeName ?? "") as string, // Issue #13
    items,
    totalAmount: parseFloat(String(d.grand_total ?? d.totalAmount ?? 0)) || 0,
    requestTime: formattedTime,
    rawRequestTime: String(rawTime),
    type,
    reason: (d.reason ?? "") as string,
    status: statusMap[rawStatus] ?? "Pending",
    rejectionReason: (d.review_note ?? d.rejectionReason ?? "") as string,
  };
}

function mapCancellationStatus(s: string): "Pending" | "Approved" | "Rejected" {
  if (s === "approved") return "Approved";
  if (s === "rejected") return "Rejected";
  return "Pending";
}

// ══════════════════════════════════════
// CUSTOMERS (= Dealers in the API)
// ══════════════════════════════════════
export const fetchCustomers = async () => {
  const data = await get<{ data: Record<string, unknown>[] }>("/dealers", {
    limit: 100,
    page: 1,
  });
  return (data.data ?? []).map(normalizeCustomer);
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
    creditLimit: body.creditLimit,
    addressType: body.addressType || undefined,
    state: body.state || undefined,
    city: body.city || undefined,
    area: body.area || undefined,
    houseNo: body.houseNo || undefined,
    street: body.street || undefined,
    address: body.address || undefined,
    code: body.code,
    active: body.active !== false,
    ...(body.zoneId ? { zoneId: body.zoneId } : {}),
    ...(body.routeId ? { routeId: body.routeId } : {}),
  });
  return normalizeCustomer(data.dealer);
};

// ── NEW ──
export const updateCustomer = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ dealer: Record<string, unknown> }>(`/dealers/${id}`, {
    name: body.name,
    phone: body.phone,
    email: body.email || null,
    customerType: body.type,
    rateCategory: body.rateCategory,
    payMode: body.payMode,
    officerName: body.officerName || null,
    bank: body.bank || null,
    accountNo: body.accountNo || null,
    creditLimit: body.creditLimit,
    addressType: body.addressType || null,
    state: body.state || null,
    city: body.city || null,
    area: body.area || null,
    houseNo: body.houseNo || null,
    street: body.street || null,
    address: body.address || null,
    active: body.active !== false,
    ...(body.zoneId ? { zoneId: body.zoneId } : {}),
    ...(body.routeId ? { routeId: body.routeId } : {}),
  });
  return normalizeCustomer(data.dealer);
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
    ratePerKm: body.ratePerKm,
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
    routeIds: body.routeIds ?? [],
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
    ratePerKm: body.ratePerKm,
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
    routeIds: body.routeIds ?? [],
    active: body.active !== false,
  });
  return normalizeContractor(data.contractor);
};

export const deleteContractor = async (id: string) => {
  await del(`/contractors/${id}`);
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
    }));
  }
  return [];
};

export const createRoute = async (body: Record<string, unknown>) => {
  const data = await post<{ route: Record<string, unknown> }>("/routes", {
    name: body.name,
    code: body.code,
    zoneId: body.zoneId,
    contractorId: body.contractorId || undefined,
    primaryBatchId: body.primaryBatchId || undefined,
    active: body.active !== false,
    stopDetails: [],
  });
  return normalizeRoute(data.route);
};

// ── NEW ──
export const updateRoute = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ route: Record<string, unknown> }>(`/routes/${id}`, {
    name: body.name,
    zoneId: body.zoneId,
    contractorId: body.contractorId || null,
    primaryBatchId: body.primaryBatchId || null,
    active: body.active !== false,
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
    dispatchTime: body.dispatchTime || null,
    routeIds: body.routeIds ?? [],
  });
  return normalizeBatch(data.batch);
};

// ── NEW ──
export const updateBatch = async (id: string, body: Record<string, unknown>) => {
  const data = await patch<{ batch: Record<string, unknown> }>(`/batches/${id}`, {
    whichBatch: body.whichBatch,
    timing: body.timing ?? null,
    dispatchTime: body.dispatchTime || null,
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
  return (data.products ?? []).map(normalizeProduct);
};

export const createProduct = async (body: Record<string, unknown>) => {
  const data = await post<{ product: Record<string, unknown> }>("/products", {
    name: body.name,
    categoryId: body.categoryId || body.category,
    icon: body.icon,
    unit: body.unit,
    basePrice: String(body.mrp ?? body.basePrice ?? 0),
    gstPercent: String(body.gstPercent ?? 0),
    stock: 0,
    available: true,

    // Issue #5 — pass through everything the form collects
    code: body.code || undefined,
    hsnNo: body.hsnNo || undefined,
    packSize: body.packSize !== undefined ? Number(body.packSize) : undefined,
    printDirection: body.printDirection || undefined, // "Across" | "Down" — preserves Down
    packetsCrate:
      body.packetsCrate !== undefined ? Number(body.packetsCrate) : undefined,
    reportAlias: body.reportAlias || body.name || undefined,
  });
  return normalizeProduct(data.product);
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
}) => {
  const params: Record<string, string | number | boolean | undefined> = { limit: 100, page: 1 };
  if (filters?.status) params.status = filters.status.toLowerCase();
  if (filters?.routeId) params.routeId = filters.routeId;
  if (filters?.batchId) params.batchId = filters.batchId;
  if (filters?.date) params.date = filters.date; // YYYY-MM-DD
  if (filters?.dealerId) params.dealerId = filters.dealerId;
  const data = await get<{ data: Record<string, unknown>[] }>(
    "/orders",
    params,
  );
  return (data.data ?? []).map(normalizeIndent);
};

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

export const createIndent = async (body: Record<string, unknown>) => {
  const items =
    (body.items as { productId: string; qty: number; rate: number }[]) ?? [];
  const data = await post<{ order: Record<string, unknown> }>(
    "/orders/admin-place",
    {
      dealerId: body.customerId,
      paymentMode: body.payMode === "Cash" ? "wallet" : "credit",
      notes: body.agentCode ? `Agent: ${body.agentCode}` : undefined,
      items: items.map((i) => ({ productId: i.productId, quantity: i.qty })),
    },
  );
  return normalizeIndent(data.order); // backend now returns the full order shape
};

export const cancelIndent = async (id: string, reason: string) => {
  await post(`/orders/${id}/cancel`, { reason });
};

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

// ══════════════════════════════════════
// CANCELLATION REQUESTS
// ══════════════════════════════════════
export const fetchCancellationRequests = async () => {
  const data = await get<{ data: Record<string, unknown>[] }>("/cancellations");
  return (data.data ?? []).map(normalizeCancellation);
};

export const approveCancellation = async (id: string) => {
  await patch(`/cancellations/${id}/approve`);
};

export const rejectCancellation = async (id: string, reason: string) => {
  await patch(`/cancellations/${id}/reject`, { reason });
};

// ══════════════════════════════════════
// FGS STOCK
// ══════════════════════════════════════

// Accepts an array of entries — matches backend Zod schema { date, entries: [...] }
export const updateStockEntries = async (
  date: string,
  entries: Array<{
    productId: string;
    opening: number;
    received: number;
    dispatched: number;
    wastage: number;
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

export const fetchStockEntries = async (date?: string) => {
  const params = date ? { date } : undefined;
  const data = await get<{ products: Record<string, unknown>[] }>(
    "/fgs/overview",
    params,
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
  const data = await get<{ windows: Record<string, unknown>[] }>(
    "/time-windows",
  );
  return (data.windows ?? []).map((w) => ({
    id: w.id as string,
    zoneName: (w.zone_name ?? w.zoneName ?? "") as string,
    openTime: (w.open_time ?? w.openTime ?? "06:00") as string,
    warningTime: (w.warning_time ?? w.warningTime ?? "07:45") as string,
    closeTime: (w.close_time ?? w.closeTime ?? "08:00") as string,
    active: w.active !== false,
  }));
};

export const updateTimeWindow = async (
  id: string,
  body: Record<string, unknown>,
) => {
  await patch(`/time-windows/${id}`, body);
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
// STATIC HELPERS
// ══════════════════════════════════════
export const getOfficers = () => [
  { id: "o1", name: "Ravi Kumar" },
  { id: "o2", name: "Suresh Patil" },
  { id: "o3", name: "Mohan Reddy" },
];
