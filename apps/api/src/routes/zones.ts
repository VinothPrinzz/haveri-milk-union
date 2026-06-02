// ══════════════════════════════════════════════════════════════════
// NEW FILE: apps/api/src/routes/zones.ts
//
// Zones endpoint — provides zone list for frontend dropdowns.
// Register this in server.ts: await app.register(zoneRoutes);
// ══════════════════════════════════════════════════════════════════

import type { FastifyInstance } from "fastify";
import { pgClient } from "../lib/db.js";
import { adminAuth } from "../middleware/admin-auth.js";

export async function zoneRoutes(app: FastifyInstance) {
  // GET /api/v1/zones — list all active zones
  // Used by: New Customer form (zone dropdown), New Route form (taluka dropdown)
  app.get(
    "/api/v1/zones",
    { preHandler: [adminAuth] },
    async (_request, reply) => {
      const zones = await pgClient`
        SELECT
          z.id, z.name, z.slug, z.icon, z.color, z.active,
          z.officer_id AS "officerId",
          o.name       AS "officerName"
        FROM zones z
        LEFT JOIN officers o ON o.id = z.officer_id
        WHERE z.active = true
        ORDER BY z.name
      `;
      return reply.send({ zones });
    }
  );
}
