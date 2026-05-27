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

      const customerType = query.customerType
        ? query.customerType.toLowerCase() as 'agent' | 'cash'
        : null;

      const offset = offsetFromPage(query.page, query.limit);
      
      const routeId = query.routeId ?? null;
      const dateFrom = query.dateFrom ?? null;
      const dateTo = query.dateTo ?? null;
      const officerId = query.officerId ?? null;

      const rows = await pgClient`
        SELECT 
          ds.id, ds.gp_no, ds.customer_type, ds.customer_id,
          ds.route_id, ds.sale_date, ds.payment_mode,
          ds.subtotal, ds.total_gst, ds.grand_total, ds.notes, ds.created_at,
          r.code AS route_code, r.name AS route_name,
          u.name AS officer_name,
          b.name AS batch_name,
          i.id AS invoice_id,                    -- ← ADDED for B.7
          CASE
            WHEN ds.customer_type = 'agent' THEN d.name
            WHEN ds.customer_type = 'cash'  THEN cc.name
            ELSE ds.recipient_name          -- covers vip_sample + employee_subsidy
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
        LEFT JOIN invoices i ON i.order_id = ds.id          -- ← ADDED for B.7
        WHERE (${customerType}::text IS NULL OR ds.customer_type = ${customerType ?? 'agent'}::direct_sale_customer_type)
          AND (${routeId}::uuid IS NULL OR ds.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${dateFrom}::date IS NULL OR ds.sale_date >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date IS NULL OR ds.sale_date <= ${dateTo ?? '9999-12-31'}::date)
          AND (${officerId}::uuid IS NULL OR ds.officer_id = ${officerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
        ORDER BY ds.created_at DESC
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      // Count query also updated for consistency (though not strictly required)
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

      // Replace the existing customer-resolution if/else with:
      let customer: any = null;
      if (sale.customer_type === "agent") {
        [customer] = await pgClient`SELECT id, name, phone, gst_number FROM dealers WHERE id = ${sale.customer_id}`;
      } else if (sale.customer_type === "cash") {
        [customer] = await pgClient`SELECT id, name, phone FROM cash_customers WHERE id = ${sale.customer_id}`;
      } else if (sale.customer_type === "vip_sample") {
        [customer] = await pgClient`SELECT id, name, phone, designation FROM vip_contacts WHERE id = ${sale.customer_id}`;
      } else if (sale.customer_type === "employee_subsidy") {
        [customer] = await pgClient`SELECT id, employee_code, name, phone, department, designation FROM employees WHERE id = ${sale.customer_id}`;
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

      if (!sale) return reply.status(500).send({ error: "Failed to create sale" });

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

      if (!sale) return reply.status(500).send({ error: "Failed to create sale" });

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

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/direct-sales/vip-sample
  // Free issue to a VIP. Forces all prices and GST to 0.
  // ────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/direct-sales/vip-sample",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const body = z.object({
        customerId: z.string().uuid(),   // vip_contacts.id
        routeId:    z.string().uuid().optional(),
        batchId:    z.string().uuid().optional(),
        saleDate:   z.string().optional(),
        notes:      z.string().optional(),
        items:      z.array(saleItemSchema).min(1),
      }).parse(request.body);

      const saleDate = body.saleDate ?? new Date().toISOString().slice(0, 10);

      // Resolve VIP for recipient_name snapshot
      const [vip] = await pgClient`
        SELECT id, name FROM vip_contacts
        WHERE id = ${body.customerId} AND deleted_at IS NULL
      `;
      if (!vip) return reply.status(400).send({ error: "VIP contact not found" });

      // Fetch product names for snapshots
      const productIds = body.items.map(i => i.productId);
      const productRows = await pgClient`
        SELECT id, name FROM products
        WHERE id = ANY(${productIds}::uuid[]) AND deleted_at IS NULL
      `;
      const productMap = new Map(productRows.map((p: any) => [p.id, p]));

      const lineItems = body.items.map((it) => {
        const product = productMap.get(it.productId);
        if (!product) throw new Error(`Product ${it.productId} not found`);
        return {
          productId:   it.productId,
          productName: product.name,
          quantity:    it.quantity,
          unitPrice:   0,
          gstPercent:  0,
          gstAmount:   0,
          lineTotal:   0,
        };
      });

      const [sale] = await pgClient`
        INSERT INTO direct_sales (
          customer_type, customer_id, recipient_name, route_id, officer_id, batch_id,
          sale_date, payment_mode, payment_ref,
          subtotal, total_gst, grand_total, notes
        )
        VALUES (
          'vip_sample', ${body.customerId}, ${vip.name},
          ${body.routeId ?? null}, ${request.admin!.userId}, ${body.batchId ?? null},
          ${saleDate}::date, 'complimentary'::payment_mode, NULL,
          0, 0, 0, ${body.notes ?? null}
        )
        RETURNING *
      `;
      if (!sale) return reply.status(500).send({ error: "Failed to create sale" });

      for (const item of lineItems) {
        await pgClient`
          INSERT INTO direct_sale_items (
            direct_sale_id, product_id, product_name, quantity,
            unit_price, gst_percent, gst_amount, line_total
          ) VALUES (
            ${sale.id}, ${item.productId}, ${item.productName}, ${item.quantity},
            0, 0, 0, 0
          )
        `;
        // Free issues still deduct FGS stock — the goods physically left the warehouse.
        await pgClient`
          UPDATE products SET stock = GREATEST(stock - ${item.quantity}, 0), updated_at = now()
          WHERE id = ${item.productId}
        `;
      }

      return reply.status(201).send({ sale, items: lineItems });
    }
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/direct-sales/employee-subsidy
  // Employee buys at MRP × (1 − subsidy%). Server applies discount, staff cannot override.
  // Only products with an active row in employee_subsidy_rules are accepted.
  // ────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/direct-sales/employee-subsidy",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const body = z.object({
        customerId:  z.string().uuid(),   // employees.id
        routeId:     z.string().uuid().optional(),
        batchId:     z.string().uuid().optional(),
        saleDate:    z.string().optional(),
        paymentMode: z.enum(["cash", "upi"]).default("cash"),
        paymentRef:  z.string().optional(),
        notes:       z.string().optional(),
        items:       z.array(saleItemSchema).min(1),
      }).parse(request.body);

      if (body.paymentMode === "upi" && !body.paymentRef?.trim()) {
        return reply.status(400).send({ error: "paymentRef is required for UPI" });
      }

      const saleDate = body.saleDate ?? new Date().toISOString().slice(0, 10);

      // Resolve employee
      const [employee] = await pgClient`
        SELECT id, name, active, route_id FROM employees
        WHERE id = ${body.customerId} AND deleted_at IS NULL
      `;
      if (!employee)         return reply.status(400).send({ error: "Employee not found" });
      if (!employee.active)  return reply.status(400).send({ error: "Employee is inactive" });

      // Explicit routeId wins; otherwise fall back to the employee's
      // standing route (migration 0037). NULL if the employee has none.
      const effectiveRouteId = body.routeId ?? employee.route_id ?? null;

      // Validate every line is in the eligible product list, and resolve subsidy %
      const productIds = body.items.map(i => i.productId);
      const eligible = await pgClient`
        SELECT r.product_id, r.subsidy_percent,
              p.name, p.base_price, p.gst_percent
        FROM employee_subsidy_rules r
        JOIN products p ON p.id = r.product_id
        WHERE r.active = true
          AND p.deleted_at IS NULL
          AND r.product_id = ANY(${productIds}::uuid[])
      `;
      const ruleMap = new Map(eligible.map((r: any) => [r.product_id, r]));
      for (const it of body.items) {
        if (!ruleMap.has(it.productId)) {
          return reply.status(400).send({
            error: `Product ${it.productId} is not eligible for employee subsidy`,
          });
        }
      }

      let subtotal = 0, totalGst = 0;
      const lineItems: any[] = [];

      for (const it of body.items) {
        const rule = ruleMap.get(it.productId)!;
        const mrp        = parseFloat(rule.base_price);
        const subsidyPct = parseFloat(rule.subsidy_percent);
        const gstPct     = parseFloat(rule.gst_percent);

        const unitPrice  = +(mrp * (1 - subsidyPct / 100)).toFixed(2);
        const lineSub    = +(unitPrice * it.quantity).toFixed(2);
        const gstAmount  = +(lineSub * gstPct / 100).toFixed(2);
        const lineTotal  = +(lineSub + gstAmount).toFixed(2);

        subtotal += lineSub;
        totalGst += gstAmount;

        lineItems.push({
          productId:   it.productId,
          productName: rule.name,
          quantity:    it.quantity,
          unitPrice,
          gstPercent:  gstPct,
          gstAmount,
          lineTotal,
          subsidyPercent: subsidyPct,
          mrpReference:   mrp,
        });
      }
      const grandTotal = +(subtotal + totalGst).toFixed(2);

      const subsidyNote = lineItems
        .map(li => `${li.productName}: MRP ₹${li.mrpReference} − ${li.subsidyPercent}% subsidy = ₹${li.unitPrice}`)
        .join("; ");

      const [sale] = await pgClient`
        INSERT INTO direct_sales (
          customer_type, customer_id, recipient_name, route_id, officer_id, batch_id,
          sale_date, payment_mode, payment_ref,
          subtotal, total_gst, grand_total, notes
        )
        VALUES (
          'employee_subsidy', ${body.customerId}, ${employee.name},
          ${effectiveRouteId}, ${request.admin!.userId}, ${body.batchId ?? null},
          ${saleDate}::date, ${body.paymentMode}::payment_mode, ${body.paymentRef ?? null},
          ${subtotal}, ${totalGst}, ${grandTotal},
          ${body.notes ? `${body.notes} | ${subsidyNote}` : subsidyNote}
        )
        RETURNING *
      `;
      if (!sale) return reply.status(500).send({ error: "Failed to create sale" });

      for (const it of lineItems) {
        await pgClient`
          INSERT INTO direct_sale_items (
            direct_sale_id, product_id, product_name, quantity,
            unit_price, gst_percent, gst_amount, line_total
          ) VALUES (
            ${sale.id}, ${it.productId}, ${it.productName}, ${it.quantity},
            ${it.unitPrice}, ${it.gstPercent}, ${it.gstAmount}, ${it.lineTotal}
          )
        `;
        await pgClient`
          UPDATE products SET stock = GREATEST(stock - ${it.quantity}, 0), updated_at = now()
          WHERE id = ${it.productId}
        `;
      }

      return reply.status(201).send({ sale, items: lineItems });
    }
  );

  // PATCH /api/v1/direct-sales/:id/items — qty-only modification of a direct sale
  app.patch(
    "/api/v1/direct-sales/:id/items",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        items: z.array(z.object({
          productId: z.string().uuid(),
          quantity:  z.number().int().min(0),
        })).min(1),
      });
      const body = schema.parse(request.body);

      const [sale] = await pgClient`
        SELECT id, customer_type, subtotal, total_gst, grand_total
        FROM direct_sales WHERE id = ${id} FOR UPDATE
      `;
      if (!sale) return reply.status(404).send({ error: "Direct sale not found" });

      // Existing rows — we keep the price/gst snapshot and only adjust qty.
      const existingItems = await pgClient`
        SELECT id, product_id, quantity, unit_price, gst_percent
        FROM direct_sale_items WHERE direct_sale_id = ${id}
      `;
      const byProduct = new Map(existingItems.map((r: any) => [r.product_id, r]));

      // Validate every productId in the payload exists on this sale.
      for (const i of body.items) {
        if (!byProduct.has(i.productId)) {
          return reply.status(400).send({
            error: `Product ${i.productId} is not part of this sale; cannot add/swap products here`,
          });
        }
      }

      // Recompute totals + per-line deltas
      let newSubtotal = 0, newGst = 0;
      const stockDeltas: Array<{ productId: string; delta: number }> = [];
      const updates: Array<{
        lineId: string; productId: string; quantity: number;
        unitPrice: string; gstPercent: string;
        gstAmount: string; lineTotal: string;
      }> = [];

      for (const i of body.items) {
        const existing: any = byProduct.get(i.productId);
        const unitPrice = parseFloat(existing.unit_price);
        const gstPct    = parseFloat(existing.gst_percent);
        const lineSub   = unitPrice * i.quantity;
        const lineGst   = lineSub * (gstPct / 100);
        newSubtotal += lineSub;
        newGst      += lineGst;
        // delta = new − old. Positive means more stock leaves the warehouse.
        stockDeltas.push({ productId: i.productId, delta: i.quantity - Number(existing.quantity) });
        updates.push({
          lineId: existing.id,
          productId: i.productId,
          quantity: i.quantity,
          unitPrice:  unitPrice.toFixed(2),
          gstPercent: gstPct.toFixed(2),
          gstAmount:  lineGst.toFixed(2),
          lineTotal:  (lineSub + lineGst).toFixed(2),
        });
      }

      const newGrandTotal = newSubtotal + newGst;

      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        for (const u of updates) {
          if (u.quantity === 0) {
            await tx`DELETE FROM direct_sale_items WHERE id = ${u.lineId}`;
          } else {
            await tx`
              UPDATE direct_sale_items
                SET quantity   = ${u.quantity},
                    gst_amount = ${u.gstAmount}::numeric,
                    line_total = ${u.lineTotal}::numeric
              WHERE id = ${u.lineId}
            `;
          }
        }

        // Stock adjustment: refund old qty, then subtract new qty (net = delta in reverse).
        // Implemented as a single signed update: stock -= delta.
        for (const s of stockDeltas) {
          if (s.delta !== 0) {
            await tx`
              UPDATE products
                SET stock = stock - ${s.delta},
                    updated_at = now()
              WHERE id = ${s.productId}
            `;
          }
        }

        // For agent gate-passes, keep gate_pass_items.quantity in sync.
        if (sale.customer_type === "agent") {
          for (const u of updates) {
            await tx`
              UPDATE gate_pass_items
                SET quantity = ${u.quantity}, updated_at = now()
              WHERE direct_sale_id = ${id} AND product_id = ${u.productId}
            `;
          }
        }

        await tx`
          UPDATE direct_sales
            SET subtotal    = ${newSubtotal.toFixed(2)}::numeric,
                total_gst   = ${newGst.toFixed(2)}::numeric,
                grand_total = ${newGrandTotal.toFixed(2)}::numeric,
                updated_at  = now()
          WHERE id = ${id}
        `;
      });

      return reply.send({ ok: true, id, grandTotal: newGrandTotal.toFixed(2) });
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