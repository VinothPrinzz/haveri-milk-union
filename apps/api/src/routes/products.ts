// apps/api/src/routes/products.ts
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, isNull, asc, and } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { categories } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

// Helper to derive base_price ("Basic Price", excluding GST) from the
// Dealer-Price (gross, inclusive of GST).
function deriveBasePriceFromDealerPrice(dealerPrice: number, gstPercent: number): number {
  const safeGst = Math.max(0, gstPercent || 0);
  return Math.round((dealerPrice / (1 + safeGst / 100)) * 100) / 100;
}

// Constants — single source of truth referenced by both API and web.
export const REPORT_ALIAS_MAX: Record<"Across" | "Down", number> = {
  Across: 14,
  Down:   22,
};

// Schema for writing products — three-tier pricing.
//   dealerPrice → Dealer-Price (gross, client-entered)
//   mrp         → MRP          (client-entered; defaults to dealerPrice)
//   base_price  → Basic Price  (derived server-side, never sent by client)
const productBaseSchema = z.object({
  code: z.string().min(1).optional(),
  name: z.string().min(1),
  dealerPrice: z.coerce.number().nonnegative(),
  mrp: z.coerce.number().nonnegative().optional(),
  gstPercent: z.coerce.number().min(0).max(50).default(0),
  categoryId: z.string().uuid(),
  icon: z.string().optional(),
  unit: z.string().min(1),
  stock: z.number().int().min(0).optional().default(0),
  available: z.boolean().optional().default(true),
  hsnNo: z.string().optional(),
  packSize: z.union([z.string(), z.number()]).optional(),
  printDirection: z.enum(["Across", "Down"]).optional(),
  packetsCrate: z.number().int().min(0).optional(),
  abstractPosition: z.coerce.number().int().min(0).optional(),
  reportAlias: z.string().max(22).optional(),
  retailDealerPrice: z.union([z.string(), z.number()]).optional(),
  creditInstMrpPrice: z.union([z.string(), z.number()]).optional(),
  creditInstDealerPrice: z.union([z.string(), z.number()]).optional(),
  parlourDealerPrice: z.union([z.string(), z.number()]).optional(),
  imageUrl: z.string().url().nullable().optional(),
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
  // GET /api/v1/products — includes basePrice, dealerPrice, mrp
  app.get("/api/v1/products", async (request, reply) => {
    // `stock` is the DAY-AWARE available quantity, derived live from the FGS
    // daily model (fgs_stock_log) — NOT the free-floating products.stock
    // counter, which carries indefinitely and drifts for any SKU whose stock
    // was set outside the morning Stock Entry flow (that drift is why a
    // product with a zero opening for today could still show hundreds "in
    // stock"). Availability for today =
    //   opening (carried from the most recent prior day's closing when today
    //            has no Stock Entry yet, else 0)
    //   + received − wastage
    //   − reservations already claimed by live orders for today's delivery.
    // Floored at 0.
    const productsList = await pgClient`
      WITH today AS (
        SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS d
      ),
      reserved AS (
        -- Stock already committed by live orders for today's delivery. An
        -- order holds its reservation exactly while stock_deducted = true (set
        -- at confirm, cleared on cancel/restore), so every committed order —
        -- confirmed, dispatched or delivered — is counted once and cancelled
        -- ones drop out. Keyed by the stock-owning product: a variant SKU
        -- draws from its base via stock_source_product_id (migration 0059), so
        -- a subsidy-line order reduces the base SKU's availability.
        SELECT COALESCE(pp.stock_source_product_id, pp.id) AS stock_product_id,
               SUM(oi.quantity)::int AS qty
        FROM orders o
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products pp    ON pp.id = oi.product_id
        WHERE o.delivery_date = (SELECT d FROM today)
          AND o.stock_deducted = true
        GROUP BY COALESCE(pp.stock_source_product_id, pp.id)
      )
      SELECT p.id, p.name, p.icon, p.unit,
             p.base_price   AS "basePrice",     -- Basic Price (pre-GST)
             p.dealer_price AS "dealerPrice",   -- Dealer-Price (gross)
             p.mrp,                             -- MRP
             p.gst_percent AS "gstPercent",
             GREATEST(
               COALESCE(
                 fsl.opening,
                 (SELECT prev.closing
                    FROM fgs_stock_log prev
                   WHERE prev.product_id = p.id
                     AND prev.date < (SELECT d FROM today)
                   ORDER BY prev.date DESC
                   LIMIT 1),
                 0
               )
               + COALESCE(fsl.received, 0)
               - COALESCE(fsl.wastage, 0)
               - COALESCE(r.qty, 0),
               0
             )::int AS stock,
             p.available,
             p.category_id AS "categoryId", c.name AS "categoryName",
             p.sort_order AS "sortOrder",
             p.code, p.hsn_no AS "hsnNo", p.pack_size AS "packSize",
             p.print_direction AS "printDirection",
             p.packets_crate AS "packetsCrate", p.report_alias AS "reportAlias",
             p.abstract_position AS "abstractPosition",
             p.image_url AS "imageUrl",
             COALESCE(p.retail_dealer_price, p.base_price) AS "retailDealerPrice",
             COALESCE(p.credit_inst_mrp_price, p.base_price) AS "creditInstMrpPrice",
             COALESCE(p.credit_inst_dealer_price, p.base_price) AS "creditInstDealerPrice",
             COALESCE(p.parlour_dealer_price, p.base_price) AS "parlourDealerPrice"
      FROM products p
      JOIN categories c ON c.id = p.category_id
      LEFT JOIN fgs_stock_log fsl
             ON fsl.product_id = p.id AND fsl.date = (SELECT d FROM today)
      LEFT JOIN reserved r ON r.stock_product_id = p.id
      WHERE p.deleted_at IS NULL AND p.available = true
        -- The subsidy SKU (migration 0056) is placed ONLY via the Subsidy
        -- Indents page — never surfaced in the dealer app or any ordering
        -- picker. It stays available=true for the route-sheet report.
        AND p.code IS DISTINCT FROM 'PD0191S'
      ORDER BY p.sort_order, p.name
    `;
    return reply.status(200).send({ products: productsList });
  });

  // GET /api/v1/products/all — includes basePrice, dealerPrice, mrp
  app.get(
    "/api/v1/products/all",
    { preHandler: [adminAuth, requireRole("products.view")] },
    async (request, reply) => {
      const query = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
      const data = await pgClient`
        SELECT p.id, p.name, p.icon, p.unit,
               p.image_url        AS "imageUrl",
               p.base_price   AS "basePrice",     -- Basic Price (pre-GST)
               p.dealer_price AS "dealerPrice",   -- Dealer-Price (gross)
               p.mrp,                             -- MRP
               p.gst_percent AS "gstPercent", p.stock, p.available,
               p.category_id AS "categoryId", c.name AS "categoryName",
               p.sort_order AS "sortOrder",
               p.low_stock_threshold AS "lowStockThreshold",
               p.critical_stock_threshold AS "criticalStockThreshold",
               p.created_at AS "createdAt",
               p.code, p.hsn_no AS "hsnNo", p.pack_size AS "packSize",
               p.print_direction AS "printDirection",
               p.image_url AS "imageUrl",
               p.packets_crate AS "packetsCrate", p.report_alias AS "reportAlias",
               p.abstract_position AS "abstractPosition",
               COALESCE(p.retail_dealer_price, p.base_price) AS "retailDealerPrice",
               COALESCE(p.credit_inst_mrp_price, p.base_price) AS "creditInstMrpPrice",
               COALESCE(p.credit_inst_dealer_price, p.base_price) AS "creditInstDealerPrice",
               COALESCE(p.parlour_dealer_price, p.base_price) AS "parlourDealerPrice"
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL
          -- Hide the subsidy-only SKU (migration 0056) from the masters list.
          AND p.code IS DISTINCT FROM 'PD0191S'
        ORDER BY p.sort_order, p.name
        LIMIT ${query.limit} OFFSET ${offset}
      `;
      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM products
         WHERE deleted_at IS NULL AND code IS DISTINCT FROM 'PD0191S'
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

  // POST /api/v1/products — three-tier pricing
  app.post(
    "/api/v1/products",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const body = productWriteSchema.parse(request.body);

      // Basic Price is derived from the (gross) Dealer-Price.
      const basePrice = deriveBasePriceFromDealerPrice(body.dealerPrice, body.gstPercent);
      // MRP defaults to Dealer-Price if the client did not supply one.
      const mrp = body.mrp ?? body.dealerPrice;

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
          code, hsn_no, pack_size, print_direction, packets_crate, abstract_position, report_alias,
          dealer_price, mrp,
          retail_dealer_price, credit_inst_mrp_price, credit_inst_dealer_price, parlour_dealer_price,
          image_url
        ) VALUES (
          ${body.name}, ${body.categoryId}, ${body.icon ?? null}, ${body.unit},
          ${basePrice}::numeric, ${body.gstPercent}::numeric, ${body.stock}, ${body.available},
          ${code}, ${body.hsnNo ?? null}, ${body.packSize ?? null}::numeric,
          ${body.printDirection ?? "Across"}, ${body.packetsCrate ?? 0}, ${body.abstractPosition ?? 0},
          ${body.reportAlias ?? body.name},
          ${body.dealerPrice}::numeric, ${mrp}::numeric,
          ${body.retailDealerPrice ?? basePrice}::numeric,
          ${body.creditInstMrpPrice ?? basePrice}::numeric,
          ${body.creditInstDealerPrice ?? basePrice}::numeric,
          ${body.parlourDealerPrice ?? basePrice}::numeric,
          ${body.imageUrl ?? null}
        )
        RETURNING *
      `;

      return reply.status(201).send({ product });
    }
  );

  // PATCH /api/v1/products/:id — three-tier pricing
  app.patch(
    "/api/v1/products/:id",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = productUpdateSchema.parse(request.body);

      // Fetch current values to recompute base_price when dealer_price / gst change.
      const [current] = await pgClient`
        SELECT dealer_price, mrp, gst_percent
        FROM products WHERE id = ${id} AND deleted_at IS NULL
      `;
      if (!current) return reply.status(404).send({ error: "Product not found" });

      const newDealerPrice =
        body.dealerPrice !== undefined ? body.dealerPrice : Number(current.dealer_price);
      const newMrp =
        body.mrp !== undefined ? body.mrp : Number(current.mrp);
      const newGst =
        body.gstPercent !== undefined ? body.gstPercent : Number(current.gst_percent);

      // Basic Price is always derived from the (gross) Dealer-Price.
      const basePrice = deriveBasePriceFromDealerPrice(newDealerPrice, newGst);

      const [updated] = await pgClient`
        UPDATE products SET
          name = COALESCE(${body.name ?? null}, name),
          category_id = COALESCE(${body.categoryId ?? null}::uuid, category_id),
          icon = CASE WHEN ${body.icon !== undefined} THEN ${body.icon ?? null} ELSE icon END,
          image_url = CASE WHEN ${body.imageUrl !== undefined}
                          THEN ${body.imageUrl ?? null}
                          ELSE image_url END,
          unit = COALESCE(${body.unit ?? null}, unit),
          base_price = ${basePrice}::numeric,
          dealer_price = ${newDealerPrice}::numeric,
          mrp = ${newMrp}::numeric,
          gst_percent = ${newGst}::numeric,
          stock = COALESCE(${body.stock ?? null}::int, stock),
          available = COALESCE(${body.available ?? null}::boolean, available),
          code = COALESCE(${body.code ?? null}, code),
          hsn_no = CASE WHEN ${body.hsnNo !== undefined} THEN ${body.hsnNo ?? null} ELSE hsn_no END,
          pack_size = COALESCE(${body.packSize ?? null}::numeric, pack_size),
          print_direction = COALESCE(${body.printDirection ?? null}, print_direction),
          packets_crate = COALESCE(${body.packetsCrate ?? null}::int, packets_crate),
          abstract_position = COALESCE(${body.abstractPosition ?? null}::int, abstract_position),
          report_alias = COALESCE(${body.reportAlias ?? null}, report_alias),
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

  // ── POST /api/v1/admin/products/image-presign ─────────────────────────
  // Returns a short-lived presigned PUT URL so the browser can upload
  // directly to R2 without routing the bytes through the API server.
  // After the PUT succeeds, publicUrl is stored in the product form and
  // submitted with the normal create/update call.
  app.post(
    "/api/v1/admin/products/image-presign",
    { preHandler: [adminAuth, requireRole("products.manage")] },
    async (request, reply) => {
      const { filename, contentType } = z
        .object({
          filename: z.string().min(1),
          contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
        })
        .parse(request.body);

      const accountId  = process.env.R2_ACCOUNT_ID;
      const accessKey  = process.env.R2_ACCESS_KEY_ID;
      const secret     = process.env.R2_SECRET_ACCESS_KEY;
      const bucket     = process.env.R2_BUCKET_NAME;
      const publicBase = process.env.R2_PUBLIC_URL;

      if (!accountId || !accessKey || !secret || !bucket) {
        return reply.status(503).send({ error: "Image storage (R2) is not configured on this server" });
      }

      const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
      const { getSignedUrl }               = await import("@aws-sdk/s3-request-presigner");

      const ext = filename.split(".").pop()?.toLowerCase() ?? "jpg";
      const key = `products/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;

      const s3 = new S3Client({
        region: "auto",
        endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
        credentials: { accessKeyId: accessKey, secretAccessKey: secret },
        // R2 (and browser PUTs to presigned URLs) break when the SDK bakes a
        // default CRC32 checksum into the signed URL — it signs the checksum of
        // an empty body, which never matches the real upload. Only add a
        // checksum when the operation actually requires one (PutObject doesn't).
        requestChecksumCalculation: "WHEN_REQUIRED",
      });

      const uploadUrl = await getSignedUrl(
        s3,
        new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }),
        { expiresIn: 300 }, // 5 minutes
      );

      // If a public CDN is configured (recommended), return the permanent URL.
      // Otherwise fall back to a signed GET URL (fine for private buckets).
      const publicUrl = publicBase
        ? `${publicBase}/${key}`
        : uploadUrl.split("?")[0];

      return reply.send({ uploadUrl, publicUrl });
    }
  );
}