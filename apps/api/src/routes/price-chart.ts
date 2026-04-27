import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

export async function priceChartRoutes(app: FastifyInstance) {
  // ═══ RATE CATEGORIES ═══

  // GET /api/v1/rate-categories
  app.get(
    "/api/v1/rate-categories",
    { preHandler: [adminAuth, requireRole("price_chart.view")] },
    async (request, reply) => {
      const rows = await pgClient`
        SELECT id, name, description, sort_order, active, created_at
        FROM rate_categories
        ORDER BY sort_order, name
      `;
      return reply.send({ data: rows });
    }
  );

  // POST /api/v1/rate-categories
  app.post(
    "/api/v1/rate-categories",
    { preHandler: [adminAuth, requireRole("price_chart.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        sortOrder: z.number().int().optional(),
      });
      const body = schema.parse(request.body);

      const [maxOrder] = await pgClient`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM rate_categories`;
      const [category] = await pgClient`
        INSERT INTO rate_categories (name, description, sort_order)
        VALUES (${body.name}, ${body.description ?? null}, ${body.sortOrder ?? maxOrder?.next ?? 1})
        RETURNING *
      `;
      return reply.status(201).send({ category });
    }
  );

  // PATCH /api/v1/rate-categories/:id
  app.patch(
    "/api/v1/rate-categories/:id",
    { preHandler: [adminAuth, requireRole("price_chart.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().min(1).optional(),
        description: z.string().nullable().optional(),
        sortOrder: z.number().int().optional(),
        active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);

      const [updated] = await pgClient`
        UPDATE rate_categories SET
          name = COALESCE(${body.name ?? null}, name),
          description = CASE WHEN ${body.description !== undefined} THEN ${body.description ?? null} ELSE description END,
          sort_order = COALESCE(${body.sortOrder ?? null}::int, sort_order),
          active = COALESCE(${body.active ?? null}::boolean, active),
          updated_at = now()
        WHERE id = ${id}
        RETURNING *
      `;
      if (!updated) return reply.status(404).send({ error: "Rate category not found" });
      return reply.send({ category: updated });
    }
  );

  // ═══ PRICE CHART ═══

  // GET /api/v1/price-chart — pivoted, COALESCE to base_price so empty cells still show MRP
  app.get(
    "/api/v1/price-chart",
    { preHandler: [adminAuth, requireRole("price_chart.view")] },
    async (request, reply) => {
      const rows = await pgClient`
        SELECT p.id            AS "productId",
              p.name          AS "productName",
              p.report_alias  AS "reportAlias",
              p.code,
              p.pack_size     AS "packSize",
              p.unit,
              c.name          AS category,
              p.gst_percent   AS "gstPercent",
              p.base_price    AS mrp,
              COALESCE(p.retail_dealer_price,      p.base_price) AS "Retail-Dealer",
              COALESCE(p.credit_inst_mrp_price,    p.base_price) AS "Credit Inst-MRP",
              COALESCE(p.credit_inst_dealer_price, p.base_price) AS "Credit Inst-Dealer",
              COALESCE(p.parlour_dealer_price,     p.base_price) AS "Parlour-Dealer"
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL
        ORDER BY p.sort_order, p.name
      `;
      return reply.send({ data: rows });
    }
  );

  // POST /api/v1/price-chart — set price for a product + rate category
  app.post(
    "/api/v1/price-chart",
    { preHandler: [adminAuth, requireRole("price_chart.manage")] },
    async (request, reply) => {
      const schema = z.object({
        productId: z.string().uuid(),
        rateCategoryId: z.string().uuid(),
        price: z.number().positive(),
        effectiveFrom: z.string().optional(), // ISO date, defaults to today
      });
      const body = schema.parse(request.body);
      const effectiveFrom = body.effectiveFrom ?? new Date().toISOString().slice(0, 10);

      // Close any existing active price for this product + category
      await pgClient`
        UPDATE price_chart SET
          effective_to = ${effectiveFrom}::date,
          updated_at = now()
        WHERE product_id = ${body.productId}
          AND rate_category_id = ${body.rateCategoryId}
          AND effective_to IS NULL
      `;

      // Insert new active price
      const [entry] = await pgClient`
        INSERT INTO price_chart (product_id, rate_category_id, price, effective_from, created_by)
        VALUES (${body.productId}, ${body.rateCategoryId}, ${body.price}, ${effectiveFrom}::date,
                ${request.admin!.userId})
        RETURNING *
      `;

      return reply.status(201).send({ entry });
    }
  );

  // POST /api/v1/price-chart/bulk — set prices for multiple products at once
  app.post(
    "/api/v1/price-chart/bulk",
    { preHandler: [adminAuth, requireRole("price_chart.manage")] },
    async (request, reply) => {
      const schema = z.object({
        entries: z.array(z.object({
          productId: z.string().uuid(),
          rateCategoryId: z.string().uuid(),
          price: z.number().positive(),
        })).min(1),
        effectiveFrom: z.string().optional(),
      });
      const body = schema.parse(request.body);
      const effectiveFrom = body.effectiveFrom ?? new Date().toISOString().slice(0, 10);

      let count = 0;
      for (const entry of body.entries) {
        // Close existing
        await pgClient`
          UPDATE price_chart SET effective_to = ${effectiveFrom}::date, updated_at = now()
          WHERE product_id = ${entry.productId}
            AND rate_category_id = ${entry.rateCategoryId}
            AND effective_to IS NULL
        `;
        // Insert new
        await pgClient`
          INSERT INTO price_chart (product_id, rate_category_id, price, effective_from, created_by)
          VALUES (${entry.productId}, ${entry.rateCategoryId}, ${entry.price},
                  ${effectiveFrom}::date, ${request.admin!.userId})
        `;
        count++;
      }

      return reply.status(201).send({ message: `${count} price(s) updated`, count });
    }
  );

  // GET /api/v1/price-chart/history/:productId — price history for a product
  app.get(
    "/api/v1/price-chart/history/:productId",
    { preHandler: [adminAuth, requireRole("price_chart.view")] },
    async (request, reply) => {
      const { productId } = request.params as { productId: string };
      const rows = await pgClient`
        SELECT pc.*, rc.name AS rate_category_name, u.name AS created_by_name
        FROM price_chart pc
        JOIN rate_categories rc ON rc.id = pc.rate_category_id
        LEFT JOIN users u ON u.id = pc.created_by
        WHERE pc.product_id = ${productId}
        ORDER BY pc.effective_from DESC, rc.sort_order
      `;
      return reply.send({ data: rows });
    }
  );
}