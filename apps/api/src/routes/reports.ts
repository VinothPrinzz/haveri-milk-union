import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationMeta, offsetFromPage } from "../lib/pagination.js";

// Reports need larger page sizes than the shared paginationSchema allows (max 100).
// Using a local schema with max(1000) because report tables can legitimately render
// hundreds of rows per visual page (Gate Pass, Adhoc).
const reportPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

export async function reportsRoutes(app: FastifyInstance) {
  // ════════════════════════════════════════════
  // A1. Route Sheet — 1 page per active route
  // Filters: batch (optional), date (required)
  // Sources: dealer orders + employee-subsidy direct sales
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/route-sheet",
    { preHandler: [adminAuth, requireRole("reports.view")] },
    async (request, reply) => {
      const qs = z.object({
        date: z.string(),
        batchId: z.string().uuid().optional(),
      });
      const q = qs.parse(request.query);
      const batchId = q.batchId ?? null;
      const NIL = "00000000-0000-0000-0000-000000000000";
 
      // ── 1. All active products ──
      const prodRows = await pgClient`
        SELECT p.id, p.code, p.report_alias, p.name,
               p.print_direction, p.packets_crate,
               p.pack_size, p.unit, p.sort_order,
               c.name AS category_name
          FROM products p
          JOIN categories c ON c.id = p.category_id
         WHERE p.deleted_at IS NULL
           AND p.available  = true
         ORDER BY
           CASE LOWER(c.name)
             WHEN 'milk' THEN 1
             WHEN 'curd' THEN 2
             ELSE 3
           END,
           p.sort_order, p.name
      `;
 
      // ── 2. Bucketing: across vs others by print_direction ──
      const acrossEligible = (prodRows as any[]).filter(
        p => (p.print_direction ?? "").trim().toLowerCase() === "across"
      );
 
      const acrossProducts = acrossEligible.map(p => ({
        id: p.id,
        code: p.code ?? "",
        reportAlias: p.report_alias ?? p.name,
        category: p.category_name,
        packetsCrate: Number(p.packets_crate) || 0,
        packSize: parseFloat(p.pack_size) || 0,
        unit: p.unit ?? "",
      }));
      const acrossIds = new Set(acrossProducts.map(p => p.id));
 
      const otherProducts = (prodRows as any[])
        .filter(p => !acrossIds.has(p.id))
        .map(p => ({
          id: p.id,
          code: p.code ?? "",
          reportAlias: p.report_alias ?? p.name,
          category: p.category_name,
          packetsCrate: Number(p.packets_crate) || 0,
          packSize: parseFloat(p.pack_size) || 0,
          unit: p.unit ?? "",
        }));
 
      type ProdMeta = {
        id: string; alias: string; packetsCrate: number;
        packSize: number; unit: string; sortOrder: number;
      };
      const productMeta = new Map<string, ProdMeta>();
      for (const p of prodRows as any[]) {
        productMeta.set(p.id, {
          id: p.id,
          alias: p.report_alias ?? p.name,
          packetsCrate: Number(p.packets_crate) || 0,
          packSize: parseFloat(p.pack_size) || 0,
          unit: p.unit ?? "",
          sortOrder: Number(p.sort_order) || 0,
        });
      }
 
      // ── 3. Batch metadata (if any) ──
      let batch: any = null;
      if (batchId) {
        const [b] = await pgClient`
          SELECT id, name, batch_number
            FROM batches
           WHERE id = ${batchId} AND deleted_at IS NULL
        `;
        if (b) batch = {
          id: b.id, name: b.name, batchNumber: b.batch_number,
        };
      }
 
      // ── 4. Routes that have a dealer order OR an employee-subsidy
      //     sale on the date. Batch filter narrows the ROUTE SET via
      //     the batch_routes junction. ──
      const routes = await pgClient`
        SELECT r.id, r.code, r.name,
               r.contractor_id, r.dispatch_time,
               ct.name           AS contractor_name,
               ct.vehicle_number AS vehicle_number,
               b.name            AS batch_name,
               b.batch_number    AS batch_code
          FROM routes r
          LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
          LEFT JOIN batches b      ON b.id = r.primary_batch_id AND b.deleted_at IS NULL
         WHERE r.deleted_at IS NULL
           AND (${batchId}::uuid IS NULL
                OR EXISTS (SELECT 1 FROM batch_routes br
                            WHERE br.route_id = r.id
                              AND br.batch_id = ${batchId ?? NIL}::uuid))
           AND (
             EXISTS (
               SELECT 1
                 FROM orders o
                 JOIN dealers d ON d.id = o.dealer_id
                WHERE o.created_at::date = ${q.date}::date
                  AND o.status != 'cancelled'
                  AND d.route_id = r.id
             )
             OR EXISTS (
               SELECT 1
                 FROM direct_sales ds
                WHERE ds.customer_type = 'employee_subsidy'
                  AND ds.sale_date = ${q.date}::date
                  AND ds.route_id = r.id
             )
           )
         ORDER BY r.code
      `;
 
      if ((routes as any[]).length === 0) {
        return reply.send({
          date: q.date,
          batch,
          acrossProducts,
          otherProducts,
          routes: [],
        });
      }
      const routeIds = (routes as any[]).map(r => r.id);
 
      // ── 5. Dealers on those routes ──
      // Pull position from dealer_routes for the dealer's primary route
      // so the printed sheet matches the delivery driver's actual path.
      const dealers = await pgClient`
        SELECT d.id, d.code, d.name, d.route_id,
               dr.position AS position
          FROM dealers d
          JOIN dealer_routes dr
            ON dr.dealer_id = d.id
           AND dr.route_id  = d.route_id      -- primary route only
         WHERE d.deleted_at IS NULL
           AND d.route_id = ANY(${routeIds}::uuid[])
         ORDER BY dr.route_id, dr.position NULLS LAST, d.code, d.name
      `;
 
      // ── 6. Dealer order items for the day ──
      const itemRows = await pgClient`
        SELECT o.id AS order_id, o.dealer_id, d.route_id,
               oi.product_id, oi.quantity::int AS qty,
               oi.line_total::numeric AS amount
          FROM orders o
          JOIN dealers d      ON d.id = o.dealer_id
          JOIN order_items oi ON oi.order_id = o.id
         WHERE o.created_at::date = ${q.date}::date
           AND o.status != 'cancelled'
           AND d.route_id = ANY(${routeIds}::uuid[])
      `;
 
      // ── 6b. Employee-subsidy sale items for the day ──
      // Customer is an employee; route comes from direct_sales.route_id;
      // ordering position comes from employees.route_position.
      const empItemRows = await pgClient`
        SELECT ds.route_id,
               ds.customer_id            AS employee_id,
               e.employee_code           AS employee_code,
               e.name                    AS employee_name,
               e.route_position          AS route_position,
               dsi.product_id,
               dsi.quantity::int         AS qty,
               dsi.line_total::numeric   AS amount
          FROM direct_sales ds
          JOIN employees e            ON e.id = ds.customer_id
          JOIN direct_sale_items dsi  ON dsi.direct_sale_id = ds.id
         WHERE ds.customer_type = 'employee_subsidy'
           AND ds.sale_date = ${q.date}::date
           AND ds.route_id = ANY(${routeIds}::uuid[])
      `;
 
      // ── 7. Aggregate per (route, customer, product) and per (route, productKey) ──
      // A "customer" is a dealer OR an employee. routeProductAgg is keyed
      // by productKey: the raw product_id for dealer lines, and
      // `${product_id}:sub` for employee-subsidy lines, so the abstract
      // keeps subsidy quantities on their own rows.
      type CustomerAgg = {
        id: string; code: string; name: string;
        isEmployee: boolean;
        position: number;
        acrossQty: Record<string, number>;
        othersItems: Array<{ productId: string; alias: string; qty: number; sortOrder: number }>;
        othersQty: number;
        netAmount: number;
        crates: number;
      };
      const byRoute = new Map<string, Map<string, CustomerAgg>>();
      const routeProductAgg = new Map<string, Map<string, { qty: number; amount: number }>>();
 
      for (const r of routes as any[]) {
        byRoute.set(r.id, new Map());
        routeProductAgg.set(r.id, new Map());
      }
 
      // 7a. Seed dealer rows (so a dealer with no items still has a slot).
      for (const d of dealers as any[]) {
        byRoute.get(d.route_id)?.set(d.id, {
          id: d.id, code: d.code ?? "", name: d.name,
          isEmployee: false,
          position: Number(d.position) || 9999,
          acrossQty: Object.fromEntries(acrossProducts.map(p => [p.id, 0])),
          othersItems: [],
          othersQty: 0,
          netAmount: 0,
          crates: 0,
        });
      }
 
      // 7b. Fold in dealer order items.
      for (const it of itemRows as any[]) {
        const customer = byRoute.get(it.route_id)?.get(it.dealer_id);
        if (!customer) continue;
        const meta = productMeta.get(it.product_id);
        if (!meta) continue;
 
        const qty = Number(it.qty) || 0;
        const amt = parseFloat(it.amount) || 0;
 
        const rmap = routeProductAgg.get(it.route_id)!;
        const cur = rmap.get(it.product_id) ?? { qty: 0, amount: 0 };
        cur.qty += qty;
        cur.amount = round2(cur.amount + amt);
        rmap.set(it.product_id, cur);
 
        if (acrossIds.has(it.product_id)) {
          customer.acrossQty[it.product_id] = (customer.acrossQty[it.product_id] ?? 0) + qty;
        } else {
          customer.othersItems.push({
            productId: it.product_id,
            alias: meta.alias,
            qty,
            sortOrder: meta.sortOrder,
          });
          customer.othersQty += qty;
        }
        customer.netAmount = round2(customer.netAmount + amt);
 
        if (meta.packetsCrate > 0) {
          customer.crates += Math.round(qty / meta.packetsCrate);
        }
      }
 
      // 7c. Fold in employee-subsidy items.
      //     Employee rows are created lazily. Every subsidy line goes
      //     into othersItems with a "(Sub)" alias and is aggregated in
      //     routeProductAgg under the `${pid}:sub` key.
      for (const it of empItemRows as any[]) {
        const customers = byRoute.get(it.route_id);
        if (!customers) continue;
        const meta = productMeta.get(it.product_id);
        if (!meta) continue;
 
        let customer = customers.get(it.employee_id);
        if (!customer) {
          customer = {
            id: it.employee_id,
            code: it.employee_code ?? "",   // PF number
            name: it.employee_name ?? "",
            isEmployee: true,
            position: Number(it.route_position) || 9999,
            acrossQty: Object.fromEntries(acrossProducts.map(p => [p.id, 0])),
            othersItems: [],
            othersQty: 0,
            netAmount: 0,
            crates: 0,
          };
          customers.set(it.employee_id, customer);
        }
 
        const qty = Number(it.qty) || 0;
        const amt = parseFloat(it.amount) || 0;
 
        const subKey = `${it.product_id}:sub`;
        const rmap = routeProductAgg.get(it.route_id)!;
        const cur = rmap.get(subKey) ?? { qty: 0, amount: 0 };
        cur.qty += qty;
        cur.amount = round2(cur.amount + amt);
        rmap.set(subKey, cur);
 
        // Subsidy lines never enter the across columns — always Others.
        customer.othersItems.push({
          productId: subKey,
          alias: `${meta.alias} (Sub)`,
          qty,
          sortOrder: meta.sortOrder + 0.5,   // sits just after its base product
        });
        customer.othersQty += qty;
        customer.netAmount = round2(customer.netAmount + amt);
 
        if (meta.packetsCrate > 0) {
          customer.crates += Math.round(qty / meta.packetsCrate);
        }
      }
 
      // ── 8. Shape per-route output ──
      const routesOut: any[] = [];
      for (const r of routes as any[]) {
        const map = byRoute.get(r.id)!;
        const allRows = Array.from(map.values());
        const activeRows = allRows.filter(d =>
          d.othersQty > 0 || Object.values(d.acrossQty).some(qv => qv > 0)
        );
        if (activeRows.length === 0) continue;
 
        // FIX: order by route position (NOT alphabetically). Dealers use
        // dealer_routes.position; employees use employees.route_position.
        // Ties break on code then name.
        activeRows.sort((a, b) =>
          (a.position - b.position)
          || (a.code || "").localeCompare(b.code || "")
          || a.name.localeCompare(b.name)
        );
 
        const customers = activeRows.map((d, idx) => {
          const collapsed = new Map<string, { alias: string; qty: number; sortOrder: number }>();
          for (const it of d.othersItems) {
            const cur = collapsed.get(it.productId);
            if (cur) cur.qty += it.qty;
            else collapsed.set(it.productId, { alias: it.alias, qty: it.qty, sortOrder: it.sortOrder });
          }
          const othersList = Array.from(collapsed.values())
            .filter(x => x.qty > 0)
            .sort((a, b) => a.sortOrder - b.sortOrder);
 
          return {
            sl: idx + 1,
            id: d.id,
            code: d.code,
            name: d.name,
            isEmployee: d.isEmployee,
            acrossQty: d.acrossQty,
            othersText: othersList.map(x => `${x.alias} × ${x.qty}`).join(", "),
            othersQty: d.othersQty,
            netAmount: round2(d.netAmount),
            crates: d.crates,
          };
        });
 
        const totals = {
          acrossQty: Object.fromEntries(
            acrossProducts.map(p => [
              p.id,
              customers.reduce((s, c) => s + (c.acrossQty[p.id] ?? 0), 0),
            ])
          ),
          othersQty:      customers.reduce((s, c) => s + c.othersQty, 0),
          netAmount:      round2(customers.reduce((s, c) => s + c.netAmount, 0)),
          crates:         customers.reduce((s, c) => s + c.crates, 0),
          totalAcrossQty: customers.reduce((s, c) =>
            s + Object.values(c.acrossQty).reduce((a: number, b: number) => a + b, 0), 0),
          totalAllQty:    customers.reduce((s, c) =>
            s + Object.values(c.acrossQty).reduce((a: number, b: number) => a + b, 0) + c.othersQty, 0),
        };
 
        // ── Abstract: per-productKey breakdown (dealer + "(Sub)" lines) ──
        const rmap = routeProductAgg.get(r.id)!;
        const abstractItems: any[] = [];
        for (const [key, agg] of rmap.entries()) {
          if (agg.qty === 0) continue;
          const isSub = key.endsWith(":sub");
          const realPid = isSub ? key.slice(0, -4) : key;
          const meta = productMeta.get(realPid);
          if (!meta) continue;
          const pc = meta.packetsCrate;
          let crates = 0, pktPlus = 0, pktMinus = 0;
          if (pc > 0) {
            crates = Math.round(agg.qty / pc);
            const diff = agg.qty - crates * pc;
            if (diff > 0) pktPlus = diff;
            else if (diff < 0) pktMinus = -diff;
          } else {
            pktPlus = agg.qty;
          }
          abstractItems.push({
            productId:    key,
            alias:        isSub ? `${meta.alias} (Sub)` : meta.alias,
            sortOrder:    isSub ? meta.sortOrder + 0.5 : meta.sortOrder,
            packetsCrate: pc,
            packSize:     meta.packSize,
            unit:         meta.unit,
            crates,
            packets:      agg.qty,
            kgLtr:        round2(agg.qty * meta.packSize),
            amount:       agg.amount,
            pktPlus,
            pktMinus,
          });
        }
        abstractItems.sort((a, b) => a.sortOrder - b.sortOrder);
 
        const abstract = {
          items: abstractItems,
          totals: {
            packets:  abstractItems.reduce((s, i) => s + i.packets, 0),
            kgLtr:    round2(abstractItems.reduce((s, i) => s + i.kgLtr, 0)),
            amount:   round2(abstractItems.reduce((s, i) => s + i.amount, 0)),
            crates:   abstractItems.reduce((s, i) => s + i.crates, 0),
            pktPlus:  abstractItems.reduce((s, i) => s + i.pktPlus, 0),
            pktMinus: abstractItems.reduce((s, i) => s + i.pktMinus, 0),
          },
        };
 
        routesOut.push({
          id: r.id,
          code: r.code,
          name: r.name,
          contractor: {
            id:            r.contractor_id ?? null,
            name:          r.contractor_name ?? null,
            vehicleNumber: r.vehicle_number ?? null,
          },
          dispatchTime: r.dispatch_time ?? null,
          batchName: r.batch_name ?? null,
          batchCode: r.batch_code ?? null,
          customers,
          totals,
          abstract,
        });
      }
 
      return reply.send({
        date: q.date,
        batch,
        acrossProducts,
        otherProducts,
        routes: routesOut,
      });
    }
  );

  // ════════════════════════════════════════════
  // A2. Gate Pass Report — route-sheet layout, agent gate passes
  // Filters: date (required), batchId (optional), routeId (optional)
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/gate-pass",
    { preHandler: [adminAuth, requireRole("reports.view")] },
    async (request, reply) => {
      const qs = z.object({
        date: z.string(),
        batchId: z.string().uuid().optional(),
        routeId: z.string().uuid().optional(),
      });
      const q = qs.parse(request.query);
      const batchId = q.batchId ?? null;
      const routeId = q.routeId ?? null;
      const NIL = "00000000-0000-0000-0000-000000000000";
 
      // ── 1. All active products — identical bucketing to Route Sheet ──
      const prodRows = await pgClient`
        SELECT p.id, p.code, p.report_alias, p.name,
               p.print_direction, p.packets_crate,
               p.pack_size, p.unit, p.sort_order,
               c.name AS category_name
          FROM products p
          JOIN categories c ON c.id = p.category_id
         WHERE p.deleted_at IS NULL
           AND p.available  = true
         ORDER BY
           CASE LOWER(c.name)
             WHEN 'milk' THEN 1
             WHEN 'curd' THEN 2
             ELSE 3
           END,
           p.sort_order, p.name
      `;
 
      const acrossEligible = (prodRows as any[]).filter(
        p => (p.print_direction ?? "").trim().toLowerCase() === "across"
      );
 
      const acrossProducts = acrossEligible.map(p => ({
        id: p.id,
        code: p.code ?? "",
        reportAlias: p.report_alias ?? p.name,
        category: p.category_name,
        packetsCrate: Number(p.packets_crate) || 0,
        packSize: parseFloat(p.pack_size) || 0,
        unit: p.unit ?? "",
      }));
      const acrossIds = new Set(acrossProducts.map(p => p.id));
 
      const otherProducts = (prodRows as any[])
        .filter(p => !acrossIds.has(p.id))
        .map(p => ({
          id: p.id,
          code: p.code ?? "",
          reportAlias: p.report_alias ?? p.name,
          category: p.category_name,
          packetsCrate: Number(p.packets_crate) || 0,
          packSize: parseFloat(p.pack_size) || 0,
          unit: p.unit ?? "",
        }));
 
      type ProdMeta = {
        id: string; alias: string; packetsCrate: number;
        packSize: number; unit: string; sortOrder: number;
      };
      const productMeta = new Map<string, ProdMeta>();
      for (const p of prodRows as any[]) {
        productMeta.set(p.id, {
          id: p.id,
          alias: p.report_alias ?? p.name,
          packetsCrate: Number(p.packets_crate) || 0,
          packSize: parseFloat(p.pack_size) || 0,
          unit: p.unit ?? "",
          sortOrder: Number(p.sort_order) || 0,
        });
      }
 
      // ── 2. Batch metadata (if filtered) ──
      let batch: any = null;
      if (batchId) {
        const [b] = await pgClient`
          SELECT id, name, batch_number
            FROM batches
           WHERE id = ${batchId} AND deleted_at IS NULL
        `;
        if (b) batch = { id: b.id, name: b.name, batchNumber: b.batch_number };
      }
 
      // ── 3. Routes that have an agent gate pass on the date ──
      //     direct_sales carries route_id directly — no junction needed.
      const routes = await pgClient`
        SELECT r.id, r.code, r.name,
               r.contractor_id, r.dispatch_time,
               ct.name           AS contractor_name,
               ct.vehicle_number AS vehicle_number,
               b.name            AS batch_name,
               b.batch_number    AS batch_code
          FROM routes r
          LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
          LEFT JOIN batches b      ON b.id = r.primary_batch_id AND b.deleted_at IS NULL
         WHERE r.deleted_at IS NULL
           AND (${routeId}::uuid IS NULL OR r.id = ${routeId ?? NIL}::uuid)
           AND EXISTS (
             SELECT 1
               FROM direct_sales ds
              WHERE ds.customer_type = 'agent'
                AND ds.sale_date = ${q.date}::date
                AND ds.route_id  = r.id
                AND (${batchId}::uuid IS NULL
                     OR ds.batch_id = ${batchId ?? NIL}::uuid)
           )
         ORDER BY r.code
      `;
 
      if ((routes as any[]).length === 0) {
        return reply.send({
          date: q.date,
          batch,
          acrossProducts,
          otherProducts,
          routes: [],
        });
      }
      const routeIds = (routes as any[]).map(r => r.id);
 
      // ── 4. Gate pass line items for the day on those routes ──
      //     The "customer" is the agent: a dealers row referenced by
      //     direct_sales.customer_id when customer_type = 'agent'.
      const itemRows = await pgClient`
        SELECT ds.route_id,
               ds.customer_id          AS agent_id,
               d.code                  AS agent_code,
               d.name                  AS agent_name,
               dsi.product_id,
               dsi.quantity::int       AS qty,
               dsi.line_total::numeric AS amount
          FROM direct_sales ds
          JOIN dealers d             ON d.id = ds.customer_id
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
         WHERE ds.customer_type = 'agent'
           AND ds.sale_date = ${q.date}::date
           AND ds.route_id = ANY(${routeIds}::uuid[])
           AND (${batchId}::uuid IS NULL
                OR ds.batch_id = ${batchId ?? NIL}::uuid)
      `;
 
      // ── 5. Aggregate per (route, agent, product) and per (route, product) ──
      type AgentAgg = {
        id: string; code: string; name: string;
        acrossQty: Record<string, number>;
        othersItems: Array<{ productId: string; alias: string; qty: number; sortOrder: number }>;
        othersQty: number;
        netAmount: number;
        crates: number;
      };
      const byRoute = new Map<string, Map<string, AgentAgg>>();
      const routeProductAgg = new Map<string, Map<string, { qty: number; amount: number }>>();
 
      for (const r of routes as any[]) {
        byRoute.set(r.id, new Map());
        routeProductAgg.set(r.id, new Map());
      }
 
      for (const it of itemRows as any[]) {
        const agents = byRoute.get(it.route_id);
        if (!agents) continue;
        const meta = productMeta.get(it.product_id);
        if (!meta) continue;
 
        // Agent rows are created lazily on first item — an agent can
        // hold several gate passes in a day; they collapse into one row.
        let agent = agents.get(it.agent_id);
        if (!agent) {
          agent = {
            id: it.agent_id,
            code: it.agent_code ?? "",
            name: it.agent_name ?? "",
            acrossQty: Object.fromEntries(acrossProducts.map(p => [p.id, 0])),
            othersItems: [],
            othersQty: 0,
            netAmount: 0,
            crates: 0,
          };
          agents.set(it.agent_id, agent);
        }
 
        const qty = Number(it.qty) || 0;
        const amt = parseFloat(it.amount) || 0;
 
        const rmap = routeProductAgg.get(it.route_id)!;
        const cur = rmap.get(it.product_id) ?? { qty: 0, amount: 0 };
        cur.qty += qty;
        cur.amount = round2(cur.amount + amt);
        rmap.set(it.product_id, cur);
 
        if (acrossIds.has(it.product_id)) {
          agent.acrossQty[it.product_id] = (agent.acrossQty[it.product_id] ?? 0) + qty;
        } else {
          agent.othersItems.push({
            productId: it.product_id,
            alias: meta.alias,
            qty,
            sortOrder: meta.sortOrder,
          });
          agent.othersQty += qty;
        }
        agent.netAmount = round2(agent.netAmount + amt);
 
        if (meta.packetsCrate > 0) {
          agent.crates += Math.round(qty / meta.packetsCrate);
        }
      }
 
      // ── 6. Shape per-route output — identical to Route Sheet ──
      const routesOut: any[] = [];
      for (const r of routes as any[]) {
        const map = byRoute.get(r.id)!;
        const allRows = Array.from(map.values());
        const activeRows = allRows.filter(d =>
          d.othersQty > 0 || Object.values(d.acrossQty).some(qv => qv > 0)
        );
        if (activeRows.length === 0) continue;
 
        activeRows.sort((a, b) =>
          (a.code || "").localeCompare(b.code || "")
          || a.name.localeCompare(b.name)
        );
 
        const customers = activeRows.map((d, idx) => {
          const collapsed = new Map<string, { alias: string; qty: number; sortOrder: number }>();
          for (const it of d.othersItems) {
            const cur = collapsed.get(it.productId);
            if (cur) cur.qty += it.qty;
            else collapsed.set(it.productId, { alias: it.alias, qty: it.qty, sortOrder: it.sortOrder });
          }
          const othersList = Array.from(collapsed.values())
            .filter(x => x.qty > 0)
            .sort((a, b) => a.sortOrder - b.sortOrder);
 
          return {
            sl: idx + 1,
            id: d.id,
            code: d.code,
            name: d.name,
            acrossQty: d.acrossQty,
            othersText: othersList.map(x => `${x.alias} × ${x.qty}`).join(", "),
            othersQty: d.othersQty,
            netAmount: round2(d.netAmount),
            crates: d.crates,
          };
        });
 
        const totals = {
          acrossQty: Object.fromEntries(
            acrossProducts.map(p => [
              p.id,
              customers.reduce((s, c) => s + (c.acrossQty[p.id] ?? 0), 0),
            ])
          ),
          othersQty:      customers.reduce((s, c) => s + c.othersQty, 0),
          netAmount:      round2(customers.reduce((s, c) => s + c.netAmount, 0)),
          crates:         customers.reduce((s, c) => s + c.crates, 0),
          totalAcrossQty: customers.reduce((s, c) =>
            s + Object.values(c.acrossQty).reduce((a: number, b: number) => a + b, 0), 0),
          totalAllQty:    customers.reduce((s, c) =>
            s + Object.values(c.acrossQty).reduce((a: number, b: number) => a + b, 0) + c.othersQty, 0),
        };
 
        // ── Abstract: per-product breakdown (across + others) ──
        const rmap = routeProductAgg.get(r.id)!;
        const abstractItems: any[] = [];
        for (const [pid, agg] of rmap.entries()) {
          if (agg.qty === 0) continue;
          const meta = productMeta.get(pid)!;
          const pc = meta.packetsCrate;
          let crates = 0, pktPlus = 0, pktMinus = 0;
          if (pc > 0) {
            crates = Math.round(agg.qty / pc);
            const diff = agg.qty - crates * pc;
            if (diff > 0) pktPlus = diff;
            else if (diff < 0) pktMinus = -diff;
          } else {
            pktPlus = agg.qty;
          }
          abstractItems.push({
            productId:    pid,
            alias:        meta.alias,
            sortOrder:    meta.sortOrder,
            packetsCrate: pc,
            packSize:     meta.packSize,
            unit:         meta.unit,
            crates,
            packets:      agg.qty,
            kgLtr:        round2(agg.qty * meta.packSize),
            amount:       agg.amount,
            pktPlus,
            pktMinus,
          });
        }
        abstractItems.sort((a, b) => a.sortOrder - b.sortOrder);
 
        const abstract = {
          items: abstractItems,
          totals: {
            packets:  abstractItems.reduce((s, i) => s + i.packets, 0),
            kgLtr:    round2(abstractItems.reduce((s, i) => s + i.kgLtr, 0)),
            amount:   round2(abstractItems.reduce((s, i) => s + i.amount, 0)),
            crates:   abstractItems.reduce((s, i) => s + i.crates, 0),
            pktPlus:  abstractItems.reduce((s, i) => s + i.pktPlus, 0),
            pktMinus: abstractItems.reduce((s, i) => s + i.pktMinus, 0),
          },
        };
 
        routesOut.push({
          id: r.id,
          code: r.code,
          name: r.name,
          contractor: {
            id:            r.contractor_id ?? null,
            name:          r.contractor_name ?? null,
            vehicleNumber: r.vehicle_number ?? null,
          },
          dispatchTime: r.dispatch_time ?? null,
          batchName: r.batch_name ?? null,
          batchCode: r.batch_code ?? null,
          customers,
          totals,
          abstract,
        });
      }
 
      return reply.send({
        date: q.date,
        batch,
        acrossProducts,
        otherProducts,
        routes: routesOut,
      });
    }
  );
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}