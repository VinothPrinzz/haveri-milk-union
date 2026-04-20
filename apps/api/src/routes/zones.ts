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
        SELECT id, name, slug, icon, color, active
        FROM zones
        WHERE active = true
        ORDER BY name
      `;
      return reply.send({ zones });
    }
  );
}
