import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

export async function financeRoutes(app: FastifyInstance) {
  // ═══ INVOICES ═══

  // GET /api/v1/invoices
  app.get(
    "/api/v1/invoices",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        dealer: z.string().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
      });
      const query = querySchema.parse(request.query);
      const offset = offsetFromPage(query.page, query.limit);
      const dealerSearch = query.dealer ? `%${query.dealer}%` : null;
      const dateFrom = query.dateFrom ?? null;
      const dateTo = query.dateTo ? query.dateTo + "T23:59:59Z" : null;

      const rows = await pgClient`
        SELECT i.id, i.invoice_number, i.order_id, i.invoice_date, i.taxable_amount,
               i.cgst, i.sgst, i.total_tax, i.total_amount, i.pdf_url,
               i.dealer_name, i.dealer_gst_number
        FROM invoices i
        JOIN dealers d ON d.id = i.dealer_id
        WHERE (${dealerSearch}::text IS NULL OR d.name ILIKE ${dealerSearch ?? ''})
          AND (${dateFrom}::timestamptz IS NULL OR i.invoice_date >= ${dateFrom ?? '1970-01-01'}::timestamptz)
          AND (${dateTo}::timestamptz IS NULL OR i.invoice_date <= ${dateTo ?? '2099-12-31'}::timestamptz)
        ORDER BY i.invoice_date DESC
        LIMIT ${query.limit} OFFSET ${offset}
      `;
      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM invoices i
        JOIN dealers d ON d.id = i.dealer_id
        WHERE (${dealerSearch}::text IS NULL OR d.name ILIKE ${dealerSearch ?? ''})
          AND (${dateFrom}::timestamptz IS NULL OR i.invoice_date >= ${dateFrom ?? '1970-01-01'}::timestamptz)
          AND (${dateTo}::timestamptz IS NULL OR i.invoice_date <= ${dateTo ?? '2099-12-31'}::timestamptz)
      `;
      return reply.send({ data: rows, ...paginationMeta(countRow?.count ?? 0, query.page, query.limit) });
    }
  );

  // GET /api/v1/invoices/:id — invoice detail with order items
  app.get(
    "/api/v1/invoices/:id",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [invoice] = await pgClient`
        SELECT i.*, o.status AS order_status, o.payment_mode, o.item_count
        FROM invoices i
        JOIN orders o ON o.id = i.order_id
        WHERE i.id = ${id} LIMIT 1
      `;
      if (!invoice) return reply.status(404).send({ error: "Invoice not found" });
      const items = await pgClient`
        SELECT product_name, quantity, unit_price, gst_percent, gst_amount, line_total
        FROM order_items WHERE order_id = ${invoice.order_id} ORDER BY product_name
      `;
      return reply.send({ invoice, items });
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
      const targetDate = query.dateFrom || new Date().toISOString().split("T")[0];

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
        orderItemsData.push({ productId: item.productId, productName: product.name, quantity: item.quantity, unitPrice: price.toFixed(2), gstPercent: gstPct.toFixed(2), gstAmount: lineGst.toFixed(2), lineTotal: (lineSub + lineGst).toFixed(2) });
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
        return reply.status(201).send({ message: "Order placed successfully", order: { id: result!.id, grandTotal: grandTotal.toFixed(2), itemCount: orderItemsData.length } });
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
