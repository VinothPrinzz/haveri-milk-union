import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";
import { enqueuePDFInvoice, enqueuePushNotification } from "../lib/queue.js";
import { generateInvoicePdfSync } from "../lib/invoice-pdf.js";

export async function financeRoutes(app: FastifyInstance) {
  // ═══ INVOICES ═══

  // GET /api/v1/invoices
  app.get(
    "/api/v1/invoices",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        dealer:        z.string().optional(),
        dateFrom:      z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        dateTo:        z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        routeId:       z.string().uuid().optional(),
        paymentStatus: z.enum(["paid","unpaid","partial"]).optional(),
        search:        z.string().optional(),  // matches invoice_number too
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);
   
      const dealerSearch  = q.dealer ? `%${q.dealer}%` : null;
      const generalSearch = q.search ? `%${q.search}%` : null;
      const dateFrom      = q.dateFrom ?? null;
      const dateTo        = q.dateTo   ? q.dateTo + "T23:59:59Z" : null;
      const routeId       = q.routeId  ?? null;
      const status        = q.paymentStatus ?? null;
   
      const rows = await pgClient`
        SELECT
          i.id,
          i.invoice_number         AS "invoiceNumber",
          i.order_id               AS "orderId",
          i.invoice_date           AS "invoiceDate",
          i.due_date               AS "dueDate",
          i.taxable_amount         AS "taxableAmount",
          i.cgst,
          i.sgst,
          i.total_tax              AS "totalTax",
          i.total_amount           AS "totalAmount",
          i.paid_amount            AS "paidAmount",
          i.payment_status         AS "paymentStatus",
          i.pdf_url                AS "pdfUrl",
          i.dealer_name            AS "dealerName",
          i.dealer_gst_number      AS "dealerGstNumber",
          d.id                     AS "dealerId",
          d.code                   AS "dealerCode",
          i.route_id               AS "routeId",
          r.code                   AS "routeCode",
          r.name                   AS "routeName",
          o.payment_mode           AS "paymentMode",
          o.item_count             AS "itemCount",
          -- Overdue days: only for unpaid/partial with a due_date in the past
          CASE
            WHEN i.payment_status <> 'paid' AND i.due_date IS NOT NULL
            THEN GREATEST(0, (CURRENT_DATE - i.due_date))
            ELSE 0
          END                      AS "overdueDays"
        FROM invoices i
        JOIN dealers d       ON d.id = i.dealer_id
        LEFT JOIN orders o   ON o.id = i.order_id
        LEFT JOIN routes r   ON r.id = i.route_id
        WHERE (${dealerSearch}::text  IS NULL OR d.name ILIKE ${dealerSearch ?? ''})
          AND (${generalSearch}::text IS NULL OR
               d.name ILIKE ${generalSearch ?? ''} OR
               i.invoice_number ILIKE ${generalSearch ?? ''})
          AND (${dateFrom}::timestamptz IS NULL OR i.invoice_date >= ${dateFrom ?? '1970-01-01'}::timestamptz)
          AND (${dateTo}::timestamptz   IS NULL OR i.invoice_date <= ${dateTo   ?? '2099-12-31'}::timestamptz)
          AND (${routeId}::uuid IS NULL OR i.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${status}::text  IS NULL OR i.payment_status = ${status ?? 'unpaid'})
        ORDER BY i.invoice_date DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;
   
      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM invoices i
        JOIN dealers d ON d.id = i.dealer_id
        WHERE (${dealerSearch}::text  IS NULL OR d.name ILIKE ${dealerSearch ?? ''})
          AND (${generalSearch}::text IS NULL OR
               d.name ILIKE ${generalSearch ?? ''} OR
               i.invoice_number ILIKE ${generalSearch ?? ''})
          AND (${dateFrom}::timestamptz IS NULL OR i.invoice_date >= ${dateFrom ?? '1970-01-01'}::timestamptz)
          AND (${dateTo}::timestamptz   IS NULL OR i.invoice_date <= ${dateTo   ?? '2099-12-31'}::timestamptz)
          AND (${routeId}::uuid IS NULL OR i.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${status}::text  IS NULL OR i.payment_status = ${status ?? 'unpaid'})
      `;
   
      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // GET /api/v1/invoices/:id — invoice detail with order items
  app.get(
    "/api/v1/invoices/:id",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
   
      const [invoice] = await pgClient`
        SELECT
          i.id,
          i.invoice_number      AS "invoiceNumber",
          i.order_id            AS "orderId",
          i.invoice_date        AS "invoiceDate",
          i.due_date            AS "dueDate",
          i.taxable_amount      AS "taxableAmount",
          i.cgst,
          i.sgst,
          i.total_tax           AS "totalTax",
          i.total_amount        AS "totalAmount",
          i.paid_amount         AS "paidAmount",
          i.payment_status      AS "paymentStatus",
          i.pdf_url             AS "pdfUrl",
          i.dealer_name         AS "dealerName",
          i.dealer_gst_number   AS "dealerGstNumber",
          i.dealer_address      AS "dealerAddressSnapshot",
          i.route_id            AS "routeId",
          o.status              AS "orderStatus",
          o.payment_mode        AS "paymentMode",
          o.item_count          AS "itemCount",
          o.subtotal            AS "orderSubtotal",
          o.total_gst           AS "orderTotalGst",
          o.grand_total         AS "orderGrandTotal",
          -- Dealer block (live, not snapshot — use dealer_* fields on
          -- invoice itself for GST number / name at invoice time)
          d.id                  AS "dealerId",
          d.code                AS "dealerCode",
          d.name                AS "currentDealerName",
          d.phone               AS "dealerPhone",
          d.gst_number          AS "dealerCurrentGst",
          d.address             AS "dealerAddress",
          d.city                AS "dealerCity",
          d.state               AS "dealerState",
          d.pin_code            AS "dealerPincode",
          -- Route block
          r.code                AS "routeCode",
          r.name                AS "routeName"
        FROM invoices i
        JOIN dealers d     ON d.id = i.dealer_id
        LEFT JOIN orders o ON o.id = i.order_id
        LEFT JOIN routes r ON r.id = i.route_id
        WHERE i.id = ${id}
        LIMIT 1
      `;
      if (!invoice) return reply.status(404).send({ error: "Invoice not found" });
   
      // Line items with HSN + pack size from products (fallbacks for
      // products that have been soft-deleted since the order).
      const items = await pgClient`
        SELECT
          oi.product_id     AS "productId",
          oi.product_name   AS "productName",
          COALESCE(p.hsn_no, '')      AS "hsnNo",
          COALESCE(p.pack_size::text, '') AS "packSize",
          oi.quantity,
          oi.unit_price     AS "unitPrice",
          oi.gst_percent    AS "gstPercent",
          -- CGST/SGST split = half each of total GST
          (oi.gst_amount / 2)::numeric(10,2) AS "cgstAmount",
          (oi.gst_amount / 2)::numeric(10,2) AS "sgstAmount",
          (oi.gst_percent / 2)::numeric(5,2) AS "cgstPercent",
          (oi.gst_percent / 2)::numeric(5,2) AS "sgstPercent",
          oi.gst_amount     AS "gstAmount",
          oi.line_total     AS "lineTotal",
          -- Basic = line subtotal before GST
          (oi.quantity * oi.unit_price)::numeric(10,2) AS "basic"
        FROM order_items oi
        LEFT JOIN products p ON p.id = oi.product_id
        WHERE oi.order_id = ${(invoice as any).orderId}
        ORDER BY oi.product_name
      `;
   
      // Payments recorded against this invoice (may be empty).
      const payments = await pgClient`
        SELECT
          id,
          received_date    AS "receivedDate",
          amount,
          mode,
          reference,
          notes,
          created_at       AS "createdAt"
        FROM payments
        WHERE invoice_id = ${id}
        ORDER BY received_date DESC, created_at DESC
      `;
   
      return reply.send({ invoice, items, payments });
    }
  );

  // ═══ REPORTS ═══

  // GET /api/v1/reports/sales
  app.get(
    "/api/v1/reports/sales",
    { preHandler: [adminAuth, requireRole("reports.view")] },
    async (request, reply) => {
      const schema = z.object({ dateFrom: z.string().optional(), dateTo: z.string().optional() });
      const query = schema.parse(request.query);

      const [summary] = await pgClient`
        SELECT count(*)::int AS total_orders,
               COALESCE(sum(grand_total), 0)::numeric AS total_revenue,
               COALESCE(avg(grand_total), 0)::numeric AS avg_order_value
        FROM orders WHERE status != 'cancelled'
      `;

      const [dealerCount] = await pgClient`SELECT count(*)::int AS count FROM dealers WHERE active = true AND deleted_at IS NULL`;

      const zoneRevenue = await pgClient`
        SELECT z.name AS zone_name, z.slug, count(o.id)::int AS orders,
               COALESCE(sum(o.grand_total), 0)::numeric AS revenue
        FROM zones z
        LEFT JOIN orders o ON o.zone_id = z.id AND o.status != 'cancelled'
        GROUP BY z.id, z.name, z.slug ORDER BY revenue DESC
      `;

      const topDealers = await pgClient`
        SELECT d.name, z.name AS zone_name, count(o.id)::int AS orders,
               COALESCE(sum(o.grand_total), 0)::numeric AS revenue,
               COALESCE(avg(o.grand_total), 0)::numeric AS avg_order,
               COALESCE(w.balance, 0)::numeric AS wallet_balance
        FROM dealers d
        JOIN zones z ON z.id = d.zone_id
        LEFT JOIN orders o ON o.dealer_id = d.id AND o.status != 'cancelled'
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        WHERE d.deleted_at IS NULL
        GROUP BY d.id, d.name, z.name, w.balance
        ORDER BY revenue DESC LIMIT 10
      `;

      return reply.send({
        summary: { ...summary, activeDealers: dealerCount?.count ?? 0 },
        zoneRevenue,
        topDealers,
      });
    }
  );

  // GET /api/v1/reports/dealer-wise
  app.get(
    "/api/v1/reports/dealer-wise",
    { preHandler: [adminAuth, requireRole("reports.view")] },
    async (request, reply) => {
      const rows = await pgClient`
        SELECT d.name, z.name AS zone_name, count(o.id)::int AS orders,
               COALESCE(sum(o.grand_total), 0)::numeric AS revenue,
               COALESCE(avg(o.grand_total), 0)::numeric AS avg_order,
               COALESCE(w.balance, 0)::numeric AS wallet_balance
        FROM dealers d
        JOIN zones z ON z.id = d.zone_id
        LEFT JOIN orders o ON o.dealer_id = d.id AND o.status != 'cancelled'
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        WHERE d.deleted_at IS NULL
        GROUP BY d.id, d.name, z.name, w.balance
        ORDER BY revenue DESC
      `;
      return reply.send({ data: rows });
    }
  );

  // GET /api/v1/reports/dispatch
  app.get(
    "/api/v1/reports/dispatch",
    { preHandler: [adminAuth, requireRole("reports.view")] },
    async (request, reply) => {
      const rows = await pgClient`
        SELECT r.name AS route_name, count(ra.id)::int AS trips,
               avg(ra.dealer_count)::int AS avg_dealers,
               sum(ra.item_count)::int AS total_crates,
               count(CASE WHEN ra.status = 'dispatched' OR ra.status = 'delivered' THEN 1 END)::int AS completed
        FROM routes r
        LEFT JOIN route_assignments ra ON ra.route_id = r.id
        WHERE r.deleted_at IS NULL
        GROUP BY r.id, r.name ORDER BY r.name
      `;
      return reply.send({ data: rows });
    }
  );

  // GET /api/v1/reports/zone-revenue
  app.get(
    "/api/v1/reports/zone-revenue",
    { preHandler: [adminAuth, requireRole("reports.view")] },
    async (request, reply) => {
      const rows = await pgClient`
        SELECT z.name, z.slug, z.icon, z.color,
               count(DISTINCT d.id)::int AS dealer_count,
               count(o.id)::int AS order_count,
               COALESCE(sum(o.grand_total), 0)::numeric AS revenue
        FROM zones z
        LEFT JOIN dealers d ON d.zone_id = z.id AND d.deleted_at IS NULL
        LEFT JOIN orders o ON o.zone_id = z.id AND o.status != 'cancelled'
        WHERE z.active = true
        GROUP BY z.id, z.name, z.slug, z.icon, z.color
        ORDER BY revenue DESC
      `;
      const totalRevenue = rows.reduce((a: number, r: any) => a + parseFloat(r.revenue), 0);
      return reply.send({ data: rows.map((r: any) => ({ ...r, percentage: totalRevenue > 0 ? Math.round((parseFloat(r.revenue) / totalRevenue) * 100) : 0 })) });
    }
  );

  // GET /api/v1/reports/fgs-movement
  app.get(
    "/api/v1/reports/fgs-movement",
    { preHandler: [adminAuth, requireRole("reports.view")] },
    async (request, reply) => {
      const schema = z.object({ dateFrom: z.string().optional(), dateTo: z.string().optional() });
      const query = schema.parse(request.query);
      const targetDate = (query.dateFrom ?? new Date().toISOString().split("T")[0]) as string;

      const rows = await pgClient`
        SELECT p.id, p.name, p.icon, c.name AS category_name,
               COALESCE(f.opening, p.stock) AS opening,
               COALESCE(f.received, 0) AS received,
               COALESCE(f.dispatched, 0) AS dispatched,
               COALESCE(f.wastage, 0) AS wastage,
               COALESCE(f.closing, p.stock) AS closing
        FROM products p
        JOIN categories c ON c.id = p.category_id
        LEFT JOIN fgs_stock_log f ON f.product_id = p.id AND f.date = ${targetDate}::date
        WHERE p.deleted_at IS NULL
        ORDER BY p.sort_order
      `;
      return reply.send({ data: rows });
    }
  );

  // ═══ ADMIN-PLACED ORDERS (Call Desk) ═══

  // POST /api/v1/orders/admin-place — place order on behalf of a dealer
  app.post(
    "/api/v1/orders/admin-place",
    { preHandler: [adminAuth, requireRole("orders.create")] },
    async (request, reply) => {
      const schema = z.object({
        dealerId: z.string().uuid(),
        items: z.array(z.object({ productId: z.string().uuid(), quantity: z.number().int().min(1) })).min(1),
        paymentMode: z.enum(["wallet", "upi", "credit"]).default("wallet"),
      });
      const body = schema.parse(request.body);

      // Get dealer zone
      const [dealer] = await pgClient`SELECT id, zone_id FROM dealers WHERE id = ${body.dealerId} AND deleted_at IS NULL`;
      if (!dealer) return reply.status(404).send({ error: "Dealer not found" });

      // Get products
      const productRows = await pgClient`SELECT id, name, base_price, gst_percent, stock, available FROM products WHERE id = ANY(${body.items.map(i => i.productId)}::uuid[])`;
      const productMap = new Map(productRows.map((p: any) => [p.id, p]));

      // Validate + calculate
      let subtotal = 0, totalGst = 0;
      const orderItemsData: any[] = [];
      for (const item of body.items) {
        const product = productMap.get(item.productId);
        if (!product) return reply.status(400).send({ error: `Product ${item.productId} not found` });
        if (!product.available) return reply.status(400).send({ error: `${product.name} unavailable` });
        if (product.stock < item.quantity) return reply.status(400).send({ error: `${product.name}: only ${product.stock} in stock` });
        const price = parseFloat(product.base_price), gstPct = parseFloat(product.gst_percent);
        const lineSub = price * item.quantity, lineGst = lineSub * (gstPct / 100);
        subtotal += lineSub; totalGst += lineGst;
        orderItemsData.push({ 
          productId: item.productId, 
          productName: product.name, 
          quantity: item.quantity, 
          unitPrice: price.toFixed(2), 
          gstPercent: gstPct.toFixed(2), 
          gstAmount: lineGst.toFixed(2), 
          lineTotal: (lineSub + lineGst).toFixed(2) 
        });
      }
      const grandTotal = subtotal + totalGst;

      // Wallet deduction if applicable
      if (body.paymentMode === "wallet") {
        const result = await pgClient`UPDATE dealer_wallets SET balance = balance - ${grandTotal.toFixed(2)}::numeric, updated_at = now() WHERE dealer_id = ${body.dealerId} AND balance >= ${grandTotal.toFixed(2)}::numeric RETURNING balance`;
        if (result.length === 0) return reply.status(402).send({ error: "Insufficient wallet balance" });
      }

      try {
        const result = await pgClient.begin(async (tx) => {
          const [order] = await tx`
            INSERT INTO orders (dealer_id, zone_id, status, payment_mode, subtotal, total_gst, grand_total, item_count, placed_by, created_at, updated_at)
            VALUES (${body.dealerId}, ${dealer.zone_id}, 'pending', ${body.paymentMode}, ${subtotal.toFixed(2)}::numeric, ${totalGst.toFixed(2)}::numeric, ${grandTotal.toFixed(2)}::numeric, ${orderItemsData.length}, ${request.admin!.userId}, now(), now())
            RETURNING id, created_at
          `;
          for (const item of orderItemsData) {
            await tx`INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total) VALUES (${order!.id}, ${item.productId}, ${item.productName}, ${item.quantity}, ${item.unitPrice}::numeric, ${item.gstPercent}::numeric, ${item.gstAmount}::numeric, ${item.lineTotal}::numeric)`;
          }
          for (const item of body.items) {
            await tx`UPDATE products SET stock = stock - ${item.quantity}, updated_at = now() WHERE id = ${item.productId}`;
          }
          if (body.paymentMode === "wallet") {
            const [w] = await tx`SELECT balance FROM dealer_wallets WHERE dealer_id = ${body.dealerId}`;
            await tx`INSERT INTO dealer_ledger (dealer_id, type, amount, reference_id, reference_type, description, balance_after, performed_by) VALUES (${body.dealerId}, 'debit', ${grandTotal.toFixed(2)}::numeric, ${order!.id}, 'order', ${"Call Desk order " + order!.id}, ${w!.balance}::numeric, ${request.admin!.userId})`;
          }
          return order;
        });

        // ── Auto-generate GST Invoice + Push Notification ──
        try {
          await enqueuePDFInvoice(result.id);
        } catch (err) {
          console.warn("[orders] PDF enqueue failed:", err);
        }

        try {
          await enqueuePushNotification({
            event: "order.confirmed",
            dealerId: body.dealerId,
            orderId: result.id,
          });
        } catch (err) {
          console.warn("[orders] Push enqueue failed:", err);
        }

        // === SYNCHRONOUS INVOICE GENERATION (as requested) ===
        let invoiceNumber: string | null = null;
        let invoicePdfUrl: string | null = null;

        try {
          const pdfResult = await generateInvoicePdfSync(result!.id);

          // Extract the URL from the returned object
          invoicePdfUrl = pdfResult?.pdfUrl ??  null;

          const [inv] = await pgClient`
            SELECT invoice_number FROM invoices WHERE order_id = ${result!.id} LIMIT 1
          `;
          invoiceNumber = inv?.invoice_number ?? null;
        } catch (err) {
          console.error("[admin-place] Invoice generation failed:", err);
          // Order still succeeds
        }

        return reply.status(201).send({ 
          message: "Order placed successfully", 
          order: { 
            id: result!.id, 
            grandTotal: grandTotal.toFixed(2), 
            itemCount: orderItemsData.length 
          },
          invoiceNumber,
          invoicePdfUrl
        });
      } catch (err) {
        if (body.paymentMode === "wallet") {
          await pgClient`UPDATE dealer_wallets SET balance = balance + ${grandTotal.toFixed(2)}::numeric, updated_at = now() WHERE dealer_id = ${body.dealerId}`;
        }
        throw err;
      }
    }
  );

  // ═══ SETTLEMENTS ═══

  // GET /api/v1/settlements
  app.get(
    "/api/v1/settlements",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const query = paginationSchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
      const rows = await pgClient`
        SELECT id, settlement_date, total_amount, dealer_count, status, bank_reference, notes, processed_at, created_at
        FROM settlements ORDER BY settlement_date DESC
        LIMIT ${query.limit} OFFSET ${offset}
      `;
      const [countRow] = await pgClient`SELECT count(*)::int AS count FROM settlements`;
      return reply.send({ data: rows, ...paginationMeta(countRow?.count ?? 0, query.page, query.limit) });
    }
  );

  // ═══ OUTSTANDING / DUES ═══

  // GET /api/v1/outstanding
  app.get(
    "/api/v1/outstanding",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const rows = await pgClient`
        SELECT d.id, d.name, d.city, z.name AS zone_name,
               COALESCE(SUM(CASE WHEN o.status IN ('pending','confirmed','dispatched') THEN o.grand_total ELSE 0 END), 0)::numeric AS outstanding,
               COALESCE(SUM(CASE WHEN o.status = 'pending' AND o.created_at < now() - interval '3 days' THEN o.grand_total ELSE 0 END), 0)::numeric AS overdue,
               MAX(o.created_at) AS last_order_date,
               CASE
                 WHEN SUM(CASE WHEN o.status = 'pending' AND o.created_at < now() - interval '7 days' THEN 1 ELSE 0 END) > 0 THEN 'critical'
                 WHEN SUM(CASE WHEN o.status = 'pending' AND o.created_at < now() - interval '3 days' THEN 1 ELSE 0 END) > 0 THEN 'overdue'
                 ELSE 'current'
               END AS payment_status
        FROM dealers d
        JOIN zones z ON z.id = d.zone_id
        LEFT JOIN orders o ON o.dealer_id = d.id AND o.payment_mode = 'credit' AND o.status != 'cancelled'
        WHERE d.deleted_at IS NULL
        GROUP BY d.id, d.name, d.city, z.name
        HAVING SUM(CASE WHEN o.status IN ('pending','confirmed','dispatched') THEN o.grand_total ELSE 0 END) > 0
        ORDER BY outstanding DESC
      `;
      const totalOut = rows.reduce((a: number, r: any) => a + parseFloat(r.outstanding), 0);
      const totalOvd = rows.reduce((a: number, r: any) => a + parseFloat(r.overdue), 0);
      return reply.send({ data: rows, summary: { totalOutstanding: totalOut, totalOverdue: totalOvd } });
    }
  );

  // ═══ PAYMENT OVERVIEW ═══

  // ┌─────────────────────────────────────────────────┐
  // │   GET /api/v1/payments                            │
  // │   Payments Overview list                          │
  // └─────────────────────────────────────────────────┘
  app.get(
    "/api/v1/payments",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        dateFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        dateTo:   z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        mode:     z.enum(["cash","upi","cheque","neft","rtgs","credit","wallet"]).optional(),
        dealerId: z.string().uuid().optional(),
        search:   z.string().optional(),  // dealer name OR invoice number OR reference
      });
      const q = querySchema.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);
  
      const dateFrom = q.dateFrom ?? null;
      const dateTo   = q.dateTo   ?? null;
      const mode     = q.mode     ?? null;
      const dealerId = q.dealerId ?? null;
      const search   = q.search ? `%${q.search}%` : null;
  
      // Column order in the SELECT matches the UI spec:
      // Received date → Overdue → Customer → Mode → Reference → Amount → Invoice No.
      const rows = await pgClient`
        SELECT
          p.id,
          p.received_date                    AS "receivedDate",
          CASE
            WHEN i.due_date IS NOT NULL AND i.payment_status <> 'paid'
            THEN GREATEST(0, (p.received_date - i.due_date))
            ELSE 0
          END                                AS "overdueDays",
          d.id                               AS "dealerId",
          d.name                             AS "dealerName",
          d.code                             AS "dealerCode",
          p.mode,
          p.reference,
          p.amount,
          p.invoice_id                       AS "invoiceId",
          i.invoice_number                   AS "invoiceNumber",
          p.notes,
          u.name                             AS "receivedByName",
          p.created_at                       AS "createdAt"
        FROM payments p
        JOIN dealers d        ON d.id = p.dealer_id
        LEFT JOIN invoices i  ON i.id = p.invoice_id
        LEFT JOIN users u     ON u.id = p.received_by
        WHERE (${dateFrom}::date IS NULL OR p.received_date >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date   IS NULL OR p.received_date <= ${dateTo   ?? '9999-12-31'}::date)
          AND (${mode}::text     IS NULL OR p.mode = ${mode ?? 'cash'})
          AND (${dealerId}::uuid IS NULL OR p.dealer_id = ${dealerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${search}::text   IS NULL OR
              d.name ILIKE ${search ?? ''} OR
              i.invoice_number ILIKE ${search ?? ''} OR
              p.reference ILIKE ${search ?? ''})
        ORDER BY p.received_date DESC, p.created_at DESC
        LIMIT ${q.limit} OFFSET ${offset}
      `;
  
      const [countRow] = await pgClient`
        SELECT count(*)::int AS count
        FROM payments p
        JOIN dealers d        ON d.id = p.dealer_id
        LEFT JOIN invoices i  ON i.id = p.invoice_id
        WHERE (${dateFrom}::date IS NULL OR p.received_date >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date   IS NULL OR p.received_date <= ${dateTo   ?? '9999-12-31'}::date)
          AND (${mode}::text     IS NULL OR p.mode = ${mode ?? 'cash'})
          AND (${dealerId}::uuid IS NULL OR p.dealer_id = ${dealerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${search}::text   IS NULL OR
              d.name ILIKE ${search ?? ''} OR
              i.invoice_number ILIKE ${search ?? ''} OR
              p.reference ILIKE ${search ?? ''})
      `;
  
      // Summary for the page header strip.
      const [summary] = await pgClient`
        SELECT
          COALESCE(SUM(p.amount), 0)::numeric AS total_received,
          COUNT(*)::int                        AS total_count,
          COALESCE(SUM(CASE WHEN p.received_date = CURRENT_DATE
                            THEN p.amount ELSE 0 END), 0)::numeric AS received_today
        FROM payments p
        WHERE (${dateFrom}::date IS NULL OR p.received_date >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date   IS NULL OR p.received_date <= ${dateTo   ?? '9999-12-31'}::date)
          AND (${mode}::text     IS NULL OR p.mode = ${mode ?? 'cash'})
          AND (${dealerId}::uuid IS NULL OR p.dealer_id = ${dealerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
      `;
  
      return reply.send({
        data: rows,
        summary: {
          totalReceived:  parseFloat(summary?.total_received  ?? '0'),
          totalCount:     summary?.total_count ?? 0,
          receivedToday:  parseFloat(summary?.received_today  ?? '0'),
        },
        ...paginationMeta(countRow?.count ?? 0, q.page, q.limit),
      });
    }
  );
  
  
  // ┌─────────────────────────────────────────────────┐
  // │   POST /api/v1/payments                           │
  // │   Record a payment receipt                        │
  // └─────────────────────────────────────────────────┘
  app.post(
    "/api/v1/payments",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const schema = z.object({
        dealerId:     z.string().uuid(),
        amount:       z.number().positive(),
        mode:         z.enum(["cash","upi","cheque","neft","rtgs","credit","wallet"]),
        receivedDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        invoiceId:    z.string().uuid().optional().nullable(),
        reference:    z.string().optional(),
        notes:        z.string().optional(),
      });
      const body = schema.parse(request.body);
      const receivedDate = body.receivedDate ?? new Date().toISOString().slice(0, 10);
  
      // Validate dealer + fetch wallet balance (for ledger balance_after).
      const [dealer] = await pgClient`
        SELECT d.id, d.name, COALESCE(w.balance, 0)::numeric AS wallet_balance
        FROM dealers d
        LEFT JOIN dealer_wallets w ON w.dealer_id = d.id
        WHERE d.id = ${body.dealerId} AND d.deleted_at IS NULL
        LIMIT 1
      `;
      if (!dealer) return reply.status(404).send({ error: "Dealer not found" });
  
      // If invoice_id was given, validate it belongs to this dealer.
      let invoice: any = null;
      if (body.invoiceId) {
        const [row] = await pgClient`
          SELECT id, dealer_id, total_amount, paid_amount, payment_status, invoice_number
          FROM invoices WHERE id = ${body.invoiceId} LIMIT 1
        `;
        if (!row) return reply.status(404).send({ error: "Invoice not found" });
        if (row.dealer_id !== body.dealerId) {
          return reply.status(400).send({ error: "Invoice does not belong to this dealer" });
        }
        invoice = row;
      }
  
      try {
        const result = await pgClient.begin(async (tx) => {
          // (a) Insert payment row.
          const [payment] = await tx`
            INSERT INTO payments (
              dealer_id, received_date, amount, mode, reference,
              invoice_id, received_by, notes
            ) VALUES (
              ${body.dealerId},
              ${receivedDate}::date,
              ${body.amount.toFixed(2)}::numeric,
              ${body.mode},
              ${body.reference ?? null},
              ${body.invoiceId ?? null}::uuid,
              ${request.admin!.userId}::uuid,
              ${body.notes ?? null}
            )
            RETURNING id, received_date, amount, mode
          `;
  
          // (b) Append to dealer_ledger. voucher_type='Receipt'.
          // reference_type must be a ledger_ref_type enum value —
          // 'wallet_topup' for wallet-mode receipts (updates wallet),
          // 'adjustment' for everything else (on-account credits that
          // don't touch the wallet but do move dealer balance).
          const ledgerRefType =
            body.mode === "wallet" ? "wallet_topup" : "adjustment";
  
          // For wallet-mode receipts, also credit the wallet (keeps
          // parity with existing wallet top-up flow).
          let balanceAfter = parseFloat(dealer.wallet_balance);
          if (body.mode === "wallet") {
            const [w] = await tx`
              UPDATE dealer_wallets SET
                balance = balance + ${body.amount.toFixed(2)}::numeric,
                last_topup_at = now(),
                last_topup_amount = ${body.amount.toFixed(2)}::numeric,
                updated_at = now()
              WHERE dealer_id = ${body.dealerId}
              RETURNING balance
            `;
            if (w) balanceAfter = parseFloat(w.balance);
          } else {
            // For non-wallet receipts, the balance_after tracks the
            // dealer's running outstanding-vs-credit balance, not the
            // wallet. We store it as the wallet balance unchanged, and
            // the ledger reader uses the voucher-based running total
            // separately (see /ledger endpoint, which derives running
            // balance from ordered credits/debits — not from this
            // field — once voucher_type is present).
          }
  
          const voucherNo = invoice?.invoice_number
            ? `RC-${invoice.invoice_number}-${new Date(receivedDate).getTime().toString().slice(-6)}`
            : `RC-${payment.id.slice(0, 8).toUpperCase()}`;
  
          const particulars = invoice
            ? `Payment against ${invoice.invoice_number} (${body.mode.toUpperCase()})`
            : `On-account receipt (${body.mode.toUpperCase()})`;
  
          await tx`
            INSERT INTO dealer_ledger (
              dealer_id, type, amount,
              reference_id, reference_type,
              description, balance_after,
              performed_by,
              voucher_no, voucher_type, particulars, voucher_date
            ) VALUES (
              ${body.dealerId},
              'credit',
              ${body.amount.toFixed(2)}::numeric,
              ${payment.id}::uuid,
              ${ledgerRefType}::ledger_ref_type,
              ${particulars},
              ${balanceAfter.toFixed(2)}::numeric,
              ${request.admin!.userId}::uuid,
              ${voucherNo},
              'Receipt',
              ${particulars},
              ${receivedDate}::date
            )
          `;
  
          // (c) Update invoice payment_status if linked.
          if (invoice) {
            const newPaid = parseFloat(invoice.paid_amount) + body.amount;
            const newStatus =
              newPaid >= parseFloat(invoice.total_amount) ? 'paid'
            : newPaid > 0                                 ? 'partial'
            :                                               'unpaid';

            await tx`
              UPDATE invoices SET
                paid_amount    = ${newPaid.toFixed(2)}::numeric,
                payment_status = ${newStatus}
              WHERE id = ${body.invoiceId!}::uuid          -- ← Fixed here
            `;
          }
  
          return { payment, voucherNo };
        });
  
        return reply.status(201).send({
          message: "Payment recorded",
          ...result,
        });
      } catch (err) {
        request.log.error(err, "Record payment failed");
        throw err;
      }
    }
  );

  // GET /api/v1/payments/overview
  app.get(
    "/api/v1/payments/overview",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = z.object({
        search: z.string().optional(),
        method: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      });
      const query = querySchema.parse(request.query);
      const searchTerm = query.search ? `%${query.search}%` : null;
      const methodFilter = query.method ?? null;
      const dateFrom = query.dateFrom ?? null;
      const dateTo = query.dateTo ? query.dateTo + "T23:59:59Z" : null;

      const rows = await pgClient`
        SELECT o.id, o.payment_mode, o.grand_total, o.status, o.created_at,
               d.name AS dealer_name
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        WHERE o.status != 'cancelled'
          AND (${searchTerm}::text IS NULL OR d.name ILIKE ${searchTerm ?? ''})
          AND (${methodFilter}::text IS NULL OR o.payment_mode::text = ${methodFilter ?? ''})
          AND (${dateFrom}::timestamptz IS NULL OR o.created_at >= ${dateFrom ?? '1970-01-01'}::timestamptz)
          AND (${dateTo}::timestamptz IS NULL OR o.created_at <= ${dateTo ?? '2099-12-31'}::timestamptz)
        ORDER BY o.created_at DESC LIMIT 100
      `;

      const [summary] = await pgClient`
        SELECT COALESCE(SUM(grand_total), 0)::numeric AS total_collected,
               count(*)::int AS total_transactions
        FROM orders WHERE status != 'cancelled'
      `;

      const [walletSum] = await pgClient`SELECT COALESCE(SUM(balance), 0)::numeric AS total FROM dealer_wallets`;

      return reply.send({
        data: rows,
        summary: { totalCollected: summary?.total_collected ?? 0, totalTransactions: summary?.total_transactions ?? 0, totalWalletBalance: walletSum?.total ?? 0 },
      });
    }
  );
}
