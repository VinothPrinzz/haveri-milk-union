// apps/api/src/routes/employee-indents.ts
// ═══════════════════════════════════════════════════════════════════════
// Admin-side employee standing-indent + daily-draft management.
//
// The employee mirror of admin-indents.ts. Employees have NO app login, so
// the entire flow is admin/worker-driven. Two important differences from the
// dealer flow:
//
//   1. PRICING — employee indents are priced at the employee-subsidy rate.
//      Only products with an ACTIVE row in employee_subsidy_rules are
//      eligible; unit_price = base_price × (1 − subsidy%) + GST. Same maths
//      as POST /api/v1/direct-sales/employee-subsidy.
//
//   2. FINANCE LINK — POST .../drafts/:date/confirm places the draft as a
//      'confirmed' employee_order AND writes an employee_ledger debit in the
//      SAME transaction. Over-limit (and not forced) parks the order as
//      'payment_required' for finance to release — there is no payment app
//      for employees.
//
//   • reads  → requireRole("indents.view")
//   • writes → requireRole("indents.manage")
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { checkEmployeeCredit } from "../lib/credit-check.js";

// ── Helpers ─────────────────────────────────────────────────────────────

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");
const uuid = z.string().uuid();

function adminUserId(request: FastifyRequest): string {
  const a = (request as unknown as { admin?: { userId: string } }).admin;
  if (!a?.userId) throw new Error("adminAuth middleware not set");
  return a.userId;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Subsidized line maths — mirrors POST /direct-sales/employee-subsidy.
 * `mrp` is the product base_price; the employee pays mrp × (1 − subsidy%).
 */
function calcSubsidizedLine(mrp: number, subsidyPct: number, gstPercent: number, qty: number) {
  const unitPrice = round2(mrp * (1 - subsidyPct / 100));
  const subtotal = round2(unitPrice * qty);
  const gst = round2(subtotal * (gstPercent / 100));
  return {
    unitPrice,
    subtotal,
    gst,
    total: round2(subtotal + gst),
  };
}

/** Resolve + validate an employee; throws a 404-shaped error if missing. */
async function loadEmployee(employeeId: string) {
  const [emp] = await pgClient`
    SELECT id, name, employee_code AS "code", route_id AS "routeId"
      FROM employees
     WHERE id = ${employeeId} AND deleted_at IS NULL
     LIMIT 1
  `;
  if (!emp) {
    throw Object.assign(new Error("Employee not found"), { statusCode: 404 });
  }
  return emp as { id: string; name: string; code: string | null; routeId: string | null };
}

/**
 * Eligible products for an employee indent = products with an active
 * employee_subsidy_rule. Returns the subsidized unit price alongside the
 * MRP / subsidy% / GST so callers can price + snapshot.
 */
async function eligibleSubsidyProducts() {
  return pgClient`
    SELECT
      p.id                       AS "productId",
      p.name                     AS "productName",
      p.unit                     AS "unit",
      p.icon                     AS "icon",
      p.image_url                AS "imageUrl",
      p.base_price::numeric      AS "basePrice",
      p.gst_percent::numeric     AS "gstPercent",
      p.available                AS "productAvailable",
      r.subsidy_percent::numeric AS "subsidyPercent"
    FROM employee_subsidy_rules r
    JOIN products p ON p.id = r.product_id AND p.deleted_at IS NULL
    WHERE r.active = true
    ORDER BY p.sort_order, p.name
  `;
}

// ═══════════════════════════════════════════════════════════════════════
// Routes
// ═══════════════════════════════════════════════════════════════════════

export async function employeeIndentsRoutes(app: FastifyInstance) {
  // ┌───────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/admin/employees/:employeeId/standing-indents          │
  // │  One merged row per subsidy-eligible product: template + picker.   │
  // └───────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/admin/employees/:employeeId/standing-indents",
    { preHandler: [adminAuth, requireRole("indents.view")] },
    async (request, reply) => {
      const { employeeId } = z.object({ employeeId: uuid }).parse(request.params);
      const employee = await loadEmployee(employeeId);

      const products = (await eligibleSubsidyProducts()) as any[];

      // Current template for this employee, keyed by product.
      const templateRows = (await pgClient`
        SELECT product_id AS "productId", default_qty AS "defaultQty", active
          FROM employee_standing_indents
         WHERE employee_id = ${employeeId}
      `) as any[];
      const tmpl = new Map(templateRows.map((r) => [r.productId, r]));

      const items = products.map((p) => {
        const mrp = parseFloat(p.basePrice);
        const subsidyPct = parseFloat(p.subsidyPercent);
        const gstPct = parseFloat(p.gstPercent);
        const t = tmpl.get(p.productId);
        return {
          productId: p.productId,
          productName: p.productName,
          unit: p.unit,
          icon: p.icon,
          imageUrl: p.imageUrl,
          basePrice: round2(mrp),
          subsidyPercent: subsidyPct,
          unitPrice: round2(mrp * (1 - subsidyPct / 100)),
          gstPercent: gstPct,
          productAvailable: p.productAvailable,
          defaultQty: t ? t.defaultQty : 0,
          active: t ? t.active : false,
          inTemplate: !!t,
        };
      });

      return reply.send({
        employee: { id: employee.id, name: employee.name, code: employee.code },
        items,
      });
    }
  );

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  PUT /api/v1/admin/employees/:employeeId/standing-indents          │
  // └───────────────────────────────────────────────────────────────────┘
  app.put(
    "/api/v1/admin/employees/:employeeId/standing-indents",
    { preHandler: [adminAuth, requireRole("indents.manage")] },
    async (request, reply) => {
      const { employeeId } = z.object({ employeeId: uuid }).parse(request.params);
      await loadEmployee(employeeId);

      const body = z
        .object({
          items: z
            .array(
              z.object({
                productId: uuid,
                defaultQty: z.number().int().min(0).max(10_000),
                active: z.boolean().default(true),
              })
            )
            .min(1),
        })
        .parse(request.body);

      // Only subsidy-eligible products may enter an employee standing indent.
      const productIds = body.items.map((i) => i.productId);
      const eligible = await pgClient`
        SELECT r.product_id::text AS id
          FROM employee_subsidy_rules r
          JOIN products p ON p.id = r.product_id AND p.deleted_at IS NULL
         WHERE r.active = true
           AND r.product_id = ANY(${productIds}::uuid[])
      `;
      const eligibleSet = new Set((eligible as any[]).map((r) => r.id));
      const ineligible = productIds.filter((id) => !eligibleSet.has(id));
      if (ineligible.length > 0) {
        return reply.status(400).send({
          error: "Ineligible products",
          message: "Only products with an active employee subsidy rule are allowed",
          ineligibleProductIds: ineligible,
        });
      }

      const rows = body.items.map((it) => ({
        employee_id: employeeId,
        product_id: it.productId,
        default_qty: it.defaultQty,
        active: it.active,
      }));

      await pgClient`
        INSERT INTO employee_standing_indents
          ${pgClient(rows, "employee_id", "product_id", "default_qty", "active")}
        ON CONFLICT (employee_id, product_id) DO UPDATE
          SET default_qty = EXCLUDED.default_qty,
              active      = EXCLUDED.active,
              updated_at  = now()
      `;

      return reply.send({ updated: body.items.length });
    }
  );

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/admin/employees/:employeeId/drafts/:date              │
  // └───────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/admin/employees/:employeeId/drafts/:date",
    { preHandler: [adminAuth, requireRole("indents.view")] },
    async (request, reply) => {
      const { employeeId, date } = z
        .object({ employeeId: uuid, date: isoDate })
        .parse(request.params);
      const employee = await loadEmployee(employeeId);

      // Any non-cancelled order for this date wins (editable only while draft).
      const [order] = await pgClient`
        SELECT id, status::text AS status
          FROM employee_orders
         WHERE employee_id = ${employeeId}
           AND delivery_date = ${date}::date
           AND status <> 'cancelled'
         ORDER BY created_at DESC
         LIMIT 1
      `;

      if (order) {
        const lines = await pgClient`
          SELECT
            oi.product_id            AS "productId",
            oi.product_name          AS "productName",
            oi.quantity              AS "quantity",
            oi.unit_price::numeric   AS "unitPrice",
            oi.gst_percent::numeric  AS "gstPercent",
            oi.line_total::numeric   AS "lineTotal",
            oi.subsidy_percent::numeric AS "subsidyPercent",
            p.icon                   AS "icon",
            p.image_url              AS "imageUrl",
            p.unit                   AS "unit"
          FROM employee_order_items oi
          LEFT JOIN products p ON p.id = oi.product_id
          WHERE oi.employee_order_id = ${order.id}::uuid
          ORDER BY oi.product_name
        `;
        let subtotal = 0;
        let totalGst = 0;
        const items = (lines as any[]).map((l) => {
          const unitPrice = parseFloat(l.unitPrice);
          const gstPct = parseFloat(l.gstPercent);
          const lineSub = round2(unitPrice * l.quantity);
          const lineGst = round2(lineSub * (gstPct / 100));
          subtotal += lineSub;
          totalGst += lineGst;
          return {
            productId: l.productId,
            productName: l.productName,
            quantity: Number(l.quantity),
            unitPrice,
            gstPercent: gstPct,
            subsidyPercent: parseFloat(l.subsidyPercent),
            lineTotal: parseFloat(l.lineTotal),
            icon: l.icon,
            imageUrl: l.imageUrl,
            unit: l.unit,
          };
        });
        const grandTotal = round2(subtotal + totalGst);
        return reply.send({
          employee: { id: employee.id, name: employee.name, code: employee.code },
          deliveryDate: date,
          exists: true,
          orderId: order.id,
          status: order.status,
          editable: order.status === "draft",
          items,
          totals: { subtotal: round2(subtotal), totalGst: round2(totalGst), grandTotal },
          credit: await checkEmployeeCredit(employeeId, grandTotal),
        });
      }

      // No order row — synthesize a preview from the standing indent.
      const standing = await pgClient`
        SELECT
          esi.product_id          AS "productId",
          esi.default_qty         AS "quantity",
          p.name                  AS "productName",
          p.unit                  AS "unit",
          p.icon                  AS "icon",
          p.image_url             AS "imageUrl",
          p.base_price::numeric   AS "basePrice",
          p.gst_percent::numeric  AS "gstPercent",
          r.subsidy_percent::numeric AS "subsidyPercent"
        FROM employee_standing_indents esi
        JOIN products p ON p.id = esi.product_id
                       AND p.deleted_at IS NULL
                       AND p.available = true
        JOIN employee_subsidy_rules r ON r.product_id = esi.product_id AND r.active = true
        WHERE esi.employee_id = ${employeeId}
          AND esi.active = true
          AND esi.default_qty > 0
        ORDER BY p.sort_order, p.name
      `;

      let subtotal = 0;
      let totalGst = 0;
      const items = (standing as any[]).map((r) => {
        const mrp = parseFloat(r.basePrice);
        const subsidyPct = parseFloat(r.subsidyPercent);
        const gstPct = parseFloat(r.gstPercent);
        const line = calcSubsidizedLine(mrp, subsidyPct, gstPct, r.quantity);
        subtotal += line.subtotal;
        totalGst += line.gst;
        return {
          productId: r.productId,
          productName: r.productName,
          quantity: r.quantity,
          unitPrice: line.unitPrice,
          gstPercent: gstPct,
          subsidyPercent: subsidyPct,
          lineTotal: line.total,
          icon: r.icon,
          imageUrl: r.imageUrl,
          unit: r.unit,
        };
      });
      const grandTotal = round2(subtotal + totalGst);

      return reply.send({
        employee: { id: employee.id, name: employee.name, code: employee.code },
        deliveryDate: date,
        exists: false,
        status: "draft",
        editable: true,
        items,
        totals: { subtotal: round2(subtotal), totalGst: round2(totalGst), grandTotal },
        credit: await checkEmployeeCredit(employeeId, grandTotal),
      });
    }
  );

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  PATCH /api/v1/admin/employees/:employeeId/drafts/:date            │
  // │  Bulk-replace the draft's line items (subsidized pricing).         │
  // └───────────────────────────────────────────────────────────────────┘
  app.patch(
    "/api/v1/admin/employees/:employeeId/drafts/:date",
    { preHandler: [adminAuth, requireRole("indents.manage")] },
    async (request, reply) => {
      const { employeeId, date } = z
        .object({ employeeId: uuid, date: isoDate })
        .parse(request.params);
      const employee = await loadEmployee(employeeId);

      const body = z
        .object({
          items: z.array(
            z.object({
              productId: uuid,
              quantity: z.number().int().min(0).max(10_000),
            })
          ),
        })
        .parse(request.body);
      const lineItems = body.items.filter((i) => i.quantity > 0);

      // Reject editing a placed (non-draft) order.
      const [active] = await pgClient`
        SELECT id, status::text AS status FROM employee_orders
         WHERE employee_id = ${employeeId}
           AND delivery_date = ${date}::date
           AND status <> 'cancelled'
         ORDER BY created_at DESC
         LIMIT 1
      `;
      if (active && active.status !== "draft") {
        return reply.status(409).send({
          error: "Order already placed",
          message: "This date's indent is already confirmed and can no longer be edited.",
          status: active.status,
        });
      }

      // Resolve subsidy pricing for every line; reject ineligible products.
      const ruleRows =
        lineItems.length > 0
          ? await pgClient`
              SELECT
                p.id::text             AS "id",
                p.name                 AS "name",
                p.base_price::numeric  AS "basePrice",
                p.gst_percent::numeric AS "gstPercent",
                p.available            AS "available",
                r.subsidy_percent::numeric AS "subsidyPercent"
              FROM employee_subsidy_rules r
              JOIN products p ON p.id = r.product_id AND p.deleted_at IS NULL
              WHERE r.active = true
                AND r.product_id = ANY(${lineItems.map((i) => i.productId)}::uuid[])
            `
          : [];
      const ruleMap = new Map<string, any>((ruleRows as any[]).map((p) => [p.id, p]));

      for (const it of lineItems) {
        const p = ruleMap.get(it.productId);
        if (!p) {
          return reply.status(400).send({
            error: "Ineligible product",
            message: "Product has no active employee subsidy rule",
            productId: it.productId,
          });
        }
        if (!p.available) {
          return reply.status(400).send({
            error: "Product unavailable",
            productId: it.productId,
            productName: p.name,
          });
        }
      }

      let subtotal = 0;
      let totalGst = 0;
      let itemCount = 0;
      const orderItemsRows = lineItems.map((it) => {
        const p = ruleMap.get(it.productId);
        const mrp = parseFloat(p.basePrice);
        const subsidyPct = parseFloat(p.subsidyPercent);
        const gstPct = parseFloat(p.gstPercent);
        const line = calcSubsidizedLine(mrp, subsidyPct, gstPct, it.quantity);
        subtotal += line.subtotal;
        totalGst += line.gst;
        itemCount += it.quantity;
        return {
          productId: it.productId,
          productName: p.name,
          quantity: it.quantity,
          unitPrice: line.unitPrice.toFixed(2),
          gstPercent: gstPct.toFixed(2),
          gstAmount: line.gst.toFixed(2),
          lineTotal: line.total.toFixed(2),
          subsidyPercent: subsidyPct.toFixed(2),
          mrpReference: mrp.toFixed(2),
        };
      });
      const grandTotal = round2(subtotal + totalGst);

      const orderId = await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        const [existing] = await tx`
          SELECT id FROM employee_orders
           WHERE employee_id = ${employeeId}
             AND delivery_date = ${date}::date
             AND status = 'draft'
           ORDER BY created_at DESC
           LIMIT 1
        `;

        let id: string;
        if (existing) {
          await tx`
            UPDATE employee_orders SET
              subtotal    = ${subtotal.toFixed(2)}::numeric,
              total_gst   = ${totalGst.toFixed(2)}::numeric,
              grand_total = ${grandTotal.toFixed(2)}::numeric,
              item_count  = ${itemCount},
              updated_at  = now()
            WHERE id = ${existing.id}::uuid
          `;
          await tx`DELETE FROM employee_order_items WHERE employee_order_id = ${existing.id}::uuid`;
          id = existing.id;
        } else {
          const [created] = await tx`
            INSERT INTO employee_orders (
              employee_id, route_id, status, payment_mode,
              subtotal, total_gst, grand_total, item_count,
              delivery_date, placed_by
            ) VALUES (
              ${employeeId}, ${employee.routeId}, 'draft', 'credit',
              ${subtotal.toFixed(2)}::numeric,
              ${totalGst.toFixed(2)}::numeric,
              ${grandTotal.toFixed(2)}::numeric,
              ${itemCount},
              ${date}::date,
              ${adminUserId(request)}
            )
            RETURNING id
          `;
          id = created!.id;
        }

        for (const oi of orderItemsRows) {
          await tx`
            INSERT INTO employee_order_items (
              employee_order_id, product_id, product_name, quantity,
              unit_price, gst_percent, gst_amount, line_total,
              subsidy_percent, mrp_reference
            ) VALUES (
              ${id}::uuid, ${oi.productId}::uuid, ${oi.productName},
              ${oi.quantity}, ${oi.unitPrice}::numeric, ${oi.gstPercent}::numeric,
              ${oi.gstAmount}::numeric, ${oi.lineTotal}::numeric,
              ${oi.subsidyPercent}::numeric, ${oi.mrpReference}::numeric
            )
          `;
        }
        return id;
      });

      return reply.send({
        orderId,
        deliveryDate: date,
        status: "draft",
        itemCount,
        totals: { subtotal: round2(subtotal), totalGst: round2(totalGst), grandTotal },
      });
    }
  );

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  POST /api/v1/admin/employees/:employeeId/drafts/:date/confirm     │
  // │  Place the draft + write the employee_ledger debit. Over-limit and │
  // │  not forced → park as 'payment_required' for finance to release.   │
  // └───────────────────────────────────────────────────────────────────┘
  app.post(
    "/api/v1/admin/employees/:employeeId/drafts/:date/confirm",
    { preHandler: [adminAuth, requireRole("indents.manage")] },
    async (request, reply) => {
      const { employeeId, date } = z
        .object({ employeeId: uuid, date: isoDate })
        .parse(request.params);
      await loadEmployee(employeeId);

      const body = z.object({ force: z.boolean().default(false) }).parse(request.body ?? {});

      const [order] = await pgClient`
        SELECT id, status::text AS status,
               grand_total::numeric AS grand_total, item_count
          FROM employee_orders
         WHERE employee_id = ${employeeId}
           AND delivery_date = ${date}::date
           AND status <> 'cancelled'
         ORDER BY created_at DESC
         LIMIT 1
      `;

      if (!order) {
        return reply.status(404).send({
          error: "No draft to confirm",
          message: "There is no draft for this date yet. Edit the items first.",
        });
      }

      if (order.status !== "draft" && order.status !== "payment_required") {
        return reply.send({
          orderId: order.id,
          status: order.status,
          deliveryDate: date,
          alreadyConfirmed: true,
        });
      }

      if (order.item_count === 0) {
        return reply.status(400).send({
          error: "Empty draft",
          message: "Cannot confirm an empty draft. Add items first.",
        });
      }

      const grandTotal = parseFloat(order.grand_total);
      const credit = await checkEmployeeCredit(employeeId, grandTotal);

      if (!credit.sufficient && !body.force) {
        await pgClient`
          UPDATE employee_orders
             SET status = 'payment_required', updated_at = now()
           WHERE id = ${order.id}::uuid
        `;
        return reply.status(402).send({
          error: "Credit limit exceeded",
          message: `Draft is over the employee's available credit by ₹${credit.shortfall.toFixed(
            2
          )}. Finance can release it, or re-send with { "force": true }.`,
          orderId: order.id,
          credit,
        });
      }

      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        await tx`
          UPDATE employee_orders
             SET status       = 'confirmed',
                 payment_mode = 'credit',
                 confirmed_at = now(),
                 updated_at   = now()
           WHERE id = ${order.id}::uuid
        `;

        const [bal] = await tx`
          SELECT
            COALESCE(e.opening_balance, 0)
            + COALESCE((SELECT SUM(CASE WHEN el.type = 'credit'
                                         AND COALESCE(el.voucher_type,'') <> 'Opening'
                                        THEN el.amount ELSE 0 END)
                          FROM employee_ledger el WHERE el.employee_id = e.id), 0)
            - COALESCE((SELECT SUM(CASE WHEN el.type = 'debit'
                                         AND COALESCE(el.voucher_type,'') <> 'Opening'
                                        THEN el.amount ELSE 0 END)
                          FROM employee_ledger el WHERE el.employee_id = e.id), 0)
            AS bal
          FROM employees e WHERE e.id = ${employeeId}
        `;
        const balanceAfter = parseFloat(bal!.bal) - grandTotal;

        await tx`
          INSERT INTO employee_ledger
            (employee_id, type, amount,
             reference_id, reference_type,
             voucher_type, voucher_date,
             description, balance_after, performed_by)
          VALUES
            (${employeeId}, 'debit', ${grandTotal.toFixed(2)}::numeric,
             ${order.id}, 'order',
             'Invoice', now()::date,
             ${"Employee standing-indent order " + order.id},
             ${balanceAfter.toFixed(2)}::numeric,
             ${adminUserId(request)})
        `;
      });

      return reply.send({
        orderId: order.id,
        status: "confirmed",
        deliveryDate: date,
        credit,
        forced: !credit.sufficient && body.force,
      });
    }
  );
}
