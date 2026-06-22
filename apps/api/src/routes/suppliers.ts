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
}
