import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import { cancellationRequests, orders, dealers } from "@hmu/db/schema";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function cancellationRoutes(app: FastifyInstance) {
  // GET /api/v1/cancellations — list all cancellation requests
  app.get(
    "/api/v1/cancellations",
    { preHandler: [adminAuth, requireRole("orders.view")] },
    async (request, reply) => {
      const query = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);

      const [rows, [countRow]] = await Promise.all([
        pgClient`
          SELECT cr.id, cr.order_id, cr.reason, cr.status, cr.review_note,
                 cr.created_at, cr.reviewed_at,
                 d.name AS dealer_name, d.phone AS dealer_phone,
                 z.name AS zone_name,
                 o.grand_total, o.item_count, o.status AS order_status
          FROM cancellation_requests cr
          JOIN dealers d ON d.id = cr.dealer_id
          JOIN zones z ON z.id = d.zone_id
          LEFT JOIN orders o ON o.id = cr.order_id
          ORDER BY
            CASE WHEN cr.status = 'pending' THEN 0 ELSE 1 END,
            cr.created_at DESC
          LIMIT ${query.limit} OFFSET ${offset}
        `,
        pgClient`SELECT count(*)::int AS count FROM cancellation_requests`,
      ]);

      // Get order items for each cancellation
      for (const row of rows) {
        const items = await pgClient`
          SELECT product_name, quantity FROM order_items WHERE order_id = ${row.order_id}
        `;
        (row as any).items = items;
      }

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // PATCH /api/v1/cancellations/:id/approve — approve + cancel order + refund wallet
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

      await pgClient.begin(async (tx) => {
        // 1. Update cancellation request
        await tx`
          UPDATE cancellation_requests SET status = 'approved', reviewed_by = ${request.admin!.userId},
          reviewed_at = now(), updated_at = now() WHERE id = ${id}
        `;

        // 2. Cancel the order
        await tx`
          UPDATE orders SET status = 'cancelled', cancelled_at = now(),
          cancellation_reason = 'Approved cancellation request', updated_at = now()
          WHERE id = ${cr.orderId}
        `;

        // 3. Refund wallet if paid via wallet
        const [order] = await tx`SELECT payment_mode, grand_total, dealer_id FROM orders WHERE id = ${cr.orderId}`;
        if (order && order.payment_mode === "wallet") {
          const [wallet] = await tx`
            UPDATE dealer_wallets SET balance = balance + ${order.grand_total}::numeric, updated_at = now()
            WHERE dealer_id = ${order.dealer_id} RETURNING balance
          `;
          // 4. Ledger entry for refund
          await tx`
            INSERT INTO dealer_ledger (dealer_id, type, amount, reference_id, reference_type, description, balance_after, performed_by)
            VALUES (${order.dealer_id}, 'credit', ${order.grand_total}::numeric, ${cr.orderId}, 'refund',
                    'Cancellation refund', ${wallet!.balance}::numeric, ${request.admin!.userId})
          `;
        }

        // 5. Restore product stock
        const items = await tx`SELECT product_id, quantity FROM order_items WHERE order_id = ${cr.orderId}`;
        for (const item of items) {
          await tx`UPDATE products SET stock = stock + ${item.quantity}, updated_at = now() WHERE id = ${item.product_id}`;
        }
      });

      return reply.send({ message: "Cancellation approved, order cancelled, wallet refunded" });
    }
  );

  // PATCH /api/v1/cancellations/:id/reject
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
