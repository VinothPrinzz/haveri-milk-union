import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, and, isNull } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { categories, products, priceRevisions, routes, routeAssignments } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

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
      const [cat] = await db.insert(categories).values({ ...body, sortOrder: maxOrder[0]?.next ?? 1 }).returning();
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

  // POST /api/v1/price-revisions — batch price update
  app.post(
    "/api/v1/price-revisions",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const schema = z.object({
        revisions: z.array(z.object({
          productId: z.string().uuid(),
          newPrice: z.string(),
          newGstPercent: z.string().optional(),
          effectiveFrom: z.string().optional(),
        })),
      });
      const body = schema.parse(request.body);
      const results = [];

      for (const rev of body.revisions) {
        const [product] = await db.select({ basePrice: products.basePrice, gstPercent: products.gstPercent }).from(products).where(eq(products.id, rev.productId)).limit(1);
        if (!product) continue;

        const oldPrice = product.basePrice;
        const oldGst = product.gstPercent;
        const newGst = rev.newGstPercent ?? oldGst;

        // Only log if price actually changed
        if (rev.newPrice !== oldPrice || newGst !== oldGst) {
          await db.insert(priceRevisions).values({
            productId: rev.productId,
            oldPrice: oldPrice,
            newPrice: rev.newPrice,
            oldGstPercent: oldGst,
            newGstPercent: newGst,
            effectiveFrom: rev.effectiveFrom ?? new Date().toISOString().split("T")[0]!,
            changedBy: request.admin!.userId,
          });

          await db.update(products).set({ basePrice: rev.newPrice, gstPercent: newGst, updatedAt: new Date() }).where(eq(products.id, rev.productId));
          results.push({ productId: rev.productId, oldPrice, newPrice: rev.newPrice });
        }
      }

      return reply.send({ message: `Updated ${results.length} prices`, results });
    }
  );

  // ═══ ROUTE UPDATES ═══

  // PATCH /api/v1/routes/:id
  app.patch(
    "/api/v1/routes/:id",
    { preHandler: [adminAuth, requireRole("distribution.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().optional(), code: z.string().optional(), zoneId: z.string().uuid().optional(),
        stops: z.number().int().optional(), distanceKm: z.string().optional(), active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);
      const [updated] = await db.update(routes).set({ ...body, updatedAt: new Date() }).where(and(eq(routes.id, id), isNull(routes.deletedAt))).returning();
      if (!updated) return reply.status(404).send({ error: "Route not found" });
      return reply.send({ route: updated });
    }
  );

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
