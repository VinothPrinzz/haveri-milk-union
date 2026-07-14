// apps/api/src/routes/admin-indents.ts
// ═══════════════════════════════════════════════════════════════════════
// Admin-side standing-indent + daily-draft management.
//
// Lets internal staff inspect and edit ANY dealer's standing-indent
// template and per-date draft orders — the admin mirror of the dealer
// app's /api/v1/dealer/standing-indents and /api/v1/dealer/drafts/:date.
//
//   • reads  → requireRole("indents.view")
//   • writes → requireRole("indents.manage")
//
// ── Finance link ───────────────────────────────────────────────────────
// POST .../drafts/:date/confirm places the draft as a 'pending' order AND
// writes a dealer_ledger debit (voucher_type 'Invoice', reference_type
// 'order') in the SAME transaction — identical to the Call Desk
// POST /api/v1/orders path. That ledger row is what makes standing-indent
// orders visible on every admin finance surface (Dealer Ledger, Payments
// Overview, dealer current_balance / outstanding). Without it, an order
// confirmed from a standing indent never reaches the books.
//
// Because the confirmed row is an ordinary `orders` row carrying a
// 'order' ledger debit, the existing cancellation flow reverses it the
// same way it reverses any other credit order — no special-casing.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { checkDealerCredit } from "../lib/credit-check.js";
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
import { cancelSupersededSiblings } from "../lib/supersede-orders.js";

// ── Helpers ─────────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const uuid = z.string().uuid();

// The half-price HTM 1000ML SKU seeded by migration 0056. It carries
// make_zero_in_indents = true so it stays hidden from the DEALER's own
// standing-indent picker (the subsidy scheme is admin-operated). Admins,
// however, may mark it as a standing indent on a dealer's behalf here, so
// the endpoints below whitelist it back into the eligible set. Once a
// standing row exists, the nightly materialize + warning-time auto-confirm
// place it on the dealer's order at its 50% base_price like any other line.
const SUBSIDY_PRODUCT_CODE = "PD0191S";

function adminUserId(request: FastifyRequest): string {
  const a = (request as unknown as { admin?: { userId: string } }).admin;
  if (!a?.userId) throw new Error("adminAuth middleware not set");
  return a.userId;
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

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Resolve + validate a dealer; throws a 404-shaped error if missing. */
async function loadDealer(dealerId: string) {
  const [dealer] = await pgClient`
    SELECT id, name, code, zone_id AS "zoneId"
      FROM dealers
     WHERE id = ${dealerId} AND deleted_at IS NULL
     LIMIT 1
  `;
  if (!dealer) {
    throw Object.assign(new Error("Dealer not found"), { statusCode: 404 });
  }
  if (!dealer.zoneId) {
    throw Object.assign(
      new Error("Dealer has no zone assigned — set a zone before placing indents"),
      { statusCode: 409 }
    );
  }
  return dealer as { id: string; name: string; code: string | null; zoneId: string };
}

// ═══════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════

export async function adminIndentsRoutes(app: FastifyInstance) {
  // ┌───────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/admin/dealers/:dealerId/standing-indents              │
  // │  One merged row per eligible product: current template + picker.   │
  // └───────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/admin/dealers/:dealerId/standing-indents",
    { preHandler: [adminAuth, requireRole("indents.view")] },
    async (request, reply) => {
      const { dealerId } = z.object({ dealerId: uuid }).parse(request.params);
      const dealer = await loadDealer(dealerId);

      // Every product the dealer COULD have in a standing indent, LEFT
      // JOINed with whatever is currently in their template.
      const items = await pgClient`
        SELECT
          p.id                          AS "productId",
          p.name                        AS "productName",
          p.unit                        AS "unit",
          p.icon                        AS "icon",
          p.image_url                   AS "imageUrl",
          p.base_price::numeric          AS "basePrice",
          p.gst_percent::numeric         AS "gstPercent",
          p.available                   AS "productAvailable",
          p.code                        AS "code",
          (p.code = ${SUBSIDY_PRODUCT_CODE}) AS "isSubsidy",
          c.name                        AS "categoryName",
          COALESCE(dsi.default_qty, 0)   AS "defaultQty",
          COALESCE(dsi.active, false)    AS "active",
          (dsi.id IS NOT NULL)           AS "inTemplate"
        FROM products p
        LEFT JOIN dealer_standing_indents dsi
               ON dsi.product_id = p.id
              AND dsi.dealer_id  = ${dealerId}
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL
          AND p.available = true
          AND (p.make_zero_in_indents = false OR p.code = ${SUBSIDY_PRODUCT_CODE})
        ORDER BY p.sort_order, p.name
      `;

      return reply.send({
        dealer: { id: dealer.id, name: dealer.name, code: dealer.code },
        items,
      });
    }
  );

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  PUT /api/v1/admin/dealers/:dealerId/standing-indents              │
  // │  Bulk upsert the dealer's template. Same body as the dealer app.   │
  // └───────────────────────────────────────────────────────────────────┘
  app.put(
    "/api/v1/admin/dealers/:dealerId/standing-indents",
    { preHandler: [adminAuth, requireRole("indents.manage")] },
    async (request, reply) => {
      const { dealerId } = z.object({ dealerId: uuid }).parse(request.params);
      await loadDealer(dealerId);

      const body = z
        .object({
          items: z
            .array(
              z.object({
                productId: uuid,
                defaultQty: z.number().int().min(0).max(10_000),
                active: z.boolean().default(true),
              })
            )
            .min(1),
        })
        .parse(request.body);

      const productIds = body.items.map((i) => i.productId);
      const eligible = await pgClient`
        SELECT id::text FROM products
         WHERE id = ANY(${productIds}::uuid[])
           AND deleted_at IS NULL
           AND (make_zero_in_indents = false OR code = ${SUBSIDY_PRODUCT_CODE})
      `;
      const eligibleSet = new Set(eligible.map((r: any) => r.id));
      const ineligible = productIds.filter((id) => !eligibleSet.has(id));
      if (ineligible.length > 0) {
        return reply.status(400).send({
          error: "Ineligible products",
          message: "Some products cannot be added to a standing indent",
          ineligibleProductIds: ineligible,
        });
      }

      // Milk order minimum (≥12 L milk; curd has no minimum). Only ACTIVE lines
      // with a positive default get auto-placed, so the aggregate is checked
      // over those.
      const minQtyViolations = await findMinQtyViolations(
        body.items
          .filter((i) => i.active)
          .map((i) => ({ productId: i.productId, quantity: i.defaultQty }))
      );
      if (minQtyViolations.length > 0) {
        return reply.status(400).send({
          error: "Minimum order quantity",
          message: minQtyErrorMessage(minQtyViolations),
          violations: minQtyViolations,
        });
      }

      const rows = body.items.map((it) => ({
        dealer_id: dealerId,
        product_id: it.productId,
        default_qty: it.defaultQty,
        active: it.active,
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

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/admin/dealers/:dealerId/drafts/:date                  │
  // │  Persisted draft if one exists, else a synthesized preview from    │
  // │  the standing indent. Always carries a credit snapshot.            │
  // └───────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/admin/dealers/:dealerId/drafts/:date",
    { preHandler: [adminAuth, requireRole("indents.view")] },
    async (request, reply) => {
      const { dealerId, date } = z
        .object({ dealerId: uuid, date: isoDate })
        .parse(request.params);
      const dealer = await loadDealer(dealerId);

      // Credit standing — the finance context for this dealer/date.
      // We compute the order total below and re-check with checkDealerCredit
      // so the page can show "available before / after this draft".
      const baseCredit = await checkDealerCredit(dealerId, 0);

      // ── Pause check ──
      const [paused] = await pgClient`
        SELECT reason FROM dealer_indent_pauses
         WHERE dealer_id = ${dealerId}
           AND ${date}::date BETWEEN from_date AND to_date
         ORDER BY created_at DESC
         LIMIT 1
      `;
      if (paused) {
        return reply.send({
          dealer: { id: dealer.id, name: dealer.name, code: dealer.code },
          deliveryDate: date,
          exists: false,
          paused: true,
          pausedReason: paused.reason ?? null,
          status: "draft",
          items: [],
          totals: { subtotal: 0, totalGst: 0, grandTotal: 0 },
          credit: baseCredit,
        });
      }

      // ── Any non-cancelled order for this date wins (read-only once
      //    placed; editable only while status = 'draft') ──
      const [order] = await pgClient`
        SELECT id, status::text AS status
          FROM orders
         WHERE dealer_id = ${dealerId}
           AND delivery_date = ${date}::date
           AND status <> 'cancelled'
         ORDER BY created_at DESC
         LIMIT 1
      `;

      if (order) {
        const lines = await pgClient`
          SELECT
            oi.product_id            AS "productId",
            oi.product_name          AS "productName",
            oi.quantity              AS "quantity",
            oi.unit_price::numeric   AS "unitPrice",
            oi.gst_percent::numeric  AS "gstPercent",
            oi.line_total::numeric   AS "lineTotal",
            p.icon                   AS "icon",
            p.image_url              AS "imageUrl",
            p.unit                   AS "unit",
            (p.code = ${SUBSIDY_PRODUCT_CODE}) AS "isSubsidy",
            c.name                   AS "categoryName"
          FROM order_items oi
          LEFT JOIN products p ON p.id = oi.product_id
          LEFT JOIN categories c ON c.id = p.category_id
          WHERE oi.order_id = ${order.id}::uuid
          ORDER BY oi.product_name
        `;
        let subtotal = 0;
        let totalGst = 0;
        for (const l of lines as any[]) {
          const line = calcLine(
            parseFloat(l.unitPrice),
            parseFloat(l.gstPercent),
            l.quantity
          );
          subtotal += line.subtotal;
          totalGst += line.gst;
        }
        const grandTotal = round2(subtotal + totalGst);
        return reply.send({
          dealer: { id: dealer.id, name: dealer.name, code: dealer.code },
          deliveryDate: date,
          exists: true,
          paused: false,
          orderId: order.id,
          status: order.status,
          editable: order.status === "draft",
          items: lines,
          totals: { subtotal: round2(subtotal), totalGst: round2(totalGst), grandTotal },
          credit: await checkDealerCredit(dealerId, grandTotal),
        });
      }

      // ── No order row — synthesize a preview from the standing indent.
      const standing = await pgClient`
        SELECT
          dsi.product_id          AS "productId",
          dsi.default_qty         AS "quantity",
          p.name                  AS "productName",
          p.unit                  AS "unit",
          p.icon                  AS "icon",
          p.image_url             AS "imageUrl",
          p.base_price::numeric   AS "unitPrice",
          p.gst_percent::numeric  AS "gstPercent",
          (p.code = ${SUBSIDY_PRODUCT_CODE}) AS "isSubsidy",
          c.name                  AS "categoryName"
        FROM dealer_standing_indents dsi
        JOIN products p ON p.id = dsi.product_id
                       AND p.deleted_at IS NULL
                       AND p.available = true
        LEFT JOIN categories c ON c.id = p.category_id
        WHERE dsi.dealer_id = ${dealerId}
          AND dsi.active = true
          AND dsi.default_qty > 0
        ORDER BY p.sort_order, p.name
      `;

      let subtotal = 0;
      let totalGst = 0;
      const items = (standing as any[]).map((r) => {
        const price = parseFloat(r.unitPrice);
        const gstPct = parseFloat(r.gstPercent);
        const line = calcLine(price, gstPct, r.quantity);
        subtotal += line.subtotal;
        totalGst += line.gst;
        return {
          productId: r.productId,
          productName: r.productName,
          quantity: r.quantity,
          unitPrice: price,
          gstPercent: gstPct,
          lineTotal: line.total,
          icon: r.icon,
          imageUrl: r.imageUrl,
          unit: r.unit,
          isSubsidy: r.isSubsidy ?? false,
          categoryName: r.categoryName ?? null,
        };
      });
      const grandTotal = round2(subtotal + totalGst);

      return reply.send({
        dealer: { id: dealer.id, name: dealer.name, code: dealer.code },
        deliveryDate: date,
        exists: false,
        paused: false,
        status: "draft",
        editable: true,
        items,
        totals: { subtotal: round2(subtotal), totalGst: round2(totalGst), grandTotal },
        credit: await checkDealerCredit(dealerId, grandTotal),
      });
    }
  );

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  PATCH /api/v1/admin/dealers/:dealerId/drafts/:date                │
  // │  Bulk-replace the draft's line items. Materializes the row on the  │
  // │  first edit. Refuses to touch an already-placed order.             │
  // └───────────────────────────────────────────────────────────────────┘
  app.patch(
    "/api/v1/admin/dealers/:dealerId/drafts/:date",
    { preHandler: [adminAuth, requireRole("indents.manage")] },
    async (request, reply) => {
      const { dealerId, date } = z
        .object({ dealerId: uuid, date: isoDate })
        .parse(request.params);
      const dealer = await loadDealer(dealerId);

      const body = z
        .object({
          items: z.array(
            z.object({
              productId: uuid,
              quantity: z.number().int().min(0).max(10_000),
            })
          ),
        })
        .parse(request.body);
      const lineItems = body.items.filter((i) => i.quantity > 0);

      // Reject editing a placed (non-draft) order.
      const [active] = await pgClient`
        SELECT id, status::text AS status FROM orders
         WHERE dealer_id = ${dealerId}
           AND delivery_date = ${date}::date
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
        (productRows as any[]).map((p) => [p.id, p])
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
      const grandTotal = round2(subtotal + totalGst);

      const orderId = await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        // Serialize draft creation per (dealer, date) — same advisory
        // lock as the dealer PATCH (the partitioned orders table can't
        // enforce uniqueness, so concurrent edits could insert twins).
        await tx`
          SELECT pg_advisory_xact_lock(hashtext(${dealerId + ":" + date}))
        `;

        const [existing] = await tx`
          SELECT id FROM orders
           WHERE dealer_id = ${dealerId}
             AND delivery_date = ${date}::date
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
              delivery_date, placed_by
            ) VALUES (
              ${dealerId}, ${dealer.zoneId}, 'draft', 'credit',
              ${subtotal.toFixed(2)}::numeric,
              ${totalGst.toFixed(2)}::numeric,
              ${grandTotal.toFixed(2)}::numeric,
              ${itemCount},
              ${date}::date,
              ${adminUserId(request)}
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
        deliveryDate: date,
        status: "draft",
        itemCount,
        totals: { subtotal: round2(subtotal), totalGst: round2(totalGst), grandTotal },
      });
    }
  );

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  POST /api/v1/admin/dealers/:dealerId/drafts/:date/confirm         │
  // │  Place the draft as a 'pending' order AND write the finance        │
  // │  ledger debit. `force: true` overrides an over-limit credit check  │
  // │  (admin placing on the dealer's behalf).                           │
  // └───────────────────────────────────────────────────────────────────┘
  app.post(
    "/api/v1/admin/dealers/:dealerId/drafts/:date/confirm",
    { preHandler: [adminAuth, requireRole("indents.manage")] },
    async (request, reply) => {
      const { dealerId, date } = z
        .object({ dealerId: uuid, date: isoDate })
        .parse(request.params);
      await loadDealer(dealerId);

      const body = z.object({ force: z.boolean().default(false) }).parse(
        request.body ?? {}
      );

      const [order] = await pgClient`
        SELECT id, status::text AS status,
               grand_total::numeric AS grand_total, item_count
          FROM orders
         WHERE dealer_id = ${dealerId}
           AND delivery_date = ${date}::date
           AND status <> 'cancelled'
         ORDER BY created_at DESC
         LIMIT 1
      `;

      if (!order) {
        return reply.status(404).send({
          error: "No draft to confirm",
          message: "There is no draft for this date yet. Edit the items first.",
        });
      }

      // Already placed → idempotent success.
      if (order.status !== "draft" && order.status !== "payment_required") {
        return reply.send({
          orderId: order.id,
          status: order.status,
          deliveryDate: date,
          alreadyConfirmed: true,
        });
      }

      if (order.item_count === 0) {
        return reply.status(400).send({
          error: "Empty draft",
          message: "Cannot confirm an empty draft. Add items first.",
        });
      }

      const grandTotal = parseFloat(order.grand_total);

      // ── Milk order-minimum gate (≥12 L; curd has no minimum) ── blocks even a
      // forced confirm; the draft stays editable to top up quantities.
      const minQtyViolations = await findOrderMinQtyViolations(order.id);
      if (minQtyViolations.length > 0) {
        return reply.status(400).send({
          error: "Minimum order quantity",
          message: minQtyErrorMessage(minQtyViolations),
          orderId: order.id,
          violations: minQtyViolations,
        });
      }

      // ── Stock gate ── a hard physical limit: you can't dispatch milk you
      // don't have, so this blocks even a forced confirm (force only
      // overrides the credit line). The draft stays editable for trimming
      // or a stock top-up, then re-confirm.
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

      // Over the credit line and not forced → surface the shortfall.
      if (!credit.sufficient && !body.force) {
        await pgClient`
          UPDATE orders
             SET status = 'payment_required', updated_at = now()
           WHERE id = ${order.id}::uuid
        `;
        return reply.status(402).send({
          error: "Credit limit exceeded",
          message: `Draft is over the customer's available balance by ₹${credit.shortfall.toFixed(
            2
          )}. Re-send with { "force": true } to place it anyway.`,
          orderId: order.id,
          credit,
        });
      }

      // ── Place the order, deduct stock, AND post the finance ledger
      //    debit atomically. A concurrent order draining stock after the
      //    gate above makes the guarded deduction throw → full rollback,
      //    order stays a draft.
      try {
      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        // cancel_window_ends_at = LEAST(now + 30 min, route's close_time for
        // the delivery date) — same rule as the dealer credit-confirm path.
        await tx`
          UPDATE orders
             SET status       = 'confirmed',
                 payment_mode = 'credit',
                 confirmed_at = now(),
                 updated_at   = now(),
                 cancel_window_ends_at = LEAST(
                   now() + interval '30 minutes',
                   COALESCE(
                     (orders.delivery_date + tw.close_time) AT TIME ZONE 'Asia/Kolkata',
                     now() + interval '30 minutes'
                   )
                 )
           FROM dealers d
           LEFT JOIN time_windows tw ON tw.route_id = d.route_id
           WHERE orders.id = ${order.id}::uuid
             AND orders.dealer_id = d.id
        `;

        // Running balance = opening_balance + non-Opening credits
        //                    - non-Opening debits  (same maths the
        //                    Call Desk POST /orders path uses).
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
             description, balance_after, performed_by)
          VALUES
            (${dealerId}, 'debit', ${grandTotal.toFixed(2)}::numeric,
             ${order.id}, 'order',
             'Invoice', now()::date,
             ${"Standing-indent order " + order.id},
             ${balanceAfter.toFixed(2)}::numeric,
             ${adminUserId(request)})
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

      return reply.send({
        orderId: order.id,
        status: "confirmed",
        deliveryDate: date,
        credit,
        forced: !credit.sufficient && body.force,
      });
    }
  );

  // ── Pause windows (so admin can park a dealer's auto-drafts) ───────────
  app.get(
    "/api/v1/admin/dealers/:dealerId/indent-pauses",
    { preHandler: [adminAuth, requireRole("indents.view")] },
    async (request, reply) => {
      const { dealerId } = z.object({ dealerId: uuid }).parse(request.params);
      await loadDealer(dealerId);
      const pauses = await pgClient`
        SELECT id,
               from_date::text AS "fromDate",
               to_date::text   AS "toDate",
               reason,
               created_at      AS "createdAt"
          FROM dealer_indent_pauses
         WHERE dealer_id = ${dealerId}
         ORDER BY from_date DESC
      `;
      return reply.send({ pauses });
    }
  );

  app.post(
    "/api/v1/admin/dealers/:dealerId/indent-pauses",
    { preHandler: [adminAuth, requireRole("indents.manage")] },
    async (request, reply) => {
      const { dealerId } = z.object({ dealerId: uuid }).parse(request.params);
      await loadDealer(dealerId);
      const body = z
        .object({
          fromDate: isoDate,
          toDate: isoDate,
          reason: z.string().max(200).optional(),
        })
        .parse(request.body);
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
    "/api/v1/admin/dealers/:dealerId/indent-pauses/:id",
    { preHandler: [adminAuth, requireRole("indents.manage")] },
    async (request, reply) => {
      const { dealerId, id } = z
        .object({ dealerId: uuid, id: uuid })
        .parse(request.params);
      const result = await pgClient`
        DELETE FROM dealer_indent_pauses
         WHERE id = ${id}::uuid AND dealer_id = ${dealerId}
         RETURNING id
      `;
      if (result.length === 0) {
        return reply.status(404).send({ error: "Pause not found" });
      }
      return reply.send({ deleted: id });
    }
  );
}