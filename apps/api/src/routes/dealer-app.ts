import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { dealerAuth } from "../middleware/dealer-auth.js";
import {
  paginationSchema,
  paginationMeta,
  offsetFromPage,
} from "../lib/pagination.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

// ── Dealer route type (for the list/switch endpoints below) ──
interface DealerRoute {
  id: string;
  code: string;
  name: string;
  isPrimary: boolean;
}

export async function dealerAppRoutes(app: FastifyInstance) {
  // GET /api/v1/banners — active marketing banners for dealer app
  app.get("/api/v1/banners", async (request, reply) => {
    const banners = await pgClient`
      SELECT id, title, subtitle, category, image_url, start_date, end_date
      FROM banners
      WHERE active = true
        AND start_date <= CURRENT_DATE
        AND end_date >= CURRENT_DATE
      ORDER BY created_at DESC
    `;
    return reply.send({ banners });
  });

  // POST /api/v1/banners — create banner
  app.post(
    "/api/v1/banners",
    { preHandler: [adminAuth, requireRole("system.manage")] },
    async (request, reply) => {
      const schema = z.object({
        title: z.string().min(1),
        subtitle: z.string().optional(),
        category: z.string().optional(),
        imageUrl: z.string().optional().or(z.literal("")), // allow empty, relative, or absolute
        linkUrl: z.string().optional().or(z.literal("")),
        startDate: z.string(), // YYYY-MM-DD
        endDate: z.string(), // YYYY-MM-DD
        zoneId: z.string().uuid().nullable().optional(),
        active: z.boolean().optional().default(true),
      });
      const body = schema.parse(request.body);
      const [banner] = await pgClient`
        INSERT INTO banners (title, subtitle, category, image_url, link_url, start_date, end_date, zone_id, active)
        VALUES (${body.title}, ${body.subtitle ?? null}, ${body.category ?? 'Announcement'},
                ${body.imageUrl ?? null}, ${body.linkUrl ?? null},
                ${body.startDate}::date, ${body.endDate}::date,
                ${body.zoneId ?? null}::uuid, ${body.active})
        RETURNING *
      `;
      return reply.status(201).send({ banner });
    },
  );

  // PATCH /api/v1/banners/:id
  app.patch(
    "/api/v1/banners/:id",
    { preHandler: [adminAuth, requireRole("system.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        title: z.string().optional(),
        subtitle: z.string().nullable().optional(),
        category: z.string().nullable().optional(),
        imageUrl: z.string().optional().or(z.literal("")), // allow empty, relative, or absolute
        linkUrl: z.string().optional().or(z.literal("")),
        startDate: z.string().optional(),
        endDate: z.string().optional(),
        active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);
      const [updated] = await pgClient`
        UPDATE banners SET
          title      = COALESCE(${body.title ?? null}, title),
          subtitle   = CASE WHEN ${body.subtitle !== undefined} THEN ${body.subtitle ?? null} ELSE subtitle END,
          category   = CASE WHEN ${body.category !== undefined} THEN ${body.category ?? null} ELSE category END,
          image_url  = CASE WHEN ${body.imageUrl !== undefined} THEN ${body.imageUrl ?? null} ELSE image_url END,
          link_url   = CASE WHEN ${body.linkUrl !== undefined} THEN ${body.linkUrl ?? null} ELSE link_url END,
          start_date = COALESCE(${body.startDate ?? null}::date, start_date),
          end_date   = COALESCE(${body.endDate ?? null}::date, end_date),
          active     = COALESCE(${body.active ?? null}::boolean, active),
          updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      if (!updated)
        return reply.status(404).send({ error: "Banner not found" });
      return reply.send({ banner: updated });
    },
  );

  // DELETE /api/v1/banners/:id
  app.delete(
    "/api/v1/banners/:id",
    { preHandler: [adminAuth, requireRole("system.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await pgClient`DELETE FROM banners WHERE id = ${id}`;
      return reply.send({ message: "Banner deleted" });
    },
  );

  // GET /api/v1/invoices/my — dealer's own invoices
  app.get(
    "/api/v1/invoices/my",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = request.dealer!.dealerId;

      // LEFT JOIN preserves the invoice + adds order_id for the mobile
      // add an explicit month_id derived in IST so client doesn't guess
      const invoices = await pgClient`
      SELECT
        i.id,
        i.order_id,
        i.invoice_number,
        i.invoice_date,
        i.taxable_amount,
        i.cgst,
        i.sgst,
        i.total_tax,
        i.total_amount,
        i.pdf_url,
        -- NEW: server-computed month tag in YYYY-MM format, IST timezone.
        -- The dealer app uses this directly for filtering — no Date math
        -- on the client, no timezone disagreement.
        to_char((i.invoice_date AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM') AS month_id,
        -- NEW: invoice_date as a date-only string for display
        to_char((i.invoice_date AT TIME ZONE 'Asia/Kolkata'), 'YYYY-MM-DD') AS invoice_date_ist,
        COALESCE(o.item_count, 0)        AS item_count,
        COALESCE(o.status::text, 'unknown') AS order_status,
        o.delivery_date                  AS delivery_date
      FROM invoices i
      JOIN orders o ON o.id = i.order_id
      WHERE i.dealer_id = ${dealerId}
        -- Only surface invoices for PLACED orders. A draft / payment_required
        -- order is not a real invoice yet, and a cancelled order's invoice
        -- must not count toward the dealer's GST totals.
        AND o.status IN ('confirmed', 'dispatched', 'delivered')
      ORDER BY i.invoice_date DESC
      LIMIT 50
      `;

      // Summary anchored to the SAME timezone so it always agrees with the list
      const [summary] = await pgClient`
      SELECT
        COALESCE(SUM(total_amount), 0)::numeric AS total_orders,
        COALESCE(SUM(total_tax), 0)::numeric    AS total_gst,
        count(*)::int                            AS invoice_count,
        -- Echo back the month the summary was computed for, so the client
        -- can label its card correctly even on the first render.
        to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') AS current_month_id
      FROM invoices i
      WHERE i.dealer_id = ${dealerId}
        AND date_trunc('month', i.invoice_date AT TIME ZONE 'Asia/Kolkata') =
            date_trunc('month', now() AT TIME ZONE 'Asia/Kolkata')
        -- Match the list query: count only placed-order invoices.
        AND EXISTS (
          SELECT 1 FROM orders o
           WHERE o.id = i.order_id
             AND o.status IN ('confirmed', 'dispatched', 'delivered')
        )
      `;

      return reply.send({ invoices, summary });
    },
  );

  // GET /api/v1/dealer/routes — list routes the dealer is assigned to
  app.get(
    "/api/v1/dealer/routes",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = request.dealer!.dealerId;
      const routes = await pgClient`
        SELECT r.id, r.code, r.name, dr.is_primary AS "isPrimary"
        FROM dealer_routes dr
        JOIN routes r ON r.id = dr.route_id
        WHERE dr.dealer_id = ${dealerId} AND r.deleted_at IS NULL
        ORDER BY dr.is_primary DESC, r.code
      `;
      return reply.send({ routes });
    }
  );

  // PATCH /api/v1/dealer/route — switch the dealer's active route
  // Only routes already assigned to the dealer are allowed.
  app.patch(
    "/api/v1/dealer/route",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = request.dealer!.dealerId;
      const body = z.object({ routeId: z.string().uuid() }).parse(request.body);

      // Guard: only allow switching to an assigned route
      const [assigned] = await pgClient`
        SELECT 1 FROM dealer_routes
         WHERE dealer_id = ${dealerId} AND route_id = ${body.routeId}::uuid
         LIMIT 1
      `;
      if (!assigned)
        return reply.status(403).send({
          error: "Route not assigned",
          message:
            "You can only switch to a route you are assigned to. " +
            "Contact your union office to be added to a route.",
        });

      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        await tx`UPDATE dealer_routes SET is_primary = false WHERE dealer_id = ${dealerId}`;
        await tx`
          UPDATE dealer_routes
             SET is_primary = true
           WHERE dealer_id = ${dealerId} AND route_id = ${body.routeId}::uuid
        `;
        await tx`
          UPDATE dealers
             SET route_id = ${body.routeId}::uuid, updated_at = now()
           WHERE id = ${dealerId}
        `;
      });

      const [route] = await pgClient`
        SELECT id, code, name FROM routes WHERE id = ${body.routeId}::uuid
      `;
      return reply.send({ route, message: "Active route updated" });
    }
  );

  // POST /api/v1/orders/reorder/:id — reorder from a previous order
  app.post(
    "/api/v1/orders/reorder/:id",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const dealerId = request.dealer!.dealerId;

      // Get original order items
      const items = await pgClient`
        SELECT oi.product_id, oi.quantity, p.base_price, p.gst_percent, p.available, p.stock
        FROM order_items oi
        JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ${id}
          AND p.available = true AND p.stock > 0
      `;

      if (items.length === 0) {
        return reply
          .status(400)
          .send({ error: "No available products from that order" });
      }

      // Build cart items for the response (let the client place the actual order)
      const cartItems = items.map((i: any) => ({
        productId: i.product_id,
        quantity: i.quantity,
        unitPrice: parseFloat(i.base_price),
        gstPercent: parseFloat(i.gst_percent),
      }));

      return reply.send({ items: cartItems, message: "Items ready for cart" });
    },
  );
}
