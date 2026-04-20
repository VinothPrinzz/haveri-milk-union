// ══════════════════════════════════════════════════════════════════
// @hmu/db — Schema Barrel Export
// Import everything from here: import { zones, dealers, orders } from "@hmu/db/schema"
//
// Phase 2: Added contractors, batches, batchRoutes, rateCategories, priceChart,
// cashCustomers, directSales, directSaleItems, gatePassItems, routeSheets
// ══════════════════════════════════════════════════════════════════

// ── Enums ──
export {
  userRoleEnum,
  orderStatusEnum,
  paymentModeEnum,
  cancellationStatusEnum,
  ledgerTypeEnum,
  ledgerRefTypeEnum,
  registrationStatusEnum,
  approvalTypeEnum,
  dispatchStatusEnum,
  deliveryStatusEnum,
  notifChannelEnum,
  settlementStatusEnum,
  // Phase 2 enums
  batchStatusEnum,
  directSaleCustomerTypeEnum,
  routeSheetStatusEnum,
} from "./enums.js";

// ── Zones & Time Windows ──
export {
  zones,
  timeWindows,
  zonesRelations,
  timeWindowsRelations,
} from "./zones.js";

// ── Admin Users & Sessions ──
export {
  users,
  adminSessions,
  usersRelations,
  adminSessionsRelations,
} from "./users.js";

// ── Categories ──
export { categories } from "./categories.js";

// ── Products & Price Revisions ──
export {
  products,
  priceRevisions,
  productsRelations,
  categoriesRelations,
  priceRevisionsRelations,
} from "./products.js";

// ── Dealers, Wallets, OTPs, Refresh Tokens, Approval Requests ──
export {
  dealers,
  dealerWallets,
  dealerOtps,
  dealerRefreshTokens,
  approvalRequests,
  dealersRelations,
  dealerWalletsRelations,
  dealerRefreshTokensRelations,
  approvalRequestsRelations,
} from "./dealers.js";

// ── Orders, Order Items, Cancellation Requests ──
export {
  orders,
  orderItems,
  cancellationRequests,
  ordersRelations,
  orderItemsRelations,
  cancellationRequestsRelations,
} from "./orders.js";

// ── Invoices ──
export {
  invoices,
  invoicesRelations,
} from "./invoices.js";

// ── Dealer Ledger (APPEND-ONLY) ──
export {
  dealerLedger,
  dealerLedgerRelations,
} from "./ledger.js";

// ── FGS Stock Log ──
export {
  fgsStockLog,
  fgsStockLogRelations,
} from "./inventory.js";

// ── Distribution: Routes, Vehicles, Route Assignments ──
export {
  routes,
  vehicles,
  routeAssignments,
  routesRelations,
  vehiclesRelations,
  routeAssignmentsRelations,
} from "./distribution.js";

// ── Finance: Settlements, Bank Reconciliation ──
export {
  settlements,
  bankReconciliation,
} from "./finance.js";

// ── Banners ──
export {
  banners,
  bannersRelations,
} from "./banners.js";

// ── Notifications Log ──
export { notificationsLog } from "./notifications.js";

// ── System Settings & Notification Config ──
export {
  systemSettings,
  notificationConfig,
} from "./settings.js";

// ┌─────────────────────────────────────────┐
// │   PHASE 2 — Marketing Module             │
// └─────────────────────────────────────────┘

// ── Contractors ──
export {
  contractors,
  contractorsRelations,
} from "./contractors.js";

// ── Batches & Batch Routes ──
export {
  batches,
  batchRoutes,
  batchesRelations,
  batchRoutesRelations,
} from "./batches.js";

// ── Rate Categories, Price Chart, Cash Customers, Direct Sales, Route Sheets ──
export {
  rateCategories,
  priceChart,
  cashCustomers,
  directSales,
  directSaleItems,
  gatePassItems,
  routeSheets,
  rateCategoriesRelations,
  priceChartRelations,
  cashCustomersRelations,
  directSalesRelations,
  directSaleItemsRelations,
  gatePassItemsRelations,
  routeSheetsRelations,
} from "./marketing.js";
