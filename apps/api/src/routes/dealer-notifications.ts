import type { FastifyInstance } from "fastify";
import { dealerAuth } from "../middleware/dealer-auth.js";
import { pgClient } from "../lib/db.js";

/**
 * Dealer Notifications Routes
 * These routes are specific to the mobile dealer app.
 */
export async function dealerNotificationsRoutes(app: FastifyInstance) {
  // GET /api/v1/dealer/notifications — list this dealer's notifications
  app.get(
    "/api/v1/dealer/notifications",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = request.dealer!.dealerId;
      const zoneId = request.dealer!.zoneId;
  
      const rows = await pgClient`
        SELECT 
          n.id, n.target_type, n.target_id, n.channel, n.title, n.message,
          n.status, n.sent_at, n.delivered_at, n.created_at,
          (r.notification_id IS NULL) AS unread
        FROM notifications_log n
        LEFT JOIN dealer_notification_reads r
          ON r.notification_id = n.id 
         AND r.dealer_id = ${dealerId}::uuid
        WHERE
          n.target_type = 'all'
          OR (n.target_type = 'dealer' AND n.target_id = ${dealerId}::uuid)
          OR (n.target_type = 'zone'   AND n.target_id = ${zoneId}::uuid)
        ORDER BY n.created_at DESC
        LIMIT 50
      `;
  
      return reply.send({ notifications: rows });
    }
  );

  app.post(
    "/api/v1/dealer/notifications/:id/read",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const dealerId = request.dealer!.dealerId;
  
      await pgClient`
        INSERT INTO dealer_notification_reads (dealer_id, notification_id)
        VALUES (${dealerId}::uuid, ${id}::uuid)
        ON CONFLICT DO NOTHING
      `;
  
      return reply.send({ ok: true });
    }
  );
}