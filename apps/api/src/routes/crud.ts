import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { categories, products, priceRevisions, routes, routeAssignments } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function crudRoutes(app: FastifyInstance) {
  // ═══ CATEGORIES CRUD ═══
  // POST /api/v1/categories
  app.post(
    "/api/v1/categories",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const schema = z.object({ name: z.string().min(1), icon: z.string().optional() });
      const body = schema.parse(request.body);
      const maxOrder = await pgClient`SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM categories`;
      const [cat] = await db.insert(categories).values({ name: body.name, icon: body.icon, sortOrder: maxOrder[0]?.next ?? 1 }).returning();
      return reply.status(201).send({ category: cat });
    }
  );
  // PATCH /api/v1/categories/:id
  app.patch(
    "/api/v1/categories/:id",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({ name: z.string().min(1).optional(), icon: z.string().optional(), active: z.boolean().optional() });
      const body = schema.parse(request.body);
      const [updated] = await db.update(categories).set({ ...body, updatedAt: new Date() }).where(eq(categories.id, id)).returning();
      if (!updated) return reply.status(404).send({ error: "Category not found" });
      return reply.send({ category: updated });
    }
  );

  // ═══ PRICE REVISION ═══
  // GET /api/v1/price-revisions
  // Paginated history. Product join to show code/name + user join
  // to show who changed it. Filters: productId, dateFrom, dateTo.
  // Sort: effective_from DESC, then created_at DESC.
  app.get(
    "/api/v1/price-revisions",
    { preHandler: [adminAuth, requireRole("products.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        productId: z.string().uuid().optional(),
        dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        dateTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);
      const productId = q.productId ?? null;
      const dateFrom = q.dateFrom ?? null;
      const dateTo = q.dateTo ?? null;
      const rows = await pgClient`
        SELECT
          pr.id,
          pr.product_id AS "productId",
          p.code AS "productCode",
          COALESCE(p.report_alias, p.name) AS "productName",
          p.unit AS "unit",
          pr.old_price AS "oldPrice",
          pr.new_price AS "newPrice",
          pr.old_gst_percent AS "oldGst",
          pr.new_gst_percent AS "newGst",
          pr.effective_from AS "effectiveFrom",
          pr.reason AS "reason",
          pr.changed_by AS "changedBy",
          u.name AS "changedByName",
          pr.created_at AS "createdAt"
        FROM price_revisions pr
        JOIN products p ON p.id = pr.product_id
        LEFT JOIN users u ON u.id = pr.changed_by
        WHERE (${productId}::uuid IS NULL OR pr.product_id = ${productId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${dateFrom}::date IS NULL OR pr.effective_from >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date IS NULL OR pr.effective_from <= ${dateTo ?? '9999-12-31'}::date)
        ORDER BY pr.effective_from DESC, pr.created_at DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;
      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM price_revisions pr
        WHERE (${productId}::uuid IS NULL OR pr.product_id = ${productId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${dateFrom}::date IS NULL OR pr.effective_from >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date IS NULL OR pr.effective_from <= ${dateTo ?? '9999-12-31'}::date)
      `;
      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // GET /api/v1/products/with-pricing
  // Flattened list for the Price Revisions bulk-edit grid.
  // Returns a single row per product with all 4 rate-category
  // prices + base price + gst already flattened — no nested
  // categories tree like GET /products returns. Sorted by category
  // name then product sort_order.
  app.get(
    "/api/v1/products/with-pricing",
    { preHandler: [adminAuth, requireRole("products.view")] },
    async (request, reply) => {
      // No pagination — the Price Revisions editor shows everything at
      // once. Products list is small (< 100 typical for a dairy union).
      const rows = await pgClient`
        SELECT
          p.id,
          p.code,
          COALESCE(p.report_alias, p.name) AS name,
          p.unit,
          p.pack_size AS "packSize",
          p.hsn_no AS "hsnNo",
          p.base_price AS "basePrice",
          p.gst_percent AS "gstPercent",
          c.id AS "categoryId",
          c.name AS "categoryName",
          COALESCE(p.retail_dealer_price, p.base_price) AS "retailDealerPrice",
          COALESCE(p.credit_inst_mrp_price, p.base_price) AS "creditInstMrpPrice",
          COALESCE(p.credit_inst_dealer_price, p.base_price) AS "creditInstDealerPrice",
          COALESCE(p.parlour_dealer_price, p.base_price) AS "parlourDealerPrice",
          p.sort_order AS "sortOrder",
          -- Timestamp of last price revision, for display in the grid.
          (SELECT MAX(pr.effective_from)
           FROM price_revisions pr WHERE pr.product_id = p.id) AS "lastRevisedAt"
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL
        ORDER BY c.name, p.sort_order, p.name
      `;
      return reply.send({ data: rows });
    }
  );

  // POST /api/v1/price-revisions — batch price update (fixed)
  app.post(
    "/api/v1/price-revisions",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const schema = z.object({
        revisions: z.array(z.object({
          productId: z.string().uuid(),
          newPrice: z.union([z.string(), z.number()]),
          newGstPercent: z.union([z.string(), z.number()]).optional(),
          effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        })).min(1),
        reason: z.string().optional(), // applied to all revisions in this batch
      });
      const body = schema.parse(request.body);
      const today = new Date().toISOString().slice(0, 10);
      // Whole batch in one transaction — either all revisions commit or
      // none do. If the audit-log insert fails mid-loop, the products
      // update is rolled back.
      const results = await pgClient.begin(async (tx) => {
        const applied: Array<{ productId: string; oldPrice: string; newPrice: string }> = [];
        for (const rev of body.revisions) {
          // Fetch current values for the audit log + change detection.
          const [product] = await tx`
            SELECT base_price, gst_percent
            FROM products
            WHERE id = ${rev.productId} AND deleted_at IS NULL
            FOR UPDATE
          `;
          if (!product) continue;
          const oldPrice = product.base_price as string;
          const oldGst = product.gst_percent as string;
          // Normalize new values to strings for DB, but compare
          // numerically so "30" vs "30.00" doesn't log a phantom
          // revision.
          const newPriceStr = typeof rev.newPrice === "number"
            ? rev.newPrice.toFixed(2)
            : rev.newPrice;
          const newGstStr = rev.newGstPercent == null
            ? oldGst
            : (typeof rev.newGstPercent === "number"
                 ? rev.newGstPercent.toFixed(2)
                 : rev.newGstPercent);
          const priceChanged = Number(newPriceStr) !== Number(oldPrice);
          const gstChanged = Number(newGstStr) !== Number(oldGst);
          if (!priceChanged && !gstChanged) continue;
          await tx`
            INSERT INTO price_revisions (
              product_id, old_price, new_price,
              old_gst_percent, new_gst_percent,
              effective_from, changed_by, reason
            ) VALUES (
              ${rev.productId},
              ${oldPrice}::numeric,
              ${newPriceStr}::numeric,
              ${oldGst}::numeric,
              ${newGstStr}::numeric,
              ${rev.effectiveFrom ?? today}::date,
              ${request.admin!.userId},
              ${body.reason ?? null}
            )
          `;
          await tx`
            UPDATE products SET
              base_price = ${newPriceStr}::numeric,
              gst_percent = ${newGstStr}::numeric,
              updated_at = now()
            WHERE id = ${rev.productId}
          `;
          applied.push({
            productId: rev.productId,
            oldPrice,
            newPrice: newPriceStr,
          });
        }
        return applied;
      });
      return reply.send({
        message: `Updated ${results.length} price(s)`,
        results,
      });
    }
  );

  // ═══ ROUTE UPDATES ═══
  // PATCH /api/v1/routes/:id
  // app.patch(
  // "/api/v1/routes/:id",
  // { preHandler: [adminAuth, requireRole("distribution.manage")] },
  // async (request, reply) => {
  // const { id } = request.params as { id: string };
  // const schema = z.object({
  // name: z.string().optional(), code: z.string().optional(), zoneId: z.string().uuid().optional(),
  // stops: z.number().int().optional(), distanceKm: z.string().optional(), active: z.boolean().optional(),
  // });
  // const body = schema.parse(request.body);
  // const [updated] = await db.update(routes).set({ ...body, updatedAt: new Date() }).where(and(eq(routes.id, id), isNull(routes.deletedAt))).returning();
  // if (!updated) return reply.status(404).send({ error: "Route not found" });
  // return reply.send({ route: updated });
  // }
  // );

  // ═══ DISPATCH STATUS UPDATE ═══
  // PATCH /api/v1/dispatch/:id/status — mark assignment as dispatched/delivered
  app.patch(
    "/api/v1/dispatch/:id/status",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({ status: z.enum(["loading", "dispatched", "delivered"]) });
      const body = schema.parse(request.body);
      const updates: any = { status: body.status, updatedAt: new Date() };
      if (body.status === "dispatched") updates.actualDepartureTime = new Date();
      const [updated] = await db.update(routeAssignments).set(updates).where(eq(routeAssignments.id, id)).returning();
      if (!updated) return reply.status(404).send({ error: "Assignment not found" });
      return reply.send({ assignment: updated });
    }
  );

  // ═══ DELETE PRODUCT (soft) ═══
  app.delete(
    "/api/v1/products/:id",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await db.update(products).set({ deletedAt: new Date() }).where(eq(products.id, id));
      return reply.send({ message: "Product deleted" });
    }
  );
}