/**
 * HMU Dealer App — Shared Types
 *
 * Mirrors the API response shapes from /mnt/project/api.txt.
 *
 * IMPORTANT: the backend is inconsistent — `/orders/my` returns snake_case
 * (`created_at`, `grand_total`) while `/products` returns camelCase
 * (`basePrice`, `gstPercent`). Each hook in `src/hooks/` normalizes the
 * response so screens only ever see camelCase here.
 */

// ── Window ─────────────────────────────────────────────────────────────

/** Exactly matches the `state` field returned by /api/v1/window/status */
export type WindowState = "open" | "warning" | "closed";

export interface WindowStatus {
  // Route-based fields (new primary path)
  routeId?: string;
  routeName?: string;
  routeCode?: string;
  // Zone-based fields (legacy — kept for backward compat)
  zoneId?: string;
  zoneName?: string;
  state: WindowState;
  openTime: string;        // "06:00"
  closeTime: string;       // "08:00"
  warningMinutes: number;  // minutes before close when state flips to "warning"
  remainingSeconds: number;
  serverTime: string;      // ISO
}

// ── Dealer / Auth ──────────────────────────────────────────────────────

export interface Dealer {
  id: string;
  name: string;
  phone: string;
  username?: string;
  code?: string;              // agency ID (e.g. HMU-AG-2024-XXXX)
  zoneId: string;
  zoneName: string;
  // Route — primary delivery route for ordering window + dispatch
  routeId: string;
  routeName: string;
  routeCode: string;
  walletBalance: number;
  creditLimit: number;
  creditOutstanding?: number;
  creditAvailable?: number;
  ledgerBalance: number;
  locationLabel?: string;
  email?: string;
  gstNumber?: string;
  address?: string;
  languagePref?: "en" | "kn";
  notificationsEnabled?: boolean;
  biometricEnabled?: boolean;
  verified?: boolean;
  memberSince?: string;
}

// ── Login Response (new username/password flow) ────────────────────────

export interface LoginResponse {
  accessToken: string;
  refreshToken: string;
  dealer: Dealer;              // Full dealer object from backend
}

export interface VerifyOtpResponse {
  accessToken: string;
  refreshToken: string;
  dealer: Pick<Dealer, "id" | "name" | "phone" | "zoneId">;
}

// ── Catalog ────────────────────────────────────────────────────────────

export interface Category {
  id: string;
  name: string;
  icon: string | null;
  sortOrder: number;
}

export interface Product {
  id: string;
  name: string;
  icon: string | null;          // emoji fallback / visual hint
  imageUrl?: string | null;     // real CDN image (backend doesn't serve this yet; ProductCard handles absence)
  unit: string;                 // "1 L", "500 ml", "200 g", etc.
  basePrice: number;
  dealerPrice?: number;  // Dealer-Price (gross, client-entered)
  mrp: number;
  gstPercent: number;
  stock: number;
  available: boolean;
  categoryId: string;
  categoryName: string;
  sortOrder: number;

  // Marketing / pricing tier fields (rarely needed on dealer app)
  code?: string | null;
  hsnNo?: string | null;
  packSize?: string | null;
  packetsCrate?: number | null;
  retailDealerPrice?: number;
  creditInstMrpPrice?: number;
  creditInstDealerPrice?: number;
  parlourDealerPrice?: number;
}

// ── Banners ────────────────────────────────────────────────────────────

export interface Banner {
  id: string;
  title: string;
  subtitle: string | null;
  category: string | null;     // "Offer" | "New Launch" | "Announcement" | ...
  imageUrl: string | null;
  startDate: string;           // YYYY-MM-DD
  endDate: string;
}

// ── Orders ─────────────────────────────────────────────────────────────

export type OrderStatus =
  | "draft"
  | "payment_required"
  | "confirmed"
  | "dispatched"
  | "delivered"
  | "cancelled";

export type PaymentMode = "wallet" | "upi" | "credit";

/** Payment method the UI shows in the IndentCart footer (spec §6.8) */
export type UiPaymentMethod = "wallet" | "upi" | "card" | "netbank" | "credit";

export function uiPaymentToBackend(m: UiPaymentMethod): PaymentMode {
  if (m === "wallet") return "wallet";
  if (m === "credit") return "credit";
  return "upi";
}

export interface OrderItem {
  productId?: string;           // not always returned in /orders/my
  productName: string;
  quantity: number;
  unitPrice: number;
  gstPercent: number;
  gstAmount?: number;
  lineTotal: number;
}

export interface Order {
  id: string;
  status: OrderStatus;
  paymentMode: PaymentMode;
  subtotal: number;
  totalGst: number;
  grandTotal: number;
  itemCount: number;
  createdAt: string;
  /** When the order was confirmed/placed. */
  confirmedAt?: string | null;
  items: OrderItem[];
}

export interface PlaceOrderRequest {
  items: Array<{ productId: string; quantity: number }>;
  paymentMode: PaymentMode;
  paymentReference?: string;
  notes?: string;
}

export interface PlaceOrderResponse {
  order: Order;
  invoiceNumber?: string;
}

// ── Invoices ───────────────────────────────────────────────────────────

export interface Invoice {
  id: string;
  orderId: string;
  invoiceNumber: string;
  invoiceDate: string;          // ISO or YYYY-MM-DD
  monthId: string;
  deliveryDate: string | null;  // YYYY-MM-DD from orders.delivery_date
  taxableAmount: number;
  cgst: number;
  sgst: number;
  totalTax: number;
  totalAmount: number;
  pdfUrl: string | null;
  itemCount: number;
  orderStatus: OrderStatus;
}

export interface InvoiceSummary {
  totalOrders: number;          // sum of total_amount for current month
  totalGst: number;
  invoiceCount: number;
  currentMonthId?: string;      // NEW: from server, e.g. "2026-04"
}

// ── Pagination ─────────────────────────────────────────────────────────

export interface Paginated<T> {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ── Standing indent ─────────────────────────────────────────────────
 
/** A row in the dealer's standing indent template */
export interface StandingIndentItem {
  productId: string;
  defaultQty: number;
  active: boolean;
  productName: string;
  unit: string;
  icon: string | null;
  imageUrl: string | null;
  basePrice: number;
  gstPercent: number;
  productAvailable: boolean;
}
 
/** A product the dealer COULD add to their standing indent */
export interface EligibleProduct {
  productId: string;
  productName: string;
  unit: string;
  icon: string | null;
  imageUrl: string | null;
  basePrice: number;
  gstPercent: number;
  categoryName?: string | null;  // drives the Milk/Curd minimum-order-qty rule
  /** What's currently in the dealer's standing indent for this product (0 = not in) */
  currentDefaultQty: number;
  currentActive: boolean;
}
 
// ── Daily draft ─────────────────────────────────────────────────────
 
/** A line item in a draft / confirmed order */
export interface DraftItem {
  productId: string;
  productName: string;
  quantity: number;
  unitPrice: number;
  gstPercent: number;
  lineTotal: number;
  icon: string | null;
  imageUrl: string | null;
  unit: string;
  categoryName?: string | null;  // drives the Milk/Curd minimum-order-qty rule
}
 
export interface DraftTotals {
  subtotal: number;
  totalGst: number;
  grandTotal: number;
}
 
/**
 * Result of GET /api/v1/dealer/drafts/:date.
 *
 * `exists` distinguishes a server-side persisted draft from a
 * synthesized "what would the draft look like" preview. Clients
 * shouldn't care for display purposes, but the difference matters
 * for the first PATCH (which creates the row vs. updates it — the
 * server handles that transparently).
 *
 * `paused` is true when the requested delivery date falls inside an
 * active pause window. UI should disable +/- and show a "shop is
 * paused for this date" message.
 */
export interface DailyDraft {
  deliveryDate: string;
  exists: boolean;
  paused: boolean;
  pausedReason?: string | null;
  orderId?: string;
  /**
   * The single orders row for (dealer, deliveryDate) moves through the
   * whole lifecycle — the server's GET /drafts/:date surfaces it in any
   * non-cancelled status, so this must allow every OrderStatus, not just
   * the three editable-ish ones. (Previously this was narrowed, which
   * forced screens to cast.)
   */
  status: OrderStatus;
  items: DraftItem[];
  totals: DraftTotals;
}
 
// ── Confirm response ────────────────────────────────────────────────
 
export interface CreditCheckSnapshot {
  creditLimit: number;
  outstanding: number;
  available: number;
  orderTotal: number;
  sufficient: boolean;
  shortfall: number;
}
 
export interface ConfirmDraftSuccess {
  orderId: string;
  status: "confirmed";
  deliveryDate: string;
  credit: CreditCheckSnapshot;
}
 
/** 402 response shape — same as success minus the status flip */
export interface ConfirmDraftCreditExceeded {
  error: "Credit limit exceeded";
  message: string;
  orderId: string;
  credit: CreditCheckSnapshot;
}
 
// ── Pause windows ───────────────────────────────────────────────────
 
export interface IndentPause {
  id: string;
  fromDate: string;
  toDate: string;
  reason: string | null;
  createdAt: string;
}