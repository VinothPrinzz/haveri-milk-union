// ═══════════════════════════════════════════════════════════════════════
// Dealer Standing Indents — Drizzle Schema
// packages/db/src/schema/dealerIndents.ts
//
// Mirrors migration 0030_dealer_standing_indents.sql.
// Two tables:
//   1. dealer_standing_indents — per-dealer template of daily qty per product
//   2. dealer_indent_pauses    — closed-shop windows (vacation, closures)
//
// Edit discipline:
//   Standing indents are edited explicitly (Manage screen / inline link).
//   Day-to-day +/- on the Indent tab edits the materialized order row,
//   not these rows.
// ═══════════════════════════════════════════════════════════════════════

import {
    pgTable,
    uuid,
    text,
    boolean,
    timestamp,
    integer,
    date,
    index,
    uniqueIndex,
    check,
  } from "drizzle-orm/pg-core";
  import { relations, sql } from "drizzle-orm";
  import { dealers } from "./dealers.js";
  import { products } from "./products.js";
  
  // ── Standing indent rows ─────────────────────────────────────────────
  export const dealerStandingIndents = pgTable(
    "dealer_standing_indents",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      dealerId: uuid("dealer_id")
        .notNull()
        .references(() => dealers.id, { onDelete: "cascade" }),
      productId: uuid("product_id")
        .notNull()
        .references(() => products.id, { onDelete: "restrict" }),
      defaultQty: integer("default_qty").notNull().default(0),
      active: boolean("active").notNull().default(true),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      uniqueIndex("uq_dealer_standing_indents_dealer_product").on(
        table.dealerId,
        table.productId
      ),
      index("idx_dealer_standing_indents_active")
        .on(table.dealerId)
        .where(sql`active = true AND default_qty > 0`),
      check("default_qty_nonneg", sql`default_qty >= 0`),
    ]
  );
  
  // ── Pause windows (vacation, closed-shop) ────────────────────────────
  export const dealerIndentPauses = pgTable(
    "dealer_indent_pauses",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      dealerId: uuid("dealer_id")
        .notNull()
        .references(() => dealers.id, { onDelete: "cascade" }),
      fromDate: date("from_date").notNull(),
      toDate: date("to_date").notNull(),
      reason: text("reason"),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
    },
    (table) => [
      index("idx_dealer_indent_pauses_dealer_range").on(
        table.dealerId,
        table.fromDate,
        table.toDate
      ),
      check("pause_range_valid", sql`to_date >= from_date`),
    ]
  );
  
  // ── Relations ────────────────────────────────────────────────────────
  export const dealerStandingIndentsRelations = relations(
    dealerStandingIndents,
    ({ one }) => ({
      dealer: one(dealers, {
        fields: [dealerStandingIndents.dealerId],
        references: [dealers.id],
      }),
      product: one(products, {
        fields: [dealerStandingIndents.productId],
        references: [products.id],
      }),
    })
  );
  
  export const dealerIndentPausesRelations = relations(
    dealerIndentPauses,
    ({ one }) => ({
      dealer: one(dealers, {
        fields: [dealerIndentPauses.dealerId],
        references: [dealers.id],
      }),
    })
  );