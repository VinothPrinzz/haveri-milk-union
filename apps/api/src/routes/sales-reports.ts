import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationMeta, offsetFromPage } from "../lib/pagination.js";
import { displayRouteCode } from "../lib/route-code.js";

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

// ── Cash / credit sale-type filter (B6 Sales Register, B9 GST Statement) ──
// On the ORDERS rail, "credit" keys on the CUSTOMER, never on the order's
// stored payment_mode. Ordinary dealers carry payment_mode='credit' as a
// technical marker for a ledger-settled order their own wallet money already
// funded (see the note in finance-day-book.ts), so reading that column would
// file nearly every sale as credit. The only dealers who genuinely take goods
// against a bill cleared later are the credit institutions
// (customer_type 'Credit Inst-*'), billed monthly on the B5 Credit Sales bill
// — and then only on the orders they have NOT already paid for. Those buyers
// may settle up front in the dealer app like anyone else, which stamps
// payment_mode='upi' and captures a real gateway charge; such a sale is
// collected money and files with the cash side. Both halves of the test are
// needed, and the canonical rule lives in lib/credit-check.ts.
//
// On the DIRECT-SALES rail the column means the opposite, and IS the answer:
// a gate pass is rung up as wallet, cash, UPI or credit, and only 'credit'
// takes goods against a later bill. That distinction was previously ignored
// here, so a credit gate pass was filed as a cash sale on B6 and appeared on
// no credit report at all — ₹23,999.08 of it on 2026-08-12 alone.
//
//   cash   — ordinary dealer orders, counter sales, and gate passes settled
//            by wallet, cash or UPI (all money the union holds).
//   credit — supply taken against a balance settled later: the credit
//            institutions, gate passes issued on credit, and (B6 only) the
//            employee ghee subsidy, which confirms on credit and is recovered
//            from salary. B9 GST still files the subsidy on the cash side: a
//            GST return follows the supply, not how it was settled.
//   all    — both. Note this overlaps the B5 Credit Sales bill, which reports
//            the same credit supply with its own BASIC/CGST/SGST breakup.
// The rule, written once in prose because postgres.js binds ${} as a
// parameter and cannot splice a SQL fragment: a direct sale belongs to the
// CREDIT side when it is an employee subsidy OR its payment_mode is 'credit'.
// Every direct-sales query below that splits the two spells out exactly:
//
//   ( (${wantCash}   AND NOT (<subsidy> OR ds.payment_mode::text = 'credit'))
//  OR (${wantCredit} AND     (<subsidy> OR ds.payment_mode::text = 'credit')) )
const saleTypeSchema = z.enum(["cash", "credit", "all"]).default("cash");
export type SaleType = z.infer<typeof saleTypeSchema>;

const dateRangeSaleTypeSchema = dateRangeSchema.extend({ saleType: saleTypeSchema });

// Which sides of the split a request wants. Passed into SQL as booleans so a
// single query serves all three choices without string-matching in the WHERE.
function saleTypeBuckets(saleType: SaleType) {
  return { wantCash: saleType !== "credit", wantCredit: saleType !== "cash" };
}

// ── Which day a dealer order counts on ────────────────────────────────
// Every report in this file books an order on its DELIVERY date — the day
// the milk actually leaves the plant — not on created_at, the day the indent
// was typed. The two are the same for 99.7% of orders, but a standing indent
// placed a day or two ahead (or an admin indent booked for later in the week)
// would otherwise be counted on the wrong day: e.g. 6 L of HTM 1000ML (sub)
// placed 01-Aug for 03-Aug delivery landed on the 1st's sheet, leaving the
// 3rd reading 52 L against 58 L actually dispatched.
//
// This matches the Day Book, which has booked sales on delivery_date since
// 2026-07-18. direct_sales already carries its own sale_date and needs none
// of this.
//
// `orders` is partitioned by MONTH on created_at, so filtering on
// delivery_date alone would scan every partition. Each query keeps a coarse
// created_at window as well — purely a partition-pruning hint, wide enough
// (31 days back, 2 days forward) to cover any lead time. Orders are never
// created after their delivery date, so the forward slack is nominal.

// ── Adhoc (route-less) bucket ─────────────────────────────────────────
// Counter sales, VIP samples, the employee ghee subsidy and gate passes can
// be raised without naming a route; the goods still leave FGS and the money
// is still collected, so they are bucketed under one sentinel "route" rather
// than dropped. Same sentinel the Route Sheet (A1) and Dispatch Sheet use, so
// the three reports agree on what "ADHOC" contains.
const ADHOC_ROUTE_ID = "00000000-0000-0000-0000-000000000000";

// ── Dealers with no taluka set ────────────────────────────────────────
// A taluka is a property of the dealer (dealers.zone_id), and that column is
// nullable. Product Wise Taluka Sales (B7d) buckets those sales under this
// sentinel "zone" rather than inner-joining them away, so a product's taluka
// columns still add up to its own total. Same device as ADHOC_ROUTE_ID above,
// and the web sends it back as ?zoneId to read the bucket on its own.
const UNASSIGNED_ZONE_ID = "00000000-0000-0000-0000-000000000001";

// ── Play Store DEMO route ─────────────────────────────────────────────
// The Google Play reviewer logs in as a demo dealer parked on a dedicated
// always-open DEMO route (packages/db/src/seed-demo-account.ts), because
// every real route's ordering window is shut during US review hours. Their
// test orders are not the union's trade: left in, they inflate every figure
// on this page and print an empty DEMO column across each route grid.
//
// So every rail below carries one of these, and the three route listings
// drop the column outright:
//
//   orders            NOT EXISTS (... dr.id = COALESCE(o.route_id, dealer's route))
//   direct_sales      NOT EXISTS (... dr.id = ds.route_id)
//   employee_orders   NOT EXISTS (... dr.id = eo.route_id)
//
// Written as NOT EXISTS against routes.code rather than a bound route id on
// purpose: it needs no per-request lookup, it is correct when no DEMO route
// exists at all, and - unlike NOT IN or IS DISTINCT FROM against a nullable
// id - it KEEPS route-less rows, which is what the ADHOC bucket above is
// made of. Orders resolve their route the way every other read here does
// (order-snapshot first, the dealer's route as fallback).

// ── one-request cache for system_settings ──
type ReportConfig = {
  categoryGroups: { milk: string[]; curd: string[]; lassi: string[] };
  cashPaymentModes: string[];
  milkCategoryGroup: string[];
  talukaFixedProducts: Array<{ code: string; label: string }>;
  cratePacketsDefault: number;
};

/** Exported alongside buildSalesGrid so diagnostics can build a grid. */
export async function loadReportConfig(): Promise<ReportConfig> {
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
  // Subsidised HTM 1000ML (PD0191S, migration 0056) — the same physical pouch
  // sold under the 50 % scheme. It gets its own column so the union can read
  // scheme volume apart from full-price sales; it still counts as milk, so its
  // litres roll into TOTAL MILK like every other milk column.
  { key: "htm1000sub",  code: "PD0191S", name: "HTM 1000ML (Subsidy)", header: "HTM 1000ml (Sub)", group: "HTM MILK", bucket: "milk", qtyToUnit: 1.0 },
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

      // Fetch products ordered by sort_order grouped by category.
      // pack_size + unit come along so the client can render each column in
      // Ltr (milk) / Kg (curd) instead of raw packet counts.
      const products = await pgClient`
        SELECT p.id, p.report_alias, p.name, p.sort_order,
               COALESCE(p.pack_size, 0)::numeric AS pack_size, p.unit,
               c.name AS category_name
        FROM products p
        JOIN categories c ON c.id = p.category_id
        WHERE p.deleted_at IS NULL
          AND p.available = true
        ORDER BY p.sort_order, p.name
      `;

      // Fetch aggregated sales by (date, product) for orders + direct sales
      const salesRows = await pgClient`
        WITH combined AS (
          SELECT o.delivery_date AS sale_date,
                 oi.product_id,
                 oi.quantity::int AS qty,
                 oi.line_total::numeric AS amount
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.delivery_date >= ${q.from}::date
            AND o.delivery_date <= ${q.to}::date
            AND o.created_at >= ${q.from}::date - interval '31 days'
            AND o.created_at <  ${q.to}::date + interval '2 days'
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                             AND dr.id = COALESCE(o.route_id,
                                   (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
          UNION ALL
          SELECT ds.sale_date,
                 dsi.product_id,
                 dsi.quantity::int AS qty,
                 dsi.line_total::numeric AS amount
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
            -- Complimentary VIP samples are given away, not sold, so they
            -- stay out of the statement. They carry real packet counts but
            -- bill ₹0, which inflated every quantity column against an
            -- unchanged amount. They are reported on B11 VIP Sales instead.
            AND ds.customer_type::text <> 'vip_sample'
          UNION ALL
          -- Employee ghee subsidy. It moved from direct_sales to its own
          -- employee_orders rail on 2026-08-02, so a statement that reads only
          -- the two arms above lost it from that date on. Both rails are
          -- unioned: the legacy rows arrive on the direct_sales arm, the
          -- current ones here, and no sale is counted twice because a given
          -- indent lives on exactly one of them.
          SELECT eo.delivery_date AS sale_date,
                 eoi.product_id,
                 eoi.quantity::int AS qty,
                 eoi.line_total::numeric AS amount
          FROM employee_orders eo
          JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
          WHERE eo.delivery_date >= ${q.from}::date
            AND eo.delivery_date <= ${q.to}::date
            AND eo.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
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
          .map(p => ({
            id: p.id,
            reportAlias: p.report_alias ?? p.name,
            sortOrder: p.sort_order,
            packSize: parseFloat(p.pack_size) || 0,
            unit: p.unit ?? "",
          }));

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

      const dateList = await pgClient`
        SELECT to_char(d::date, 'YYYY-MM-DD') AS date
        FROM generate_series(${q.from}::date, ${q.to}::date, interval '1 day') d
        ORDER BY d
      `;
      const dates = dateList.map((r: any) => r.date);

      // Every route, not only the live ones. Current routes always get a
      // column (even at zero, so the grid keeps its shape); a retired or
      // deleted route is kept only if it actually sold in the range. Filtering
      // to active routes in SQL used to leave that money in the day and grand
      // totals with no column to sit under, so the columns did not add up to
      // the row total.
      const allRoutes = await pgClient`
        SELECT r.id, r.code, r.name,
               (r.deleted_at IS NULL AND r.active = true) AS is_current
        FROM routes r
        WHERE r.code <> 'DEMO'
        ORDER BY (r.deleted_at IS NOT NULL), r.code
      `;

      // Day/route sales total, across all three sales rails:
      //
      //   1. orders           — dealer indents (app + admin), the bulk of it
      //   2. direct_sales     — counter/cash sales, agent gate passes, VIP
      //                         samples and pre-2026-08-02 employee subsidy
      //   3. employee_orders  — employee subsidy since it became a real indent
      //
      // Rails 2 and 3 were missing entirely: the report read `orders` alone, so
      // every gate pass and counter sale of the day was absent from its route's
      // column and from the grand total. The other reports over the same money
      // (B1 Daily Sales Statement, Route Sheet, Dispatch Sheet) already union
      // all three, so B2 was the odd one out.
      //
      // What "cash" means here: the money reached the union, either collected
      // at the counter or already funded by the buyer. What it excludes is
      // supply taken against a balance settled later. Which column answers
      // that differs per rail, so the same payment_mode value must NOT be read
      // the same way on all three:
      //
      //   • orders — NO payment_mode filter. An earlier version kept only
      //     cash-mode payments, which dropped wallet- and ledger-settled orders
      //     and undercounted every route. Ordinary dealers have no credit limit
      //     (lib/credit-check.ts), so payment_mode='credit' on their order is a
      //     technical marker for a wallet balance they already funded. Cash to
      //     the union, and it belongs here. The genuine credit buyers are the
      //     credit institutions ('Credit Inst-*') on the orders they have not
      //     paid for, excluded exactly as the Sales Register (B6) and GST
      //     Statement (B7) do; they are billed monthly on the separate B5
      //     Credit Sales report. A credit institution that DID pay at
      //     checkout stays here with everyone else — see lib/credit-check.ts.
      //
      //   • direct_sales and employee_orders — payment_mode IS the answer, and
      //     'credit' on these rails means the opposite of what it means on an
      //     order: nothing was collected and nothing was posted (the sale row
      //     is the whole record — see lib/direct-sale-money.ts). So only the
      //     modes where money actually moved are counted. That keeps agent
      //     gate passes and counter sales in (all of them cash/UPI in practice)
      //     and leaves the employee ghee subsidy out: it confirms on credit,
      //     debits employee_ledger against a per-employee credit_limit and is
      //     recovered from salary later — a credit sale in the same sense a
      //     credit institution's is. It is reported on the Employee Subsidy
      //     Statement and Finance → Employee Credit. Filtering on the column
      //     rather than dropping the rail keeps a subsidy that IS rung up as
      //     cash/UPI at the counter (direct-sales.ts allows it) counted here.
      //     Complimentary VIP samples fall out on the same test, and cost ₹0
      //     either way.
      //
      // The collected-modes list is spelled out inline rather than bound as an
      // array param: a JS array binding is exactly the shape that breaks Bind
      // on the transaction pooler, and it would defeat the EXPLAIN sweep.
      //
      // A sale that names no route (a gate pass raised at the plant, a dealer
      // with no route assigned) buckets under the ADHOC sentinel instead of
      // being dropped, so no rupee leaves the report.
      const salesRows = await pgClient`
        WITH combined AS (
          SELECT o.delivery_date AS sale_date,
                 COALESCE(o.route_id, d.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
                 o.grand_total::numeric AS amount
          FROM orders o
          JOIN dealers d ON d.id = o.dealer_id
          WHERE o.delivery_date >= ${q.from}::date
            AND o.delivery_date <= ${q.to}::date
            AND o.created_at >= ${q.from}::date - interval '31 days'
            AND o.created_at <  ${q.to}::date + interval '2 days'
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                             AND dr.id = COALESCE(o.route_id,
                                   (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
            -- Credit supply is excluded, and a credit institution that paid
            -- at checkout is NOT credit supply: that UPI charge is cash to
            -- the union on the day and belongs on a cash report. See the
            -- canonical rule in lib/credit-check.ts.
            AND NOT (COALESCE(d.customer_type::text, '') LIKE 'Credit Inst%'
                     AND o.payment_mode::text <> 'upi')
          UNION ALL
          SELECT ds.sale_date,
                 COALESCE(ds.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
                 ds.grand_total::numeric AS amount
          FROM direct_sales ds
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
            AND ds.payment_mode::text IN ('cash', 'upi', 'wallet')
          UNION ALL
          SELECT eo.delivery_date AS sale_date,
                 COALESCE(eo.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
                 eo.grand_total::numeric AS amount
          FROM employee_orders eo
          WHERE eo.delivery_date >= ${q.from}::date
            AND eo.delivery_date <= ${q.to}::date
            AND eo.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
            AND eo.payment_mode::text IN ('cash', 'upi', 'wallet')
        )
        SELECT to_char(sale_date, 'YYYY-MM-DD') AS date,
               route_id,
               SUM(amount)::numeric AS amount
        FROM combined
        GROUP BY sale_date, route_id
      `;

      // Which route columns the grid carries: every current route, plus any
      // retired one and the ADHOC bucket if they hold money in this range.
      const soldRouteIds = new Set((salesRows as any[]).map(r => r.route_id));
      const routes = [
        ...(allRoutes as any[])
          .filter(r => r.is_current || soldRouteIds.has(r.id))
          .map(r => ({ id: r.id, code: displayRouteCode(r.code), name: r.name })),
        ...(soldRouteIds.has(ADHOC_ROUTE_ID)
          ? [{ id: ADHOC_ROUTE_ID, code: "ADHOC", name: "Adhoc (no route)" }]
          : []),
      ];

      const matrix: Record<string, Record<string, number>> = {};
      const routeTotals: Record<string, number> = {};
      const dayTotals: Record<string, number> = {};
      let grandTotal = 0;

      for (const date of dates) {
        matrix[date] = {};
        dayTotals[date] = 0;
        for (const r of routes) {
          matrix[date][r.id] = 0;
          routeTotals[r.id] = routeTotals[r.id] ?? 0;
        }
      }

      for (const row of salesRows as any[]) {
        const d = row.date;
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
        routes,
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

      // pack_size + unit ride along so the client renders each product row in
      // Ltr (milk) / Kg (curd) instead of raw packet counts.
      const products = await pgClient`
        SELECT id, report_alias, name, sort_order,
               COALESCE(pack_size, 0)::numeric AS pack_size, unit
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
          WHERE o.delivery_date >= ${q.from}::date
            AND o.delivery_date <= ${q.to}::date
            AND o.created_at >= ${q.from}::date - interval '31 days'
            AND o.created_at <  ${q.to}::date + interval '2 days'
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                             AND dr.id = COALESCE(o.route_id,
                                   (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
            AND z.officer_id IS NOT NULL
          UNION ALL
          SELECT z.officer_id, dsi.product_id, dsi.quantity::int AS qty
          FROM direct_sales ds
          JOIN dealers d ON d.id = ds.customer_id AND ds.customer_type = 'agent'
          JOIN zones z   ON z.id = d.zone_id
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
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
        products: (products as any[]).map(p => ({
          id: p.id,
          reportAlias: p.report_alias ?? p.name,
          sortOrder: p.sort_order,
          packSize: parseFloat(p.pack_size) || 0,
          unit: p.unit ?? "",
        })),
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
      // Pinned to the cash side of the split: ordinary dealer orders however
      // they settled, plus counter sales and gate passes where money actually
      // changed hands. Credit institutions and the employee subsidy are the
      // credit side and appear on the Credit Sales bill / Sales Register.
      return reply.send(await buildSalesGrid({ q, cfg, saleType: "cash", collectedModesOnly: true }));
    }
  );

  // ════════════════════════════════════════════
  // B6. Sales Register — 2 pages (same shape as B4, no payment filter)
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/register",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSaleTypeSchema.parse(request.query);
      const cfg = await loadReportConfig();
      // Quantities render in Ltr/Kg. saleType picks which side of the cash /
      // credit split to show (see saleTypeSchema); the 'cash' default keeps
      // credit institutions on their separate monthly bill, as before, and
      // now also holds the counter sales and gate passes that a route filter
      // used to drop. The credit side carries the employee subsidy alongside
      // the institutions. Route-less goods on any rail print under ADHOC.
      // Complimentary VIP samples are given away, not sold, so they are
      // excluded; they are reported on B11 VIP Sales.
      return reply.send(await buildSalesGrid({ q, cfg, saleType: q.saleType }));
    }
  );

  // ════════════════════════════════════════════
  // B5. Credit Sales — N + 1 pages (legacy bill format)
  //
  // Product COLUMNS are one per (SKU, price), not one per SKU. A dealer-price
  // or MRP revision inside the billing month gives the SKU a second column at
  // its own rate, tagged → A / → B on the name (oldest first, see
  // priceVariantSuffixes); the packets and money split between them. The bill
  // used to print one column at the largest price seen, so on a revision the
  // Rate row no longer agreed with the BASIC row beneath it.
  //
  // The GST rate, by contrast, is read live off products.gst_percent and
  // applied to the whole period: BASIC / CGST / SGST are backed out of the
  // gross that was billed (splitGstFromGross), so correcting a wrong rate in
  // the product master corrects every past bill without moving the Amount.
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

      // Two kinds of credit supply reach this bill.
      //
      // 1. Credit-institution orders (customer_type 'Credit Inst-*') that are
      //    still unpaid. These buyers are billed monthly, so the bill is
      //    scoped to the institution — but only over supply it actually owes
      //    for. An order it settled at checkout (payment_mode='upi', gateway
      //    charge captured, receipt written, invoice already 'paid') is done
      //    with; carrying it here would put it on the monthly bill as well as
      //    in the day's UPI collections and ask for the money twice.
      // 2. Gate passes rung up on credit, whoever the agent is. On the
      //    direct-sales rail payment_mode is the real answer, and a credit
      //    pass is goods handed over against a later bill by definition.
      //    These used to appear on NO credit report: this bill read only
      //    orders, and the register filed them as cash.
      //
      // which_batch (via the route → primary batch) drives the EVE/MOR/AFT
      // session label above each product column.
      const lines = await pgClient`
        SELECT d.id   AS dealer_id,
               d.code AS dealer_code,
               d.name AS dealer_name,
               d.address,
               d.city,
               z.name AS taluka,
               d.gst_number,
               d.rate_category,
               bt.which_batch AS which_batch,
               oi.product_id,
               p.code AS product_code,
               COALESCE(p.report_alias, p.name) AS product_name,
               c.name AS category_name,
               p.hsn_no,
               COALESCE(p.pack_size, 0)::numeric AS pack_size,
               p.unit,
               p.sort_order,
               p.gst_percent::numeric AS gst_percent,
               o.delivery_date AS sale_date,
               oi.quantity::int  AS qty,
               -- The gross (GST-inclusive) rate this packet was billed at.
               -- Splitting the bill's product columns on it is what keeps a
               -- mid-month price revision off a single averaged column.
               round(oi.unit_price * (1 + oi.gst_percent / 100), 2) AS gross_rate,
               oi.line_total::numeric AS line_total
        FROM orders o
        JOIN dealers d    ON d.id = o.dealer_id
        LEFT JOIN zones z ON z.id = d.zone_id
        JOIN order_items oi ON oi.order_id = o.id
        JOIN products p   ON p.id = oi.product_id
        JOIN categories c ON c.id = p.category_id
        -- Not filtered on deleted_at: the route is read only for its batch's
        -- session label (EVE/MOR/AFT), and a bill for a past date must print
        -- the session it was actually delivered on even if the route has since
        -- been deleted.
        LEFT JOIN routes r   ON r.id = COALESCE(o.route_id, d.route_id)
        LEFT JOIN batches bt ON bt.id = r.primary_batch_id AND bt.deleted_at IS NULL
        WHERE o.delivery_date >= ${q.from}::date
          AND o.delivery_date <= ${q.to}::date
          AND o.created_at >= ${q.from}::date - interval '31 days'
          AND o.created_at <  ${q.to}::date + interval '2 days'
          AND o.status IN ('confirmed', 'dispatched', 'delivered')
          AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                           AND dr.id = COALESCE(o.route_id,
                                 (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
          -- Scoped to the institution, but only for supply it still owes on.
          -- A purchase it paid for at checkout (payment_mode='upi', gateway
          -- charge captured, receipt written) is settled, so billing it again
          -- on the monthly credit bill would ask for the money twice. See the
          -- canonical rule in lib/credit-check.ts.
          AND COALESCE(d.customer_type::text, '') LIKE 'Credit Inst%'
          AND o.payment_mode::text <> 'upi'

        UNION ALL

        SELECT d.id   AS dealer_id,
               d.code AS dealer_code,
               d.name AS dealer_name,
               d.address,
               d.city,
               z.name AS taluka,
               d.gst_number,
               d.rate_category,
               bt.which_batch AS which_batch,
               dsi.product_id,
               p.code AS product_code,
               COALESCE(p.report_alias, p.name) AS product_name,
               c.name AS category_name,
               p.hsn_no,
               COALESCE(p.pack_size, 0)::numeric AS pack_size,
               p.unit,
               p.sort_order,
               p.gst_percent::numeric AS gst_percent,
               ds.sale_date AS sale_date,
               dsi.quantity::int  AS qty,
               round(dsi.unit_price * (1 + dsi.gst_percent / 100), 2) AS gross_rate,
               dsi.line_total::numeric AS line_total
        FROM direct_sales ds
        JOIN dealers d    ON d.id = ds.customer_id
        LEFT JOIN zones z ON z.id = d.zone_id
        JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
        JOIN products p   ON p.id = dsi.product_id
        JOIN categories c ON c.id = p.category_id
        LEFT JOIN routes r   ON r.id = COALESCE(ds.route_id, d.route_id)
        LEFT JOIN batches bt ON bt.id = r.primary_batch_id AND bt.deleted_at IS NULL
        WHERE ds.customer_type = 'agent'
          AND ds.status = 'confirmed'
          AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
          AND ds.payment_mode::text = 'credit'
          AND ds.sale_date >= ${q.from}::date
          AND ds.sale_date <= ${q.to}::date
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
      // Delivery-session label printed above each product column (EVE/MOR/AFT),
      // derived from the batch's which_batch. Defaults to EVE — the evening
      // dispatch these institutions are served on when no batch is resolvable.
      const sessionAbbr = (wb: string | null | undefined) => {
        const w = (wb ?? "").toLowerCase();
        if (w.includes("morn")) return "MOR";
        if (w.includes("noon") || w.includes("after")) return "AFT";
        return "EVE";
      };

      // Group lines by dealer → (product, price); track daily qty AND daily
      // amount (line_total) per (dealer, column, date). line_total is the
      // GROSS the sale booked, so the footer BASIC/CGST/SGST are backed out
      // of the amount at the product's current GST rate, not added on top
      // (see the customer build below).
      type ProdAgg = {
        key: string;       // productId|grossRate - one column per PRICE
        id: string;
        code: string;
        reportAlias: string;
        category: string;
        hsn: string;
        packSize: number;
        unit: string;
        grossRate: number; // GST-inclusive rate booked; the column identity
        firstDate: string; // earliest sale at this price; orders the A/B tags
        gstPct: number;
        sortOrder: number;
        session: string;   // EVE / MOR / AFT
        dailyQty: Map<string, number>;    // date → qty
        dailyAmount: Map<string, number>; // date → Σ line_total
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
            // Address line under the buyer's name. Every dealer sits in Haveri
            // district, so the district alone says nothing - print the taluka
            // ahead of it ("RANEBENNUR, Haveri").
            city: [r.taluka, r.city].filter(Boolean).join(", ") || null,
            gstNumber: r.gst_number ?? null,
            rateCategory: r.rate_category ?? null,
            products: new Map(),
          });
        }
        const cust = custMap.get(r.dealer_id)!;
        const grossRate = round2(parseFloat(r.gross_rate) || 0);
        const iso = new Date(r.sale_date).toISOString().slice(0, 10);
        // Keyed on (product, price), not on product alone: a revision inside
        // the period gives the SKU a second column at its own rate. The old
        // code kept the largest price seen and printed every packet against
        // it, so Rate x Pkts stopped agreeing with the BASIC row below it.
        const key = priceVariantKey(r.product_id, grossRate);
        if (!cust.products.has(key)) {
          cust.products.set(key, {
            key,
            id: r.product_id,
            code: r.product_code ?? "",
            reportAlias: r.product_name,
            category: (r.category_name ?? "").toUpperCase(),
            hsn: r.hsn_no ?? "",
            packSize: parseFloat(r.pack_size) || 0,
            unit: r.unit ?? "",
            grossRate,
            firstDate: iso,
            gstPct: parseFloat(r.gst_percent) || 0,
            sortOrder: Number(r.sort_order) || 0,
            session: sessionAbbr(r.which_batch),
            dailyQty: new Map(),
            dailyAmount: new Map(),
          });
        }
        const prod = cust.products.get(key)!;
        if (iso < prod.firstDate) prod.firstDate = iso;
        prod.dailyQty.set(iso, (prod.dailyQty.get(iso) ?? 0) + (Number(r.qty) || 0));
        prod.dailyAmount.set(iso, (prod.dailyAmount.get(iso) ?? 0) + (parseFloat(r.line_total) || 0));
      }

      // A / B / C per product, assigned across every bill in the run so one
      // letter names one rate on all of them - the same letters the GST
      // Statement and Agent Sales print.
      const suffixes = priceVariantSuffixes(
        (lines as any[]).map(r => ({
          groupKey: r.product_id,
          rate: parseFloat(r.gross_rate) || 0,
          firstDate: new Date(r.sale_date).toISOString().slice(0, 10),
        }))
      );

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
          // Price versions of one SKU sit side by side, oldest first, so the
          // Rate row reads left to right in the order the prices applied.
          const products = Array.from(cust.products.values())
            .sort((a, b) =>
              a.sortOrder - b.sortOrder ||
              a.reportAlias.localeCompare(b.reportAlias) ||
              a.firstDate.localeCompare(b.firstDate) ||
              a.grossRate - b.grossRate);

          // Per-day rows. The day total is the sum of the actual booked
          // (GST-inclusive) line amounts for that day, so it ties out to the
          // Amount footer exactly.
          const dailyRows = dateList.map(iso => {
            const qty = products.map(p => p.dailyQty.get(iso) ?? 0);
            const dayTotal = products.reduce((s, p) => s + (p.dailyAmount.get(iso) ?? 0), 0);
            const [_, __, day] = iso.split("-");
            return {
              day,           // "01" .. "31"
              date: iso,     // full ISO for tooltip / debugging
              qty,           // array aligned with products[]
              dayTotal: round2(dayTotal),
            };
          });

          // Footer totals — all arrays aligned with products[].
          // Amount is the GST-inclusive booked value; BASIC is reverse-derived
          // (Amount ÷ (1 + gst%)) and CGST = SGST = (Amount − BASIC) / 2, so
          // BASIC + CGST + SGST == Amount to the paisa (matches the paper bill).
          const pkts = products.map((_, i) => dailyRows.reduce((s, r) => s + (r.qty[i] ?? 0), 0));
          const kgLtr = products.map((p, i) => round3(toKgLtr(pkts[i] ?? 0, p.packSize, p.unit)));
          const amount = products.map(p =>
            round2(Array.from(p.dailyAmount.values()).reduce((s, v) => s + v, 0)));
          // CGST and SGST are always equal: each is exactly half the tax, so
          // an odd paisa shows as a half-paisa on both (three decimals) and
          // BASIC + CGST + SGST equals Amount exactly (see splitGstFromGross).
          const splits = products.map((p, i) => splitGstFromGross(amount[i] ?? 0, p.gstPct));
          const basic = splits.map(sp => sp.basic);
          const cgstPctArr = products.map(p => round2(p.gstPct / 2));
          const sgstPctArr = products.map(p => round2(p.gstPct / 2));
          const cgst = splits.map(sp => sp.cgst);
          const sgst = splits.map(sp => sp.sgst);

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
              // Unique per column: one SKU can appear twice, at two prices.
              key: p.key,
              id: p.id,
              code: p.code,
              reportAlias:
                p.reportAlias + (suffixes.get(priceVariantKey(p.id, p.grossRate)) ?? ""),
              category: p.category,
              hsn: p.hsn,
              session: p.session,
              // The taxable (pre-GST) rate the BASIC row is built from —
              // rupees and paise, never a third decimal. Derived from the
              // gross this column booked and the CURRENT GST rate, so a rate
              // correction in the product master moves this row and the BASIC
              // row together and the bill still foots to the same Amount.
              rate: round2(p.grossRate / (1 + (Number(p.gstPct) || 0) / 100)),
              grossRate: round2(p.grossRate),
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

      // Per (taluka=zone, dealer, product) qty + amount.
      //
      // Taluka comes from the DEALER's current zone (d.zone_id), not the
      // zone snapshotted onto the order at creation (o.zone_id). A taluka is
      // an attribute of the customer, not a fact about the dispatch — unlike
      // orders.route_id, which is deliberately a snapshot because it records
      // where the goods physically went that day. When a dealer's taluka is
      // corrected in the master, their past sales must move with them, or the
      // order keeps reporting under the taluka the record used to hold. This
      // also matches Officer Wise Sales (B3), which already resolves the
      // officer through d.zone_id, so the two reports agree.
      // Gate passes ride along on the second arm. A gate pass IS a sale to
      // that agent — goods they collected at the plant instead of taking on
      // the vehicle — so leaving it out understated the very dealer the report
      // is about. Only customer_type='agent' direct sales map to a dealer and
      // therefore to a taluka; cash, VIP and employee counter sales have no
      // dealer and stay out, exactly as on Officer Wise Sales (B3).
      const rows = await pgClient`
        WITH combined AS (
          SELECT d.id AS dealer_id, oi.product_id, oi.quantity::int AS qty,
                 oi.line_total::numeric AS amount
          FROM orders o
          JOIN dealers d ON d.id = o.dealer_id
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.delivery_date >= ${q.from}::date
            AND o.delivery_date <= ${q.to}::date
            AND o.created_at >= ${q.from}::date - interval '31 days'
            AND o.created_at <  ${q.to}::date + interval '2 days'
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                             AND dr.id = COALESCE(o.route_id,
                                   (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
          UNION ALL
          SELECT d.id, dsi.product_id, dsi.quantity::int, dsi.line_total::numeric
          FROM direct_sales ds
          JOIN dealers d ON d.id = ds.customer_id AND ds.customer_type = 'agent'
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
        )
        SELECT z.name AS taluka,
               d.id AS dealer_id, d.code AS dealer_code, d.name AS dealer_name,
               cb.product_id,
               p.category_id, c.name AS category_name,
               COALESCE(p.pack_size, 0)::numeric AS pack_size, p.unit,
               SUM(cb.qty)::int       AS qty,
               SUM(cb.amount)::numeric AS amount
        FROM combined cb
        JOIN dealers d ON d.id = cb.dealer_id
        JOIN zones z ON z.id = d.zone_id
        JOIN products p ON p.id = cb.product_id
        JOIN categories c ON c.id = p.category_id
        GROUP BY z.name, d.id, d.code, d.name, cb.product_id, p.category_id, c.name,
                 p.pack_size, p.unit
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
            id: r.dealer_id,
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
        // milk / curd category buckets, in Ltr / Kg (packets x pack_size),
        // the same unit the detailed matrix now prints.
        const vol = toKgLtr(qty, parseFloat(r.pack_size) || 0, r.unit ?? "");
        if (milkCatSet.has(catOf(r.category_name)) && !curdCatSet.has(catOf(r.category_name))) {
          cust.summary.milkTotalQty = round2(cust.summary.milkTotalQty + vol);
        }
        if (curdCatSet.has(catOf(r.category_name))) {
          cust.summary.curdTotalQty = round2(cust.summary.curdTotalQty + vol);
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
          id: c.id,
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
          id: c.id,
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
            milkTotalQty: round2(acc.milkTotalQty + r.milkTotalQty),
            curdTotalQty: round2(acc.curdTotalQty + r.curdTotalQty),
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
        products: (products as any[]).map(p => ({
          id: p.id,
          reportAlias: p.report_alias ?? p.name,
          sortOrder: p.sort_order,
          packSize: parseFloat(p.pack_size) || 0,
          unit: p.unit ?? "",
        })),
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
  //   the number of days in the period. Sales are attributed to the DEALER's
  //   current zone (taluka), like the Taluka/Agent report above — see the note
  //   there for why the order's snapshotted zone_id is the wrong source.
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
      // Everything that is neither milk nor curd (lassi, buttermilk, ghee,
      // paneer, sweets, …) gets its own product page, mirroring the milk/curd
      // pages. Volume is derived the same way (packets × pack_size, unit-aware).
      const otherProducts = (products as any[]).filter(
        p => !milkIds.has(p.id) && !curdIds.has(p.id)
      );
      const otherIds = new Set(otherProducts.map(p => p.id));
      const packSizeById = new Map((products as any[]).map(p => [p.id, parseFloat(p.pack_size) || 0]));
      const unitById = new Map((products as any[]).map(p => [p.id, p.unit ?? ""]));

      // Per (taluka = zone, product) qty, orders plus agent gate passes. A
      // taluka is a property of the dealer, so only the direct sales that name
      // a dealer (customer_type='agent') can be placed on this report; cash,
      // VIP and employee counter sales have no taluka and stay out, the same
      // rule Officer Wise (B3) and Agent Wise (B9) apply.
      const rows = await pgClient`
        WITH combined AS (
          SELECT d.zone_id, oi.product_id, oi.quantity::int AS qty
          FROM orders o
          JOIN dealers d ON d.id = o.dealer_id
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.delivery_date >= ${q.from}::date
            AND o.delivery_date <= ${q.to}::date
            AND o.created_at >= ${q.from}::date - interval '31 days'
            AND o.created_at <  ${q.to}::date + interval '2 days'
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                             AND dr.id = COALESCE(o.route_id,
                                   (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
          UNION ALL
          SELECT d.zone_id, dsi.product_id, dsi.quantity::int
          FROM direct_sales ds
          JOIN dealers d ON d.id = ds.customer_id AND ds.customer_type = 'agent'
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
        )
        SELECT z.name AS taluka, cb.product_id, SUM(cb.qty)::int AS qty
        FROM combined cb
        JOIN zones z ON z.id = cb.zone_id
        GROUP BY z.name, cb.product_id
      `;

      const numDays = Math.max(
        1,
        Math.round((new Date(q.to).getTime() - new Date(q.from).getTime()) / 86_400_000) + 1
      );

      // taluka → { productId → volume } (raw; rounded only on the way out)
      const talukaMap = new Map<string, {
        milkVol: Record<string, number>;
        curdVol: Record<string, number>;
        otherVol: Record<string, number>;
      }>();
      for (const r of rows as any[]) {
        if (!talukaMap.has(r.taluka)) talukaMap.set(r.taluka, { milkVol: {}, curdVol: {}, otherVol: {} });
        const t = talukaMap.get(r.taluka)!;
        const vol = toKgLtr(Number(r.qty) || 0, packSizeById.get(r.product_id) ?? 0, unitById.get(r.product_id) ?? "");
        if (milkIds.has(r.product_id)) t.milkVol[r.product_id] = (t.milkVol[r.product_id] ?? 0) + vol;
        else if (curdIds.has(r.product_id)) t.curdVol[r.product_id] = (t.curdVol[r.product_id] ?? 0) + vol;
        else if (otherIds.has(r.product_id)) t.otherVol[r.product_id] = (t.otherVol[r.product_id] ?? 0) + vol;
      }

      const talukaRows = Array.from(talukaMap.keys())
        .sort((a, b) => a.localeCompare(b))
        .map(taluka => {
          const t = talukaMap.get(taluka)!;
          const totalMilk = milkProducts.reduce((s, p) => s + (t.milkVol[p.id] ?? 0), 0);
          const totalCurd = curdProducts.reduce((s, p) => s + (t.curdVol[p.id] ?? 0), 0);
          const totalOther = otherProducts.reduce((s, p) => s + (t.otherVol[p.id] ?? 0), 0);
          return {
            taluka,
            milkQty: Object.fromEntries(milkProducts.map(p => [p.id, round2(t.milkVol[p.id] ?? 0)])),
            curdQty: Object.fromEntries(curdProducts.map(p => [p.id, round2(t.curdVol[p.id] ?? 0)])),
            otherQty: Object.fromEntries(otherProducts.map(p => [p.id, round2(t.otherVol[p.id] ?? 0)])),
            totalMilk: round2(totalMilk),
            avgMilk: round2(totalMilk / numDays),
            totalCurd: round2(totalCurd),
            avgCurd: round2(totalCurd / numDays),
            totalOther: round2(totalOther),
            avgOther: round2(totalOther / numDays),
          };
        });

      // Column + grand totals (summed across talukas).
      const colTotal = (sel: (r: typeof talukaRows[number]) => Record<string, number>, id: string) =>
        round2(talukaRows.reduce((s, r) => s + (sel(r)[id] ?? 0), 0));
      const totalMilk = round2(talukaRows.reduce((s, r) => s + r.totalMilk, 0));
      const totalCurd = round2(talukaRows.reduce((s, r) => s + r.totalCurd, 0));
      const totalOther = round2(talukaRows.reduce((s, r) => s + r.totalOther, 0));

      return reply.send({
        from: q.from,
        to: q.to,
        numDays,
        milkProducts: milkProducts.map(p => ({ id: p.id, reportAlias: p.report_alias ?? p.name, sortOrder: p.sort_order })),
        curdProducts: curdProducts.map(p => ({ id: p.id, reportAlias: p.report_alias ?? p.name, sortOrder: p.sort_order })),
        otherProducts: otherProducts.map(p => ({ id: p.id, reportAlias: p.report_alias ?? p.name, sortOrder: p.sort_order })),
        rows: talukaRows,
        totals: {
          milkQty: Object.fromEntries(milkProducts.map(p => [p.id, colTotal(r => r.milkQty, p.id)])),
          curdQty: Object.fromEntries(curdProducts.map(p => [p.id, colTotal(r => r.curdQty, p.id)])),
          otherQty: Object.fromEntries(otherProducts.map(p => [p.id, colTotal(r => r.otherQty, p.id)])),
          totalMilk,
          avgMilk: round2(totalMilk / numDays),
          totalCurd,
          avgCurd: round2(totalCurd / numDays),
          totalOther,
          avgOther: round2(totalOther / numDays),
        },
      });
    }
  );


  // ════════════════════════════════════════════
  // B7d. Product Wise Taluka Sales
  //
  //   Product (rows) × Taluka (columns) — packets, Ltr/Kg volume and ₹ —
  //   over a date range, narrowed by any of:
  //
  //     categoryId  one product category (blank = all)
  //     productId   one product inside it (blank = every product)
  //     zoneId      one taluka (blank = every taluka)
  //
  //   Where Taluka Wise (B7b) fixes its columns to the milk / curd / other
  //   split and always prints every taluka, this one is the drill-down: pick
  //   a category, a single SKU, or a single taluka and read that slice alone.
  //
  //   Same two rails, and the same reason, as Taluka Wise and Agent Wise: a
  //   taluka is an attribute of the DEALER (d.zone_id), so only sales that
  //   name a dealer can carry one — dealer orders, plus the gate passes an
  //   agent collected at the plant (direct_sales, customer_type='agent').
  //   Cash, VIP and employee counter sales have no dealer behind them and
  //   stay out, exactly as on B3 / B7 / B7b.
  //
  //   Taluka resolves through the dealer's CURRENT zone, not a snapshot, so
  //   correcting a dealer's taluka in the master moves their history with
  //   them — the rule B3 and B7 already follow.
  //
  //   One deliberate difference from B7b: a dealer with no taluka set is
  //   bucketed under an UNASSIGNED sentinel column rather than dropped. B7b
  //   inner-joins zones, so such a sale silently vanishes from it; on a
  //   report meant to be read against a product's own total that is a hole,
  //   and the sentinel is the same device the route reports use for ADHOC.
  //
  //   Rows are the products that actually sold in the filtered slice. Listing
  //   every available SKU would print 174 mostly-empty rows whenever no
  //   category is picked, which is the opposite of what a drill-down is for.
  //
  //   Amounts are gross (GST-inclusive) — line_total as billed — matching
  //   every other qty + ₹ grid in this file.
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/product-taluka",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema
        .extend({
          categoryId: z.string().uuid().optional(),
          productId: z.string().uuid().optional(),
          zoneId: z.string().uuid().optional(),
        })
        .parse(request.query);

      // Absent = no filter. Each optional filter follows the pattern used
      // across the CRUD routes: an IS NULL test on the bound value, plus a
      // never-matching fallback in the equality slot so the comparison stays
      // well-typed when the filter is off.
      const categoryId = q.categoryId ?? null;
      const productId = q.productId ?? null;
      const zoneId = q.zoneId ?? null;
      const NO_MATCH = "ffffffff-ffff-ffff-ffff-ffffffffffff";

      const rows = await pgClient`
        WITH combined AS (
          SELECT o.dealer_id, oi.product_id, oi.quantity::int AS qty,
                 oi.line_total::numeric AS amount
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.delivery_date >= ${q.from}::date
            AND o.delivery_date <= ${q.to}::date
            AND o.created_at >= ${q.from}::date - interval '31 days'
            AND o.created_at <  ${q.to}::date + interval '2 days'
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                             AND dr.id = COALESCE(o.route_id,
                                   (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
          UNION ALL
          SELECT ds.customer_id, dsi.product_id, dsi.quantity::int,
                 dsi.line_total::numeric
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.customer_type = 'agent'
            AND ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
        )
        SELECT COALESCE(z.id, ${UNASSIGNED_ZONE_ID}::uuid) AS taluka_id,
               COALESCE(z.name, 'UNASSIGNED')              AS taluka_name,
               p.id AS product_id, p.code, p.report_alias, p.name, p.sort_order,
               COALESCE(p.pack_size, 0)::numeric AS pack_size, p.unit,
               c.id AS category_id, c.name AS category_name,
               SUM(cb.qty)::int        AS qty,
               SUM(cb.amount)::numeric AS amount
        FROM combined cb
        JOIN dealers d    ON d.id = cb.dealer_id
        LEFT JOIN zones z ON z.id = d.zone_id
        JOIN products p   ON p.id = cb.product_id
        JOIN categories c ON c.id = p.category_id
        WHERE (${categoryId}::uuid IS NULL OR p.category_id = ${categoryId ?? NO_MATCH}::uuid)
          AND (${productId}::uuid  IS NULL OR p.id          = ${productId ?? NO_MATCH}::uuid)
          AND (${zoneId}::uuid     IS NULL
               OR COALESCE(d.zone_id, ${UNASSIGNED_ZONE_ID}::uuid) = ${zoneId ?? NO_MATCH}::uuid)
        GROUP BY z.id, z.name, p.id, p.code, p.report_alias, p.name, p.sort_order,
                 p.pack_size, p.unit, c.id, c.name
        ORDER BY p.sort_order, p.name
      `;

      const numDays = Math.max(
        1,
        Math.round((new Date(q.to).getTime() - new Date(q.from).getTime()) / 86_400_000) + 1
      );

      // Columns: the talukas that actually sold, alphabetical, with the
      // UNASSIGNED bucket pinned last so it reads as the remainder it is.
      const talukaNames = new Map<string, string>();
      for (const r of rows as any[]) talukaNames.set(r.taluka_id, r.taluka_name);
      const talukas = Array.from(talukaNames, ([id, name]) => ({ id, name })).sort((a, b) =>
        a.id === UNASSIGNED_ZONE_ID ? 1
          : b.id === UNASSIGNED_ZONE_ID ? -1
            : a.name.localeCompare(b.name)
      );

      // Rows: one per product, in the master's print order (sort_order, name).
      type Cell = { qty: number; vol: number; amount: number };
      type ProdAcc = {
        id: string; code: string; reportAlias: string; name: string;
        categoryName: string; packSize: number; unit: string; sortOrder: number;
        cells: Map<string, Cell>;
      };
      const prodMap = new Map<string, ProdAcc>();
      for (const r of rows as any[]) {
        let acc = prodMap.get(r.product_id);
        if (!acc) {
          acc = {
            id: r.product_id,
            code: r.code ?? "",
            reportAlias: r.report_alias ?? r.name,
            name: r.name,
            categoryName: r.category_name ?? "",
            packSize: parseFloat(r.pack_size) || 0,
            unit: r.unit ?? "",
            sortOrder: Number(r.sort_order) || 0,
            cells: new Map(),
          };
          prodMap.set(r.product_id, acc);
        }
        const qty = Number(r.qty) || 0;
        const cell = acc.cells.get(r.taluka_id) ?? { qty: 0, vol: 0, amount: 0 };
        cell.qty += qty;
        cell.vol += toKgLtr(qty, acc.packSize, acc.unit);
        cell.amount += parseFloat(r.amount) || 0;
        acc.cells.set(r.taluka_id, cell);
      }

      const productRows = Array.from(prodMap.values())
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .map(p => {
          const spread = (f: keyof Cell, round: (n: number) => number) =>
            Object.fromEntries(talukas.map(t => [t.id, round(p.cells.get(t.id)?.[f] ?? 0)]));
          const sum = (f: keyof Cell) =>
            talukas.reduce((s, t) => s + (p.cells.get(t.id)?.[f] ?? 0), 0);
          const totalQty = sum("qty");
          const totalVol = sum("vol");
          const totalAmount = sum("amount");
          return {
            productId: p.id,
            code: p.code,
            reportAlias: p.reportAlias,
            name: p.name,
            categoryName: p.categoryName,
            packSize: p.packSize,
            unit: p.unit,
            qty: spread("qty", n => n),
            vol: spread("vol", round3),
            amount: spread("amount", round2),
            totalQty,
            totalVol: round3(totalVol),
            totalAmount: round2(totalAmount),
            avgQty: round2(totalQty / numDays),
            avgVol: round3(totalVol / numDays),
          };
        });

      // Column totals are summed from the ROUNDED cells the sheet prints, so
      // a column adds up to what the eye adds up to.
      //
      // `vol` totals are only a quantity of anything when the slice reads in
      // ONE unit: across all categories they add litres of milk to kilos of
      // curd. They are returned regardless — a category- or product-filtered
      // run is single-unit and wants them — and the web suppresses the total
      // line when the rows it got back are mixed.
      const colTotal = (
        f: "qty" | "vol" | "amount",
        round: (n: number) => number
      ): Record<string, number> =>
        Object.fromEntries(
          talukas.map(t => [
            t.id,
            round(productRows.reduce((s, r) => s + (r[f][t.id] ?? 0), 0)),
          ])
        );
      const grandQty = productRows.reduce((s, r) => s + r.totalQty, 0);
      const grandVol = productRows.reduce((s, r) => s + r.totalVol, 0);
      const grandAmount = productRows.reduce((s, r) => s + r.totalAmount, 0);

      return reply.send({
        from: q.from,
        to: q.to,
        numDays,
        filters: { categoryId, productId, zoneId },
        talukas,
        products: productRows.map(r => ({
          id: r.productId,
          code: r.code,
          reportAlias: r.reportAlias,
          name: r.name,
          categoryName: r.categoryName,
          packSize: r.packSize,
          unit: r.unit,
        })),
        rows: productRows,
        totals: {
          qty: colTotal("qty", n => n),
          vol: colTotal("vol", round3),
          amount: colTotal("amount", round2),
          totalQty: grandQty,
          totalVol: round3(grandVol),
          totalAmount: round2(grandAmount),
          avgQty: round2(grandQty / numDays),
          avgVol: round3(grandVol / numDays),
        },
      });
    }
  );
  // ════════════════════════════════════════════
  // B7c. Agent Sales — one block per agent (legacy per-customer statement)
  //
  //   Code | Customer Name | Packet Name | Rate | Qty No | Qty Ltrs/Kg | Amount
  //
  //   One line per (product, price) an agent bought in the period, closed by
  //   the agent's grand total and Milk / Curd / Other volume + value rows.
  //
  //   RATE is the GST-inclusive per-packet price the line was billed at —
  //   unit_price x (1 + gst%) — so Rate x Qty reconciles against Amount on the
  //   printed sheet. A product bought at two different prices inside the
  //   period prints as two lines, exactly as the legacy statement did, tagged
  //   → A and → B on the packet name (oldest price first): collapsing them
  //   would
  //   invent a rate that was never charged.
  //
  //   Lines group on that PRINTED rate, not on the raw stored net. Prices are
  //   2dp everywhere now, but history holds nets that differ only in a third
  //   decimal (products.base_price was derived at 3dp until 2026-08-22, so
  //   COOKIES 20GM sits at both 255.100 and 255.105). Those are the same
  //   ₹267.86 packet and must print as one line; grouping on the raw net
  //   split them into two identical-looking rows. Correcting a product's GST
  //   rate does not split a line either — the gross is what the agent paid
  //   and it does not move (see splitGstFromGross).
  //
  //   Same two rails as Taluka/Agent Wise (B7): dealer orders plus the gate
  //   passes an agent collected at the plant (direct_sales, customer_type
  //   'agent'). Cash / VIP / employee counter sales have no dealer behind them
  //   and stay out.
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/agent-sales",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSchema.extend({
        // Blank / absent = every agent that traded in the period.
        dealerId: z.string().uuid().optional(),
      }).parse(request.query);
      const cfg = await loadReportConfig();

      // Milk / curd buckets come from the same config the Taluka Wise Report
      // reads, so the two reports bucket a product the same way. Everything
      // outside those two category groups is "other".
      const milkCatSet = new Set(cfg.categoryGroups.milk.map(c => c.toLowerCase()));
      const curdCatSet = new Set(cfg.categoryGroups.curd.map(c => c.toLowerCase()));

      // Per (agent, product, printed rate) packets + amount. Grouping on the
      // rounded GST-inclusive rate is what splits a revised price into its own
      // line, while sub-paisa differences in the stored net collapse.
      //
      // That rate reads the line's OWN gst snapshot, so it holds still when
      // products.gst_percent is corrected — a GST fix re-splits basic and tax
      // but never changes what the agent paid, and must not spawn a second
      // rate line here.
      const rows = await pgClient`
        WITH combined AS (
          SELECT o.dealer_id,
                 oi.product_id,
                 o.delivery_date         AS sale_date,
                 round(oi.unit_price * (1 + oi.gst_percent / 100), 2) AS rate,
                 oi.quantity::int        AS qty,
                 oi.line_total::numeric  AS amount
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.delivery_date >= ${q.from}::date
            AND o.delivery_date <= ${q.to}::date
            AND o.created_at >= ${q.from}::date - interval '31 days'
            AND o.created_at <  ${q.to}::date + interval '2 days'
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                             AND dr.id = COALESCE(o.route_id,
                                   (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
          UNION ALL
          SELECT ds.customer_id,
                 dsi.product_id,
                 ds.sale_date,
                 round(dsi.unit_price * (1 + dsi.gst_percent / 100), 2),
                 dsi.quantity::int,
                 dsi.line_total::numeric
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.customer_type = 'agent'
            AND ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
        )
        SELECT d.id AS dealer_id, d.code AS dealer_code, d.name AS dealer_name,
               cb.product_id,
               COALESCE(p.report_alias, p.name) AS product_name,
               c.name AS category_name,
               COALESCE(p.pack_size, 0)::numeric AS pack_size, p.unit,
               cb.rate                 AS rate,
               to_char(MIN(cb.sale_date), 'YYYY-MM-DD') AS first_date,
               SUM(cb.qty)::int        AS qty,
               SUM(cb.amount)::numeric AS amount
        FROM combined cb
        JOIN dealers d ON d.id = cb.dealer_id
        JOIN products p ON p.id = cb.product_id
        JOIN categories c ON c.id = p.category_id
        WHERE (${q.dealerId ?? null}::uuid IS NULL OR d.id = ${q.dealerId ?? null}::uuid)
        GROUP BY d.id, d.code, d.name, cb.product_id, p.report_alias, p.name,
                 c.name, p.pack_size, p.unit, cb.rate
        ORDER BY d.code, d.name, COALESCE(p.report_alias, p.name), cb.rate
      `;

      // A / B / C on the packet name, assigned per PRODUCT across the whole
      // report — so a price version carries the same letter on every agent's
      // sheet, and on the GST Statement, even for an agent who only bought
      // after the revision.
      const suffixes = priceVariantSuffixes(
        (rows as any[]).map(r => ({
          groupKey: r.product_id,
          rate: parseFloat(r.rate) || 0,
          firstDate: r.first_date ?? "",
        }))
      );

      type Line = {
        productId: string;
        name: string;
        bucket: "milk" | "curd" | "other";
        rate: number;
        qtyNo: number;
        qtyVol: number;
        unit: string;
        amount: number;
      };
      const agentMap = new Map<string, {
        id: string; code: string; name: string; lines: Line[];
      }>();

      for (const r of rows as any[]) {
        if (!agentMap.has(r.dealer_id)) {
          agentMap.set(r.dealer_id, {
            id: r.dealer_id,
            code: r.dealer_code ?? "",
            name: r.dealer_name,
            lines: [],
          });
        }
        const cat = (r.category_name ?? "").toLowerCase();
        const bucket: Line["bucket"] =
          milkCatSet.has(cat) ? "milk" : curdCatSet.has(cat) ? "curd" : "other";
        const rate = round2(parseFloat(r.rate) || 0);
        agentMap.get(r.dealer_id)!.lines.push({
          productId: r.product_id,
          name: r.product_name + (suffixes.get(priceVariantKey(r.product_id, rate)) ?? ""),
          bucket,
          // GST-inclusive packet rate, so Rate x Qty reads back as Amount.
          rate,
          qtyNo: Number(r.qty) || 0,
          qtyVol: round2(toKgLtr(Number(r.qty) || 0, parseFloat(r.pack_size) || 0, r.unit ?? "")),
          unit: r.unit ?? "",
          amount: round2(parseFloat(r.amount) || 0),
        });
      }

      // Lines print milk first, then curd, then everything else, each block
      // alphabetical — so the Milk / Curd / Other footer rows sit under the
      // lines they add up.
      const bucketRank = { milk: 0, curd: 1, other: 2 } as const;
      const agents = Array.from(agentMap.values())
        .sort((a, b) => (a.code || "").localeCompare(b.code || "") || a.name.localeCompare(b.name))
        .map(a => {
          const lines = a.lines.sort(
            (x, y) =>
              bucketRank[x.bucket] - bucketRank[y.bucket] ||
              x.name.localeCompare(y.name) ||
              x.rate - y.rate
          );
          const sum = (b: Line["bucket"], f: (l: Line) => number) =>
            round2(lines.reduce((s, l) => s + (l.bucket === b ? f(l) : 0), 0));
          return {
            ...a,
            lines,
            total: round2(lines.reduce((s, l) => s + l.amount, 0)),
            milkLtr:      sum("milk",  l => l.qtyVol),
            milkAmount:   sum("milk",  l => l.amount),
            curdKg:       sum("curd",  l => l.qtyVol),
            curdAmount:   sum("curd",  l => l.amount),
            otherQty:     sum("other", l => l.qtyVol),
            otherAmount:  sum("other", l => l.amount),
          };
        });

      const gsum = (f: (a: typeof agents[number]) => number) =>
        round2(agents.reduce((s, a) => s + f(a), 0));

      return reply.send({
        from: q.from,
        to: q.to,
        agents,
        totals: {
          total:       gsum(a => a.total),
          milkLtr:     gsum(a => a.milkLtr),
          milkAmount:  gsum(a => a.milkAmount),
          curdKg:      gsum(a => a.curdKg),
          curdAmount:  gsum(a => a.curdAmount),
          otherQty:    gsum(a => a.otherQty),
          otherAmount: gsum(a => a.otherAmount),
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

      // Every one-off counter transaction, across both rails.
      //
      // The name column used to resolve only 'agent' and 'cash', so VIP
      // samples and employee-subsidy rows printed a blank customer. All four
      // direct-sale types are covered now, each falling back to the
      // recipient_name snapshot on the sale and then to a generic label, so a
      // row can never render nameless.
      //
      // The employee subsidy also gets its own arm: it left direct_sales for
      // employee_orders on 2026-08-02, and it is still exactly what this
      // report is for — goods collected at the plant counter, no route, no
      // vehicle. Those rows carry no gate-pass number (only direct_sales has
      // the gp_no sequence), so they bill under their invoice number instead
      // and the customer name is prefixed to keep the two rails legible side
      // by side.
      const rows = await pgClient`
        WITH combined AS (
          SELECT ds.id,
                 ds.gp_no,
                 ds.sale_date,
                 CASE ds.customer_type::text
                   WHEN 'agent'            THEN COALESCE(d.name,  ds.recipient_name, 'Agent')
                   WHEN 'cash'             THEN COALESCE(cc.name, ds.recipient_name, 'Cash Customer')
                   WHEN 'vip_sample'       THEN COALESCE(vc.name, ds.recipient_name, 'VIP Sample')
                   WHEN 'employee_subsidy' THEN COALESCE(e.name,  ds.recipient_name, 'Employee')
                   ELSE COALESCE(ds.recipient_name, 'Counter Sale')
                 END AS customer_name,
                 -- How it was settled. Every row on this report used to look
                 -- alike, so a pass handed over on credit was indistinguishable
                 -- from one paid for in cash at the counter.
                 ds.payment_mode::text AS pay_mode,
                 ds.grand_total::numeric AS amount
          FROM direct_sales ds
          LEFT JOIN dealers d         ON ds.customer_type = 'agent'            AND d.id  = ds.customer_id
          LEFT JOIN cash_customers cc ON ds.customer_type = 'cash'             AND cc.id = ds.customer_id
          LEFT JOIN vip_contacts vc   ON ds.customer_type = 'vip_sample'       AND vc.id = ds.customer_id
          LEFT JOIN employees e       ON ds.customer_type = 'employee_subsidy' AND e.id  = ds.customer_id
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
          UNION ALL
          SELECT eo.id,
                 NULL AS gp_no,
                 eo.delivery_date AS sale_date,
                 'Employee subsidy: ' || COALESCE(e.name, 'unknown') AS customer_name,
                 eo.payment_mode::text AS pay_mode,
                 eo.grand_total::numeric AS amount
          FROM employee_orders eo
          LEFT JOIN employees e ON e.id = eo.employee_id
          WHERE eo.delivery_date >= ${q.from}::date
            AND eo.delivery_date <= ${q.to}::date
            AND eo.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
        ),
        page AS (
          SELECT * FROM combined
          ORDER BY sale_date DESC, gp_no NULLS LAST
          LIMIT ${q.limit} OFFSET ${offset}
        )
        SELECT p.*,
               -- Bill number. A counter sale always carries a gate-pass number
               -- (direct_sales.gp_no defaults off a sequence); an employee
               -- indent has none, so it falls back to the invoice minted for
               -- it. invoices.order_id is polymorphic and unique
               -- (uq_invoices_order_id), so this resolves at most one row.
               COALESCE(
                 p.gp_no,
                 (SELECT i.invoice_number FROM invoices i WHERE i.order_id = p.id)
               ) AS bill_no,
               -- Line items, rolled up. The aggregate runs over the LIMITed
               -- page, not the whole date range. string_agg returns NULL when
               -- a rail holds no rows for this id, so the COALESCE picks
               -- whichever of the two rails the row actually came from.
               COALESCE(
                 (SELECT string_agg(dsi.product_name || ' × ' || dsi.quantity::text,
                                    ', ' ORDER BY dsi.product_name)
                    FROM direct_sale_items dsi
                   WHERE dsi.direct_sale_id = p.id),
                 (SELECT string_agg(eoi.product_name || ' × ' || eoi.quantity::text,
                                    ', ' ORDER BY eoi.product_name)
                    FROM employee_order_items eoi
                   WHERE eoi.employee_order_id = p.id),
                 ''
               ) AS items_text
        FROM page p
        ORDER BY p.sale_date DESC, p.gp_no NULLS LAST
      `;

      const [countRow] = await pgClient`
        WITH combined AS (
          SELECT ds.grand_total::numeric AS amount
          FROM direct_sales ds
          WHERE ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
          UNION ALL
          SELECT eo.grand_total::numeric
          FROM employee_orders eo
          WHERE eo.delivery_date >= ${q.from}::date
            AND eo.delivery_date <= ${q.to}::date
            AND eo.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
        )
        SELECT count(*)::int AS count, COALESCE(sum(amount),0)::numeric AS total_amount
        FROM combined
      `;

      const mapped = (rows as any[]).map((r, idx) => ({
        sl: offset + idx + 1,
        id: r.id,
        date: new Date(r.sale_date).toISOString().slice(0, 10),
        billNo: r.bill_no ?? "",
        customerName: r.customer_name ?? "",
        payMode: r.pay_mode ?? "",
        itemsText: r.items_text ?? "",
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
  //
  // TWO RULES DECIDE WHAT SHARES A ROW.
  //
  // 1. The GST RATE is read live and applied to the whole period. The rate
  //    comes from products.gst_percent as it stands today, and the taxable
  //    value / CGST / SGST are backed out of the gross the sale actually
  //    booked (see splitGstFromGross) — the per-line gst_percent and
  //    gst_amount snapshots are not read at all. Correcting a wrong rate in
  //    the product master therefore corrects every past sale of that SKU on
  //    this statement, without touching a rupee of what was billed: the
  //    gross is frozen, only the split between basic and tax moves. Before
  //    this, a rate correction split one SKU into a 12% row and a 5% row and
  //    could only be fixed by a repair script over the stored lines.
  //
  // 2. The PRICE never averages. A dealer-price or MRP revision inside the
  //    period gives each price its own row, tagged → A, → B, → C … oldest first
  //    (see priceVariantSuffixes), each carrying its own packets, taxable
  //    value and tax. An SKU that held one price all period is untagged.
  //
  // Subsidised sales get their OWN row, separate from the full-price sales
  // of the same SKU: the employee scheme sells at half MRP, so folding both
  // into one line hid a second taxable value behind a single product name
  // (e.g. GHEE SACHET 500ML at ₹303.03 and ₹274.44 summed together). The
  // subsidy row is suffixed " (Subsidy)" and sorts right after its
  // full-price sibling.
  //
  // Employee subsidy spans two rails — employee_orders (since 2026-08-02,
  // when it became a real indent) and the direct_sales rows it was written
  // as before that — so both are unioned in, exactly like the Employee
  // Subsidy Statement below. Only placed indents count: a draft employee
  // order is not a sale and must never reach a GST return.
  //
  // THE SUBSIDY IS A CREDIT SUPPLY, on both of those rails. No money is
  // collected at the counter: the ghee debits employee_ledger against the
  // employee's credit limit and is recovered from salary, so it files under
  // ?saleType=credit, the same side the Sales Register (B6) puts it on. It
  // used to file as cash on both rails, which mixed a salary receivable in
  // with counter money and left it off the credit statement entirely.
  //
  // Credit-institution sales ('Credit Inst-*' customers, on the orders they
  // have not already paid for — see lib/credit-check.ts) are selected with
  // ?saleType, the same cash / credit split the Sales Register (B6) offers.
  // The default stays 'cash', i.e. they are excluded: they are billed monthly
  // on the separate B5 Credit Sales bill, which carries its own
  // BASIC/CGST/SGST breakup, so counting them here too reports the same supply
  // twice — read a 'credit' or 'all' statement with that in mind.
  //
  // VIP SAMPLES ARE OUT. A 'vip_sample' gate pass is goods given away
  // complimentary: every line is ₹0 and is written with gst_percent 0, so it
  // never merges into the paid row for that SKU — it lands as a row of its
  // own carrying a packet count against an empty taxable value, CGST, SGST
  // and invoice value. Fifteen such rows on a three-week statement, none of
  // them a taxable supply. (Verified in production: no vip_sample line has
  // ever carried a value, and no other customer_type settles 'complimentary'.)
  // ════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/gst-statement",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = dateRangeSaleTypeSchema.parse(request.query);
      // Counter sales are cash money and stay on the cash side — except a
      // gate pass issued on credit, which is genuine credit supply, and the
      // employee subsidy, which is recovered from salary (see the header).
      // Both of those follow the credit arm on whichever rail they were
      // written to, so a range spanning the 2026-08-02 switchover cannot file
      // the same subsidy as cash on one side of the date and credit on the
      // other.
      const { wantCash, wantCredit } = saleTypeBuckets(q.saleType);

      // One row per (product, subsidy flag, PRICE). A dealer-price or MRP
      // revision inside the period lands as two rows tagged → A / → B rather than
      // one row carrying an average rate nobody was ever charged — see
      // priceVariantSuffixes. Rows are NOT split on the GST rate: that is read
      // live off the product master below and re-applied to the whole period.
      //
      // Only the gross (line_total) is summed here. taxable / CGST / SGST are
      // derived from it in JS, so what the statement files follows
      // products.gst_percent as it stands today.
      const rows = await pgClient`
        -- Every amount below is a COLLECTED amount. The gross a line carries
        -- is its stored line_total plus, on the largest line of each
        -- document, that document's rounding residue (grand_total minus the
        -- sum of its line_totals). So the statement's invoice value ties to
        -- the money actually charged, exactly as the Cash Sales grid does.
        --
        -- The A / B / C price-variant key is round(unit_price * (1 + gst), 2),
        -- taken from the PRICE and never from amount/qty, so moving a residue
        -- onto a line cannot invent or merge a price row. See
        -- priceVariantSuffixes and the header note.
        WITH ord AS (
          SELECT o.id, o.delivery_date, o.grand_total
          FROM orders o
          JOIN dealers d ON d.id = o.dealer_id
            WHERE o.delivery_date >= ${q.from}::date
              AND o.delivery_date <= ${q.to}::date
              AND o.created_at >= ${q.from}::date - interval '31 days'
              AND o.created_at <  ${q.to}::date + interval '2 days'
              AND o.status IN ('confirmed', 'dispatched', 'delivered')
              AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                               AND dr.id = COALESCE(o.route_id,
                                     (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
              -- Cash / credit split. Credit supply is a credit institution that
              -- has NOT paid at checkout; one that paid up front by UPI is
              -- settled money and files on the cash side with everyone else.
              -- Canonical rule: lib/credit-check.ts.
              AND ( (${wantCash}::boolean   AND NOT (COALESCE(d.customer_type::text, '') LIKE 'Credit Inst%'
                                                     AND o.payment_mode::text <> 'upi'))
                 OR (${wantCredit}::boolean AND     (COALESCE(d.customer_type::text, '') LIKE 'Credit Inst%'
                                                     AND o.payment_mode::text <> 'upi')) )
        ),
        ord_li AS (
          SELECT oi.order_id, oi.product_id, oi.quantity, oi.line_total,
                 oi.unit_price, oi.gst_percent,
                 SUM(oi.line_total) OVER (PARTITION BY oi.order_id) AS line_sum,
                 ROW_NUMBER() OVER (PARTITION BY oi.order_id
                                    ORDER BY oi.line_total DESC, oi.product_id) AS rn
          FROM order_items oi
          JOIN ord ON ord.id = oi.order_id
        ),
        dsale AS (
          SELECT ds.id, ds.sale_date, ds.grand_total,
                 (ds.customer_type::text = 'employee_subsidy') AS is_subsidy
          FROM direct_sales ds
            WHERE ds.sale_date >= ${q.from}::date
              AND ds.sale_date <= ${q.to}::date
              AND ds.status = 'confirmed'
              AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
              -- Complimentary VIP samples are given away, not sold (see header).
              AND ds.customer_type::text <> 'vip_sample'
              -- Two ways onto the credit side, exactly as the Sales Register
              -- (B6) splits this rail: a gate pass rung up on 'credit' (on this
              -- rail payment_mode IS the answer, unlike the orders rail where
              -- 'credit' marks prepaid wallet money), and the employee subsidy
              -- sold before 2026-08-02, which still lives here and must land on
              -- the same side as the employee_orders arm below. The rest is
              -- counter money and stays on the cash side.
              AND ( (${wantCash}::boolean   AND NOT (ds.customer_type::text = 'employee_subsidy'
                                                     OR ds.payment_mode::text = 'credit'))
                 OR (${wantCredit}::boolean AND     (ds.customer_type::text = 'employee_subsidy'
                                                     OR ds.payment_mode::text = 'credit')) )
        ),
        dsale_li AS (
          SELECT dsi.direct_sale_id, dsi.product_id, dsi.quantity, dsi.line_total,
                 dsi.unit_price, dsi.gst_percent,
                 SUM(dsi.line_total) OVER (PARTITION BY dsi.direct_sale_id) AS line_sum,
                 ROW_NUMBER() OVER (PARTITION BY dsi.direct_sale_id
                                    ORDER BY dsi.line_total DESC, dsi.product_id) AS rn
          FROM direct_sale_items dsi
          JOIN dsale ON dsale.id = dsi.direct_sale_id
        ),
        emp AS (
          SELECT eo.id, eo.delivery_date, eo.grand_total
          FROM employee_orders eo
            WHERE eo.delivery_date >= ${q.from}::date
              AND eo.delivery_date <= ${q.to}::date
              AND eo.status IN ('confirmed', 'dispatched', 'delivered')
              AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
              -- Credit side: recovered from salary, never counter cash.
              AND ${wantCredit}::boolean
        ),
        emp_li AS (
          SELECT eoi.employee_order_id, eoi.product_id, eoi.quantity, eoi.line_total,
                 eoi.unit_price, eoi.gst_percent,
                 SUM(eoi.line_total) OVER (PARTITION BY eoi.employee_order_id) AS line_sum,
                 ROW_NUMBER() OVER (PARTITION BY eoi.employee_order_id
                                    ORDER BY eoi.line_total DESC, eoi.product_id) AS rn
          FROM employee_order_items eoi
          JOIN emp ON emp.id = eoi.employee_order_id
        ),
        combined AS (
          SELECT l.product_id,
                 ord.delivery_date AS sale_date,
                 l.quantity::int AS qty,
                 (l.line_total
                  + CASE WHEN l.rn = 1 THEN ord.grand_total - l.line_sum ELSE 0 END
                 )::numeric AS amount,
                 round(l.unit_price * (1 + l.gst_percent / 100), 2) AS gross_rate,
                 false AS is_subsidy
          FROM ord_li l
          JOIN ord ON ord.id = l.order_id
          UNION ALL
          SELECT l.product_id,
                 dsale.sale_date,
                 l.quantity::int,
                 (l.line_total
                  + CASE WHEN l.rn = 1 THEN dsale.grand_total - l.line_sum ELSE 0 END
                 )::numeric,
                 round(l.unit_price * (1 + l.gst_percent / 100), 2),
                 dsale.is_subsidy
          FROM dsale_li l
          JOIN dsale ON dsale.id = l.direct_sale_id
          UNION ALL
          SELECT l.product_id,
                 emp.delivery_date,
                 l.quantity::int,
                 (l.line_total
                  + CASE WHEN l.rn = 1 THEN emp.grand_total - l.line_sum ELSE 0 END
                 )::numeric,
                 round(l.unit_price * (1 + l.gst_percent / 100), 2),
                 true AS is_subsidy
          FROM emp_li l
          JOIN emp ON emp.id = l.employee_order_id
        )
        SELECT p.id AS product_id,
               c.is_subsidy                           AS is_subsidy,
               COALESCE(p.report_alias, p.name)
                 || CASE WHEN c.is_subsidy THEN ' (Subsidy)' ELSE '' END AS product_name,
               p.sort_order,
               p.hsn_no,
               -- The rate as it stands in the product master TODAY, not the
               -- snapshot the line was written with.
               p.gst_percent::numeric                 AS gst_percent,
               -- Kept GST-inclusive here because it is the row's identity —
               -- the price-variant key. The basic rate the statement prints
               -- is backed out of it below, at the live rate.
               c.gross_rate                           AS gross_rate,
               to_char(MIN(c.sale_date), 'YYYY-MM-DD') AS first_date,
               SUM(c.qty)::int                        AS qty,
               SUM(c.amount)::numeric                 AS invoice_value
        FROM combined c
        JOIN products p ON p.id = c.product_id
        GROUP BY p.id, p.report_alias, p.name, p.sort_order, p.hsn_no,
                 p.gst_percent, c.is_subsidy, c.gross_rate
        ORDER BY p.sort_order, p.name, c.is_subsidy, MIN(c.sale_date), c.gross_rate
      `;

      // A / B / C per (product, subsidy flag): the subsidised SKU runs its own
      // price history, so a revision on one side never renumbers the other.
      const suffixes = priceVariantSuffixes(
        (rows as any[]).map(r => ({
          groupKey: `${r.product_id}|${r.is_subsidy === true}`,
          rate: parseFloat(r.gross_rate) || 0,
          firstDate: r.first_date ?? "",
        }))
      );

      const mapped = (rows as any[]).map((r, idx) => {
        const invoiceValue = round2(parseFloat(r.invoice_value) || 0);
        const gstPct = round2(parseFloat(r.gst_percent) || 0);
        const grossRate = round2(parseFloat(r.gross_rate) || 0);
        // A GST statement quotes the BASIC rate, so the rate printed is the
        // gross packet rate with the tax taken back out at the live GST rate
        // — the same split the taxable value uses, so Rate x Qty reads back
        // as Taxable rather than as Total. Backing it out beats reading
        // unit_price straight off the line: when the master rate has since
        // been corrected (PD0061 12 → 5), the snapshot unit_price no longer
        // matches the taxable value this statement files.
        const rate = round2(grossRate / (1 + gstPct / 100));
        // Gross in, breakup out — the statement follows the live GST rate.
        const split = splitGstFromGross(invoiceValue, gstPct);
        return {
          sl: idx + 1,
          productId: r.product_id,
          productName:
            r.product_name +
            (suffixes.get(priceVariantKey(`${r.product_id}|${r.is_subsidy === true}`, grossRate)) ?? ""),
          isSubsidy: r.is_subsidy === true,
          hsn: r.hsn_no ?? "",
          qty: Number(r.qty) || 0,
          // Basic (pre-GST) packet rate; Rate x Qty reads back as Taxable,
          // bar the paisa each line's own rounding absorbs.
          rate,
          grossRate,
          gstPct,
          taxableValue: split.basic,
          cgst: split.cgst,
          sgst: split.sgst,
          totalTax: split.tax,
          invoiceValue,
        };
      });

      const totals = mapped.reduce(
        (acc, r) => ({
          qty: acc.qty + r.qty,
          taxableValue: round2(acc.taxableValue + r.taxableValue),
          cgst: round3(acc.cgst + r.cgst),
          sgst: round3(acc.sgst + r.sgst),
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
      //    date range, across BOTH rails — employee_orders (employee subsidy
      //    is a real indent now) and the direct_sales rows it was recorded as
      //    before that change, so a range spanning the switchover still totals
      //    correctly. The outer GROUP BY re-folds an employee who appears in
      //    both, so nobody is listed twice.
      const rows = await pgClient`
        SELECT s.employee_id,
               s.employee_code,
               s.employee_name,
               s.product_id,
               SUM(s.qty)::int             AS qty,
               SUM(s.total_amount)::numeric AS total_amount
        FROM (
          SELECT eo.employee_id            AS employee_id,
                 e.employee_code           AS employee_code,
                 e.name                    AS employee_name,
                 eoi.product_id            AS product_id,
                 eoi.quantity::int         AS qty,
                 eoi.line_total::numeric   AS total_amount
          FROM employee_orders eo
          JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
          JOIN employees e ON e.id = eo.employee_id
          WHERE eo.status <> 'cancelled'
          AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
            AND eo.delivery_date >= ${q.from}::date
            AND eo.delivery_date <= ${q.to}::date
            AND eoi.product_id = ANY(${eligibleIds}::uuid[])
          UNION ALL
          SELECT ds.customer_id, e.employee_code, e.name,
                 dsi.product_id, dsi.quantity::int, dsi.line_total::numeric
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          JOIN employees e ON e.id = ds.customer_id
          WHERE ds.customer_type = 'employee_subsidy'
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
            AND ds.sale_date >= ${q.from}::date
            AND ds.sale_date <= ${q.to}::date
            AND dsi.product_id = ANY(${eligibleIds}::uuid[])
        ) s
        GROUP BY s.employee_id, s.employee_code, s.employee_name, s.product_id
        ORDER BY s.employee_code NULLS LAST, s.employee_name
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
          AND ds.status = 'confirmed'
          AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
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
  //   • TOTAL G/L         → Ltr of every product in the "goodlife milk"
//                         category (qty x pack_size, unit-aware)
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
          SELECT COALESCE(o.route_id, d.route_id) AS route_id, o.delivery_date AS sale_date,
                 oi.product_id, oi.quantity::int AS qty
          FROM orders o
          JOIN dealers d      ON d.id = o.dealer_id
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.delivery_date IN (${prevDate}::date, ${q.date}::date)
            AND o.created_at >= ${prevDate}::date - interval '31 days'
            AND o.created_at <  ${q.date}::date + interval '2 days'
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                             AND dr.id = COALESCE(o.route_id,
                                   (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
          UNION ALL
          SELECT ds.route_id, ds.sale_date, dsi.product_id, dsi.quantity::int AS qty
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date IN (${prevDate}::date, ${q.date}::date)
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
            -- Complimentary VIP samples are given away, not sold, so they
            -- stay out of the milk/curd sales figures.
            AND ds.customer_type::text <> 'vip_sample'
          UNION ALL
          -- Employee subsidy on its own rail since 2026-08-02. Route-less in
          -- practice, so it lands in the ADHOC bucket the same way a
          -- route-less counter sale does.
          SELECT eo.route_id, eo.delivery_date, eoi.product_id, eoi.quantity::int AS qty
          FROM employee_orders eo
          JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
          WHERE eo.delivery_date IN (${prevDate}::date, ${q.date}::date)
            AND eo.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
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

  // ═══════════════════════════════════════════════════════════════
  // Daily Sales Report (MD) — the one-page day summary the MD reads.
  //
  // Nine lines, one per production line, in the order the union's own sheet
  // prints them. It replaces a sheet typed by hand each morning, so it is
  // built to reproduce that sheet exactly rather than to be a general report:
  //
  //   • Rails: dealer indents (orders on their delivery date, confirmed /
  //     dispatched / delivered) plus direct sales, i.e. counter sales and gate
  //     passes on their sale date (status 'confirmed'). Added at the union's
  //     request on 2026-09-15; the hand-typed sheet held indents only.
  //     Two direct-sale types stay out: VIP samples are given away, not sold,
  //     and employee subsidy has lived on employee_orders since 2026-08-02, so
  //     its few legacy direct_sales rows are excluded too, keeping a date
  //     before the switchover consistent with one after it.
  //   • Quantity: packets x pack_size, i.e. the same Ltr / Kg volume every
  //     other report reads, rounded to whole units the way the sheet prints.
  //   • Buckets: product CATEGORY, except peda, which the sheet splits into
  //     Dharwad peda and white peda. 'PEDA DWD%' is the Dharwad line; every
  //     other peda (milk, kesar, elachi, jaggery, sugarfree) files under white
  //     so no peda can go missing from a summary the MD reads.
  //
  //   The indent rail was verified against the union's sheet for 08-08-2026:
  //   all nine lines agree once the two orders cancelled AFTER that morning
  //   (31 L milk, 6 kg curd) are counted back in. Direct sales move the lines
  //   off that sheet on purpose (that day the counter added 10.8 L of UHT).
  //
  // Categories outside the nine lines (flavoured milk, sweets, bakery, cheese,
  // milk powder, shrikhand …) are deliberately absent: this is the union's
  // fixed nine-line format, not a complete sales report.
  // ═══════════════════════════════════════════════════════════════
  app.get(
    "/api/v1/reports/sales-reports/daily-md",
    { preHandler: [adminAuth, requireRole("sales_reports.view")] },
    async (request, reply) => {
      const q = z.object({ date: z.string() }).parse(request.query);

      // The sheet's nine lines, in its own order. `unit` is the label the
      // sheet prints, not a conversion: ghee reads LTRS even though the 15 kg
      // tin is stocked by weight, exactly as the union writes it.
      const LINES = [
        { key: "milk",       label: "TOTAL MILK",        unit: "LTRS" },
        { key: "uht",        label: "TOTAL UHT",         unit: "LTRS" },
        { key: "curd",       label: "TOTAL CURD",        unit: "KGS"  },
        { key: "paneer",     label: "TOTAL PANEER",      unit: "KGS"  },
        { key: "butter",     label: "TOTAL BUTTER",      unit: "KGS"  },
        { key: "ghee",       label: "TOTAL GHEE",        unit: "LTRS" },
        { key: "khova",      label: "TOTAL KHOVA",       unit: "KGS"  },
        { key: "dwd_peda",   label: "TOTAL DWD PEDA",    unit: "KGS"  },
        { key: "white_peda", label: "TOTAL WHITE PEDA",  unit: "KGS"  },
      ];

      const rows = await pgClient`
        WITH sold AS (
          SELECT oi.product_id, oi.quantity
          FROM orders o
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.delivery_date = ${q.date}::date
            -- Partition pruning: orders is partitioned by month, and an order is
            -- always raised within a few days of the day it is delivered.
            AND o.created_at >= ${q.date}::date - interval '31 days'
            AND o.created_at <  ${q.date}::date + interval '2 days'
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            -- The Play Store demo dealer's route never reaches a real report.
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                             AND dr.id = COALESCE(o.route_id,
                                   (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
          UNION ALL
          -- Counter sales and gate passes. Route-less ones count too: this is
          -- a day total, not a route grid.
          SELECT dsi.product_id, dsi.quantity
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date = ${q.date}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
            AND ds.customer_type::text NOT IN ('vip_sample', 'employee_subsidy')
        )
        SELECT CASE
                 WHEN c.name = 'milk'          THEN 'milk'
                 WHEN c.name = 'goodlife milk' THEN 'uht'
                 WHEN c.name = 'curd'          THEN 'curd'
                 WHEN c.name = 'paneer'        THEN 'paneer'
                 WHEN c.name = 'butter'        THEN 'butter'
                 WHEN c.name = 'ghee'          THEN 'ghee'
                 WHEN c.name = 'khova'         THEN 'khova'
                 WHEN c.name = 'peda' AND p.name ILIKE 'PEDA DWD%' THEN 'dwd_peda'
                 WHEN c.name = 'peda'          THEN 'white_peda'
               END AS line_key,
               SUM(s.quantity * COALESCE(p.pack_size, 0))::numeric AS qty
        FROM sold s
        JOIN products p   ON p.id = s.product_id
        JOIN categories c ON c.id = p.category_id
        WHERE c.name IN ('milk', 'goodlife milk', 'curd', 'paneer',
                         'butter', 'ghee', 'khova', 'peda')
        GROUP BY 1
      `;

      const byKey = new Map<string, number>();
      for (const r of rows as any[]) {
        if (r.line_key) byKey.set(r.line_key, parseFloat(r.qty) || 0);
      }

      // Every line is sent whether or not it sold: the sheet is a fixed form,
      // and a missing line reads as "not printed", not as "none today".
      return reply.send({
        date: q.date,
        lines: LINES.map(l => ({ ...l, qty: round3(byKey.get(l.key) ?? 0) })),
      });
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
          SELECT COALESCE(o.route_id, d.route_id) AS route_id, o.delivery_date AS sale_date,
                 oi.product_id, oi.quantity::int AS qty
          FROM orders o
          JOIN dealers d      ON d.id = o.dealer_id
          JOIN order_items oi ON oi.order_id = o.id
          WHERE o.delivery_date >= ${prevMonthStart}::date
            AND o.delivery_date <= ${monthEnd}::date
            AND o.created_at >= ${prevMonthStart}::date - interval '31 days'
            AND o.created_at <  ${monthEnd}::date + interval '2 days'
            AND o.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                             AND dr.id = COALESCE(o.route_id,
                                   (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
          UNION ALL
          SELECT ds.route_id, ds.sale_date, dsi.product_id, dsi.quantity::int AS qty
          FROM direct_sales ds
          JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
          WHERE ds.sale_date >= ${prevMonthStart}::date
            AND ds.sale_date <= ${monthEnd}::date
            AND ds.status = 'confirmed'
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
            -- Complimentary VIP samples are given away, not sold, so they
            -- stay out of the milk/curd sales figures.
            AND ds.customer_type::text <> 'vip_sample'
          UNION ALL
          -- Employee subsidy on its own rail since 2026-08-02; route-less, so
          -- it buckets under ADHOC like the counter sales above.
          SELECT eo.route_id, eo.delivery_date, eoi.product_id, eoi.quantity::int AS qty
          FROM employee_orders eo
          JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
          WHERE eo.delivery_date >= ${prevMonthStart}::date
            AND eo.delivery_date <= ${monthEnd}::date
            AND eo.status IN ('confirmed', 'dispatched', 'delivered')
            AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
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
// Exported so diagnostics can exercise the grid without a session, the same
// way loadStatement is in finance-dealer-statements.ts.
export async function buildSalesGrid(opts: {
  q: { from: string; to: string };
  cfg: ReportConfig;
  /** Which side of the cash / credit split to build. B4 Cash Sales pins this
   *  to "cash"; B6 Sales Register lets the caller pick. */
  saleType: SaleType;
  /** B4 only. Restricts the direct-sales rail to the payment modes where
   *  money actually changed hands (system_settings reports.cash_payment_modes,
   *  default cash / upi / wallet), so a gate pass taken on credit stays off a
   *  report titled Cash Sales. Never applied to dealer orders: 'credit' there
   *  marks a wallet balance the dealer already funded, which IS cash to the
   *  union — see the note on the day/route report. */
  collectedModesOnly?: boolean;
}) {
  const { q, cfg, saleType, collectedModesOnly = false } = opts;
  const { wantCash, wantCredit } = saleTypeBuckets(saleType);

  const products = await pgClient`
    SELECT p.id, p.report_alias, p.name, p.sort_order,
           COALESCE(p.pack_size, 0)::numeric AS pack_size, p.unit,
           c.name AS category_name
    FROM products p
    JOIN categories c ON c.id = p.category_id
    WHERE p.deleted_at IS NULL AND p.available = true
    ORDER BY p.sort_order, p.name
  `;

  // Every route, not only the live ones. A current route always gets a column
  // (even at zero, so the grid keeps its shape); a retired or deleted one is
  // kept only if it actually sold inside the range — see the filter below.
  //
  // Selecting active routes here used to drop that money without a trace:
  // `apply` finds no bucket for a route with no column and silently discards
  // the row, so retiring a route erased its history from this report. Route
  // R17 (retired, still delivering) took ₹2,91,225.05 of July-August 2026 out
  // of the register that way.
  const allRoutes = await pgClient`
    SELECT r.id, r.code, r.name, ct.name AS contractor_name,
           (r.deleted_at IS NULL AND r.active = true) AS is_current
    FROM routes r
    LEFT JOIN contractors ct ON ct.id = r.contractor_id AND ct.deleted_at IS NULL
    WHERE r.code <> 'DEMO'
    ORDER BY (r.deleted_at IS NOT NULL), r.code
  `;

  // Applied to the direct-sales rail only (see collectedModesOnly above).
  const cashModes = cfg.cashPaymentModes;
  const directModeFilter = collectedModesOnly ? cashModes : null;

  // Per (route, product) qty + amount from orders. A dealer with no route at
  // all buckets under the ADHOC sentinel; on Cash Sales, which builds no ADHOC
  // column, such a row is discarded by `apply` exactly as it was before.
  const rowsOrders = await pgClient`
    WITH ord AS (
      SELECT o.id,
             COALESCE(o.route_id, d.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
             o.grand_total
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
      WHERE o.delivery_date >= ${q.from}::date
      AND o.delivery_date <= ${q.to}::date
      AND o.created_at >= ${q.from}::date - interval '31 days'
      AND o.created_at <  ${q.to}::date + interval '2 days'
      AND o.status IN ('confirmed', 'dispatched', 'delivered')
      AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                       AND dr.id = COALESCE(o.route_id,
                             (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
      -- Cash / credit split. Credit supply is a credit institution that has
      -- NOT paid at checkout; one that paid up front by UPI is settled money
      -- and files on the cash side. Canonical rule: lib/credit-check.ts.
      AND ( (${wantCash}::boolean   AND NOT (COALESCE(d.customer_type::text, '') LIKE 'Credit Inst%'
                                             AND o.payment_mode::text <> 'upi'))
         OR (${wantCredit}::boolean AND     (COALESCE(d.customer_type::text, '') LIKE 'Credit Inst%'
                                             AND o.payment_mode::text <> 'upi')) )
    ),
    li AS (
      SELECT oi.order_id, oi.product_id, oi.quantity, oi.line_total,
             SUM(oi.line_total) OVER (PARTITION BY oi.order_id) AS line_sum,
             ROW_NUMBER() OVER (PARTITION BY oi.order_id
                                ORDER BY oi.line_total DESC, oi.product_id) AS rn
      FROM order_items oi
      JOIN ord ON ord.id = oi.order_id
    )
    SELECT ord.route_id, li.product_id, c.name AS category_name,
           SUM(li.quantity)::int AS qty,
           SUM(li.line_total
               + CASE WHEN li.rn = 1 THEN ord.grand_total - li.line_sum ELSE 0 END
              )::numeric AS amount
    FROM li
    JOIN ord ON ord.id = li.order_id
    JOIN products p ON p.id = li.product_id
    JOIN categories c ON c.id = p.category_id
    GROUP BY 1, li.product_id, c.name
  `;

  // Per (route, product) from direct sales.
  //
  // Cash Sales used to skip this rail entirely, which is how a report named
  // for counter money ended up holding none of it.
  //
  // Route-less counter sales used to be dropped here by a `route_id IS NOT
  // NULL` filter. Gate passes and counter sales are raised at the plant and
  // usually name no route, so that filter removed nearly the entire rail from
  // the register: 12 of the 13 direct sales in July-August 2026 carry no
  // route. They now bucket under the ADHOC sentinel, the same one the Route
  // Sheet and Dispatch Sheet already print these goods on.
  //
  // Side of the split, two ways onto the credit side:
  //   • the employee ghee subsidy, which debits employee_ledger against the
  //     employee's credit limit and is recovered from salary. The subsidy
  //     sold before 2026-08-02 still lives on this rail, so it is routed to
  //     the credit side here to match the employee_orders arm below —
  //     otherwise a range spanning that switchover would file the same
  //     subsidy as cash on one side of the date and credit on the other.
  //   • a gate pass rung up on 'credit', which is a genuine receivable. On
  //     this rail payment_mode IS the answer (unlike the orders rail, where
  //     'credit' marks wallet money the dealer already funded). Before this
  //     the register filed those passes as cash sales.
  // Everything else — counter cash, UPI, and a wallet pass drawn against a
  // prepaid balance — is money the union holds, so it stays on the cash side.
  const rowsDirect = await pgClient`
    WITH ds AS (
      SELECT ds.id,
             COALESCE(ds.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
             ds.grand_total
      FROM direct_sales ds
      WHERE ds.sale_date >= ${q.from}::date
      AND ds.sale_date <= ${q.to}::date
      AND ds.status = 'confirmed'
      AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
      -- Complimentary VIP samples are given away, not sold, so they stay out
      -- of the register. They carry real packet counts but bill ₹0, which
      -- inflated every quantity column against an unchanged amount. They are
      -- reported on B11 VIP Sales instead. (Cash Sales never saw them: their
      -- 'complimentary' mode is not a collected mode.)
      AND ds.customer_type::text <> 'vip_sample'
      AND (${directModeFilter}::text[] IS NULL
           OR ds.payment_mode::text = ANY(${directModeFilter ?? cashModes}::text[]))
      AND ( (${wantCash}::boolean   AND NOT (ds.customer_type::text = 'employee_subsidy'
                                             OR ds.payment_mode::text = 'credit'))
         OR (${wantCredit}::boolean AND     (ds.customer_type::text = 'employee_subsidy'
                                             OR ds.payment_mode::text = 'credit')) )
    ),
    li AS (
      SELECT dsi.direct_sale_id, dsi.product_id, dsi.quantity, dsi.line_total,
             SUM(dsi.line_total) OVER (PARTITION BY dsi.direct_sale_id) AS line_sum,
             ROW_NUMBER() OVER (PARTITION BY dsi.direct_sale_id
                                ORDER BY dsi.line_total DESC, dsi.product_id) AS rn
      FROM direct_sale_items dsi
      JOIN ds ON ds.id = dsi.direct_sale_id
    )
    SELECT ds.route_id, li.product_id, c.name AS category_name,
           SUM(li.quantity)::int AS qty,
           SUM(li.line_total
               + CASE WHEN li.rn = 1 THEN ds.grand_total - li.line_sum ELSE 0 END
              )::numeric AS amount
    FROM li
    JOIN ds ON ds.id = li.direct_sale_id
    JOIN products p ON p.id = li.product_id
    JOIN categories c ON c.id = p.category_id
    GROUP BY 1, li.product_id, c.name
  `;

  // Employee subsidy on its current rail (a real indent since 2026-08-02).
  // Credit side, so it never reaches Cash Sales (which asks for "cash" only),
  // and route-less in practice — subsidy ghee is collected at the plant
  // counter and never rides a vehicle — so it lands in ADHOC too.
  const rowsEmployee = wantCredit ? await pgClient`
    WITH eo AS (
      SELECT eo.id,
             COALESCE(eo.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
             eo.grand_total
      FROM employee_orders eo
      WHERE eo.delivery_date >= ${q.from}::date
        AND eo.delivery_date <= ${q.to}::date
        AND eo.status IN ('confirmed', 'dispatched', 'delivered')
        AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
    ),
    li AS (
      SELECT eoi.employee_order_id, eoi.product_id, eoi.quantity, eoi.line_total,
             SUM(eoi.line_total) OVER (PARTITION BY eoi.employee_order_id) AS line_sum,
             ROW_NUMBER() OVER (PARTITION BY eoi.employee_order_id
                                ORDER BY eoi.line_total DESC, eoi.product_id) AS rn
      FROM employee_order_items eoi
      JOIN eo ON eo.id = eoi.employee_order_id
    )
    SELECT eo.route_id, li.product_id, c.name AS category_name,
           SUM(li.quantity)::int AS qty,
           SUM(li.line_total
               + CASE WHEN li.rn = 1 THEN eo.grand_total - li.line_sum ELSE 0 END
              )::numeric AS amount
    FROM li
    JOIN eo ON eo.id = li.employee_order_id
    JOIN products p ON p.id = li.product_id
    JOIN categories c ON c.id = p.category_id
    GROUP BY 1, li.product_id, c.name
  ` : [];

  // ── Integrity check: the same money, counted a second way ──
  //
  // Every amount this report prints is already a COLLECTED amount: each of the
  // three queries above anchors its lines on the document total (see the note
  // on `apply`). These queries add those document totals up directly, without
  // touching the item tables, so `total` and `collected` must come out equal.
  // They are not displayed; they exist so a drift can be caught rather than
  // printed. The one case that can separate them is a document with no line
  // rows at all, which has nowhere to carry its total.
  //
  // Summed WITHOUT joining the item tables - joining would multiply each
  // document total by its line count. Filters are otherwise identical to the
  // line queries above; if you edit one, edit its partner.
  const docsOrders = await pgClient`
    SELECT COALESCE(o.route_id, d.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
           SUM(o.grand_total)::numeric AS amount
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    WHERE o.delivery_date >= ${q.from}::date
      AND o.delivery_date <= ${q.to}::date
      AND o.created_at >= ${q.from}::date - interval '31 days'
      AND o.created_at <  ${q.to}::date + interval '2 days'
      AND o.status IN ('confirmed', 'dispatched', 'delivered')
      AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                       AND dr.id = COALESCE(o.route_id,
                             (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
      AND ( (${wantCash}::boolean   AND NOT (COALESCE(d.customer_type::text, '') LIKE 'Credit Inst%'
                                             AND o.payment_mode::text <> 'upi'))
         OR (${wantCredit}::boolean AND     (COALESCE(d.customer_type::text, '') LIKE 'Credit Inst%'
                                             AND o.payment_mode::text <> 'upi')) )
    GROUP BY 1
  `;

  const docsDirect = await pgClient`
    SELECT COALESCE(ds.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
           SUM(ds.grand_total)::numeric AS amount
    FROM direct_sales ds
    WHERE ds.sale_date >= ${q.from}::date
      AND ds.sale_date <= ${q.to}::date
      AND ds.status = 'confirmed'
      AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
      AND ds.customer_type::text <> 'vip_sample'
      AND (${directModeFilter}::text[] IS NULL
           OR ds.payment_mode::text = ANY(${directModeFilter ?? cashModes}::text[]))
      AND ( (${wantCash}::boolean   AND NOT (ds.customer_type::text = 'employee_subsidy'
                                             OR ds.payment_mode::text = 'credit'))
         OR (${wantCredit}::boolean AND     (ds.customer_type::text = 'employee_subsidy'
                                             OR ds.payment_mode::text = 'credit')) )
    GROUP BY 1
  `;

  const docsEmployee = wantCredit ? await pgClient`
    SELECT COALESCE(eo.route_id, ${ADHOC_ROUTE_ID}::uuid) AS route_id,
           SUM(eo.grand_total)::numeric AS amount
    FROM employee_orders eo
    WHERE eo.delivery_date >= ${q.from}::date
      AND eo.delivery_date <= ${q.to}::date
      AND eo.status IN ('confirmed', 'dispatched', 'delivered')
      AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = eo.route_id)
    GROUP BY 1
  ` : [];

  // Case-insensitive: config uses capitalized names, DB stores lowercase.
  const milkCatSet = new Set(cfg.milkCategoryGroup.map(c => c.toLowerCase()));

  const blankAgg = (id: string, code: string, name: string, contractorName: string | null) => ({
    id, code, name, contractorName,
    qty: Object.fromEntries((products as any[]).map(p => [p.id, 0])),
    amount: Object.fromEntries((products as any[]).map(p => [p.id, 0])),
    milkAmount: 0,
    productAmount: 0,
    total: 0,
    /** Sum of the DOCUMENT totals (grand_total) for this route. */
    collected: 0,
  });

  // Which routes get a column: the current ones always, plus any retired or
  // deleted route that actually sold in this range.
  const soldRouteIds = new Set<string>();
  for (const rows of [rowsOrders, rowsDirect, rowsEmployee]) {
    for (const r of rows as any[]) soldRouteIds.add(r.route_id);
  }

  const routeAgg = new Map<string, any>();
  for (const r of allRoutes as any[]) {
    if (!r.is_current && !soldRouteIds.has(r.id)) continue;
    routeAgg.set(r.id, blankAgg(r.id, displayRouteCode(r.code), r.name, r.contractor_name ?? null));
  }

  // The ADHOC column, added only when route-less goods actually moved in the
  // range so the grid does not carry a dead column on an ordinary day. It has
  // no contractor: nobody hauls it, the buyer collects at the plant.
  if (soldRouteIds.has(ADHOC_ROUTE_ID)) {
    routeAgg.set(ADHOC_ROUTE_ID, blankAgg(ADHOC_ROUTE_ID, "ADHOC", "Adhoc (no route)", null));
  }

  // Amounts arriving here are collected amounts. Each document's rounding
  // residue (grand_total minus the sum of its stored line_totals) was added to
  // its largest line by the queries above, so a route's Milk + Product add up
  // to exactly what its dealers were charged. Pre-2026-09-07 orders stored
  // line_total rounded per line while grand_total was summed from the
  // UNROUNDED lines, which is what made the residue: Rs 6.09 across August
  // 2026. For anything sold after lib/line-totals.ts the residue is zero and
  // the allocation is a no-op.
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
  for (const r of rowsEmployee as any[]) apply(r);

  // A document whose route has no column (Cash Sales builds no ADHOC one) is
  // discarded here exactly as its lines are by `apply`, so the two rows stay
  // comparable.
  const applyDoc = (row: any) => {
    const agg = routeAgg.get(row.route_id);
    if (!agg) return;
    agg.collected = round2(agg.collected + (parseFloat(row.amount) || 0));
  };
  for (const r of docsOrders as any[]) applyDoc(r);
  for (const r of docsDirect as any[]) applyDoc(r);
  for (const r of docsEmployee as any[]) applyDoc(r);

  const routesOut = Array.from(routeAgg.values());

  // Grand totals
  const totals = {
    qty: Object.fromEntries((products as any[]).map(p => [p.id, routesOut.reduce((s, r) => s + (r.qty[p.id] ?? 0), 0)])),
    amount: Object.fromEntries((products as any[]).map(p => [p.id, round2(routesOut.reduce((s, r) => s + (r.amount[p.id] ?? 0), 0))])),
    milkAmount: round2(routesOut.reduce((s, r) => s + r.milkAmount, 0)),
    productAmount: round2(routesOut.reduce((s, r) => s + r.productAmount, 0)),
    total: round2(routesOut.reduce((s, r) => s + r.total, 0)),
    collected: round2(routesOut.reduce((s, r) => s + r.collected, 0)),
  };

  return {
    from: q.from,
    to: q.to,
    products: (products as any[]).map(p => ({
      id: p.id,
      reportAlias: p.report_alias ?? p.name,
      sortOrder: p.sort_order,
      packSize: parseFloat(p.pack_size) || 0,
      unit: p.unit ?? "",
    })),
    routes: routesOut,
    totals,
  };
}

// ════════════════════════════════════════════════════════════════════
// Shared "MILK & CURD SALES REPORT" cross-tab builder.
//
// Both the Daily and Monthly Sales Reports render the same route × product
// cross-tab (Night / Afternoon groups, a previous-period comparison + diff,
// milk / curd / Good Life totals and a grand "HVR TOTAL"). They differ only in the
// period each sale falls into, so callers pre-tag every (route, product) sales
// row as 'cur' (selected period) or 'prev' (comparison period) and this helper
// produces the identical { columns, groups, total } payload.
// ════════════════════════════════════════════════════════════════════
async function buildMilkCurdCrossTab(
  salesRows: Array<{ route_id: string | null; period: string; product_id: string; qty: number | string }>,
) {
  // ── 1. Products: resolve the fixed columns + the Good Life milk set ──
  const products = await pgClient`
    SELECT p.id, p.code, p.name, p.report_alias,
           COALESCE(p.pack_size, 0)::numeric AS pack_size, p.unit,
           c.name AS category_name
    FROM products p
    LEFT JOIN categories c ON c.id = p.category_id
    WHERE p.deleted_at IS NULL
  `;
  const prodById = new Map((products as any[]).map(p => [p.id, p]));

  // Loose key: uppercase + strip every non-alphanumeric char, so
  // "HTM 1000ML" / "HTM-1000ML" / "htm1000ml" all collapse to the same
  // token. Makes column matching resilient to spacing/punctuation drift.
  const norm = (s: unknown) => String(s ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");

  // TOTAL G/L set: the "goodlife milk" product CATEGORY, in Ltr. Keyed on the
  // category and not on a "G/L " name prefix, because that prefix also carries
  // the Good Life bakery lines (G/L CREAMBUN 50GM, a kg item) which have no
  // business inside a litre total. Each member's Ltr-per-packet factor comes
  // from its own pack_size + unit, exactly like the fixed columns.
  const glPerPack = new Map<string, number>();
  // Separate indexes so an authoritative code/name never loses to a
  // (often messy) report_alias collision.
  const byCode = new Map<string, string>();
  const byName = new Map<string, string>();
  const byAlias = new Map<string, string>();

  for (const p of products as any[]) {
    if (norm(p.category_name) === "GOODLIFEMILK") {
      glPerPack.set(p.id, toKgLtr(1, parseFloat(p.pack_size) || 0, p.unit ?? ""));
    }
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

  // ── 2. Routes + their session (Night / Afternoon) ──
  //     which_batch comes from the route's primary batch; if it has none
  //     set, fall back to any batch linked via batch_routes.
  //
  //     Every route, not only the live ones. A current route always gets a
  //     row (even at zero, so the sheet keeps its shape); a retired or deleted
  //     one is kept only when it actually sold in one of the two periods — see
  //     the filter where the rows are built. Selecting live routes here used to
  //     erase history: the accumulator below finds no bucket for a route with
  //     no row and silently drops the sale, so the day a route was deleted its
  //     sales vanished from this report for EVERY past date, including the
  //     dates it really did deliver on.
  const routes = await pgClient`
    SELECT r.id, r.code, r.name,
           (r.deleted_at IS NULL AND r.active = true) AS is_current,
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
    WHERE r.code <> 'DEMO'
    ORDER BY (r.deleted_at IS NOT NULL), r.code
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
    totalGL: number;                   // selected-period Good Life milk, Ltr
  };
  const newAcc = (): Acc => ({ qty: 0, prevQty: 0, cols: {}, prevCols: {}, totalGL: 0 });
  const accByRoute = new Map<string, Acc>();
  for (const r of routes as any[]) accByRoute.set(r.id, newAcc());
  const adhocAcc = newAcc();

  for (const row of salesRows) {
    const acc = row.route_id == null ? adhocAcc : accByRoute.get(row.route_id);
    if (!acc) continue; // route row missing from the masters entirely
    const qty = Number(row.qty) || 0;
    const colKey = colKeyByProductId.get(row.product_id);

    if (row.period === "cur") {
      acc.qty += qty;
      if (colKey) acc.cols[colKey] = (acc.cols[colKey] ?? 0) + qty;
      const glPer = glPerPack.get(row.product_id);
      if (glPer !== undefined) acc.totalGL += qty * glPer;
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
    totalGL: round1(acc.totalGL),          // Ltr
  });
  type DSRRow = ReturnType<typeof mkRow>;

  const hasData = (a: Acc) =>
    Boolean(a.qty || a.prevQty || a.totalGL ||
      Object.keys(a.cols).length > 0 || Object.keys(a.prevCols).length > 0);

  const nightRows: DSRRow[] = [];
  const afternoonRows: DSRRow[] = [];
  for (const r of routes as any[]) {
    const acc = accByRoute.get(r.id)!;
    // A route that is retired or deleted keeps its row for as long as it has
    // sales in the period — its history belongs to the date, not to whether
    // the route still runs today. It only drops off once it is empty.
    if (!r.is_current && !hasData(acc)) continue;
    const row = mkRow(r.id, displayRouteCode(r.code), r.name, acc);
    (sessionOf(r.which_batch) === "night" ? nightRows : afternoonRows).push(row);
  }
  // ADHOC row — only when it carries data (night group, like the sheet).
  if (hasData(adhocAcc)) nightRows.push(mkRow(null, "", "ADHOC SALES", adhocAcc));

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
      totalGL: round1(rows.reduce((s, r) => s + r.totalGL, 0)),
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

// ── Price variants: one line per price, tagged → A, → B, → C … ────────
//
// A product's dealer price or MRP can be revised mid-period. Folding the
// sales either side of the revision into one line invents an average rate
// that was never charged, so every report that prints a per-product rate
// splits on the price instead and tags the versions → A, → B, → C … oldest
// first, the arrow marking where the SKU name ends.
// A product that held ONE price all period gets no letter: the tag only
// appears where there is something to tell apart.
//
// Lines group on the GROSS (GST-inclusive) rate the packet was BILLED at:
// unit_price x (1 + the line's OWN gst_percent), rounded to the paisa. Two
// details in that definition are load-bearing:
//
//   • It reads the line's gst snapshot, not the product master. So editing
//     products.gst_percent re-splits a past sale between basic and tax (see
//     splitGstFromGross) without moving any line's price key — a GST
//     correction can never spawn a second price row.
//   • It is derived per PACKET, never as line_total / quantity. line_total is
//     rounded once for the whole line, so dividing it back carries a drift
//     that depends on the quantity: on Jul–Aug 2026 it invented price
//     revisions for 24 extra SKUs, splitting COOKIES 20GM across ₹267.85 /
//     ₹267.86 / ₹267.87 and every 50GM CREAMBUN across ₹9.10 / ₹9.11.
//
// It also collapses the nets that differ only in a third decimal (base_price
// was derived at 3dp until 2026-08-22, so COOKIES 20GM sits at both 255.100
// and 255.105): both are the same ₹267.86 packet and must print as one line.
//
// Letters are assigned across the WHOLE report run, not per customer, so
// "HTM 1000ML → B" names the same rate on every page of every sheet, and the
// GST Statement, the Credit Sales bill and Agent Sales agree on which
// version is which.

/** A, B … Z, AA, AB … — spreadsheet-column order, so a 27th price still reads. */
function variantLetter(index: number): string {
  let n = index;
  let s = "";
  do {
    s = String.fromCharCode(65 + (n % 26)) + s;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return s;
}

/** Lookup key for one (thing being tagged, price) pair. */
function priceVariantKey(groupKey: string, rate: number): string {
  return `${groupKey}|${round2(rate).toFixed(2)}`;
}

/**
 * groupKey → each price it sold at → " → A" / " → B" / …, oldest first.
 * The arrow keeps the tag off the product name: "GHEE SACHET 200ML → B"
 * cannot be misread as a SKU called "200ML B".
 * A group that only ever held one price maps to nothing, so callers can
 * append `suffixes.get(key) ?? ""` unconditionally.
 */
function priceVariantSuffixes(
  rows: Array<{ groupKey: string; rate: number; firstDate: string }>
): Map<string, string> {
  const byGroup = new Map<string, Array<{ rate: number; firstDate: string }>>();
  for (const r of rows) {
    const rate = round2(r.rate);
    const list = byGroup.get(r.groupKey);
    if (!list) {
      byGroup.set(r.groupKey, [{ rate, firstDate: r.firstDate }]);
      continue;
    }
    const seen = list.find(x => x.rate === rate);
    if (!seen) list.push({ rate, firstDate: r.firstDate });
    else if (r.firstDate < seen.firstDate) seen.firstDate = r.firstDate;
  }

  const out = new Map<string, string>();
  for (const [groupKey, list] of byGroup) {
    if (list.length < 2) continue;
    // Oldest price first. A same-day pair (a correction typed the same
    // morning) falls back to the cheaper rate, so the order is deterministic.
    list.sort((a, b) => a.firstDate.localeCompare(b.firstDate) || a.rate - b.rate);
    list.forEach((v, i) =>
      out.set(priceVariantKey(groupKey, v.rate), ` → ${variantLetter(i)}`));
  }
  return out;
}

// ── The GST rate is read live; the gross is frozen ────────────────────
/**
 * Split a GROSS (GST-inclusive) amount into basic + CGST + SGST at `gstPct`.
 *
 * The gross is the invariant. It is what the dealer was billed, what the
 * money rails posted and what every total on every report foots to, and no
 * later edit to products.gst_percent may move it. Correcting a rate only
 * moves the line BETWEEN basic and tax — which is why reports derive the
 * breakup here from products.gst_percent as it stands today, rather than
 * reading the per-line gst_amount / gst_percent snapshot written when the
 * order was placed. Fixing a wrong rate in the product master therefore
 * fixes the whole history at once (it used to need a repair script).
 *
 * CGST and SGST are levied at the same rate on the same taxable value, so
 * they are always EQUAL: basic is the gross backed out at the full rate and
 * rounded to the paisa, and the tax left over is halved EXACTLY. An odd
 * paisa of tax therefore prints as a half-paisa on each side (258.91 →
 * 129.455 + 129.455), which is why CGST / SGST carry three decimals and
 * every other figure two. basic + cgst + sgst == amount exactly, and the
 * CGST and SGST columns always foot to the same total. (It used to round
 * each half to the paisa and hand the odd paisa to CGST — 129.46 / 129.45 —
 * or, through float error, to SGST.)
 *
 * All arithmetic is in integer paise, so no half-paisa is lost to float.
 */
function splitGstFromGross(amount: number, gstPct: number) {
  const grossP = Math.round((Number(amount) || 0) * 100);
  const sign   = grossP < 0 ? -1 : 1;
  const absP   = Math.abs(grossP);
  // Rate in hundredths of a percent (5% → 500), so 2.5% etc. stay exact.
  const rateH  = Math.round((Number(gstPct) || 0) * 100);
  // basic = gross / (1 + rate), rounded half-up to the paisa.
  const num    = absP * 10000;
  const den    = 10000 + rateH;
  const basicP = Math.floor((2 * num + den) / (2 * den));
  const taxP   = absP - basicP;
  const basic  = (sign * basicP) / 100;
  const tax    = (sign * taxP) / 100;
  // Half of a whole number of paise: exact to the third decimal.
  const cgst   = (sign * taxP) / 200;
  return { basic, cgst, sgst: cgst, tax };
}

function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function round1(n: number): number {
  return Math.round((Number(n) || 0) * 10) / 10;
}

/** Litres and kilos, where a third decimal is real (0.140 kg), and CGST /
 *  SGST, which are half a whole number of paise (see splitGstFromGross).
 *  No other money uses this: prices and amounts are rupees and paise. */
function round3(n: number): number {
  return Math.round((Number(n) || 0) * 1000) / 1000;
}