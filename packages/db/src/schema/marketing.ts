import {
  pgTable,
  uuid,
  text,
  boolean,
  timestamp,
  numeric,
  integer,
  date,
  time,
  index,
  unique,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  directSaleCustomerTypeEnum,
  paymentModeEnum,
  routeSheetStatusEnum,
} from "./enums.js";
import { products } from "./products.js";
import { users } from "./users.js";
import { routes } from "./distribution.js";
import { contractors } from "./contractors.js";
import { batches } from "./batches.js";

// ┌─────────────────────────────────────────┐
// │   RATE CATEGORIES & PRICE CHART          │
// └─────────────────────────────────────────┘

// ── Rate Categories ──
// Used by Price Chart: "Retail-Dealer", "Credit Inst-MRP",
// "Credit Inst-Dealer", "Parlour-Dealer"
export const rateCategories = pgTable("rate_categories", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().unique(),
  description: text("description"),
  sortOrder: integer("sort_order").notNull().default(0),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Price Chart ──
// Per-product, per-rate-category pricing. Separate from the base product price.
// Supports effective date ranges for scheduled price changes.
// If effective_to IS NULL, the price is currently active (open-ended).
export const priceChart = pgTable("price_chart", {
  id: uuid("id").defaultRandom().primaryKey(),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "restrict" }),
  rateCategoryId: uuid("rate_category_id")
    .notNull()
    .references(() => rateCategories.id, { onDelete: "restrict" }),
  price: numeric("price", { precision: 10, scale: 2 }).notNull(),
  effectiveFrom: date("effective_from").notNull(),
  effectiveTo: date("effective_to"),         // NULL = currently active
  createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_price_chart_product").on(table.productId),
  index("idx_price_chart_category").on(table.rateCategoryId),
  index("idx_price_chart_active_lookup").on(
    table.productId, table.rateCategoryId, table.effectiveFrom
  ),
]);

// ┌─────────────────────────────────────────┐
// │   CASH CUSTOMERS                         │
// └─────────────────────────────────────────┘

// ── Cash Customers ──
// Walk-in cash buyers for direct sales (not registered dealers).
// Minimal info — name and phone are enough for a receipt.
export const cashCustomers = pgTable("cash_customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  phone: text("phone"),
  address: text("address"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp("deleted_at", { withTimezone: true }), // soft delete
}, (table) => [
  index("idx_cash_customers_phone").on(table.phone),
]);

// ┌─────────────────────────────────────────┐
// │   DIRECT SALES                           │
// └─────────────────────────────────────────┘

// ── Direct Sales ──
// Gate pass (agent) and cash customer sales.
// customer_type determines whether customer_id references dealers (agent) or cash_customers (cash).
export const directSales = pgTable("direct_sales", {
  id: uuid("id").defaultRandom().primaryKey(),
  gpNo: text("gp_no"),
  customerType: directSaleCustomerTypeEnum("customer_type").notNull(),
  customerId: uuid("customer_id").notNull(), // polymorphic: dealers.id or cash_customers.id
  routeId: uuid("route_id").references(() => routes.id, { onDelete: "set null" }),
  officerId: uuid("officer_id").references(() => users.id, { onDelete: "set null" }),
  batchId: uuid("batch_id").references(() => batches.id, { onDelete: "set null" }),
  saleDate: date("sale_date").notNull(),
  paymentMode: paymentModeEnum("payment_mode").notNull().default("cash"),
  paymentRef: text("payment_ref"),           // UPI ref or receipt number
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(),
  totalGst: numeric("total_gst", { precision: 10, scale: 2 }).notNull().default("0"),
  grandTotal: numeric("grand_total", { precision: 10, scale: 2 }).notNull(),
  notes: text("notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_direct_sales_customer").on(table.customerType, table.customerId),
  index("idx_direct_sales_date").on(table.saleDate),
  index("idx_direct_sales_route").on(table.routeId),
  index("idx_direct_sales_officer").on(table.officerId),
  index("idx_direct_sales_batch").on(table.batchId),
]);

// ── Direct Sale Items ──
// Line items for a direct sale. Same pattern as order_items.
// Stores snapshot of price at time of sale.
export const directSaleItems = pgTable("direct_sale_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  directSaleId: uuid("direct_sale_id")
    .notNull()
    .references(() => directSales.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "restrict" }),
  productName: text("product_name").notNull(), // snapshot: product name at sale time
  quantity: integer("quantity").notNull(),
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  gstPercent: numeric("gst_percent", { precision: 5, scale: 2 }).notNull().default("0"),
  gstAmount: numeric("gst_amount", { precision: 10, scale: 2 }).notNull().default("0"),
  lineTotal: numeric("line_total", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_direct_sale_items_sale").on(table.directSaleId),
  index("idx_direct_sale_items_product").on(table.productId),
]);

// ── Gate Pass Items ──
// Tracks issued vs returned quantities for agent gate passes.
// A gate pass is a direct_sale where customer_type = 'agent'.
// returned_quantity is updated when the agent returns unsold stock.
export const gatePassItems = pgTable("gate_pass_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  directSaleId: uuid("direct_sale_id")
    .notNull()
    .references(() => directSales.id, { onDelete: "cascade" }),
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "restrict" }),
  quantity: integer("quantity").notNull(),              // issued quantity
  returnedQuantity: integer("returned_quantity").notNull().default(0), // returned unsold
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_gate_pass_items_sale").on(table.directSaleId),
  index("idx_gate_pass_items_product").on(table.productId),
]);

// ┌─────────────────────────────────────────┐
// │   ROUTE SHEETS                           │
// └─────────────────────────────────────────┘

// ── Route Sheets ──
// Formal daily route sheet records — generated when indents are "posted" for a route.
// One route sheet per route per date per batch.
export const routeSheets = pgTable("route_sheets", {
  id: uuid("id").defaultRandom().primaryKey(),
  routeId: uuid("route_id")
    .notNull()
    .references(() => routes.id, { onDelete: "restrict" }),
  batchId: uuid("batch_id").references(() => batches.id, { onDelete: "set null" }),
  date: date("date").notNull(),
  vehicleNumber: text("vehicle_number"),
  driverName: text("driver_name"),
  contractorId: uuid("contractor_id").references(() => contractors.id, { onDelete: "set null" }),
  departureTime: time("departure_time"),
  arrivalTime: time("arrival_time"),
  totalCrates: integer("total_crates").notNull().default(0),
  totalAmount: numeric("total_amount", { precision: 12, scale: 2 }).notNull().default("0"),
  dealerCount: integer("dealer_count").notNull().default(0),
  status: routeSheetStatusEnum("status").notNull().default("draft"),
  notes: text("notes"),
  generatedBy: uuid("generated_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_route_sheets_date").on(table.date),
  index("idx_route_sheets_route").on(table.routeId),
  index("idx_route_sheets_status").on(table.status),
]);

// ┌─────────────────────────────────────────┐
// │   RELATIONS                              │
// └─────────────────────────────────────────┘

export const rateCategoriesRelations = relations(rateCategories, ({ many }) => ({
  priceEntries: many(priceChart),
}));

export const priceChartRelations = relations(priceChart, ({ one }) => ({
  product: one(products, {
    fields: [priceChart.productId],
    references: [products.id],
  }),
  rateCategory: one(rateCategories, {
    fields: [priceChart.rateCategoryId],
    references: [rateCategories.id],
  }),
  creator: one(users, {
    fields: [priceChart.createdBy],
    references: [users.id],
  }),
}));

export const cashCustomersRelations = relations(cashCustomers, ({ many }) => ({
  directSales: many(directSales),
}));

export const directSalesRelations = relations(directSales, ({ one, many }) => ({
  route: one(routes, {
    fields: [directSales.routeId],
    references: [routes.id],
  }),
  officer: one(users, {
    fields: [directSales.officerId],
    references: [users.id],
  }),
  batch: one(batches, {
    fields: [directSales.batchId],
    references: [batches.id],
  }),
  items: many(directSaleItems),
  gatePassItems: many(gatePassItems),
}));

export const directSaleItemsRelations = relations(directSaleItems, ({ one }) => ({
  directSale: one(directSales, {
    fields: [directSaleItems.directSaleId],
    references: [directSales.id],
  }),
  product: one(products, {
    fields: [directSaleItems.productId],
    references: [products.id],
  }),
}));

export const gatePassItemsRelations = relations(gatePassItems, ({ one }) => ({
  directSale: one(directSales, {
    fields: [gatePassItems.directSaleId],
    references: [directSales.id],
  }),
  product: one(products, {
    fields: [gatePassItems.productId],
    references: [products.id],
  }),
}));

export const routeSheetsRelations = relations(routeSheets, ({ one }) => ({
  route: one(routes, {
    fields: [routeSheets.routeId],
    references: [routes.id],
  }),
  batch: one(batches, {
    fields: [routeSheets.batchId],
    references: [batches.id],
  }),
  contractor: one(contractors, {
    fields: [routeSheets.contractorId],
    references: [contractors.id],
  }),
  generatedByUser: one(users, {
    fields: [routeSheets.generatedBy],
    references: [users.id],
  }),
}));
