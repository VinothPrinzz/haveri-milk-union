import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";

const saleItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1),
});

export async function directSalesRoutes(app: FastifyInstance) {
  // ═══ CASH CUSTOMERS ═══
  // GET /api/v1/cash-customers — list for dropdown / autocomplete
  app.get(
    "/api/v1/cash-customers",
    { preHandler: [adminAuth, requireRole("cash_customers.view")] },
    async (request, reply) => {
      const querySchema = z.object({
        search: z.string().optional(),
      });
      const query = querySchema.parse(request.query);
      const searchTerm = query.search ? `%${query.search}%` : null;

      const rows = await pgClient`
        SELECT id, name, phone, address FROM cash_customers
        WHERE deleted_at IS NULL
          AND (${searchTerm}::text IS NULL OR name ILIKE ${searchTerm ?? ''} OR phone ILIKE ${searchTerm ?? ''})
        ORDER BY name
        LIMIT 50
      `;
      return reply.send({ data: rows });
    }
  );

  // POST /api/v1/cash-customers — create cash customer (inline from direct sale form)
  app.post(
    "/api/v1/cash-customers",
    { preHandler: [adminAuth, requireRole("cash_customers.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        address: z.string().optional(),
      });
      const body = schema.parse(request.body);
      const [customer] = await pgClient`
        INSERT INTO cash_customers (name, phone, address)
        VALUES (${body.name}, ${body.phone ?? null}, ${body.address ?? null})
        RETURNING *
      `;
      return reply.status(201).send({ customer });
    }
  );

  // ═══ DIRECT SALES ═══
  // GET /api/v1/direct-sales — paginated list with filters
  app.get(
    "/api/v1/direct-sales",
    { preHandler: [adminAuth, requireRole("direct_sales.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        customerType: z.enum(["agent", "cash"]).optional(),
        routeId: z.string().uuid().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        officerId: z.string().uuid().optional(),
      });
      const query = querySchema.parse(request.query);

      // ←←← ONLY THIS CHANGE AS PER STEP 5
      const customerType = query.customerType
        ? query.customerType.toLowerCase() as 'agent' | 'cash'
        : null;

      const offset = offsetFromPage(query.page, query.limit);
     
      const routeId = query.routeId ?? null;
      const dateFrom = query.dateFrom ?? null;
      const dateTo = query.dateTo ?? null;
      const officerId = query.officerId ?? null;

      const rows = await pgClient`
        SELECT ds.id, ds.gp_no, ds.customer_type, ds.customer_id,
              ds.route_id, ds.sale_date, ds.payment_mode,
              ds.subtotal, ds.total_gst, ds.grand_total, ds.notes, ds.created_at,
              r.code AS route_code, r.name AS route_name,
              u.name AS officer_name,
              b.name AS batch_name,
              CASE
                WHEN ds.customer_type = 'agent' THEN d.name
                WHEN ds.customer_type = 'cash'  THEN cc.name
              END AS customer_name,
              CASE
                WHEN ds.customer_type = 'agent' THEN d.phone
                WHEN ds.customer_type = 'cash'  THEN cc.phone
              END AS customer_phone,
              COALESCE(
                (SELECT json_agg(json_build_object(
                    'product_name', dsi.product_name,
                    'quantity',     dsi.quantity,
                    'unit_price',   dsi.unit_price,
                    'line_total',   dsi.line_total
                  ) ORDER BY dsi.product_name)
                  FROM direct_sale_items dsi WHERE dsi.direct_sale_id = ds.id),
                '[]'::json
              ) AS items,
              (SELECT count(*)::int FROM direct_sale_items dsi WHERE dsi.direct_sale_id = ds.id) AS item_count
        FROM direct_sales ds
        LEFT JOIN routes r ON r.id = ds.route_id
        LEFT JOIN users u  ON u.id = ds.officer_id
        LEFT JOIN batches b ON b.id = ds.batch_id
        LEFT JOIN dealers d ON ds.customer_type = 'agent' AND d.id = ds.customer_id
        LEFT JOIN cash_customers cc ON ds.customer_type = 'cash' AND cc.id = ds.customer_id
        WHERE (${customerType}::text IS NULL OR ds.customer_type = ${customerType ?? 'agent'}::direct_sale_customer_type)
          AND (${routeId}::uuid IS NULL OR ds.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${dateFrom}::date IS NULL OR ds.sale_date >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date IS NULL OR ds.sale_date <= ${dateTo ?? '9999-12-31'}::date)
          AND (${officerId}::uuid IS NULL OR ds.officer_id = ${officerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
        ORDER BY ds.created_at DESC
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count FROM direct_sales ds
        WHERE (${customerType}::text IS NULL OR ds.customer_type = ${customerType ?? 'agent'}::direct_sale_customer_type)
          AND (${routeId}::uuid IS NULL OR ds.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${dateFrom}::date IS NULL OR ds.sale_date >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date IS NULL OR ds.sale_date <= ${dateTo ?? '9999-12-31'}::date)
          AND (${officerId}::uuid IS NULL OR ds.officer_id = ${officerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/direct-sales/:id — single sale with items
  app.get(
    "/api/v1/direct-sales/:id",
    { preHandler: [adminAuth, requireRole("direct_sales.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [sale] = await pgClient`
        SELECT ds.*,
               r.code AS route_code, r.name AS route_name,
               u.name AS officer_name,
               b.name AS batch_name
        FROM direct_sales ds
        LEFT JOIN routes r ON r.id = ds.route_id
        LEFT JOIN users u ON u.id = ds.officer_id
        LEFT JOIN batches b ON b.id = ds.batch_id
        WHERE ds.id = ${id}
      `;
      if (!sale) return reply.status(404).send({ error: "Direct sale not found" });

      const items = await pgClient`
        SELECT dsi.*, p.icon, p.unit
        FROM direct_sale_items dsi
        JOIN products p ON p.id = dsi.product_id
        WHERE dsi.direct_sale_id = ${id}
        ORDER BY dsi.product_name
      `;

      // If gate pass, also get gate pass items with return info
      let gatePassItems: any[] = [];
      if (sale.customer_type === "agent") {
        gatePassItems = await pgClient`
          SELECT gpi.*, p.name AS product_name, p.icon, p.unit
          FROM gate_pass_items gpi
          JOIN products p ON p.id = gpi.product_id
          WHERE gpi.direct_sale_id = ${id}
          ORDER BY p.name
        `;
      }

      // Resolve customer name
      let customer: any = null;
      if (sale.customer_type === "agent") {
        [customer] = await pgClient`SELECT id, name, phone, gst_number FROM dealers WHERE id = ${sale.customer_id}`;
      } else {
        [customer] = await pgClient`SELECT id, name, phone FROM cash_customers WHERE id = ${sale.customer_id}`;
      }

      return reply.send({ sale, items, gatePassItems, customer });
    }
  );

  // POST /api/v1/direct-sales/gate-pass — create agent gate pass sale
  app.post(
    "/api/v1/direct-sales/gate-pass",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const schema = z.object({
        customerId: z.string().uuid(), // dealer ID (agent)
        routeId: z.string().uuid().optional(),
        batchId: z.string().uuid().optional(),
        saleDate: z.string().optional(), // ISO date, defaults to today
        paymentMode: z.enum(["wallet", "upi", "credit", "cash"]).default("credit"),
        paymentRef: z.string().optional(),
        notes: z.string().optional(),
        items: z.array(saleItemSchema).min(1),
      });
      const body = schema.parse(request.body);
      const saleDate = body.saleDate ?? new Date().toISOString().slice(0, 10);

      // Fetch product prices
      const productIds = body.items.map(i => i.productId);
      const productRows = await pgClient`
        SELECT id, name, base_price, gst_percent FROM products
        WHERE id = ANY(${productIds}::uuid[]) AND deleted_at IS NULL
      `;
      const productMap = new Map(productRows.map((p: any) => [p.id, p]));

      // Calculate totals
      let subtotal = 0;
      let totalGst = 0;
      const lineItems: any[] = [];

      for (const item of body.items) {
        const product = productMap.get(item.productId);
        if (!product) return reply.status(400).send({ error: `Product ${item.productId} not found` });

        const unitPrice = parseFloat(product.base_price);
        const gstPercent = parseFloat(product.gst_percent);
        const lineSubtotal = unitPrice * item.quantity;
        const gstAmount = Math.round(lineSubtotal * gstPercent) / 100;
        const lineTotal = lineSubtotal + gstAmount;

        subtotal += lineSubtotal;
        totalGst += gstAmount;

        lineItems.push({
          productId: item.productId,
          productName: product.name,
          quantity: item.quantity,
          unitPrice,
          gstPercent,
          gstAmount,
          lineTotal,
        });
      }

      const grandTotal = subtotal + totalGst;

      // Insert direct sale
      const [sale] = await pgClient`
        INSERT INTO direct_sales (customer_type, customer_id, route_id, officer_id, batch_id,
                                   sale_date, payment_mode, payment_ref, subtotal, total_gst, grand_total, notes)
        VALUES ('agent', ${body.customerId}, ${body.routeId ?? null}, ${request.admin!.userId},
                ${body.batchId ?? null}, ${saleDate}::date, ${body.paymentMode}::payment_mode,
                ${body.paymentRef ?? null}, ${subtotal}, ${totalGst}, ${grandTotal}, ${body.notes ?? null})
        RETURNING *
      `;

      // Insert line items and gate pass items
      for (const item of lineItems) {
        await pgClient`
          INSERT INTO direct_sale_items (direct_sale_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total)
          VALUES (${sale.id}, ${item.productId}, ${item.productName}, ${item.quantity},
                  ${item.unitPrice}, ${item.gstPercent}, ${item.gstAmount}, ${item.lineTotal})
        `;
        // Gate pass tracking row
        await pgClient`
          INSERT INTO gate_pass_items (direct_sale_id, product_id, quantity, returned_quantity)
          VALUES (${sale.id}, ${item.productId}, ${item.quantity}, 0)
        `;
      }

      // Deduct stock
      for (const item of lineItems) {
        await pgClient`
          UPDATE products SET stock = GREATEST(stock - ${item.quantity}, 0), updated_at = now()
          WHERE id = ${item.productId}
        `;
      }

      return reply.status(201).send({ sale, items: lineItems });
    }
  );

  // POST /api/v1/direct-sales/cash — create cash customer sale
  app.post(
    "/api/v1/direct-sales/cash",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const schema = z.object({
        customerId: z.string().uuid(), // cash_customers.id
        routeId: z.string().uuid().optional(),
        batchId: z.string().uuid().optional(),
        saleDate: z.string().optional(),
        paymentMode: z.enum(["cash", "upi"]).default("cash"),
        paymentRef: z.string().optional(),
        notes: z.string().optional(),
        items: z.array(saleItemSchema).min(1),
      });
      const body = schema.parse(request.body);
      const saleDate = body.saleDate ?? new Date().toISOString().slice(0, 10);

      // Fetch product prices
      const productIds = body.items.map(i => i.productId);
      const productRows = await pgClient`
        SELECT id, name, base_price, gst_percent FROM products
        WHERE id = ANY(${productIds}::uuid[]) AND deleted_at IS NULL
      `;
      const productMap = new Map(productRows.map((p: any) => [p.id, p]));

      let subtotal = 0;
      let totalGst = 0;
      const lineItems: any[] = [];

      for (const item of body.items) {
        const product = productMap.get(item.productId);
        if (!product) return reply.status(400).send({ error: `Product ${item.productId} not found` });

        const unitPrice = parseFloat(product.base_price);
        const gstPercent = parseFloat(product.gst_percent);
        const lineSubtotal = unitPrice * item.quantity;
        const gstAmount = Math.round(lineSubtotal * gstPercent) / 100;
        const lineTotal = lineSubtotal + gstAmount;

        subtotal += lineSubtotal;
        totalGst += gstAmount;

        lineItems.push({ productId: item.productId, productName: product.name, quantity: item.quantity, unitPrice, gstPercent, gstAmount, lineTotal });
      }

      const grandTotal = subtotal + totalGst;

      const [sale] = await pgClient`
        INSERT INTO direct_sales (customer_type, customer_id, route_id, officer_id, batch_id,
                                   sale_date, payment_mode, payment_ref, subtotal, total_gst, grand_total, notes)
        VALUES ('cash', ${body.customerId}, ${body.routeId ?? null}, ${request.admin!.userId},
                ${body.batchId ?? null}, ${saleDate}::date, ${body.paymentMode}::payment_mode,
                ${body.paymentRef ?? null}, ${subtotal}, ${totalGst}, ${grandTotal}, ${body.notes ?? null})
        RETURNING *
      `;

      for (const item of lineItems) {
        await pgClient`
          INSERT INTO direct_sale_items (direct_sale_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total)
          VALUES (${sale.id}, ${item.productId}, ${item.productName}, ${item.quantity},
                  ${item.unitPrice}, ${item.gstPercent}, ${item.gstAmount}, ${item.lineTotal})
        `;
      }

      // Deduct stock
      for (const item of lineItems) {
        await pgClient`
          UPDATE products SET stock = GREATEST(stock - ${item.quantity}, 0), updated_at = now()
          WHERE id = ${item.productId}
        `;
      }

      return reply.status(201).send({ sale, items: lineItems });
    }
  );

  // PATCH /api/v1/direct-sales/:id/returns — record gate pass returns
  app.patch(
    "/api/v1/direct-sales/:id/returns",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        returns: z.array(z.object({
          productId: z.string().uuid(),
          returnedQuantity: z.number().int().min(0),
        })).min(1),
      });
      const body = schema.parse(request.body);

      // Verify this is an agent gate pass
      const [sale] = await pgClient`SELECT id, customer_type FROM direct_sales WHERE id = ${id}`;
      if (!sale) return reply.status(404).send({ error: "Sale not found" });
      if (sale.customer_type !== "agent") return reply.status(400).send({ error: "Returns only apply to gate pass (agent) sales" });

      for (const ret of body.returns) {
        // Update gate pass item
        const [gpi] = await pgClient`
          UPDATE gate_pass_items SET
            returned_quantity = ${ret.returnedQuantity},
            updated_at = now()
          WHERE direct_sale_id = ${id} AND product_id = ${ret.productId}
          RETURNING quantity, returned_quantity
        `;

        if (gpi && ret.returnedQuantity > 0) {
          // Restore stock for returned items
          await pgClient`
            UPDATE products SET stock = stock + ${ret.returnedQuantity}, updated_at = now()
            WHERE id = ${ret.productId}
          `;
        }
      }

      // Recalculate sale totals based on net quantities (issued - returned)
      const netItems = await pgClient`
        SELECT gpi.product_id, (gpi.quantity - gpi.returned_quantity) AS net_qty,
               dsi.unit_price, dsi.gst_percent
        FROM gate_pass_items gpi
        JOIN direct_sale_items dsi ON dsi.direct_sale_id = gpi.direct_sale_id AND dsi.product_id = gpi.product_id
        WHERE gpi.direct_sale_id = ${id}
      `;

      let newSubtotal = 0;
      let newGst = 0;
      for (const item of netItems) {
        const lineSubtotal = parseFloat(item.unit_price) * item.net_qty;
        const gstAmount = Math.round(lineSubtotal * parseFloat(item.gst_percent)) / 100;
        newSubtotal += lineSubtotal;
        newGst += gstAmount;
      }

      await pgClient`
        UPDATE direct_sales SET subtotal = ${newSubtotal}, total_gst = ${newGst},
               grand_total = ${newSubtotal + newGst}, updated_at = now()
        WHERE id = ${id}
      `;

      return reply.send({ message: "Returns recorded and totals updated" });
    }
  );
}