import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { eq, inArray } from "drizzle-orm";
import { db, pgClient } from "../lib/db.js";
import {
  orderItems,
  products,
  dealerWallets,
} from "@hmu/db/schema";
import { dealerAuth } from "../middleware/dealer-auth.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";
import { enqueuePDFInvoice, enqueuePushNotification } from "../lib/queue.js";
import { signInvoicePdfToken, verifyInvoicePdfToken } from "../lib/auth.js";
import { generateInvoicePdfSync } from "../lib/invoice-pdf.js";
import { adminCancelOrder, RefundError } from "../lib/cancel-order.js";
import {
  findMinQtyViolations,
  minQtyErrorMessage,
} from "../lib/min-order-qty.js";
import { checkDealerCredit } from "../lib/credit-check.js";
import { PDFDocument } from "pdf-lib";
import jwt from "jsonwebtoken"

export async function orderRoutes(app: FastifyInstance) {
  // ════════════════════════════════════════════
  // POST /api/v1/orders — PLACE AN INDENT
  // This is the MOST CRITICAL endpoint in the system.
  // Must be concurrent-safe, handle edge cases:
  // - Window closes mid-checkout
  // - Product goes out of stock
  // - Wallet exactly at zero
  // - Two dealers ordering the same product simultaneously
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
      // Time-windows are route-based (migration 0023): the admin panel
      // configures one window per route, so look it up via the dealer's
      // assigned route — not their zone (which left this query empty and
      // failed every order with "not active for your zone").
      const [tw] = await pgClient`
        SELECT tw.open_time  AS "openTime",
               tw.close_time AS "closeTime",
               tw.active     AS active
          FROM dealers d
          JOIN time_windows tw ON tw.route_id = d.route_id
         WHERE d.id = ${dealer.dealerId}::uuid
         LIMIT 1
      ` as unknown as Array<{ openTime: string; closeTime: string; active: boolean }>;
      if (!tw || !tw.active) {
        return reply.status(403).send({
          error: "Window Closed",
          message: "Ordering window is not active for your route",
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

      // ── 2b. Enforce Milk order minimum (≥12 L milk; curd has no minimum) ──
      const minQtyViolations = await findMinQtyViolations(body.items);
      if (minQtyViolations.length > 0) {
        return reply.status(400).send({
          error: "Minimum order quantity",
          message: minQtyErrorMessage(minQtyViolations),
          violations: minQtyViolations,
        });
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

      // Prepaid balance pre-check: block if the order exceeds available balance
      // (opening + top-ups − purchases). No credit limit — customers spend only
      // what they've paid in. checkDealerCredit is the single source of truth.
      if (body.paymentMode === "credit") {
        const credit = await checkDealerCredit(dealer.dealerId, grandTotal);
        if (!credit.sufficient) {
          return reply.status(402).send({
            error: "Insufficient balance",
            message: `Available balance ₹${credit.available.toFixed(2)} is short of this order ₹${grandTotal.toFixed(2)} by ₹${credit.shortfall.toFixed(2)}. Please top up.`,
            availableCredit: credit.available.toFixed(2),
            requestedAmount: grandTotal.toFixed(2),
          });
        }
      }

      // ── 4. Create order + items + ledger entry in a single transaction ──
      // Wallet deduction is inside so it rolls back atomically if any step fails.
      // TransactionSql<{}> extends Omit<Sql<{}>, ...> which drops call signatures;
      // cast to typeof pgClient to restore them.

      // UPI orders aren't paid here — they go to 'payment_required' and the
      // dealer settles via the Razorpay pay-now endpoint. wallet/credit settle
      // synchronously inside the transaction below, so they're confirmed
      // immediately. ('pending' is deprecated — dispatch/finance only look at
      // 'confirmed', and the dealer app only offers Cancel on 'confirmed'.)
      const initialStatus =
        body.paymentMode === "upi" ? "payment_required" : "confirmed";

      try {
        const result = await pgClient.begin(async (_tx) => {
          const tx = _tx as unknown as typeof pgClient;
          // Insert order
          const [order] = await tx`
            INSERT INTO orders (dealer_id, zone_id, status, payment_mode, payment_reference, subtotal, total_gst, grand_total, item_count, notes, created_at, updated_at)
            VALUES (
              ${dealer.dealerId}, ${dealer.zoneId}, ${initialStatus}, ${body.paymentMode},
              ${body.paymentReference ?? null},
              ${subtotal.toFixed(2)}::numeric, ${totalGst.toFixed(2)}::numeric, ${grandTotal.toFixed(2)}::numeric,
              ${orderItemsData.length}, ${body.notes ?? null}, now(), now()
            )
            RETURNING id, created_at
          `;

          // For settled (confirmed) orders, stamp confirm time + the
          // route-based self-cancel window: LEAST(now + 30 min, the route's
          // close time for this order's delivery date). delivery_date
          // defaults to today (IST), so these cart orders are same-day and
          // get the close-time cap. UPI orders get this on pay-now instead.
          if (initialStatus === "confirmed") {
            await tx`
              UPDATE orders
                 SET confirmed_at = now(),
                     cancel_window_ends_at = LEAST(
                       now() + interval '30 minutes',
                       COALESCE(
                         (orders.delivery_date + tw.close_time) AT TIME ZONE 'Asia/Kolkata',
                         now() + interval '30 minutes'
                       )
                     )
                FROM dealers d
                LEFT JOIN time_windows tw ON tw.route_id = d.route_id
               WHERE orders.id = ${order!.id}::uuid
                 AND orders.dealer_id = d.id
            `;
          }

          // Insert order items
          for (const item of orderItemsData) {
            await tx`
              INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total)
              VALUES (${order!.id}, ${item.productId}, ${item.productName}, ${item.quantity},
                      ${item.unitPrice}::numeric, ${item.gstPercent}::numeric, ${item.gstAmount}::numeric, ${item.lineTotal}::numeric)
            `;
          }

          // Deduct stock — guard against concurrent orders driving stock negative
          for (const item of body.items) {
            const updated = await tx`
              UPDATE products SET stock = stock - ${item.quantity}, updated_at = now()
              WHERE id = ${item.productId} AND stock >= ${item.quantity}
              RETURNING id
            `;
            if (updated.length === 0) {
              throw Object.assign(new Error("Stock depleted"), { statusCode: 409, productId: item.productId });
            }
          }
          // Latch the deduction so a later cancel restores exactly once
          // (and a pay-now completion won't re-deduct). See migration 0049.
          await tx`UPDATE orders SET stock_deducted = true WHERE id = ${order!.id}`;

          // Deduct wallet atomically — balance check is inside the same transaction 
          if (body.paymentMode === "wallet") {
            const deducted = await tx`                                      
              UPDATE dealer_wallets                                         
              SET balance = balance - ${grandTotal.toFixed(2)}::numeric, updated_at = now()                                                      
              WHERE dealer_id = ${dealer.dealerId}                          
                AND balance >= ${grandTotal.toFixed(2)}::numeric            
              RETURNING balance
            `;
            if (deducted.length === 0) {                                    
              const [wallet] = await tx`SELECT balance FROM dealer_wallets WHERE dealer_id = ${dealer.dealerId}`;                                
              throw Object.assign(new Error("Insufficient Balance"),        {                                                                           
                statusCode: 402,                                            
                currentBalance: wallet?.balance ?? "0",                     
                orderTotal: grandTotal.toFixed(2),                          
              });                                                           
            }                                                              
            const walletBalance = (deducted[0] as any).balance;
            await tx`
              INSERT INTO dealer_ledger (dealer_id, type, amount, reference_id, reference_type, description, balance_after)
              VALUES (${dealer.dealerId}, 'debit', ${grandTotal.toFixed(2)}::numeric,
                      ${order!.id}, 'order', ${"Order " + order!.id}, ${walletBalance}::numeric)
            `;
          }

          // Credit-mode orders are debits against the dealer's credit line.
          // No wallet movement; just an audit row + running balance for
          // the credit-available calculation.
          if (body.paymentMode === "credit") {
            const [bal] = await tx`
              SELECT
                COALESCE(d.opening_balance, 0)
                + COALESCE((SELECT SUM(CASE WHEN dl.type='credit'
                                              AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                            THEN dl.amount ELSE 0 END) FROM dealer_ledger dl
                            WHERE dl.dealer_id = d.id), 0)
                - COALESCE((SELECT SUM(CASE WHEN dl.type='debit'
                                              AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                            THEN dl.amount ELSE 0 END) FROM dealer_ledger dl
                            WHERE dl.dealer_id = d.id), 0)
                AS bal
              FROM dealers d WHERE d.id = ${dealer.dealerId}
            `;
            const balanceAfter = (parseFloat(bal!.bal) - grandTotal);
            await tx`
              INSERT INTO dealer_ledger
                (dealer_id, type, amount,
                reference_id, reference_type,
                voucher_type, voucher_date,
                description, balance_after)
              VALUES
                (${dealer.dealerId}, 'debit', ${grandTotal.toFixed(2)}::numeric,
                ${order!.id}, 'order',
                'Invoice', now()::date,
                ${'Credit indent ' + order!.id},
                ${balanceAfter.toFixed(2)}::numeric)
            `;
          }

          return order;
        });



        // ── Auto-generate GST Invoice + Push Notification ──
        // UPI orders are NOT paid yet (status 'payment_required'). Invoice + push
        // fire only for wallet/credit, which are settled by this point. A
        // Razorpay-paid order gets its invoice on demand via /invoices/by-order
        // after pay-now/verify — same as the date-based draft flow.
        const settledNow = body.paymentMode !== "upi";

        if (result?.id && settledNow) {
          try {
            await enqueuePDFInvoice(result.id);
          } catch (err) {
            console.warn("[orders] PDF enqueue failed:", err);
          }
          try {
            await enqueuePushNotification({
              event: "order.confirmed",
              dealerId: dealer.dealerId,
              orderId: result.id,
            });
          } catch (err) {
            console.warn("[orders] Push enqueue failed:", err);
          }
        }

        const fullOrder = await pgClient`
          SELECT * FROM orders WHERE id = ${result!.id} LIMIT 1
        `;
        const itemsForResp = await pgClient`
          SELECT product_id, product_name, quantity,
                 unit_price, gst_percent, gst_amount, line_total
          FROM order_items WHERE order_id = ${result!.id}
          ORDER BY product_name
        `;

        let invoiceNumber: string | null = null;
        let invoicePdfUrl: string | null = null;

        if (settledNow) {
          try {
            const pdfResult = await generateInvoicePdfSync(result!.id);
            invoicePdfUrl = pdfResult.pdfUrl ?? null;
            const [inv] = await pgClient`
              SELECT invoice_number FROM invoices WHERE order_id = ${result!.id} LIMIT 1
            `;
            invoiceNumber = inv?.invoice_number ?? null;
          } catch (err) {
            console.error("[orders] Invoice generation failed:", err);
          }
        }

        return reply.status(201).send({
          message: "Order placed successfully",
          order: { ...fullOrder[0], items: itemsForResp },
          invoiceNumber,
          invoicePdfUrl,
        });
      } catch (err: any) {                                                  
        if (err.statusCode === 402) {                                       
          return reply.status(402).send({                                   
            error: "Insufficient Balance",                                  
            message: `Wallet balance ₹${err.currentBalance} is less than order total ₹${err.orderTotal}`,                                        
            currentBalance: err.currentBalance,                             
            orderTotal: err.orderTotal,                                     
          });                                                               
        }
        if (err.statusCode === 409) {                                       
          return reply.status(409).send({                                   
            error: "Insufficient Stock",                                    
            message: `Stock depleted for product ${err.productId} — please refresh and retry`,                                                   
          });                                                               
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
        // Admin All-Indents list can filter on any lifecycle state (drafts and
        // payment_required orders are visible here, just not on route sheets).
        status:   z.enum(["draft","pending","payment_required","confirmed","dispatched","delivered","cancelled"]).optional(),
        dealerId: z.string().uuid().optional(),
        zoneId:   z.string().uuid().optional(),
        routeId:  z.string().uuid().optional(),
        batchId:  z.string().uuid().optional(),
        date:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        from:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to:       z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        search:   z.string().optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);
      const search = q.search ? `%${q.search}%` : null;

      const rows = await pgClient`
        SELECT o.id, o.dealer_id, o.zone_id, o.status, o.payment_mode,
               o.subtotal, o.total_gst, o.grand_total, o.item_count,
               o.created_at, o.delivery_date, o.confirmed_at, o.dispatched_at,
               d.name  AS dealer_name,
               d.phone AS dealer_phone,
               d.code  AS agent_code,
               d.route_id,
               r.code  AS route_code,
               r.name  AS route_name,
               z.name  AS zone_name,
               -- Cancellation is only allowed while the order's delivery
               -- window is still open: now() < (delivery_date + route
               -- close_time). Today-not-yet-closed and future dates are
               -- true; past orders (window already shut) are false. Falls
               -- back to end of the delivery day when no window is set.
               (COALESCE(
                  (o.delivery_date + tw.close_time) AT TIME ZONE 'Asia/Kolkata',
                  ((o.delivery_date + 1)::timestamp) AT TIME ZONE 'Asia/Kolkata'
                ) > now()) AS window_open,
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
        LEFT JOIN LATERAL (
          SELECT close_time FROM time_windows tw
           WHERE tw.route_id = d.route_id
           ORDER BY close_time DESC LIMIT 1
        ) tw ON true
        WHERE (${q.status ?? null}::text IS NULL OR o.status::text = ${q.status ?? ''})
          AND (${q.dealerId ?? null}::uuid IS NULL OR o.dealer_id = ${q.dealerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${q.zoneId   ?? null}::uuid IS NULL OR o.zone_id   = ${q.zoneId   ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${q.routeId  ?? null}::uuid IS NULL OR d.route_id  = ${q.routeId  ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${q.date     ?? null}::date IS NULL OR o.delivery_date = ${q.date ?? '1970-01-01'}::date)
          AND (${q.from     ?? null}::date IS NULL OR o.delivery_date >= ${q.from ?? '1970-01-01'}::date)
          AND (${q.to       ?? null}::date IS NULL OR o.delivery_date <= ${q.to   ?? '9999-12-31'}::date)
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
          AND (${q.date     ?? null}::date IS NULL OR o.delivery_date = ${q.date ?? '1970-01-01'}::date)
          AND (${q.from     ?? null}::date IS NULL OR o.delivery_date >= ${q.from ?? '1970-01-01'}::date)
          AND (${q.to       ?? null}::date IS NULL OR o.delivery_date <= ${q.to   ?? '9999-12-31'}::date)
          AND (${q.batchId  ?? null}::uuid IS NULL OR EXISTS (
                SELECT 1 FROM batch_routes br
                WHERE br.batch_id = ${q.batchId ?? '00000000-0000-0000-0000-000000000000'}::uuid
                  AND br.route_id = d.route_id))
          AND (${search}::text IS NULL OR d.name ILIKE ${search ?? ''} OR d.phone ILIKE ${search ?? ''})
      `;

      return reply.send({ data: rows, ...paginationMeta(countRow?.count ?? 0, q.page, q.limit) });
    }
  );

  // GET /api/v1/orders/my — dealer's own orders (paginated, date-filterable)
  app.get(
    "/api/v1/orders/my",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        status: z.enum(["confirmed","dispatched","delivered","cancelled"]).optional(),
        from:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to:     z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);
      const dealerId = request.dealer!.dealerId;

      // Items aggregated with json_agg — ONE query for the whole page,
      // not one query per order like the old code.
      const ordersList = await pgClient`
        SELECT
          o.id, o.status, o.payment_mode,
          o.subtotal, o.total_gst, o.grand_total, o.item_count,
          o.created_at AS created_at,
          o.confirmed_at AS confirmed_at,
          o.delivery_date AS delivery_date,
          -- An unconfirmed order (draft / payment_required) is only still
          -- actionable until its delivery-day ordering window closes. Once
          -- past close, the auto-confirm job has resolved its fate, so the
          -- app should show "Not placed" rather than "Awaiting Payment" +
          -- Pay Now. Mirrors the window_open logic on the admin list.
          (o.status IN ('draft','payment_required')
            AND now() < COALESCE(
                  (o.delivery_date + tw.close_time) AT TIME ZONE 'Asia/Kolkata',
                  ((o.delivery_date + 1)::timestamp) AT TIME ZONE 'Asia/Kolkata'
                )) AS awaiting_payment_open,
          COALESCE(
            (SELECT json_agg(json_build_object(
                'product_id',   oi.product_id,
                'product_name', oi.product_name,
                'quantity',     oi.quantity,
                'unit_price',   oi.unit_price,
                'gst_percent',  oi.gst_percent,
                'gst_amount',   oi.gst_amount,
                'line_total',   oi.line_total
              ) ORDER BY oi.product_name)
            FROM order_items oi WHERE oi.order_id = o.id),
            '[]'::json
          ) AS items
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        LEFT JOIN LATERAL (
          SELECT close_time FROM time_windows tw
           WHERE tw.route_id = d.route_id AND tw.active = true
           ORDER BY close_time DESC LIMIT 1
        ) tw ON true
        WHERE o.dealer_id = ${dealerId}
          AND (${q.status ?? null}::text IS NULL OR o.status::text = ${q.status ?? ''})
          AND (${q.from ?? null}::date IS NULL OR o.delivery_date >= ${q.from ?? '1970-01-01'}::date)
          AND (${q.to   ?? null}::date IS NULL OR o.delivery_date <= ${q.to   ?? '9999-12-31'}::date)
        ORDER BY o.delivery_date DESC, o.created_at DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM orders o
        WHERE o.dealer_id = ${dealerId}
          AND (${q.status ?? null}::text IS NULL OR o.status::text = ${q.status ?? ''})
          AND (${q.from ?? null}::date IS NULL OR o.delivery_date >= ${q.from ?? '1970-01-01'}::date)
          AND (${q.to   ?? null}::date IS NULL OR o.delivery_date <= ${q.to   ?? '9999-12-31'}::date)
      `;

      return reply.status(200).send({
        data: ordersList,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // GET /api/v1/orders/:id — order detail                                  
  app.get(                                                                  
    "/api/v1/orders/:id",                                                   
    { preHandler: [adminAuth, requireRole("orders.view")] },                
    async (request, reply) => {                                             
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

      // Live credit standing for the dealer — lets the Modify screen show the
      // available balance and the debit/credit impact of an edit. Prepaid
      // model: `available` already reflects THIS order's existing debit.
      let credit = null;
      try {
        credit = await checkDealerCredit(order.dealer_id, 0);
      } catch {
        credit = null; // dealer soft-deleted/missing — omit rather than 500
      }

      return reply.status(200).send({ order, items, credit });
    }                                                                       
  ); 

  // PATCH /api/v1/orders/:id/status
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

  // POST /api/v1/orders/bulk-confirm
  // DEPRECATED — PostIndentPage has been removed. Orders now go directly
  // to 'confirmed' on dealer/auto-confirm. This endpoint is kept for any
  // legacy 'pending' orders that existed before migration 0023 and were
  // not caught by the UPDATE in that migration.
  app.post(
    "/api/v1/orders/bulk-confirm",
    { preHandler: [adminAuth, requireRole("orders.update")] },
    async (request, reply) => {
      const schema = z.object({
        ids: z.array(z.string().uuid()).min(1).max(500),
      });
      const { ids } = schema.parse(request.body);

      // Look up only legacy 'pending' orders (should be 0 after migration 0023)
      const legacyPending = await pgClient`
        SELECT id, dealer_id
        FROM orders
        WHERE id = ANY(${ids}::uuid[])
          AND status = 'pending'
        FOR UPDATE
      ` as Array<{ id: string; dealer_id: string }>;

      if (legacyPending.length === 0) {
        return reply.status(200).send({
          message: "No legacy pending orders found — all orders already confirmed",
          requested: ids.length,
          confirmed: 0,
          skipped: ids.length,
        });
      }

      const confirmIds = legacyPending.map((o) => o.id);

      const updated = await pgClient`
        UPDATE orders
        SET status       = 'confirmed'::order_status,
            confirmed_at = now(),
            updated_at   = now()
        WHERE id = ANY(${confirmIds}::uuid[])
          AND status = 'pending'
        RETURNING id, dealer_id
      ` as Array<{ id: string; dealer_id: string }>;

      for (const o of updated) {
        try { await enqueuePDFInvoice(o.id); } catch { /* logged in helper */ }
        try {
          await enqueuePushNotification({
            event:    "order.confirmed",
            dealerId: o.dealer_id,
            orderId:  o.id,
            title:    "Indent confirmed",
            body:     `Your indent #${String(o.id).slice(-4).toUpperCase()} has been confirmed.`,
          });
        } catch { /* logged in helper */ }
      }

      return reply.status(200).send({
        message:   `Confirmed ${updated.length} legacy order(s)`,
        requested: ids.length,
        confirmed: updated.length,
        skipped:   ids.length - updated.length,
        ids:       updated.map((o) => o.id),
      });
    },
  );

  // POST /api/v1/orders/:id/admin-cancel
  // Admin-only indent cancellation. The admin picks where the refund goes
  // via `refundMethod`: "razorpay" (to the dealer's bank, only for orders
  // with a captured online payment) or "balance" (store credit on the
  // dealer's available balance). Omitting it keeps the legacy auto-rule.
  // Cancellation is not dealer-initiated; the dealer app has no cancel path.
  app.post(
    "/api/v1/orders/:id/admin-cancel",
    { preHandler: [adminAuth, requireRole("orders.cancel")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const body = z
        .object({
          reason: z.string().min(1, "A cancellation reason is required"),
          // Where the refund goes. Omitted → legacy auto-rule (online-paid →
          // bank, everything else → available balance).
          refundMethod: z.enum(["razorpay", "balance"]).optional(),
        })
        .parse(request.body);

      const [order] = await pgClient`
        SELECT o.id, o.status,
               (COALESCE(
                  (o.delivery_date + tw.close_time) AT TIME ZONE 'Asia/Kolkata',
                  ((o.delivery_date + 1)::timestamp) AT TIME ZONE 'Asia/Kolkata'
                ) > now()) AS window_open
          FROM orders o
          JOIN dealers d ON d.id = o.dealer_id
          LEFT JOIN LATERAL (
            SELECT close_time FROM time_windows tw
             WHERE tw.route_id = d.route_id
             ORDER BY close_time DESC LIMIT 1
          ) tw ON true
         WHERE o.id = ${id}
         LIMIT 1
      `;
      if (!order) return reply.status(404).send({ error: "Order not found" });
      if (order.status === "cancelled")
        return reply.status(400).send({ error: "Order is already cancelled" });
      if (order.status === "delivered")
        return reply.status(400).send({ error: "A delivered order cannot be cancelled" });
      if (!["confirmed", "dispatched", "payment_required"].includes(order.status))
        return reply.status(400).send({
          error: "Cannot cancel",
          message: `An order in '${order.status}' state cannot be cancelled`,
        });
      // Only cancellable while the delivery window is still open — today
      // (not yet closed) and future dates. Past orders cannot be cancelled.
      if (!order.window_open)
        return reply.status(400).send({
          error: "Window closed",
          message: "This order's cancellation window has closed — past orders cannot be cancelled.",
        });

      try {
        const summary = await adminCancelOrder(id, body.reason, request.admin!.userId, body.refundMethod);
        return reply.send({ message: "Order cancelled", orderId: id, ...summary });
      } catch (err) {
        if (err instanceof RefundError)
          return reply.status(err.statusCode).send({ error: err.message });
        throw err;
      }
    }
  );

  // PATCH /api/v1/orders/:id/items
  app.patch(
    "/api/v1/orders/:id/items",
    { preHandler: [adminAuth, requireRole("orders.create")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        items: z.array(z.object({
          productId: z.string().uuid(),
          quantity:  z.number().int().min(0),
        })).min(1),
      });
      const body = schema.parse(request.body);

      const [existing] = await pgClient`
        SELECT id, dealer_id, status, payment_mode, grand_total, created_at
        FROM orders WHERE id = ${id} FOR UPDATE
      `;
      if (!existing) return reply.status(404).send({ error: "Order not found" });
      if (existing.status !== "confirmed") {
        return reply.status(409).send({ error: `Cannot modify ${existing.status} order` });
      }

      // Milk order minimum (≥12 L; curd has no minimum) over the lines being kept.
      const modMinQtyViolations = await findMinQtyViolations(
        body.items.filter((i) => i.quantity > 0)
      );
      if (modMinQtyViolations.length > 0) {
        return reply.status(400).send({
          error: "Minimum order quantity",
          message: minQtyErrorMessage(modMinQtyViolations),
          violations: modMinQtyViolations,
        });
      }

      const productIds = body.items.filter(i => i.quantity > 0).map(i => i.productId);
      const productRows = productIds.length
        ? await pgClient`SELECT id, name, base_price, gst_percent, stock FROM products WHERE id = ANY(${productIds}::uuid[])`
        : [];
      const productMap = new Map(productRows.map((p: any) => [p.id, p]));

      let newSubtotal = 0, newGst = 0;
      const newLines: any[] = [];
      for (const item of body.items) {
        if (item.quantity === 0) continue;
        const p = productMap.get(item.productId);
        if (!p) return reply.status(400).send({ error: `Product ${item.productId} not found` });
        const price = parseFloat(p.base_price);
        const gstPct = parseFloat(p.gst_percent);
        const lineSub = price * item.quantity;
        const lineGst = lineSub * (gstPct / 100);
        newSubtotal += lineSub; newGst += lineGst;
        newLines.push({
          productId: item.productId,
          productName: p.name,
          quantity: item.quantity,
          unitPrice: price.toFixed(2),
          gstPercent: gstPct.toFixed(2),
          gstAmount: lineGst.toFixed(2),
          lineTotal: (lineSub + lineGst).toFixed(2)
        });
      }
      const newGrandTotal = newSubtotal + newGst;
      const oldGrandTotal = parseFloat(existing.grand_total);
      const delta = newGrandTotal - oldGrandTotal;

      // ── Credit gate (prepaid model) ──────────────────────────────────
      // An UPWARD change on a credit order posts an extra debit of `delta`.
      // That extra must fit within the dealer's available balance — which
      // already reflects THIS order's original debit — so `delta <=
      // available`. Hard block: the increase is refused when the balance is
      // short (no override from this screen). Downward changes (delta <= 0)
      // refund to the balance and are never blocked.
      if (existing.payment_mode === "credit" && delta > 0) {
        const credit = await checkDealerCredit(existing.dealer_id, delta);
        if (!credit.sufficient) {
          return reply.status(402).send({
            error: "Insufficient available balance",
            message:
              `This change raises the indent by ₹${delta.toFixed(2)}, but the dealer only ` +
              `has ₹${credit.available.toFixed(2)} available (short by ₹${credit.shortfall.toFixed(2)}). ` +
              `Reduce quantities or top up the dealer's balance first.`,
            credit,
            delta: Number(delta.toFixed(2)),
          });
        }
      }

      const oldItems = await pgClient`SELECT product_id, quantity FROM order_items WHERE order_id = ${id}`;

      // Same TransactionSql cast as in the POST handler — Omit<Sql,...> drops call signatures.                                                 
      await pgClient.begin(async (_tx) => {                                 
        const tx = _tx as unknown as typeof pgClient; 
        
        for (const oi of oldItems) {
          await tx`UPDATE products SET stock = stock + ${oi.quantity}, updated_at = now() WHERE id = ${oi.product_id}`;
        }
        await tx`DELETE FROM order_items WHERE order_id = ${id}`;
        for (const li of newLines) {
          await tx`INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total)
                   VALUES (${id}, ${li.productId}, ${li.productName}, ${li.quantity},
                           ${li.unitPrice}::numeric, ${li.gstPercent}::numeric, ${li.gstAmount}::numeric, ${li.lineTotal}::numeric)`;
          await tx`UPDATE products SET stock = stock - ${li.quantity}, updated_at = now() WHERE id = ${li.productId}`;
        }
        await tx`UPDATE orders SET subtotal = ${newSubtotal.toFixed(2)}::numeric,
                                    total_gst = ${newGst.toFixed(2)}::numeric,
                                    grand_total = ${newGrandTotal.toFixed(2)}::numeric,
                                    item_count = ${newLines.length},
                                    updated_at = now()
                  WHERE id = ${id}`;

        if (existing.payment_mode === "wallet" && delta !== 0) {
          if (delta > 0) {
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

        if (existing.payment_mode === "credit" && delta !== 0) {
          // For credit orders, only the ledger needs adjusting — the
          // running balance reflects updated outstanding.
          const [bal] = await tx`
            SELECT
              COALESCE(d.opening_balance, 0)
              + COALESCE((SELECT SUM(CASE WHEN dl.type='credit'
                                            AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                          THEN dl.amount ELSE 0 END) FROM dealer_ledger dl
                          WHERE dl.dealer_id = d.id), 0)
              - COALESCE((SELECT SUM(CASE WHEN dl.type='debit'
                                            AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                          THEN dl.amount ELSE 0 END) FROM dealer_ledger dl
                          WHERE dl.dealer_id = d.id), 0)
              AS bal
            FROM dealers d WHERE d.id = ${existing.dealer_id}
          `;
          if (delta > 0) {
            const balanceAfter = (parseFloat(bal!.bal) - delta);
            await tx`
              INSERT INTO dealer_ledger
                (dealer_id, type, amount, reference_id, reference_type,
                 voucher_type, voucher_date,
                 description, balance_after, performed_by)
              VALUES
                (${existing.dealer_id}, 'debit', ${delta.toFixed(2)}::numeric, ${id},
                 'adjustment',
                 'Adjustment', now()::date,
                 ${'Modify credit order ' + id},
                 ${balanceAfter.toFixed(2)}::numeric, ${request.admin!.userId})
            `;
          } else {
            const refund = Math.abs(delta);
            const balanceAfter = (parseFloat(bal!.bal) + refund);
            await tx`
              INSERT INTO dealer_ledger
                (dealer_id, type, amount, reference_id, reference_type,
                 voucher_type, voucher_date,
                 description, balance_after, performed_by)
              VALUES
                (${existing.dealer_id}, 'credit', ${refund.toFixed(2)}::numeric, ${id},
                 'adjustment',
                 'Adjustment', now()::date,
                 ${'Modify credit refund ' + id},
                 ${balanceAfter.toFixed(2)}::numeric, ${request.admin!.userId})
            `;
          }
        }
      });

      const items = await pgClient`SELECT product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total FROM order_items WHERE order_id = ${id} ORDER BY product_name`;

      // Recompute credit AFTER the adjustment posts so the Modify screen can
      // show the dealer's new available balance without a second round-trip.
      let credit = null;
      if (existing.payment_mode === "credit") {
        try { credit = await checkDealerCredit(existing.dealer_id, 0); } catch { credit = null; }
      }

      return reply.send({
        message: "Order modified successfully",
        order: { id, subtotal: newSubtotal.toFixed(2), totalGst: newGst.toFixed(2), grandTotal: newGrandTotal.toFixed(2), itemCount: newLines.length, items },
        delta: Number(delta.toFixed(2)),
        credit,
      });
    }
  );

  // GET /api/v1/dealer/invoices/by-order/:orderId
  // Returns the invoice metadata + an HTTPS URL the mobile can open in
  // a browser. The URL is signed and self-contained (10 min TTL).
  app.get(
    "/api/v1/dealer/invoices/by-order/:orderId",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const { orderId } = request.params as { orderId: string };
      const dealerId = request.dealer!.dealerId;

      // Verify ownership BEFORE generating
      const [order] = await pgClient`
        SELECT id, dealer_id, status FROM orders WHERE id = ${orderId} LIMIT 1
      `;
      if (!order) return reply.status(404).send({ error: "Order not found" });
      if (order.dealer_id !== dealerId) {
        return reply.status(403).send({ error: "Not your order" });
      }

      // Make sure an invoice row exists. If pdf_url isn't set (no R2),
      // we don't care — the public endpoint regenerates on demand.
      let [inv] = await pgClient`
        SELECT id, invoice_number, pdf_url, total_amount
        FROM invoices WHERE order_id = ${orderId} LIMIT 1
      `;

      if (!inv) {
        // No invoice yet. Only a PLACED order (confirmed/dispatched/
        // delivered) is a tax document — a draft or payment_required order
        // must never have one minted on demand. (This is also why the
        // dealer app hides the Invoice action for unconfirmed orders.)
        if (!["confirmed", "dispatched", "delivered"].includes(order.status)) {
          return reply.status(409).send({
            error: "Invoice not available",
            message: "This order isn't confirmed yet, so it has no invoice.",
          });
        }
        try {
          await generateInvoicePdfSync(orderId);
          [inv] = await pgClient`
            SELECT id, invoice_number, pdf_url, total_amount
            FROM invoices WHERE order_id = ${orderId} LIMIT 1
          `;
        } catch (err) {
          console.error("[invoice] generate-on-demand failed:", err);
          return reply.status(500).send({ error: "Could not generate invoice" });
        }
      }

      // Build the openable URL.
      // - If R2 served us a real public URL, prefer that.
      // - Otherwise, return our own /public/invoice-pdf endpoint with a
      //   signed token. The mobile's API_BASE prefix is added client-side.
      const externalUrl = inv?.pdf_url && !inv.pdf_url.startsWith("data:")
        ? inv.pdf_url
        : null;

      const token = signInvoicePdfToken({ orderId, dealerId });
      const apiPath = `/api/v1/public/invoice-pdf?token=${encodeURIComponent(token)}`;

      return reply.send({
        invoice: {
          id: inv?.id,
          invoice_number: inv?.invoice_number,
          total_amount: inv?.total_amount,
        },
        // openableUrl is what the mobile actually opens. apiPath is a
        // relative path; the mobile prefixes API_BASE. externalUrl is
        // already absolute when present.
        openableUrl: externalUrl,
        apiPath: externalUrl ? null : apiPath,
      });
    }
  );

  // GET /api/v1/dealer/invoices/bulk?orderIds=id1,id2,id3
  // Returns a token-signed URL the mobile can open. The URL serves a
  // single PDF containing each requested invoice in order.
  app.get(
    "/api/v1/dealer/invoices/bulk",
    { preHandler: [dealerAuth] },
    async (request, reply) => {
      const dealerId = request.dealer!.dealerId;
      const query = request.query as { orderIds?: string };
      const orderIds = (query.orderIds ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);

      if (orderIds.length === 0) {
        return reply.status(400).send({ error: "No orders specified" });
      }
      if (orderIds.length > 50) {
        return reply.status(400).send({ error: "Too many invoices in one bundle (max 50)" });
      }

      // Verify every requested order belongs to this dealer
      const owned = await pgClient`
        SELECT id FROM orders
        WHERE id = ANY(${orderIds}::uuid[])
          AND dealer_id = ${dealerId}
      `;
      if (owned.length !== orderIds.length) {
        return reply.status(403).send({ error: "Some orders are not yours" });
      }

      // Build one signed token that covers the whole bundle
      const token = jwt.sign(
        { kind: "invoice-bulk", dealerId, orderIds },
        process.env.JWT_SECRET as string,
        { expiresIn: "10m" }
      );
      return reply.send({
        apiPath: `/api/v1/public/invoice-bulk-pdf?token=${encodeURIComponent(token)}`,
      });
    }
  );

  // ════════════════════════════════════════════════════════════════
  // PUBLIC INVOICE PDF — token-gated, no Bearer auth.
  // Designed to be opened directly in a mobile browser via Linking.openURL.
  // The token is short-lived (10 min) and bound to a specific orderId+dealerId.
  // ════════════════════════════════════════════════════════════════
  app.get(
    "/api/v1/public/invoice-pdf",
    async (request, reply) => {
      const query = request.query as { token?: string };
      if (!query.token) {
        return reply.status(401).send({ error: "Token required" });
      }

      let payload;
      try {
        payload = verifyInvoicePdfToken(query.token);
      } catch (err) {
        return reply.status(401).send({ error: "Invalid or expired token" });
      }

      // Verify the order still belongs to the encoded dealer
      const [order] = await pgClient`
        SELECT id, dealer_id FROM orders WHERE id = ${payload.orderId} LIMIT 1
      `;
      if (!order || order.dealer_id !== payload.dealerId) {
        return reply.status(404).send({ error: "Invoice not found" });
      }

      // Always regenerate. Cheap with pdf-lib and avoids stale rows.
      let result;
      try {
        result = await generateInvoicePdfSync(payload.orderId);
      } catch (err) {
        console.error("[public-pdf] generation failed:", err);
        return reply.status(500).send({ error: "Could not render invoice" });
      }

      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition",
          `inline; filename="${result.invoiceNumber}.pdf"`)
        .header("Cache-Control", "private, max-age=600")
        .send(Buffer.from(result.pdfBytes));
    }
  );

  // Public endpoint — no auth, validates token from query
  app.get(
    "/api/v1/public/invoice-bulk-pdf",
    async (request, reply) => {
      const query = request.query as { token?: string };
      if (!query.token) return reply.status(401).send({ error: "Token required" });

      let payload;
      try {
        payload = jwt.verify(query.token, process.env.JWT_SECRET as string) as {
          kind: string;
          dealerId: string;
          orderIds: string[];
        };
      } catch {
        return reply.status(401).send({ error: "Invalid or expired token" });
      }
      if (payload.kind !== "invoice-bulk") {
        return reply.status(401).send({ error: "Wrong token kind" });
      }

      // Generate each invoice's PDF and merge.
      const merged = await PDFDocument.create();
      for (const orderId of payload.orderIds) {
        try {
          const { pdfBytes } = await generateInvoicePdfSync(orderId);
          const single = await PDFDocument.load(pdfBytes);
          const pages = await merged.copyPages(single, single.getPageIndices());
          for (const p of pages) merged.addPage(p);
        } catch (err) {
          console.warn(`[bulk-pdf] skipped ${orderId}:`, err);
          // Skip individual failures — better to return what we can.
        }
      }
      const out = await merged.save();
      return reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition",
          `inline; filename="invoices-${new Date().toISOString().slice(0,10)}.pdf"`)
        .send(Buffer.from(out));
    }
  );

  // POST /api/v1/admin/invoices/backfill
  // Enqueues invoice generation for every confirmed/dispatched/delivered
  // order that has no invoice row yet. Safe to run multiple times — the
  // pdf-invoice worker uses ON CONFLICT DO UPDATE so duplicates are harmless.
  app.post(
    "/api/v1/admin/invoices/backfill",
    { preHandler: [adminAuth, requireRole("orders.update")] },
    async (_request, reply) => {
      // Every confirmed/dispatched/delivered order should have an invoice
      // — including online (upi) ones, which only reach 'confirmed' AFTER
      // payment is captured, so they're genuinely paid. (The old query
      // excluded upi back when online invoices were on-demand only; pay-now
      // now enqueues one at capture, so a missing-upi invoice is just a
      // pre-fix gap to recover here.)
      const missing = await pgClient`
        SELECT o.id::text AS id
        FROM orders o
        WHERE o.status IN ('confirmed', 'dispatched', 'delivered')
          AND NOT EXISTS (
            SELECT 1 FROM invoices i WHERE i.order_id = o.id
          )
        ORDER BY o.delivery_date DESC
      `;

      let enqueued = 0;
      for (const row of missing) {
        try {
          await enqueuePDFInvoice(row.id);
          enqueued++;
        } catch {
          // logged inside enqueuePDFInvoice
        }
      }

      return reply.send({ total: missing.length, enqueued });
    }
  );
}