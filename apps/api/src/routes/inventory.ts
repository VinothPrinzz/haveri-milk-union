import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql, and, lt } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { products, fgsStockLog, categories } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

export async function inventoryRoutes(app: FastifyInstance) {
  // GET /api/v1/fgs/overview — current stock for all products
  app.get(
    "/api/v1/fgs/overview",
    { preHandler: [adminAuth, requireRole("inventory.view")] },
    async (request, reply) => {
      const stockData = await pgClient`
        SELECT p.id, p.name, p.icon, p.unit, p.stock, p.available,
               p.low_stock_threshold, p.critical_stock_threshold,
               c.name AS category_name,
               CASE
                 WHEN p.stock = 0 THEN 'out_of_stock'
                 WHEN p.stock <= p.critical_stock_threshold THEN 'critical'
                 WHEN p.stock <= p.low_stock_threshold THEN 'low'
                 ELSE 'healthy'
               END AS stock_status
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL
        ORDER BY p.sort_order
      `;

      const summary = {
        totalProducts: stockData.length,
        outOfStock: stockData.filter((p) => p.stock_status === "out_of_stock").length,
        critical: stockData.filter((p) => p.stock_status === "critical").length,
        low: stockData.filter((p) => p.stock_status === "low").length,
        healthy: stockData.filter((p) => p.stock_status === "healthy").length,
      };

      return reply.status(200).send({ summary, products: stockData });
    }
  );

  // POST /api/v1/fgs/update — daily stock entry by Dispatch Officer
  app.post(
    "/api/v1/fgs/update",
    { preHandler: [adminAuth, requireRole("inventory.update")] },
    async (request, reply) => {
      const schema = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        entries: z.array(
          z.object({
            productId: z.string().uuid(),
            opening: z.number().int().min(0),
            received: z.number().int().min(0),
            dispatched: z.number().int().min(0),
            wastage: z.number().int().min(0),
          })
        ),
      });
      const body = schema.parse(request.body);

      const results = [];

      for (const entry of body.entries) {
        const closing =
          entry.opening + entry.received - entry.dispatched - entry.wastage;

        // Upsert — one entry per product per date
        const [row] = await pgClient`
          INSERT INTO fgs_stock_log (product_id, date, opening, received, dispatched, wastage, closing, entered_by)
          VALUES (${entry.productId}, ${body.date}::date, ${entry.opening}, ${entry.received},
                  ${entry.dispatched}, ${entry.wastage}, ${closing}, ${request.admin!.userId})
          ON CONFLICT (product_id, date) DO UPDATE SET
            opening = EXCLUDED.opening,
            received = EXCLUDED.received,
            dispatched = EXCLUDED.dispatched,
            wastage = EXCLUDED.wastage,
            closing = EXCLUDED.closing,
            entered_by = EXCLUDED.entered_by,
            updated_at = now()
          RETURNING *
        `;

        // Also update the product's current stock to match closing
        await pgClient`
          UPDATE products SET stock = ${closing}, updated_at = now()
          WHERE id = ${entry.productId}
        `;

        results.push(row);
      }

      return reply.status(200).send({
        message: `Updated ${results.length} stock entries for ${body.date}`,
        entries: results,
      });
    }
  );

  // GET /api/v1/fgs/alerts — products below threshold
  app.get(
    "/api/v1/fgs/alerts",
    { preHandler: [adminAuth, requireRole("inventory.view")] },
    async (request, reply) => {
      const alerts = await pgClient`
        SELECT p.id, p.name, p.icon, p.unit, p.stock,
               p.low_stock_threshold, p.critical_stock_threshold,
               c.name AS category_name,
               CASE
                 WHEN p.stock = 0 THEN 'out_of_stock'
                 WHEN p.stock <= p.critical_stock_threshold THEN 'critical'
                 ELSE 'low'
               END AS alert_level
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL
          AND p.stock <= p.low_stock_threshold
        ORDER BY p.stock ASC
      `;

      return reply.status(200).send({ alerts });
    }
  );
}
