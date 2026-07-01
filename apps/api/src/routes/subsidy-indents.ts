// apps/api/src/routes/subsidy-indents.ts
// ═══════════════════════════════════════════════════════════════════════
// Customer subsidy indents — HTM 1000ML (sub).
//
// A dedicated Call-Desk surface for recording indents of the subsidised
// HTM 1000ML pouch (the customer pays 50%). It behaves like the Record
// Indents flow — a real, confirmed order that posts a credit-ledger debit
// and mints a GST invoice — but is locked to a single product resolved
// server-side (products.code = 'PD0191S', seeded by migration 0056).
//
// One-order-per-date invariant
// ─────────────────────────────
// uq_orders_dealer_delivery_active (migration 0034) allows AT MOST ONE
// non-cancelled order per (dealer_id, delivery_date). A subsidy indent
// therefore cannot be a second standalone order when the customer already
// has a regular indent that day. So this endpoint is CREATE-OR-APPEND:
//   • no order for the date  → create a new 'confirmed' order with the
//                              subsidy line;
//   • an editable order exists → replace/set the subsidy line on it and
//                                re-total (other lines untouched).
// Either way the invariant holds and the line lands on the customer's
// order for that delivery date, so it shows in the route-sheet column.
//
//   • reads  → requireRole("orders.view")
//   • writes → requireRole("orders.create")
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { checkDealerCredit } from "../lib/credit-check.js";
import { enqueuePDFInvoice, enqueuePushNotification } from "../lib/queue.js";
import { generateInvoicePdfSync } from "../lib/invoice-pdf.js";

// The subsidy SKU seeded by migration 0056 (half-price HTM 1000ML).
const SUBSIDY_PRODUCT_CODE = "PD0191S";

const round2 = (n: number) => Math.round(n * 100) / 100;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

function adminUserId(request: FastifyRequest): string {
  const a = (request as unknown as { admin?: { userId: string } }).admin;
  if (!a?.userId) throw new Error("adminAuth middleware not set");
  return a.userId;
}

interface SubsidyProduct {
  id: string;
  name: string;
  base_price: string;
  gst_percent: string;
  available: boolean;
}

async function loadSubsidyProduct(): Promise<SubsidyProduct | undefined> {
  const [p] = await pgClient`
    SELECT id, name,
           base_price::numeric  AS base_price,
           gst_percent::numeric AS gst_percent,
           available
      FROM products
     WHERE code = ${SUBSIDY_PRODUCT_CODE} AND deleted_at IS NULL
     LIMIT 1
  `;
  return p as unknown as SubsidyProduct | undefined;
}

/** Ledger running balance for a dealer (same maths as orders.ts / admin-indents.ts). */
async function currentBalance(tx: typeof pgClient, dealerId: string): Promise<number> {
  const [bal] = await tx`
    SELECT
      COALESCE(d.opening_balance, 0)
      + COALESCE((SELECT SUM(CASE WHEN dl.type = 'credit'
                                   AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                  THEN dl.amount ELSE 0 END)
                    FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      - COALESCE((SELECT SUM(CASE WHEN dl.type = 'debit'
                                   AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                  THEN dl.amount ELSE 0 END)
                    FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      AS bal
    FROM dealers d WHERE d.id = ${dealerId}
  `;
  return parseFloat(bal!.bal);
}

export async function subsidyIndentsRoutes(app: FastifyInstance) {
  // ┌───────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/orders/subsidy-product                                │
  // │  The single product this page places, for label + rate display.   │
  // └───────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/orders/subsidy-product",
    { preHandler: [adminAuth, requireRole("orders.view")] },
    async (_request, reply) => {
      const p = await loadSubsidyProduct();
      if (!p) {
        return reply.status(404).send({
          error: "Subsidy product not configured",
          message: "HTM 1000ML (sub) is missing — run migration 0056.",
        });
      }
      return reply.send({
        product: {
          id: p.id,
          name: p.name,
          unitPrice: round2(parseFloat(p.base_price)),
          gstPercent: round2(parseFloat(p.gst_percent)),
          available: p.available,
        },
      });
    }
  );

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  POST /api/v1/orders/subsidy-place                                 │
  // │  Record a subsidy indent (create-or-append onto the day's order).  │
  // └───────────────────────────────────────────────────────────────────┘
  app.post(
    "/api/v1/orders/subsidy-place",
    { preHandler: [adminAuth, requireRole("orders.create")] },
    async (request, reply) => {
      const body = z
        .object({
          customerId: z.string().uuid(),
          routeId: z.string().uuid().nullable().optional(),
          paymentMode: z.enum(["upi", "credit", "cash"]).default("credit"),
          paymentReference: z.string().optional(),
          notes: z.string().optional(),
          quantity: z.number().int().min(1).max(100_000),
          deliveryDate: isoDate.optional(),
        })
        .parse(request.body);

      if (body.paymentMode === "upi" && !body.paymentReference?.trim()) {
        return reply.status(400).send({ error: "paymentReference is required for UPI" });
      }

      // ── Resolve customer + subsidy product ──
      const [dealer] = await pgClient`
        SELECT id, zone_id FROM dealers WHERE id = ${body.customerId} AND deleted_at IS NULL
      `;
      if (!dealer) return reply.status(404).send({ error: "Customer not found" });
      if (!dealer.zone_id) {
        return reply.status(409).send({
          error: "Customer has no zone",
          message: "Assign a zone to this customer before placing indents.",
        });
      }

      const product = await loadSubsidyProduct();
      if (!product) {
        return reply.status(404).send({ error: "Subsidy product not configured" });
      }
      if (!product.available) {
        return reply.status(400).send({ error: "HTM 1000ML (sub) is currently unavailable" });
      }

      // ── Line maths (priced at the subsidy base_price) ──
      const price = parseFloat(product.base_price);
      const gstPct = parseFloat(product.gst_percent);
      const lineSub = round2(price * body.quantity);
      const lineGst = round2(lineSub * (gstPct / 100));
      const lineTotal = round2(lineSub + lineGst);

      // ── Delivery date (default: today, IST) ──
      // to_char keeps it a 'YYYY-MM-DD' string so the ::date casts below
      // don't have to round-trip a JS Date through the driver.
      const [d] = await pgClient`
        SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today
      `;
      const deliveryDate = body.deliveryDate ?? String(d!.today);

      // ── Existing non-cancelled order for this customer + delivery date? ──
      const [existing] = await pgClient`
        SELECT o.id, o.status::text AS status,
               COALESCE(oi.line_total, 0)::numeric AS existing_sub_total
          FROM orders o
          LEFT JOIN order_items oi
                 ON oi.order_id = o.id AND oi.product_id = ${product.id}::uuid
         WHERE o.dealer_id = ${body.customerId}
           AND o.delivery_date = ${deliveryDate}::date
           AND o.status <> 'cancelled'
         ORDER BY o.created_at DESC
         LIMIT 1
      `;

      if (existing && (existing.status === "dispatched" || existing.status === "delivered")) {
        return reply.status(409).send({
          error: "Order already dispatched",
          message: `This customer's indent for ${deliveryDate} is already ${existing.status} and can no longer be changed.`,
        });
      }

      const oldSubTotal = existing ? parseFloat(existing.existing_sub_total) : 0;
      // What this action actually charges to credit: the DELTA over any
      // subsidy line already on the order (set-not-add semantics).
      const chargeDelta = round2(lineTotal - oldSubTotal);

      // ── Credit gate (only when this action increases the credit debit) ──
      if (body.paymentMode === "credit" && chargeDelta > 0) {
        const credit = await checkDealerCredit(body.customerId, chargeDelta);
        if (!credit.sufficient) {
          return reply.status(402).send({
            error: "Credit limit exceeded",
            message: `Available credit ₹${credit.available.toFixed(2)} is short of this subsidy indent by ₹${credit.shortfall.toFixed(2)}.`,
            credit,
          });
        }
      }

      // ── Persist: create a new order, or append onto the day's order ──
      const orderId: string = await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        let id: string;
        let notesForOrder = body.notes ?? null;

        if (!existing) {
          // Fresh confirmed order carrying just the subsidy line.
          const [order] = await tx`
            INSERT INTO orders (
              dealer_id, zone_id, status, payment_mode, payment_reference,
              subtotal, total_gst, grand_total, item_count, notes,
              delivery_date, placed_by, confirmed_at, created_at, updated_at
            ) VALUES (
              ${body.customerId}, ${dealer.zone_id}, 'confirmed', ${body.paymentMode},
              ${body.paymentReference ?? null},
              ${lineSub.toFixed(2)}::numeric, ${lineGst.toFixed(2)}::numeric,
              ${lineTotal.toFixed(2)}::numeric, 1, ${notesForOrder},
              ${deliveryDate}::date, ${adminUserId(request)}, now(), now(), now()
            )
            RETURNING id
          `;
          id = order!.id;

          await tx`
            INSERT INTO order_items (
              order_id, product_id, product_name, quantity,
              unit_price, gst_percent, gst_amount, line_total
            ) VALUES (
              ${id}::uuid, ${product.id}::uuid, ${product.name}, ${body.quantity},
              ${price.toFixed(2)}::numeric, ${gstPct.toFixed(2)}::numeric,
              ${lineGst.toFixed(2)}::numeric, ${lineTotal.toFixed(2)}::numeric
            )
          `;
        } else {
          // Set the subsidy line on the existing order, then re-total from
          // ALL its items so the other lines are left exactly as they were.
          id = existing.id;
          await tx`
            DELETE FROM order_items
             WHERE order_id = ${id}::uuid AND product_id = ${product.id}::uuid
          `;
          await tx`
            INSERT INTO order_items (
              order_id, product_id, product_name, quantity,
              unit_price, gst_percent, gst_amount, line_total
            ) VALUES (
              ${id}::uuid, ${product.id}::uuid, ${product.name}, ${body.quantity},
              ${price.toFixed(2)}::numeric, ${gstPct.toFixed(2)}::numeric,
              ${lineGst.toFixed(2)}::numeric, ${lineTotal.toFixed(2)}::numeric
            )
          `;

          const [tot] = await tx`
            SELECT
              COALESCE(SUM(line_total), 0)::numeric                     AS grand_total,
              COALESCE(SUM(gst_amount), 0)::numeric                     AS total_gst,
              COALESCE(SUM(line_total) - SUM(gst_amount), 0)::numeric   AS subtotal,
              COUNT(*)::int                                            AS item_count
            FROM order_items WHERE order_id = ${id}::uuid
          `;
          await tx`
            UPDATE orders SET
              subtotal    = ${tot!.subtotal}::numeric,
              total_gst   = ${tot!.total_gst}::numeric,
              grand_total = ${tot!.grand_total}::numeric,
              item_count  = ${tot!.item_count},
              notes       = COALESCE(${body.notes ?? null}, notes),
              updated_at  = now()
            WHERE id = ${id}::uuid
          `;
        }

        // ── Credit ledger movement for the delta (subsidy portion only) ──
        // UPI and cash subsidy indents are paid at the counter (UPI captures
        // a reference; cash needs none) and post no ledger row. Only credit
        // indents debit/credit the dealer's line by the delta.
        if (body.paymentMode === "credit" && chargeDelta !== 0) {
          const bal = await currentBalance(tx, body.customerId);
          if (chargeDelta > 0) {
            await tx`
              INSERT INTO dealer_ledger
                (dealer_id, type, amount, reference_id, reference_type,
                 voucher_type, voucher_date, description, balance_after, performed_by)
              VALUES
                (${body.customerId}, 'debit', ${chargeDelta.toFixed(2)}::numeric,
                 ${id}, 'order', 'Invoice', now()::date,
                 ${"Subsidy indent " + id}, ${(bal - chargeDelta).toFixed(2)}::numeric,
                 ${adminUserId(request)})
            `;
          } else {
            const refund = Math.abs(chargeDelta);
            await tx`
              INSERT INTO dealer_ledger
                (dealer_id, type, amount, reference_id, reference_type,
                 voucher_type, voucher_date, description, balance_after, performed_by)
              VALUES
                (${body.customerId}, 'credit', ${refund.toFixed(2)}::numeric,
                 ${id}, 'adjustment', 'Adjustment', now()::date,
                 ${"Subsidy indent revised " + id}, ${(bal + refund).toFixed(2)}::numeric,
                 ${adminUserId(request)})
            `;
          }
        }

        return id;
      });

      // ── Invoice (re)generation + push (best-effort, outside the tx) ──
      try {
        await enqueuePDFInvoice(orderId);
      } catch (err) {
        console.warn("[subsidy] PDF enqueue failed:", err);
      }
      if (!existing) {
        try {
          await enqueuePushNotification({
            event: "order.confirmed",
            dealerId: body.customerId,
            orderId,
          });
        } catch (err) {
          console.warn("[subsidy] Push enqueue failed:", err);
        }
      }

      let invoiceNumber: string | null = null;
      let invoicePdfUrl: string | null = null;
      try {
        const pdf = await generateInvoicePdfSync(orderId);
        invoicePdfUrl = pdf?.pdfUrl ?? null;
        const [inv] = await pgClient`
          SELECT invoice_number FROM invoices WHERE order_id = ${orderId} LIMIT 1
        `;
        invoiceNumber = inv?.invoice_number ?? null;
      } catch (err) {
        console.error("[subsidy] Invoice generation failed:", err);
      }

      return reply.status(201).send({
        message: existing
          ? "Subsidy indent added to the customer's indent for this date"
          : "Subsidy indent placed successfully",
        orderId,
        status: "confirmed",
        deliveryDate,
        appended: !!existing,
        quantity: body.quantity,
        lineTotal: lineTotal.toFixed(2),
        invoiceNumber,
        invoicePdfUrl,
      });
    }
  );
}
