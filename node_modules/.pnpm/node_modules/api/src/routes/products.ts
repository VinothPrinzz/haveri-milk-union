import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, isNull, asc, sql, and } from "drizzle-orm";
import { db } from "../lib/db.js";
import { products, categories } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function productRoutes(app: FastifyInstance) {
  // GET /api/v1/products — active products with prices (dealer app uses this)
  app.get("/api/v1/products", async (request, reply) => {
    const allProducts = await db
      .select({
        id: products.id,
        name: products.name,
        icon: products.icon,
        unit: products.unit,
        basePrice: products.basePrice,
        gstPercent: products.gstPercent,
        stock: products.stock,
        available: products.available,
        categoryId: products.categoryId,
        categoryName: categories.name,
        categoryIcon: categories.icon,
        sortOrder: products.sortOrder,
      })
      .from(products)
      .innerJoin(categories, eq(products.categoryId, categories.id))
      .where(and(isNull(products.deletedAt), eq(products.available, true)))
      .orderBy(asc(products.sortOrder));

    return reply.status(200).send({ products: allProducts });
  });

  // GET /api/v1/products/all — all products including unavailable (admin)
  app.get(
    "/api/v1/products/all",
    { preHandler: [adminAuth, requireRole("products.view")] },
    async (request, reply) => {
      const query = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);

      const [data, [countRow]] = await Promise.all([
        db
          .select({
            id: products.id,
            name: products.name,
            icon: products.icon,
            unit: products.unit,
            basePrice: products.basePrice,
            gstPercent: products.gstPercent,
            stock: products.stock,
            available: products.available,
            categoryId: products.categoryId,
            categoryName: categories.name,
            sortOrder: products.sortOrder,
            lowStockThreshold: products.lowStockThreshold,
            criticalStockThreshold: products.criticalStockThreshold,
            createdAt: products.createdAt,
          })
          .from(products)
          .innerJoin(categories, eq(products.categoryId, categories.id))
          .where(isNull(products.deletedAt))
          .orderBy(asc(products.sortOrder))
          .limit(query.limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(products)
          .where(isNull(products.deletedAt)),
      ]);

      return reply.status(200).send({
        data,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/categories — all active categories
  app.get("/api/v1/categories", async (request, reply) => {
    const cats = await db
      .select({
        id: categories.id,
        name: categories.name,
        icon: categories.icon,
        sortOrder: categories.sortOrder,
      })
      .from(categories)
      .where(and(isNull(categories.deletedAt), eq(categories.active, true)))
      .orderBy(asc(categories.sortOrder));

    return reply.status(200).send({ categories: cats });
  });

  // POST /api/v1/products — create product (admin)
  app.post(
    "/api/v1/products",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        categoryId: z.string().uuid(),
        icon: z.string().optional(),
        unit: z.string().min(1),
        basePrice: z.string().regex(/^\d+(\.\d{1,2})?$/),
        gstPercent: z.string().regex(/^\d+(\.\d{1,2})?$/),
        stock: z.number().int().min(0).default(0),
        available: z.boolean().default(true),
      });
      const body = schema.parse(request.body);

      const [product] = await db
        .insert(products)
        .values(body)
        .returning();

      return reply.status(201).send({ product });
    }
  );

  // PATCH /api/v1/products/:id — update product (admin)
  app.patch(
    "/api/v1/products/:id",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().min(1).optional(),
        categoryId: z.string().uuid().optional(),
        icon: z.string().optional(),
        unit: z.string().min(1).optional(),
        basePrice: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        gstPercent: z.string().regex(/^\d+(\.\d{1,2})?$/).optional(),
        stock: z.number().int().min(0).optional(),
        available: z.boolean().optional(),
      });
      const body = schema.parse(request.body);

      const [updated] = await db
        .update(products)
        .set({ ...body, updatedAt: new Date() })
        .where(and(eq(products.id, id), isNull(products.deletedAt)))
        .returning();

      if (!updated) {
        return reply.status(404).send({ error: "Product not found" });
      }

      return reply.status(200).send({ product: updated });
    }
  );
}
