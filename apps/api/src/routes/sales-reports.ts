import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationMeta, offsetFromPage } from "../lib/pagination.js";

// Reports need larger page sizes than the shared paginationSchema allows (max 100).
const reportPagination = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(1000).default(100),
});

// ── shared schema ──
const dateRangeSchema = z.object({
  from: z.string(), // ISO YYYY-MM-DD
  to: z.string(),
});

// ── one-request cache for system_settings ──
type ReportConfig = {
  categoryGroups: { milk: string[]; curd: string[]; lassi: string[] };
  cashPaymentModes: string[];
  milkCategoryGroup: string[];
  talukaFixedProducts: Array<{ code: string; label: string }>;
  cratePacketsDefault: number;
};

async function loadReportConfig(): Promise<ReportConfig> {
  const rows = await pgClient`
    SELECT key, value FROM system_settings WHERE category = 'reports'
  `;
  const map = new Map(rows.map((r: any) => [r.key, r.value]));
  const parse = (k: string, fallback: any) => {
    const v = map.get(k);
    if (v == null) return fallback;
    try { return typeof v === "string" ? JSON.parse(v) : v; } catch { return fallback; }
  };
  return {
    categoryGroups: parse("category_groups", { milk: ["Milk"], curd: ["Curd"], lassi: ["Lassi", "Buttermilk"] }),
    cashPaymentModes: parse("cash_payment_modes", ["cash", "upi", "wallet"]),
    milkCategoryGroup: parse("milk_category_group", ["Milk", "Curd", "Lassi", "Buttermilk"]),
    talukaFixedProducts: parse("taluka_fixed_products", []),
    cratePacketsDefault: Number(parse("crate_packets_default", 20)) || 20,
  };
}

export async function salesReportRoutes(app: FastifyInstance) {
  // ════════════════════════════════════════════
  // B1. Daily Sales Statement — 3 pages (Milk / Curd / Lassi+Majige)
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/daily-statement",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);
      const cfg = await loadReportConfig();

      // Generate every date in the range (even if zero sales that day)
      const dateList = await pgClient`
        SELECT to_char(d::date, 'YYYY-MM-DD') AS date
        FROM generate_series(${q.from}::date, ${q.to}::date, interval '1 day') d
        ORDER BY d
      `;
      const dates = dateList.map((r: any) => r.date);

      // Fetch products ordered by sort_order grouped by category
      const products = await pgClient`
        SELECT p.id, p.report_alias, p.name, p.sort_order, c.name AS category_name
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL
          AND p.available = true
        ORDER BY p.sort_order, p.name
      `;

      // Fetch aggregated sales by (date, product) for orders + direct sales
      const salesRows = await pgClient`
        WITH combined AS (
          SELECT o.created_at::date AS sale_date,
                 oi.product_id,
                 oi.quantity::int AS qty,
                 oi.line_total::numeric AS amount
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.created_at::date >= ${q.from}::date
            AND o.created_at::date <= ${q.to}::date
            AND o.status != 'cancelled'
          UNION ALL
          SELECT ds.sale_date,
                 dsi.product_id,
                 dsi.quantity::int AS qty,
                 dsi.line_total::numeric AS amount
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
        )
        SELECT to_char(sale_date, 'YYYY-MM-DD') AS date,
               product_id,
               SUM(qty)::int       AS qty,
               SUM(amount)::numeric AS amount
        FROM combined
        GROUP BY sale_date, product_id
      `;

      // Index: date → productId → {qty, amount}
      const byDate = new Map<string, Map<string, { qty: number; amount: number }>>();
      for (const r of salesRows as any[]) {
        if (!byDate.has(r.date)) byDate.set(r.date, new Map());
        byDate.get(r.date)!.set(r.product_id, {
          qty: Number(r.qty) || 0,
          amount: parseFloat(r.amount) || 0,
        });
      }

      // Helper to build a group page (milk | curd | lassi)
      const buildGroup = (key: "milk" | "curd" | "lassi", label: string, categories: string[]) => {
        const groupProds = (products as any[])
          .filter(p => categories.includes(p.category_name))
          .map(p => ({ id: p.id, reportAlias: p.report_alias ?? p.name, sortOrder: p.sort_order }));

        const rows = dates.map(date => {
          const qtyByProd: Record<string, number> = {};
          let totalAmount = 0;
          for (const p of groupProds) {
            const cell = byDate.get(date)?.get(p.id);
            qtyByProd[p.id] = cell?.qty ?? 0;
            totalAmount += cell?.amount ?? 0;
          }
          return { date, qty: qtyByProd, totalAmount: round2(totalAmount) };
        });

        const totals = {
          qty: Object.fromEntries(groupProds.map(p => [p.id, rows.reduce((s, r) => s + (r.qty[p.id] ?? 0), 0)])),
          totalAmount: round2(rows.reduce((s, r) => s + r.totalAmount, 0)),
        };

        return { key, label, products: groupProds, rows, totals };
      };

      return reply.send({
        from: q.from,
        to: q.to,
        dates,
        groups: [
          buildGroup("milk", "Milk Items", cfg.categoryGroups.milk),
          buildGroup("curd", "Curd Items", cfg.categoryGroups.curd),
          buildGroup("lassi", "Lassi & Majige Items", cfg.categoryGroups.lassi),
        ],
      });
    }
  );

  // ════════════════════════════════════════════
  // B2. Day / Route Wise Cash Sales — 1 page
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/day-route-cash",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);
      const cfg = await loadReportConfig();

      const dateList = await pgClient`
        SELECT to_char(d::date, 'YYYY-MM-DD') AS date
        FROM generate_series(${q.from}::date, ${q.to}::date, interval '1 day') d
        ORDER BY d
      `;
      const dates = dateList.map((r: any) => r.date);

      const routes = await pgClient`
        SELECT r.id, r.code, r.name
        FROM routes r
        WHERE r.deleted_at IS NULL AND r.active = true
        ORDER BY r.code
      `;

      const cashModes = cfg.cashPaymentModes; // ['cash','upi','wallet']
      const salesRows = await pgClient`
        SELECT o.created_at::date AS sale_date,
               d.route_id,
               SUM(o.grand_total)::numeric AS amount
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        WHERE o.created_at::date >= ${q.from}::date
          AND o.created_at::date <= ${q.to}::date
          AND o.status != 'cancelled'
          AND o.payment_mode::text = ANY(${cashModes}::text[])
          AND d.route_id IS NOT NULL
        GROUP BY o.created_at::date, d.route_id
      `;

      const matrix: Record<string, Record<string, number>> = {};
      const routeTotals: Record<string, number> = {};
      const dayTotals: Record<string, number> = {};
      let grandTotal = 0;

      for (const date of dates) {
        matrix[date] = {};
        dayTotals[date] = 0;
        for (const r of routes as any[]) {
          matrix[date][r.id] = 0;
          routeTotals[r.id] = routeTotals[r.id] ?? 0;
        }
      }

      for (const row of salesRows as any[]) {
        const d = new Date(row.sale_date).toISOString().slice(0, 10);
        const amt = parseFloat(row.amount) || 0;
        if (!matrix[d]) continue;
        matrix[d][row.route_id] = round2(amt);
        routeTotals[row.route_id] = round2((routeTotals[row.route_id] ?? 0) + amt);
        dayTotals[d] = round2((dayTotals[d] ?? 0) + amt);
        grandTotal += amt;
      }

      return reply.send({
        from: q.from,
        to: q.to,
        dates,
        routes: (routes as any[]).map(r => ({ id: r.id, code: r.code, name: r.name })),
        matrix,
        routeTotals,
        dayTotals,
        grandTotal: round2(grandTotal),
      });
    }
  );

  // ════════════════════════════════════════════
  // B3. Officer Wise Sales (Qty) — 1 page
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/officer-wise",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);

      const products = await pgClient`
        SELECT id, report_alias, name, sort_order
        FROM products
        WHERE deleted_at IS NULL AND available = true
        ORDER BY sort_order, name
      `;

      const officers = await pgClient`
        SELECT id, name
        FROM users
        WHERE role = 'officer' AND active = true
        ORDER BY name
      `;

      // Combined qty per (product, officer) from orders + direct sales
      const rows = await pgClient`
        WITH combined AS (
          SELECT o.officer_id, oi.product_id, oi.quantity::int AS qty
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.created_at::date >= ${q.from}::date
            AND o.created_at::date <= ${q.to}::date
            AND o.status != 'cancelled'
            AND o.officer_id IS NOT NULL
          UNION ALL
          SELECT ds.officer_id, dsi.product_id, dsi.quantity::int AS qty
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND ds.officer_id IS NOT NULL
        )
        SELECT officer_id, product_id, SUM(qty)::int AS qty
        FROM combined
        GROUP BY officer_id, product_id
      `;

      const matrix: Record<string, Record<string, number>> = {};
      const officerTotals: Record<string, number> = {};
      const productTotals: Record<string, number> = {};
      let grandTotal = 0;

      for (const p of products as any[]) {
        const row: Record<string, number> = {};
        matrix[p.id] = row;
        productTotals[p.id] = 0;
        for (const o of officers as any[]) {
          row[o.id] = 0;
          officerTotals[o.id] = officerTotals[o.id] ?? 0;
        }
      }

      for (const r of rows as any[]) {
        const productRow = matrix[r.product_id];
        if (!productRow) continue;
        const qty = Number(r.qty) || 0;
        productRow[r.officer_id] = qty;
        officerTotals[r.officer_id] = (officerTotals[r.officer_id] ?? 0) + qty;
        productTotals[r.product_id] = (productTotals[r.product_id] ?? 0) + qty;
        grandTotal += qty;
      }

      return reply.send({
        from: q.from,
        to: q.to,
        products: (products as any[]).map(p => ({ id: p.id, reportAlias: p.report_alias ?? p.name, sortOrder: p.sort_order })),
        officers: (officers as any[]).map(o => ({ id: o.id, name: o.name })),
        matrix,
        officerTotals,
        productTotals,
        grandTotal,
      });
    }
  );

  // ════════════════════════════════════════════
  // B4. Cash Sales Statement — 2 pages (product grid + summary)
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/cash-sales",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);
      const cfg = await loadReportConfig();
      return reply.send(await buildSalesGrid({ q, cfg, onlyCash: true }));
    }
  );

  // ════════════════════════════════════════════
  // B6. Sales Register — 2 pages (same shape as B4, no payment filter)
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/register",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);
      const cfg = await loadReportConfig();
      return reply.send(await buildSalesGrid({ q, cfg, onlyCash: false }));
    }
  );

  // ════════════════════════════════════════════
  // B5. Credit Sales — N + 1 pages (legacy bill format)
  //
  // Payload mirrors the dairy's paper bill layout:
  //   • Header: customer info, BILL NO (code\month\YY), period
  //   • Product columns (dynamic count = products customer bought)
  //   • Daily rows: day number + per-product qty + day total
  //   • Footer totals: Pkts, Kg\ltr, BASIC, CGST, SGST, Amount
  //     Grand totals summed into the Total Amount column
  //   • Final summary page: one row per credit customer with bill total
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/credit-sales",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);

      // All credit sales line items in range (one row per order_item)
      // Only keep orders paid on credit; a credit customer might have cash
      // orders too — those don't belong on the bill.
      const lines = await pgClient`
        SELECT d.id   AS dealer_id,
               d.code AS dealer_code,
               d.name AS dealer_name,
               d.address,
               d.city,
               d.gst_number,
               d.rate_category,
               oi.product_id,
               p.code AS product_code,
               COALESCE(p.report_alias, p.name) AS product_name,
               c.name AS category_name,
               p.hsn_no,
               COALESCE(p.pack_size, 0)::numeric AS pack_size,
               p.sort_order,
               p.gst_percent::numeric AS gst_percent,
               o.created_at::date AS sale_date,
               oi.quantity::int  AS qty,
               oi.unit_price::numeric AS unit_price,
               oi.line_total::numeric AS line_total
        FROM orders o
        JOIN dealers d    ON d.id = o.dealer_id
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p   ON p.id = oi.product_id
        JOIN categories c ON c.id = p.category_id
        WHERE o.created_at::date >= ${q.from}::date
          AND o.created_at::date <= ${q.to}::date
          AND o.status != 'cancelled'
          AND o.payment_mode = 'credit'
      `;

      // Helpers
      const ddmmyyyy = (iso: string) => {
        const [y, m, d] = iso.split("-");
        return `${d}-${m}-${y}`;
      };
      const buildBillNo = (code: string, fromDate: string) => {
        const parts = fromDate.split("-");
        const y = parts[0] ?? "";
        const m = parts[1] ?? "";
        return `${code ?? ""}\\${Number(m)}\\${y.slice(2)}`;
      };

      // Group lines by dealer → product, track daily qty per (dealer, product, date)
      type ProdAgg = {
        id: string;
        code: string;
        reportAlias: string;
        category: string;
        hsn: string;
        packSize: number;
        rate: number;      // unit_price observed (last seen)
        gstPct: number;
        sortOrder: number;
        dailyQty: Map<string, number>; // date → qty
      };
      type CustAgg = {
        id: string;
        code: string;
        name: string;
        address: string | null;
        city: string | null;
        gstNumber: string | null;
        rateCategory: string | null;
        products: Map<string, ProdAgg>;
      };

      const custMap = new Map<string, CustAgg>();
      for (const r of lines as any[]) {
        if (!custMap.has(r.dealer_id)) {
          custMap.set(r.dealer_id, {
            id: r.dealer_id,
            code: r.dealer_code ?? "",
            name: r.dealer_name,
            address: r.address ?? null,
            city: r.city ?? null,
            gstNumber: r.gst_number ?? null,
            rateCategory: r.rate_category ?? null,
            products: new Map(),
          });
        }
        const cust = custMap.get(r.dealer_id)!;
        if (!cust.products.has(r.product_id)) {
          cust.products.set(r.product_id, {
            id: r.product_id,
            code: r.product_code ?? "",
            reportAlias: r.product_name,
            category: (r.category_name ?? "").toUpperCase(),
            hsn: r.hsn_no ?? "",
            packSize: parseFloat(r.pack_size) || 0,
            rate: parseFloat(r.unit_price) || 0,
            gstPct: parseFloat(r.gst_percent) || 0,
            sortOrder: Number(r.sort_order) || 0,
            dailyQty: new Map(),
          });
        }
        const prod = cust.products.get(r.product_id)!;
        const iso = new Date(r.sale_date).toISOString().slice(0, 10);
        prod.dailyQty.set(iso, (prod.dailyQty.get(iso) ?? 0) + (Number(r.qty) || 0));
        // unit_price is usually constant per period; keep the largest seen
        if (parseFloat(r.unit_price) > prod.rate) prod.rate = parseFloat(r.unit_price);
      }

      // Build every date in the period — bill shows blank qty on zero-sale days
      const dateList: string[] = [];
      {
        const cur = new Date(q.from);
        const end = new Date(q.to);
        while (cur <= end) {
          dateList.push(cur.toISOString().slice(0, 10));
          cur.setDate(cur.getDate() + 1);
        }
      }

      const customers = Array.from(custMap.values())
        .sort((a, b) => (a.code || "").localeCompare(b.code || "") || a.name.localeCompare(b.name))
        .map(cust => {
          const products = Array.from(cust.products.values())
            .sort((a, b) => a.sortOrder - b.sortOrder || a.reportAlias.localeCompare(b.reportAlias));

          // Per-day rows
          const dailyRows = dateList.map(iso => {
            const qty = products.map(p => p.dailyQty.get(iso) ?? 0);
            const dayTotal = qty.reduce((s, q, i) => s + q * (products[i]?.rate ?? 0), 0);
            const [_, __, day] = iso.split("-");
            return {
              day,           // "01" .. "31"
              date: iso,     // full ISO for tooltip / debugging
              qty,           // array aligned with products[]
              dayTotal: round2(dayTotal),
            };
          });

          // Footer totals — all arrays aligned with products[]
          const pkts = products.map((_, i) => dailyRows.reduce((s, r) => s + (r.qty[i] ?? 0), 0));
          const kgLtr = products.map((p, i) => round3(((pkts[i] ?? 0) * p.packSize) / 1000));
          const basic = products.map((p, i) => round2((pkts[i] ?? 0) * p.rate));
          const cgstPctArr = products.map(p => round2(p.gstPct / 2));
          const sgstPctArr = products.map(p => round2(p.gstPct / 2));
          const cgst = products.map((p, i) => round3((basic[i] ?? 0) * (p.gstPct / 2) / 100));
          const sgst = products.map((p, i) => round3((basic[i] ?? 0) * (p.gstPct / 2) / 100));
          const amount = products.map((_, i) => round2((basic[i] ?? 0) + (cgst[i] ?? 0) + (sgst[i] ?? 0)));

          const basicGrand = round2(basic.reduce((s, v) => s + v, 0));
          const cgstGrand = round3(cgst.reduce((s, v) => s + v, 0));
          const sgstGrand = round3(sgst.reduce((s, v) => s + v, 0));
          const amountGrand = round2(amount.reduce((s, v) => s + v, 0));

          return {
            id: cust.id,
            code: cust.code,
            name: cust.name,
            address: cust.address,
            city: cust.city,
            gstNumber: cust.gstNumber,
            billNo: buildBillNo(cust.code, q.from),
            periodFrom: ddmmyyyy(q.from),
            periodTo: ddmmyyyy(q.to),
            rateCategory: cust.rateCategory,
            products: products.map(p => ({
              id: p.id,
              code: p.code,
              reportAlias: p.reportAlias,
              category: p.category,
              hsn: p.hsn,
              rate: round2(p.rate),
              packSize: p.packSize,
              gstPct: round2(p.gstPct),
            })),
            dailyRows,
            totals: {
              pkts,
              kgLtr,
              basic,
              cgstPct: cgstPctArr,
              cgst,
              sgstPct: sgstPctArr,
              sgst,
              amount,
              basicGrand,
              cgstGrand,
              sgstGrand,
              amountGrand,
            },
          };
        });

      // Final summary page
      const summary = customers.map((c, idx) => ({
        sl: idx + 1,
        code: c.code,
        name: c.name,
        total: c.totals.amountGrand,
      }));
      const summaryTotal = round2(summary.reduce((s, r) => s + r.total, 0));

      return reply.send({
        from: q.from,
        to: q.to,
        periodFrom: ddmmyyyy(q.from),
        periodTo: ddmmyyyy(q.to),
        customers,
        summary,
        summaryTotal,
      });
    }
  );

  // ════════════════════════════════════════════
  // B7. Taluka / Agent Wise Sales — 2 pages per taluka
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/taluka-agent",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);
      const cfg = await loadReportConfig();

      const products = await pgClient`
        SELECT p.id, p.code, p.report_alias, p.name, p.sort_order, c.name AS category_name
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL AND p.available = true
        ORDER BY p.sort_order, p.name
      `;

      // Resolve fixed cookie products by code
      const fixedCodes = cfg.talukaFixedProducts.map(x => x.code);
      const fixedRows = fixedCodes.length
        ? await pgClient`SELECT id, code FROM products WHERE code = ANY(${fixedCodes}::text[]) AND deleted_at IS NULL`
        : [];
      const fixedCodeToId = new Map((fixedRows as any[]).map(r => [r.code, r.id]));
      const fixedSummaryProducts = cfg.talukaFixedProducts.map(f => ({
        code: f.code,
        label: f.label,
        id: fixedCodeToId.get(f.code) ?? null,
      }));

      // Per (taluka=zone, dealer, product) qty + amount
      const rows = await pgClient`
        SELECT z.name AS taluka,
               d.id AS dealer_id, d.code AS dealer_code, d.name AS dealer_name,
               oi.product_id,
               p.category_id, c.name AS category_name,
               SUM(oi.quantity)::int       AS qty,
               SUM(oi.line_total)::numeric AS amount
        FROM orders o
        JOIN dealers d ON d.id = o.dealer_id
        JOIN zones z ON z.id = o.zone_id
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p ON p.id = oi.product_id
        JOIN categories c ON c.id = p.category_id
        WHERE o.created_at::date >= ${q.from}::date
          AND o.created_at::date <= ${q.to}::date
          AND o.status != 'cancelled'
        GROUP BY z.name, d.id, d.code, d.name, oi.product_id, p.category_id, c.name
        ORDER BY z.name, d.code, d.name
      `;

      const milkCats: string[] = cfg.milkCategoryGroup;
      const curdCats: string[] = cfg.categoryGroups.curd;

      // Index rows by (taluka → dealer → {products})
      const talukaMap = new Map<string, any>();
      for (const r of rows as any[]) {
        if (!talukaMap.has(r.taluka)) {
          talukaMap.set(r.taluka, {
            name: r.taluka,
            customersMap: new Map<string, any>(),
          });
        }
        const t = talukaMap.get(r.taluka);
        if (!t.customersMap.has(r.dealer_id)) {
          t.customersMap.set(r.dealer_id, {
            code: r.dealer_code ?? "",
            name: r.dealer_name,
            qty: Object.fromEntries((products as any[]).map(p => [p.id, 0])),
            total: 0,
            // summary columns
            summary: {
              cookies20: 0, butterCookies100: 0, kodubale180: 0, paneerNippattu400: 0,
              milkTotalQty: 0, curdTotalQty: 0, totalAmount: 0,
            },
          });
        }
        const cust = t.customersMap.get(r.dealer_id);
        const qty = Number(r.qty) || 0;
        const amt = parseFloat(r.amount) || 0;
        cust.qty[r.product_id] = qty;
        cust.total = round2(cust.total + amt);
        cust.summary.totalAmount = round2(cust.summary.totalAmount + amt);
        // milk / curd category buckets
        if (milkCats.includes(r.category_name) && !curdCats.includes(r.category_name)) {
          cust.summary.milkTotalQty += qty;
        }
        if (curdCats.includes(r.category_name)) {
          cust.summary.curdTotalQty += qty;
        }
        // fixed cookie columns (resolved by product_id)
        if (fixedSummaryProducts[0] && r.product_id === fixedSummaryProducts[0].id) cust.summary.cookies20 += qty;
        if (fixedSummaryProducts[1] && r.product_id === fixedSummaryProducts[1].id) cust.summary.butterCookies100 += qty;
        if (fixedSummaryProducts[2] && r.product_id === fixedSummaryProducts[2].id) cust.summary.kodubale180 += qty;
        if (fixedSummaryProducts[3] && r.product_id === fixedSummaryProducts[3].id) cust.summary.paneerNippattu400 += qty;
      }

      // Materialize
      const talukas = Array.from(talukaMap.values()).map(t => {
        const customers = Array.from(t.customersMap.values()).map((c: any, idx: number) => ({
          sl: idx + 1,
          code: c.code,
          name: c.name,
          qty: c.qty,
          total: round2(c.total),
        }));
        const detailedTotals = {
          qty: Object.fromEntries(
            (products as any[]).map(p => [p.id, customers.reduce((s, r) => s + (r.qty[p.id] ?? 0), 0)])
          ),
          total: round2(customers.reduce((s, r) => s + r.total, 0)),
        };
        const summary = Array.from(t.customersMap.values()).map((c: any, idx: number) => ({
          sl: idx + 1,
          code: c.code,
          name: c.name,
          ...c.summary,
        }));
        const summaryTotals = summary.reduce(
          (acc: any, r: any) => ({
            cookies20: acc.cookies20 + r.cookies20,
            butterCookies100: acc.butterCookies100 + r.butterCookies100,
            kodubale180: acc.kodubale180 + r.kodubale180,
            paneerNippattu400: acc.paneerNippattu400 + r.paneerNippattu400,
            milkTotalQty: acc.milkTotalQty + r.milkTotalQty,
            curdTotalQty: acc.curdTotalQty + r.curdTotalQty,
            totalAmount: round2(acc.totalAmount + r.totalAmount),
          }),
          { cookies20: 0, butterCookies100: 0, kodubale180: 0, paneerNippattu400: 0, milkTotalQty: 0, curdTotalQty: 0, totalAmount: 0 }
        );
        return { name: t.name, customers, detailedTotals, summary, summaryTotals };
      });

      return reply.send({
        from: q.from,
        to: q.to,
        products: (products as any[]).map(p => ({ id: p.id, reportAlias: p.report_alias ?? p.name, sortOrder: p.sort_order })),
        fixedSummaryProducts,
        talukas,
      });
    }
  );

  // ════════════════════════════════════════════
  // B8. Adhoc Sales Abstract — 1 page paginated
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/adhoc",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const qs = reportPagination.extend({
        from: z.string(),
        to: z.string(),
      });
      const q = qs.parse(request.query);
      const offset = offsetFromPage(q.page, q.limit);

      const rows = await pgClient`
        SELECT ds.id,
               ds.gp_no,
               ds.sale_date,
               CASE
                 WHEN ds.customer_type = 'agent' THEN d.name
                 WHEN ds.customer_type = 'cash'  THEN cc.name
               END AS customer_name,
               ds.grand_total::numeric AS amount
        FROM direct_sales ds
        LEFT JOIN dealers d        ON ds.customer_type = 'agent' AND d.id = ds.customer_id
        LEFT JOIN cash_customers cc ON ds.customer_type = 'cash'  AND cc.id = ds.customer_id
        WHERE ds.sale_date >= ${q.from}::date
          AND ds.sale_date <= ${q.to}::date
        ORDER BY ds.sale_date DESC, ds.gp_no
        LIMIT ${q.limit} OFFSET ${offset}
      `;

      const [countRow] = await pgClient`
        SELECT count(*)::int AS count, COALESCE(sum(grand_total),0)::numeric AS total_amount
        FROM direct_sales
        WHERE sale_date >= ${q.from}::date AND sale_date <= ${q.to}::date
      `;

      const mapped = (rows as any[]).map((r, idx) => ({
        sl: offset + idx + 1,
        indentDate: new Date(r.sale_date).toISOString().slice(0, 10),
        gpNo: r.gp_no ?? "",
        customerName: r.customer_name ?? "",
        amount: round2(parseFloat(r.amount) || 0),
      }));

      return reply.send({
        rows: mapped,
        totalAmount: round2(parseFloat((countRow as any)?.total_amount ?? 0)),
        ...paginationMeta((countRow as any)?.count ?? 0, q.page, q.limit),
      });
    }
  );

  // ════════════════════════════════════════════
  // B9. GST Sales Statement — 1 page
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/gst-statement",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);

      const rows = await pgClient`
        WITH combined AS (
          SELECT oi.product_id, oi.gst_percent, oi.quantity::int AS qty,
                 oi.unit_price, oi.gst_amount, oi.line_total
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.created_at::date >= ${q.from}::date
            AND o.created_at::date <= ${q.to}::date
            AND o.status != 'cancelled'
          UNION ALL
          SELECT dsi.product_id, dsi.gst_percent, dsi.quantity::int AS qty,
                 dsi.unit_price, dsi.gst_amount, dsi.line_total
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
        )
        SELECT p.id AS product_id,
               COALESCE(p.report_alias, p.name) AS product_name,
               p.sort_order,
               p.hsn_no,
               c.gst_percent                          AS gst_percent,
               SUM(c.qty)::int                        AS qty,
               SUM(c.unit_price * c.qty)::numeric     AS taxable_value,
               SUM(c.gst_amount / 2)::numeric         AS cgst,
               SUM(c.gst_amount / 2)::numeric         AS sgst,
               SUM(c.gst_amount)::numeric             AS total_tax,
               SUM(c.line_total)::numeric             AS invoice_value
        FROM combined c
        JOIN products p ON p.id = c.product_id
        GROUP BY p.id, p.report_alias, p.name, p.sort_order, p.hsn_no, c.gst_percent
        ORDER BY p.sort_order, p.name
      `;

      const mapped = (rows as any[]).map((r, idx) => ({
        sl: idx + 1,
        productId: r.product_id,
        productName: r.product_name,
        hsn: r.hsn_no ?? "",
        qty: Number(r.qty) || 0,
        gstPct: round2(parseFloat(r.gst_percent) || 0),
        taxableValue: round2(parseFloat(r.taxable_value) || 0),
        cgst: round2(parseFloat(r.cgst) || 0),
        sgst: round2(parseFloat(r.sgst) || 0),
        totalTax: round2(parseFloat(r.total_tax) || 0),
        invoiceValue: round2(parseFloat(r.invoice_value) || 0),
      }));

      const totals = mapped.reduce(
        (acc, r) => ({
          qty: acc.qty + r.qty,
          taxableValue: round2(acc.taxableValue + r.taxableValue),
          cgst: round2(acc.cgst + r.cgst),
          sgst: round2(acc.sgst + r.sgst),
          totalTax: round2(acc.totalTax + r.totalTax),
          invoiceValue: round2(acc.invoiceValue + r.invoiceValue),
        }),
        { qty: 0, taxableValue: 0, cgst: 0, sgst: 0, totalTax: 0, invoiceValue: 0 }
      );

      return reply.send({ from: q.from, to: q.to, rows: mapped, totals });
    }
  );
}

// ── Shared helper: B4 (cash) + B6 (register) produce the same shape ──
async function buildSalesGrid(opts: { q: { from: string; to: string }; cfg: ReportConfig; onlyCash: boolean }) {
  const { q, cfg, onlyCash } = opts;

  const products = await pgClient`
    SELECT p.id, p.report_alias, p.name, p.sort_order, c.name AS category_name
    FROM products p
    JOIN categories c ON c.id = p.category_id
    WHERE p.deleted_at IS NULL AND p.available = true
    ORDER BY p.sort_order, p.name
  `;

  const routes = await pgClient`
    SELECT r.id, r.code, r.name, ct.name AS contractor_name
    FROM routes r
    LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
    WHERE r.deleted_at IS NULL AND r.active = true
    ORDER BY r.code
  `;

  const cashModes = cfg.cashPaymentModes;
  const paymentFilter = onlyCash ? cashModes : null;

  // Per (route, product) qty + amount from orders
  const rowsOrders = await pgClient`
    SELECT d.route_id, oi.product_id, c.name AS category_name,
           SUM(oi.quantity)::int       AS qty,
           SUM(oi.line_total)::numeric AS amount
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    JOIN order_items oi ON oi.order_id = o.id
    JOIN products p ON p.id = oi.product_id
    JOIN categories c ON c.id = p.category_id
    WHERE o.created_at::date >= ${q.from}::date
      AND o.created_at::date <= ${q.to}::date
      AND o.status != 'cancelled'
      AND d.route_id IS NOT NULL
      AND (${paymentFilter}::text[] IS NULL OR o.payment_mode::text = ANY(${paymentFilter ?? cashModes}::text[]))
    GROUP BY d.route_id, oi.product_id, c.name
  `;

  // Per (route, product) from direct sales (register only; cash-sales excludes them to match spec intent)
  const rowsDirect = !onlyCash ? await pgClient`
    SELECT ds.route_id, dsi.product_id, c.name AS category_name,
           SUM(dsi.quantity)::int       AS qty,
           SUM(dsi.line_total)::numeric AS amount
    FROM direct_sales ds
    JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
    JOIN products p ON p.id = dsi.product_id
    JOIN categories c ON c.id = p.category_id
    WHERE ds.sale_date >= ${q.from}::date
      AND ds.sale_date <= ${q.to}::date
      AND ds.route_id IS NOT NULL
    GROUP BY ds.route_id, dsi.product_id, c.name
  ` : [];

  const milkCats = cfg.milkCategoryGroup;

  const routeAgg = new Map<string, any>();
  for (const r of routes as any[]) {
    routeAgg.set(r.id, {
      id: r.id,
      code: r.code,
      name: r.name,
      contractorName: r.contractor_name ?? null,
      qty: Object.fromEntries((products as any[]).map(p => [p.id, 0])),
      amount: Object.fromEntries((products as any[]).map(p => [p.id, 0])),
      milkAmount: 0,
      productAmount: 0,
      total: 0,
    });
  }

  const apply = (row: any) => {
    const agg = routeAgg.get(row.route_id);
    if (!agg) return;
    const qty = Number(row.qty) || 0;
    const amt = parseFloat(row.amount) || 0;
    agg.qty[row.product_id] = (agg.qty[row.product_id] ?? 0) + qty;
    agg.amount[row.product_id] = round2((agg.amount[row.product_id] ?? 0) + amt);
    if (milkCats.includes(row.category_name)) agg.milkAmount = round2(agg.milkAmount + amt);
    else agg.productAmount = round2(agg.productAmount + amt);
    agg.total = round2(agg.total + amt);
  };

  for (const r of rowsOrders as any[]) apply(r);
  for (const r of rowsDirect as any[]) apply(r);

  const routesOut = Array.from(routeAgg.values());

  // Grand totals
  const totals = {
    qty: Object.fromEntries((products as any[]).map(p => [p.id, routesOut.reduce((s, r) => s + (r.qty[p.id] ?? 0), 0)])),
    amount: Object.fromEntries((products as any[]).map(p => [p.id, round2(routesOut.reduce((s, r) => s + (r.amount[p.id] ?? 0), 0))])),
    milkAmount: round2(routesOut.reduce((s, r) => s + r.milkAmount, 0)),
    productAmount: round2(routesOut.reduce((s, r) => s + r.productAmount, 0)),
    total: round2(routesOut.reduce((s, r) => s + r.total, 0)),
  };

  return {
    from: q.from,
    to: q.to,
    products: (products as any[]).map(p => ({ id: p.id, reportAlias: p.report_alias ?? p.name, sortOrder: p.sort_order })),
    routes: routesOut,
    totals,
  };
}

// ── utility ──
function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round3(n: number): number {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}