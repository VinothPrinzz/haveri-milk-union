import {
  pgTable,
  uuid,
  text,
  timestamp,
  numeric,
  integer,
  index,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import {
  orderStatusEnum,
  paymentModeEnum,
  cancellationStatusEnum,
} from "./enums.js";
import { zones } from "./zones.js";
import { dealers } from "./dealers.js";
import { products } from "./products.js";

// ── Orders ──
// CRITICAL: This table is PARTITIONED BY RANGE (created_at) in the migration SQL.
// Drizzle does not natively support partitioned tables, so the partition DDL is in the
// raw migration file. The schema here defines the logical columns + relations for the ORM.
//
// Partitioning keeps report queries fast by scanning only the relevant month's partition.
// A BullMQ job creates next month's partition on the 25th of each month.
//
// Phase 2: Added officer_id for sales officer tracking on call-desk / officer-placed orders.
export const orders = pgTable("orders", {
  id: uuid("id").defaultRandom().notNull(),
  dealerId: uuid("dealer_id").notNull(), // FK enforced via migration SQL (partitioned tables need manual FK)
  zoneId: uuid("zone_id").notNull(),
  status: orderStatusEnum("status").notNull().default("pending"),
  paymentMode: paymentModeEnum("payment_mode").notNull().default("wallet"),
  paymentReference: text("payment_reference"), // UPI transaction ID if paid via UPI
  subtotal: numeric("subtotal", { precision: 10, scale: 2 }).notNull(), // before GST
  totalGst: numeric("total_gst", { precision: 10, scale: 2 }).notNull(),
  grandTotal: numeric("grand_total", { precision: 10, scale: 2 }).notNull(), // subtotal + totalGst
  itemCount: integer("item_count").notNull().default(0),
  notes: text("notes"), // dealer's order notes
  placedBy: uuid("placed_by"), // null = dealer placed it; set to admin user ID if Call Desk placed
  officerId: uuid("officer_id"), // Phase 2: sales officer who processed this order (no FK on partitioned table)
  confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
  dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
  cancellationReason: text("cancellation_reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // These indexes are created in migration SQL because Drizzle can't create
  // indexes on partitioned tables directly. Defined here for documentation.
  // index("idx_orders_dealer_created").on(table.dealerId, table.createdAt),
  // index("idx_orders_zone_status_created").on(table.zoneId, table.status, table.createdAt),
  // Partial index on actionable statuses: WHERE status IN ('pending', 'confirmed')
]);

// ── Order Items ──
// Each line item in an order. Stores snapshot of price at time of order (not current price).
export const orderItems = pgTable("order_items", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull(), // references orders(id) — no FK because orders is partitioned
  productId: uuid("product_id")
    .notNull()
    .references(() => products.id, { onDelete: "restrict" }),
  productName: text("product_name").notNull(), // snapshot: product name at order time
  quantity: integer("quantity").notNull(),
  unitPrice: numeric("unit_price", { precision: 10, scale: 2 }).notNull(),
  gstPercent: numeric("gst_percent", { precision: 5, scale: 2 }).notNull(),
  gstAmount: numeric("gst_amount", { precision: 10, scale: 2 }).notNull(),
  lineTotal: numeric("line_total", { precision: 10, scale: 2 }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_order_items_order").on(table.orderId),
  index("idx_order_items_product").on(table.productId),
]);

// ── Cancellation Requests ──
export const cancellationRequests = pgTable("cancellation_requests", {
  id: uuid("id").defaultRandom().primaryKey(),
  orderId: uuid("order_id").notNull(), // reference to order
  dealerId: uuid("dealer_id")
    .notNull()
    .references(() => dealers.id, { onDelete: "restrict" }),
  reason: text("reason").notNull(),
  status: cancellationStatusEnum("status").notNull().default("pending"),
  reviewedBy: uuid("reviewed_by"), // admin user
  reviewNote: text("review_note"),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_cancellation_requests_order").on(table.orderId),
  index("idx_cancellation_requests_dealer").on(table.dealerId),
  index("idx_cancellation_requests_status").on(table.status),
]);

// ── Relations ──
export const ordersRelations = relations(orders, ({ one, many }) => ({
  dealer: one(dealers, {
    fields: [orders.dealerId],
    references: [dealers.id],
  }),
  zone: one(zones, {
    fields: [orders.zoneId],
    references: [zones.id],
  }),
  items: many(orderItems),
  cancellationRequest: one(cancellationRequests, {
    fields: [orders.id],
    references: [cancellationRequests.orderId],
  }),
}));

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, {
    fields: [orderItems.orderId],
    references: [orders.id],
  }),
  product: one(products, {
    fields: [orderItems.productId],
    references: [products.id],
  }),
}));

export const cancellationRequestsRelations = relations(cancellationRequests, ({ one }) => ({
  order: one(orders, {
    fields: [cancellationRequests.orderId],
    references: [orders.id],
  }),
  dealer: one(dealers, {
    fields: [cancellationRequests.dealerId],
    references: [dealers.id],
  }),
}));
