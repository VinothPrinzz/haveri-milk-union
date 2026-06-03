import { pgEnum } from "drizzle-orm/pg-core";

// ── Admin user roles ──
// Phase 2: Added 'officer' for sales officers who handle direct sales / gate passes.
// 'viewer' is a read-only role: granted only *.view permissions in the API
// middleware (apps/api/src/middleware/admin-auth.ts).
export const userRoleEnum = pgEnum("user_role", [
  "super_admin",
  "manager",
  "dispatch_officer",
  "accountant",
  "call_desk",
  "officer",
  "viewer",
]);

// ── Order lifecycle ──
export const orderStatusEnum = pgEnum("order_status", [
  "draft",                 // pre-confirm, editable by dealer
  "pending",               // DEPRECATED — kept in enum for DB compat; all new confirms go to 'confirmed' directly
  "payment_required",      // close passed, credit insufficient
  "confirmed",             // dealer confirmed (credit OK) or window auto-closed → ready for dispatch
  "dispatched",
  "delivered",
  "cancelled",
]);

// ── Payment mode at order time ──
// Phase 2: Added 'cash' for direct/walk-in sales.
export const paymentModeEnum = pgEnum("payment_mode", [
  "wallet",
  "upi",
  "credit",
  "cash",
  "complimentary",
]);

// ── Cancellation request status ──
export const cancellationStatusEnum = pgEnum("cancellation_status", [
  "pending",
  "approved",
  "rejected",
]);

// ── Dealer ledger transaction type ──
export const ledgerTypeEnum = pgEnum("ledger_type", [
  "credit",
  "debit",
]);

// ── Ledger reference type ──
export const ledgerRefTypeEnum = pgEnum("ledger_ref_type", [
  "wallet_topup",
  "order",
  "refund",
  "adjustment",
]);

// ── Dealer registration request status ──
export const registrationStatusEnum = pgEnum("registration_status", [
  "pending",
  "approved",
  "rejected",
]);

// ── Approval request types ──
export const approvalTypeEnum = pgEnum("approval_type", [
  "new_registration",
  "credit_limit_increase",
  "address_change",
  "gst_update",
]);

// ── Route assignment status ──
export const dispatchStatusEnum = pgEnum("dispatch_status", [
  "pending",
  "loading",
  "dispatched",
  "delivered",
]);

// ── Notification delivery status ──
export const deliveryStatusEnum = pgEnum("delivery_status", [
  "queued",
  "sent",
  "delivered",
  "failed",
]);

// ── Notification channel ──
export const notifChannelEnum = pgEnum("notif_channel", [
  "push",
  "sms",
  "email",
]);

// ── Settlement status ──
export const settlementStatusEnum = pgEnum("settlement_status", [
  "pending",
  "processed",
  "failed",
]);

// ── Window state (not stored, computed at runtime — kept as reference) ──
// open | warning | closed — derived from time_windows + current time

// ┌─────────────────────────────────────────┐
// │   PHASE 2 ENUMS — Marketing Module       │
// └─────────────────────────────────────────┘

// ── Distribution batch lifecycle ──
export const batchStatusEnum = pgEnum("batch_status", [
  "active",
  "closed",
  "expired",
]);

// ── Direct sale customer type (polymorphic) ──
export const directSaleCustomerTypeEnum = pgEnum("direct_sale_customer_type", [
  "agent",
  "cash",
  "vip_sample",
  "employee_subsidy",
]);

// ── Route sheet lifecycle ──
export const routeSheetStatusEnum = pgEnum("route_sheet_status", [
  "draft",
  "confirmed",
  "dispatched",
  "completed",
]);
