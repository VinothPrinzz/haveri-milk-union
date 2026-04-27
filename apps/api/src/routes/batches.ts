import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";

export async function batchRoutes(app: FastifyInstance) {
  // GET /api/v1/batches — all batches with their assigned route IDs
  app.get(
    "/api/v1/batches",
    { preHandler: [adminAuth, requireRole("batches.view")] },
    async (request, reply) => {
      const rows = await pgClient`
        SELECT
          b.id, b.batch_number, b.name, b.which_batch, b.timing,
          b.dispatch_time, b.status,
          COALESCE(
            ARRAY(SELECT br.route_id FROM batch_routes br WHERE br.batch_id = b.id),
            ARRAY[]::uuid[]
          ) AS route_ids
        FROM batches b
        WHERE b.deleted_at IS NULL
        ORDER BY b.which_batch
      `;
      return reply.send({ data: rows });
    }
  );

  // GET /api/v1/batches/:id — single batch with routes
  app.get(
    "/api/v1/batches/:id",
    { preHandler: [adminAuth, requireRole("batches.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [batch] = await pgClient`
        SELECT
          b.id, b.batch_number, b.name, b.which_batch, b.timing,
          b.dispatch_time, b.status,
          COALESCE(
            ARRAY(SELECT br.route_id FROM batch_routes br WHERE br.batch_id = b.id),
            ARRAY[]::uuid[]
          ) AS route_ids
        FROM batches b
        WHERE b.id = ${id} AND b.deleted_at IS NULL
      `;
      if (!batch) return reply.status(404).send({ error: "Batch not found" });

      const batchRoutesRows = await pgClient`
        SELECT br.route_id, r.code, r.name
        FROM batch_routes br
        JOIN routes r ON r.id = br.route_id AND r.deleted_at IS NULL
        WHERE br.batch_id = ${id}
        ORDER BY r.code
      `;

      return reply.send({ batch, routes: batchRoutesRows });
    }
  );

  // POST /api/v1/batches — create batch with route assignments
  app.post(
    "/api/v1/batches",
    { preHandler: [adminAuth, requireRole("batches.manage")] },
    async (request, reply) => {
      const schema = z.object({
        batchNumber: z.string().min(1),
        name: z.string().min(1),
        whichBatch: z.string().optional(),
        timing: z.string().optional().nullable(),
        dispatchTime: z.string().optional().nullable(),  // HH:MM or HH:MM:SS
        routeIds: z.array(z.string().uuid()).optional(),
      });
      const body = schema.parse(request.body);

      const [batch] = await pgClient`
        INSERT INTO batches (batch_number, name, which_batch, timing, dispatch_time)
        VALUES (
          ${body.batchNumber}, ${body.name}, ${body.whichBatch ?? null},
          ${body.timing ?? null},
          ${body.dispatchTime ?? null}::time
        )
        RETURNING *
      `;

      if (!batch) return reply.status(500).send({ error: "Failed to create batch" });

      // Link routes
      if (body.routeIds && body.routeIds.length > 0) {
        for (const routeId of body.routeIds) {
          await pgClient`
            INSERT INTO batch_routes (batch_id, route_id)
            VALUES (${batch.id}, ${routeId})
            ON CONFLICT (batch_id, route_id) DO NOTHING
          `;
        }
      }

      return reply.status(201).send({ batch });
    }
  );

  // PATCH /api/v1/batches/:id — update batch + replace route assignments
  app.patch(
    "/api/v1/batches/:id",
    { preHandler: [adminAuth, requireRole("batches.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        name: z.string().min(1).optional(),
        whichBatch: z.enum(["Morning", "Afternoon", "Evening", "Night"]).optional(),
        timing: z.string().nullable().optional(),
        notes: z.string().nullable().optional(),
        status: z.enum(["active", "closed", "expired"]).optional(),
        dispatchTime: z.string().optional().nullable(),
        routeIds: z.array(z.string().uuid()).optional(),
      });
      const body = schema.parse(request.body);

      const [updated] = await pgClient`
        UPDATE batches SET
          name = COALESCE(${body.name ?? null}, name),
          which_batch = COALESCE(${body.whichBatch ?? null}, which_batch),
          timing = CASE WHEN ${body.timing !== undefined} THEN ${body.timing ?? null} ELSE timing END,
          notes = CASE WHEN ${body.notes !== undefined} THEN ${body.notes ?? null} ELSE notes END,
          dispatch_time = CASE WHEN ${body.dispatchTime !== undefined}
                                THEN ${body.dispatchTime ?? null}::time
                                ELSE dispatch_time END,
          status = COALESCE(${body.status ?? null}::batch_status, status),
          updated_at = now()
        WHERE id = ${id} AND deleted_at IS NULL
        RETURNING *
      `;

      if (!updated) return reply.status(404).send({ error: "Batch not found" });

      // Replace route assignments if provided
      if (body.routeIds !== undefined) {
        await pgClient`DELETE FROM batch_routes WHERE batch_id = ${id}`;
        for (const routeId of body.routeIds) {
          await pgClient`
            INSERT INTO batch_routes (batch_id, route_id)
            VALUES (${id}, ${routeId})
            ON CONFLICT (batch_id, route_id) DO NOTHING
          `;
        }
      }

      return reply.send({ batch: updated });
    }
  );

  // DELETE /api/v1/batches/:id — soft delete
  app.delete(
    "/api/v1/batches/:id",
    { preHandler: [adminAuth, requireRole("batches.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      await pgClient`DELETE FROM batch_routes WHERE batch_id = ${id}`;
      await pgClient`UPDATE routes SET primary_batch_id = NULL WHERE primary_batch_id = ${id}`;
      await pgClient`UPDATE batches SET deleted_at = now() WHERE id = ${id} AND deleted_at IS NULL`;
      return reply.send({ message: "Batch deleted" });
    }
  );
}