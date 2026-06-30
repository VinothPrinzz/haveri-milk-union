// apps/web/src/pages/reports/RouteSheetPage.tsx
// ════════════════════════════════════════════════════════════════════
// Route Sheet — full replacement (per-page letterhead, 3-page split).
//
// Per route we emit:
//   • N customer-rows pages (≤ ROWS_PER_PAGE each), final page carries
//     the route TOTAL row and a "Total Crates" row below it (for the
//     9 across products), showing crates ± leftover packets.
//   • 1 abstract page  → Route Sheet Abstract table + ₹ summary line.
//                         Qty (Kg/Ltr) column shows values divided by
//                         1000 so pack_size in ml/g converts correctly.
//   • 1 security page  → Despatch Summary For Security checklist with
//                         "Crates Out" (prefilled total) and
//                         "Crates In"  (blank fill-line for security).
//
// Fixes applied vs previous version:
//   1. acrossProducts sorted by fixed product-code order:
//        HTM-1000ML → HTM-500ML → HCM-500ML → SHBM 1000ML → SHBM 500ML
//        → SHBM 200ML → SAMRUDHI 500ML → CURD 200GM → CURD 500GM
//   2. Total Crates row added on page 1 below the TOTAL row (same styling
//        as TOTAL row), showing crates+pkts or crates-pkts per column.
//   3. Qty (Kg/Ltr) on page 2 uses computeKgLtr() which inspects the unit
//        text: pack_size is in ml/g for liquid/solid small packs (÷1000),
//        but already in Kg/Ltr for large bulk packs like 5KG, 10KG (×1).
//        Root cause: migration 0006 seeds pack_size by extracting the leading
//        number from the unit text — "500ml Pouch" → 500 (ml), "5KG" → 5 (Kg).
//   4. Security page: Crates Out (prefilled) and Crates In (blank).
// ════════════════════════════════════════════════════════════════════
import { useState, useMemo, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { fmtNum, fmtINR, fmtDate } from "@/components/PageHeader";
import ReportShell, { type Exporter } from "@/components/ReportShell";
import { fetchBatches } from "@/services/api";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { fetchRoutes } from "@/services/api";
import {
  fetchRouteSheet,
  type RouteSheetResponse,
  type RouteSheetRoute,
  type RouteSheetAcrossProduct,
} from "@/services/report";
import { toCsv } from "@/lib/exporters";

// ── Fixed display order for the 9 across-product columns ──────────
// Products are matched by their `code` field (case-insensitive).
// Any product whose code is NOT in this list is appended at the end
// in its original sort_order so we never silently drop data.
const ACROSS_CODE_ORDER = [
  "HTM-1000ML",
  "HTM-500ML",
  "HCM-500ML",
  "SHBM 1000ML",
  "SHBM 500ML",
  "SHBM 200ML",
  "SAMRUDHI 500ML",
  "CURD 200GM",
  "CURD 500GM",
];

function sortAcrossProducts(products: RouteSheetAcrossProduct[]): RouteSheetAcrossProduct[] {
  const orderMap = new Map(
    ACROSS_CODE_ORDER.map((code, idx) => [code.toUpperCase(), idx])
  );
  return [...products].sort((a, b) => {
    const ai = orderMap.get(a.code.toUpperCase()) ?? ACROSS_CODE_ORDER.length;
    const bi = orderMap.get(b.code.toUpperCase()) ?? ACROSS_CODE_ORDER.length;
    return ai - bi;
  });
}

// ── Helper: format crates ± leftover packets ───────────────────────
// Returns "2+6", "1-3", "4", or "" (if 0 crates and 0 packets).
function fmtCratePkts(crates: number, pktPlus: number, pktMinus: number): string {
  if (crates === 0 && pktPlus === 0 && pktMinus === 0) return "";
  if (pktPlus > 0) return `${crates}+${pktPlus}`;
  if (pktMinus > 0) return `${crates}-${pktMinus}`;
  return `${crates}`;
}

// ── Helper: convert packets × pack_size → Kg or Ltr ───────────────
// Root cause (migration 0006): pack_size is seeded by extracting the
// leading number from the product unit text:
//   "500ml Pouch"  → pack_size=500 (ml  → ÷1000 → Ltr)
//   "200g Block"   → pack_size=200 (g   → ÷1000 → Kg)
//   "5KG Bucket"   → pack_size=5   (Kg  → ×1, no division)
//   "10KG Bucket"  → pack_size=10  (Kg  → ×1, no division)
//   "1Ltr Pouch"   → pack_size=1   (Ltr → ×1, no division)
// We detect macro-unit products by scanning the unit string for "kg"
// or "ltr/litre/liter" keywords (case-insensitive).
function computeKgLtr(packets: number, packSize: number, unit: string, alias = ""): number {
  // Primary: read the per-pack size from the product name (alias) when it
  // carries an explicit size token — e.g. "HTM 1000ML" → 1 L/pack,
  // "HTM 500ML" → 0.5 L/pack, "100 GM" → 0.1 Kg/pack. This is the source of
  // truth because products.pack_size is stored inconsistently (ml/g for some
  // products, already Kg/Ltr for others such as HTM). ml/g convert ÷1000;
  // Kg/Ltr/L are used as-is.
  const m = alias.match(/(\d+(?:\.\d+)?)\s*(kg|kilogram|ltr|litre|liter|ml|gm|g|l)\b/i);
  if (m) {
    const size = parseFloat(m[1]);
    const tok = m[2].toLowerCase();
    const perPack = (tok === "ml" || tok === "g" || tok === "gm") ? size / 1000 : size;
    return packets * perPack;
  }
  // Legacy fallback: pack_size with unit-keyword macro detection.
  //   "500ml Pouch" → 500 (÷1000)   "5KG Bucket" → 5 (×1)   "1Ltr Pouch" → 1 (×1)
  // NOTE: no \b before "kg" — "5KG" has no whitespace between digit and K.
  const u = unit.toLowerCase();
  const alreadyMacro = /kg/.test(u) || /ltr|litre|liter/.test(u);
  return alreadyMacro ? packets * packSize : packets * packSize / 1000;
}

// 13 dealer rows per A4 landscape page.
const ROWS_PER_PAGE = 13;

export default function RouteSheetPage() {
  const today = new Date().toISOString().split("T")[0];
  const [batch, setBatch] = useState<string>("");
  const [date, setDate] = useState<string>(today);
  const [routeId, setRouteId]   = useState<string | null>(null);
  const [generated, setGenerated] = useState(false);

  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });
  const { data: routes  = [] } = useQuery({ queryKey: ["routes"],  queryFn: fetchRoutes  });

  // ── F9 option list for routes ──────────────────────────────────
  const routeOptions: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );

  const { data, isLoading, refetch } = useQuery<RouteSheetResponse>({
    queryKey: ["route-sheet", date, batch, routeId],   // ← routeId added
    queryFn: () => fetchRouteSheet({
      date,
      batchId:  batch   || undefined,
      routeId:  routeId || undefined,                  // ← NEW
    }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  // Filter out blank routes; renumber dealer Sl just in case.
  const routesWithData: RouteSheetRoute[] = (data?.routes ?? [])
    .map(r => {
      const active = r.customers.filter(c =>
        Object.values(c.acrossQty).some(q => q > 0) || c.othersQty > 0
      );
      return { ...r, customers: active.map((c, i) => ({ ...c, sl: i + 1 })) };
    })
    .filter(r => r.customers.length > 0);

  // Only render across columns that have at least one nonzero entry
  // anywhere in the dataset. Then apply the fixed sort order.
  const usedIds = new Set<string>();
  routesWithData.forEach(r => r.customers.forEach(c => {
    Object.entries(c.acrossQty).forEach(([pid, q]) => { if (q > 0) usedIds.add(pid); });
  }));
  const acrossProducts = sortAcrossProducts(
    (data?.acrossProducts ?? []).filter(p => usedIds.has(p.id))
  );

  // ── Build pages: per route → N row-pages + abstract page + security page ──
  const pages: ReactNode[] = [];
  const pageLabels: string[] = [];

  routesWithData.forEach(route => {
    const chunks: typeof route.customers[] = [];
    for (let i = 0; i < route.customers.length; i += ROWS_PER_PAGE) {
      chunks.push(route.customers.slice(i, i + ROWS_PER_PAGE));
    }
    chunks.forEach((rows, idx) => {
      const isLast = idx === chunks.length - 1;
      pages.push(
        <RouteRowsPage
          key={`${route.id}-rows-${idx}`}
          data={data!}
          acrossProducts={acrossProducts}
          route={route}
          rows={rows}
          showTotal={isLast}
          pageNum={idx + 1}
          pageCount={chunks.length}
        />
      );
      pageLabels.push(
        chunks.length > 1
          ? `${route.name} — Sheet ${idx + 1}/${chunks.length}`
          : `${route.name}`
      );
    });
    pages.push(
      <AbstractPage
        key={`${route.id}-abstract`}
        data={data!}
        route={route}
      />
    );
    pageLabels.push(`${route.name} — Abstract`);
    pages.push(
      <SecurityPage
        key={`${route.id}-security`}
        data={data!}
        route={route}
      />
    );
    pageLabels.push(`${route.name} — Security`);
  });

  // ── CSV export (one combined file, one row per customer + Route col) ──
  const exporters: Exporter[] = data ? [{
    label: "CSV",
    filename: `route-sheet_${data.date}.csv`,
    mimeType: "text/csv",
    build: () => {
      const header = [
        "Route Code", "Route", "Sl", "Customer Code", "Customer",
        ...acrossProducts.map(p => p.reportAlias),
        "Others", "Crates", "Net Amount",
      ];
      const rows: (string | number)[][] = [header];
      for (const r of routesWithData) {
        for (const c of r.customers) {
          rows.push([
            r.code, r.name, c.sl, c.code, c.name,
            ...acrossProducts.map(p => c.acrossQty[p.id] ?? 0),
            c.othersText, c.crates, c.netAmount,
          ]);
        }
        rows.push([
          r.code, `${r.name} TOTAL`, "", "", "",
          ...acrossProducts.map(p => r.totals.acrossQty[p.id] ?? 0),
          r.totals.othersQty, r.totals.crates, r.totals.netAmount,
        ]);
      }
      return toCsv(rows);
    },
  }] : [];

  return (
    <ReportShell
      title="Route Sheet"
      subtitle="Per-route loading sheets — abstract + security checklist appended"
      printOrientation="landscape"
      filters={
        <>
          {/* Date */}
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
              Date
            </label>
            <Input
              type="date"
              value={date}
              onChange={e => setDate(e.target.value)}
              className="erp-input w-40"
            />
          </div>
 
          {/* Batch */}
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
              Batch
            </label>
            <Select value={batch || "all"} onValueChange={v => setBatch(v === "all" ? "" : v)}>
              <SelectTrigger className="erp-input w-44">
                <SelectValue placeholder="All batches" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All batches</SelectItem>
                {(batches as any[]).map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
 
          {/* Routes — NEW F9SearchSelect */}
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
              Route
            </label>
            <F9SearchSelect
              value={routeId}
              onChange={v => setRouteId(v)}
              options={routeOptions}
              allowAll
              allLabel="All Routes"
              placeholder="All Routes (F9)"
              modalTitle="Select Route"
              className="w-52"
            />
          </div>
        </>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel: idx => pageLabels[idx] ?? "",
        emptyMessage: "No customer indents for any route on this date",
      }}
    />
  );
}

// ════════════════════════════════════════════════════════════════════
// PAGE 1: per-route customer-rows page
// ════════════════════════════════════════════════════════════════════
function RouteRowsPage({
  data, acrossProducts, route, rows, showTotal, pageNum, pageCount,
}: {
  data: RouteSheetResponse;
  acrossProducts: RouteSheetAcrossProduct[];
  route: RouteSheetRoute;
  rows: RouteSheetRoute["customers"];
  showTotal: boolean;
  pageNum: number;
  pageCount: number;
}) {
  // Build a map: productId → abstract item (for crates / pktPlus / pktMinus).
  // Used by the Total Crates row.
  const abstractByPid = new Map(
    route.abstract.items.map(i => [i.productId, i])
  );

  return (
    <div className="rs-page rs-rows-page">
      <RouteLetterhead
        data={data} route={route}
        pageHeading="Route Sheet"
        pageNum={pageNum} pageCount={pageCount}
      />

      <table className="report-ledger compact rs-ledger">
        <colgroup>
          <col style={{ width: "28px" }} />                                       {/* Sl                    */}
          <col className="col-dealer" />                                           {/* Code – Dealer (capped) */}
          {acrossProducts.map(p => <col key={p.id} style={{ width: "28px" }} />)}  {/* each vert-header col   */}
          <col style={{ width: "22%" }} />                                         {/* Other Products         */}
          <col style={{ width: "48px" }} />                                        {/* Crates                 */}
          <col style={{ width: "82px" }} />                                        {/* Net Amount             */}
        </colgroup>
        <thead>
          <tr>
            <th>Sl</th>
            <th>Dealer</th>
            {acrossProducts.map(p => (
              <th key={p.id} className="vert-text" title={p.reportAlias}>
                <span>{p.reportAlias}</span>
              </th>
            ))}
            <th>Other Products</th>
            <th className="num">Crates</th>
            <th className="num">Net Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(c => (
            <tr key={c.id}>
              <td className="num">{c.sl}</td>
              <td className="dealer-cell">
                <span className="font-mono">{c.code}</span>
                <span className="dealer-sep"> - </span>
                {c.name}
                {c.isEmployee && (
                  <span className="ml-1 text-[9px] font-semibold uppercase tracking-wide
                                  px-1 py-[1px] border border-current rounded-[2px]
                                  align-middle">EMP</span>
                )}
              </td>
              {acrossProducts.map(p => (
                <td key={p.id} className="center num">
                  {c.acrossQty[p.id] ? c.acrossQty[p.id] : ""}
                </td>
              ))}
              <td className="others-cell">
                {(c.othersText ?? "")
                  .split(",").map(s => s.trim()).filter(Boolean)
                  .map((line, li) => {
                    const [namePart, qtyPart] = line.split("→");
                    return (
                      <div key={li}>
                        {namePart?.trim()}
                        {qtyPart !== undefined && (
                          <>
                            <span className="others-arrow">→</span>
                            {qtyPart.trim()}
                          </>
                        )}
                      </div>
                    );
                  })}
              </td>
              <td className="num">{fmtNum(c.crates)}</td>
              <td className="num">{fmtINR(c.netAmount)}</td>
            </tr>
          ))}

          {/* TOTAL row — shown only on the last chunk page */}
          {showTotal && (
            <tr className="total-row">
              <td colSpan={2} className="num">TOTAL</td>
              {acrossProducts.map(p => (
                <td key={p.id} className="center num">
                  {fmtNum(route.totals.acrossQty[p.id] ?? 0)}
                </td>
              ))}
              <td className="num">
                Total Qty (Pkts): {fmtNum(route.totals.totalAllQty)}
              </td>
              <td className="num">{fmtNum(route.totals.crates)}</td>
              <td className="num">{fmtINR(route.totals.netAmount)}</td>
            </tr>
          )}

          {/* TOTAL CRATES row — one crate±pkts cell per across product */}
          {showTotal && (
            <tr className="total-row rs-total-crates-row">
              <td colSpan={2} className="num">
                Total Crates
              </td>
              {acrossProducts.map(p => {
                const item = abstractByPid.get(p.id);
                const label = item
                  ? fmtCratePkts(item.crates, item.pktPlus, item.pktMinus)
                  : "";
                return (
                  <td key={p.id} className="center num">
                    {label}
                  </td>
                );
              })}
              {/* Others and trailing columns left blank */}
              <td />
              <td />
              <td />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// PAGE 2: Route Sheet Abstract (per-product breakdown only)
// — No TM/HM-Qty, no FCM-Qty, no signatures, no return particulars —
// Qty (Kg/Ltr) = packets × pack_size ÷ 1000 (pack_size stored in ml/g)
// ════════════════════════════════════════════════════════════════════
function AbstractPage({
  data, route,
}: {
  data: RouteSheetResponse;
  route: RouteSheetRoute;
}) {
  const items = route.abstract.items;
  const t = route.abstract.totals;

  // Recompute totals kgLtr correctly using unit-aware helper
  const totalKgLtr = items.reduce((s, i) => s + computeKgLtr(i.packets, i.packSize, i.unit, i.alias), 0);

  return (
    <div className="rs-page rs-abstract-page">
      <RouteLetterhead
        data={data} route={route}
        pageHeading="Route Sheet Abstract"
      />

      <table className="report-ledger compact rs-ledger rs-abstract-table">
        <colgroup>
          <col style={{ width: "30%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "12%" }} />
          <col style={{ width: "14%" }} />
          <col style={{ width: "16%" }} />
          <col style={{ width: "8%" }} />
          <col style={{ width: "8%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>Milk \ Product</th>
            <th className="num">Crates / Boxes</th>
            <th className="num">Qty (Pkts)</th>
            <th className="num">Qty (Kg/Ltr)</th>
            <th className="num">Amount</th>
            <th className="num">Pkt (+)</th>
            <th className="num">Pkt (−)</th>
          </tr>
        </thead>
        <tbody>
          {items.map(i => {
            const kgLtrCorrect = computeKgLtr(i.packets, i.packSize, i.unit, i.alias);
            return (
              <tr key={i.productId}>
                <td>{i.alias}</td>
                <td className="num">{fmtNum(i.crates)}</td>
                <td className="num">{fmtNum(i.packets)}</td>
                <td className="num">{kgLtrCorrect.toFixed(3)}</td>
                <td className="num">{fmtINR(i.amount)}</td>
                <td className="num">{i.pktPlus > 0 ? fmtNum(i.pktPlus) : "—"}</td>
                <td className="num">{i.pktMinus > 0 ? fmtNum(i.pktMinus) : "—"}</td>
              </tr>
            );
          })}
          <tr className="total-row">
            <td className="num">Total Milk \ Amount</td>
            <td className="num">{fmtNum(t.crates)}</td>
            <td className="num">{fmtNum(t.packets)}</td>
            <td className="num">{totalKgLtr.toFixed(3)}</td>
            <td className="num">{fmtINR(t.amount)}</td>
            <td className="num">{t.pktPlus > 0 ? fmtNum(t.pktPlus) : "—"}</td>
            <td className="num">{t.pktMinus > 0 ? fmtNum(t.pktMinus) : "—"}</td>
          </tr>
        </tbody>
      </table>

      {/* Cash / Bank / Credit summary line */}
      <div className="rs-abstract-money">
        <span><strong>Total Free Milk:</strong> 0 Ltr</span>
        <span><strong>Total:</strong> 0 Crates</span>
        <span><strong>Cash:</strong> {fmtINR(t.amount)}</span>
        <span><strong>Bank:</strong> {fmtINR(0)}</span>
        <span><strong>Credit:</strong> {fmtINR(0)}</span>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// PAGE 3: Despatch Summary For Security
// — Crates Out (prefilled dispatch total) first,
//   Crates In  (blank fill-line for security to write on) second.
// ════════════════════════════════════════════════════════════════════
function SecurityPage({
  data, route,
}: {
  data: RouteSheetResponse;
  route: RouteSheetRoute;
}) {
  const items = route.abstract.items;
  const t = route.abstract.totals;

  return (
    <div className="rs-page rs-security-page">
      <RouteLetterhead
        data={data} route={route}
        pageHeading="Despatch Summary For Security"
      />

      <table className="report-ledger compact rs-ledger rs-security-table">
        <colgroup>
          <col style={{ width: "40%" }} />
          <col style={{ width: "18%" }} />
          <col style={{ width: "22%" }} />
          <col style={{ width: "20%" }} />
        </colgroup>
        <thead>
          <tr>
            <th>MLK / PRDT</th>
            <th className="num">CRTS</th>
            <th className="num">QTY (Pkts)</th>
            <th className="center">Checked Y/N</th>
          </tr>
        </thead>
        <tbody>
          {items.map(i => (
            <tr key={i.productId}>
              <td>{i.alias}</td>
              <td className="num">{fmtNum(i.crates)}</td>
              <td className="num">{fmtNum(i.packets)}</td>
              <td className="center">__</td>
            </tr>
          ))}

          {/* Crates Out — prefilled with the dispatch total */}
          <tr className="total-row">
            <td className="num">Crates Out</td>
            <td className="num">{fmtNum(t.crates)}</td>
            <td className="num">{fmtNum(t.packets)}</td>
            <td />
          </tr>

          {/* Crates In — blank fill-line for the security guard to write on return */}
          <tr className="total-row rs-crates-in">
            <td className="num">Crates In</td>
            <td className="rs-fill-line" />
            <td className="rs-fill-line" />
            <td />
          </tr>
        </tbody>
      </table>

      {/* Cash / Bank / Credit summary line (kept for despatcher reference) */}
      <div className="rs-abstract-money">
        <span><strong>Total Free Milk:</strong> 0 Ltr</span>
        <span><strong>Total:</strong> 0 Crates</span>
        <span><strong>Cash:</strong> {fmtINR(t.amount)}</span>
        <span><strong>Bank:</strong> {fmtINR(0)}</span>
        <span><strong>Credit:</strong> {fmtINR(0)}</span>
      </div>

      {/* Return Particulars block */}
      <div className="rs-returns">
        <div className="rs-returns-head">Return Particulars</div>
        <div className="rs-returns-grid">
          {["Security Section", "Production Section",
            "Products Section", "Q.C. Section", "Remarks"].map(section => (
            <div key={section} className="rs-return-cell">
              <div className="rs-return-title">{section}</div>
              <div className="rs-return-line">Empty Crates :</div>
              <div className="rs-return-line">Empty Cans   :</div>
              <div className="rs-return-line">Milk         :</div>
              <div className="rs-return-line">Products     :</div>
            </div>
          ))}
        </div>
      </div>

      {/* Only two signatures: Security + Contractor */}
      <div className="rs-signatures rs-signatures-two">
        {["Security", "Contractor"].map(role => (
          <div key={role} className="rs-sign">
            <div className="rs-sign-line" />
            <div className="rs-sign-label">{role}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Shared letterhead — rendered on every page (so each printed sheet
// carries the company header without depending on browser repeat-
// thead tricks).
// ════════════════════════════════════════════════════════════════════
function RouteLetterhead({
  data, route, pageHeading, pageNum, pageCount,
}: {
  data: RouteSheetResponse;
  route: RouteSheetRoute;
  pageHeading: string;
  pageNum?: number;
  pageCount?: number;
}) {
  const showPager = pageCount && pageCount > 1;
  return (
    <div className="rs-letterhead">
      <div className="rs-lh-co">
        Haveri District Co-operative Milk Producers Societies Union Ltd
      </div>
      <div className="rs-lh-meta">
        <span><strong>GST No.:</strong> 29AADAH7841L1Z6</span>
        <span><strong>Admin Office:</strong> Veterinary Hospital Compound, PB Road, Haveri - 581110</span>
        <span><strong>Phone:</strong> 08375200650</span>
      </div>
      <div className="rs-lh-title">
        {pageHeading}
        {showPager && (
          <span className="rs-lh-pager"> &nbsp;·&nbsp; Page {pageNum} of {pageCount}</span>
        )}
      </div>
      <div className="rs-lh-details">
        <span><strong>Route:</strong> {route.name} ({route.code})</span>
        <span><strong>Date:</strong> {fmtDate(data.date)}</span>
        <span><strong>Batch:</strong> {data.batch?.name ?? route.batchName ?? "—"}</span>
        <span><strong>Contractor:</strong> {route.contractor.name ?? "—"}</span>
        <span><strong>Dispatch:</strong> {route.dispatchTime ?? "—"}</span>
        <span><strong>Commencing:</strong> ____</span>
        <span><strong>Completion:</strong> ____</span>
      </div>
    </div>
  );
}