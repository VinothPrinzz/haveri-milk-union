import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

// ════════════════════════════════════════════════════════════════════
// Suppliers — master of vendors the plant purchases received stock from.
// Selected by name on the Stock Entry screen and referenced by
// stock_receipts. Mirrors the contractors CRUD pattern (auto SUP- code,
// soft delete, COALESCE patch), minus routes/zones.
// ════════════════════════════════════════════════════════════════════
export async function supplierRoutes(app: FastifyInstance) {
  // GET /api/v1/suppliers — paginated list with search & active filter
  app.get(
    "/api/v1/suppliers",
    { preHandler: [adminAuth, requireRole("suppliers.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        search: z.string().optional(),
        active: z.enum(["true", "false"]).optional(),
        status: z.enum(["active", "inactive"]).optional(),
      });
      const query = querySchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);

      const searchTerm = query.search ? `%${query.search}%` : null;
      const activeFilter = query.active !== undefined ? query.active === "true" : null;
      const statusFilter = query.status === "active" ? true
                        : query.status === "inactive" ? false
                        : null;

      const rows = await pgClient`
        SELECT s.*
        FROM suppliers s
        WHERE s.deleted_at IS NULL
          AND (${searchTerm}::text IS NULL
              OR s.name ILIKE ${searchTerm}::text
              OR s.phone ILIKE ${searchTerm}::text
              OR s.code ILIKE ${searchTerm}::text)
          AND (${activeFilter}::boolean IS NULL OR s.active = ${activeFilter}::boolean)
          AND (${statusFilter}::boolean IS NULL OR s.active = ${statusFilter}::boolean)
        ORDER BY s.code NULLS LAST, s.name ASC
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM suppliers s
        WHERE s.deleted_at IS NULL
          AND (${searchTerm}::text IS NULL
              OR s.name ILIKE ${searchTerm}::text
              OR s.phone ILIKE ${searchTerm}::text
              OR s.code ILIKE ${searchTerm}::text)
          AND (${activeFilter}::boolean IS NULL OR s.active = ${activeFilter}::boolean)
          AND (${statusFilter}::boolean IS NULL OR s.active = ${statusFilter}::boolean)
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/suppliers/:id
  app.get(
    "/api/v1/suppliers/:id",
    { preHandler: [adminAuth, requireRole("suppliers.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [supplier] = await pgClient`
        SELECT s.* FROM suppliers s
        WHERE s.id = ${id} AND s.deleted_at IS NULL
      `;
      if (!supplier) return reply.status(404).send({ error: "Supplier not found" });
      return reply.send({ supplier });
    }
  );

  // POST /api/v1/suppliers — create with auto SUP- code
  app.post(
    "/api/v1/suppliers",
    { preHandler: [adminAuth, requireRole("suppliers.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        phone: z.string().optional().nullable(),
        address: z.string().optional().nullable(),
        gstNo: z.string().optional().nullable(),
        accountNo: z.string().optional().nullable(),
        code: z.string().optional(),
        active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);

      const result = await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;
        let code = body.code;
        if (!code) {
          const [last] = await tx`
            SELECT code FROM suppliers
            WHERE code ~ '^SUP-[0-9]+$' AND deleted_at IS NULL
            ORDER BY CAST(SUBSTRING(code FROM 5) AS integer) DESC
            LIMIT 1
          `;
          const lastNum = last ? parseInt(last.code.slice(4)) : 0;
          code = `SUP-${String(lastNum + 1).padStart(4, "0")}`;
        }

        const [supplier] = await tx`
          INSERT INTO suppliers (code, name, phone, address, gst_no, account_no, active)
          VALUES (
            ${code}, ${body.name}, ${body.phone ?? null}, ${body.address ?? null},
            ${body.gstNo ?? null}, ${body.accountNo ?? null}, ${body.active !== false}
          )
          RETURNING *
        `;
        if (!supplier) throw new Error("Failed to create supplier");
        return supplier;
      });

      return reply.status(201).send({ supplier: result });
    }
  );

  // PATCH /api/v1/suppliers/:id
  app.patch(
    "/api/v1/suppliers/:id",
    { preHandler: [adminAuth, requireRole("suppliers.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().min(1).optional(),
        phone: z.string().optional().nullable(),
        address: z.string().optional().nullable(),
        gstNo: z.string().optional().nullable(),
        accountNo: z.string().optional().nullable(),
        active: z.boolean().optional(),
      });
      const body = schema.parse(request.body);

      const [updated] = await pgClient`
        UPDATE suppliers SET
          name = COALESCE(${body.name ?? null}, name),
          phone = COALESCE(${body.phone ?? null}, phone),
          address = COALESCE(${body.address ?? null}, address),
          gst_no = COALESCE(${body.gstNo ?? null}, gst_no),
          account_no = COALESCE(${body.accountNo ?? null}, account_no),
          active = COALESCE(${body.active ?? null}::boolean, active),
          updated_at = now()
        WHERE id = ${id} AND deleted_at IS NULL
        RETURNING *
      `;

      if (!updated) return reply.status(404).send({ error: "Supplier not found" });
      return reply.send({ supplier: updated });
    }
  );

  // DELETE /api/v1/suppliers/:id — soft delete
  app.delete(
    "/api/v1/suppliers/:id",
    { preHandler: [adminAuth, requireRole("suppliers.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await pgClient`UPDATE suppliers SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
      return reply.send({ message: "Supplier deleted" });
    }
  );

  // ══════════════════════════════════════════════════════════════════
  // Supplier product-wise cost (purchase rate card, migration 0065)
  //
  // One current rate per (supplier, product), maintained on the Suppliers
  // master and read by Stock Entry to pre-fill a receipt line's unit cost.
  // Revising a rate never touches past stock_receipts — those snapshot the
  // cost that was actually used.
  // ══════════════════════════════════════════════════════════════════

  // GET /api/v1/supplier-costs — flat rate list for lookup.
  // Read by the Stock Entry receipt dialog (hence suppliers.view, which the
  // FGS operator roles already hold) and filterable by either side.
  app.get(
    "/api/v1/supplier-costs",
    { preHandler: [adminAuth, requireRole("suppliers.view")] },
    async (request, reply) => {
      const querySchema = z.object({
        supplierId: z.string().uuid().optional(),
        productId: z.string().uuid().optional(),
      });
      const query = querySchema.parse(request.query);

      const rows = await pgClient`
        SELECT spc.supplier_id AS "supplierId",
               spc.product_id  AS "productId",
               spc.unit_cost   AS "unitCost",
               spc.updated_at  AS "updatedAt"
          FROM supplier_product_costs spc
          JOIN suppliers s ON s.id = spc.supplier_id
         WHERE s.deleted_at IS NULL
           AND (${query.supplierId ?? null}::uuid IS NULL OR spc.supplier_id = ${query.supplierId ?? null}::uuid)
           AND (${query.productId ?? null}::uuid IS NULL OR spc.product_id = ${query.productId ?? null}::uuid)
      `;

      return reply.send({ costs: rows });
    }
  );

  // GET /api/v1/suppliers/:id/costs — the rate-card editor's rows: EVERY
  // sellable product, with this supplier's rate where one is set (null
  // otherwise), so the screen is a single list the operator fills in.
  app.get(
    "/api/v1/suppliers/:id/costs",
    { preHandler: [adminAuth, requireRole("suppliers.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const [supplier] = await pgClient`
        SELECT id, code, name FROM suppliers WHERE id = ${id} AND deleted_at IS NULL
      `;
      if (!supplier) return reply.status(404).send({ error: "Supplier not found" });

      const rows = await pgClient`
        SELECT p.id            AS "productId",
               p.code          AS "productCode",
               p.name          AS "productName",
               p.unit,
               c.name          AS "categoryName",
               spc.unit_cost   AS "unitCost",
               spc.updated_at  AS "updatedAt"
          FROM products p
          JOIN categories c ON c.id = p.category_id
          LEFT JOIN supplier_product_costs spc
                 ON spc.product_id = p.id AND spc.supplier_id = ${id}
         WHERE p.deleted_at IS NULL
           -- Subsidy-only SKU (migration 0056) is never purchased; it draws
           -- its stock from the base product.
           AND p.code IS DISTINCT FROM 'PD0191S'
         ORDER BY c.name, p.sort_order, p.name
      `;

      return reply.send({ supplier, costs: rows });
    }
  );

  // PUT /api/v1/suppliers/:id/costs — bulk upsert of the rate card.
  // Send only the changed lines: a numeric unitCost upserts the rate, an
  // explicit null clears it (the product goes back to "no rate on file",
  // which Stock Entry reads as "nothing to pre-fill").
  app.put(
    "/api/v1/suppliers/:id/costs",
    { preHandler: [adminAuth, requireRole("suppliers.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        costs: z.array(
          z.object({
            productId: z.string().uuid(),
            unitCost: z.union([z.string(), z.number()]).nullable(),
          })
        ),
      });
      const body = schema.parse(request.body);

      const [supplier] = await pgClient`
        SELECT id FROM suppliers WHERE id = ${id} AND deleted_at IS NULL
      `;
      if (!supplier) return reply.status(404).send({ error: "Supplier not found" });

      // A blank string is the editor's "cleared" state, same as null.
      const toDelete = body.costs
        .filter(c => c.unitCost === null || String(c.unitCost).trim() === "")
        .map(c => c.productId);
      const toUpsert = body.costs
        .filter(c => c.unitCost !== null && String(c.unitCost).trim() !== "")
        .map(c => ({ productId: c.productId, unitCost: Number(c.unitCost) }));

      const bad = toUpsert.find(c => !Number.isFinite(c.unitCost) || c.unitCost < 0);
      if (bad) {
        return reply.status(400).send({
          error: "Bad Request",
          message: "Unit cost must be a number of 0 or more",
        });
      }

      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        // Both loops use one scalar-param statement per row. The rate card is
        // edited by hand so a save is a handful of lines, and scalar params
        // are the only shape that survives Bind through the transaction
        // pooler (a JS array bound as `= ANY(${ids}::uuid[])` throws there).
        for (const productId of toDelete) {
          await tx`
            DELETE FROM supplier_product_costs
             WHERE supplier_id = ${id} AND product_id = ${productId}
          `;
        }

        for (const c of toUpsert) {
          await tx`
            INSERT INTO supplier_product_costs (supplier_id, product_id, unit_cost, updated_by)
            VALUES (${id}, ${c.productId}, ${c.unitCost}::numeric, ${request.admin!.userId})
            ON CONFLICT (supplier_id, product_id) DO UPDATE SET
              unit_cost  = EXCLUDED.unit_cost,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()
          `;
        }
      });

      return reply.send({
        message: `Saved ${toUpsert.length} rate${toUpsert.length === 1 ? "" : "s"}${
          toDelete.length ? `, cleared ${toDelete.length}` : ""
        }`,
        saved: toUpsert.length,
        cleared: toDelete.length,
      });
    }
  );
}
