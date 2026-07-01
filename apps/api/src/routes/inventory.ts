import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, sql, and, lt } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { products, fgsStockLog, categories } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import {
  type StockBucket,
  MILK_CURD_CATEGORIES,
  bucketOfCategory,
  bucketsForRole,
} from "../lib/stock-buckets.js";

export async function inventoryRoutes(app: FastifyInstance) {
  // GET /api/v1/fgs/overview — current stock for all products
  app.get(
    "/api/v1/fgs/overview",
    { preHandler: [adminAuth, requireRole("inventory.view")] },
    async (request, reply) => {
      const querySchema = z.object({
        date:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        bucket: z.enum(["milk-curd", "others"]).optional(),
      });
      const { date, bucket } = querySchema.parse(request.query);

      // Bucket-scoped roles (SKA milk-curd diary / other-products diary) can only
      // ever see their own bucket — force it, ignoring any wider query param.
      // Unrestricted roles honour the requested bucket (undefined → all).
      const allowedBuckets = bucketsForRole(request.admin!.role);
      const effectiveBucket: StockBucket | null =
        allowedBuckets.length === 1 ? allowedBuckets[0]! : (bucket ?? null);

      // If date is given, return that day's snapshot from fgs_stock_log,
      // joined with products (some products may not have an entry that day).
      if (date) {
        const stockData = await pgClient`
          WITH dispatched_qty AS (
            -- Auto-dispatched: what actually left the plant for this delivery
            -- date, summed from dispatched/delivered order lines. This is the
            -- source of truth for the Stock Entry "Dispatched" column (both
            -- buckets) — the operator no longer types it by hand.
            SELECT oi.product_id, SUM(oi.quantity)::int AS qty
            FROM orders o
            JOIN order_items oi ON oi.order_id = o.id
            WHERE o.delivery_date = ${date}::date
              AND o.status IN ('dispatched', 'delivered')
            GROUP BY oi.product_id
          ),
          base AS (
            SELECT p.id, p.name, p.icon, p.unit, p.available, p.sort_order,
                   p.low_stock_threshold, p.critical_stock_threshold,
                   c.name AS category_name,
                   -- Opening auto-fills from the most recent prior day's closing
                   -- when this date has no entry yet (falls back to 0 for a brand
                   -- new product with no history).
                   COALESCE(
                     fsl.opening,
                     (SELECT prev.closing
                        FROM fgs_stock_log prev
                       WHERE prev.product_id = p.id
                         AND prev.date < ${date}::date
                       ORDER BY prev.date DESC
                       LIMIT 1),
                     0
                   ) AS opening,
                   COALESCE(fsl.received, 0) AS received,
                   -- Dispatched is derived from orders (see dispatched_qty),
                   -- NOT from the stored fgs_stock_log value.
                   COALESCE(dq.qty, 0) AS dispatched,
                   COALESCE(fsl.wastage, 0) AS wastage,
                   -- GRN receipt lines for this product on this day (who supplied
                   -- the received stock + cost). Empty array when none recorded.
                   COALESCE(
                     (SELECT json_agg(json_build_object(
                         'id',           sr.id,
                         'supplierId',   sr.supplier_id,
                         'supplierName', sup.name,
                         'quantity',     sr.quantity,
                         'unitCost',     sr.unit_cost,
                         'totalCost',    sr.total_cost
                       ) ORDER BY sr.created_at)
                      FROM stock_receipts sr
                      LEFT JOIN suppliers sup ON sup.id = sr.supplier_id
                      WHERE sr.product_id = p.id AND sr.date = ${date}::date),
                     '[]'::json
                   ) AS receipts
            FROM products p
            JOIN categories c ON c.id = p.category_id
            LEFT JOIN fgs_stock_log fsl ON fsl.product_id = p.id AND fsl.date = ${date}::date
            LEFT JOIN dispatched_qty dq ON dq.product_id = p.id
            WHERE p.deleted_at IS NULL
              -- Subsidy-only SKU (migration 0056) has no stock of its own.
              AND p.code IS DISTINCT FROM 'PD0191S'
              AND (
                ${effectiveBucket}::text IS NULL
                OR (${effectiveBucket}::text = 'milk-curd' AND LOWER(c.name) = ANY(${MILK_CURD_CATEGORIES}::text[]))
                OR (${effectiveBucket}::text = 'others'    AND LOWER(c.name) <> ALL(${MILK_CURD_CATEGORIES}::text[]))
              )
          )
          -- Closing (and current stock) recompute live from the derived
          -- dispatched, so the sheet always balances
          -- opening + received − dispatched − wastage.
          SELECT
            id, name, icon, unit, available,
            low_stock_threshold, critical_stock_threshold, category_name,
            opening, received, dispatched, wastage,
            (opening + received - dispatched - wastage) AS closing,
            (opening + received - dispatched - wastage) AS stock,
            ${date}::date AS date,
            CASE
              WHEN (opening + received - dispatched - wastage) = 0 THEN 'out_of_stock'
              WHEN (opening + received - dispatched - wastage) <= critical_stock_threshold THEN 'critical'
              WHEN (opening + received - dispatched - wastage) <= low_stock_threshold THEN 'low'
              ELSE 'healthy'
            END AS stock_status,
            receipts
          FROM base
          ORDER BY category_name, sort_order
        `;
        const summary = {
          totalProducts: stockData.length,
          outOfStock: stockData.filter(p => p.stock_status === "out_of_stock").length,
          critical:   stockData.filter(p => p.stock_status === "critical").length,
          low:        stockData.filter(p => p.stock_status === "low").length,
          healthy:    stockData.filter(p => p.stock_status === "healthy").length,
        };
        return reply.send({ summary, products: stockData, date });
      }

      // No date → current stock (existing behaviour).
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
        AND p.code IS DISTINCT FROM 'PD0191S'   -- subsidy-only SKU (migration 0056)
        AND (
          ${effectiveBucket}::text IS NULL
          OR (${effectiveBucket}::text = 'milk-curd' AND LOWER(c.name) = ANY(${MILK_CURD_CATEGORIES}::text[]))
          OR (${effectiveBucket}::text = 'others'    AND LOWER(c.name) <> ALL(${MILK_CURD_CATEGORIES}::text[]))
        )
      ORDER BY c.name, p.sort_order
      `;
      const summary = {
        totalProducts: stockData.length,
        outOfStock: stockData.filter(p => p.stock_status === "out_of_stock").length,
        critical:   stockData.filter(p => p.stock_status === "critical").length,
        low:        stockData.filter(p => p.stock_status === "low").length,
        healthy:    stockData.filter(p => p.stock_status === "healthy").length,
      };
      return reply.send({ summary, products: stockData });
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
            // Optional GRN receipt lines — who the received stock was purchased
            // from + at what cost. When present, `received` is DERIVED as the
            // sum of line quantities (the client's `received` is ignored) and
            // the day's stock_receipts for this product are replaced with these
            // lines. Omit the field entirely to leave receipts untouched
            // (backward-compatible with callers that only send aggregates).
            receipts: z.array(
              z.object({
                supplierId: z.string().uuid().nullable().optional(),
                quantity: z.number().int().min(0),
                unitCost: z.union([z.string(), z.number()]).nullable().optional(),
              })
            ).optional(),
          })
        ),
      });
      const body = schema.parse(request.body);

      // Bucket scoping: a bucket-restricted FGS operator may only write stock for
      // products in their own bucket. Verify every submitted product's category
      // before touching any row, so a Milk & Curd operator can't edit Other
      // Products stock (and vice versa) by crafting a request.
      const allowedBuckets = bucketsForRole(request.admin!.role);
      if (allowedBuckets.length === 1 && body.entries.length > 0) {
        const productIds = body.entries.map(e => e.productId);
        const productCats = await pgClient`
          SELECT p.id, c.name AS category
          FROM products p
          JOIN categories c ON c.id = p.category_id
          WHERE p.id = ANY(${productIds}::uuid[])
        `;
        const catById = new Map<string, string>(
          productCats.map(r => [r.id as string, r.category as string]),
        );
        const offending = body.entries.filter(e => {
          // Unknown product ids are treated as out-of-bucket — reject defensively.
          const cat = catById.get(e.productId);
          return cat === undefined || !allowedBuckets.includes(bucketOfCategory(cat));
        });
        if (offending.length > 0) {
          return reply.status(403).send({
            error: "Forbidden",
            message: `Role '${request.admin!.role}' may only edit ${allowedBuckets[0]} stock`,
          });
        }
      }

      // Dispatched is derived, never taken from the client: sum the dispatched/
      // delivered order lines for each edited product on this date. Computed
      // once up-front so every product's log + closing + products.stock stay in
      // step with what the Stock Entry / Overview screens display.
      const dispatchedByProduct = new Map<string, number>();
      if (body.entries.length > 0) {
        const productIds = body.entries.map(e => e.productId);
        const dispatchedRows = await pgClient`
          SELECT oi.product_id, SUM(oi.quantity)::int AS qty
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.delivery_date = ${body.date}::date
            AND o.status IN ('dispatched', 'delivered')
            AND oi.product_id = ANY(${productIds}::uuid[])
          GROUP BY oi.product_id
        `;
        for (const r of dispatchedRows) {
          dispatchedByProduct.set(r.product_id as string, Number(r.qty));
        }
      }

      const results = [];

      for (const entry of body.entries) {
        // When the client sent receipt lines, the received total is their sum
        // (the lines are the source of truth); otherwise fall back to the
        // aggregate `received` the client typed.
        const hasReceipts = entry.receipts !== undefined;
        const received = hasReceipts
          ? entry.receipts!.reduce((sum, r) => sum + r.quantity, 0)
          : entry.received;

        // Ignore entry.dispatched — it is auto-derived from orders.
        const dispatched = dispatchedByProduct.get(entry.productId) ?? 0;

        const closing =
          entry.opening + received - dispatched - entry.wastage;

        // Each product's log upsert + receipt replacement + stock update is one
        // atomic unit — a failed receipt insert must not leave the rolled-up
        // `received` out of sync with the receipt rows.
        const row = await pgClient.begin(async (_tx) => {
          const tx = _tx as unknown as typeof pgClient;

          // Upsert — one entry per product per date
          const [logRow] = await tx`
            INSERT INTO fgs_stock_log (product_id, date, opening, received, dispatched, wastage, closing, entered_by)
            VALUES (${entry.productId}, ${body.date}::date, ${entry.opening}, ${received},
                    ${dispatched}, ${entry.wastage}, ${closing}, ${request.admin!.userId})
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

          // Replace this product/day's receipt lines with the submitted set.
          if (hasReceipts) {
            await tx`
              DELETE FROM stock_receipts
              WHERE product_id = ${entry.productId} AND date = ${body.date}::date
            `;
            for (const r of entry.receipts!) {
              // Skip blank rows (a dialog row left entirely empty).
              const hasCost = r.unitCost !== null && r.unitCost !== undefined && r.unitCost !== "";
              if (r.quantity <= 0 && r.supplierId == null && !hasCost) continue;
              const unitCost = hasCost ? String(r.unitCost) : null;
              const totalCost = unitCost != null ? String(Number(unitCost) * r.quantity) : null;
              await tx`
                INSERT INTO stock_receipts
                  (product_id, supplier_id, date, quantity, unit_cost, total_cost, entered_by)
                VALUES (
                  ${entry.productId}, ${r.supplierId ?? null}, ${body.date}::date, ${r.quantity},
                  ${unitCost}::numeric, ${totalCost}::numeric, ${request.admin!.userId}
                )
              `;
            }
          }

          // Also update the product's current stock to match closing
          await tx`
            UPDATE products SET stock = ${closing}, updated_at = now()
            WHERE id = ${entry.productId}
          `;

          return logRow;
        });

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
          AND p.code IS DISTINCT FROM 'PD0191S'   -- subsidy-only SKU (migration 0056)
          AND p.stock <= p.low_stock_threshold
        ORDER BY p.stock ASC
      `;

      return reply.status(200).send({ alerts });
    }
  );
}
