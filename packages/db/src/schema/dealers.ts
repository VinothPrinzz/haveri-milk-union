// ═══════════════════════════════════════════════════════════════════════
// Dealers schema — Updated with Marketing Module fields
// ═══════════════════════════════════════════════════════════════════════

import {
  pgTable,
  pgEnum,
  uuid,
  text,
  boolean,
  numeric,
  timestamp,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";

import { zones } from "./zones.js";
import { routes } from "./distribution.js";
import { registrationStatusEnum, approvalTypeEnum } from "./enums.js";

// ── Enums ──
export const customerTypeEnum = pgEnum("customer_type", [
  "Retail-Dealer",
  "Credit Inst-MRP",
  "Credit Inst-Dealer",
  "Parlour-Dealer",
]);

export const payModeEnum = pgEnum("pay_mode", ["Cash", "Credit"]);

// ── Dealers Table ──
export const dealers = pgTable(
  "dealers",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: text("name").notNull(),
    phone: text("phone").notNull().unique(),
    email: text("email"),
    gstNumber: text("gst_number"),

    zoneId: uuid("zone_id")
      .notNull()
      .references(() => zones.id, { onDelete: "restrict" }),

    // ── Marketing Module fields ──
    code: text("code").unique(), // e.g. "A1", "B3"
    customerType: customerTypeEnum("customer_type")
      .notNull()
      .default("Retail-Dealer"),
    rateCategory: text("rate_category")
      .notNull()
      .default("Retail-Dealer"),
    payMode: payModeEnum("pay_mode").notNull().default("Cash"),
    routeId: uuid("route_id").references(() => routes.id, { onDelete: "set null" }),
    bank: text("bank"),
    officerName: text("officer_name"),

    // ── Original fields ──
    address: text("address"),
    city: text("city"),
    pinCode: text("pin_code"),
    locationLabel: text("location_label"),
    contactPerson: text("contact_person"),
    creditLimit: numeric("credit_limit", { precision: 10, scale: 2 })
      .notNull()
      .default("0"),
    fcmToken: text("fcm_token"),
    languagePreference: text("language_preference")
      .notNull()
      .default("en"),
    biometricEnabled: boolean("biometric_enabled")
      .notNull()
      .default(false),
    notificationsEnabled: boolean("notifications_enabled")
      .notNull()
      .default(true),
    active: boolean("active").notNull().default(true),

    // Marketing v1.4
    accountNo:     text("account_no"),
    addressType:   text("address_type"), // "Office" | "Residence"
    state:         text("state").default("Karnataka"),
    area:          text("area"),
    houseNo:       text("house_no"),
    street:        text("street"),
    lastIndentAt:  timestamp("last_indent_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
  },
  (table) => [
    index("idx_dealers_code").on(table.code),
    index("idx_dealers_route").on(table.routeId),
    index("idx_dealers_customer_type").on(table.customerType),
    index("idx_dealers_pay_mode").on(table.payMode),
  ]
);

// ── Dealer Wallets ──
export const dealerWallets = pgTable("dealer_wallets", {
  id: uuid("id").defaultRandom().primaryKey(),
  dealerId: uuid("dealer_id")
    .notNull()
    .references(() => dealers.id, { onDelete: "restrict" })
    .unique(),
  balance: numeric("balance", { precision: 12, scale: 2 })
    .notNull()
    .default("0"),
  lastTopupAt: timestamp("last_topup_at", { withTimezone: true }),
  lastTopupAmount: numeric("last_topup_amount", { precision: 10, scale: 2 }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Dealer OTPs ──
export const dealerOtps = pgTable("dealer_otps", {
  id: uuid("id").defaultRandom().primaryKey(),
  phone: text("phone").notNull(),
  otp: text("otp").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  verified: boolean("verified").notNull().default(false),
  attempts: numeric("attempts").notNull().default("0"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Dealer Refresh Tokens ──
export const dealerRefreshTokens = pgTable(
  "dealer_refresh_tokens",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    dealerId: uuid("dealer_id")
      .notNull()
      .references(() => dealers.id, { onDelete: "cascade" }),
    token: text("token").notNull().unique(),
    family: text("family").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("idx_dealer_refresh_tokens_dealer").on(table.dealerId),
    index("idx_dealer_refresh_tokens_family").on(table.family),
  ]
);

// ── Dealer Approval Requests ──
export const approvalRequests = pgTable("approval_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  dealerId: uuid("dealer_id").references(() => dealers.id, { onDelete: "set null" }),
  type: approvalTypeEnum("type").notNull(),
  status: registrationStatusEnum("status").notNull().default("pending"),
  submittedData: text("submitted_data").notNull(), // JSON string
  reviewedBy: uuid("reviewed_by"),
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
  route: one(routes, {
    fields: [dealers.routeId],
    references: [routes.id],
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

export const dealerRefreshTokensRelations = relations(
  dealerRefreshTokens,
  ({ one }) => ({
    dealer: one(dealers, {
      fields: [dealerRefreshTokens.dealerId],
      references: [dealers.id],
    }),
  })
);

export const approvalRequestsRelations = relations(approvalRequests, ({ one }) => ({
  dealer: one(dealers, {
    fields: [approvalRequests.dealerId],
    references: [dealers.id],
  }),
}));