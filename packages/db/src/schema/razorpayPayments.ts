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
    check,
  } from "drizzle-orm/pg-core";
  import { relations, sql } from "drizzle-orm";
  import { dealers } from "./dealers.js";
  
  // ── Enums ───────────────────────────────────────────────────────────
  export const razorpayPaymentKindEnum = pgEnum("razorpay_payment_kind", [
    "credit_topup",
    "order_payment",
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
      dealerId: uuid("dealer_id")
        .notNull()
        .references(() => dealers.id, { onDelete: "restrict" }),
      razorpayOrderId: text("razorpay_order_id").notNull().unique(),
      razorpayPaymentId: text("razorpay_payment_id").unique(),
      razorpaySignature: text("razorpay_signature"),
      amount: numeric("amount", { precision: 10, scale: 2 }).notNull(),
      currency: text("currency").notNull().default("INR"),
      kind: razorpayPaymentKindEnum("kind").notNull(),
      status: razorpayPaymentStatusEnum("status").notNull().default("created"),
      /** Set when kind='order_payment'. No FK because orders is partitioned. */
      orderId: uuid("order_id"),
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
      check(
        "amount_positive",
        sql`amount > 0`
      ),
      check(
        "razorpay_payments_order_id_matches_kind",
        sql`(kind = 'order_payment' AND order_id IS NOT NULL)
         OR (kind = 'credit_topup'  AND order_id IS NULL)`
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
    })
  );