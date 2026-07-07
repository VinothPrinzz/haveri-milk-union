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

// Fixed milk / curd / lassi SKU map shared by the Daily Sales Report and the
// Taluka/Agent milk-sales summary. `bucket` + `qtyToUnit` give the per-packet
// Ltr (milk) / Kg (curd) factor, so volume totals are derived straight from
// packet counts — always consistent regardless of how pack_size is stored.
const DSR_COLUMNS = [
  { key: "htm1000",     code: "PD0191", name: "HTM 1000ML",         header: "HTM 1000ml",         group: "HTM MILK", bucket: "milk", qtyToUnit: 1.0 },
  { key: "htm500",      code: "PD0193", name: "HTM 500ML",          header: "HTM 500ML",          group: "HTM MILK", bucket: "milk", qtyToUnit: 0.5 },
  { key: "hcm160",      code: "PD0187", name: "HCM 160ML",          header: "HCM 160ML",          group: "HCM MILK", bucket: "milk", qtyToUnit: 0.16 },
  { key: "hcm500",      code: "PD0188", name: "HCM 500ML",          header: "HCM 500ML",          group: "HCM MILK", bucket: "milk", qtyToUnit: 0.5 },
  { key: "sbm1000",     code: "PD0274", name: "SHUBHAM 1000ML",     header: "SBM 1000ML",         group: "SBM MILK", bucket: "milk", qtyToUnit: 1.0 },
  { key: "sbm500",      code: "PD0277", name: "SHUBHAM 500ML",      header: "SBM 500ML",          group: "SBM MILK", bucket: "milk", qtyToUnit: 0.5 },
  { key: "sbm200",      code: "PD0276", name: "SHUBHAM 200ML",      header: "SBM 200ML",          group: "SBM MILK", bucket: "milk", qtyToUnit: 0.2 },
  { key: "samrudhi500", code: "PD0248", name: "SAMRUDHI 500ML",     header: "SAMRUDHI 500ML",     group: "SAMRUDHI", bucket: "milk", qtyToUnit: 0.5 },
  { key: "curd140",     code: "PD0122", name: "CURD 140GM",         header: "CURD 140GM",         group: "CURD", bucket: "curd", qtyToUnit: 0.14 },
  { key: "curd200",     code: "PD0124", name: "CURD 200 GM",        header: "CURD 200GM",         group: "CURD", bucket: "curd", qtyToUnit: 0.2 },
  { key: "curd500",     code: "PD0126", name: "CURD 500GM",         header: "CURD 500GM",         group: "CURD", bucket: "curd", qtyToUnit: 0.5 },
  { key: "curd10kg",    code: "PD0127", name: "CURD BUCKET 10KG",   header: "CURD 10KG (B)",      group: "CURD", bucket: "curd", qtyToUnit: 10 },
  { key: "curd5kg",     code: "PD0128", name: "CURD BUCKET 5KG",    header: "CURD 05KG (B)",      group: "CURD", bucket: "curd", qtyToUnit: 5 },
  // 200ml lassi / buttermilk — 0.2 L per packet so they read in litres too.
  { key: "sl200",       code: "PD0288", name: "SWEET LASSI -200ML", header: "SL 200 ML",          group: "", bucket: "other", qtyToUnit: 0.2 },
  { key: "majjige",     code: "PD0217", name: "MASALA MAJJIGE 200ML", header: "MASAL MAJJIGE 200ML", group: "", bucket: "other", qtyToUnit: 0.2 },
] as const;
const MILK_COLS = DSR_COLUMNS.filter(c => c.bucket === "milk");
const CURD_COLS = DSR_COLUMNS.filter(c => c.bucket === "curd");

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
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
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
      // Category names are matched case-insensitively: the config/defaults use
      // capitalized names ("Milk") while the DB stores them lowercase ("milk"),
      // so an exact match would silently drop every product from the group.
      const buildGroup = (key: "milk" | "curd" | "lassi", label: string, categories: string[]) => {
        const catSet = new Set(categories.map(c => c.toLowerCase()));
        const groupProds = (products as any[])
          .filter(p => catSet.has((p.category_name ?? "").toLowerCase()))
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
          AND o.status IN ('confirmed', 'dispatched', 'delivered')
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
        FROM officers
        WHERE active = true
        ORDER BY name
      `;

      // Combined qty per (product, taluka officer). Sales are attributed to
      // the field officer of the customer's taluka: sale → dealer → zone →
      // officer. Direct sales only map to a dealer for customer_type='agent';
      // cash / vip / employee direct sales have no dealer taluka and are left
      // unattributed.
      const rows = await pgClient`
        WITH combined AS (
          SELECT z.officer_id, oi.product_id, oi.quantity::int AS qty
          FROM orders o
          JOIN dealers d ON d.id = o.dealer_id
          JOIN zones z   ON z.id = d.zone_id
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.created_at::date >= ${q.from}::date
            AND o.created_at::date <= ${q.to}::date
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            AND z.officer_id IS NOT NULL
          UNION ALL
          SELECT z.officer_id, dsi.product_id, dsi.quantity::int AS qty
          FROM direct_sales ds
          JOIN dealers d ON d.id = ds.customer_id AND ds.customer_type = 'agent'
          JOIN zones z   ON z.id = d.zone_id
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND z.officer_id IS NOT NULL
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
               p.unit,
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
          AND o.status IN ('confirmed', 'dispatched', 'delivered')
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
        unit: string;
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
            unit: r.unit ?? "",
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
          const kgLtr = products.map((p, i) => round3(toKgLtr(pkts[i] ?? 0, p.packSize, p.unit)));
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
        SELECT p.id, p.code, p.report_alias, p.name, p.sort_order,
               COALESCE(p.pack_size, 0)::numeric AS pack_size, p.unit,
               c.name AS category_name
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
          AND o.status IN ('confirmed', 'dispatched', 'delivered')
        GROUP BY z.name, d.id, d.code, d.name, oi.product_id, p.category_id, c.name
        ORDER BY z.name, d.code, d.name
      `;

      // Case-insensitive: config uses capitalized names, DB stores lowercase.
      const milkCatSet = new Set(cfg.milkCategoryGroup.map(c => c.toLowerCase()));
      const curdCatSet = new Set(cfg.categoryGroups.curd.map(c => c.toLowerCase()));
      const catOf = (name: string) => (name ?? "").toLowerCase();

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
        if (milkCatSet.has(catOf(r.category_name)) && !curdCatSet.has(catOf(r.category_name))) {
          cust.summary.milkTotalQty += qty;
        }
        if (curdCatSet.has(catOf(r.category_name))) {
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

      // ── Taluka wise milk sales (In Ltrs) overview ──
      // Total Milk (Ltr) / Total Curd (Kg) per taluka = Σ packets × per-pack
      // volume, read live from each product's DB pack_size + unit (same SKU set
      // as the Daily Sales Report; hardcoded qtyToUnit only as a fallback when
      // a product/pack_size can't be resolved). Avg = Total ÷ days.
      const milkFactorById = new Map<string, number>();
      const curdFactorById = new Map<string, number>();
      {
        const milkByCode = new Map(MILK_COLS.map(c => [c.code, c.qtyToUnit]));
        const curdByCode = new Map(CURD_COLS.map(c => [c.code, c.qtyToUnit]));
        for (const p of products as any[]) {
          const dbPerPack = toKgLtr(1, parseFloat(p.pack_size) || 0, p.unit ?? "");
          if (milkByCode.has(p.code))
            milkFactorById.set(p.id, dbPerPack > 0 ? dbPerPack : milkByCode.get(p.code)!);
          if (curdByCode.has(p.code))
            curdFactorById.set(p.id, dbPerPack > 0 ? dbPerPack : curdByCode.get(p.code)!);
        }
      }
      const volByTaluka = new Map<string, { milk: number; curd: number }>();
      for (const r of rows as any[]) {
        const v = volByTaluka.get(r.taluka) ?? { milk: 0, curd: 0 };
        const qty = Number(r.qty) || 0;
        if (milkFactorById.has(r.product_id)) v.milk += qty * milkFactorById.get(r.product_id)!;
        if (curdFactorById.has(r.product_id)) v.curd += qty * curdFactorById.get(r.product_id)!;
        volByTaluka.set(r.taluka, v);
      }
      const numDays = Math.max(
        1,
        Math.round((new Date(q.to).getTime() - new Date(q.from).getTime()) / 86_400_000) + 1
      );
      const milkSummaryRows = talukas.map(t => {
        const v = volByTaluka.get(t.name) ?? { milk: 0, curd: 0 };
        return {
          taluka: t.name,
          totalMilk: round2(v.milk),
          avgMilk: round2(v.milk / numDays),
          totalCurd: round2(v.curd),
          avgCurd: round2(v.curd / numDays),
        };
      });
      const grandMilk = round2(milkSummaryRows.reduce((s, r) => s + r.totalMilk, 0));
      const grandCurd = round2(milkSummaryRows.reduce((s, r) => s + r.totalCurd, 0));
      const talukaMilkSummary = {
        numDays,
        rows: milkSummaryRows,
        totals: {
          totalMilk: grandMilk,
          avgMilk: round2(grandMilk / numDays),
          totalCurd: grandCurd,
          avgCurd: round2(grandCurd / numDays),
        },
      };

      return reply.send({
        from: q.from,
        to: q.to,
        products: (products as any[]).map(p => ({ id: p.id, reportAlias: p.report_alias ?? p.name, sortOrder: p.sort_order })),
        fixedSummaryProducts,
        talukaMilkSummary,
        talukas,
      });
    }
  );

  // ════════════════════════════════════════════
  // B7b. Taluka Wise Report — 3 pages
  //   1. Milk sales (In Ltrs) — taluka × milk product
  //   2. Curd sales (In Kgs)  — taluka × curd product
  //   3. Summary — Total Milk / Avg Milk / Total Curd / Avg Curd per taluka
  //
  //   Volume per (taluka, product) = Σ packets × pack_size (unit-aware, see
  //   toKgLtr) — pack_size is stored in the macro unit (L for milk, kg for
  //   curd), so milk reads in litres and curd in kilograms. Averages divide by
  //   the number of days in the period. Sales are attributed to the order's
  //   zone (taluka), like the Taluka/Agent report.
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/taluka-wise",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);
      const cfg = await loadReportConfig();

      // Case-insensitive: config uses capitalized names, DB stores lowercase.
      const milkCatSet = new Set(cfg.categoryGroups.milk.map(c => c.toLowerCase()));
      const curdCatSet = new Set(cfg.categoryGroups.curd.map(c => c.toLowerCase()));
      const catOf = (n: string) => (n ?? "").toLowerCase();

      // Milk + curd products = the report's columns. Pulled once so the columns
      // stay stable across talukas (even products with zero sales appear).
      const products = await pgClient`
        SELECT p.id, p.report_alias, p.name, p.sort_order,
               COALESCE(p.pack_size, 0)::numeric AS pack_size,
               p.unit,
               c.name AS category_name
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL AND p.available = true
        ORDER BY p.sort_order, p.name
      `;
      const milkProducts = (products as any[]).filter(p => milkCatSet.has(catOf(p.category_name)));
      const curdProducts = (products as any[]).filter(p => curdCatSet.has(catOf(p.category_name)));
      const milkIds = new Set(milkProducts.map(p => p.id));
      const curdIds = new Set(curdProducts.map(p => p.id));
      const packSizeById = new Map((products as any[]).map(p => [p.id, parseFloat(p.pack_size) || 0]));
      const unitById = new Map((products as any[]).map(p => [p.id, p.unit ?? ""]));

      // Per (taluka = zone, product) qty from orders in range.
      const rows = await pgClient`
        SELECT z.name AS taluka, oi.product_id, SUM(oi.quantity)::int AS qty
        FROM orders o
        JOIN zones z ON z.id = o.zone_id
        JOIN order_items oi ON oi.order_id = o.id
        WHERE o.created_at::date >= ${q.from}::date
          AND o.created_at::date <= ${q.to}::date
          AND o.status IN ('confirmed', 'dispatched', 'delivered')
        GROUP BY z.name, oi.product_id
      `;

      const numDays = Math.max(
        1,
        Math.round((new Date(q.to).getTime() - new Date(q.from).getTime()) / 86_400_000) + 1
      );

      // taluka → { productId → volume } (raw; rounded only on the way out)
      const talukaMap = new Map<string, { milkVol: Record<string, number>; curdVol: Record<string, number> }>();
      for (const r of rows as any[]) {
        if (!talukaMap.has(r.taluka)) talukaMap.set(r.taluka, { milkVol: {}, curdVol: {} });
        const t = talukaMap.get(r.taluka)!;
        const vol = toKgLtr(Number(r.qty) || 0, packSizeById.get(r.product_id) ?? 0, unitById.get(r.product_id) ?? "");
        if (milkIds.has(r.product_id)) t.milkVol[r.product_id] = (t.milkVol[r.product_id] ?? 0) + vol;
        else if (curdIds.has(r.product_id)) t.curdVol[r.product_id] = (t.curdVol[r.product_id] ?? 0) + vol;
      }

      const talukaRows = Array.from(talukaMap.keys())
        .sort((a, b) => a.localeCompare(b))
        .map(taluka => {
          const t = talukaMap.get(taluka)!;
          const totalMilk = milkProducts.reduce((s, p) => s + (t.milkVol[p.id] ?? 0), 0);
          const totalCurd = curdProducts.reduce((s, p) => s + (t.curdVol[p.id] ?? 0), 0);
          return {
            taluka,
            milkQty: Object.fromEntries(milkProducts.map(p => [p.id, round2(t.milkVol[p.id] ?? 0)])),
            curdQty: Object.fromEntries(curdProducts.map(p => [p.id, round2(t.curdVol[p.id] ?? 0)])),
            totalMilk: round2(totalMilk),
            avgMilk: round2(totalMilk / numDays),
            totalCurd: round2(totalCurd),
            avgCurd: round2(totalCurd / numDays),
          };
        });

      // Column + grand totals (summed across talukas).
      const colTotal = (sel: (r: typeof talukaRows[number]) => Record<string, number>, id: string) =>
        round2(talukaRows.reduce((s, r) => s + (sel(r)[id] ?? 0), 0));
      const totalMilk = round2(talukaRows.reduce((s, r) => s + r.totalMilk, 0));
      const totalCurd = round2(talukaRows.reduce((s, r) => s + r.totalCurd, 0));

      return reply.send({
        from: q.from,
        to: q.to,
        numDays,
        milkProducts: milkProducts.map(p => ({ id: p.id, reportAlias: p.report_alias ?? p.name, sortOrder: p.sort_order })),
        curdProducts: curdProducts.map(p => ({ id: p.id, reportAlias: p.report_alias ?? p.name, sortOrder: p.sort_order })),
        rows: talukaRows,
        totals: {
          milkQty: Object.fromEntries(milkProducts.map(p => [p.id, colTotal(r => r.milkQty, p.id)])),
          curdQty: Object.fromEntries(curdProducts.map(p => [p.id, colTotal(r => r.curdQty, p.id)])),
          totalMilk,
          avgMilk: round2(totalMilk / numDays),
          totalCurd,
          avgCurd: round2(totalCurd / numDays),
        },
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
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
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

  // ════════════════════════════════════════════════════════════════
  // B10. Employee Subsidy Statement
  //      One endpoint, three reportable views on the client:
  //        • HTM 1000ML
  //        • GHEE 500ML
  //        • Combined (both products per-employee)
  // ════════════════════════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/employee-subsidy",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);

      // 1. Resolve eligible products from employee_subsidy_rules.
      //    Even if a rule is inactive now, we still include it so
      //    historical sales aren't omitted (active filter applies
      //    only to NEW sales validation, not the report).
      const products = await pgClient`
        SELECT p.id, p.code, p.name, p.report_alias
        FROM products p
        WHERE p.id IN (SELECT product_id FROM employee_subsidy_rules)
          AND p.deleted_at IS NULL
        ORDER BY p.name
      `;

      const productsOut = (products as any[]).map(p => ({
        id:    p.id,
        code:  p.code,
        name:  p.name,
        label: p.report_alias ?? p.name,
      }));
      const eligibleIds = productsOut.map(p => p.id);

      if (eligibleIds.length === 0) {
        return reply.send({
          from: q.from, to: q.to,
          products: [], employees: [],
          perProduct: {}, combined: [],
          totals: { perProduct: {}, grandTotal: 0 },
        });
      }

      // 2. Aggregate sales: one row per (employee, product) inside the
      //    date range. Uses customer_type='employee_subsidy' to scope.
      const rows = await pgClient`
        SELECT ds.customer_id                  AS employee_id,
               e.employee_code                 AS employee_code,
               e.name                          AS employee_name,
               dsi.product_id                  AS product_id,
               SUM(dsi.quantity)::int          AS qty,
               SUM(dsi.line_total)::numeric    AS total_amount
        FROM direct_sales ds
        JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
        JOIN employees e ON e.id = ds.customer_id
        WHERE ds.customer_type = 'employee_subsidy'
          AND ds.sale_date >= ${q.from}::date
          AND ds.sale_date <= ${q.to}::date
          AND dsi.product_id = ANY(${eligibleIds}::uuid[])
        GROUP BY ds.customer_id, e.employee_code, e.name, dsi.product_id
        ORDER BY e.employee_code NULLS LAST, e.name
      `;

      // 3. Pivot into the response shapes.
      type R = {
        employeeId: string;
        employeeCode: string | null;
        employeeName: string;
        qty: number;
        totalAmount: number;
      };

      // productId → R[]
      const perProduct: Record<string, R[]> = {};
      for (const p of productsOut) perProduct[p.id] = [];

      // employeeId → { row + perProduct totals }
      const byEmployee = new Map<string, {
        employeeId: string;
        employeeCode: string | null;
        employeeName: string;
        perProduct: Record<string, { qty: number; amount: number }>;
        totalAmount: number;
      }>();

      const perProductTotals: Record<string, number> = {};
      for (const p of productsOut) perProductTotals[p.id] = 0;

      for (const r of rows as any[]) {
        const qty    = Number(r.qty)         || 0;
        const amount = round2(parseFloat(r.total_amount) || 0);

        perProduct[r.product_id]?.push({
          employeeId:   r.employee_id,
          employeeCode: r.employee_code,
          employeeName: r.employee_name,
          qty,
          totalAmount:  amount,
        });

        perProductTotals[r.product_id] = round2(
          (perProductTotals[r.product_id] ?? 0) + amount,
        );

        let emp = byEmployee.get(r.employee_id);
        if (!emp) {
          emp = {
            employeeId:   r.employee_id,
            employeeCode: r.employee_code,
            employeeName: r.employee_name,
            perProduct:   {},
            totalAmount:  0,
          };
          byEmployee.set(r.employee_id, emp);
        }
        emp.perProduct[r.product_id] = { qty, amount };
        emp.totalAmount = round2(emp.totalAmount + amount);
      }

      const combined = Array.from(byEmployee.values())
        .sort((a, b) => {
          const ac = a.employeeCode ?? "";
          const bc = b.employeeCode ?? "";
          if (ac !== bc) return ac.localeCompare(bc, undefined, { numeric: true });
          return a.employeeName.localeCompare(b.employeeName);
        });

      const grandTotal = round2(
        Object.values(perProductTotals).reduce((s, n) => s + n, 0),
      );

      return reply.send({
        from: q.from,
        to:   q.to,
        products: productsOut,
        employees: combined.map(e => ({
          id:   e.employeeId,
          code: e.employeeCode,
          name: e.employeeName,
        })),
        perProduct,
        combined,
        totals: { perProduct: perProductTotals, grandTotal },
      });
    }
  );

  // ════════════════════════════════════════════════════════════════
  // B11. VIP Sales (Free Samples) — 1 page
  //   Lists complimentary issues to VIP contacts (customer_type =
  //   'vip_sample'). Sale prices are 0, so we also surface a notional
  //   value (qty × product base_price) showing the worth of the
  //   samples handed out. One row per sale (line items rolled up).
  // ════════════════════════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/vip-sales",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.parse(request.query);

      const lines = await pgClient`
        SELECT ds.id,
               ds.gp_no,
               ds.sale_date,
               COALESCE(ds.recipient_name, vc.name) AS vip_name,
               vc.designation,
               dsi.product_name,
               dsi.quantity::int                  AS qty,
               COALESCE(p.base_price, 0)::numeric  AS base_price
        FROM direct_sales ds
        JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
        LEFT JOIN vip_contacts vc  ON vc.id = ds.customer_id
        LEFT JOIN products p       ON p.id = dsi.product_id
        WHERE ds.customer_type = 'vip_sample'
          AND ds.sale_date >= ${q.from}::date
          AND ds.sale_date <= ${q.to}::date
        ORDER BY ds.sale_date DESC, ds.gp_no
      `;

      // Roll line items back up into one row per sale (items arrive
      // consecutively thanks to the ORDER BY on sale_date + gp_no).
      const bySale = new Map<string, {
        id: string; date: string; gpNo: string;
        vipName: string; designation: string | null;
        items: string[]; totalQty: number; value: number;
      }>();
      for (const r of lines as any[]) {
        let row = bySale.get(r.id);
        if (!row) {
          row = {
            id: r.id,
            date: new Date(r.sale_date).toISOString().slice(0, 10),
            gpNo: r.gp_no ?? "",
            vipName: r.vip_name ?? "",
            designation: r.designation ?? null,
            items: [], totalQty: 0, value: 0,
          };
          bySale.set(r.id, row);
        }
        const qty = Number(r.qty) || 0;
        row.items.push(`${r.product_name} × ${qty}`);
        row.totalQty += qty;
        row.value += qty * (parseFloat(r.base_price) || 0);
      }

      const rows = Array.from(bySale.values()).map((r, idx) => ({
        sl: idx + 1,
        date: r.date,
        gpNo: r.gpNo,
        vipName: r.vipName,
        designation: r.designation,
        itemsText: r.items.join(", "),
        totalQty: r.totalQty,
        value: round2(r.value),
      }));

      const totalQty = rows.reduce((s, r) => s + r.totalQty, 0);
      const totalValue = round2(rows.reduce((s, r) => s + r.value, 0));

      return reply.send({ from: q.from, to: q.to, rows, totalQty, totalValue });
    }
  );

  // ════════════════════════════════════════════════════════════════
  // Daily Sales Report — "MILK & CURD SALES REPORT"
  //   Single-day route × product cross-tab, split into Night / Afternoon
  //   sales groups (by the route's batch which_batch), with a prev-day
  //   total-milk comparison + diff, sub-totals per group and a grand
  //   "HVR TOTAL". Replaces the sheet the union types by hand each day.
  //
  //   • Night/Afternoon   → routes.primary_batch_id → batches.which_batch
  //                         (Night/Evening → Night, else Afternoon), with a
  //                         batch_routes fallback when no primary batch
  //   • Fixed columns     → matched by product code/name/alias (normalised)
  //   • TOTAL MILK / CURD → sum of ALL Milk / Curd category products
  //                         (ltr / kg, unit-aware)
  //   • TOTAL G/L         → sum of qty of all "G/L" / "GOOD LIFE" products
  //   • ADHOC SALES       → route-less sales (route_id IS NULL), night grp
  // ════════════════════════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/daily-sales-report",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = z.object({ date: z.string() }).parse(request.query);

      // Previous calendar day (for the comparison + diff columns).
      const dateObj = new Date(`${q.date}T00:00:00Z`);
      const prevDate = new Date(dateObj.getTime() - 86_400_000)
        .toISOString()
        .slice(0, 10);

      // Combined qty per (route, product) for the selected day + the previous
      // day, each row tagged cur / prev for the shared cross-tab builder.
      // orders.route via dealers.route_id; direct_sales.route_id direct;
      // route_id NULL → ADHOC bucket.
      const salesRows = await pgClient`
        WITH combined AS (
          SELECT d.route_id AS route_id, o.created_at::date AS sale_date,
                 oi.product_id, oi.quantity::int AS qty
          FROM orders o
          JOIN dealers d      ON d.id = o.dealer_id
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.created_at::date IN (${prevDate}::date, ${q.date}::date)
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
          UNION ALL
          SELECT ds.route_id, ds.sale_date, dsi.product_id, dsi.quantity::int AS qty
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date IN (${prevDate}::date, ${q.date}::date)
        )
        SELECT route_id,
               CASE WHEN sale_date = ${q.date}::date THEN 'cur' ELSE 'prev' END AS period,
               product_id, SUM(qty)::int AS qty
        FROM combined
        GROUP BY route_id, period, product_id
      `;

      const { columns, groups, total } = await buildMilkCurdCrossTab(salesRows as any[]);
      return reply.send({ date: q.date, prevDate, columns, groups, total });
    }
  );

  // ════════════════════════════════════════════════════════════════
  // Monthly Sales Report — "MILK & CURD SALES REPORT" (whole month)
  //   Same route × product cross-tab as the Daily Sales Report, but the
  //   figures are summed across a whole calendar month and the two
  //   comparison columns hold the selected month vs the previous month.
  // ════════════════════════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/monthly-sales-report",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = z.object({ month: z.string().regex(/^\d{4}-\d{2}$/) }).parse(request.query);

      // Selected-month + previous-month bounds (UTC, inclusive). Date.UTC with
      // day 0 yields the last day of the preceding month, so these stay correct
      // across year boundaries (e.g. Jan → previous Dec).
      const monthStart = `${q.month}-01`;
      const startObj = new Date(`${monthStart}T00:00:00Z`);
      const y = startObj.getUTCFullYear();
      const m = startObj.getUTCMonth();
      const iso = (d: Date) => d.toISOString().slice(0, 10);
      const monthEnd = iso(new Date(Date.UTC(y, m + 1, 0)));     // last day of selected month
      const prevMonthStart = iso(new Date(Date.UTC(y, m - 1, 1)));
      const prevMonthEnd = iso(new Date(Date.UTC(y, m, 0)));     // last day of previous month
      const prevMonth = prevMonthStart.slice(0, 7);              // "YYYY-MM"

      // Combined qty per (route, product) across both months, each row tagged
      // cur / prev. The previous month immediately precedes the selected one,
      // so one continuous range covers both and the CASE splits them.
      const salesRows = await pgClient`
        WITH combined AS (
          SELECT d.route_id AS route_id, o.created_at::date AS sale_date,
                 oi.product_id, oi.quantity::int AS qty
          FROM orders o
          JOIN dealers d      ON d.id = o.dealer_id
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.created_at::date >= ${prevMonthStart}::date
            AND o.created_at::date <= ${monthEnd}::date
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
          UNION ALL
          SELECT ds.route_id, ds.sale_date, dsi.product_id, dsi.quantity::int AS qty
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date >= ${prevMonthStart}::date
            AND ds.sale_date <= ${monthEnd}::date
        )
        SELECT route_id,
               CASE WHEN sale_date >= ${monthStart}::date THEN 'cur' ELSE 'prev' END AS period,
               product_id, SUM(qty)::int AS qty
        FROM combined
        GROUP BY route_id, period, product_id
      `;

      const { columns, groups, total } = await buildMilkCurdCrossTab(salesRows as any[]);
      return reply.send({
        month: q.month,
        prevMonth,
        monthStart,
        monthEnd,
        prevMonthStart,
        prevMonthEnd,
        columns,
        groups,
        total,
      });
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
      AND o.status IN ('confirmed', 'dispatched', 'delivered')
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

  // Case-insensitive: config uses capitalized names, DB stores lowercase.
  const milkCatSet = new Set(cfg.milkCategoryGroup.map(c => c.toLowerCase()));

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
    if (milkCatSet.has((row.category_name ?? "").toLowerCase())) agg.milkAmount = round2(agg.milkAmount + amt);
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

// ════════════════════════════════════════════════════════════════════
// Shared "MILK & CURD SALES REPORT" cross-tab builder.
//
// Both the Daily and Monthly Sales Reports render the same route × product
// cross-tab (Night / Afternoon groups, a previous-period comparison + diff,
// milk / curd / G-L totals and a grand "HVR TOTAL"). They differ only in the
// period each sale falls into, so callers pre-tag every (route, product) sales
// row as 'cur' (selected period) or 'prev' (comparison period) and this helper
// produces the identical { columns, groups, total } payload.
// ════════════════════════════════════════════════════════════════════
async function buildMilkCurdCrossTab(
  salesRows: Array<{ route_id: string | null; period: string; product_id: string; qty: number | string }>,
) {
  // ── 1. Products: resolve the fixed columns + the G/L set by name ──
  const products = await pgClient`
    SELECT p.id, p.code, p.name, p.report_alias,
           COALESCE(p.pack_size, 0)::numeric AS pack_size, p.unit
    FROM products p
    WHERE p.deleted_at IS NULL
  `;
  const prodById = new Map((products as any[]).map(p => [p.id, p]));

  // Loose key: uppercase + strip every non-alphanumeric char, so
  // "HTM 1000ML" / "HTM-1000ML" / "htm1000ml" all collapse to the same
  // token. Makes column matching resilient to spacing/punctuation drift.
  const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  const glIds = new Set<string>();
  // Separate indexes so an authoritative code/name never loses to a
  // (often messy) report_alias collision.
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();
  const byAlias = new Map<string, string>();

  for (const p of products as any[]) {
    const nm = (p.name ?? "").toUpperCase().trim();
    if (nm.startsWith("G/L") || nm.startsWith("GOOD LIFE")) glIds.add(p.id);
    const kc = norm(p.code);
    const kn = norm(p.name);
    const ka = norm(p.report_alias);
    if (kc && !byCode.has(kc)) byCode.set(kc, p.id);
    if (kn && !byName.has(kn)) byName.set(kn, p.id);
    if (ka && !byAlias.has(ka)) byAlias.set(ka, p.id);
  }

  // productId → column key (code → name → alias fallback), plus each column's
  // Ltr/Kg-per-packet factor read live from the matched product's pack_size +
  // unit. The DB is the source of truth so editing a product's pack_size flows
  // straight through to the report; the hardcoded qtyToUnit is only a fallback
  // for when the column's product (or its pack_size) can't be resolved.
  const colKeyByProductId = new Map<string, string>();
  const perPackByColKey = new Map<string, number>();
  for (const col of DSR_COLUMNS) {
    const pid =
      byCode.get(norm(col.code)) ??
      byName.get(norm(col.name)) ??
      byAlias.get(norm(col.name));
    if (!pid) continue;
    colKeyByProductId.set(pid, col.key);
    const p = prodById.get(pid);
    const dbPerPack = p ? toKgLtr(1, parseFloat(p.pack_size) || 0, p.unit ?? "") : 0;
    perPackByColKey.set(col.key, dbPerPack > 0 ? dbPerPack : col.qtyToUnit);
  }

  // ── 2. Active routes + their session (Night / Afternoon) ──
  //     which_batch comes from the route's primary batch; if it has none
  //     set, fall back to any batch linked via batch_routes.
  const routes = await pgClient`
    SELECT r.id, r.code, r.name,
           COALESCE(
             pb.which_batch,
             (SELECT b2.which_batch
                FROM batch_routes br
                JOIN batches b2 ON b2.id = br.batch_id AND b2.deleted_at IS NULL
               WHERE br.route_id = r.id
               ORDER BY b2.which_batch
               LIMIT 1),
             ''
           ) AS which_batch
    FROM routes r
    LEFT JOIN batches pb ON pb.id = r.primary_batch_id AND pb.deleted_at IS NULL
    WHERE r.deleted_at IS NULL AND r.active = true
    ORDER BY r.code
  `;
  // Two sales shifts: Night and Afternoon. which_batch text is matched
  // loosely; anything that isn't a night/evening batch (including no
  // batch) falls into the afternoon group.
  const sessionOf = (wb: string): "night" | "afternoon" => {
    const w = (wb ?? "").toLowerCase();
    return w.includes("night") || w.includes("evening") ? "night" : "afternoon";
  };

  // ── 3. Accumulate per-route packet counts, split by period ──
  //     cols / prevCols hold the selected- and comparison-period packet
  //     counts per column; the Ltr/Kg totals are derived from these ×
  //     perPackByColKey (each column's DB pack_size+unit) so the printed
  //     columns and the totals can never disagree.
  type Acc = {
    qty: number;                       // selected-period total packets (all products)
    prevQty: number;                   // comparison-period total packets (all products)
    cols: Record<string, number>;      // selected-period packet count per column
    prevCols: Record<string, number>;  // comparison-period packet count per column
    totalGL: number;                   // selected-period G/L packet count
  };
  const newAcc = (): Acc => ({ qty: 0, prevQty: 0, cols: {}, prevCols: {}, totalGL: 0 });
  const accByRoute = new Map<string, Acc>();
  for (const r of routes as any[]) accByRoute.set(r.id, newAcc());
  const adhocAcc = newAcc();

  for (const row of salesRows) {
    const acc = row.route_id == null ? adhocAcc : accByRoute.get(row.route_id);
    if (!acc) continue; // sale on an inactive/deleted route — skip
    const qty = Number(row.qty) || 0;
    const colKey = colKeyByProductId.get(row.product_id);

    if (row.period === "cur") {
      acc.qty += qty;
      if (colKey) acc.cols[colKey] = (acc.cols[colKey] ?? 0) + qty;
      if (glIds.has(row.product_id)) acc.totalGL += qty;
    } else {
      acc.prevQty += qty;
      if (colKey) acc.prevCols[colKey] = (acc.prevCols[colKey] ?? 0) + qty;
    }
  }

  // Each column's Ltr/Kg-per-packet factor: DB pack_size+unit, hardcoded
  // qtyToUnit only as a last resort.
  const unitPer = (c: (typeof DSR_COLUMNS)[number]) => perPackByColKey.get(c.key) ?? c.qtyToUnit;
  const milkLtr = (cmap: Record<string, number>) =>
    MILK_COLS.reduce((s, c) => s + (cmap[c.key] ?? 0) * unitPer(c), 0);
  const curdKg = (cmap: Record<string, number>) =>
    CURD_COLS.reduce((s, c) => s + (cmap[c.key] ?? 0) * unitPer(c), 0);
  // Combined sales volume across every fixed column (milk Ltr + curd Kg +
  // lassi Ltr) — drives the period-over-period comparison columns so they
  // read in volume units like the rest of the sheet.
  const totalVol = (cmap: Record<string, number>) =>
    DSR_COLUMNS.reduce((s, c) => s + (cmap[c.key] ?? 0) * unitPer(c), 0);

  const mkRow = (id: string | null, code: string, name: string, acc: Acc) => ({
    id, code, name,
    // Period-over-period comparison columns, in combined sales volume (milk
    // Ltr + curd Kg + lassi Ltr) so they read in volume units like the rest.
    prevQty: round1(totalVol(acc.prevCols)),                    // comparison period
    todayQty: round1(totalVol(acc.cols)),                       // selected period
    diff: round1(totalVol(acc.cols) - totalVol(acc.prevCols)),  // difference
    cols: Object.fromEntries(DSR_COLUMNS.map(c => [c.key, acc.cols[c.key] ?? 0])),
    totalMilk: round1(milkLtr(acc.cols)),  // Ltr
    totalCurd: round1(curdKg(acc.cols)),   // Kg
    totalGL: acc.totalGL,                  // qty
  });
  type DSRRow = ReturnType<typeof mkRow>;

  const nightRows: DSRRow[] = [];
  const afternoonRows: DSRRow[] = [];
  for (const r of routes as any[]) {
    const row = mkRow(r.id, r.code ?? "", r.name, accByRoute.get(r.id)!);
    (sessionOf(r.which_batch) === "night" ? nightRows : afternoonRows).push(row);
  }
  // ADHOC row — only when it carries data (night group, like the sheet).
  const adhocHasData =
    adhocAcc.qty || adhocAcc.prevQty || adhocAcc.totalGL ||
    Object.keys(adhocAcc.cols).length > 0;
  if (adhocHasData) nightRows.push(mkRow(null, "", "ADHOC SALES", adhocAcc));

  const sumRows = (rows: DSRRow[], name: string) => {
    const cols: Record<string, number> = {};
    for (const c of DSR_COLUMNS) cols[c.key] = rows.reduce((s, r) => s + (r.cols[c.key] ?? 0), 0);
    const prevQty = round1(rows.reduce((s, r) => s + r.prevQty, 0));
    const todayQty = round1(rows.reduce((s, r) => s + r.todayQty, 0));
    return {
      id: null, code: "", name,
      prevQty, todayQty, diff: round1(todayQty - prevQty), cols,
      totalMilk: round1(rows.reduce((s, r) => s + r.totalMilk, 0)),
      totalCurd: round1(rows.reduce((s, r) => s + r.totalCurd, 0)),
      totalGL: rows.reduce((s, r) => s + r.totalGL, 0),
    };
  };

  return {
    columns: DSR_COLUMNS,
    groups: [
      { key: "night", label: "Night Sales", rows: nightRows, subtotal: sumRows(nightRows, "Total Night Sales") },
      { key: "afternoon", label: "Afternoon Sales", rows: afternoonRows, subtotal: sumRows(afternoonRows, "Total Afternoon Sales") },
    ],
    total: sumRows([...nightRows, ...afternoonRows], "HVR TOTAL (IN LTRS)"),
  };
}

// ── utility ──
// Qty in Kg/Ltr from the product's DB fields. products.pack_size is stored in
// the product's macro unit (L/kg) for every product in this dataset — e.g.
// HTM 1000ML = 1.00 L, CURD 140GM = 0.14 kg, and multi-packs like G/L UHT
// "180 ML 30 PACK" = 5.40 L — so volume is simply qty × pack_size. Micro units
// (ml/g), still selectable on the product form, hold a sub-unit size and
// convert ÷1000. This matches the web helper in apps/web/src/lib/kgLtr.ts.
function toKgLtr(qty: number, packSize: number, unit: string): number {
  const u = (unit ?? "").trim().toLowerCase();
  const isMicro =
    u === "ml" || u === "g" || u === "gm" || u === "gram" || u === "grams";
  const perPack = isMicro ? packSize / 1000 : packSize;
  return (Number(qty) || 0) * (Number(perPack) || 0);
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round1(n: number): number {
  return Math.round((Number(n) || 0) * 10) / 10;
}

function round3(n: number): number {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}