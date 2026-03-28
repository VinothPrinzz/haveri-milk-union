import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, desc, and, sql, inArray } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import {
  orders,
  orderItems,
  products,
  dealers,
  dealerWallets,
  dealerLedger,
  timeWindows,
  invoices,
  cancellationRequests,
} from "@hmu/db/schema";
import { dealerAuth } from "../middleware/dealer-auth.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function orderRoutes(app: FastifyInstance) {
  // ════════════════════════════════════════════
  // POST /api/v1/orders — PLACE AN INDENT
  // This is the MOST CRITICAL endpoint in the system.
  // Must be concurrent-safe, handle edge cases:
  //   - Window closes mid-checkout
  //   - Product goes out of stock
  //   - Wallet exactly at zero
  //   - Two dealers ordering the same product simultaneously
  // ════════════════════════════════════════════
  app.post(
    "/api/v1/orders",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const schema = z.object({
        items: z
          .array(
            z.object({
              productId: z.string().uuid(),
              quantity: z.number().int().min(1),
            })
          )
          .min(1),
        paymentMode: z.enum(["wallet", "upi", "credit"]).default("wallet"),
        paymentReference: z.string().optional(),
        notes: z.string().optional(),
      });

      const body = schema.parse(request.body);
      const dealer = request.dealer!;

      // ── 1. Validate ordering window is still open ──
      const [tw] = await db
        .select()
        .from(timeWindows)
        .where(eq(timeWindows.zoneId, dealer.zoneId))
        .limit(1);

      if (!tw || !tw.active) {
        return reply.status(403).send({
          error: "Window Closed",
          message: "Ordering window is not active for your zone",
        });
      }

      const now = new Date();
      const istTime = new Date(
        now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
      );
      const currentMinutes = istTime.getHours() * 60 + istTime.getMinutes();
      const [openH, openM] = tw.openTime.split(":").map(Number);
      const [closeH, closeM] = tw.closeTime.split(":").map(Number);
      const openMins = openH! * 60 + openM!;
      const closeMins = closeH! * 60 + closeM!;

      if (currentMinutes < openMins || currentMinutes >= closeMins) {
        return reply.status(403).send({
          error: "Window Closed",
          message: `Ordering window is ${tw.openTime}–${tw.closeTime}. Please try during the window.`,
        });
      }

      // ── 2. Fetch product details and validate availability ──
      const productIds = body.items.map((i) => i.productId);
      const productRows = await db
        .select({
          id: products.id,
          name: products.name,
          basePrice: products.basePrice,
          gstPercent: products.gstPercent,
          stock: products.stock,
          available: products.available,
        })
        .from(products)
        .where(inArray(products.id, productIds));

      const productMap = new Map(productRows.map((p) => [p.id, p]));

      // Validate all products exist and are available
      for (const item of body.items) {
        const product = productMap.get(item.productId);
        if (!product) {
          return reply.status(400).send({
            error: "Invalid Product",
            message: `Product ${item.productId} not found`,
          });
        }
        if (!product.available) {
          return reply.status(400).send({
            error: "Product Unavailable",
            message: `${product.name} is currently unavailable`,
          });
        }
        if (product.stock < item.quantity) {
          return reply.status(400).send({
            error: "Insufficient Stock",
            message: `${product.name} has only ${product.stock} units available`,
          });
        }
      }

      // ── 3. Calculate totals with GST ──
      let subtotal = 0;
      let totalGst = 0;
      const orderItemsData: Array<{
        productId: string;
        productName: string;
        quantity: number;
        unitPrice: string;
        gstPercent: string;
        gstAmount: string;
        lineTotal: string;
      }> = [];

      for (const item of body.items) {
        const product = productMap.get(item.productId)!;
        const price = parseFloat(product.basePrice);
        const gstPct = parseFloat(product.gstPercent);
        const lineSubtotal = price * item.quantity;
        const lineGst = lineSubtotal * (gstPct / 100);
        const lineTotal = lineSubtotal + lineGst;

        subtotal += lineSubtotal;
        totalGst += lineGst;

        orderItemsData.push({
          productId: item.productId,
          productName: product.name,
          quantity: item.quantity,
          unitPrice: price.toFixed(2),
          gstPercent: gstPct.toFixed(2),
          gstAmount: lineGst.toFixed(2),
          lineTotal: lineTotal.toFixed(2),
        });
      }

      const grandTotal = subtotal + totalGst;

      // ── 4. ATOMIC wallet deduction (if wallet payment) ──
      // Single query with WHERE balance >= amount — Postgres row-level lock handles concurrency.
      if (body.paymentMode === "wallet") {
        const result = await pgClient`
          UPDATE dealer_wallets
          SET balance = balance - ${grandTotal.toFixed(2)}::numeric,
              updated_at = now()
          WHERE dealer_id = ${dealer.dealerId}
            AND balance >= ${grandTotal.toFixed(2)}::numeric
          RETURNING balance
        `;

        if (result.length === 0) {
          // Get current balance for the error message
          const [wallet] = await db
            .select({ balance: dealerWallets.balance })
            .from(dealerWallets)
            .where(eq(dealerWallets.dealerId, dealer.dealerId))
            .limit(1);

          return reply.status(402).send({
            error: "Insufficient Balance",
            message: `Wallet balance ₹${wallet?.balance ?? "0"} is less than order total ₹${grandTotal.toFixed(2)}`,
            currentBalance: wallet?.balance ?? "0",
            orderTotal: grandTotal.toFixed(2),
          });
        }
      }

      // ── 5. Create order + items + ledger entry in a transaction ──
      try {
        const result = await pgClient.begin(async (tx) => {
          // Insert order
          const [order] = await tx`
            INSERT INTO orders (dealer_id, zone_id, status, payment_mode, payment_reference, subtotal, total_gst, grand_total, item_count, notes, created_at, updated_at)
            VALUES (
              ${dealer.dealerId}, ${dealer.zoneId}, 'pending', ${body.paymentMode},
              ${body.paymentReference ?? null},
              ${subtotal.toFixed(2)}::numeric, ${totalGst.toFixed(2)}::numeric, ${grandTotal.toFixed(2)}::numeric,
              ${orderItemsData.length}, ${body.notes ?? null}, now(), now()
            )
            RETURNING id, created_at
          `;

          // Insert order items
          for (const item of orderItemsData) {
            await tx`
              INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total)
              VALUES (${order!.id}, ${item.productId}, ${item.productName}, ${item.quantity},
                      ${item.unitPrice}::numeric, ${item.gstPercent}::numeric, ${item.gstAmount}::numeric, ${item.lineTotal}::numeric)
            `;
          }

          // Deduct stock
          for (const item of body.items) {
            await tx`
              UPDATE products SET stock = stock - ${item.quantity}, updated_at = now()
              WHERE id = ${item.productId}
            `;
          }

          // Insert ledger entry (append-only) if wallet payment
          if (body.paymentMode === "wallet") {
            const [wallet] = await tx`
              SELECT balance FROM dealer_wallets WHERE dealer_id = ${dealer.dealerId}
            `;
            await tx`
              INSERT INTO dealer_ledger (dealer_id, type, amount, reference_id, reference_type, description, balance_after)
              VALUES (${dealer.dealerId}, 'debit', ${grandTotal.toFixed(2)}::numeric,
                      ${order!.id}, 'order', ${"Order " + order!.id}, ${wallet!.balance}::numeric)
            `;
          }

          return order;
        });

        return reply.status(201).send({
          message: "Order placed successfully",
          order: {
            id: result!.id,
            createdAt: result!.created_at,
            grandTotal: grandTotal.toFixed(2),
            itemCount: orderItemsData.length,
            paymentMode: body.paymentMode,
            status: "pending",
          },
        });
      } catch (err) {
        // If transaction fails and we already deducted wallet, we need to refund
        if (body.paymentMode === "wallet") {
          await pgClient`
            UPDATE dealer_wallets
            SET balance = balance + ${grandTotal.toFixed(2)}::numeric, updated_at = now()
            WHERE dealer_id = ${dealer.dealerId}
          `;
          request.log.error(err, "Order transaction failed — wallet refunded");
        }
        throw err;
      }
    }
  );

  // GET /api/v1/orders — list orders (admin, paginated)
  app.get(
    "/api/v1/orders",
    { preHandler: [adminAuth, requireRole("orders.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        status: z.string().optional(),
        zoneId: z.string().uuid().optional(),
      });
      const query = querySchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);

      const statusFilter = query.status ?? null;
      const zoneFilter = query.zoneId ?? null;

      const dataRows = await pgClient`
        SELECT o.id, o.dealer_id, o.zone_id, o.status, o.payment_mode,
               o.grand_total, o.item_count, o.created_at,
               d.name AS dealer_name, d.phone AS dealer_phone,
               z.name AS zone_name
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        JOIN zones z ON z.id = o.zone_id
        WHERE (${statusFilter}::text IS NULL OR o.status::text = ${statusFilter ?? ''})
          AND (${zoneFilter}::uuid IS NULL OR o.zone_id = ${zoneFilter ?? '00000000-0000-0000-0000-000000000000'}::uuid)
        ORDER BY o.created_at DESC
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM orders o
        WHERE (${statusFilter}::text IS NULL OR o.status::text = ${statusFilter ?? ''})
          AND (${zoneFilter}::uuid IS NULL OR o.zone_id = ${zoneFilter ?? '00000000-0000-0000-0000-000000000000'}::uuid)
      `;

      return reply.status(200).send({
        data: dataRows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/orders/my — dealer's own orders
  app.get(
    "/api/v1/orders/my",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const query = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
      const dealerId = request.dealer!.dealerId;

      const [dataRows, [countRow]] = await Promise.all([
        pgClient`
          SELECT id, status, payment_mode, grand_total, item_count, created_at
          FROM orders
          WHERE dealer_id = ${dealerId}
          ORDER BY created_at DESC
          LIMIT ${query.limit} OFFSET ${offset}
        `,
        pgClient`
          SELECT count(*)::int AS count FROM orders WHERE dealer_id = ${dealerId}
        `,
      ]);

      return reply.status(200).send({
        data: dataRows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/orders/:id — order detail with items
  app.get("/api/v1/orders/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    const [order] = await pgClient`
      SELECT o.*, d.name AS dealer_name, d.phone AS dealer_phone, z.name AS zone_name
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
      JOIN zones z ON z.id = o.zone_id
      WHERE o.id = ${id}
      LIMIT 1
    `;

    if (!order) {
      return reply.status(404).send({ error: "Order not found" });
    }

    const items = await db
      .select()
      .from(orderItems)
      .where(eq(orderItems.orderId, id));

    return reply.status(200).send({ order, items });
  });

  // PATCH /api/v1/orders/:id/status — update order status (admin)
  app.patch(
    "/api/v1/orders/:id/status",
    { preHandler: [adminAuth, requireRole("orders.update")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        status: z.enum(["confirmed", "dispatched", "delivered", "cancelled"]),
      });
      const body = schema.parse(request.body);

      const timestampField: Record<string, string> = {
        confirmed: "confirmed_at",
        dispatched: "dispatched_at",
        delivered: "delivered_at",
        cancelled: "cancelled_at",
      };

      const field = timestampField[body.status]!;

      const result = await pgClient`
        UPDATE orders
        SET status = ${body.status}::order_status,
            ${pgClient(field)} = now(),
            updated_at = now()
        WHERE id = ${id}
        RETURNING id, status
      `;

      if (result.length === 0) {
        return reply.status(404).send({ error: "Order not found" });
      }

      return reply.status(200).send({ order: result[0] });
    }
  );

  // POST /api/v1/orders/:id/cancel — dealer requests cancellation
  app.post(
    "/api/v1/orders/:id/cancel",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({ reason: z.string().min(1) });
      const body = schema.parse(request.body);

      // Only pending orders can be cancelled
      const [order] = await pgClient`
        SELECT id, status, dealer_id FROM orders WHERE id = ${id} LIMIT 1
      `;

      if (!order) {
        return reply.status(404).send({ error: "Order not found" });
      }
      if (order.dealer_id !== request.dealer!.dealerId) {
        return reply.status(403).send({ error: "Not your order" });
      }
      if (order.status !== "pending") {
        return reply.status(400).send({
          error: "Cannot cancel",
          message: `Order is already ${order.status}`,
        });
      }

      const [cr] = await db
        .insert(cancellationRequests)
        .values({
          orderId: id,
          dealerId: request.dealer!.dealerId,
          reason: body.reason,
        })
        .returning();

      return reply.status(201).send({
        message: "Cancellation request submitted",
        cancellationRequest: cr,
      });
    }
  );
}
