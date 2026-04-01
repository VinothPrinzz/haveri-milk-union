import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { dealerAuth } from "../middleware/dealer-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function dealerAppRoutes(app: FastifyInstance) {
  // GET /api/v1/banners — active marketing banners for dealer app
  app.get("/api/v1/banners", async (request, reply) => {
    const banners = await pgClient`
      SELECT id, title, subtitle, image_url, start_date, end_date
      FROM banners
      WHERE active = true
        AND start_date <= CURRENT_DATE
        AND end_date >= CURRENT_DATE
      ORDER BY created_at DESC
    `;
    return reply.send({ banners });
  });

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
        return reply.status(400).send({ error: "No available products from that order" });
      }

      // Build cart items for the response (let the client place the actual order)
      const cartItems = items.map((i: any) => ({
        productId: i.product_id,
        quantity: i.quantity,
        unitPrice: parseFloat(i.base_price),
        gstPercent: parseFloat(i.gst_percent),
      }));

      return reply.send({ items: cartItems, message: "Items ready for cart" });
    }
  );
}
