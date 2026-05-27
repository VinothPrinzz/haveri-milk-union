import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { cancellationRequests, orders, dealers } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";
import { cancelOrderWithReversal } from "../lib/cancel-order.js";

export async function cancellationRoutes(app: FastifyInstance) {
  // GET /api/v1/cancellations — list all cancellation requests
  app.get(
    "/api/v1/cancellations",
    { preHandler: [adminAuth, requireRole("orders.view")] },
    async (request, reply) => {
      const rows = await pgClient`
      SELECT cr.id, cr.order_id, cr.dealer_id, cr.reason, cr.status,
             cr.review_note, cr.created_at, cr.reviewed_at,
             d.name  AS dealer_name,
             d.code  AS agent_code,
             d.route_id,
             r.code  AS route_code,
             r.name  AS route_name,
             o.grand_total,
             o.subtotal, o.total_gst,
             COALESCE(
               (SELECT json_agg(json_build_object(
                  'product_id',   oi.product_id,
                  'product_name', oi.product_name,
                  'quantity',     oi.quantity,
                  'unit_price',   oi.unit_price,
                  'line_total',   oi.line_total)
                 ORDER BY oi.product_name)
                FROM order_items oi WHERE oi.order_id = cr.order_id),
               '[]'::json
             ) AS items
      FROM cancellation_requests cr
      JOIN dealers d ON d.id = cr.dealer_id
      LEFT JOIN routes r ON r.id = d.route_id
      LEFT JOIN orders o ON o.id = cr.order_id
      ORDER BY cr.created_at DESC
    `;
      return reply.send({ data: rows });
    }
  );

  // PATCH /api/v1/cancellations/:id/approve — approve + cancel order + refund
  app.patch(
    "/api/v1/cancellations/:id/approve",
    { preHandler: [adminAuth, requireRole("orders.cancel")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };

      const [cr] = await db
        .select()
        .from(cancellationRequests)
        .where(eq(cancellationRequests.id, id))
        .limit(1);

      if (!cr) return reply.status(404).send({ error: "Cancellation request not found" });
      if (cr.status !== "pending") return reply.status(400).send({ error: "Already processed" });

      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        // 1. Mark cancellation request approved
        await tx`
          UPDATE cancellation_requests
          SET status = 'approved',
              reviewed_by = ${request.admin!.userId},
              reviewed_at = now(),
              updated_at = now()
          WHERE id = ${id}
        `;

        // 2 + 3 + 4. Cancel order + financial reversal (wallet or credit)
        // Uses the shared helper so admin and self-service paths stay in sync.
        await cancelOrderWithReversal(
          tx,
          cr.orderId,
          "Approved cancellation request",
          request.admin!.userId,
        );

        // 5. Restore product stock
        const items = await tx`
          SELECT product_id, quantity FROM order_items WHERE order_id = ${cr.orderId}
        `;
        for (const item of items) {
          await tx`
            UPDATE products
            SET stock = stock + ${item.quantity},
                updated_at = now()
            WHERE id = ${item.product_id}
          `;
        }
      });

      return reply.send({ 
        message: "Cancellation approved, order cancelled, refund processed" 
      });
    }
  );

  // PATCH /api/v1/cancellations/:id/reject (unchanged)
  app.patch(
    "/api/v1/cancellations/:id/reject",
    { preHandler: [adminAuth, requireRole("orders.cancel")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({ reviewNote: z.string().min(1, "Rejection reason is required") });
      const body = schema.parse(request.body);

      const [cr] = await db
        .select()
        .from(cancellationRequests)
        .where(eq(cancellationRequests.id, id))
        .limit(1);

      if (!cr) return reply.status(404).send({ error: "Not found" });
      if (cr.status !== "pending") return reply.status(400).send({ error: "Already processed" });

      await db
        .update(cancellationRequests)
        .set({
          status: "rejected",
          reviewedBy: request.admin!.userId,
          reviewNote: body.reviewNote,
          reviewedAt: new Date(),
        })
        .where(eq(cancellationRequests.id, id));

      return reply.send({ message: "Cancellation rejected" });
    }
  );
}