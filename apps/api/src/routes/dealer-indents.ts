// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/routes/dealer-indents.ts
//
// Phase 2A — dealer-facing endpoints for the v2 redesign.
//
// All routes require `dealerAuth` (sets request.dealer = { dealerId,
// phone, zoneId }). Mirrors existing dealer-profile route style.
//
// Mounted in apps/api/src/server.ts:
//   import { dealerIndentsRoutes } from "./routes/dealer-indents.js";
//   app.register(dealerIndentsRoutes);
//
// Routes:
//   GET    /api/v1/dealer/standing-indents               list dealer's standing template
//   PUT    /api/v1/dealer/standing-indents               replace whole template (bulk upsert)
//   GET    /api/v1/dealer/standing-indents/eligible      list products eligible to be in standing
//   GET    /api/v1/dealer/drafts/:date                   fetch draft (synthesize if absent)
//   PATCH  /api/v1/dealer/drafts/:date                   replace items for a date's draft
//   POST   /api/v1/dealer/drafts/:date/confirm           draft → pending (or payment_required)
//   GET    /api/v1/dealer/indent-pauses                  list dealer's pause windows
//   POST   /api/v1/dealer/indent-pauses                  add a pause window
//   DELETE /api/v1/dealer/indent-pauses/:id              remove a pause window
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient, db } from "../lib/db.js";
import { dealerAuth } from "../middleware/dealer-auth.js";
import { checkDealerCredit } from "../lib/credit-check.js";

// ── Helpers ─────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

function getDealerId(request: FastifyRequest): string {
  const d = (request as unknown as { dealer?: { dealerId: string } }).dealer;
  if (!d?.dealerId) throw new Error("dealerAuth middleware not set");
  return d.dealerId;
}

function getDealerZoneId(request: FastifyRequest): string {
  const d = (request as unknown as { dealer?: { zoneId: string } }).dealer;
  if (!d?.zoneId) throw new Error("dealerAuth middleware not set");
  return d.zoneId;
}

/** Check whether a given delivery date falls in any active pause window. */
async function isPaused(dealerId: string, deliveryDate: string): Promise<boolean> {
  const [row] = await pgClient`
    SELECT 1
      FROM dealer_indent_pauses
     WHERE dealer_id = ${dealerId}
       AND ${deliveryDate}::date BETWEEN from_date AND to_date
     LIMIT 1
  `;
  return !!row;
}

/**
 * Compute line totals from (price_excl_gst, gst_percent, quantity).
 * Returns rupees rounded to 2dp.
 */
function calcLine(basePrice: number, gstPercent: number, qty: number) {
  const subtotal = basePrice * qty;
  const gst = subtotal * (gstPercent / 100);
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    gst: Math.round(gst * 100) / 100,
    total: Math.round((subtotal + gst) * 100) / 100,
  };
}

// ═══════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════

export async function dealerIndentsRoutes(app: FastifyInstance) {
  // ┌─────────────────────────────────────────────────┐
  // │  GET /api/v1/dealer/standing-indents              │
  // │  List the dealer's standing template              │
  // └─────────────────────────────────────────────────┘
  app.get(
    "/api/v1/dealer/standing-indents",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);

      const rows = await pgClient`
        SELECT
          dsi.product_id          AS "productId",
          dsi.default_qty         AS "defaultQty",
          dsi.active              AS "active",
          p.name                  AS "productName",
          p.unit                  AS "unit",
          p.icon                  AS "icon",
          p.image_url             AS "imageUrl",
          p.base_price::numeric   AS "basePrice",
          p.gst_percent::numeric  AS "gstPercent",
          p.available             AS "productAvailable"
        FROM dealer_standing_indents dsi
        JOIN products p ON p.id = dsi.product_id AND p.deleted_at IS NULL
        WHERE dsi.dealer_id = ${dealerId}
        ORDER BY p.sort_order, p.name
      `;

      return reply.send({ items: rows });
    }
  );

  // ┌─────────────────────────────────────────────────┐
  // │  GET /api/v1/dealer/standing-indents/eligible     │
  // │  Products the dealer COULD add to their standing  │
  // │  indent (i.e. make_zero_in_indents=false). Used   │
  // │  by the "Manage standing indent" screen to show   │
  // │  the picker.                                      │
  // └─────────────────────────────────────────────────┘
  app.get(
    "/api/v1/dealer/standing-indents/eligible",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);

      const rows = await pgClient`
        SELECT
          p.id                      AS "productId",
          p.name                    AS "productName",
          p.unit                    AS "unit",
          p.icon                    AS "icon",
          p.image_url               AS "imageUrl",
          p.base_price::numeric     AS "basePrice",
          p.gst_percent::numeric    AS "gstPercent",
          COALESCE(dsi.default_qty, 0)  AS "currentDefaultQty",
          COALESCE(dsi.active, false)   AS "currentActive"
        FROM products p
        LEFT JOIN dealer_standing_indents dsi
               ON dsi.product_id = p.id
              AND dsi.dealer_id = ${dealerId}
        WHERE p.deleted_at IS NULL
          AND p.available = true
          AND p.make_zero_in_indents = false
        ORDER BY p.sort_order, p.name
      `;

      return reply.send({ items: rows });
    }
  );

  // ┌─────────────────────────────────────────────────┐
  // │  PUT /api/v1/dealer/standing-indents              │
  // │  Replace the dealer's whole standing template.    │
  // │                                                   │
  // │  Body items[]:                                     │
  // │    { productId, defaultQty, active }              │
  // │                                                   │
  // │  Semantics: full bulk upsert. Existing rows that  │
  // │  are not in the request body remain — we don't    │
  // │  delete on omission (avoids accidental wipe-outs  │
  // │  if the client only sends a delta).                │
  // └─────────────────────────────────────────────────┘
  app.put(
    "/api/v1/dealer/standing-indents",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);

      const schema = z.object({
        items: z
          .array(
            z.object({
              productId: z.string().uuid(),
              defaultQty: z.number().int().min(0).max(10_000),
              active: z.boolean().default(true),
            })
          )
          .min(1),
      });
      const body = schema.parse(request.body);

      // Validate that all referenced products exist and are eligible
      // (admin hasn't set make_zero_in_indents=true on any of them).
      const productIds = body.items.map((i) => i.productId);
      const eligible = await pgClient`
        SELECT id::text FROM products
         WHERE id = ANY(${productIds}::uuid[])
           AND deleted_at IS NULL
           AND make_zero_in_indents = false
      `;
      const eligibleSet = new Set(eligible.map((r: any) => r.id));
      const ineligible = productIds.filter((id) => !eligibleSet.has(id));
      if (ineligible.length > 0) {
        return reply.status(400).send({
          error: "Ineligible products",
          message: "Some products are not eligible for the standing indent",
          ineligibleProductIds: ineligible,
        });
      }

      // Bulk upsert via a single statement.
      // Note: `dealer_id, product_id` is the unique index from 0030.
      await pgClient.begin(async (tx) => {
        for (const it of body.items) {
          await tx`
            INSERT INTO dealer_standing_indents (dealer_id, product_id, default_qty, active)
            VALUES (${dealerId}, ${it.productId}, ${it.defaultQty}, ${it.active})
            ON CONFLICT (dealer_id, product_id) DO UPDATE
              SET default_qty = EXCLUDED.default_qty,
                  active      = EXCLUDED.active,
                  updated_at  = now()
          `;
        }
      });

      return reply.send({ updated: body.items.length });
    }
  );

  // ┌─────────────────────────────────────────────────┐
  // │  GET /api/v1/dealer/drafts/:date                  │
  // │  Fetch the draft for that delivery date.          │
  // │                                                   │
  // │  Behavior:                                         │
  // │   1. If an existing draft/pending order exists,    │
  // │      return its items as-is.                       │
  // │   2. If no order exists yet for that date AND     │
  // │      the dealer is not in a pause window, return  │
  // │      a SYNTHESIZED draft built from the standing  │
  // │      indent. `exists: false` signals to the       │
  // │      client that nothing's persisted yet — the    │
  // │      first PATCH will create the order row.        │
  // │   3. If paused, return empty items with          │
  // │      pausedReason set.                            │
  // └─────────────────────────────────────────────────┘
  app.get(
    "/api/v1/dealer/drafts/:date",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);
      const params = z.object({ date: isoDate }).parse(request.params);

      // Pause check — short-circuit if dealer has closed shop for this day.
      const pausedRow = await pgClient`
        SELECT reason FROM dealer_indent_pauses
         WHERE dealer_id = ${dealerId}
           AND ${params.date}::date BETWEEN from_date AND to_date
         ORDER BY created_at DESC
         LIMIT 1
      `;
      if (pausedRow.length > 0) {
        return reply.send({
          deliveryDate: params.date,
          exists: false,
          paused: true,
          pausedReason: pausedRow[0]!.reason ?? null,
          status: "draft",
          items: [],
          totals: { subtotal: 0, totalGst: 0, grandTotal: 0 },
        });
      }

      // Try to find an existing draft / pending order for this date.
      const existing = await pgClient`
        SELECT o.id, o.status::text, o.subtotal::numeric, o.total_gst::numeric, o.grand_total::numeric
          FROM orders o
         WHERE o.dealer_id = ${dealerId}
           AND o.delivery_date = ${params.date}::date
           AND o.status IN ('draft', 'pending', 'payment_required')
         ORDER BY o.created_at DESC
         LIMIT 1
      `;

      if (existing.length > 0) {
        const order = existing[0];
        const items = await pgClient`
          SELECT
            oi.product_id           AS "productId",
            oi.product_name         AS "productName",
            oi.quantity             AS "quantity",
            oi.unit_price::numeric  AS "unitPrice",
            oi.gst_percent::numeric AS "gstPercent",
            oi.line_total::numeric  AS "lineTotal",
            p.icon                  AS "icon",
            p.image_url             AS "imageUrl",
            p.unit                  AS "unit"
          FROM order_items oi
          JOIN products p ON p.id = oi.product_id
          WHERE oi.order_id = ${order!.id}::uuid
          ORDER BY p.sort_order, p.name
        `;
        return reply.send({
          deliveryDate: params.date,
          exists: true,
          paused: false,
          orderId: order!.id,
          status: order!.status,
          items,
          totals: {
            subtotal: parseFloat(order!.subtotal),
            totalGst: parseFloat(order!.total_gst),
            grandTotal: parseFloat(order!.grand_total),
          },
        });
      }

      // No existing order — synthesize from standing indent.
      const standing = await pgClient`
        SELECT
          dsi.product_id          AS "productId",
          dsi.default_qty         AS "quantity",
          p.name                  AS "productName",
          p.unit                  AS "unit",
          p.icon                  AS "icon",
          p.image_url             AS "imageUrl",
          p.base_price::numeric   AS "unitPrice",
          p.gst_percent::numeric  AS "gstPercent"
        FROM dealer_standing_indents dsi
        JOIN products p ON p.id = dsi.product_id
                       AND p.deleted_at IS NULL
                       AND p.available = true
        WHERE dsi.dealer_id = ${dealerId}
          AND dsi.active = true
          AND dsi.default_qty > 0
        ORDER BY p.sort_order, p.name
      `;

      let subtotal = 0;
      let totalGst = 0;
      const items = standing.map((r: any) => {
        const qty = r.quantity;
        const price = parseFloat(r.unitPrice);
        const gstPct = parseFloat(r.gstPercent);
        const line = calcLine(price, gstPct, qty);
        subtotal += line.subtotal;
        totalGst += line.gst;
        return {
          productId: r.productId,
          productName: r.productName,
          quantity: qty,
          unitPrice: price,
          gstPercent: gstPct,
          lineTotal: line.total,
          icon: r.icon,
          imageUrl: r.imageUrl,
          unit: r.unit,
        };
      });

      return reply.send({
        deliveryDate: params.date,
        exists: false,
        paused: false,
        status: "draft",
        items,
        totals: {
          subtotal: Math.round(subtotal * 100) / 100,
          totalGst: Math.round(totalGst * 100) / 100,
          grandTotal: Math.round((subtotal + totalGst) * 100) / 100,
        },
      });
    }
  );

  // ┌─────────────────────────────────────────────────┐
  // │  PATCH /api/v1/dealer/drafts/:date                │
  // │  Replace the draft's items.                       │
  // │                                                   │
  // │  Creates the order row on first call (status=    │
  // │  'draft'); updates items + totals on subsequent  │
  // │  calls. Idempotent w.r.t. the body items list.   │
  // └─────────────────────────────────────────────────┘
  app.patch(
    "/api/v1/dealer/drafts/:date",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);
      const zoneId = getDealerZoneId(request);
      const params = z.object({ date: isoDate }).parse(request.params);

      const schema = z.object({
        items: z.array(
          z.object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(0).max(10_000),
          })
        ),
      });
      const body = schema.parse(request.body);

      // Filter out qty=0 — those are removals.
      const lineItems = body.items.filter((i) => i.quantity > 0);

      // If everything is qty=0, the dealer effectively cleared the draft.
      // We still create (or update) the row but with zero totals/items.

      // Fetch products with current prices (snapshotted onto the order).
      const productRows = lineItems.length > 0
        ? await pgClient`
            SELECT
              id::text                  AS "id",
              name                      AS "name",
              base_price::numeric       AS "basePrice",
              gst_percent::numeric      AS "gstPercent",
              available                 AS "available",
              stock                     AS "stock"
            FROM products
            WHERE id = ANY(${lineItems.map((i) => i.productId)}::uuid[])
              AND deleted_at IS NULL
          `
        : [];
      const productMap = new Map<string, any>(
        productRows.map((p: any) => [p.id, p])
      );

      // Validate all referenced products exist and are available
      for (const it of lineItems) {
        const p = productMap.get(it.productId);
        if (!p) {
          return reply.status(400).send({
            error: "Product not found",
            productId: it.productId,
          });
        }
        if (!p.available) {
          return reply.status(400).send({
            error: "Product unavailable",
            productId: it.productId,
            productName: p.name,
          });
        }
      }

      // Compute totals
      let subtotal = 0;
      let totalGst = 0;
      let itemCount = 0;
      const orderItemsRows = lineItems.map((it) => {
        const p = productMap.get(it.productId);
        const price = parseFloat(p.basePrice);
        const gstPct = parseFloat(p.gstPercent);
        const line = calcLine(price, gstPct, it.quantity);
        subtotal += line.subtotal;
        totalGst += line.gst;
        itemCount += it.quantity;
        return {
          productId: it.productId,
          productName: p.name,
          quantity: it.quantity,
          unitPrice: price.toFixed(2),
          gstPercent: gstPct.toFixed(2),
          gstAmount: line.gst.toFixed(2),
          lineTotal: line.total.toFixed(2),
        };
      });
      const grandTotal = Math.round((subtotal + totalGst) * 100) / 100;

      // Upsert order + items in a transaction
      const orderId = await pgClient.begin(async (tx) => {
        // Try to find existing draft/pending row
        const [existing] = await tx`
          SELECT id FROM orders
           WHERE dealer_id = ${dealerId}
             AND delivery_date = ${params.date}::date
             AND status IN ('draft', 'pending', 'payment_required')
           ORDER BY created_at DESC
           LIMIT 1
        `;

        let id: string;
        if (existing) {
          // Update existing row
          await tx`
            UPDATE orders SET
              subtotal     = ${subtotal.toFixed(2)}::numeric,
              total_gst    = ${totalGst.toFixed(2)}::numeric,
              grand_total  = ${grandTotal.toFixed(2)}::numeric,
              item_count   = ${itemCount},
              updated_at   = now()
            WHERE id = ${existing.id}::uuid
          `;
          // Replace items
          await tx`DELETE FROM order_items WHERE order_id = ${existing.id}::uuid`;
          id = existing.id;
        } else {
          // Insert new draft row
          const [created] = await tx`
            INSERT INTO orders (
              dealer_id, zone_id, status, payment_mode,
              subtotal, total_gst, grand_total, item_count,
              delivery_date
            ) VALUES (
              ${dealerId}, ${zoneId}, 'draft', 'credit',
              ${subtotal.toFixed(2)}::numeric,
              ${totalGst.toFixed(2)}::numeric,
              ${grandTotal.toFixed(2)}::numeric,
              ${itemCount},
              ${params.date}::date
            )
            RETURNING id
          `;
          id = created!.id;
        }

        // Insert items
        for (const oi of orderItemsRows) {
          await tx`
            INSERT INTO order_items (
              order_id, product_id, product_name, quantity,
              unit_price, gst_percent, gst_amount, line_total
            ) VALUES (
              ${id}::uuid, ${oi.productId}::uuid, ${oi.productName},
              ${oi.quantity}, ${oi.unitPrice}::numeric, ${oi.gstPercent}::numeric,
              ${oi.gstAmount}::numeric, ${oi.lineTotal}::numeric
            )
          `;
        }

        return id;
      });

      return reply.send({
        orderId,
        deliveryDate: params.date,
        status: "draft",
        totals: {
          subtotal: Math.round(subtotal * 100) / 100,
          totalGst: Math.round(totalGst * 100) / 100,
          grandTotal,
        },
        itemCount,
      });
    }
  );

  // ┌─────────────────────────────────────────────────┐
  // │  POST /api/v1/dealer/drafts/:date/confirm         │
  // │  Move draft → pending (or payment_required).      │
  // │                                                   │
  // │  Body:                                            │
  // │    { paymentMode: 'credit' | 'razorpay',         │
  // │      razorpayPaymentId?: string }                │
  // │                                                   │
  // │  Credit path: runs credit-check. If sufficient,   │
  // │  status='pending'. If not, status='payment_      │
  // │  required' and the response includes shortfall   │
  // │  + topup hint.                                    │
  // │                                                   │
  // │  Razorpay path (Phase 2B): verifies the          │
  // │  razorpayPaymentId, then status='pending'.       │
  // │  Phase 2A returns 501 for the razorpay path.     │
  // └─────────────────────────────────────────────────┘
  app.post(
    "/api/v1/dealer/drafts/:date/confirm",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);
      const params = z.object({ date: isoDate }).parse(request.params);

      const schema = z.object({
        paymentMode: z.enum(["credit", "razorpay"]),
        razorpayPaymentId: z.string().optional(),
      });
      const body = schema.parse(request.body);

      // Find the draft order
      const [draft] = await pgClient`
        SELECT id, grand_total::numeric AS grand_total, item_count
          FROM orders
         WHERE dealer_id = ${dealerId}
           AND delivery_date = ${params.date}::date
           AND status = 'draft'
         ORDER BY created_at DESC
         LIMIT 1
      `;

      if (!draft) {
        return reply.status(404).send({
          error: "No draft to confirm",
          message:
            "There's no draft order for this date. PATCH the draft first.",
        });
      }

      if (draft.item_count === 0) {
        return reply.status(400).send({
          error: "Empty draft",
          message: "Cannot confirm an empty draft. Add items first.",
        });
      }

      const grandTotal = parseFloat(draft.grand_total);

      // ── Razorpay path (Phase 2B) ──
      if (body.paymentMode === "razorpay") {
        return reply.status(501).send({
          error: "Not implemented",
          message:
            "Razorpay payment confirmation will land in Phase 2B (after SDK + webhook setup).",
        });
      }

      // ── Credit path ──
      const credit = await checkDealerCredit(dealerId, grandTotal);

      if (!credit.sufficient) {
        // Mark order as payment_required and return the shortfall info
        await pgClient`
          UPDATE orders
             SET status = 'payment_required', updated_at = now()
           WHERE id = ${draft.id}::uuid
        `;
        return reply.status(402).send({
          error: "Credit limit exceeded",
          message: `Order is over your available credit by ₹${credit.shortfall.toFixed(2)}`,
          orderId: draft.id,
          credit,
        });
      }

      // Sufficient — mark pending. Outstanding gets recomputed on next
      // credit check (we don't materialize it on the dealer row).
      await pgClient`
        UPDATE orders
           SET status = 'pending',
               payment_mode = 'credit',
               confirmed_at = now(),
               updated_at = now()
         WHERE id = ${draft.id}::uuid
      `;

      return reply.send({
        orderId: draft.id,
        status: "pending",
        deliveryDate: params.date,
        credit,
      });
    }
  );

  // ┌─────────────────────────────────────────────────┐
  // │  Pause windows CRUD                               │
  // └─────────────────────────────────────────────────┘

  app.get(
    "/api/v1/dealer/indent-pauses",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);
      const rows = await pgClient`
        SELECT
          id,
          from_date::text  AS "fromDate",
          to_date::text    AS "toDate",
          reason,
          created_at       AS "createdAt"
        FROM dealer_indent_pauses
        WHERE dealer_id = ${dealerId}
        ORDER BY from_date DESC
      `;
      return reply.send({ pauses: rows });
    }
  );

  app.post(
    "/api/v1/dealer/indent-pauses",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);
      const schema = z.object({
        fromDate: isoDate,
        toDate: isoDate,
        reason: z.string().max(200).optional(),
      });
      const body = schema.parse(request.body);

      if (body.toDate < body.fromDate) {
        return reply.status(400).send({
          error: "Invalid range",
          message: "toDate must be on or after fromDate",
        });
      }

      const [row] = await pgClient`
        INSERT INTO dealer_indent_pauses (dealer_id, from_date, to_date, reason)
        VALUES (${dealerId}, ${body.fromDate}::date, ${body.toDate}::date,
                ${body.reason ?? null})
        RETURNING id, from_date::text AS "fromDate", to_date::text AS "toDate",
                  reason, created_at AS "createdAt"
      `;
      return reply.status(201).send({ pause: row });
    }
  );

  app.delete(
    "/api/v1/dealer/indent-pauses/:id",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);
      const params = z.object({ id: z.string().uuid() }).parse(request.params);

      const result = await pgClient`
        DELETE FROM dealer_indent_pauses
         WHERE id = ${params.id}::uuid AND dealer_id = ${dealerId}
         RETURNING id
      `;
      if (result.length === 0) {
        return reply.status(404).send({ error: "Pause not found" });
      }
      return reply.send({ deleted: params.id });
    }
  );
}