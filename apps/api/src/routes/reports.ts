import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationMeta, offsetFromPage } from "../lib/pagination.js";
import { isCreditInstitutionType, isCreditSupplyOrder } from "../lib/credit-check.js";
import { displayRouteCode } from "../lib/route-code.js";

// Reports need larger page sizes than the shared paginationSchema allows (max 100).
// Using a local schema with max(1000) because report tables can legitimately render
// hundreds of rows per visual page (Gate Pass, Adhoc).
const reportPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

// Adhoc sales that name NO route — cash counter, VIP samples, the employee
// ghee subsidy and gate passes issued without a route are all handed over at
// the plant, so there is no vehicle to put them on. The goods still leave FGS,
// so the Route Sheet prints them as one extra page under this sentinel "route"
// instead of dropping them (the same bucket the Dispatch Sheet shows). The nil
// UUID can never collide with a real routes.id — gen_random_uuid never
// returns it.
const ADHOC_ROUTE_ID = "00000000-0000-0000-0000-000000000000";

export async function reportsRoutes(app: FastifyInstance) {
  // ════════════════════════════════════════════
  // A1. Route Sheet — 1 page per active route, plus one ADHOC page
  // Filters: batch (optional), date (required)
  // Sources: dealer orders + employee indents + adhoc counter sales
  //          (cash / VIP sample / employee subsidy / gate pass) that
  //          named no route
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/route-sheet",
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
 
      // ── 1. All active products ──
      const prodRows = await pgClient`
        SELECT p.id, p.code, p.report_alias, p.name,
               p.print_direction, p.packets_crate,
               p.pack_size, p.unit, p.sort_order, p.abstract_position,
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
        abstractPosition: Number(p.abstract_position) || 0,
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
        abstractPosition: number; category: string;
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
          abstractPosition: Number(p.abstract_position) || 0,
          category: p.category_name ?? "",
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
      //
      // Deliberately NOT filtered on r.deleted_at: the sheet is the record of
      // what a given day dispatched, and deleting a route today cannot unmake
      // the deliveries it carried last month. The EXISTS clauses below already
      // limit the list to routes that actually sold on the date, so a deleted
      // route only reappears on the dates it really ran. Its code is given up
      // on delete (see lib/route-code.ts), so it prints by name.
      const routes = await pgClient`
        SELECT r.id, r.code, r.name,
               r.contractor_id, r.dispatch_time,
               (r.deleted_at IS NOT NULL) AS retired,
               ct.name           AS contractor_name,
               ct.vehicle_number AS vehicle_number,
               b.name            AS batch_name,
               b.batch_number    AS batch_code
          FROM routes r
          LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
          LEFT JOIN batches b      ON b.id = r.primary_batch_id AND b.deleted_at IS NULL
         WHERE (${routeId}::uuid IS NULL OR r.id = ${routeId ?? NIL}::uuid)
           AND (${batchId}::uuid IS NULL
                OR EXISTS (SELECT 1 FROM batch_routes br
                            WHERE br.route_id = r.id
                              AND br.batch_id = ${batchId ?? NIL}::uuid))
           AND (
             EXISTS (
               SELECT 1
                 FROM orders o
                 JOIN dealers d ON d.id = o.dealer_id
                 -- Play Store demo route: a reviewer's test activity is not the union's
                 -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
                 AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                                  WHERE demo_rt.code = 'DEMO'
                                    AND demo_rt.id = COALESCE(o.route_id, d.route_id))
                WHERE o.delivery_date = ${q.date}::date
                  -- Only orders actually placed for dispatch belong on the
                  -- route sheet. Drafts (pre-confirm carts), pending and
                  -- payment_required orders are NOT dispatched, so exclude
                  -- everything except confirmed/dispatched/delivered.
                  AND o.status IN ('confirmed', 'dispatched', 'delivered')
                  -- The route the order was placed for (snapshotted on the
                  -- order) wins over the dealer's current primary route.
                  AND COALESCE(o.route_id, d.route_id) = r.id
             )
             OR EXISTS (
               SELECT 1
                 FROM employee_orders eo
                WHERE eo.delivery_date = ${q.date}::date
                  AND eo.status IN ('confirmed', 'dispatched', 'delivered')
                  AND eo.route_id = r.id
             )
             -- Employee subsidy sold before it became a real indent still
             -- lives in direct_sales; kept so historical route sheets reprint
             -- exactly as they did.
             OR EXISTS (
               SELECT 1
                 FROM direct_sales ds
                WHERE ds.customer_type = 'employee_subsidy'
                  AND ds.status = 'confirmed'
                  AND ds.sale_date = ${q.date}::date
                  AND ds.route_id = r.id
             )
           )
         ORDER BY (r.deleted_at IS NOT NULL), r.code
      `;
 
      // ── 4b. Adhoc counter sales that named NO route ──
      // Cash sales, VIP samples, the employee ghee subsidy and gate passes
      // issued without a route are collected at the plant, so they carry no
      // route and no vehicle. They still leave FGS, so they are collected on
      // one ADHOC page rather than dropped. Offered only when the caller hasn't
      // narrowed to a single route — picking a route means asking for that
      // route's sheet alone.
      //
      // Batch: a route-less line has no route whose batch it could inherit, so
      // under a batch filter only sales explicitly tagged with that batch show
      // (employee indents carry no batch at all, so they drop out entirely).
      // is_credit marks supply that is NOT collected on this delivery, so the
      // page can foot it separately from the route's cash total. The rule is
      // the one the whole codebase uses: only a genuine later-billed sale
      // counts. Two things qualify here:
      //   • a gate pass taken on 'credit' — one taken on wallet, cash or UPI
      //     is money the union has (or is taking now), so it stays on the
      //     cash side, the same reasoning that keeps a wallet-funded dealer
      //     order there
      //   • the employee ghee subsidy, which debits employee_ledger against
      //     the employee's credit limit and is recovered from salary. Nothing
      //     is collected at the gate for it either. This page used to foot it
      //     as cash, which disagreed with every sales report — they have
      //     always filed the subsidy on the credit side (see buildSalesGrid).
      const adhocAllowed = routeId === null;
      const adhocRows = adhocAllowed ? await pgClient`
        SELECT eo.employee_id          AS party_id,
               e.employee_code         AS party_code,
               e.name                  AS party_name,
               'EMP'                   AS tag,
               true                    AS is_subsidy,
               true                    AS is_credit,
               eoi.product_id,
               eoi.quantity::int       AS qty,
               eoi.line_total::numeric AS amount
          FROM employee_orders eo
          JOIN employees e              ON e.id = eo.employee_id
          JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
         WHERE eo.delivery_date = ${q.date}::date
           AND eo.status IN ('confirmed', 'dispatched', 'delivered')
           AND eo.route_id IS NULL
           AND ${batchId}::uuid IS NULL
        UNION ALL
        -- Employee subsidy sold before it became a real indent still lives in
        -- direct_sales; kept so past dates reprint exactly as they did.
        SELECT ds.customer_id          AS party_id,
               e.employee_code         AS party_code,
               e.name                  AS party_name,
               'EMP'                   AS tag,
               true                    AS is_subsidy,
               true                    AS is_credit,
               dsi.product_id,
               dsi.quantity::int       AS qty,
               dsi.line_total::numeric AS amount
          FROM direct_sales ds
          JOIN employees e           ON e.id = ds.customer_id
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
         WHERE ds.customer_type = 'employee_subsidy'
           AND ds.status = 'confirmed'
           AND ds.sale_date = ${q.date}::date
           AND ds.route_id IS NULL
           AND (${batchId}::uuid IS NULL OR ds.batch_id = ${batchId ?? NIL}::uuid)
        UNION ALL
        SELECT ds.customer_id          AS party_id,
               ''                      AS party_code,
               COALESCE(cc.name, ds.recipient_name, 'Cash Customer') AS party_name,
               'CASH'                  AS tag,
               false                   AS is_subsidy,
               false                   AS is_credit,
               dsi.product_id,
               dsi.quantity::int       AS qty,
               dsi.line_total::numeric AS amount
          FROM direct_sales ds
          LEFT JOIN cash_customers cc ON cc.id = ds.customer_id
          JOIN direct_sale_items dsi  ON dsi.direct_sale_id = ds.id
         WHERE ds.customer_type = 'cash'
           AND ds.status = 'confirmed'
           AND ds.sale_date = ${q.date}::date
           AND ds.route_id IS NULL
           AND (${batchId}::uuid IS NULL OR ds.batch_id = ${batchId ?? NIL}::uuid)
        UNION ALL
        SELECT ds.customer_id          AS party_id,
               ''                      AS party_code,
               COALESCE(vc.name, ds.recipient_name, 'VIP Sample') AS party_name,
               'VIP'                   AS tag,
               false                   AS is_subsidy,
               false                   AS is_credit,
               dsi.product_id,
               dsi.quantity::int       AS qty,
               dsi.line_total::numeric AS amount
          FROM direct_sales ds
          LEFT JOIN vip_contacts vc  ON vc.id = ds.customer_id
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
         WHERE ds.customer_type = 'vip_sample'
           AND ds.status = 'confirmed'
           AND ds.sale_date = ${q.date}::date
           AND ds.route_id IS NULL
           AND (${batchId}::uuid IS NULL OR ds.batch_id = ${batchId ?? NIL}::uuid)
        UNION ALL
        -- Gate passes issued WITHOUT a route. A routed gate pass prints per
        -- route on the Gate Pass Report and is deliberately absent here (it
        -- would double against that sheet), but a route-less one appears on
        -- neither report — the Gate Pass Report joins routes — so its packets
        -- were invisible to the loader. The agent is a dealers row (no
        -- deleted_at filter: a pass already issued still has to be loaded).
        SELECT ds.customer_id          AS party_id,
               COALESCE(d.code, '')    AS party_code,
               COALESCE(d.name, ds.recipient_name, 'Gate Pass') AS party_name,
               'GP'                    AS tag,
               false                   AS is_subsidy,
               (ds.payment_mode::text = 'credit') AS is_credit,
               dsi.product_id,
               dsi.quantity::int       AS qty,
               dsi.line_total::numeric AS amount
          FROM direct_sales ds
          LEFT JOIN dealers d        ON d.id = ds.customer_id
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
         WHERE ds.customer_type = 'agent'
           AND ds.status = 'confirmed'
           AND ds.sale_date = ${q.date}::date
           AND ds.route_id IS NULL
           AND (${batchId}::uuid IS NULL OR ds.batch_id = ${batchId ?? NIL}::uuid)
      ` : [];

      if ((routes as any[]).length === 0 && (adhocRows as any[]).length === 0) {
        return reply.send({
          date: q.date,
          batch,
          acrossProducts,
          otherProducts,
          routes: [],
        });
      }
      // The sentinel keeps this array non-empty even on an adhoc-only day; no
      // real row can match it (a route-less line has route_id NULL, and NULL
      // never equals the sentinel).
      const routeIds = [...(routes as any[]).map(r => r.id), ADHOC_ROUTE_ID];

      // ── 5. Dealers on those routes ──
      // Roster comes from dealer_routes — the dealer's ASSIGNMENT to each
      // route — not from dealers.route_id (their primary). A dealer served
      // by two routes is visited by both and carries a standing indent per
      // route (migration 0061), so they get a slot on both sheets. Position
      // is the per-route stop order, so the printed sheet matches the
      // driver's actual path.
      // This seeds EMPTY slots only; soft-deleted dealers are skipped here
      // so they don't print a blank row, but any order they actually placed
      // still reaches the sheet through the item rows below (§6), which
      // deliberately do NOT filter on deleted_at.
      const dealers = await pgClient`
        SELECT d.id, d.code, d.name, d.customer_type,
               dr.route_id AS route_id,
               dr.position  AS position
          FROM dealer_routes dr
          JOIN dealers d ON d.id = dr.dealer_id
         WHERE d.deleted_at IS NULL
           AND dr.route_id = ANY(${routeIds}::uuid[])
         ORDER BY dr.route_id, dr.position NULLS LAST, d.code, d.name
      `;
 
      // ── 6. Dealer order items for the day ──
      // Keyed on delivery_date (the day goods are loaded/delivered), NOT
      // created_at. Standing-indent drafts are materialized the night
      // before delivery, so created_at lands on the prior day — filtering
      // on it would drop them from their own delivery-day route sheet.
      // direct_sales already uses sale_date (below) for the same reason.
      // route_id here is the order's effective route (snapshotted route, or
      // the dealer's primary as fallback). dealer_code/name/customer_type +
      // position are carried so a dealer who ordered on a route that ISN'T
      // their primary (admin Record Indent, or a route switch) can be added
      // to that route's sheet on the fly (they aren't in its primary roster).
      const itemRows = await pgClient`
        SELECT o.id AS order_id, o.dealer_id,
               COALESCE(o.route_id, d.route_id) AS route_id,
               d.code          AS dealer_code,
               d.name          AS dealer_name,
               d.customer_type AS customer_type,
               -- The order's own settlement rail. Needed with customer_type
               -- to decide the cash / credit side of this sheet: a credit
               -- institution that paid at checkout owes nothing, so it is not
               -- credit supply. See lib/credit-check.ts.
               o.payment_mode  AS payment_mode,
               dr.position     AS position,
               oi.product_id, oi.quantity::int AS qty,
               oi.line_total::numeric AS amount
          FROM orders o
          JOIN dealers d      ON d.id = o.dealer_id
          -- Play Store demo route: a reviewer's test activity is not the union's
          -- trade and must never reach this report. Mirrors routes/sales-reports.ts.
          AND NOT EXISTS (SELECT 1 FROM routes demo_rt
                           WHERE demo_rt.code = 'DEMO'
                             AND demo_rt.id = COALESCE(o.route_id, d.route_id))
          JOIN order_items oi ON oi.order_id = o.id
          LEFT JOIN dealer_routes dr
                 ON dr.dealer_id = d.id
                AND dr.route_id  = COALESCE(o.route_id, d.route_id)
         WHERE o.delivery_date = ${q.date}::date
           -- Match the route-selection filter above: only placed-for-dispatch
           -- orders contribute line items; drafts/pending/payment_required
           -- are excluded so unconfirmed carts never reach the route sheet.
           AND o.status IN ('confirmed', 'dispatched', 'delivered')
           AND COALESCE(o.route_id, d.route_id) = ANY(${routeIds}::uuid[])
      `;
 
      // ── 6b. Employee-subsidy sale items for the day ──
      // Customer is an employee; route comes from direct_sales.route_id;
      // ordering position comes from employees.route_position.
      // Two sources: employee_orders (the current rail — employee subsidy is a
      // real indent) and the direct_sales rows it was recorded as before the
      // change, so past dates keep reprinting unchanged.
      const empItemRows = await pgClient`
        SELECT eo.route_id,
               eo.employee_id            AS employee_id,
               e.employee_code           AS employee_code,
               e.name                    AS employee_name,
               e.route_position          AS route_position,
               eoi.product_id,
               eoi.quantity::int         AS qty,
               eoi.line_total::numeric   AS amount
          FROM employee_orders eo
          JOIN employees e               ON e.id = eo.employee_id
          JOIN employee_order_items eoi  ON eoi.employee_order_id = eo.id
         WHERE eo.delivery_date = ${q.date}::date
           AND eo.status IN ('confirmed', 'dispatched', 'delivered')
           AND eo.route_id = ANY(${routeIds}::uuid[])
        UNION ALL
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
           AND ds.status = 'confirmed'
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
        // Supply billed later rather than collected on this delivery: it is
        // excluded from the route cash total and surfaced separately under
        // Credit. A credit-institution customer (customer_type
        // 'Credit Inst-*') buys on monthly credit and lands here — UNLESS it
        // paid for this order up front in the app (payment_mode 'upi'), which
        // settles the supply and puts it back on the cash side. The seed in
        // 7a knows only the customer class; 7b corrects it from the order's
        // actual rail. Canonical rule: lib/credit-check.ts.
        isCredit: boolean;
        // Badge printed next to the name: EMP / CASH / VIP. Employee rows on a
        // real route keep the EMP badge they already had.
        tag?: string;
        position: number;
        acrossQty: Record<string, number>;
        othersItems: Array<{ productId: string; alias: string; qty: number; sortOrder: number }>;
        othersQty: number;
        netAmount: number;
        // Total quantity per product for this customer. Crates are computed
        // once, later, from these AGGREGATES — never rounded per order line
        // (a customer may have several lines of the same product).
        qtyByProduct: Map<string, number>;
      };
      const byRoute = new Map<string, Map<string, CustomerAgg>>();
      const routeProductAgg = new Map<string, Map<string, { qty: number; amount: number }>>();

      // The ADHOC page exists only on days when route-less goods actually went
      // out. It is appended after the real routes, so it prints last.
      const sheetRoutes: any[] = (adhocRows as any[]).length > 0
        ? [...(routes as any[]), {
            id: ADHOC_ROUTE_ID,
            code: "ADHOC",
            name: "Adhoc Sales (No Route)",
            contractor_id: null, contractor_name: null, vehicle_number: null,
            dispatch_time: null, batch_name: null, batch_code: null,
          }]
        : (routes as any[]);

      for (const r of sheetRoutes) {
        byRoute.set(r.id, new Map());
        routeProductAgg.set(r.id, new Map());
      }
 
      // 7a. Seed dealer rows (so a dealer with no items still has a slot).
      // isCredit here is provisional — the customer class is all this query
      // knows. A dealer with no items foots ₹0 either way, and one WITH items
      // has the flag corrected in 7b from the order's own payment rail.
      for (const d of dealers as any[]) {
        byRoute.get(d.route_id)?.set(d.id, {
          id: d.id, code: d.code ?? "", name: d.name,
          isEmployee: false,
          isCredit: isCreditInstitutionType(d.customer_type),
          position: Number(d.position) || 9999,
          acrossQty: Object.fromEntries(acrossProducts.map(p => [p.id, 0])),
          othersItems: [],
          othersQty: 0,
          netAmount: 0,
          qtyByProduct: new Map(),
        });
      }
 
      // 7b. Fold in dealer order items.
      //
      // CASH AND CREDIT SUPPLY GET SEPARATE ROWS, exactly as a gate-pass agent
      // taking one pass on credit and another on cash does further down. A
      // credit institution may pay for one of the day's indents in the app and
      // leave the other on its monthly account; footing both into a single row
      // would show the driver one combined figure marked "(credit)", claiming a
      // debt for money that is already banked. So the row is keyed on the rail:
      //
      //   P45  PRAVEEN ELECTRICALS            24,413.72
      //   P45  PRAVEEN ELECTRICALS            17,226.46 (credit)
      //
      // The first rail seen for a dealer takes over the row 7a seeded for them
      // (so the ordinary one-order case adds no row and leaves no empty one); a
      // second, DIFFERENT rail gets a sibling row under a suffixed key. Rows
      // with no quantity are dropped in step 8, so an unused seed cannot print.
      //
      // Ordinary dealers are unaffected: isCreditSupplyOrder is false for every
      // order they place, so all their rails collapse to the one row.
      //
      // (route, dealer) -> rail -> the bucket key holding that rail's row.
      const dealerRailRows = new Map<string, Map<boolean, string>>();
      for (const it of itemRows as any[]) {
        const bucket = byRoute.get(it.route_id);
        if (!bucket) continue; // route not in the selected set
        // Does THIS order leave money owing? A credit institution that paid
        // at checkout does not. See lib/credit-check.ts.
        const orderIsCredit = isCreditSupplyOrder({
          customerType: it.customer_type,
          paymentMode: it.payment_mode,
        });

        const dealerKey = `${it.route_id}:${it.dealer_id}`;
        let rails = dealerRailRows.get(dealerKey);
        if (!rails) { rails = new Map(); dealerRailRows.set(dealerKey, rails); }
        let rowKey: string | undefined = rails.get(orderIsCredit);
        if (rowKey === undefined) {
          // First rail for this dealer adopts the seeded row; a second one
          // opens its own. The suffix keeps <tr key={c.id}> unique on the web.
          rowKey = rails.size === 0
            ? String(it.dealer_id)
            : `${it.dealer_id}:${orderIsCredit ? "CR" : "CASH"}`;
          rails.set(orderIsCredit, rowKey);
        }

        let customer = bucket.get(rowKey);
        if (!customer) {
          // Either the dealer placed this order on a route that isn't their
          // primary (admin Record Indent, or a route switch) and so isn't in
          // this route's seeded roster, or this is their second rail.
          customer = {
            id: rowKey,
            code: it.dealer_code ?? "",
            name: it.dealer_name,
            isEmployee: false,
            isCredit: orderIsCredit,
            position: Number(it.position) || 9999,
            acrossQty: Object.fromEntries(acrossProducts.map(p => [p.id, 0])),
            othersItems: [],
            othersQty: 0,
            netAmount: 0,
            qtyByProduct: new Map(),
          };
          bucket.set(rowKey, customer);
        }
        // Replace 7a's guess (customer class only) with this order's own rail.
        customer.isCredit = orderIsCredit;
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

        // Accumulate qty per product; crates are computed later from the total.
        customer.qtyByProduct.set(
          it.product_id,
          (customer.qtyByProduct.get(it.product_id) ?? 0) + qty
        );
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
            // Not a credit institution, but credit all the same: the subsidy
            // debits employee_ledger and is recovered from salary, so the
            // driver collects nothing for it. Footed with the credit total,
            // matching the ADHOC page above and every sales report.
            isCredit: true,
            position: Number(it.route_position) || 9999,
            acrossQty: Object.fromEntries(acrossProducts.map(p => [p.id, 0])),
            othersItems: [],
            othersQty: 0,
            netAmount: 0,
            qtyByProduct: new Map(),
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

        customer.qtyByProduct.set(
          it.product_id,
          (customer.qtyByProduct.get(it.product_id) ?? 0) + qty
        );
      }

      // 7d. Fold in the route-less adhoc sales, all onto the ADHOC page.
      //     Subsidy lines keep the "(Sub)" treatment they get on a real route
      //     (Others column, `${pid}:sub` abstract key). Cash, VIP and gate-pass
      //     lines are ordinary goods, so they behave like a dealer's: across
      //     column when the product has one, Others otherwise. The tag (CASH /
      //     VIP / EMP / GP) is what tells the loader which rail a row came from.
      for (const it of adhocRows as any[]) {
        const customers = byRoute.get(ADHOC_ROUTE_ID);
        if (!customers) continue;
        const meta = productMeta.get(it.product_id);
        if (!meta) continue;

        // One row per party per kind: the same person buying cash and taking a
        // subsidy packet is two different transactions on the sheet. Credit
        // splits the key too, so an agent who takes one pass on credit and
        // another on cash is footed on the right side for each.
        const rowKey = `${it.party_id}:${it.tag}${it.is_credit ? ":CR" : ""}`;
        let customer = customers.get(rowKey);
        if (!customer) {
          customer = {
            id: rowKey,
            code: it.party_code ?? "",
            name: it.party_name ?? "",
            isEmployee: it.tag === "EMP",
            isCredit: it.is_credit === true,
            tag: it.tag,
            position: 9999,
            acrossQty: Object.fromEntries(acrossProducts.map(p => [p.id, 0])),
            othersItems: [],
            othersQty: 0,
            netAmount: 0,
            qtyByProduct: new Map(),
          };
          customers.set(rowKey, customer);
        }

        const qty = Number(it.qty) || 0;
        const amt = parseFloat(it.amount) || 0;
        const isSub = it.is_subsidy === true;

        const key = isSub ? `${it.product_id}:sub` : it.product_id;
        const rmap = routeProductAgg.get(ADHOC_ROUTE_ID)!;
        const cur = rmap.get(key) ?? { qty: 0, amount: 0 };
        cur.qty += qty;
        cur.amount = round2(cur.amount + amt);
        rmap.set(key, cur);

        if (!isSub && acrossIds.has(it.product_id)) {
          customer.acrossQty[it.product_id] = (customer.acrossQty[it.product_id] ?? 0) + qty;
        } else {
          customer.othersItems.push({
            productId: key,
            alias: isSub ? `${meta.alias} (Sub)` : meta.alias,
            qty,
            sortOrder: isSub ? meta.sortOrder + 0.5 : meta.sortOrder,
          });
          customer.othersQty += qty;
        }
        customer.netAmount = round2(customer.netAmount + amt);

        customer.qtyByProduct.set(
          it.product_id,
          (customer.qtyByProduct.get(it.product_id) ?? 0) + qty
        );
      }

      // ── 8. Shape per-route output ──
      const routesOut: any[] = [];
      for (const r of sheetRoutes) {
        const map = byRoute.get(r.id)!;
        const allRows = Array.from(map.values());
        const activeRows = allRows.filter(d =>
          d.othersQty > 0 || Object.values(d.acrossQty).some(qv => qv > 0)
        );
        if (activeRows.length === 0) continue;
 
        // FIX: order by route position (NOT alphabetically). Dealers use
        // dealer_routes.position; employees use employees.route_position.
        // Ties break on code then name.
        // The last tiebreak only ever separates a dealer's own cash and credit
        // rows (everything before it is identical for them): the collected row
        // prints above the "(credit)" one, in that order every time.
        activeRows.sort((a, b) =>
          (a.position - b.position)
          || (a.code || "").localeCompare(b.code || "")
          || a.name.localeCompare(b.name)
          || (Number(a.isCredit) - Number(b.isCredit))
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

          // Whole crates ± loose packets for the single Crates cell. Group the
          // customer's products by crate size (packets/crate) and split each
          // group's COMBINED qty, so same-size products share crates and the
          // remainder stays minimal (e.g. two 13-pkt lines of a 24-crate read
          // "1+2", not "2−22"). Only pc-assigned products count; the +/− are
          // netted so the cell reads "N", "N+p", or "N−p".
          const qtyByPc = new Map<number, number>();
          for (const [pid, qty] of d.qtyByProduct) {
            const pc = productMeta.get(pid)?.packetsCrate ?? 0;
            if (pc > 0 && qty > 0) qtyByPc.set(pc, (qtyByPc.get(pc) ?? 0) + qty);
          }
          let cr = 0, pPlus = 0, pMinus = 0;
          for (const [pc, qty] of qtyByPc) {
            const s = crateSplit(qty, pc);
            cr += s.crates; pPlus += s.pktPlus; pMinus += s.pktMinus;
          }
          const net = pPlus - pMinus;

          return {
            sl: idx + 1,
            id: d.id,
            code: d.code,
            name: d.name,
            isEmployee: d.isEmployee,
            isCredit: d.isCredit,
            tag: d.tag ?? null,
            acrossQty: d.acrossQty,
            othersText: othersList.map(x => `${x.alias} → ${x.qty}`).join(", "),
            othersQty: d.othersQty,
            netAmount: round2(d.netAmount),
            crates: cr,
            cratePktPlus:  net > 0 ?  net : 0,
            cratePktMinus: net < 0 ? -net : 0,
          };
        });

        // Route-level net of every dealer's loose packets (pkt+ minus pkt−).
        const routeNetCratePkt = customers.reduce(
          (s, c) => s + c.cratePktPlus - c.cratePktMinus, 0
        );

        const totals = {
          acrossQty: Object.fromEntries(
            acrossProducts.map(p => [
              p.id,
              customers.reduce((s, c) => s + (c.acrossQty[p.id] ?? 0), 0),
            ])
          ),
          othersQty:      customers.reduce((s, c) => s + c.othersQty, 0),
          // Cash total: excludes credit-institution customers (billed monthly,
          // not collected on this delivery). Their amount goes to creditAmount.
          netAmount:      round2(customers.reduce((s, c) => s + (c.isCredit ? 0 : c.netAmount), 0)),
          creditAmount:   round2(customers.reduce((s, c) => s + (c.isCredit ? c.netAmount : 0), 0)),
          crates:         customers.reduce((s, c) => s + c.crates, 0),
          // Net the per-dealer loose packets across the route into one +/−.
          cratePktPlus:   Math.max(0,  routeNetCratePkt),
          cratePktMinus:  Math.max(0, -routeNetCratePkt),
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
          // Nearest-crate split (ties/"middle" → pkt+). Non-crate products
          // contribute nothing — no crates, no loose packets.
          const { crates, pktPlus, pktMinus } = crateSplit(agg.qty, pc);
          // Sort key: the client-defined abstract_position leads; products
          // with no position (0) fall after all positioned rows in sort_order.
          // Sub lines sit immediately after their base product (+0.5).
          // A subsidised across product (alias carries "(sub)") is pulled to
          // the FRONT so it — and its column — lead the sheet & abstract.
          const isSubProduct = /\(\s*sub\s*\)/i.test(meta.alias);
          const basePos = isSubProduct
            ? -1_000_000 + meta.sortOrder
            : meta.abstractPosition > 0 ? meta.abstractPosition : 1000 + meta.sortOrder;
          abstractItems.push({
            productId:    key,
            alias:        isSub ? `${meta.alias} (Sub)` : meta.alias,
            sortOrder:    isSub ? basePos + 0.5 : basePos,
            packetsCrate: pc,
            packSize:     meta.packSize,
            unit:         meta.unit,
            category:     meta.category,
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
          code: displayRouteCode(r.code),
          name: r.name,
          // Deleted after this date's dispatch. The page still prints — the
          // goods went out — but the route is no longer one you can dispatch on.
          retired: Boolean(r.retired),
          // The no-route page: goods handed over at the plant counter. Not a
          // vehicle load, so it carries no contractor or dispatch time.
          isAdhoc: r.id === ADHOC_ROUTE_ID,
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
  // One page per route that has a gate pass, plus one ADHOC page for the
  // passes issued without a route (the same bucket the Route Sheet and the
  // Dispatch Sheet collect). Those route-less packets therefore print on BOTH
  // this report and the Route Sheet's ADHOC page — asked for deliberately so
  // the gate sees every pass, so do not read the two sheets as one total.
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
               p.pack_size, p.unit, p.sort_order, p.abstract_position,
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
        abstractPosition: Number(p.abstract_position) || 0,
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
        abstractPosition: number; category: string;
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
          abstractPosition: Number(p.abstract_position) || 0,
          category: p.category_name ?? "",
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
      //
      // Not filtered on r.deleted_at, for the same reason as the Route Sheet:
      // the EXISTS below already limits this to routes that carried a pass on
      // the date, and deleting the route later does not unissue the pass.
      const routes = await pgClient`
        SELECT r.id, r.code, r.name,
               r.contractor_id, r.dispatch_time,
               (r.deleted_at IS NOT NULL) AS retired,
               ct.name           AS contractor_name,
               ct.vehicle_number AS vehicle_number,
               b.name            AS batch_name,
               b.batch_number    AS batch_code
          FROM routes r
          LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
          LEFT JOIN batches b      ON b.id = r.primary_batch_id AND b.deleted_at IS NULL
         WHERE (${routeId}::uuid IS NULL OR r.id = ${routeId ?? NIL}::uuid)
           AND EXISTS (
             SELECT 1
               FROM direct_sales ds
              WHERE ds.customer_type = 'agent'
                AND ds.status = 'confirmed'
                AND ds.sale_date = ${q.date}::date
                AND ds.route_id  = r.id
                AND (${batchId}::uuid IS NULL
                     OR ds.batch_id = ${batchId ?? NIL}::uuid)
           )
         ORDER BY (r.deleted_at IS NOT NULL), r.code
      `;

      // ── 3b. Gate passes that named NO route ──
      // Handed over at the plant, so there is no vehicle and no route page to
      // sit on. They print as one extra ADHOC page rather than being dropped
      // (before 2026-08-07 they appeared on no report at all — this report
      // joins routes, and the loading sheets skipped agent rows entirely).
      // Offered only when the caller hasn't narrowed to a single route, and
      // shaped exactly like the item rows below so both streams fold through
      // the same aggregation. The agent is LEFT joined here and below: a pass
      // already issued has to print even if its dealer row went missing, and
      // the Route Sheet's ADHOC page joins the same way, so the two pages
      // cannot disagree on a packet count.
      const adhocAllowed = routeId === null;
      const adhocRows = adhocAllowed ? await pgClient`
        SELECT ${ADHOC_ROUTE_ID}::uuid AS route_id,
               ds.customer_id          AS agent_id,
               COALESCE(d.code, '')    AS agent_code,
               COALESCE(d.name, ds.recipient_name, 'Gate Pass') AS agent_name,
               (ds.payment_mode::text = 'credit') AS is_credit,
               dsi.product_id,
               dsi.quantity::int       AS qty,
               dsi.line_total::numeric AS amount
          FROM direct_sales ds
          LEFT JOIN dealers d        ON d.id = ds.customer_id
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
         WHERE ds.customer_type = 'agent'
           AND ds.status = 'confirmed'
           AND ds.sale_date = ${q.date}::date
           AND ds.route_id IS NULL
           AND (${batchId}::uuid IS NULL
                OR ds.batch_id = ${batchId ?? NIL}::uuid)
      ` : [];

      if ((routes as any[]).length === 0 && (adhocRows as any[]).length === 0) {
        return reply.send({
          date: q.date,
          batch,
          acrossProducts,
          otherProducts,
          routes: [],
        });
      }
      // The sentinel keeps this array non-empty even on an adhoc-only day; no
      // real row can match it (a route-less pass has route_id NULL, and NULL
      // never equals the sentinel).
      const routeIds = [...(routes as any[]).map(r => r.id), ADHOC_ROUTE_ID];

      // ── 4. Gate pass line items for the day on those routes ──
      //     The "customer" is the agent: a dealers row referenced by
      //     direct_sales.customer_id when customer_type = 'agent'.
      const itemRows = await pgClient`
        SELECT ds.route_id,
               ds.customer_id          AS agent_id,
               COALESCE(d.code, '')    AS agent_code,
               COALESCE(d.name, ds.recipient_name, 'Gate Pass') AS agent_name,
               (ds.payment_mode::text = 'credit') AS is_credit,
               dsi.product_id,
               dsi.quantity::int       AS qty,
               dsi.line_total::numeric AS amount
          FROM direct_sales ds
          LEFT JOIN dealers d        ON d.id = ds.customer_id
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
         WHERE ds.customer_type = 'agent'
           AND ds.status = 'confirmed'
           AND ds.sale_date = ${q.date}::date
           AND ds.route_id = ANY(${routeIds}::uuid[])
           AND (${batchId}::uuid IS NULL
                OR ds.batch_id = ${batchId ?? NIL}::uuid)
      `;

      // ── 5. Aggregate per (route, agent, product) and per (route, product) ──
      type AgentAgg = {
        id: string; code: string; name: string;
        // A pass taken on credit is billed later, not collected at the gate,
        // so it foots separately from the page's cash total — the same split
        // the Route Sheet makes for credit-institution dealers.
        isCredit: boolean;
        acrossQty: Record<string, number>;
        othersItems: Array<{ productId: string; alias: string; qty: number; sortOrder: number }>;
        othersQty: number;
        netAmount: number;
        // Total quantity per product; crates are computed once from these
        // AGGREGATES (an agent may hold several gate passes for a product).
        qtyByProduct: Map<string, number>;
      };
      const byRoute = new Map<string, Map<string, AgentAgg>>();
      const routeProductAgg = new Map<string, Map<string, { qty: number; amount: number }>>();

      // The ADHOC page exists only on days when a route-less pass was actually
      // issued. It is appended after the real routes, so it prints last.
      const sheetRoutes: any[] = (adhocRows as any[]).length > 0
        ? [...(routes as any[]), {
            id: ADHOC_ROUTE_ID,
            code: "ADHOC",
            name: "Adhoc Gate Passes (No Route)",
            contractor_id: null, contractor_name: null, vehicle_number: null,
            dispatch_time: null, batch_name: null, batch_code: null,
          }]
        : (routes as any[]);

      for (const r of sheetRoutes) {
        byRoute.set(r.id, new Map());
        routeProductAgg.set(r.id, new Map());
      }

      // Route-less passes carry the sentinel as their route_id and are shaped
      // like the routed ones, so one fold handles both streams.
      for (const it of [...(itemRows as any[]), ...(adhocRows as any[])]) {
        const agents = byRoute.get(it.route_id);
        if (!agents) continue;
        const meta = productMeta.get(it.product_id);
        if (!meta) continue;
 
        // Agent rows are created lazily on first item — an agent can
        // hold several gate passes in a day; they collapse into one row.
        // Cash and credit passes stay apart, so one agent taking both is
        // footed on the right side for each.
        const agentKey = `${it.agent_id}${it.is_credit ? ":CR" : ""}`;
        let agent = agents.get(agentKey);
        if (!agent) {
          agent = {
            id: it.agent_id,
            code: it.agent_code ?? "",
            name: it.agent_name ?? "",
            isCredit: it.is_credit === true,
            acrossQty: Object.fromEntries(acrossProducts.map(p => [p.id, 0])),
            othersItems: [],
            othersQty: 0,
            netAmount: 0,
            qtyByProduct: new Map(),
          };
          agents.set(agentKey, agent);
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

        // Accumulate qty per product; crates are computed later from the total.
        agent.qtyByProduct.set(
          it.product_id,
          (agent.qtyByProduct.get(it.product_id) ?? 0) + qty
        );
      }
 
      // ── 6. Shape per-route output — identical to Route Sheet ──
      const routesOut: any[] = [];
      for (const r of sheetRoutes) {
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

          // Whole crates ± loose packets, from aggregated per-product qty,
          // grouped by crate size so same-size products share crates. Only
          // pc-assigned products count; +/− netted into one cell.
          const qtyByPc = new Map<number, number>();
          for (const [pid, qty] of d.qtyByProduct) {
            const pc = productMeta.get(pid)?.packetsCrate ?? 0;
            if (pc > 0 && qty > 0) qtyByPc.set(pc, (qtyByPc.get(pc) ?? 0) + qty);
          }
          let cr = 0, pPlus = 0, pMinus = 0;
          for (const [pc, qty] of qtyByPc) {
            const s = crateSplit(qty, pc);
            cr += s.crates; pPlus += s.pktPlus; pMinus += s.pktMinus;
          }
          const net = pPlus - pMinus;

          return {
            sl: idx + 1,
            id: d.id,
            code: d.code,
            name: d.name,
            isCredit: d.isCredit,
            acrossQty: d.acrossQty,
            othersText: othersList.map(x => `${x.alias} → ${x.qty}`).join(", "),
            othersQty: d.othersQty,
            netAmount: round2(d.netAmount),
            crates: cr,
            cratePktPlus:  net > 0 ?  net : 0,
            cratePktMinus: net < 0 ? -net : 0,
          };
        });

        // Route-level net of every agent's loose packets (pkt+ minus pkt−).
        const routeNetCratePkt = customers.reduce(
          (s, c) => s + c.cratePktPlus - c.cratePktMinus, 0
        );

        const totals = {
          acrossQty: Object.fromEntries(
            acrossProducts.map(p => [
              p.id,
              customers.reduce((s, c) => s + (c.acrossQty[p.id] ?? 0), 0),
            ])
          ),
          othersQty:      customers.reduce((s, c) => s + c.othersQty, 0),
          // Cash total excludes passes taken on credit — nothing is collected
          // at the gate for those, they are billed and age in AR. Their value
          // is footed separately under creditAmount, as on the Route Sheet.
          netAmount:      round2(customers.reduce((s, c) => s + (c.isCredit ? 0 : c.netAmount), 0)),
          creditAmount:   round2(customers.reduce((s, c) => s + (c.isCredit ? c.netAmount : 0), 0)),
          crates:         customers.reduce((s, c) => s + c.crates, 0),
          cratePktPlus:   Math.max(0,  routeNetCratePkt),
          cratePktMinus:  Math.max(0, -routeNetCratePkt),
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
          // Nearest-crate split (ties/"middle" → pkt+). Non-crate products
          // contribute nothing — no crates, no loose packets.
          const { crates, pktPlus, pktMinus } = crateSplit(agg.qty, pc);
          // Sort key: client-defined abstract_position leads; unpositioned
          // products (0) fall after all positioned rows in sort_order.
          const basePos = meta.abstractPosition > 0 ? meta.abstractPosition : 1000 + meta.sortOrder;
          abstractItems.push({
            productId:    pid,
            alias:        meta.alias,
            sortOrder:    basePos,
            packetsCrate: pc,
            packSize:     meta.packSize,
            unit:         meta.unit,
            category:     meta.category,
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
          code: displayRouteCode(r.code),
          name: r.name,
          // Deleted since this date. The passes it carried still print.
          retired: Boolean(r.retired),
          // The no-route page: passes collected at the plant counter. Not a
          // vehicle load, so it carries no contractor or dispatch time.
          isAdhoc: r.id === ADHOC_ROUTE_ID,
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
  // A3. Route Indent Status — which dealers assigned to a route placed an
  // indent for the day, and which did not.
  // Filters: date (required), routeId (optional). The Placed / Not placed
  // filter is applied by the page, so each route's counts stay whole.
  //
  // "Placed" is the Route Sheet's rule: an order for the delivery date that
  // reached confirmed / dispatched / delivered. A draft (standing indent not
  // yet confirmed), a payment_required order or a cancelled one is nothing
  // the route will load, so that dealer reads Not placed, and the state is
  // returned as the reason.
  //
  // The roster is dealer_routes (the assignment, so a two-route dealer is
  // expected on both), live routes only, active non-deleted dealers only: an
  // inactive dealer cannot sign in to order, so listing them as Not placed
  // would be noise. Anyone who DID place on the route shows regardless (taken
  // off the route since, deleted, or a retired route), so the Placed count
  // matches what the route actually loaded. One row per dealer per route:
  // dealers top up with several orders a day, so orders are summed.
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/indent-status",
    { preHandler: [adminAuth, requireRole("reports.view")] },
    async (request, reply) => {
      const qs = z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        routeId: z.string().uuid().optional(),
      });
      const q = qs.parse(request.query);
      const routeId = q.routeId ?? null;
      const NIL = "00000000-0000-0000-0000-000000000000";

      const rows = await pgClient`
        WITH day_orders AS (
          SELECT o.dealer_id,
                 -- The route the order was placed for wins over the dealer's
                 -- current primary (see the Route Sheet above).
                 COALESCE(o.route_id, d.route_id) AS route_id,
                 o.status::text AS status,
                 o.grand_total,
                 COALESCE(o.confirmed_at, o.created_at) AS placed_at,
                 (SELECT COALESCE(SUM(oi.quantity), 0)
                    FROM order_items oi
                   WHERE oi.order_id = o.id) AS qty
            FROM orders o
            JOIN dealers d ON d.id = o.dealer_id
           WHERE o.delivery_date = ${q.date}::date
        ),
        placed AS (
          SELECT dealer_id, route_id,
                 COUNT(*)::int             AS indents,
                 SUM(qty)::int             AS qty,
                 SUM(grand_total)::numeric AS amount,
                 MIN(placed_at)            AS first_placed_at
            FROM day_orders
           WHERE status IN ('confirmed', 'dispatched', 'delivered')
           GROUP BY dealer_id, route_id
        ),
        open_orders AS (
          SELECT dealer_id, route_id,
                 bool_or(status = 'payment_required')    AS payment_required,
                 bool_or(status IN ('draft', 'pending')) AS unconfirmed,
                 bool_or(status = 'cancelled')           AS cancelled
            FROM day_orders
           WHERE status NOT IN ('confirmed', 'dispatched', 'delivered')
           GROUP BY dealer_id, route_id
        ),
        roster AS (
          SELECT dr.dealer_id, dr.route_id, dr.position
            FROM dealer_routes dr
            JOIN dealers d ON d.id = dr.dealer_id
            JOIN routes  r ON r.id = dr.route_id
           WHERE d.deleted_at IS NULL
             AND d.active
             AND r.deleted_at IS NULL
        ),
        slots AS (
          SELECT dealer_id, route_id FROM roster
          UNION
          SELECT dealer_id, route_id FROM placed
        )
        SELECT s.route_id,
               r.code AS route_code,
               r.name AS route_name,
               (r.deleted_at IS NOT NULL) AS route_retired,
               s.dealer_id,
               d.code  AS dealer_code,
               d.name  AS dealer_name,
               d.phone AS dealer_phone,
               (ro.dealer_id IS NOT NULL) AS assigned,
               p.indents, p.qty, p.amount,
               to_char(p.first_placed_at AT TIME ZONE 'Asia/Kolkata',
                       'YYYY-MM-DD HH24:MI') AS first_placed_at,
               CASE
                 WHEN oo.payment_required THEN 'payment_required'
                 WHEN oo.unconfirmed      THEN 'draft'
                 WHEN oo.cancelled        THEN 'cancelled'
               END AS open_status
          FROM slots s
          JOIN routes  r ON r.id = s.route_id
          JOIN dealers d ON d.id = s.dealer_id
          LEFT JOIN roster      ro ON ro.dealer_id = s.dealer_id AND ro.route_id = s.route_id
          LEFT JOIN placed      p  ON p.dealer_id  = s.dealer_id AND p.route_id  = s.route_id
          LEFT JOIN open_orders oo ON oo.dealer_id = s.dealer_id AND oo.route_id = s.route_id
         -- Play Store demo route: the reviewer's account is not a dealer
         -- anyone chases for an indent. Mirrors routes/sales-reports.ts.
         WHERE r.code <> 'DEMO'
           AND (${routeId}::uuid IS NULL OR s.route_id = ${routeId ?? NIL}::uuid)
         -- Stop order on the route, so the list reads in the driver's path;
         -- dealers off the roster (no position) close the list.
         ORDER BY ro.position NULLS LAST, d.code, d.name
      `;

      type Counts = {
        assigned: number; placed: number; notPlaced: number;
        indents: number; qty: number; amount: number;
      };
      const emptyCounts = (): Counts => ({
        assigned: 0, placed: 0, notPlaced: 0, indents: 0, qty: 0, amount: 0,
      });
      const tally = (c: Counts, row: {
        assigned: boolean; placed: boolean; indents: number; qty: number; amount: number;
      }) => {
        if (row.assigned) c.assigned += 1;
        if (row.placed) c.placed += 1; else c.notPlaced += 1;
        c.indents += row.indents;
        c.qty += row.qty;
        c.amount = round2(c.amount + row.amount);
      };

      const byRoute = new Map<string, any>();
      for (const r of rows as any[]) {
        let route = byRoute.get(r.route_id);
        if (!route) {
          route = {
            id: r.route_id,
            code: displayRouteCode(r.route_code),
            name: r.route_name,
            retired: r.route_retired,
            counts: emptyCounts(),
            dealers: [],
          };
          byRoute.set(r.route_id, route);
        }
        const placed = Number(r.indents ?? 0) > 0;
        const dealer = {
          dealerId: r.dealer_id,
          code: r.dealer_code ?? "",
          name: r.dealer_name,
          phone: r.dealer_phone ?? "",
          assigned: r.assigned,
          placed,
          indents: Number(r.indents ?? 0),
          qty: Number(r.qty ?? 0),
          amount: round2(Number(r.amount ?? 0)),
          firstPlacedAt: r.first_placed_at ?? null,
          // Why a dealer is still Not placed. A placed dealer's cancelled or
          // superseded siblings are routine and would only confuse the row.
          openStatus: placed ? null : (r.open_status ?? null),
        };
        route.dealers.push(dealer);
        tally(route.counts, dealer);
      }

      // Live routes first, in natural code order (R2 before R10).
      const routesOut = Array.from(byRoute.values()).sort((a, b) =>
        (Number(a.retired) - Number(b.retired))
        || a.code.localeCompare(b.code, "en", { numeric: true })
        || a.name.localeCompare(b.name)
      );

      const totals = emptyCounts();
      for (const r of routesOut) {
        totals.assigned  += r.counts.assigned;
        totals.placed    += r.counts.placed;
        totals.notPlaced += r.counts.notPlaced;
        totals.indents   += r.counts.indents;
        totals.qty       += r.counts.qty;
        totals.amount     = round2(totals.amount + r.counts.amount);
      }

      return reply.send({ date: q.date, routes: routesOut, totals });
    }
  );
}

/** Kg/Ltr quantities — two decimals is what the paper registers show. */
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}


/**
 * Split an ordered quantity into whole crates ± loose packets, for ONE product.
 *
 * Rounds to the NEAREST whole crate:
 *   • remainder in the lower half (ties / the exact "middle" included) → keep
 *     the crate, show the extra as pkt (+):   "quotient + remainder"
 *   • remainder in the upper half → round up to the next crate, show the
 *     shortfall as pkt (−):                    "(quotient+1) − (pc − remainder)"
 *
 * Only products with a packets-per-crate assigned (pc > 0) count; anything else
 * returns all-zero — no crate, no loose packets ("do nothing for others").
 */
function crateSplit(
  qty: number,
  pc: number
): { crates: number; pktPlus: number; pktMinus: number } {
  if (!(pc > 0) || qty <= 0) return { crates: 0, pktPlus: 0, pktMinus: 0 };
  const quotient = Math.floor(qty / pc);
  const remainder = qty - quotient * pc;
  if (remainder === 0) return { crates: quotient, pktPlus: 0, pktMinus: 0 };
  // Lower half (and the exact middle) stays on the current crate as pkt(+).
  if (remainder * 2 <= pc) return { crates: quotient, pktPlus: remainder, pktMinus: 0 };
  // Upper half rounds up to the next crate; the gap shows as pkt(−).
  return { crates: quotient + 1, pktPlus: 0, pktMinus: pc - remainder };
}