import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, isNull, asc, sql, and } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { products, categories } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

// Helper to derive base_price (excluding GST) from MRP (inclusive of GST)
function deriveBasePriceFromMrp(mrp: number, gstPercent: number): number {
  const safeGst = Math.max(0, gstPercent || 0);
  return Math.round((mrp / (1 + safeGst / 100)) * 100) / 100;
}

// Constants — single source of truth referenced by both API and web.
export const REPORT_ALIAS_MAX: Record<"Across" | "Down", number> = {
  Across: 14,
  Down:   22,
};

// Updated schema for writing products — now accepts MRP
const productBaseSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(1),
  mrp: z.number().nonnegative(),
  gstPercent: z.number().min(0).max(50).default(0),
  categoryId: z.string().uuid(),
  icon: z.string().optional(),
  unit: z.string().min(1),
  stock: z.number().int().min(0).optional().default(0),
  available: z.boolean().optional().default(true),
  hsnNo: z.string().optional(),
  packSize: z.union([z.string(), z.number()]).optional(),
  printDirection: z.enum(["Across", "Down"]).optional(),
  packetsCrate: z.number().int().min(0).optional(),
  reportAlias: z.string().max(22).optional(),
  retailDealerPrice: z.union([z.string(), z.number()]).optional(),
  creditInstMrpPrice: z.union([z.string(), z.number()]).optional(),
  creditInstDealerPrice: z.union([z.string(), z.number()]).optional(),
  parlourDealerPrice: z.union([z.string(), z.number()]).optional(),
});

const productWriteSchema = productBaseSchema
  .superRefine((data, ctx) => {
    if (!data.reportAlias) return;

    const direction = data.printDirection ?? "Across";
    const maxLen = REPORT_ALIAS_MAX[direction];

    if (data.reportAlias.length > maxLen) {
      ctx.addIssue({
        code: z.ZodIssueCode.too_big,
        type: "string",
        maximum: maxLen,
        inclusive: true,
        message: `Report alias for ${direction} products must be ≤ ${maxLen} characters (got ${data.reportAlias.length})`,
        path: ["reportAlias"],
      });
    }
  });

// For PATCH - make it partial
const productUpdateSchema = productBaseSchema.partial().superRefine((data, ctx) => {
  if (!data.reportAlias) return;

  const direction = data.printDirection ?? "Across";
  const maxLen = REPORT_ALIAS_MAX[direction];

  if (data.reportAlias.length > maxLen) {
    ctx.addIssue({
      code: z.ZodIssueCode.too_big,
      type: "string",
      maximum: maxLen,
      inclusive: true,
      message: `Report alias for ${direction} products must be ≤ ${maxLen} characters (got ${data.reportAlias.length})`,
      path: ["reportAlias"],
    });
  }
});

export async function productRoutes(app: FastifyInstance) {
  // GET /api/v1/products — now includes mrp
  app.get("/api/v1/products", async (request, reply) => {
    const productsList = await pgClient`
      SELECT p.id, p.name, p.icon, p.unit, p.base_price AS "basePrice",
             p.mrp,                                      -- ← ADDED
             p.gst_percent AS "gstPercent", p.stock, p.available,
             p.category_id AS "categoryId", c.name AS "categoryName",
             p.sort_order AS "sortOrder",
             p.code, p.hsn_no AS "hsnNo", p.pack_size AS "packSize",
             p.print_direction AS "printDirection",
             p.packets_crate AS "packetsCrate", p.report_alias AS "reportAlias",
             COALESCE(p.retail_dealer_price, p.base_price) AS "retailDealerPrice",
             COALESCE(p.credit_inst_mrp_price, p.base_price) AS "creditInstMrpPrice",
             COALESCE(p.credit_inst_dealer_price, p.base_price) AS "creditInstDealerPrice",
             COALESCE(p.parlour_dealer_price, p.base_price) AS "parlourDealerPrice"
      FROM products p
      JOIN categories c ON c.id = p.category_id
      WHERE p.deleted_at IS NULL AND p.available = true
      ORDER BY p.sort_order, p.name
    `;
    return reply.status(200).send({ products: productsList });
  });

  // GET /api/v1/products/all — now includes mrp
  app.get(
    "/api/v1/products/all",
    { preHandler: [adminAuth, requireRole("products.view")] },
    async (request, reply) => {
      const query = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
      const data = await pgClient`
        SELECT p.id, p.name, p.icon, p.unit, p.base_price AS "basePrice",
               p.mrp,                                      -- ← ADDED
               p.gst_percent AS "gstPercent", p.stock, p.available,
               p.category_id AS "categoryId", c.name AS "categoryName",
               p.sort_order AS "sortOrder",
               p.low_stock_threshold AS "lowStockThreshold",
               p.critical_stock_threshold AS "criticalStockThreshold",
               p.created_at AS "createdAt",
               p.code, p.hsn_no AS "hsnNo", p.pack_size AS "packSize",
               p.print_direction AS "printDirection",
               p.packets_crate AS "packetsCrate", p.report_alias AS "reportAlias",
               COALESCE(p.retail_dealer_price, p.base_price) AS "retailDealerPrice",
               COALESCE(p.credit_inst_mrp_price, p.base_price) AS "creditInstMrpPrice",
               COALESCE(p.credit_inst_dealer_price, p.base_price) AS "creditInstDealerPrice",
               COALESCE(p.parlour_dealer_price, p.base_price) AS "parlourDealerPrice"
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL
        ORDER BY p.sort_order, p.name
        LIMIT ${query.limit} OFFSET ${offset}
      `;
      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM products WHERE deleted_at IS NULL
      `;
      return reply.status(200).send({
        data,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/categories — unchanged
  app.get("/api/v1/categories", async (request, reply) => {
    const cats = await db
      .select({ id: categories.id, name: categories.name, icon: categories.icon, sortOrder: categories.sortOrder })
      .from(categories)
      .where(and(isNull(categories.deletedAt), eq(categories.active, true)))
      .orderBy(asc(categories.sortOrder));
    return reply.status(200).send({ categories: cats });
  });

  // POST /api/v1/products — Updated to accept MRP
  app.post(
    "/api/v1/products",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const body = productWriteSchema.parse(request.body);
      const basePrice = deriveBasePriceFromMrp(body.mrp, body.gstPercent);

      // Auto-generate code if not provided
      let code = body.code;
      if (!code) {
        const [last] = await pgClient`
          SELECT code FROM products
          WHERE code ~ '^P[0-9]+$' AND deleted_at IS NULL
          ORDER BY CAST(SUBSTRING(code FROM 2) AS integer) DESC LIMIT 1
        `;
        const lastNum = last ? parseInt(last.code.slice(1)) : 0;
        code = `P${String(lastNum + 1).padStart(2, "0")}`;
      }

      const [product] = await pgClient`
        INSERT INTO products (
          name, category_id, icon, unit, base_price, gst_percent, stock, available,
          code, hsn_no, pack_size, print_direction, packets_crate, report_alias, mrp,
          retail_dealer_price, credit_inst_mrp_price, credit_inst_dealer_price, parlour_dealer_price
        ) VALUES (
          ${body.name}, ${body.categoryId}, ${body.icon ?? null}, ${body.unit},
          ${basePrice}::numeric, ${body.gstPercent}::numeric, ${body.stock}, ${body.available},
          ${code}, ${body.hsnNo ?? null}, ${body.packSize ?? null}::numeric,
          ${body.printDirection ?? "Across"}, ${body.packetsCrate ?? 0},
          ${body.reportAlias ?? body.name}, ${body.mrp}::numeric,
          ${body.retailDealerPrice ?? basePrice}::numeric,
          ${body.creditInstMrpPrice ?? basePrice}::numeric,
          ${body.creditInstDealerPrice ?? basePrice}::numeric,
          ${body.parlourDealerPrice ?? basePrice}::numeric
        )
        RETURNING *
      `;

      return reply.status(201).send({ product });
    }
  );

  // PATCH /api/v1/products/:id — Updated with MRP logic
  app.patch(
    "/api/v1/products/:id",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = productUpdateSchema.parse(request.body);

      // Fetch current MRP & GST to recompute base_price if needed
      const [current] = await pgClient`
        SELECT mrp, gst_percent FROM products WHERE id = ${id} AND deleted_at IS NULL
      `;
      if (!current) return reply.status(404).send({ error: "Product not found" });

      const newMrp = body.mrp !== undefined ? body.mrp : Number(current.mrp);
      const newGst = body.gstPercent !== undefined ? body.gstPercent : Number(current.gst_percent);
      const basePrice = deriveBasePriceFromMrp(newMrp, newGst);

      const [updated] = await pgClient`
        UPDATE products SET
          name = COALESCE(${body.name ?? null}, name),
          category_id = COALESCE(${body.categoryId ?? null}::uuid, category_id),
          icon = CASE WHEN ${body.icon !== undefined} THEN ${body.icon ?? null} ELSE icon END,
          unit = COALESCE(${body.unit ?? null}, unit),
          base_price = ${basePrice}::numeric,
          gst_percent = ${newGst}::numeric,
          stock = COALESCE(${body.stock ?? null}::int, stock),
          available = COALESCE(${body.available ?? null}::boolean, available),
          code = COALESCE(${body.code ?? null}, code),
          hsn_no = CASE WHEN ${body.hsnNo !== undefined} THEN ${body.hsnNo ?? null} ELSE hsn_no END,
          pack_size = COALESCE(${body.packSize ?? null}::numeric, pack_size),
          print_direction = COALESCE(${body.printDirection ?? null}, print_direction),
          packets_crate = COALESCE(${body.packetsCrate ?? null}::int, packets_crate),
          report_alias = COALESCE(${body.reportAlias ?? null}, report_alias),
          mrp = ${newMrp}::numeric,                                   -- ← UPDATED
          retail_dealer_price = COALESCE(${body.retailDealerPrice ?? null}::numeric, retail_dealer_price),
          credit_inst_mrp_price = COALESCE(${body.creditInstMrpPrice ?? null}::numeric, credit_inst_mrp_price),
          credit_inst_dealer_price = COALESCE(${body.creditInstDealerPrice ?? null}::numeric, credit_inst_dealer_price),
          parlour_dealer_price = COALESCE(${body.parlourDealerPrice ?? null}::numeric, parlour_dealer_price),
          updated_at = now()
        WHERE id = ${id} AND deleted_at IS NULL
        RETURNING *
      `;

      return reply.status(200).send({ product: updated });
    }
  );
}