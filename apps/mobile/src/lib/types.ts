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
  zoneId: string;
  zoneName: string;
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
  code?: string;              // agency ID (e.g. HMU-AG-2024-XXXX)
  zoneId: string;
  zoneName: string;
  walletBalance: number;
  creditLimit: number;          // <- ADD
  creditOutstanding?: number;
  locationLabel?: string;
  gstNumber?: string;
  address?: string;
  languagePref?: "en" | "kn";
  notificationsEnabled?: boolean;
  biometricEnabled?: boolean;
  verified?: boolean;
  memberSince?: string;       // ISO
  
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
  | "pending"
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
  cancellationStatus?: "pending" | "approved" | "rejected" | null;  // ← ADD
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