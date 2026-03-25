import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  numeric,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { registrationStatusEnum, approvalTypeEnum } from "./enums.js";
import { zones } from "./zones.js";

// ── Dealers ──
// Registered agencies. Each belongs to a zone. Has GST number, phone, address.
export const dealers = pgTable("dealers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  phone: text("phone").notNull().unique(), // primary login identifier (OTP-based)
  email: text("email"),
  gstNumber: text("gst_number"), // GSTIN — can be null for dealers without GST
  zoneId: uuid("zone_id")
    .notNull()
    .references(() => zones.id, { onDelete: "restrict" }),
  address: text("address"),
  city: text("city"),
  pinCode: text("pin_code"),
  locationLabel: text("location_label"), // e.g. "Haveri Main Market" — shown in app header
  contactPerson: text("contact_person"),
  creditLimit: numeric("credit_limit", { precision: 10, scale: 2 }).notNull().default("0"),
  fcmToken: text("fcm_token"), // Firebase Cloud Messaging token for push notifications
  languagePreference: text("language_preference").notNull().default("en"), // "en" | "kn" (Kannada)
  biometricEnabled: boolean("biometric_enabled").notNull().default(false),
  notificationsEnabled: boolean("notifications_enabled").notNull().default(true),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
});

// ── Dealer Wallets ──
// One row per dealer. balance, last_topup_at, last_topup_amount.
// Updated atomically: UPDATE ... SET balance = balance - $1 WHERE balance >= $1 RETURNING balance;
export const dealerWallets = pgTable("dealer_wallets", {
  id: uuid("id").defaultRandom().primaryKey(),
  dealerId: uuid("dealer_id")
    .notNull()
    .references(() => dealers.id, { onDelete: "restrict" })
    .unique(), // one wallet per dealer
  balance: numeric("balance", { precision: 12, scale: 2 }).notNull().default("0"),
  lastTopupAt: timestamp("last_topup_at", { withTimezone: true }),
  lastTopupAmount: numeric("last_topup_amount", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Dealer OTPs ──
// Short-lived OTP for dealer login. Auto-expires.
export const dealerOtps = pgTable("dealer_otps", {
  id: uuid("id").defaultRandom().primaryKey(),
  phone: text("phone").notNull(),
  otp: text("otp").notNull(), // 6-digit OTP (hashed in production)
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  verified: boolean("verified").notNull().default(false),
  attempts: numeric("attempts").notNull().default("0"), // rate limit brute force
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Dealer Refresh Tokens ──
// JWT refresh token rotation. 30-day tokens stored in Expo SecureStore.
export const dealerRefreshTokens = pgTable("dealer_refresh_tokens", {
  id: uuid("id").defaultRandom().primaryKey(),
  dealerId: uuid("dealer_id")
    .notNull()
    .references(() => dealers.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  family: text("family").notNull(), // token family for rotation detection
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }), // null = active
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_dealer_refresh_tokens_dealer").on(table.dealerId),
  index("idx_dealer_refresh_tokens_family").on(table.family),
]);

// ── Dealer Registrations / Approval Requests ──
// New dealer registrations and change requests that need admin approval.
export const approvalRequests = pgTable("approval_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  dealerId: uuid("dealer_id").references(() => dealers.id, { onDelete: "set null" }), // null for new registrations
  type: approvalTypeEnum("type").notNull(),
  status: registrationStatusEnum("status").notNull().default("pending"),
  // Submitted data as JSON — flexible for different request types
  submittedData: text("submitted_data").notNull(), // JSON string
  reviewedBy: uuid("reviewed_by"), // admin user who reviewed
  reviewNote: text("review_note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Relations ──
export const dealersRelations = relations(dealers, ({ one, many }) => ({
  zone: one(zones, {
    fields: [dealers.zoneId],
    references: [zones.id],
  }),
  wallet: one(dealerWallets, {
    fields: [dealers.id],
    references: [dealerWallets.dealerId],
  }),
  refreshTokens: many(dealerRefreshTokens),
  approvalRequests: many(approvalRequests),
}));

export const dealerWalletsRelations = relations(dealerWallets, ({ one }) => ({
  dealer: one(dealers, {
    fields: [dealerWallets.dealerId],
    references: [dealers.id],
  }),
}));

export const dealerRefreshTokensRelations = relations(dealerRefreshTokens, ({ one }) => ({
  dealer: one(dealers, {
    fields: [dealerRefreshTokens.dealerId],
    references: [dealers.id],
  }),
}));

export const approvalRequestsRelations = relations(approvalRequests, ({ one }) => ({
  dealer: one(dealers, {
    fields: [approvalRequests.dealerId],
    references: [dealers.id],
  }),
}));
