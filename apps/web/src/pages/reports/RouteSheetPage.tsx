// apps/web/src/pages/reports/RouteSheetPage.tsx
// ════════════════════════════════════════════════════════════════════
// Route Sheet — full replacement.
//
// Per route we emit:
//   • N customer-rows pages (≤ ROWS_PER_PAGE each), final page carries
//     the route TOTAL row.
//   • 1 abstract page (per-product breakdown + despatch checklist).
//
// Constraints:
//   • Across cap = 8 (enforced by the API; UI just renders what comes).
//   • Crates column sits BEFORE Net ₹.
//   • Designed to fit A4 landscape; widths in CSS keep us under that.
//
// Pagination:
//   Pages are pre-rendered into the `pages: ReactNode[]` that
//   ReportShell uses for screen Prev/Next; on print, the browser
//   page-breaks naturally because we put `page-break-after: always`
//   between siblings.
// ════════════════════════════════════════════════════════════════════
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { fmtNum, fmtINR, fmtDate } from "@/components/PageHeader";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { fetchBatches } from "@/services/api";
import {
  fetchRouteSheet,
  type RouteSheetResponse,
  type RouteSheetRoute,
  type RouteSheetAcrossProduct,
} from "@/services/report";
import { toCsv } from "@/lib/exporters";

// 16 dealer rows per A4 landscape page leaves comfortable headroom for
// the Others column to wrap to 2-3 lines. Tune here if needed.
const ROWS_PER_PAGE = 16;

export default function RouteSheetPage() {
  const today = new Date().toISOString().split("T")[0];
  const [batch, setBatch] = useState<string>("");
  const [date, setDate] = useState<string>(today);
  const [generated, setGenerated] = useState(false);

  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  const { data, isLoading, refetch } = useQuery<RouteSheetResponse>({
    queryKey: ["route-sheet", date, batch],
    queryFn: () => fetchRouteSheet({ date, batchId: batch || undefined }),
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
  // anywhere in the dataset. Keeps narrow days narrow.
  const usedIds = new Set<string>();
  routesWithData.forEach(r => r.customers.forEach(c => {
    Object.entries(c.acrossQty).forEach(([pid, q]) => { if (q > 0) usedIds.add(pid); });
  }));
  const acrossProducts = (data?.acrossProducts ?? []).filter(p => usedIds.has(p.id));

  // ── Build pages: per route → N row-pages + 1 abstract page ──
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
      subtitle="Per-route loading sheets — one route per group, abstract appended"
      printOrientation="landscape"
      filters={
        <>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
              Date
            </label>
            <Input type="date" value={date}
                   onChange={e => setDate(e.target.value)}
                   className="erp-input w-40" />
          </div>
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
        </>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Route Sheet"
          rows={[
            { label: "Date", value: data ? fmtDate(data.date) : "—" },
            { label: "Batch", value: data?.batch?.name ?? "All" },
          ]}
        />
      }
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

// ────────────────────────────────────────────────────────────────────
// PER-ROUTE CUSTOMER ROWS PAGE
// ────────────────────────────────────────────────────────────────────
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
  return (
    <div className="rs-page rs-rows-page">
      <RouteStrip data={data} route={route} variant="sheet"
                  pageNum={pageNum} pageCount={pageCount} />

      <table className="report-ledger compact rs-ledger">
        <colgroup>
          <col style={{ width: "26px" }} />
          <col style={{ width: "60px" }} />
          <col />
          {acrossProducts.map(p => <col key={p.id} style={{ width: "44px" }} />)}
          <col style={{ width: "32%" }} />
          <col style={{ width: "48px" }} />
          <col style={{ width: "82px" }} />
        </colgroup>
        <thead>
          <tr>
            <th>Sl</th>
            <th>Code</th>
            <th>Dealer</th>
            {acrossProducts.map(p => (
              <th key={p.id} className="vert-text" title={p.reportAlias}>
                <VerticalText text={p.reportAlias} />
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
              <td className="font-mono">{c.code}</td>
              <td>{c.name}</td>
              {acrossProducts.map(p => (
                <td key={p.id} className="center num">
                  {c.acrossQty[p.id] ? c.acrossQty[p.id] : ""}
                </td>
              ))}
              <td className="others-cell">
                {(c.othersText ?? "")
                  .split(",").map(s => s.trim()).filter(Boolean).join("\n")}
              </td>
              <td className="num">{fmtNum(c.crates)}</td>
              <td className="num">{fmtINR(c.netAmount)}</td>
            </tr>
          ))}

          {showTotal && (
            <tr className="total-row">
              <td colSpan={3} className="num">TOTAL</td>
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
        </tbody>
      </table>
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// PER-ROUTE ABSTRACT / DESPATCH SUMMARY PAGE
// ────────────────────────────────────────────────────────────────────
function AbstractPage({
  data, route,
}: {
  data: RouteSheetResponse;
  route: RouteSheetRoute;
}) {
  const items = route.abstract.items;
  const t = route.abstract.totals;

  return (
    <div className="rs-page rs-abstract-page">
      <RouteStrip data={data} route={route} variant="abstract" />

      <div className="rs-abstract-grid">
        {/* Left: full breakdown */}
        <table className="report-ledger compact rs-ledger rs-abstract-table">
          <colgroup>
            <col style={{ width: "22%" }} />
            <col style={{ width: "64px" }} />
            <col style={{ width: "64px" }} />
            <col style={{ width: "64px" }} />
            <col style={{ width: "82px" }} />
            <col style={{ width: "44px" }} />
            <col style={{ width: "44px" }} />
            <col style={{ width: "60px" }} />
            <col style={{ width: "60px" }} />
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
              <th className="num">TM/HM-Qty (Ltr)</th>
              <th className="num">FCM-Qty (Ltr)</th>
            </tr>
          </thead>
          <tbody>
            {items.map(i => (
              <tr key={i.productId}>
                <td>{i.alias}</td>
                <td className="num">{fmtNum(i.crates)}</td>
                <td className="num">{fmtNum(i.packets)}</td>
                <td className="num">{i.kgLtr.toFixed(2)}</td>
                <td className="num">{fmtINR(i.amount)}</td>
                <td className="num">{i.pktPlus > 0 ? fmtNum(i.pktPlus) : "—"}</td>
                <td className="num">{i.pktMinus > 0 ? fmtNum(i.pktMinus) : "—"}</td>
                <td className="num">{i.unit?.toLowerCase().includes("ml") || i.unit?.toLowerCase().includes("ltr")
                  ? i.kgLtr.toFixed(2) : "0.00"}</td>
                <td className="num">0</td>
              </tr>
            ))}
            <tr className="total-row">
              <td className="num">Total Milk \ Amount</td>
              <td className="num">{fmtNum(t.crates)}</td>
              <td className="num">{fmtNum(t.packets)}</td>
              <td className="num">{t.kgLtr.toFixed(2)}</td>
              <td className="num">{fmtINR(t.amount)}</td>
              <td className="num">{t.pktPlus > 0 ? fmtNum(t.pktPlus) : "—"}</td>
              <td className="num">{t.pktMinus > 0 ? fmtNum(t.pktMinus) : "—"}</td>
              <td className="num">{t.kgLtr.toFixed(2)}</td>
              <td className="num">0</td>
            </tr>
          </tbody>
        </table>

        {/* Right: Despatch Summary For Security checklist */}
        <table className="report-ledger compact rs-ledger rs-security-table">
          <colgroup>
            <col />
            <col style={{ width: "44px" }} />
            <col style={{ width: "60px" }} />
            <col style={{ width: "62px" }} />
          </colgroup>
          <thead>
            <tr>
              <th colSpan={4} className="rs-security-head">
                Despatch Summary For Security
              </th>
            </tr>
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
            <tr className="total-row">
              <td className="num">Total Crates</td>
              <td className="num">{fmtNum(t.crates)}</td>
              <td className="num">{fmtNum(t.packets)}</td>
              <td />
            </tr>
          </tbody>
        </table>
      </div>

      {/* Cash / Bank / Credit summary line */}
      <div className="rs-abstract-money">
        <span><strong>Total Free Milk:</strong> 0 Ltr</span>
        <span><strong>Total:</strong> 0 Crates</span>
        <span><strong>Cash:</strong> {fmtINR(t.amount)}</span>
        <span><strong>Bank:</strong> {fmtINR(0)}</span>
        <span><strong>Credit:</strong> {fmtINR(0)}</span>
      </div>

      {/* Signature row */}
      <div className="rs-signatures">
        {["Prepared By", "Checked By", "Mktg. Incharge", "Salesman",
          "Despatcher", "Security", "Shift-Incharge (Prodn.)"].map(role => (
            <div key={role} className="rs-sign">
              <div className="rs-sign-line" />
              <div className="rs-sign-label">{role}</div>
            </div>
          ))}
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
    </div>
  );
}

// ────────────────────────────────────────────────────────────────────
// SHARED: top header strip used on every page
// ────────────────────────────────────────────────────────────────────
function RouteStrip({
  data, route, variant, pageNum, pageCount,
}: {
  data: RouteSheetResponse;
  route: RouteSheetRoute;
  variant: "sheet" | "abstract";
  pageNum?: number;
  pageCount?: number;
}) {
  const showPager = variant === "sheet" && pageCount && pageCount > 1;
  return (
    <div className="rs-strip">
      <div className="rs-strip-row1">
        <span>
          <strong>{variant === "abstract" ? "Route Sheet Abstract" : "Route"}:</strong>{" "}
          {route.name} ({route.code})
        </span>
        <span><strong>Date:</strong> {fmtDate(data.date)}</span>
        <span><strong>Batch:</strong> {data.batch?.name ?? route.batchName ?? "—"}</span>
        {showPager && (
          <span className="rs-pager">Page {pageNum} of {pageCount}</span>
        )}
      </div>
      <div className="rs-strip-row2">
        <span><strong>Contractor:</strong> {route.contractor.name ?? "—"}</span>
        <span><strong>Vehicle No:</strong> {route.contractor.vehicleNumber ?? "—"}</span>
        <span><strong>Dispatch:</strong> {route.dispatchTime ?? "—"}</span>
        <span><strong>Top-Light:</strong> Yes / No</span>
        <span><strong>Commencing:</strong> ____</span>
        <span><strong>Completion:</strong> ____</span>
      </div>
    </div>
  );
}

function VerticalText({ text }: { text: string }) {
  return (
    <span aria-label={text}>
      {Array.from(text).map((ch, i) => (
        <span key={i} className="vert-letter">{ch}</span>
      ))}
    </span>
  );
}