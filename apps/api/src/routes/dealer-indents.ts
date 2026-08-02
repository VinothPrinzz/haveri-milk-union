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
import { getDealerRouteId, NO_ROUTE_RESPONSE } from "../lib/dealer-route.js";
import {
  getOrderStockShortfalls,
  deductOrderStock,
  describeShortfalls,
  StockConflictError,
} from "../lib/stock-check.js";
import {
  findMinQtyViolations,
  findOrderMinQtyViolations,
  minQtyErrorMessage,
} from "../lib/min-order-qty.js";
import { enqueuePDFInvoice } from "../lib/queue.js";
import { cancelSupersededSiblings } from "../lib/supersede-orders.js";
import { resolveUnitPrice } from "../lib/rate-price.js";

// ── Helpers ─────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

// The half-price HTM 1000ML SKU (migration 0056). The subsidy scheme is
// UNION-OPERATED: the line is assigned per-dealer from the admin panel
// (standing template / Subsidy Indents page) and the dealer must not be
// able to add, change, or remove it — here it is pinned server-side in
// PATCH /drafts/:date, and flagged isSubsidy in GET /drafts/:date so the
// app renders it read-only. (The standing-indent PUT already rejects it
// via make_zero_in_indents, and the catalog endpoint hides it.)
const SUBSIDY_PRODUCT_CODE = "PD0191S";

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

/**
 * The dealer's rate category — decides which price their lines bill at.
 * 'Credit Inst-MRP' pays MRP on milk; see lib/rate-price.ts.
 */
async function dealerRateCategory(dealerId: string): Promise<string | null> {
  const [row] = await pgClient`
    SELECT rate_category::text AS "rateCategory"
      FROM dealers WHERE id = ${dealerId} LIMIT 1
  `;
  return (row?.rateCategory ?? null) as string | null;
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

/**
 * Re-sync the dealer's still-editable draft orders (today + future,
 * status='draft' only) to their CURRENT standing-indent template.
 *
 * Called after the dealer changes their standing indent so that
 * already-materialised drafts (e.g. tomorrow's, pre-built nightly) and
 * today's not-yet-placed draft pick up the new quantities — which is
 * what the auto-confirm job will then place at close time.
 *
 * Only touches status='draft' rows, so placed/confirmed/payment_required
 * orders are never mutated. Drafts whose template is now empty are left
 * empty (item_count=0); the close-time job cancels empty drafts.
 */
async function resyncEditableDrafts(
  dealerId: string,
  routeId: string
): Promise<number> {
  // Canonical line set from the live standing template FOR THIS ROUTE.
  // mrp + category name drive the rate-category price (lib/rate-price.ts).
  const standing = await pgClient`
    SELECT
      dsi.product_id::text         AS "productId",
      dsi.default_qty              AS "quantity",
      p.name                       AS "productName",
      p.base_price::numeric        AS "basePrice",
      p.mrp::numeric               AS "mrp",
      p.gst_percent::numeric       AS "gstPercent",
      p.code                       AS "code",
      c.name                       AS "categoryName"
    FROM dealer_standing_indents dsi
    JOIN products p ON p.id = dsi.product_id
                   AND p.deleted_at IS NULL
                   AND p.available = true
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE dsi.dealer_id = ${dealerId}
      AND dsi.route_id = ${routeId}::uuid
      AND dsi.active = true
      AND dsi.default_qty > 0
  `;

  const rateCategory = await dealerRateCategory(dealerId);

  let subtotal = 0;
  let totalGst = 0;
  let itemCount = 0;
  const lines = standing.map((r: any) => {
    const qty = Number(r.quantity);
    const price = resolveUnitPrice(r, rateCategory);
    const gstPct = parseFloat(r.gstPercent);
    const line = calcLine(price, gstPct, qty);
    subtotal += line.subtotal;
    totalGst += line.gst;
    itemCount += qty;
    return {
      productId: r.productId,
      productName: r.productName,
      quantity: qty,
      unitPrice: price.toFixed(2),
      gstPercent: gstPct.toFixed(2),
      gstAmount: line.gst.toFixed(2),
      lineTotal: line.total.toFixed(2),
    };
  });
  const grandTotal = Math.round((subtotal + totalGst) * 100) / 100;

  // Editable drafts for THIS ROUTE: today (IST) onward, still status='draft'.
  // (COALESCE catches legacy NULL-route drafts as the active route.)
  const targets = await pgClient`
    SELECT id::text AS id FROM orders
     WHERE dealer_id = ${dealerId}
       AND status = 'draft'
       AND delivery_date >= (now() AT TIME ZONE 'Asia/Kolkata')::date
       AND COALESCE(route_id, ${routeId}::uuid) = ${routeId}::uuid
  `;

  for (const t of targets) {
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;
      // Guard on status='draft' so we never race a confirm in flight.
      const upd = await tx`
        UPDATE orders SET
          subtotal    = ${subtotal.toFixed(2)}::numeric,
          total_gst   = ${totalGst.toFixed(2)}::numeric,
          grand_total = ${grandTotal.toFixed(2)}::numeric,
          item_count  = ${itemCount},
          updated_at  = now()
        WHERE id = ${t.id}::uuid AND status = 'draft'
      `;
      if (upd.count === 0) return; // moved on (confirmed/placed) — skip
      await tx`DELETE FROM order_items WHERE order_id = ${t.id}::uuid`;
      for (const ln of lines) {
        await tx`
          INSERT INTO order_items (
            order_id, product_id, product_name, quantity,
            unit_price, gst_percent, gst_amount, line_total
          ) VALUES (
            ${t.id}::uuid, ${ln.productId}::uuid, ${ln.productName},
            ${ln.quantity}, ${ln.unitPrice}::numeric, ${ln.gstPercent}::numeric,
            ${ln.gstAmount}::numeric, ${ln.lineTotal}::numeric
          )
        `;
      }
    });
  }

  return targets.length;
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
      // Templates are per (dealer, route); show the dealer's ACTIVE route's
      // template (the route they picked on the Profile switch). No route ⇒
      // nothing to show.
      const routeId = await getDealerRouteId(dealerId);
      if (!routeId) return reply.send({ items: [] });
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
          AND dsi.route_id = ${routeId}::uuid
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
      // Current-value columns reflect the ACTIVE route's template (null route
      // ⇒ all zero, dealer builds it fresh once assigned a route).
      const routeId = await getDealerRouteId(dealerId);
      const rows = await pgClient`
        SELECT
          p.id                      AS "productId",
          p.name                    AS "productName",
          p.unit                    AS "unit",
          p.icon                    AS "icon",
          p.image_url               AS "imageUrl",
          p.base_price::numeric     AS "basePrice",
          p.gst_percent::numeric    AS "gstPercent",
          c.name                    AS "categoryName",
          COALESCE(dsi.default_qty, 0)  AS "currentDefaultQty",
          COALESCE(dsi.active, false)   AS "currentActive"
        FROM products p
        LEFT JOIN dealer_standing_indents dsi
               ON dsi.product_id = p.id
              AND dsi.dealer_id = ${dealerId}
              AND dsi.route_id = ${routeId ?? null}::uuid
        LEFT JOIN categories c ON c.id = p.category_id
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
      // The template being edited belongs to the dealer's ACTIVE route. No
      // route ⇒ they can't hold a template (nor order).
      const routeId = await getDealerRouteId(dealerId);
      if (!routeId) return reply.status(403).send(NO_ROUTE_RESPONSE);

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

      // Milk order minimum (≥12 L milk; curd has no minimum). Only ACTIVE lines
      // with a positive default get auto-placed, so the aggregate is checked
      // over those — a standing indent that totals under the minimum would
      // otherwise auto-confirm into an order that breaks the rule.
      const minQtyViolations = await findMinQtyViolations(
        body.items
          .filter((i) => i.active)
          .map((i) => ({ productId: i.productId, quantity: i.defaultQty })),
        dealerId
      );
      if (minQtyViolations.length > 0) {
        return reply.status(400).send({
          error: "Minimum order quantity",
          message: minQtyErrorMessage(minQtyViolations),
          violations: minQtyViolations,
        });
      }

      const rows = body.items.map((it) => ({
        dealer_id:   dealerId,
        route_id:    routeId,
        product_id:  it.productId,
        default_qty: it.defaultQty,
        active:      it.active,
      }));

      await pgClient`
        INSERT INTO dealer_standing_indents
          ${pgClient(rows, "dealer_id", "route_id", "product_id", "default_qty", "active")}
        ON CONFLICT (dealer_id, route_id, product_id) DO UPDATE
          SET default_qty = EXCLUDED.default_qty,
              active      = EXCLUDED.active,
              updated_at  = now()
      `;

      // Reflect the new template in any still-editable drafts (today +
      // future) so the close-time auto-confirm places the updated order.
      // Placed orders are never touched. Best-effort: a re-sync failure
      // must not fail the template save itself.
      let resyncedDrafts = 0;
      try {
        resyncedDrafts = await resyncEditableDrafts(dealerId, routeId);
      } catch (err) {
        request.log.warn(
          { err },
          "[standing-indents] draft re-sync failed (template saved)"
        );
      }

      return reply.send({ updated: body.items.length, resyncedDrafts });
    }
  );

  app.get(
    "/api/v1/dealer/drafts/:date",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = getDealerId(request);
      const params = z.object({ date: isoDate }).parse(request.params);
      // The app always works on the dealer's ACTIVE route: scope the order
      // lookup + the synthesized preview to it, so a two-route dealer's other
      // (admin-managed) route order never leaks into the app view.
      const activeRouteId = await getDealerRouteId(dealerId);

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
           AND COALESCE(o.route_id, ${activeRouteId ?? null}::uuid) IS NOT DISTINCT FROM ${activeRouteId ?? null}::uuid
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
            p.unit                  AS "unit",
            (p.code = ${SUBSIDY_PRODUCT_CODE}) AS "isSubsidy",
            c.name                  AS "categoryName"
          FROM order_items oi
          JOIN products p ON p.id = oi.product_id
          LEFT JOIN categories c ON c.id = p.category_id
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
          isSubsidy: Boolean(r.isSubsidy),
          categoryName: r.categoryName ?? null,
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
          p.base_price::numeric   AS "basePrice",
          p.mrp::numeric          AS "mrp",
          p.gst_percent::numeric  AS "gstPercent",
          p.code                  AS "code",
          (p.code = ${SUBSIDY_PRODUCT_CODE}) AS "isSubsidy",
          c.name                  AS "categoryName"
        FROM dealer_standing_indents dsi
        JOIN products p ON p.id = dsi.product_id
                       AND p.deleted_at IS NULL
                       AND p.available = true
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE dsi.dealer_id = ${dealerId}
          AND dsi.route_id = ${activeRouteId ?? null}::uuid
          AND dsi.active = true
          AND dsi.default_qty > 0
        ORDER BY p.sort_order, p.name
      `;

      const previewRateCategory = await dealerRateCategory(dealerId);

      let subtotal = 0;
      let totalGst = 0;
      const items = standing.map((r: any) => {
        const qty = r.quantity;
        const price = resolveUnitPrice(r, previewRateCategory);
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
          isSubsidy: Boolean(r.isSubsidy),
          categoryName: r.categoryName ?? null,
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

      // A dealer with no delivery route can't place orders — block building
      // the indent at all so they never reach a dead-end at confirm. The
      // active route is snapshotted onto the draft so it dispatches/reports
      // under the route the dealer is currently on.
      const activeRouteId = await getDealerRouteId(dealerId);
      if (!activeRouteId) {
        return reply.status(403).send(NO_ROUTE_RESPONSE);
      }

      const schema = z.object({
        items: z.array(
          z.object({
            productId: z.string().uuid(),
            quantity: z.number().int().min(0).max(10_000),
          })
        ),
      });
      const body = schema.parse(request.body);
      let lineItems = body.items.filter((i) => i.quantity > 0);

      // ── FIX: if an order for this date already exists and is no longer a
      // draft, it has been placed — reject the edit instead of mutating a
      // placed order or inserting a duplicate.
      const [active] = await pgClient`
        SELECT id, status::text AS status FROM orders
         WHERE dealer_id = ${dealerId}
           AND delivery_date = ${params.date}::date
           AND status <> 'cancelled'
           AND COALESCE(route_id, ${activeRouteId}::uuid) = ${activeRouteId}::uuid
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

      // ── Subsidy line is union-managed — pin it ──────────────────────
      // Whatever the client sent for PD0191S is ignored. The line is held
      // at what is already on this date's draft (or, for a fresh draft,
      // what the admin-assigned standing template says). Dealers keep full
      // control of every other line; only the admin panel moves this one.
      const [subsidyProduct] = await pgClient`
        SELECT id::text AS id FROM products
         WHERE code = ${SUBSIDY_PRODUCT_CODE} AND deleted_at IS NULL
         LIMIT 1
      `;
      if (subsidyProduct) {
        let pinnedQty = 0;
        if (active) {
          const [line] = await pgClient`
            SELECT quantity FROM order_items
             WHERE order_id = ${active.id}::uuid
               AND product_id = ${subsidyProduct.id}::uuid
             LIMIT 1
          `;
          pinnedQty = line ? Number(line.quantity) : 0;
        } else {
          const [tpl] = await pgClient`
            SELECT default_qty FROM dealer_standing_indents
             WHERE dealer_id = ${dealerId}
               AND route_id = ${activeRouteId}::uuid
               AND product_id = ${subsidyProduct.id}::uuid
               AND active = true
             LIMIT 1
          `;
          pinnedQty = tpl ? Number(tpl.default_qty) : 0;
        }
        lineItems = lineItems.filter((i) => i.productId !== subsidyProduct.id);
        if (pinnedQty > 0) {
          lineItems.push({ productId: subsidyProduct.id, quantity: pinnedQty });
        }
      }

      const productRows =
        lineItems.length > 0
          ? await pgClient`
              SELECT
                p.id::text             AS "id",
                p.name                 AS "name",
                p.base_price::numeric  AS "basePrice",
                p.mrp::numeric         AS "mrp",
                p.gst_percent::numeric AS "gstPercent",
                p.available            AS "available",
                p.code                 AS "code",
                c.name                 AS "categoryName"
              FROM products p
              LEFT JOIN categories c ON c.id = p.category_id
              WHERE p.id = ANY(${lineItems.map((i) => i.productId)}::uuid[])
                AND p.deleted_at IS NULL
            `
          : [];
      const productMap = new Map<string, any>(
        productRows.map((p: any) => [p.id, p])
      );

      const draftRateCategory = await dealerRateCategory(dealerId);
   
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
        const price = resolveUnitPrice(p, draftRateCategory);
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

        // Serialize draft creation per (dealer, date). The partitioned
        // orders table can't carry a unique index on (dealer_id,
        // delivery_date), so two concurrent PATCHes (mobile network
        // retries on flaky rural links) could BOTH see "no draft" and
        // insert twins — one dealer accumulated five. The xact-scoped
        // advisory lock makes the second wait until the first commits,
        // so its SELECT below finds the committed draft and UPDATEs it.
        await tx`
          SELECT pg_advisory_xact_lock(hashtext(${dealerId + ":" + activeRouteId + ":" + params.date}))
        `;

        // Only ever update an existing DRAFT on THIS route. (A placed order
        // was already rejected above; this guard keeps the transaction
        // consistent.) COALESCE catches legacy NULL-route drafts.
        const [existing] = await tx`
          SELECT id FROM orders
           WHERE dealer_id = ${dealerId}
             AND delivery_date = ${params.date}::date
             AND status = 'draft'
             AND COALESCE(route_id, ${activeRouteId}::uuid) = ${activeRouteId}::uuid
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
              dealer_id, zone_id, route_id, status, payment_mode,
              subtotal, total_gst, grand_total, item_count,
              delivery_date
            ) VALUES (
              ${dealerId}, ${zoneId}, ${activeRouteId}::uuid, 'draft', 'credit',
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

      // Guard: an unrouted dealer must not be able to place an order, even if
      // a draft was somehow materialised (e.g. by the nightly standing-indent
      // job before their route was removed). The app confirms the ACTIVE
      // route's order for the date.
      const activeRouteId = await getDealerRouteId(dealerId);
      if (!activeRouteId) {
        return reply.status(403).send(NO_ROUTE_RESPONSE);
      }

      const schema = z.object({
        // "wallet" and "credit" are the SAME settlement path (a ledger
        // debit): regular dealers draw on their prepaid wallet balance,
        // credit institutions accumulate the debit on their monthly bill
        // (checkDealerCredit waives the balance gate for them). "wallet"
        // is the name newer app builds send; "credit" is kept for older
        // builds. Stored payment_mode stays 'credit' either way — the
        // cancel/refund path reverses these orders via the ledger.
        paymentMode: z.enum(["credit", "wallet", "razorpay"]),
        razorpayPaymentId: z.string().optional(),
      });
      const body = schema.parse(request.body);
 
      // Look at ANY non-cancelled order for this date on the ACTIVE route
      // (not just 'draft'). COALESCE catches legacy NULL-route orders.
      const [order] = await pgClient`
        SELECT id, status::text AS status,
               grand_total::numeric AS grand_total, item_count
          FROM orders
         WHERE dealer_id = ${dealerId}
           AND delivery_date = ${params.date}::date
           AND status <> 'cancelled'
           AND COALESCE(route_id, ${activeRouteId}::uuid) = ${activeRouteId}::uuid
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

      // ── Milk order-minimum gate (≥12 L; curd has no minimum) ── leave the order a
      // draft so the dealer can top up the quantities, then re-confirm.
      const minQtyViolations = await findOrderMinQtyViolations(order.id);
      if (minQtyViolations.length > 0) {
        return reply.status(400).send({
          error: "Minimum order quantity",
          message: minQtyErrorMessage(minQtyViolations),
          orderId: order.id,
          violations: minQtyViolations,
        });
      }

      // ── Stock gate ── never confirm what we can't physically deliver.
      // Leave the order a draft so it stays editable; the dealer can trim
      // quantities or wait for the day's stock entry, then re-confirm.
      const shortfalls = await getOrderStockShortfalls(pgClient, order.id);
      if (shortfalls.length > 0) {
        return reply.status(409).send({
          error: "Insufficient stock",
          message: `Not enough stock for: ${describeShortfalls(shortfalls)}`,
          orderId: order.id,
          shortfalls,
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
          message: `Order is over your wallet balance by ₹${credit.shortfall.toFixed(
            2
          )}`,
          orderId: order.id,
          credit,
        });
      }
 
      // ── Place the order, deduct stock, AND post the finance ledger
      //    debit atomically. If stock was drained by a concurrent order
      //    between the gate above and here, the guarded deduction throws
      //    and the whole confirm rolls back (order stays a draft).
      try {
      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        // cancel_window_ends_at = LEAST(now + 30 min, route's close_time for today).
        // Uses the dealer's route_id from the dealers table. If no route or no
        // time_window is configured for that route, falls back to now + 30 min.
        await tx`
          UPDATE orders
             SET status       = 'confirmed',
                 payment_mode = 'credit',
                 confirmed_at = now(),
                 updated_at   = now(),
                 route_id     = COALESCE(orders.route_id, d.route_id),
                 cancel_window_ends_at = LEAST(
                   now() + interval '30 minutes',
                   COALESCE(
                     (orders.delivery_date + (
                        SELECT tw.close_time FROM time_windows tw
                         WHERE tw.route_id = COALESCE(orders.route_id, d.route_id)
                         ORDER BY tw.close_time DESC LIMIT 1
                      )) AT TIME ZONE 'Asia/Kolkata',
                     now() + interval '30 minutes'
                   )
                 )
           FROM dealers d
           WHERE orders.id = ${order.id}::uuid
             AND d.id = ${dealerId}
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

        // This is now the day's placed order — cancel any stranded twin
        // (older duplicate draft / unpaid payment_required) for this date
        // FIRST, so its reservation no longer counts against this order in the
        // FGS stock check below (else a dealer replacing their own order
        // double-counts and false-blocks).
        await cancelSupersededSiblings(tx, order.id);

        // Move physical stock last — its FGS guard is what can abort the confirm.
        await deductOrderStock(tx, order.id);
      });
      } catch (err) {
        if (err instanceof StockConflictError) {
          return reply.status(409).send({
            error: "Insufficient stock",
            message: `Not enough stock for: ${describeShortfalls(err.shortfalls)}`,
            orderId: order.id,
            shortfalls: err.shortfalls,
          });
        }
        throw err;
      }

      // Generate invoice in the background (same queue as direct orders).
      await enqueuePDFInvoice(order.id);

      return reply.send({
        orderId: order.id,
        status: "confirmed",
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