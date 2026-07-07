// apps/web/src/pages/reports/RouteSheetPage.tsx
// ════════════════════════════════════════════════════════════════════
// Route Sheet — full replacement (per-page letterhead, 3-page split).
//
// Per route we emit:
//   • N customer-rows pages (packed by row height, not a fixed count, so a
//     tall multi-line row never overflows onto a header-less sheet), final page carries
//     the route TOTAL row and a "Total Crates" row below it (for the
//     9 across products), showing crates ± leftover packets.
//   • 1 abstract page  → Route Sheet Abstract table + ₹ summary line.
//                         Qty (Kg/Ltr) = packets × pack_size, read from the
//                         product's DB fields (see @/lib/kgLtr).
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
//   3. Qty (Kg/Ltr) on page 2 uses computeKgLtr() (@/lib/kgLtr), which
//        multiplies packets by products.pack_size — pack_size is stored in
//        the macro unit (L/kg), so multi-pack SKUs like "180 ML (30 PACK)"
//        (5.4 L) report their true carton volume instead of one pouch.
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
import { computeKgLtr } from "@/lib/kgLtr";

// ── Display order for the across-product columns ──────────────────
// Driven by products.abstract_position, set per-product from the admin panel
// (Products → Behaviour → "Abstract Sheet Position"). Positioned products
// (position > 0) lead in ascending order; unpositioned products (0) fall to
// the end, keeping their server sort_order. This is the SAME ordering the API
// applies to the Route Sheet Abstract table, so columns and abstract rows
// stay in lock-step.
//
// LEGACY_ORDER is a fallback used only for products that still have no
// abstract_position assigned, so the sheet keeps a sensible order until an
// admin sets positions. Matched against both code and reportAlias.
const LEGACY_ORDER = [
  "HTM-1000ML",
  "HTM 1000ML (sub)",   // subsidised HTM 1000ML — sits right after its base product
  "HTM-500ML",
  "HCM-500ML",
  "SHBM 1000ML",
  "SHBM 500ML",
  "SHBM 200ML",
  "SAMRUDHI 500ML",
  "CURD 200GM",
  "CURD 500GM",
];

// A subsidised product ("HTM 1000ML (sub)") leads the sheet — its column and
// abstract row sort before everything else, matching the server's abstract order.
const isSubAlias = (s: string | undefined | null): boolean =>
  /\(\s*sub\s*\)/i.test(s ?? "");

function sortAcrossProducts(products: RouteSheetAcrossProduct[]): RouteSheetAcrossProduct[] {
  const legacy = new Map(LEGACY_ORDER.map((c, i) => [c.toUpperCase(), i + 1]));
  const key = (p: RouteSheetAcrossProduct): number => {
    const base =
      p.abstractPosition && p.abstractPosition > 0
        ? p.abstractPosition
        : legacy.get(p.code.toUpperCase()) ??
          legacy.get((p.reportAlias ?? "").toUpperCase()) ??
          Number.MAX_SAFE_INTEGER;
    // Subsidised products sort ahead of all non-sub products while keeping
    // their relative order (smaller base still leads among subs).
    return isSubAlias(p.reportAlias) ? base - Number.MAX_SAFE_INTEGER : base;
  };
  return [...products].sort((a, b) => key(a) - key(b));
}

// ── Helper: format crates ± leftover packets ───────────────────────
// Returns "2+6", "1-3", "4", or "" (if 0 crates and 0 packets).
function fmtCratePkts(crates: number, pktPlus: number, pktMinus: number): string {
  if (crates === 0 && pktPlus === 0 && pktMinus === 0) return "";
  if (pktPlus > 0) return `${crates}+${pktPlus}`;
  if (pktMinus > 0) return `${crates}-${pktMinus}`;
  return `${crates}`;
}

// Qty (Kg/Ltr) = packets × pack_size, read from the DB — see @/lib/kgLtr.

// ── Content-aware pagination ────────────────────────────────────────
// A fixed row-count split orphaned tall rows: 13 rows only fit when they're
// all single-line, but a row's "Other Products" cell stacks one line per
// entry (and long dealer names wrap), so a page of multi-line rows overflows
// its sheet. The browser then continues the table on a second physical sheet
// — repeating only the <thead>, NOT the letterhead — leaving a header-less
// "not continuous" page. Instead we measure each row in text-line units and
// pack rows by height so every chunk fits on one sheet.
//
// PAGE_UNIT_BUDGET is calibrated against the tightest sheet (page 1, which
// also carries the document print-header): ~22 line-units fit there, so 20
// leaves a safety margin for font/wrap variance.
const PAGE_UNIT_BUDGET = 20;
// The final sheet of a route also carries the TOTAL + Total-Crates rows.
const TOTAL_ROWS_UNITS = 2;
// Approx. characters that fit on one line of the capped dealer-name column.
const DEALER_CHARS_PER_LINE = 30;

// Height of a single customer row, in text-line units (min 1). The row is as
// tall as its tallest cell: either the wrapped dealer name or the stacked
// "Other Products" lines.
function rowUnits(c: RouteSheetRoute["customers"][number]): number {
  const otherLines = (c.othersText ?? "")
    .split(",").map(s => s.trim()).filter(Boolean).length;
  const nameLen = `${c.code} - ${c.name}`.length;
  const nameLines = Math.max(1, Math.ceil(nameLen / DEALER_CHARS_PER_LINE));
  return Math.max(1, nameLines, otherLines);
}

// Greedily pack customers into printed sheets so each sheet's rows stay within
// PAGE_UNIT_BUDGET, keeping the table continuous across headed pages.
function paginateRows(
  customers: RouteSheetRoute["customers"],
): RouteSheetRoute["customers"][] {
  const chunks: RouteSheetRoute["customers"][] = [];
  let current: RouteSheetRoute["customers"] = [];
  let used = 0;
  for (const c of customers) {
    const u = rowUnits(c);
    if (current.length > 0 && used + u > PAGE_UNIT_BUDGET) {
      chunks.push(current);
      current = [];
      used = 0;
    }
    current.push(c);
    used += u;
  }
  if (current.length > 0) chunks.push(current);

  // Reserve room on the final sheet for the TOTAL + Total-Crates rows; if they
  // won't fit alongside the last dealer row, spill that row to a fresh sheet.
  if (chunks.length > 0) {
    const last = chunks[chunks.length - 1];
    const lastUnits = last.reduce((s, c) => s + rowUnits(c), 0);
    if (last.length > 1 && lastUnits + TOTAL_ROWS_UNITS > PAGE_UNIT_BUDGET) {
      chunks.push([last.pop()!]);
    }
  }
  return chunks;
}

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
    const chunks = paginateRows(route.customers);
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
            c.othersText,
            fmtCratePkts(c.crates, c.cratePktPlus ?? 0, c.cratePktMinus ?? 0) || String(c.crates),
            c.netAmount,
          ]);
        }
        rows.push([
          r.code, `${r.name} TOTAL`, "", "", "",
          ...acrossProducts.map(p => r.totals.acrossQty[p.id] ?? 0),
          r.totals.othersQty,
          fmtCratePkts(r.totals.crates, r.totals.cratePktPlus ?? 0, r.totals.cratePktMinus ?? 0) || String(r.totals.crates),
          r.totals.netAmount,
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
              <td className="num">{fmtCratePkts(c.crates, c.cratePktPlus ?? 0, c.cratePktMinus ?? 0) || fmtNum(c.crates)}</td>
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
              <td className="num">{fmtCratePkts(route.totals.crates, route.totals.cratePktPlus ?? 0, route.totals.cratePktMinus ?? 0) || fmtNum(route.totals.crates)}</td>
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
// Qty (Kg/Ltr) = packets × pack_size, read from the DB (see @/lib/kgLtr)
// ════════════════════════════════════════════════════════════════════
function AbstractPage({
  data, route,
}: {
  data: RouteSheetResponse;
  route: RouteSheetRoute;
}) {
  const items = route.abstract.items;
  const t = route.abstract.totals;

  // Qty (Kg/Ltr) total is milk only: it represents total litres of milk
  // dispatched, so adding curd (measured in Kg) into the same figure would
  // be meaningless. Per-row Kg/Ltr values still show for every product; only
  // this grand total is restricted to the Milk category.
  const totalKgLtr = items
    .filter(i => (i.category ?? "").trim().toLowerCase() === "milk")
    .reduce((s, i) => s + computeKgLtr(i.packets, i.packSize, i.unit), 0);

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
            const kgLtrCorrect = computeKgLtr(i.packets, i.packSize, i.unit);
            return (
              <tr key={i.productId}>
                <td>{i.alias}</td>
                <td className="num">{fmtNum(i.crates)}</td>
                <td className="num">{fmtNum(i.packets)}</td>
                <td className="num">{kgLtrCorrect.toFixed(2)}</td>
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
            <td className="num">{totalKgLtr.toFixed(2)}</td>
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