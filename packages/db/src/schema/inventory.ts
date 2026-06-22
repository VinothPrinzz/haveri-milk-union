import {
  pgTable,
  uuid,
  timestamp,
  integer,
  numeric,
  date,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { products } from "./products.js";
import { suppliers } from "./suppliers.js";

// ── FGS Stock Log ──
// Daily entries: product_id, date, opening, received, dispatched, wastage, closing.
// Entered by Dispatch Officer each morning.
// One entry per product per date — enforced by unique constraint.
// Phase 2: Added batch_id FK to link stock entries to distribution batches.
export const fgsStockLog = pgTable("fgs_stock_log", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "restrict" }),
  date: date("date").notNull(), // the business day this entry is for
  opening: integer("opening").notNull().default(0),
  received: integer("received").notNull().default(0), // production received
  dispatched: integer("dispatched").notNull().default(0), // sent out on routes
  wastage: integer("wastage").notNull().default(0), // spoiled / damaged
  closing: integer("closing").notNull().default(0), // opening + received - dispatched - wastage
  enteredBy: uuid("entered_by").notNull(), // admin user (dispatch officer)
  batchId: uuid("batch_id"), // Phase 2: FK to batches (no inline ref to avoid circular import)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  unique("uq_fgs_stock_product_date").on(table.productId, table.date),
  index("idx_fgs_stock_date").on(table.date),
  index("idx_fgs_stock_product").on(table.productId),
  index("idx_fgs_stock_batch").on(table.batchId),
]);

// ── Relations ──
export const fgsStockLogRelations = relations(fgsStockLog, ({ one }) => ({
  product: one(products, {
    fields: [fgsStockLog.productId],
    references: [products.id],
  }),
}));

// ── Stock Receipts (GRN lines) ──
// One row per purchase/receipt event: which product was received, from which
// supplier, the quantity and cost, on a given business day. A product may be
// received from several suppliers on the same day → several rows. The daily
// fgs_stock_log.received is the SUM of that day's receipts for the product
// (rolled up by the API on save). supplier_id / unit_cost are nullable so a
// plain "received from own plant production" line still works.
export const stockReceipts = pgTable("stock_receipts", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "restrict" }),
  supplierId: uuid("supplier_id").references(() => suppliers.id, { onDelete: "set null" }),
  date: date("date").notNull(),
  quantity: integer("quantity").notNull().default(0),
  unitCost: numeric("unit_cost", { precision: 10, scale: 2 }),
  totalCost: numeric("total_cost", { precision: 12, scale: 2 }),
  enteredBy: uuid("entered_by").notNull(), // admin user (FGS operator)
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_stock_receipts_product_date").on(table.productId, table.date),
  index("idx_stock_receipts_supplier").on(table.supplierId),
  index("idx_stock_receipts_date").on(table.date),
]);

export const stockReceiptsRelations = relations(stockReceipts, ({ one }) => ({
  product: one(products, {
    fields: [stockReceipts.productId],
    references: [products.id],
  }),
  supplier: one(suppliers, {
    fields: [stockReceipts.supplierId],
    references: [suppliers.id],
  }),
}));
