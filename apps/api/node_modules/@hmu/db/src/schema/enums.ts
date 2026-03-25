import { pgEnum } from "drizzle-orm/pg-core";

// ── Admin user roles ──
export const userRoleEnum = pgEnum("user_role", [
  "super_admin",
  "manager",
  "dispatch_officer",
  "accountant",
  "call_desk",
]);

// ── Order lifecycle ──
export const orderStatusEnum = pgEnum("order_status", [
  "pending",
  "confirmed",
  "dispatched",
  "delivered",
  "cancelled",
]);

// ── Payment mode at order time ──
export const paymentModeEnum = pgEnum("payment_mode", [
  "wallet",
  "upi",
  "credit",
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
