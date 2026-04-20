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

  // GET /api/v1/orders/my — handled in orders.ts, enriched below

  // GET /api/v1/invoices/my — dealer's own invoices
  app.get(
    "/api/v1/invoices/my",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = request.dealer!.dealerId;

      const invoices = await pgClient`
        SELECT i.id, i.invoice_number, i.invoice_date, i.taxable_amount,
               i.cgst, i.sgst, i.total_tax, i.total_amount, i.pdf_url,
               o.item_count, o.status AS order_status
        FROM invoices i
        JOIN orders o ON o.id = i.order_id
        WHERE i.dealer_id = ${dealerId}
        ORDER BY i.invoice_date DESC
        LIMIT 50
      `;

      // Summary for current month
      const [summary] = await pgClient`
        SELECT COALESCE(SUM(total_amount), 0)::numeric AS total_orders,
               COALESCE(SUM(total_tax), 0)::numeric AS total_gst,
               count(*)::int AS invoice_count
        FROM invoices
        WHERE dealer_id = ${dealerId}
          AND date_trunc('month', invoice_date) = date_trunc('month', CURRENT_DATE)
      `;

      return reply.send({ invoices, summary });
    },
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
