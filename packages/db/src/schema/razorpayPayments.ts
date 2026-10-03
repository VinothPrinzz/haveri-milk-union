// ═══════════════════════════════════════════════════════════════════════
// packages/db/src/schema/razorpayPayments.ts
//
// Mirrors migration 0032_razorpay_payments.sql.
// ═══════════════════════════════════════════════════════════════════════

import {
    pgTable,
    pgEnum,
    uuid,
    text,
    boolean,
    numeric,
    timestamp,
    jsonb,
    index,
    uniqueIndex,
    check,
  } from "drizzle-orm/pg-core";
  import { relations, sql } from "drizzle-orm";
  import { dealers } from "./dealers.js";
  import { directSales } from "./marketing.js";

  // ── Enums ───────────────────────────────────────────────────────────
  export const razorpayPaymentKindEnum = pgEnum("razorpay_payment_kind", [
    "credit_topup",
    "order_payment",
    // Counter payment for a gate-pass sale, collected by scanning a
    // per-sale Razorpay QR. Migration 0067. Unlike the two dealer kinds
    // this row has NO razorpay order (a QR payment has none) and points
    // at a direct_sale instead of an order — see the shape CHECK.
    "gate_pass",
  ]);
  
  export const razorpayPaymentStatusEnum = pgEnum("razorpay_payment_status", [
    "created",
    "attempted",
    "paid",
    "failed",
    "refunded",
  ]);
  
  // ── Table ───────────────────────────────────────────────────────────
  export const razorpayPayments = pgTable(
    "razorpay_payments",
    {
      id: uuid("id").defaultRandom().primaryKey(),
      /**
       * Always set, including kind='gate_pass' — a gate-pass agent IS a
       * dealers row (direct_sales.customer_id is polymorphic and the
       * 'agent' branch joins dealers).
       */
      dealerId: uuid("dealer_id")
        .notNull()
        .references(() => dealers.id, { onDelete: "restrict" }),
      /** NULL for kind='gate_pass' — a QR payment has no Razorpay order. */
      razorpayOrderId: text("razorpay_order_id").unique(),
      razorpayPaymentId: text("razorpay_payment_id").unique(),
      razorpaySignature: text("razorpay_signature"),
      amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
      currency: text("currency").notNull().default("INR"),
      kind: razorpayPaymentKindEnum("kind").notNull(),
      status: razorpayPaymentStatusEnum("status").notNull().default("created"),
      /** Set when kind='order_payment'. No FK because orders is partitioned. */
      orderId: uuid("order_id"),
      /**
       * Set when kind='gate_pass'. The qr_code.credited webhook can only
       * identify a row by this — its payload names the QR and the payment,
       * never an order.
       */
      razorpayQrCodeId: text("razorpay_qr_code_id"),
      /** Set when kind='gate_pass'. direct_sales is not partitioned, so a real FK. */
      directSaleId: uuid("direct_sale_id").references(() => directSales.id, {
        onDelete: "restrict",
      }),
      notes: jsonb("notes"),
      webhookReceived: boolean("webhook_received").notNull().default(false),
      errorCode: text("error_code"),
      errorDescription: text("error_description"),
      createdAt: timestamp("created_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      updatedAt: timestamp("updated_at", { withTimezone: true })
        .notNull()
        .defaultNow(),
      paidAt: timestamp("paid_at", { withTimezone: true }),
    },
    (table) => [
      index("idx_razorpay_payments_dealer").on(
        table.dealerId,
        table.createdAt
      ),
      index("idx_razorpay_payments_order")
        .on(table.orderId)
        .where(sql`order_id IS NOT NULL`),
      index("idx_razorpay_payments_direct_sale")
        .on(table.directSaleId)
        .where(sql`direct_sale_id IS NOT NULL`),
      uniqueIndex("idx_razorpay_payments_qr_code")
        .on(table.razorpayQrCodeId)
        .where(sql`razorpay_qr_code_id IS NOT NULL`),
      check(
        "amount_positive",
        sql`amount > 0`
      ),
      // Migration 0068. Each kind has exactly one legal column shape;
      // gate_pass is the odd one out (no razorpay order, a direct sale
      // and a QR instead).
      check(
        "razorpay_payments_shape_matches_kind",
        sql`(kind = 'credit_topup'
              AND razorpay_order_id IS NOT NULL
              AND order_id IS NULL AND direct_sale_id IS NULL
              AND razorpay_qr_code_id IS NULL)
         OR (kind = 'order_payment'
              AND razorpay_order_id IS NOT NULL
              AND order_id IS NOT NULL AND direct_sale_id IS NULL
              AND razorpay_qr_code_id IS NULL)
         OR (kind = 'gate_pass'
              AND razorpay_order_id IS NULL
              AND order_id IS NULL AND direct_sale_id IS NOT NULL
              AND razorpay_qr_code_id IS NOT NULL)`
      ),
    ]
  );
  
  // ── Relations ───────────────────────────────────────────────────────
  export const razorpayPaymentsRelations = relations(
    razorpayPayments,
    ({ one }) => ({
      dealer: one(dealers, {
        fields: [razorpayPayments.dealerId],
        references: [dealers.id],
      }),
      directSale: one(directSales, {
        fields: [razorpayPayments.directSaleId],
        references: [directSales.id],
      }),
    })
  );