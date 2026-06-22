// ══════════════════════════════════════════════════════════════════
// Officers — field sales officers assigned to talukas (zones).
//
// Masters → Officers. An officer covers one or more talukas; a taluka
// (zones row) references its officer via zones.officer_id. Assigning
// talukas to an officer sets zones.officer_id for the selected zones.
//
// NOTE: these officers are distinct from orders.officer_id /
// direct_sales.officer_id, which record the staff *user* who processed a
// sale. See packages/db/src/schema/officers.ts.
// ══════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

// Re-derive dealers.officer_name from each dealer's taluka officer. The
// dealers_set_officer_from_zone trigger only fires on dealer writes, not on
// zones updates — so when an officer's name or taluka assignment changes we
// backfill here to keep dealer officer labels consistent (mirrors 0044).
async function backfillDealerOfficers(tx: typeof pgClient) {
  await tx`
    UPDATE dealers d
    SET officer_name = sub.name, updated_at = now()
    FROM (
      SELECT z.id AS zone_id, o.name
      FROM zones z
      LEFT JOIN officers o ON o.id = z.officer_id
    ) sub
    WHERE d.zone_id = sub.zone_id
      AND d.deleted_at IS NULL
      AND d.officer_name IS DISTINCT FROM sub.name
  `;
}

export async function officerRoutes(app: FastifyInstance) {
  // GET /api/v1/officers — roster with each officer's assigned talukas
  app.get(
    "/api/v1/officers",
    { preHandler: [adminAuth, requireRole("officers.view")] },
    async (_request, reply) => {
      const officers = await pgClient`
        SELECT
          o.id, o.name, o.phone, o.active,
          o.created_at AS "createdAt", o.updated_at AS "updatedAt",
          COALESCE(
            (SELECT json_agg(json_build_object('id', z.id, 'name', z.name, 'slug', z.slug) ORDER BY z.name)
             FROM zones z WHERE z.officer_id = o.id),
            '[]'::json
          ) AS talukas
        FROM officers o
        ORDER BY o.active DESC, o.name
      `;
      return reply.send({ officers });
    }
  );

  // GET /api/v1/officers/:id — single officer + assigned talukas
  app.get(
    "/api/v1/officers/:id",
    { preHandler: [adminAuth, requireRole("officers.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [officer] = await pgClient`
        SELECT o.id, o.name, o.phone, o.active,
               o.created_at AS "createdAt", o.updated_at AS "updatedAt"
        FROM officers o WHERE o.id = ${id}
      `;
      if (!officer) return reply.status(404).send({ error: "Officer not found" });

      const talukas = await pgClient`
        SELECT z.id, z.name, z.slug
        FROM zones z WHERE z.officer_id = ${id}
        ORDER BY z.name
      `;
      return reply.send({ officer: { ...officer, talukas } });
    }
  );

  // POST /api/v1/officers — create + assign talukas atomically
  app.post(
    "/api/v1/officers",
    { preHandler: [adminAuth, requireRole("officers.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        phone: z.string().optional().nullable(),
        active: z.boolean().optional(),
        talukaIds: z.array(z.string().uuid()).optional(),
      });
      const body = schema.parse(request.body);

      try {
        const result = await pgClient.begin(async (_tx) => {
          const tx = _tx as unknown as typeof pgClient;
          const [officer] = await tx`
            INSERT INTO officers (name, phone, active)
            VALUES (${body.name}, ${body.phone ?? null}, ${body.active !== false})
            RETURNING id, name, phone, active
          `;
          if (!officer) throw new Error("Failed to create officer");

          if (body.talukaIds && body.talukaIds.length > 0) {
            await tx`
              UPDATE zones SET officer_id = ${officer.id}, updated_at = now()
              WHERE id = ANY(${body.talukaIds}::uuid[])
            `;
            await backfillDealerOfficers(tx);
          }
          return officer;
        });
        return reply.status(201).send({ officer: result });
      } catch (err) {
        if ((err as { code?: string })?.code === "23505")
          return reply.status(409).send({ error: "An officer with this name already exists" });
        throw err;
      }
    }
  );

  // PATCH /api/v1/officers/:id — update + optionally re-assign talukas
  app.patch(
    "/api/v1/officers/:id",
    { preHandler: [adminAuth, requireRole("officers.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().min(1).optional(),
        phone: z.string().optional().nullable(),
        active: z.boolean().optional(),
        talukaIds: z.array(z.string().uuid()).optional(),
      });
      const body = schema.parse(request.body);

      try {
        const result = await pgClient.begin(async (_tx) => {
          const tx = _tx as unknown as typeof pgClient;
          const [updated] = await tx`
            UPDATE officers SET
              name = COALESCE(${body.name ?? null}, name),
              phone = CASE WHEN ${body.phone !== undefined} THEN ${body.phone ?? null} ELSE phone END,
              active = COALESCE(${body.active ?? null}::boolean, active),
              updated_at = now()
            WHERE id = ${id}
            RETURNING id, name, phone, active
          `;
          if (!updated) return null;

          if (body.talukaIds !== undefined) {
            // Unassign this officer's current talukas, then assign the new set.
            await tx`UPDATE zones SET officer_id = NULL, updated_at = now() WHERE officer_id = ${id}`;
            if (body.talukaIds.length > 0) {
              await tx`
                UPDATE zones SET officer_id = ${id}, updated_at = now()
                WHERE id = ANY(${body.talukaIds}::uuid[])
              `;
            }
          }
          // Name and/or taluka changes can stale dealers.officer_name.
          await backfillDealerOfficers(tx);
          return updated;
        });

        if (!result) return reply.status(404).send({ error: "Officer not found" });
        return reply.send({ officer: result });
      } catch (err) {
        if ((err as { code?: string })?.code === "23505")
          return reply.status(409).send({ error: "An officer with this name already exists" });
        throw err;
      }
    }
  );
}
