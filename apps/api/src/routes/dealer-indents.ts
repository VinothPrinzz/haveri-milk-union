// ═══════════════════════════════════════════════════════════════════════
// apps/api/src/routes/dealer-indents.ts  —  BUILD-FIXED VERSION
//
// FIXES vs the previous version:
//   1. Removed the unused `db` import (only `pgClient` is used).
//   2. Removed the unused `isPaused()` helper (dead code).
//   3. CRITICAL: every `pgClient.begin(async (tx) => ...)` now casts
//      the transaction handle:
//        const tx = _tx as unknown as typeof pgClient;
//      The `postgres` library's TransactionSql type drops the
//      tagged-template call signature, so `tx`...`` is a TYPE ERROR
//      without the cast — which failed the whole `tsc` build and
//      404'd every route in this file. (Same pattern the existing
//      orders.ts already uses.)
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
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

/** Line totals from (price_excl_gst, gst_percent, quantity), rupees @ 2dp. */
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
  // ── GET /api/v1/dealer/standing-indents ──
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

  // ── GET /api/v1/dealer/standing-indents/eligible ──
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

  // ── PUT /api/v1/dealer/standing-indents ──
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

      const rows = body.items.map((it) => ({
        dealer_id:   dealerId,
        product_id:  it.productId,
        default_qty: it.defaultQty,
        active:      it.active,
      }));

      await pgClient`
        INSERT INTO dealer_standing_indents
          ${pgClient(rows, "dealer_id", "product_id", "default_qty", "active")}
        ON CONFLICT (dealer_id, product_id) DO UPDATE
          SET default_qty = EXCLUDED.default_qty,
              active      = EXCLUDED.active,
              updated_at  = now()
      `;

      return reply.send({ updated: body.items.length });
    }
  );

  app.get(
    "/api/v1/dealer/drafts/:date",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);
      const params = z.object({ date: isoDate }).parse(request.params);
   
      // Pause check
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
   
      // ── FIX: surface the order in ANY non-cancelled status, not just
      // draft/pending/payment_required. This is what lets the app show a
      // read-only "Indent placed" view for confirmed/dispatched/delivered
      // orders instead of (wrongly) re-synthesizing an editable preview.
      const existing = await pgClient`
        SELECT o.id, o.status::text AS status,
               o.subtotal::numeric    AS subtotal,
               o.total_gst::numeric   AS total_gst,
               o.grand_total::numeric AS grand_total
          FROM orders o
         WHERE o.dealer_id = ${dealerId}
           AND o.delivery_date = ${params.date}::date
           AND o.status <> 'cancelled'
         ORDER BY o.created_at DESC
         LIMIT 1
      `;
   
      if (existing.length > 0) {
        const order = existing[0]!;
        const rawItems = await pgClient`
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
          WHERE oi.order_id = ${order.id}::uuid
          ORDER BY p.sort_order, p.name
        `;
        // ── CRITICAL FIX (app crash) ──────────────────────────────────
        // The `postgres` driver returns numeric/decimal columns as JS
        // STRINGS, not numbers. The synthesized-preview branch below
        // already parseFloat()s them, but this branch was sending the
        // raw query rows straight through — so `unitPrice`/`gstPercent`/
        // `lineTotal` reached the mobile app as strings. The Indent
        // screen then called `.toFixed()` on a string, which throws and
        // crashes (closes) the app the moment you open the Indent tab on
        // a date whose order is already placed. Coerce every numeric
        // here so the existing-order shape matches the preview shape.
        const items = rawItems.map((r: any) => ({
          productId: r.productId,
          productName: r.productName,
          quantity: Number(r.quantity),
          unitPrice: parseFloat(r.unitPrice),
          gstPercent: parseFloat(r.gstPercent),
          lineTotal: parseFloat(r.lineTotal),
          icon: r.icon,
          imageUrl: r.imageUrl,
          unit: r.unit,
        }));
        return reply.send({
          deliveryDate: params.date,
          exists: true,
          paused: false,
          orderId: order.id,
          status: order.status, // draft | pending | payment_required | confirmed | dispatched | delivered
          items,
          totals: {
            subtotal: parseFloat(order.subtotal),
            totalGst: parseFloat(order.total_gst),
            grandTotal: parseFloat(order.grand_total),
          },
        });
      }
   
      // No order at all (or only a cancelled one) → synthesize a preview
      // from the standing indent.
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
   
  // ── PATCH /api/v1/dealer/drafts/:date ──
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
      const lineItems = body.items.filter((i) => i.quantity > 0);
   
      // ── FIX: if an order for this date already exists and is no longer a
      // draft, it has been placed — reject the edit instead of mutating a
      // placed order or inserting a duplicate.
      const [active] = await pgClient`
        SELECT id, status::text AS status FROM orders
         WHERE dealer_id = ${dealerId}
           AND delivery_date = ${params.date}::date
           AND status <> 'cancelled'
         ORDER BY created_at DESC
         LIMIT 1
      `;
      if (active && active.status !== "draft") {
        return reply.status(409).send({
          error: "Order already placed",
          message:
            "This date's indent is already confirmed and can no longer be edited.",
          status: active.status,
        });
      }
   
      const productRows =
        lineItems.length > 0
          ? await pgClient`
              SELECT
                id::text             AS "id",
                name                 AS "name",
                base_price::numeric  AS "basePrice",
                gst_percent::numeric AS "gstPercent",
                available            AS "available"
              FROM products
              WHERE id = ANY(${lineItems.map((i) => i.productId)}::uuid[])
                AND deleted_at IS NULL
            `
          : [];
      const productMap = new Map<string, any>(
        productRows.map((p: any) => [p.id, p])
      );
   
      for (const it of lineItems) {
        const p = productMap.get(it.productId);
        if (!p) {
          return reply
            .status(400)
            .send({ error: "Product not found", productId: it.productId });
        }
        if (!p.available) {
          return reply.status(400).send({
            error: "Product unavailable",
            productId: it.productId,
            productName: p.name,
          });
        }
      }
   
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
   
      const orderId = await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
   
        // Only ever update an existing DRAFT. (A placed order was already
        // rejected above; this guard keeps the transaction consistent.)
        const [existing] = await tx`
          SELECT id FROM orders
           WHERE dealer_id = ${dealerId}
             AND delivery_date = ${params.date}::date
             AND status = 'draft'
           ORDER BY created_at DESC
           LIMIT 1
        `;
   
        let id: string;
        if (existing) {
          await tx`
            UPDATE orders SET
              subtotal    = ${subtotal.toFixed(2)}::numeric,
              total_gst   = ${totalGst.toFixed(2)}::numeric,
              grand_total = ${grandTotal.toFixed(2)}::numeric,
              item_count  = ${itemCount},
              updated_at  = now()
            WHERE id = ${existing.id}::uuid
          `;
          await tx`DELETE FROM order_items WHERE order_id = ${existing.id}::uuid`;
          id = existing.id;
        } else {
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
   
  // ── POST /api/v1/dealer/drafts/:date/confirm ──
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
 
      // Look at ANY non-cancelled order for this date (not just 'draft').
      const [order] = await pgClient`
        SELECT id, status::text AS status,
               grand_total::numeric AS grand_total, item_count
          FROM orders
         WHERE dealer_id = ${dealerId}
           AND delivery_date = ${params.date}::date
           AND status <> 'cancelled'
         ORDER BY created_at DESC
         LIMIT 1
      `;
 
      if (!order) {
        return reply.status(404).send({
          error: "No indent to confirm",
          message: "There's no indent for this date yet. Add items first.",
        });
      }
 
      // Already placed → idempotent success (200) on a double-tap / retry.
      if (order.status !== "draft" && order.status !== "payment_required") {
        return reply.send({
          orderId: order.id,
          status: order.status,
          deliveryDate: params.date,
          alreadyConfirmed: true,
        });
      }
 
      if (order.item_count === 0) {
        return reply.status(400).send({
          error: "Empty indent",
          message: "Cannot confirm an empty indent. Add items first.",
        });
      }
 
      const grandTotal = parseFloat(order.grand_total);
 
      if (body.paymentMode === "razorpay") {
        return reply.status(501).send({
          error: "Not implemented",
          message: "Use the dedicated pay-now endpoint for Razorpay payment.",
        });
      }
 
      const credit = await checkDealerCredit(dealerId, grandTotal);
 
      if (!credit.sufficient) {
        await pgClient`
          UPDATE orders
             SET status = 'payment_required', updated_at = now()
           WHERE id = ${order.id}::uuid
        `;
        return reply.status(402).send({
          error: "Credit limit exceeded",
          message: `Order is over your available credit by ₹${credit.shortfall.toFixed(
            2
          )}`,
          orderId: order.id,
          credit,
        });
      }
 
      // ── Place the order AND post the finance ledger debit atomically.
      //    (This INSERT is the fix — without it the order never reaches
      //    the books.)
      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
 
        await tx`
          UPDATE orders
             SET status       = 'pending',
                 payment_mode = 'credit',
                 confirmed_at = now(),
                 updated_at   = now()
           WHERE id = ${order.id}::uuid
        `;
 
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
        const balanceAfter = parseFloat(bal!.bal) - grandTotal;
 
        await tx`
          INSERT INTO dealer_ledger
            (dealer_id, type, amount,
             reference_id, reference_type,
             voucher_type, voucher_date,
             description, balance_after)
          VALUES
            (${dealerId}, 'debit', ${grandTotal.toFixed(2)}::numeric,
             ${order.id}, 'order',
             'Invoice', now()::date,
             ${"Standing-indent order " + order.id},
             ${balanceAfter.toFixed(2)}::numeric)
        `;
      });
 
      return reply.send({
        orderId: order.id,
        status: "pending",
        deliveryDate: params.date,
        credit,
      });
    }
  );

  // ── Pause windows ──
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