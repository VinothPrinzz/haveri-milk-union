import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

export async function vipContactsRoutes(app: FastifyInstance) {
  // GET /api/v1/vip-contacts
  app.get(
    "/api/v1/vip-contacts",
    { preHandler: [adminAuth, requireRole("vip_contacts.view")] },
    async (request, reply) => {
      const q = z.object({ search: z.string().optional() }).parse(request.query);
      const s = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        SELECT id, name, phone, designation, notes, created_at
        FROM vip_contacts
        WHERE deleted_at IS NULL
          AND (${s}::text IS NULL OR name ILIKE ${s ?? ''} OR phone ILIKE ${s ?? ''})
        ORDER BY name
        LIMIT 200
      `;
      return reply.send({ data: rows });
    }
  );

  // POST /api/v1/vip-contacts — inline add from sale form, or from masters page
  app.post(
    "/api/v1/vip-contacts",
    { preHandler: [adminAuth, requireRole("vip_contacts.manage")] },
    async (request, reply) => {
      const body = z.object({
        name:        z.string().min(1),
        phone:       z.string().optional(),
        designation: z.string().optional(),
        notes:       z.string().optional(),
      }).parse(request.body);

      const [row] = await pgClient`
        INSERT INTO vip_contacts (name, phone, designation, notes)
        VALUES (${body.name}, ${body.phone ?? null}, ${body.designation ?? null}, ${body.notes ?? null})
        RETURNING id, name, phone, designation, notes
      `;
      return reply.status(201).send({ contact: row });
    }
  );

  // PATCH /api/v1/vip-contacts/:id
  app.patch(
    "/api/v1/vip-contacts/:id",
    { preHandler: [adminAuth, requireRole("vip_contacts.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z.object({
        name:        z.string().min(1).optional(),
        phone:       z.string().nullable().optional(),
        designation: z.string().nullable().optional(),
        notes:       z.string().nullable().optional(),
      }).parse(request.body);

      const [row] = await pgClient`
        UPDATE vip_contacts SET
          name        = COALESCE(${body.name ?? null}, name),
          phone       = ${body.phone === undefined ? pgClient`phone`        : body.phone},
          designation = ${body.designation === undefined ? pgClient`designation` : body.designation},
          notes       = ${body.notes === undefined ? pgClient`notes`        : body.notes},
          updated_at  = now()
        WHERE id = ${id} AND deleted_at IS NULL
        RETURNING id, name, phone, designation, notes
      `;
      if (!row) return reply.status(404).send({ error: "VIP contact not found" });
      return reply.send({ contact: row });
    }
  );

  // DELETE /api/v1/vip-contacts/:id — soft delete
  app.delete(
    "/api/v1/vip-contacts/:id",
    { preHandler: [adminAuth, requireRole("vip_contacts.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await pgClient`UPDATE vip_contacts SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
      return reply.send({ ok: true });
    }
  );
}