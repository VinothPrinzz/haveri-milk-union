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

      // Credit-mode pre-check (Issue #8): block if order would exceed dealer credit_limit
      if (body.paymentMode === "credit") {
        const [d] = await pgClient`
          SELECT COALESCE(credit_limit, 0)::numeric AS credit_limit,
                 COALESCE((SELECT SUM(grand_total) FROM orders o
                           WHERE o.dealer_id = dealers.id
                             AND o.payment_mode = 'credit'
                             AND o.status NOT IN ('cancelled','delivered')), 0)::numeric AS outstanding
          FROM dealers WHERE id = ${body.dealerId}
        `;
        const available = parseFloat(d.credit_limit) - parseFloat(d.outstanding);
        if (grandTotal > available) {
          return reply.status(402).send({
            error: "Credit limit exceeded",
            message: `Dealer credit limit ₹${d.credit_limit}, outstanding ₹${d.outstanding}, available ₹${available.toFixed(2)}, this order ₹${grandTotal.toFixed(2)}`,
            availableCredit: available.toFixed(2),
            requestedAmount: grandTotal.toFixed(2),
          });
        }
      }

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

        // Re-fetch the order with items so the UI can show the receipt without an extra request.
        const items = await pgClient`
          SELECT product_id, product_name, quantity,
                unit_price, gst_percent, gst_amount, line_total
          FROM order_items WHERE order_id = ${result!.id}
          ORDER BY product_name
        `;

        return reply.status(201).send({
          message: "Order placed successfully",
          order: {
            id:         result!.id,
            createdAt:  result!.created_at,
            dealerId:   body.dealerId,
            status:     "pending",
            paymentMode: body.paymentMode,
            subtotal:   subtotal.toFixed(2),
            totalGst:   totalGst.toFixed(2),
            grandTotal: grandTotal.toFixed(2),
            itemCount:  orderItemsData.length,
            items,
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
        status:   z.enum(["pending","confirmed","dispatched","delivered","cancelled"]).optional(),
        dealerId: z.string().uuid().optional(),
        zoneId:   z.string().uuid().optional(),
        routeId:  z.string().uuid().optional(),       // Issue #9
        batchId:  z.string().uuid().optional(),       // Issue #9
        date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),  // Issue #9
        search:   z.string().optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);
      const search = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        SELECT o.id, o.dealer_id, o.zone_id, o.status, o.payment_mode,
               o.subtotal, o.total_gst, o.grand_total, o.item_count,
               o.created_at, o.confirmed_at, o.dispatched_at,
               d.name  AS dealer_name,
               d.phone AS dealer_phone,
               d.code  AS agent_code,
               d.route_id,
               r.code  AS route_code,
               r.name  AS route_name,
               z.name  AS zone_name,
               COALESCE(
                (SELECT json_agg(json_build_object(
                    'product_id',   oi.product_id,
                    'product_name', oi.product_name,
                    'quantity',     oi.quantity,
                    'unit_price',   oi.unit_price,
                    'line_total',   oi.line_total
                  ) ORDER BY oi.product_name)
                FROM order_items oi WHERE oi.order_id = o.id),
                '[]'::json
              ) AS items
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        LEFT JOIN routes r ON r.id = d.route_id
        LEFT JOIN zones  z ON z.id = o.zone_id
        WHERE (${q.status ?? null}::text IS NULL OR o.status::text = ${q.status ?? ''})
          AND (${q.dealerId ?? null}::uuid IS NULL OR o.dealer_id = ${q.dealerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${q.zoneId   ?? null}::uuid IS NULL OR o.zone_id   = ${q.zoneId   ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${q.routeId  ?? null}::uuid IS NULL OR d.route_id  = ${q.routeId  ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${q.date     ?? null}::date IS NULL OR o.created_at::date = ${q.date ?? '1970-01-01'}::date)
          AND (${q.batchId  ?? null}::uuid IS NULL OR EXISTS (
                SELECT 1 FROM batch_routes br
                WHERE br.batch_id = ${q.batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid
                  AND br.route_id = d.route_id))
          AND (${search}::text IS NULL OR d.name ILIKE ${search ?? ''} OR d.phone ILIKE ${search ?? ''})
        ORDER BY o.created_at DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        WHERE (${q.status ?? null}::text IS NULL OR o.status::text = ${q.status ?? ''})
          AND (${q.dealerId ?? null}::uuid IS NULL OR o.dealer_id = ${q.dealerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${q.zoneId   ?? null}::uuid IS NULL OR o.zone_id   = ${q.zoneId   ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${q.routeId  ?? null}::uuid IS NULL OR d.route_id  = ${q.routeId  ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${q.date     ?? null}::date IS NULL OR o.created_at::date = ${q.date ?? '1970-01-01'}::date)
          AND (${q.batchId  ?? null}::uuid IS NULL OR EXISTS (
                SELECT 1 FROM batch_routes br
                WHERE br.batch_id = ${q.batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid
                  AND br.route_id = d.route_id))
          AND (${search}::text IS NULL OR d.name ILIKE ${search ?? ''} OR d.phone ILIKE ${search ?? ''})
      `;

      return reply.send({ data: rows, ...paginationMeta(countRow?.count ?? 0, q.page, q.limit) });
    }
  );

  // GET /api/v1/orders/my — dealer's own orders (unchanged)
  app.get(
    "/api/v1/orders/my",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const query = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
      const dealerId = request.dealer!.dealerId;

      const orders = await pgClient`
        SELECT id, status, payment_mode, subtotal, total_gst, grand_total, item_count, created_at
        FROM orders
        WHERE dealer_id = ${dealerId}
        ORDER BY created_at DESC
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      // Fetch items for each order
      for (const order of orders) {
        const items = await pgClient`
          SELECT product_name, quantity, unit_price, gst_percent, line_total
          FROM order_items WHERE order_id = ${order.id} ORDER BY product_name
        `;
        (order as any).items = items;
      }

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM orders WHERE dealer_id = ${dealerId}
      `;

      return reply.status(200).send({
        data: orders,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/orders/:id — order detail with items (unchanged)
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

  // PATCH /api/v1/orders/:id/status — update order status (admin) (unchanged)
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

  // POST /api/v1/orders/:id/cancel — dealer requests cancellation (unchanged)
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

  // PATCH /api/v1/orders/:id/items — modify items on an existing pending order
  app.patch(
    "/api/v1/orders/:id/items",
    { preHandler: [adminAuth, requireRole("orders.create")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        items: z.array(z.object({
          productId: z.string().uuid(),
          quantity:  z.number().int().min(0),    // 0 = remove
        })).min(1),
      });
      const body = schema.parse(request.body);

      // Lock the order, verify it's modifiable.
      const [existing] = await pgClient`
        SELECT id, dealer_id, status, payment_mode, grand_total, created_at
        FROM orders WHERE id = ${id} FOR UPDATE
      `;
      if (!existing) return reply.status(404).send({ error: "Order not found" });
      if (!["pending", "confirmed"].includes(existing.status)) {
        return reply.status(409).send({ error: `Cannot modify ${existing.status} order` });
      }

      // Fetch current product info for the new items.
      const productIds = body.items.filter(i => i.quantity > 0).map(i => i.productId);
      const productRows = productIds.length
        ? await pgClient`SELECT id, name, base_price, gst_percent, stock FROM products WHERE id = ANY(${productIds}::uuid[])`
        : [];
      const productMap = new Map(productRows.map((p: any) => [p.id, p]));

      let newSubtotal = 0, newGst = 0;
      const newLines: any[] = [];
      for (const item of body.items) {
        if (item.quantity === 0) continue;        // remove
        const p = productMap.get(item.productId);
        if (!p) return reply.status(400).send({ error: `Product ${item.productId} not found` });
        const price = parseFloat(p.base_price);
        const gstPct = parseFloat(p.gst_percent);
        const lineSub = price * item.quantity;
        const lineGst = lineSub * (gstPct / 100);
        newSubtotal += lineSub; newGst += lineGst;
        newLines.push({ productId: item.productId, productName: p.name, quantity: item.quantity,
          unitPrice: price.toFixed(2), gstPercent: gstPct.toFixed(2),
          gstAmount: lineGst.toFixed(2), lineTotal: (lineSub + lineGst).toFixed(2) });
      }
      const newGrandTotal = newSubtotal + newGst;
      const oldGrandTotal = parseFloat(existing.grand_total);
      const delta = newGrandTotal - oldGrandTotal;

      // Restore stock for the OLD items (we'll deduct fresh for the new items).
      const oldItems = await pgClient`SELECT product_id, quantity FROM order_items WHERE order_id = ${id}`;

      await pgClient.begin(async (tx) => {
        for (const oi of oldItems) {
          await tx`UPDATE products SET stock = stock + ${oi.quantity}, updated_at = now() WHERE id = ${oi.product_id}`;
        }
        // Insert new items (and re-deduct stock).
        await tx`DELETE FROM order_items WHERE order_id = ${id}`;
        for (const li of newLines) {
          await tx`INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total)
                   VALUES (${id}, ${li.productId}, ${li.productName}, ${li.quantity},
                           ${li.unitPrice}::numeric, ${li.gstPercent}::numeric, ${li.gstAmount}::numeric, ${li.lineTotal}::numeric)`;
          await tx`UPDATE products SET stock = stock - ${li.quantity}, updated_at = now() WHERE id = ${li.productId}`;
        }
        // Update the order header.
        await tx`UPDATE orders SET subtotal = ${newSubtotal.toFixed(2)}::numeric,
                                    total_gst = ${newGst.toFixed(2)}::numeric,
                                    grand_total = ${newGrandTotal.toFixed(2)}::numeric,
                                    item_count = ${newLines.length},
                                    updated_at = now()
                  WHERE id = ${id}`;

        // Wallet adjustment if applicable: refund or charge the delta.
        if (existing.payment_mode === "wallet" && delta !== 0) {
          if (delta > 0) {
            // charge more
            const r = await tx`UPDATE dealer_wallets SET balance = balance - ${delta.toFixed(2)}::numeric, updated_at = now()
                               WHERE dealer_id = ${existing.dealer_id} AND balance >= ${delta.toFixed(2)}::numeric
                               RETURNING balance`;
            if (r.length === 0) throw new Error("Insufficient wallet balance for upward modification");
            const [w] = r as any;
            await tx`INSERT INTO dealer_ledger (dealer_id, type, amount, reference_id, reference_type, description, balance_after, performed_by)
                    VALUES (${existing.dealer_id}, 'debit', ${delta.toFixed(2)}::numeric, ${id},
                            'adjustment', ${'Modify order ' + id}, ${w.balance}::numeric, ${request.admin!.userId})`;
          } else {
            const refund = Math.abs(delta);
            await tx`UPDATE dealer_wallets SET balance = balance + ${refund.toFixed(2)}::numeric, updated_at = now() WHERE dealer_id = ${existing.dealer_id}`;
            const [w] = await tx`SELECT balance FROM dealer_wallets WHERE dealer_id = ${existing.dealer_id}`;
            await tx`INSERT INTO dealer_ledger (dealer_id, type, amount, reference_id, reference_type, description, balance_after, performed_by)
                    VALUES (${existing.dealer_id}, 'credit', ${refund.toFixed(2)}::numeric, ${id},
                            'adjustment', ${'Modify refund ' + id}, ${w!.balance}::numeric, ${request.admin!.userId})`;
          }
        }
      });

      const items = await pgClient`SELECT product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total FROM order_items WHERE order_id = ${id} ORDER BY product_name`;
      return reply.send({
        message: "Order modified successfully",
        order: { id, subtotal: newSubtotal.toFixed(2), totalGst: newGst.toFixed(2), grandTotal: newGrandTotal.toFixed(2), itemCount: newLines.length, items },
      });
    }
  );
}