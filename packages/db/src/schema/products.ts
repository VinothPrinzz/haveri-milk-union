import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  numeric,
  integer,
  date,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { categories } from "./categories.js";

// ── Products ──
// name, category, unit, base_price, gst_percent, available (boolean), stock (current FGS count)
export const products = pgTable("products", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  categoryId: uuid("category_id")
    .notNull()
    .references(() => categories.id, { onDelete: "restrict" }),
  icon: text("icon"), // emoji for product display
  unit: text("unit").notNull(), // e.g. "500ml Pouch", "200g Block", "400ml", "100g Cup"
  basePrice: numeric("base_price", { precision: 10, scale: 2 }).notNull(), // price before GST
  gstPercent: numeric("gst_percent", { precision: 5, scale: 2 }).notNull(), // e.g. 5.00, 12.00
  stock: integer("stock").notNull().default(0), // current FGS count
  lowStockThreshold: integer("low_stock_threshold").notNull().default(50),
  criticalStockThreshold: integer("critical_stock_threshold").notNull().default(10),
  available: boolean("available").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete

  // === ADD THESE MISSING COLUMNS ===
  code:                    text("code"),
  hsnNo:                   text("hsn_no"),
  packSize:                numeric("pack_size", { precision: 8, scale: 2 }),
  printDirection:          text("print_direction").default("Across"),
  packetsCrate:            integer("packets_crate").default(0),
  reportAlias:             text("report_alias"),
  retailDealerPrice:       numeric("retail_dealer_price",      { precision: 10, scale: 2 }),
  creditInstMrpPrice:      numeric("credit_inst_mrp_price",    { precision: 10, scale: 2 }),
  creditInstDealerPrice:   numeric("credit_inst_dealer_price", { precision: 10, scale: 2 }),
  parlourDealerPrice:      numeric("parlour_dealer_price",     { precision: 10, scale: 2 }),

});

// ── Price Revisions ──
// Audit trail for price changes. Every price change is logged with effective date.
export const priceRevisions = pgTable("price_revisions", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "restrict" }),
  oldPrice: numeric("old_price", { precision: 10, scale: 2 }).notNull(),
  newPrice: numeric("new_price", { precision: 10, scale: 2 }).notNull(),
  oldGstPercent: numeric("old_gst_percent", { precision: 5, scale: 2 }).notNull(),
  newGstPercent: numeric("new_gst_percent", { precision: 5, scale: 2 }).notNull(),
  effectiveFrom: date("effective_from").notNull(), // date when new price takes effect
  changedBy: uuid("changed_by").notNull(), // admin user who made the change
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Relations ──
export const productsRelations = relations(products, ({ one, many }) => ({
  category: one(categories, {
    fields: [products.categoryId],
    references: [categories.id],
  }),
  priceRevisions: many(priceRevisions),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  products: many(products),
}));

export const priceRevisionsRelations = relations(priceRevisions, ({ one }) => ({
  product: one(products, {
    fields: [priceRevisions.productId],
    references: [products.id],
  }),
}));
