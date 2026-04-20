// ══════════════════════════════════════════════════════════════════
// Mock Data — drives all UI pages before API wiring (Phase 3)
// ══════════════════════════════════════════════════════════════════

export interface Customer {
  id: string;
  code: string;
  name: string;
  type: string;
  routeId?: string;
  routeCode?: string;
  routeName?: string;
  routes?: Array<{ routeId: string; routeCode: string; routeName: string; isPrimary: boolean }>;
  rateCategory: string;
  payMode: "Cash" | "Credit";
  officerName?: string;
  phone: string;
  email?: string;            // Marketing v1.4
  accountNo?: string;        // Marketing v1.4
  creditLimit?: number;      // Marketing v1.4
  addressType?: "Office" | "Residence" | "";  // Marketing v1.4
  state?: string;            // Marketing v1.4
  zoneId?: string;           // was present via zoneId on create; now also on read
  zoneName?: string;         // Marketing v1.4 (for display in detail view)
  city?: string;
  address?: string;
  area?: string;             // Marketing v1.4
  houseNo?: string;          // Marketing v1.4
  street?: string;           // Marketing v1.4
  bank?: string;
  creditBalance?: number;    // wallet balance (kept as-is)
  lastIndentAt?: string | null;  // Marketing v1.4
  status: "Active" | "Inactive";
}

// Extend Contractor
export interface Contractor {
  id: string;
  code: string;
  name: string;
  phone: string;
  email?: string;              // v1.4
  licenseNumber: string;
  address: string;
  vehicleNumber: string;
  routeIds: string[];
  status: "Active" | "Inactive";
  // v1.4 additions
  bankName?: string;
  accountNo?: string;
  ratePerKm?: number;
  periodFrom?: string | null;  // ISO date
  periodTo?: string | null;    // ISO date
  addressType?: "Office" | "Residence" | "";
  state?: string;
  city?: string;
  area?: string;
  houseNo?: string;
  street?: string;
}

// Extend Route
export interface Route {
  id: string;
  code: string;
  name: string;
  taluka: string;
  zoneId?: string;
  contractorId?: string;
  contractorName?: string;
  dealerCount?: number;
  dispatchTime: string;          // resolved: batch's if set, else route's own
  primaryBatchId?: string | null;   // v1.4
  status: "Active" | "Inactive";
}

// Extend Batch
export interface Batch {
  id: string;
  batchCode: string;
  whichBatch: string;
  timing: string;
  dispatchTime?: string;           // v1.4 — HH:MM
  routeIds: string[];
  status: "Active" | "Inactive";
}

export interface Product {
  id: string;
  code: string;
  name: string;
  reportAlias: string;
  category: string;
  packSize: number;
  unit: string;
  mrp: number;
  gstPercent: number;
  hsnNo: string;
  stock: number;
  sortOrder: number;
  printDirection: "Across" | "Down";
  packetsCrate: number;
  status: "Active" | "Inactive";
  terminated?: boolean;
  rateCategories: Record<string, number>;
}

export interface PriceChartEntry {
  productId: string;
  mrp: number;
  "Retail-Dealer": number;
  "Credit Inst-MRP": number;
  "Credit Inst-Dealer": number;
  "Parlour-Dealer": number;
}

export interface IndentItem {
  productId: string;
  productName: string;
  qty: number;
  rate: number;
  quantity?: number; // alias
}

export interface Indent {
  id: string;
  indentNo: string;
  customerId: string;
  customerName: string;
  routeId: string;
  batchId: string;
  date: string;
  agentCode?: string;
  status: "Pending" | "Posted" | "Dispatched" | "Cancelled";
  items: IndentItem[];
  total: number;
  totalAmount?: number;
  gstAmount?: number;
}

export interface StockEntry {
  id: string;
  productId: string;
  productName: string;
  category: string;
  date: string;
  opening: number;
  received: number;
  dispatched: number;
  wastage: number;
  closing: number;
  type?: string;
  quantity?: number;
  batchRef?: string;
  notes?: string;
  modifiedBy?: string;
}

export interface DirectSale {
  id: string;
  gpNo: string;
  customerId: string;
  customerName: string;
  type: "agent" | "cash";
  routeId: string;
  date: string;
  items: { productId: string; productName: string; qty: number; rate: number }[];
  total: number;
  payMode: "Cash" | "Credit";
}

export interface CancellationRequest {
  id: string;
  indentId: string;
  customerId: string;
  agentCode: string;
  routeId: string;
  items: { productId: string; quantity: number }[];
  totalAmount: number;
  requestTime: string;
  type: "Cancel" | "Modify";
  reason: string;
  status: "Pending" | "Approved" | "Rejected";
  rejectionReason: string;
}

export interface TimeWindow {
  id: string;
  zoneName: string;
  openTime: string;
  warningTime: string;
  closeTime: string;
  active: boolean;
}

export interface NotificationSetting {
  id: string;
  type: string;
  description: string;
  sendToAdmin: boolean;
  sendToDealer: boolean;
  sendToContractor: boolean;
  enabled: boolean;
}

export interface Banner {
  id: string;
  title: string;
  category: string;
  imageUrl: string;
  linkUrl: string;
  status: "Active" | "Inactive";
  startDate: string;
  endDate: string;
}

export interface SystemUser {
  id: string;
  name: string;
  email: string;
  role: string;
  zone: string;
  status: "Active" | "Inactive";
  lastLogin: string;
}

// ── Seed Data ──

export const contractors: Contractor[] = [
  { id: "ct1", code: "C01", name: "Karnataka Transport Co.", phone: "9845001234", licenseNumber: "KA-TRP-2021-001", address: "Haveri Bus Stand, Haveri", vehicleNumber: "KA-27-T-1001", routeIds: ["r1", "r2"], status: "Active" },
  { id: "ct2", code: "C02", name: "Sree Logistics", phone: "9845002345", licenseNumber: "KA-TRP-2021-002", address: "Ranebennur Main Road", vehicleNumber: "KA-27-T-1002", routeIds: ["r3", "r4"], status: "Active" },
  { id: "ct3", code: "C03", name: "Raghavendra Transports", phone: "9845003456", licenseNumber: "KA-TRP-2020-003", address: "Savanur Town", vehicleNumber: "KA-27-T-1003", routeIds: ["r5"], status: "Active" },
];

export const routes: Route[] = [
  { id: "r1", code: "RT01", name: "Haveri City Route 1", taluka: "Haveri", contractorId: "ct1", dispatchTime: "5:30 AM", status: "Active" },
  { id: "r2", code: "RT02", name: "Haveri City Route 2", taluka: "Haveri", contractorId: "ct1", dispatchTime: "5:30 AM", status: "Active" },
  { id: "r3", code: "RT03", name: "Ranebennur Route", taluka: "Ranebennur", contractorId: "ct2", dispatchTime: "6:00 AM", status: "Active" },
  { id: "r4", code: "RT04", name: "Byadgi Route", taluka: "Byadgi", contractorId: "ct2", dispatchTime: "6:30 AM", status: "Active" },
  { id: "r5", code: "RT05", name: "Savanur Route", taluka: "Savanur", contractorId: "ct3", dispatchTime: "6:00 AM", status: "Active" },
  { id: "r6", code: "RT06", name: "Hirekerur Route", taluka: "Hirekerur", contractorId: "ct3", dispatchTime: "7:00 AM", status: "Inactive" },
];

export const batches: Batch[] = [
  { id: "bt1", batchCode: "BT01", whichBatch: "Morning", timing: "5:00 AM - 8:00 AM", routeIds: ["r1", "r2", "r3", "r4"], status: "Active" },
  { id: "bt2", batchCode: "BT02", whichBatch: "Afternoon", timing: "12:00 PM - 2:00 PM", routeIds: ["r2", "r5"], status: "Active" },
];

export const customers: Customer[] = [
  { id: "c1", code: "A1", name: "Arun Dairy", type: "Retail-Dealer", routeId: "r1", rateCategory: "Retail-Dealer", payMode: "Cash", phone: "9876543210", city: "Haveri", address: "MG Road, Haveri", creditBalance: 0, status: "Active" },
  { id: "c2", code: "A2", name: "Asha Medical", type: "Credit Inst-MRP", routeId: "r1", rateCategory: "Credit Inst-MRP", payMode: "Credit", phone: "9876543211", city: "Haveri", address: "Hospital Road, Haveri", creditBalance: 12500, status: "Active" },
  { id: "c3", code: "A3", name: "Anand Hotel", type: "Credit Inst-Dealer", routeId: "r2", rateCategory: "Credit Inst-Dealer", payMode: "Credit", phone: "9876543212", city: "Haveri", address: "Station Road, Haveri", creditBalance: 8200, status: "Active" },
  { id: "c4", code: "A4", name: "Amrut Parlour", type: "Parlour-Dealer", routeId: "r2", rateCategory: "Parlour-Dealer", payMode: "Cash", phone: "9876543213", city: "Haveri", address: "MG Road Parlour, Haveri", creditBalance: 0, status: "Active" },
  { id: "c5", code: "A5", name: "Akshaya Stores", type: "Retail-Dealer", routeId: "r3", rateCategory: "Retail-Dealer", payMode: "Cash", phone: "9876543214", city: "Ranebennur", address: "Main Road, Ranebennur", creditBalance: 0, status: "Active" },
  { id: "c6", code: "A6", name: "Anjali Parlour", type: "Parlour-Dealer", routeId: "r1", rateCategory: "Parlour-Dealer", payMode: "Cash", phone: "9876543215", city: "Haveri", address: "Bus Stand, Haveri", creditBalance: 0, status: "Active" },
  { id: "c7", code: "A7", name: "Aadarsh School", type: "Credit Inst-MRP", routeId: "r4", rateCategory: "Credit Inst-MRP", payMode: "Credit", phone: "9876543216", city: "Byadgi", address: "School Road, Byadgi", creditBalance: 5600, status: "Inactive" },
  { id: "c8", code: "A8", name: "Arjun Fresh Dairy", type: "Retail-Dealer", routeId: "r5", rateCategory: "Retail-Dealer", payMode: "Cash", phone: "9876543217", city: "Savanur", address: "Market Road, Savanur", creditBalance: 0, status: "Active" },
  { id: "c9", code: "B1", name: "Basaveshwar Dairy", type: "Retail-Dealer", routeId: "r1", rateCategory: "Retail-Dealer", payMode: "Cash", phone: "9845100001", city: "Haveri", address: "Circle, Haveri", creditBalance: 0, status: "Active" },
  { id: "c10", code: "B2", name: "Bharat Hotel", type: "Credit Inst-Dealer", routeId: "r2", rateCategory: "Credit Inst-Dealer", payMode: "Credit", phone: "9845100002", city: "Haveri", address: "Market, Haveri", creditBalance: 3200, status: "Active" },
];

export const products: Product[] = [
  { id: "p1", code: "001", name: "Nandini Toned Milk 500ml", reportAlias: "TM 500", category: "Milk", packSize: 0.5, unit: "ltr", mrp: 24, gstPercent: 0, hsnNo: "0401", stock: 330, sortOrder: 1, printDirection: "Across", packetsCrate: 30, status: "Active", terminated: false, rateCategories: { "Retail-Dealer": 22.5, "Credit Inst-MRP": 24, "Credit Inst-Dealer": 22.5, "Parlour-Dealer": 22 } },
  { id: "p2", code: "002", name: "Nandini Full Cream Milk 500ml", reportAlias: "FCM 500", category: "Milk", packSize: 0.5, unit: "ltr", mrp: 30, gstPercent: 0, hsnNo: "0401", stock: 210, sortOrder: 2, printDirection: "Across", packetsCrate: 30, status: "Active", terminated: false, rateCategories: { "Retail-Dealer": 28, "Credit Inst-MRP": 30, "Credit Inst-Dealer": 28, "Parlour-Dealer": 27.5 } },
  { id: "p3", code: "003", name: "Nandini Curd 500ml", reportAlias: "Curd 500", category: "Curd", packSize: 0.5, unit: "kg", mrp: 30, gstPercent: 5, hsnNo: "0403", stock: 140, sortOrder: 3, printDirection: "Across", packetsCrate: 24, status: "Active", terminated: false, rateCategories: { "Retail-Dealer": 28, "Credit Inst-MRP": 30, "Credit Inst-Dealer": 28, "Parlour-Dealer": 27 } },
  { id: "p4", code: "004", name: "Nandini Buttermilk 200ml", reportAlias: "BM 200", category: "Buttermilk", packSize: 0.2, unit: "ltr", mrp: 10, gstPercent: 12, hsnNo: "0403", stock: 400, sortOrder: 4, printDirection: "Across", packetsCrate: 48, status: "Active", terminated: false, rateCategories: { "Retail-Dealer": 9, "Credit Inst-MRP": 10, "Credit Inst-Dealer": 9, "Parlour-Dealer": 8.5 } },
  { id: "p5", code: "005", name: "Nandini Lassi 200ml", reportAlias: "Lassi 200", category: "Lassi", packSize: 0.2, unit: "ltr", mrp: 15, gstPercent: 12, hsnNo: "0403", stock: 250, sortOrder: 5, printDirection: "Down", packetsCrate: 48, status: "Active", terminated: false, rateCategories: { "Retail-Dealer": 13.5, "Credit Inst-MRP": 15, "Credit Inst-Dealer": 13.5, "Parlour-Dealer": 13 } },
  { id: "p6", code: "006", name: "Nandini Ghee 500ml", reportAlias: "Ghee 500", category: "Ghee", packSize: 0.5, unit: "ltr", mrp: 275, gstPercent: 12, hsnNo: "0405", stock: 45, sortOrder: 6, printDirection: "Down", packetsCrate: 12, status: "Active", terminated: false, rateCategories: { "Retail-Dealer": 260, "Credit Inst-MRP": 275, "Credit Inst-Dealer": 260, "Parlour-Dealer": 255 } },
  { id: "p7", code: "007", name: "Nandini Peda 250g", reportAlias: "Peda 250", category: "Sweets", packSize: 0.25, unit: "kg", mrp: 120, gstPercent: 5, hsnNo: "1704", stock: 0, sortOrder: 7, printDirection: "Down", packetsCrate: 20, status: "Active", terminated: false, rateCategories: { "Retail-Dealer": 112, "Credit Inst-MRP": 120, "Credit Inst-Dealer": 112, "Parlour-Dealer": 110 } },
  { id: "p8", code: "008", name: "Nandini Paneer 200g", reportAlias: "Paneer 200", category: "Paneer", packSize: 0.2, unit: "kg", mrp: 90, gstPercent: 5, hsnNo: "0406", stock: 30, sortOrder: 8, printDirection: "Down", packetsCrate: 24, status: "Active", terminated: false, rateCategories: { "Retail-Dealer": 84, "Credit Inst-MRP": 90, "Credit Inst-Dealer": 84, "Parlour-Dealer": 82 } },
];

export const priceChart: PriceChartEntry[] = products.map(p => ({
  productId: p.id,
  mrp: p.mrp,
  "Retail-Dealer": p.rateCategories["Retail-Dealer"],
  "Credit Inst-MRP": p.rateCategories["Credit Inst-MRP"],
  "Credit Inst-Dealer": p.rateCategories["Credit Inst-Dealer"],
  "Parlour-Dealer": p.rateCategories["Parlour-Dealer"],
}));

export const indents: Indent[] = [
  { id: "IND001", indentNo: "IND-2026-001", customerId: "c1", customerName: "Arun Dairy", routeId: "r1", batchId: "bt1", date: "2026-04-13", agentCode: "A1", status: "Posted", items: [{ productId: "p1", productName: "TM 500", qty: 50, rate: 22.5, quantity: 50 }, { productId: "p2", productName: "FCM 500", qty: 20, rate: 28, quantity: 20 }, { productId: "p3", productName: "Curd 500", qty: 10, rate: 28, quantity: 10 }], total: 1965, totalAmount: 1965, gstAmount: 14 },
  { id: "IND002", indentNo: "IND-2026-002", customerId: "c2", customerName: "Asha Medical", routeId: "r1", batchId: "bt1", date: "2026-04-13", agentCode: "A2", status: "Posted", items: [{ productId: "p1", productName: "TM 500", qty: 100, rate: 24, quantity: 100 }, { productId: "p3", productName: "Curd 500", qty: 20, rate: 30, quantity: 20 }], total: 3000, totalAmount: 3000, gstAmount: 30 },
  { id: "IND003", indentNo: "IND-2026-003", customerId: "c3", customerName: "Anand Hotel", routeId: "r2", batchId: "bt1", date: "2026-04-13", agentCode: "A3", status: "Pending", items: [{ productId: "p2", productName: "FCM 500", qty: 30, rate: 28, quantity: 30 }, { productId: "p5", productName: "Lassi 200", qty: 24, rate: 13.5, quantity: 24 }], total: 1164, totalAmount: 1164, gstAmount: 39 },
  { id: "IND004", indentNo: "IND-2026-004", customerId: "c5", customerName: "Akshaya Stores", routeId: "r3", batchId: "bt1", date: "2026-04-12", agentCode: "A5", status: "Dispatched", items: [{ productId: "p1", productName: "TM 500", qty: 40, rate: 22.5, quantity: 40 }, { productId: "p4", productName: "BM 200", qty: 30, rate: 9, quantity: 30 }], total: 1170, totalAmount: 1170, gstAmount: 32 },
  { id: "IND005", indentNo: "IND-2026-005", customerId: "c8", customerName: "Arjun Fresh Dairy", routeId: "r5", batchId: "bt1", date: "2026-04-12", agentCode: "A8", status: "Cancelled", items: [{ productId: "p1", productName: "TM 500", qty: 25, rate: 22.5, quantity: 25 }], total: 562.5, totalAmount: 562.5, gstAmount: 0 },
];

export const stockEntries: StockEntry[] = [
  { id: "s1", productId: "p1", productName: "Nandini Toned Milk 500ml", category: "Milk", date: "2026-04-13", opening: 0, received: 980, dispatched: 620, wastage: 5, closing: 355, type: "Production", quantity: 980, batchRef: "PRD-0413-01", notes: "Morning production", modifiedBy: "Admin" },
  { id: "s2", productId: "p2", productName: "Nandini Full Cream Milk 500ml", category: "Milk", date: "2026-04-13", opening: 0, received: 300, dispatched: 90, wastage: 0, closing: 210, type: "Production", quantity: 300, batchRef: "PRD-0413-01", notes: "Morning production", modifiedBy: "Admin" },
  { id: "s3", productId: "p3", productName: "Nandini Curd 500ml", category: "Curd", date: "2026-04-13", opening: 0, received: 200, dispatched: 60, wastage: 0, closing: 140, type: "Production", quantity: 200, batchRef: "PRD-0413-01", notes: "Morning production", modifiedBy: "FGS Team" },
  { id: "s4", productId: "p4", productName: "Nandini Buttermilk 200ml", category: "Buttermilk", date: "2026-04-13", opening: 0, received: 400, dispatched: 0, wastage: 0, closing: 400, type: "Production", quantity: 400, batchRef: "PRD-0413-01", notes: "Morning production", modifiedBy: "FGS Team" },
  { id: "s5", productId: "p5", productName: "Nandini Lassi 200ml", category: "Lassi", date: "2026-04-13", opening: 0, received: 250, dispatched: 0, wastage: 0, closing: 250, type: "Production", quantity: 250, batchRef: "PRD-0413-01", notes: "Morning production", modifiedBy: "Admin" },
  { id: "s6", productId: "p6", productName: "Nandini Ghee 500ml", category: "Ghee", date: "2026-04-13", opening: 0, received: 0, dispatched: 0, wastage: 0, closing: 0, type: "Production", quantity: 0, batchRef: "", notes: "", modifiedBy: "Admin" },
  { id: "s7", productId: "p7", productName: "Nandini Peda 250g", category: "Sweets", date: "2026-04-13", opening: 0, received: 0, dispatched: 0, wastage: 0, closing: 0, type: "Production", quantity: 0, batchRef: "", notes: "", modifiedBy: "Admin" },
  { id: "s8", productId: "p8", productName: "Nandini Paneer 200g", category: "Paneer", date: "2026-04-13", opening: 0, received: 0, dispatched: 0, wastage: 0, closing: 0, type: "Production", quantity: 0, batchRef: "", notes: "", modifiedBy: "Admin" },
];

export const directSales: DirectSale[] = [
  { id: "ds1", gpNo: "GP-001", customerId: "c1", customerName: "Agent Ravi", type: "agent", routeId: "r1", date: "2026-04-08", items: [{ productId: "p1", productName: "TM 500", qty: 21, rate: 22.5 }, { productId: "p2", productName: "FCM 500", qty: 21, rate: 28 }, { productId: "p3", productName: "Curd 500", qty: 17, rate: 28 }], total: 2068, payMode: "Cash" },
  { id: "ds2", gpNo: "GP-002", customerId: "c2", customerName: "Agent Kumar", type: "agent", routeId: "r1", date: "2026-04-08", items: [{ productId: "p1", productName: "TM 500", qty: 22, rate: 22.5 }, { productId: "p4", productName: "BM 200", qty: 30, rate: 9 }], total: 2002, payMode: "Credit" },
  { id: "ds3", gpNo: "GP-003", customerId: "c5", customerName: "Walk-in Customer", type: "cash", routeId: "r3", date: "2026-04-08", items: [{ productId: "p2", productName: "FCM 500", qty: 5, rate: 30 }], total: 150, payMode: "Cash" },
];

export const cancellationRequests: CancellationRequest[] = [
  { id: "CR1", indentId: "IND001", customerId: "c1", agentCode: "A1", routeId: "r1", items: [{ productId: "p1", quantity: 50 }, { productId: "p2", quantity: 30 }], totalAmount: 1965, requestTime: "2026-04-13 06:30 AM", type: "Modify", reason: "Reduce TM 500 quantity to 30", status: "Pending", rejectionReason: "" },
  { id: "CR2", indentId: "IND003", customerId: "c3", agentCode: "A3", routeId: "r2", items: [{ productId: "p2", quantity: 30 }], totalAmount: 840, requestTime: "2026-04-13 07:10 AM", type: "Cancel", reason: "Customer closed today", status: "Pending", rejectionReason: "" },
  { id: "CR3", indentId: "IND004", customerId: "c5", agentCode: "A5", routeId: "r3", items: [{ productId: "p1", quantity: 40 }], totalAmount: 900, requestTime: "2026-04-12 07:45 AM", type: "Cancel", reason: "Route cancelled", status: "Approved", rejectionReason: "" },
];

export const timeWindows: TimeWindow[] = [
  { id: "tw1", zoneName: "Haveri", openTime: "06:00", warningTime: "07:45", closeTime: "08:00", active: true },
  { id: "tw2", zoneName: "Ranebennur", openTime: "06:00", warningTime: "07:45", closeTime: "08:00", active: true },
  { id: "tw3", zoneName: "Savanur", openTime: "06:30", warningTime: "07:45", closeTime: "08:00", active: true },
  { id: "tw4", zoneName: "Byadgi", openTime: "06:30", warningTime: "07:45", closeTime: "08:00", active: true },
  { id: "tw5", zoneName: "Hirekerur", openTime: "07:00", warningTime: "07:45", closeTime: "08:00", active: false },
  { id: "tw6", zoneName: "Hangal", openTime: "06:00", warningTime: "07:45", closeTime: "08:00", active: true },
];

export const notificationSettings: NotificationSetting[] = [
  { id: "n1", type: "Window Open", description: "Sent when the ordering window opens for a zone", sendToAdmin: true, sendToDealer: true, sendToContractor: false, enabled: true },
  { id: "n2", type: "Window Warning (15 min)", description: "Sent 15 minutes before window closes", sendToAdmin: false, sendToDealer: true, sendToContractor: false, enabled: true },
  { id: "n3", type: "Order Confirmed", description: "Sent after dealer places a successful order", sendToAdmin: false, sendToDealer: true, sendToContractor: false, enabled: true },
  { id: "n4", type: "Order Dispatched", description: "Sent when route is marked dispatched", sendToAdmin: false, sendToDealer: true, sendToContractor: true, enabled: true },
  { id: "n5", type: "Payment Received", description: "Sent after wallet top-up or payment", sendToAdmin: true, sendToDealer: true, sendToContractor: false, enabled: false },
  { id: "n6", type: "Low Wallet Balance", description: "Alert when dealer wallet drops below threshold", sendToAdmin: true, sendToDealer: true, sendToContractor: false, enabled: true },
];

export const banners: Banner[] = [
  { id: "bn1", title: "Summer Special Offer", category: "Promotion", imageUrl: "/placeholder.svg", linkUrl: "#", status: "Active", startDate: "2026-04-01", endDate: "2026-04-30" },
  { id: "bn2", title: "New Product Launch: Nandini Pro", category: "Announcement", imageUrl: "/placeholder.svg", linkUrl: "#", status: "Active", startDate: "2026-04-10", endDate: "2026-05-10" },
  { id: "bn3", title: "Independence Day Sale", category: "Festival", imageUrl: "/placeholder.svg", linkUrl: "#", status: "Inactive", startDate: "2026-08-10", endDate: "2026-08-15" },
];

export const systemUsers: SystemUser[] = [
  { id: "u1", name: "Ramesh Kumar", email: "ramesh@haverimunion.coop", role: "Super Admin", zone: "All Zones", status: "Active", lastLogin: "2026-04-13 08:32" },
  { id: "u2", name: "Sunita Patil", email: "sunita@haverimunion.coop", role: "Manager", zone: "All Zones", status: "Active", lastLogin: "2026-04-13 07:15" },
  { id: "u3", name: "Nagaraj Shetty", email: "nagaraj@haverimunion.coop", role: "Dispatch Officer", zone: "Haveri", status: "Active", lastLogin: "2026-04-13 05:45" },
  { id: "u4", name: "Latha Hosamani", email: "latha@haverimunion.coop", role: "Accountant", zone: "All Zones", status: "Active", lastLogin: "2026-04-12 17:00" },
  { id: "u5", name: "Basavaraj M", email: "basavaraj@haverimunion.coop", role: "Call Desk", zone: "Haveri", status: "Active", lastLogin: "2026-04-13 06:10" },
];

export const roles = [
  { role: "Super Admin", permissions: ["dashboard", "masters", "sales", "fgs", "reports", "system"] },
  { role: "Manager", permissions: ["dashboard", "masters", "sales", "fgs", "reports"] },
  { role: "Dispatch Officer", permissions: ["dashboard", "fgs", "sales.dispatch"] },
  { role: "Accountant", permissions: ["dashboard", "reports", "sales.view"] },
  { role: "Call Desk", permissions: ["dashboard", "sales.record-indents", "masters.customers.view"] },
];

// Static helpers
export const rateCategories = ["Retail-Dealer", "Credit Inst-MRP", "Credit Inst-Dealer", "Parlour-Dealer"];
export const agents = customers;
export const officers = [
  { id: "o1", name: "Ravi Kumar" },
  { id: "o2", name: "Suresh Patil" },
  { id: "o3", name: "Mohan Reddy" },
];
