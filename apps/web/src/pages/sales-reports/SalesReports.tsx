import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader, {
  FilterBar,
  EmptyState,
  fmtINR,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight, Printer, FileBarChart2 } from "lucide-react";
import {
  fetchDailyStatement, fetchDayRouteCash, fetchOfficerWise,
  fetchCashSales, fetchSalesRegister, fetchCreditSales,
  fetchTalukaAgent, fetchAdhocSales, fetchGstStatement, fetchVipSales,
  fetchTalukaWise,
  type DailyStatementResponse, type DayRouteCashResponse,
  type OfficerWiseResponse, type SalesGridResponse, type SalesGridRoute,
  type CreditSalesResponse, type CreditBillCustomer, type TalukaAgentResponse,
  type AdhocResponse, type GstStatementResponse, type VipSalesResponse,
  type TalukaWiseResponse, type TalukaWiseRow,
  type ProductLite,
} from "@/services/report";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import { ColumnPagedTable, paginateColumns } from "@/lib/reportColumnPaging";
import { computeKgLtr } from "@/lib/kgLtr";

const fmtQty = (n: number | string) => String(Number(n || 0));

// dd-mm-yyyy — the on-paper date format the union uses across sales reports.
const fmtDMY = (iso: string) => {
  const [y, m, d] = (iso ?? "").split("-");
  return y && m && d ? `${d}-${m}-${y}` : (iso ?? "");
};

// Ltr/Kg volume: blank for 0 (keeps grids readable), else up to 2 decimals.
const fmtVol = (n: number) =>
  n ? Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "";

// Volume of one product column's packet count, using its DB pack_size + unit.
const volOf = (packets: number, p: { packSize?: number; unit?: string }) =>
  computeKgLtr(packets, p.packSize ?? 0, p.unit ?? "");

// ─────────────────────────────────────────────────────────────
// Shared shell — wraps every sales report
// ─────────────────────────────────────────────────────────────
function SalesReportShell<T>({
  title, description,
  fetcher,
  renderPages,
  buildCsv,
  printOrientation = "portrait",
  printMeta = <ReportPrintMeta />,
}: {
  title: string;
  description: string;
  fetcher: (from: string, to: string) => Promise<T>;
  renderPages: (from: string, to: string, data: T | undefined) => ReactNode[];
  buildCsv?: (from: string, to: string, data: T) => (string | number | null | undefined)[][];
  printOrientation?: "portrait" | "landscape";
  /** Per-page letterhead. Pass `null` to omit it (e.g. the credit bill, which
   *  carries its own printed header). Defaults to the union letterhead. */
  printMeta?: ReactNode;
}) {
  const today = new Date().toISOString().split("T")[0];
  const monthStart = today.substring(0, 8) + "01";
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [generated, setGenerated] = useState(false);

  const { data, isLoading, refetch } = useQuery<T>({
    queryKey: [`sr:${title}`, from, to],
    queryFn: () => fetcher(from, to),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  const pages = generated ? renderPages(from, to, data) : [];
  const exporters: Exporter[] = (data && buildCsv) ? [{
    label: "CSV",
    filename: `${title.toLowerCase().replace(/\s+/g, "-")}_${from}_${to}.csv`,
    mimeType: "text/csv",
    build: () => toCsv(buildCsv(from, to, data)),
  }] : [];

  return (
    <ReportShell
      title={title}
      subtitle={description}
      printOrientation={printOrientation}
      filters={
        <>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="erp-input w-40" />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="erp-input w-40" />
          </div>
        </>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={printMeta}
      state={{ generated, loading: isLoading, pages }}
    />
  );
}

function ReportHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="text-center mb-2 print:hidden">
      <p className="text-[12px] font-bold mt-0.5">{title}</p>
      {subtitle && <p className="text-[10.5px] text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}

// ─── renderSalesGridPage (shared) ───────────────────────────────
function renderSalesGridPage(title: string, from: string, to: string, apiData: SalesGridResponse) {
  return (
    <div>
      <ReportHeader title={title} subtitle={`Period: ${from} to ${to}`} />
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className="border border-border py-1.5 px-2 text-left font-bold w-16">Code</th>
            <th className="border border-border py-1.5 px-2 text-left font-bold">Route</th>
            <th className="border border-border py-1.5 px-2 text-left font-bold">Contractor</th>
            {apiData.products.map(p => <th key={p.id} className="border border-border py-1.5 px-2 text-center font-bold whitespace-nowrap">{p.reportAlias}</th>)}
            <th className="border border-border py-1.5 px-2 text-right font-bold num">Milk ₹</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold num">Product ₹</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold num">Total ₹</th>
          </tr>
        </thead>
        <tbody>
          {apiData.routes.map(r => (
            <tr key={r.id}>
              <td className="border border-border py-1 px-2 font-mono">{r.code}</td>
              <td className="border border-border py-1 px-2 font-medium">{r.name}</td>
              <td className="border border-border py-1 px-2 text-muted-foreground">{r.contractorName ?? "—"}</td>
              {apiData.products.map(p => <td key={p.id} className="border border-border py-1 px-2 text-center num">{fmtQty(r.qty[p.id] ?? 0)}</td>)}
              <td className="border border-border py-1 px-2 text-right num">{fmtINR(r.milkAmount)}</td>
              <td className="border border-border py-1 px-2 text-right num">{fmtINR(r.productAmount)}</td>
              <td className="border border-border py-1 px-2 text-right font-semibold num">{fmtINR(r.total)}</td>
            </tr>
          ))}
          <tr className="font-bold bg-muted/40">
            <td colSpan={3} className="border border-border py-1.5 px-2 text-right">TOTAL</td>
            {apiData.products.map(p => <td key={p.id} className="border border-border py-1.5 px-2 text-center num">{fmtQty(apiData.totals.qty[p.id] ?? 0)}</td>)}
            <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(apiData.totals.milkAmount)}</td>
            <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(apiData.totals.productAmount)}</td>
            <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(apiData.totals.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Shared CSV Builder for Grid Reports ────────────────────────
const buildSalesGridCsv = (from: string, to: string, d: SalesGridResponse) => {
  const out: any[][] = [
    [`${from} to ${to}`],
    ["Code", "Route", "Contractor",
     ...d.products.map(p => p.reportAlias),
     "Milk ₹", "Product ₹", "Total ₹"],
  ];
  d.routes.forEach(r => out.push([
    r.code, r.name, r.contractorName ?? "",
    ...d.products.map(p => r.qty[p.id] ?? 0),
    r.milkAmount, r.productAmount, r.total,
  ]));
  out.push(["", "", "TOTAL",
    ...d.products.map(p => d.totals.qty[p.id] ?? 0),
    d.totals.milkAmount, d.totals.productAmount, d.totals.total,
  ]);
  return out;
};

// ─── Shared "cash-style" grid (Cash Sales + Sales Register) ─────
// Product (rows) × Route (columns) qty grid with a trailing Total-Qty
// column and Total-Qty / Milk ₹ / Product ₹ / Total ₹ footer rows. Qty
// values are centre-aligned; the ₹ footer rows stay right-aligned.
const CASH_ROUTES_PER_PAGE = 8; // A4 landscape fit

function renderCashStyleGrid(
  title: string,
  from: string,
  to: string,
  apiData: SalesGridResponse,
  asVolume = false,
): ReactNode[] {
  const routePages = paginateColumns(apiData.routes, CASH_ROUTES_PER_PAGE);
  const pageCount = routePages.length;

  // Cell + total formatters: packet counts, or Ltr/Kg volume (Sales Register).
  const one = (packets: number, p: ProductLite) =>
    asVolume ? volOf(packets, p) : packets;
  const fmtCell = (v: number) => (asVolume ? fmtVol(v) : fmtQty(v));

  return routePages.map((routeChunk, pageIdx) => {
    const routeQtyTotal = (r: SalesGridRoute) =>
      apiData.products.reduce((s, p) => s + one(r.qty[p.id] ?? 0, p), 0);
    const grandQtyTotal = apiData.products.reduce(
      (s, p) => s + one(apiData.totals.qty[p.id] ?? 0, p), 0);
    const isLast = pageIdx === pageCount - 1;

    return (
      <div key={pageIdx} className="report-page">
        <ReportHeader
          title={title}
          subtitle={`Period: ${from} to ${to} · Columns ${pageIdx + 1}/${pageCount}${asVolume ? " · Qty in Ltr / Kg" : ""}`}
        />
        <table className="w-full text-[11px] border-collapse">
          <thead>
            <tr className="bg-muted/50">
              <th className="border border-border py-1.5 px-2 text-left font-bold">Product</th>
              {routeChunk.map(r => (
                <th key={r.id} className="border border-border py-1 px-2 text-center font-bold">
                  <div className="font-mono text-[10px] text-muted-foreground">{r.code}</div>
                  <div>{r.name}</div>
                  <div className="font-normal text-[9.5px] text-muted-foreground truncate max-w-[90px]">
                    {r.contractorName ?? ""}
                  </div>
                </th>
              ))}
              {isLast && (
                <th className="border border-border py-1.5 px-2 text-center font-bold num">Total Qty</th>
              )}
            </tr>
          </thead>
          <tbody>
            {apiData.products.map(p => (
              <tr key={p.id}>
                <td className="border border-border py-1 px-2 font-medium">{p.reportAlias}</td>
                {routeChunk.map(r => (
                  <td key={r.id} className="border border-border py-1 px-2 text-center num">
                    {fmtCell(one(r.qty[p.id] ?? 0, p))}
                  </td>
                ))}
                {isLast && (
                  <td className="border border-border py-1 px-2 text-center font-bold num">
                    {fmtCell(one(apiData.totals.qty[p.id] ?? 0, p))}
                  </td>
                )}
              </tr>
            ))}

            {/* ── TOTAL QTY row ── */}
            <tr className="font-bold bg-muted/40">
              <td className="border border-border py-1.5 px-2">TOTAL</td>
              {routeChunk.map(r => (
                <td key={r.id} className="border border-border py-1.5 px-2 text-center num">
                  {fmtCell(routeQtyTotal(r))}
                </td>
              ))}
              {isLast && (
                <td className="border border-border py-1.5 px-2 text-center num">
                  {fmtCell(grandQtyTotal)}
                </td>
              )}
            </tr>

            {/* ── Amount rows — only on last page ── */}
            {isLast && (
              <>
                <tr className="font-bold bg-muted/20">
                  <td className="border border-border py-1 px-2">Milk ₹</td>
                  {routeChunk.map(r => (
                    <td key={r.id} className="border border-border py-1 px-2 text-right num">{fmtINR(r.milkAmount)}</td>
                  ))}
                  <td className="border border-border py-1 px-2 text-right num">{fmtINR(apiData.totals.milkAmount)}</td>
                </tr>
                <tr className="font-bold bg-muted/20">
                  <td className="border border-border py-1 px-2">Product ₹</td>
                  {routeChunk.map(r => (
                    <td key={r.id} className="border border-border py-1 px-2 text-right num">{fmtINR(r.productAmount)}</td>
                  ))}
                  <td className="border border-border py-1 px-2 text-right num">{fmtINR(apiData.totals.productAmount)}</td>
                </tr>
                <tr className="font-bold bg-muted/40">
                  <td className="border border-border py-1.5 px-2">Total ₹</td>
                  {routeChunk.map(r => (
                    <td key={r.id} className="border border-border py-1.5 px-2 text-right num">{fmtINR(r.total)}</td>
                  ))}
                  <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(apiData.totals.total)}</td>
                </tr>
              </>
            )}
          </tbody>
        </table>
      </div>
    );
  });
}

// Cash Sales exports packet counts; Sales Register exports Ltr/Kg volume.
const makeCashGridCsv =
  (asVolume: boolean) =>
  (from: string, to: string, d: SalesGridResponse) => {
    const cell = (packets: number, p: ProductLite) =>
      asVolume ? Math.round(volOf(packets, p) * 100) / 100 : packets;
    const rows: (string | number)[][] = [
      [`${from} to ${to}${asVolume ? " · Qty in Ltr/Kg" : ""}`],
      ["Product", ...d.routes.map(r => `${r.code} ${r.name}`), "Total Qty"],
    ];
    d.products.forEach(p => {
      rows.push([
        p.reportAlias,
        ...d.routes.map(r => cell(r.qty[p.id] ?? 0, p)),
        cell(d.totals.qty[p.id] ?? 0, p),
      ]);
    });
    rows.push([
      "TOTAL QTY",
      ...d.routes.map(r => Math.round(d.products.reduce((s, p) => s + cell(r.qty[p.id] ?? 0, p), 0) * 100) / 100),
      Math.round(d.products.reduce((s, p) => s + cell(d.totals.qty[p.id] ?? 0, p), 0) * 100) / 100,
    ]);
    rows.push(["Milk ₹",    ...d.routes.map(r => r.milkAmount),    d.totals.milkAmount]);
    rows.push(["Product ₹", ...d.routes.map(r => r.productAmount), d.totals.productAmount]);
    rows.push(["Total ₹",   ...d.routes.map(r => r.total),         d.totals.total]);
    return rows;
  };

// ─── B1. Daily Sales Statement ──────────────────────────────────
export const DailySalesStatement = () => (
  <SalesReportShell<DailyStatementResponse>
    title="Daily Sales Statement"
    description="DMU items daily sales (own production)"
    fetcher={(from, to) => fetchDailyStatement({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];

      // Cap at 8 product columns/page so a portrait A4 fits:
      // Date (90px) + 8×60px + Total Qty (110px) ≈ 680px < 703px usable.
      // Aliases are ≤14 chars (migration 0027) and wrap inside the 60px cols.
      return apiData.groups.flatMap((group, gi) => {
        const productPages = paginateColumns(group.products, 8);
        // Milk & Lassi pages read in litres, Curd page in kilograms.
        const unitLbl = group.key === "curd" ? "Kgs" : "Ltrs";
        // Row's total volume = Σ every product in the category (unit-consistent
        // within a page), so it doesn't change across column-paged chunks.
        const rowVol = (row: (typeof group.rows)[number]) =>
          group.products.reduce((s, p) => s + volOf(row.qty[p.id] ?? 0, p), 0);
        const colTotalVol = group.products.reduce(
          (s, p) => s + volOf(group.totals.qty[p.id] ?? 0, p), 0);

        return productPages.map((prodChunk, pi) => (
          <ColumnPagedTable
            key={`${gi}-${pi}`}
            title={`Daily Sales Statement — ${group.label} (${unitLbl})${productPages.length > 1 ? ` • Cols ${pi + 1}/${productPages.length}` : ""}`}
            fixedLayout
            fixedHead={[{ label: "Date", accessor: r => fmtDMY(r.date), width: "90px" }]}
            productCols={prodChunk}
            productCellRender={(row, p) => fmtVol(volOf(row.qty[p.id] ?? 0, p))}
            trailingHead={[
              { label: `Total Qty (${unitLbl})`, accessor: r => fmtVol(rowVol(r)), num: true, width: "110px" }
            ]}
            rows={group.rows}
            totalRow={{
              fixedCells: ["TOTAL"],
              productCell: (p) => fmtVol(volOf(group.totals.qty[p.id] ?? 0, p)),
              trailingCells: [fmtVol(colTotalVol)],
            }}
          />
        ));
      });
    }}
    buildCsv={(from, to, d) => {
      // One section per category page: Date + per-product Ltr/Kg + Total Qty.
      const out: any[][] = [[`Daily Sales Statement — ${from} to ${to}`]];
      const r2 = (n: number) => Math.round(n * 100) / 100;
      d.groups.forEach(g => {
        const unitLbl = g.key === "curd" ? "Kgs" : "Ltrs";
        out.push([]);
        out.push([`${g.label} (${unitLbl})`]);
        out.push(["Date", ...g.products.map(p => p.reportAlias), `Total Qty (${unitLbl})`]);
        g.rows.forEach(row => {
          out.push([
            fmtDMY(row.date),
            ...g.products.map(p => r2(volOf(row.qty[p.id] ?? 0, p))),
            r2(g.products.reduce((s, p) => s + volOf(row.qty[p.id] ?? 0, p), 0)),
          ]);
        });
        out.push([
          "TOTAL",
          ...g.products.map(p => r2(volOf(g.totals.qty[p.id] ?? 0, p))),
          r2(g.products.reduce((s, p) => s + volOf(g.totals.qty[p.id] ?? 0, p), 0)),
        ]);
      });
      return out;
    }}
  />
);

// ─── B2. Day / Route Wise Cash Sales ────────────────────────────
export const DayRouteCashSales = () => (
  <SalesReportShell<DayRouteCashResponse>
    title="Day/Route Wise Cash Sales"
    description="Cash sales breakdown by day and route"
    fetcher={(from, to) => fetchDayRouteCash({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      // Cap route columns per page so a portrait A4 fits: usable ~703px −
      // Indent Date (~86px) − Total (~96px) ≈ 521px ÷ ~87px/route ≈ 6 routes.
      const ROUTES_PER_PAGE = 6;
      const routePages = paginateColumns(apiData.routes, ROUTES_PER_PAGE);
      return routePages.map((routeChunk, pi) => (
        <div key={pi}>
          <ReportHeader
            title="Day/Route Wise Cash Sales"
            subtitle={`Period: ${from} to ${to} · Cols ${pi + 1}/${routePages.length}`}
          />
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border border-border py-1.5 px-2 text-left font-bold">Indent Date</th>
                {routeChunk.map(r => <th key={r.id} className="border border-border py-1.5 px-2 text-center font-bold">{r.name}</th>)}
                <th className="border border-border py-1.5 px-2 text-right font-bold num">Total</th>
              </tr>
            </thead>
            <tbody>
              {apiData.dates.map(d => (
                <tr key={d}>
                  <td className="border border-border py-1 px-2 font-medium">{fmtDMY(d)}</td>
                  {routeChunk.map(r => (
                    <td key={r.id} className="border border-border py-1 px-2 text-center num">{fmtINR(apiData.matrix[d]?.[r.id] ?? 0)}</td>
                  ))}
                  <td className="border border-border py-1 px-2 text-right font-bold num">{fmtINR(apiData.dayTotals[d] ?? 0)}</td>
                </tr>
              ))}
              <tr className="font-bold bg-muted/40">
                <td className="border border-border py-1.5 px-2">TOTAL</td>
                {routeChunk.map(r => <td key={r.id} className="border border-border py-1.5 px-2 text-center num">{fmtINR(apiData.routeTotals[r.id] ?? 0)}</td>)}
                <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(apiData.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ));
    }}
    buildCsv={(from, to, d) => {
      const out: any[][] = [];
      out.push(["Day/Route Wise Cash Sales", `${from} to ${to}`]);
      out.push(["Date", ...d.routes.map(r => r.name), "Total"]);
      d.dates.forEach(date => {
        out.push([
          fmtDMY(date),
          ...d.routes.map(r => d.matrix[date]?.[r.id] ?? 0),
          d.dayTotals[date] ?? 0
        ]);
      });
      out.push(["TOTAL", ...d.routes.map(r => d.routeTotals[r.id] ?? 0), d.grandTotal]);
      return out;
    }}
  />
);

// ─── B3. Officer Wise Sales ─────────────────────────────────────
export const OfficerWiseSales = () => (
  <SalesReportShell<OfficerWiseResponse>
    title="Officer Wise Sales"
    description="Quantity sold per product per officer"
    fetcher={(from, to) => fetchOfficerWise({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      // Values render as Ltr (milk) / Kg (curd) per product row. Column and
      // grand totals are recomputed from the volumes (they mix units across
      // products, so the server's packet-count totals can't just be scaled).
      const officerVol = (oId: string) =>
        apiData.products.reduce((s, p) => s + volOf(apiData.matrix[p.id]?.[oId] ?? 0, p), 0);
      const grandVol = apiData.products.reduce(
        (s, p) => s + volOf(apiData.productTotals[p.id] ?? 0, p), 0);
      return [(
        <div key="p1">
          <ReportHeader title="Officer Wise Sales" subtitle={`Period: ${from} to ${to} · Qty in Ltr / Kg`} />
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border border-border py-1.5 px-2 text-left font-bold">Product</th>
                {apiData.officers.map(o => <th key={o.id} className="border border-border py-1.5 px-2 text-center font-bold">{o.name}</th>)}
                <th className="border border-border py-1.5 px-2 text-right font-bold num">Total</th>
              </tr>
            </thead>
            <tbody>
              {apiData.products.map(p => (
                <tr key={p.id}>
                  <td className="border border-border py-1 px-2 font-medium">{p.reportAlias}</td>
                  {apiData.officers.map(o => (
                    <td key={o.id} className="border border-border py-1 px-2 text-center num">{fmtVol(volOf(apiData.matrix[p.id]?.[o.id] ?? 0, p))}</td>
                  ))}
                  <td className="border border-border py-1 px-2 text-right font-bold num">{fmtVol(volOf(apiData.productTotals[p.id] ?? 0, p))}</td>
                </tr>
              ))}
              <tr className="font-bold bg-muted/40">
                <td className="border border-border py-1.5 px-2">TOTAL</td>
                {apiData.officers.map(o => <td key={o.id} className="border border-border py-1.5 px-2 text-center num">{fmtVol(officerVol(o.id))}</td>)}
                <td className="border border-border py-1.5 px-2 text-right num">{fmtVol(grandVol)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
    buildCsv={(from, to, d) => {
      const r2 = (n: number) => Math.round(n * 100) / 100;
      const out: any[][] = [
        [`Officer Wise Sales — ${from} to ${to} · Qty in Ltr/Kg`],
        ["Product", ...d.officers.map(o => o.name), "Total"],
      ];
      d.products.forEach(p => out.push([
        p.reportAlias,
        ...d.officers.map(o => r2(volOf(d.matrix[p.id]?.[o.id] ?? 0, p))),
        r2(volOf(d.productTotals[p.id] ?? 0, p)),
      ]));
      out.push([
        "TOTAL",
        ...d.officers.map(o => r2(d.products.reduce((s, p) => s + volOf(d.matrix[p.id]?.[o.id] ?? 0, p), 0))),
        r2(d.products.reduce((s, p) => s + volOf(d.productTotals[p.id] ?? 0, p), 0)),
      ]);
      return out;
    }}
  />
);

export const CashSalesReport = () => (
  <SalesReportShell<SalesGridResponse>
    title="Cash Sales"
    description="Cash-mode sales grid by product × route"
    fetcher={(from, to) => fetchCashSales({ from, to })}
    printOrientation="landscape"
    renderPages={(from, to, apiData) =>
      apiData ? renderCashStyleGrid("Cash Sales", from, to, apiData) : []}
    buildCsv={makeCashGridCsv(false)}
  />
);

// ─── Sales Register ─────────────────────────────────────────────
// Same product × route grid as Cash Sales, but the data includes both
// cash and credit (plus direct) sales (server: register endpoint).
export const SalesRegister = () => (
  <SalesReportShell<SalesGridResponse>
    title="Sales Register"
    description="Sales by product × route in Ltr/Kg — excludes credit institutions"
    fetcher={(from, to) => fetchSalesRegister({ from, to })}
    printOrientation="landscape"
    renderPages={(from, to, apiData) =>
      apiData ? renderCashStyleGrid("Sales Register", from, to, apiData, true) : []}
    buildCsv={makeCashGridCsv(true)}
  />
);

// ─── B5. Credit Sales — legacy paper-bill layout (matches the union's PDF) ──
// One bill page per credit institution + a final summary page. Suppresses the
// ERP letterhead (printMeta=null) because the bill prints its own header block.
const UNION_GSTIN = "29AADAH7841L1Z6";
const UNION_FSSAI = "11223999000033";

// No thousands separators anywhere on the bill (matches the paper output).
const nAmt  = (n: number) => (Number(n) || 0).toFixed(2);                       // 3540.00
const nRaw  = (n: number) => String(Math.round((Number(n) || 0) * 1000) / 1000); // 1454.11 / 36.355
const nRate = (n: number) => String(Math.round((Number(n) || 0) * 100) / 100);
const nPk   = (n: number) => (n ? String(Math.round(n)) : "");
const nKg   = (n: number) => {
  const v = Number(n) || 0;
  if (!v) return "";
  return Number.isInteger(v) ? v.toFixed(1) : String(Math.round(v * 100) / 100);
};

function renderCreditBillPage(b: CreditBillCustomer, pageNo: number) {
  // Only days that carry at least one sale appear on the paper bill.
  const activeRows = b.dailyRows.filter(row => row.qty.some(q => q > 0));
  const th = "border border-border px-1 py-0.5 align-bottom";
  const td = "border border-border px-1 py-0.5";
  return (
    <div className="text-[10px] leading-tight font-mono">
      {/* Top banner */}
      <div className="flex items-center justify-between mb-1">
        <span className="tracking-[0.25em]">[ H A V E M U L ]</span>
        <span className="font-bold tracking-wide">HAVERI MILK UNION LTD - HAVERI</span>
        <span>Page {pageNo}</span>
      </div>

      {/* Two-column header: buyer block | union GST declaration */}
      <div className="grid grid-cols-2 border border-border">
        <div className="p-1.5 whitespace-pre-wrap">
          <div>To, {b.name}</div>
          {b.address && <div className="pl-4">{b.address}</div>}
          {b.city && <div className="pl-4">{b.city}</div>}
          <div className="mt-1 border-t border-border pt-1">
            <div>BILL NO&nbsp;&nbsp;{b.billNo}</div>
            <div>PERIOD&nbsp;&nbsp;&nbsp;{b.periodFrom} {b.periodTo}</div>
          </div>
        </div>
        <div className="p-1.5 border-l border-border">
          <div>Buyer's GSTIN : {b.gstNumber ?? ""}</div>
          <div>TAX INVOICE/CR.BILL GSTIN : {UNION_GSTIN} FSSAI NO:{UNION_FSSAI}</div>
          <div>DECLARATION UNDER GST Act 2017.</div>
          <div>We declare that we are the first seller in the state liable to tax under GST Act 2017 and that we shall pay the single point tax on above sale.</div>
        </div>
      </div>

      {/* Product grid: session / name / HSN / rate header stack, daily qty, footer totals */}
      <table className="w-full border-collapse mt-1">
        <thead>
          <tr>
            <th className={th}></th>
            {b.products.map(p => <th key={p.id} className={`${th} text-center`}>{p.session}</th>)}
            <th className={th}></th>
          </tr>
          <tr>
            <th className={`${th} text-left`}>Pkt</th>
            {b.products.map(p => <th key={p.id} className={`${th} text-center`}>{p.reportAlias}</th>)}
            <th className={th}></th>
          </tr>
          <tr>
            <th className={`${th} text-left`}>HSN</th>
            {b.products.map(p => <th key={p.id} className={`${th} text-center`}>{p.hsn}</th>)}
            <th className={th}></th>
          </tr>
          <tr>
            <th className={`${th} text-left`}>Rate</th>
            {b.products.map(p => <th key={p.id} className={`${th} text-center`}>{nRate(p.rate)}</th>)}
            <th className={th}></th>
          </tr>
          <tr className="bg-muted/40">
            <th className={`${th} text-left`}>Date</th>
            {b.products.map(p => <th key={p.id} className={`${th} text-center`}>Qty</th>)}
            <th className={`${th} text-right`}>Total Amount</th>
          </tr>
        </thead>
        <tbody>
          {activeRows.map((row, ri) => (
            <tr key={ri}>
              <td className={`${td} text-left`}>{row.day}</td>
              {b.products.map((p, pi) => <td key={p.id} className={`${td} text-right`}>{nPk(row.qty[pi] ?? 0)}</td>)}
              <td className={`${td} text-right`}>{row.dayTotal ? nAmt(row.dayTotal) : ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td className={`${td} text-left`}>Pkts</td>
            {b.products.map((p, i) => <td key={p.id} className={`${td} text-right`}>{nPk(b.totals.pkts[i] ?? 0)}</td>)}
            <td className={td}></td>
          </tr>
          <tr>
            <td className={`${td} text-left`}>Kg\ltr</td>
            {b.products.map((p, i) => <td key={p.id} className={`${td} text-right`}>{nKg(b.totals.kgLtr[i] ?? 0)}</td>)}
            <td className={td}></td>
          </tr>
          <tr>
            <td className={`${td} text-left`}>BASIC</td>
            {b.products.map((p, i) => <td key={p.id} className={`${td} text-right`}>{nRaw(b.totals.basic[i] ?? 0)}</td>)}
            <td className={`${td} text-right`}>{nAmt(b.totals.basicGrand)}</td>
          </tr>
          <tr>
            <td className={`${td} text-left`}>CGST</td>
            {b.products.map((p, i) => <td key={p.id} className={`${td} text-right`}>{nRaw(b.totals.cgst[i] ?? 0)}</td>)}
            <td className={`${td} text-right`}>{nRaw(b.totals.cgstGrand)}</td>
          </tr>
          <tr>
            <td className={`${td} text-left`}>SGST</td>
            {b.products.map((p, i) => <td key={p.id} className={`${td} text-right`}>{nRaw(b.totals.sgst[i] ?? 0)}</td>)}
            <td className={`${td} text-right`}>{nRaw(b.totals.sgstGrand)}</td>
          </tr>
          <tr className="font-semibold">
            <td className={`${td} text-left`}>Amount</td>
            {b.products.map((p, i) => <td key={p.id} className={`${td} text-right`}>{nAmt(b.totals.amount[i] ?? 0)}</td>)}
            <td className={`${td} text-right`}>{nAmt(b.totals.amountGrand)}</td>
          </tr>
        </tfoot>
      </table>

      {/* Notes + signature */}
      <div className="flex justify-between mt-2 text-[9px]">
        <div>
          <div>NOTE: - Kindly acknowledge receipt of this bill immediately.</div>
          <div className="pl-10">- Variation in the above bill if any may be intimated within 15 days.</div>
          <div className="pl-10">- Demand Draft should be issued in favour of "THE MANAGING DIRECTOR HAVERI</div>
          <div className="pl-14">CO-OP MILK PRODUCERS SOCIETIES UNION LTD., HAVERI".</div>
        </div>
        <div className="self-end whitespace-nowrap">AUTHORISED SIGNATURE.</div>
      </div>
    </div>
  );
}

function renderCreditSummaryPage(d: CreditSalesResponse, pageNo: number) {
  return (
    <div className="text-[11px] leading-tight font-mono">
      <div className="flex items-center justify-between mb-1">
        <span className="font-bold">Summary</span>
        <span>Page {pageNo}</span>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-muted/40">
            <th className="border border-border px-2 py-1 text-right w-16">Sl No.</th>
            <th className="border border-border px-2 py-1 text-left w-28">Code</th>
            <th className="border border-border px-2 py-1 text-left">Name</th>
            <th className="border border-border px-2 py-1 text-right w-32">Total</th>
          </tr>
        </thead>
        <tbody>
          {d.summary.map(s => (
            <tr key={s.sl}>
              <td className="border border-border px-2 py-1 text-right">{s.sl}</td>
              <td className="border border-border px-2 py-1">{s.code}</td>
              <td className="border border-border px-2 py-1">{s.name}</td>
              <td className="border border-border px-2 py-1 text-right">{nAmt(s.total)}</td>
            </tr>
          ))}
          <tr className="font-bold bg-muted/40">
            <td className="border border-border px-2 py-1" colSpan={3}>Total</td>
            <td className="border border-border px-2 py-1 text-right">{nAmt(d.summaryTotal)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export const CreditSalesReport = () => (
  <SalesReportShell<CreditSalesResponse>
    title="Credit Sales"
    description="Monthly credit bill — credit institutions only"
    printMeta={null}
    fetcher={(from, to) => fetchCreditSales({ from, to })}
    renderPages={(_from, _to, apiData) => {
      if (!apiData || apiData.customers.length === 0) return [];
      const pages: ReactNode[] = apiData.customers.map((b, i) => (
        <div key={b.id}>{renderCreditBillPage(b, i + 1)}</div>
      ));
      pages.push(
        <div key="summary">{renderCreditSummaryPage(apiData, apiData.customers.length + 1)}</div>
      );
      return pages;
    }}
    buildCsv={(_from, _to, d) => {
      const out: (string | number)[][] = [
        [`Credit Sales (Credit Institutions) — ${d.periodFrom} to ${d.periodTo}`],
      ];
      d.customers.forEach(b => {
        out.push([]);
        out.push([`BILL NO ${b.billNo}`, b.code, b.name]);
        out.push(["Date", ...b.products.map(p => p.reportAlias), "Total Amount"]);
        b.dailyRows
          .filter(r => r.qty.some(q => q > 0))
          .forEach(r => out.push([r.day, ...b.products.map((_, pi) => r.qty[pi] ?? 0), r.dayTotal]));
        out.push(["Pkts", ...b.totals.pkts, ""]);
        out.push(["Kg/ltr", ...b.totals.kgLtr, ""]);
        out.push(["BASIC", ...b.totals.basic, b.totals.basicGrand]);
        out.push(["CGST", ...b.totals.cgst, b.totals.cgstGrand]);
        out.push(["SGST", ...b.totals.sgst, b.totals.sgstGrand]);
        out.push(["Amount", ...b.totals.amount, b.totals.amountGrand]);
      });
      out.push([]);
      out.push(["Summary"]);
      out.push(["Sl No.", "Code", "Name", "Total"]);
      d.summary.forEach(s => out.push([s.sl, s.code, s.name, s.total]));
      out.push(["", "", "Total", d.summaryTotal]);
      return out;
    }}
  />
);

// ─── B7. Taluka / Agent Wise ────────────────────────────────────
// Legacy "Taluka wise agent wise sales statement" layout: one taluka per
// sheet. Each taluka renders a detailed customer × product matrix (split
// across column-pages when it is too wide for the paper) followed by a
// summary page (fixed product columns + Milk / Curd totals + amount).
export const TalukaAgentSales = () => (
  <SalesReportShell<TalukaAgentResponse>
    title="Agent wise sales"
    description="Agent wise sales statement — one taluka per page"
    printOrientation="landscape"
    fetcher={(from, to) => fetchTalukaAgent({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];

      // Cap product columns/page so a landscape A4 fits. Tune after print test.
      const COLUMNS_PER_PAGE = 9;
      const stmt = `Agent wise sales statement · Period ${from} to ${to}`;

      const customerHead = [
        { label: "Sl",   accessor: (r: { sl: number }) => r.sl, width: "30px", num: true },
        { label: "Code", accessor: (r: { code: string }) => r.code, width: "48px" },
        { label: "Customer Name", accessor: (r: { name: string }) => r.name, width: "170px" },
      ];

      // NOTE: the Total/Avg Milk + Total/Avg Curd overview page was removed —
      // it duplicated the Taluka Wise Report's summary page. This report now
      // starts straight at the first taluka's detailed matrix.

      const talukaPages = apiData.talukas.flatMap((t, ti) => {
        const nodes: ReactNode[] = [];

        // ── Detailed product matrix (column-paged) ──
        const productPages = paginateColumns(apiData.products, COLUMNS_PER_PAGE);
        productPages.forEach((prodChunk, pi) => {
          nodes.push(
            <ColumnPagedTable
              key={`d-${ti}-${pi}`}
              title={`Taluka Name: ${t.name}  —  ${stmt}${productPages.length > 1 ? ` · Products ${pi + 1}/${productPages.length}` : ""}`}
              fixedLayout
              productColWidth="78px"
              fixedHead={customerHead}
              productCols={prodChunk}
              productCellRender={(row, p) => {
                const v = row.qty[p.id] ?? 0;
                return v ? fmtQty(v) : "";
              }}
              rows={t.customers}
              rowKey={(r) => r.code || r.sl}
              totalRow={{
                fixedCells: ["", "", "TOTAL"],
                productCell: (p) => fmtQty(t.detailedTotals.qty[p.id] ?? 0),
              }}
            />
          );
        });

        // ── Summary page (cookies + milk/curd totals + amount) ──
        nodes.push(
          <ColumnPagedTable
            key={`s-${ti}`}
            title={`Taluka Name: ${t.name}  —  ${stmt} · Summary`}
            fixedHead={customerHead}
            productCols={[] as ProductLite[]}
            productCellRender={() => null}
            trailingHead={[
              { label: "Milk Total Qty", accessor: (r) => r.milkTotalQty || "", num: true },
              { label: "Curd Total Qty", accessor: (r) => r.curdTotalQty || "", num: true },
              { label: "Total Amt ₹",    accessor: (r) => fmtINR(r.totalAmount), num: true },
            ]}
            rows={t.summary}
            rowKey={(r) => r.code || r.sl}
            totalRow={{
              fixedCells: ["", "", "TOTAL"],
              productCell: () => null,
              trailingCells: [
                fmtQty(t.summaryTotals.milkTotalQty),
                fmtQty(t.summaryTotals.curdTotalQty),
                fmtINR(t.summaryTotals.totalAmount),
              ],
            }}
          />
        );

        return nodes;
      });

      return talukaPages;
    }}
    buildCsv={(from, to, d) => {
      const out: (string | number)[][] = [];
      out.push(["Agent wise sales statement", `Period ${from} to ${to}`]);
      d.talukas.forEach((t) => {
        out.push([]);
        out.push([`Taluka Name: ${t.name}`]);
        // detailed matrix
        out.push(["Sl", "Code", "Customer Name", ...d.products.map((p) => p.reportAlias)]);
        t.customers.forEach((c) =>
          out.push([c.sl, c.code, c.name, ...d.products.map((p) => c.qty[p.id] ?? 0)])
        );
        out.push(["", "", "TOTAL", ...d.products.map((p) => t.detailedTotals.qty[p.id] ?? 0)]);
        // summary
        out.push([]);
        out.push(["Sl", "Code", "Customer Name", "Milk Total Qty", "Curd Total Qty", "Total Amt"]);
        t.summary.forEach((s) =>
          out.push([s.sl, s.code, s.name, s.milkTotalQty, s.curdTotalQty, s.totalAmount])
        );
        out.push([
          "", "", "TOTAL",
          t.summaryTotals.milkTotalQty, t.summaryTotals.curdTotalQty, t.summaryTotals.totalAmount,
        ]);
      });
      return out;
    }}
  />
);

// ─── B7b. Taluka Wise Report ────────────────────────────────────
// Three pages for a chosen period: milk sales (In Ltrs) per taluka ×
// milk product, the same for curd (In Kgs), and a per-taluka summary
// of Total / Avg Milk + Total / Avg Curd. Volumes come from the API
// (packets × pack_size), so this only formats + paginates them.
export const TalukaWiseReport = () => (
  <SalesReportShell<TalukaWiseResponse>
    title="Taluka Wise Report"
    description="Taluka wise milk (Ltrs) & curd (Kgs) sales with totals & averages"
    printOrientation="landscape"
    fetcher={(from, to) => fetchTalukaWise({ from, to })}
    renderPages={(from, to, d) => {
      if (!d) return [];

      const fmtVol = (n: number) =>
        Number(n || 0).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      // Cap product columns/page so a landscape A4 fits. Tune after print test.
      const COLS_PER_PAGE = 12;
      const taluka = { label: "Taluka", accessor: (r: TalukaWiseRow) => r.taluka, width: "180px" };
      const pages: ReactNode[] = [];

      // ── Page 1: Milk sales (In Ltrs) — taluka × milk product ──
      const milkChunks = paginateColumns(d.milkProducts, COLS_PER_PAGE);
      milkChunks.forEach((chunk, pi) => {
        const isLast = pi === milkChunks.length - 1;
        pages.push(
          <ColumnPagedTable
            key={`milk-${pi}`}
            title={`Taluka Wise Milk Sales (In Ltrs) · Period ${from} to ${to}${milkChunks.length > 1 ? ` · Products ${pi + 1}/${milkChunks.length}` : ""}`}
            fixedLayout
            productColWidth="78px"
            fixedHead={[taluka]}
            productCols={chunk}
            productCellRender={(row, p) => {
              const v = row.milkQty[p.id] ?? 0;
              return v ? fmtVol(v) : "";
            }}
            trailingHead={isLast ? [{ label: "Total Milk (Ltrs)", accessor: (r) => fmtVol(r.totalMilk), num: true, width: "110px" }] : undefined}
            rows={d.rows}
            rowKey={(r) => r.taluka}
            totalRow={{
              fixedCells: ["TOTAL"],
              productCell: (p) => fmtVol(d.totals.milkQty[p.id] ?? 0),
              trailingCells: isLast ? [fmtVol(d.totals.totalMilk)] : undefined,
            }}
          />
        );
      });

      // ── Page 2: Curd sales (In Kgs) — taluka × curd product ──
      const curdChunks = paginateColumns(d.curdProducts, COLS_PER_PAGE);
      curdChunks.forEach((chunk, pi) => {
        const isLast = pi === curdChunks.length - 1;
        pages.push(
          <ColumnPagedTable
            key={`curd-${pi}`}
            title={`Taluka Wise Curd Sales (In Kgs) · Period ${from} to ${to}${curdChunks.length > 1 ? ` · Products ${pi + 1}/${curdChunks.length}` : ""}`}
            fixedLayout
            productColWidth="78px"
            fixedHead={[taluka]}
            productCols={chunk}
            productCellRender={(row, p) => {
              const v = row.curdQty[p.id] ?? 0;
              return v ? fmtVol(v) : "";
            }}
            trailingHead={isLast ? [{ label: "Total Curd (Kgs)", accessor: (r) => fmtVol(r.totalCurd), num: true, width: "110px" }] : undefined}
            rows={d.rows}
            rowKey={(r) => r.taluka}
            totalRow={{
              fixedCells: ["TOTAL"],
              productCell: (p) => fmtVol(d.totals.curdQty[p.id] ?? 0),
              trailingCells: isLast ? [fmtVol(d.totals.totalCurd)] : undefined,
            }}
          />
        );
      });

      // ── Page 3: Other sales — taluka × non-milk/curd product ──
      // Same layout as the milk/curd pages, for everything else (lassi,
      // buttermilk, ghee, paneer, sweets, …). Only rendered when such
      // products exist in the period.
      const otherChunks = paginateColumns(d.otherProducts, COLS_PER_PAGE);
      if (d.otherProducts.length > 0) {
        otherChunks.forEach((chunk, pi) => {
          const isLast = pi === otherChunks.length - 1;
          pages.push(
            <ColumnPagedTable
              key={`other-${pi}`}
              title={`Taluka Wise Other Sales (Qty) · Period ${from} to ${to}${otherChunks.length > 1 ? ` · Products ${pi + 1}/${otherChunks.length}` : ""}`}
              fixedLayout
              productColWidth="78px"
              fixedHead={[taluka]}
              productCols={chunk}
              productCellRender={(row, p) => {
                const v = row.otherQty[p.id] ?? 0;
                return v ? fmtVol(v) : "";
              }}
              trailingHead={isLast ? [{ label: "Total Other", accessor: (r) => fmtVol(r.totalOther), num: true, width: "110px" }] : undefined}
              rows={d.rows}
              rowKey={(r) => r.taluka}
              totalRow={{
                fixedCells: ["TOTAL"],
                productCell: (p) => fmtVol(d.totals.otherQty[p.id] ?? 0),
                trailingCells: isLast ? [fmtVol(d.totals.totalOther)] : undefined,
              }}
            />
          );
        });
      }

      // ── Final page: Summary — Total / Avg per taluka for all three groups ──
      pages.push(
        <ColumnPagedTable
          key="summary"
          title={`Taluka Wise Summary · Period ${from} to ${to} · ${d.numDays} day(s)`}
          fixedHead={[{ ...taluka, width: "200px" }]}
          productCols={[] as ProductLite[]}
          productCellRender={() => null}
          trailingHead={[
            { label: "Total Milk (Ltrs)", accessor: (r) => fmtVol(r.totalMilk), num: true, width: "110px" },
            { label: "Avg Milk (Ltrs)",   accessor: (r) => fmtVol(r.avgMilk),   num: true, width: "110px" },
            { label: "Total Curd (Kgs)",  accessor: (r) => fmtVol(r.totalCurd), num: true, width: "110px" },
            { label: "Avg Curd (Kgs)",    accessor: (r) => fmtVol(r.avgCurd),   num: true, width: "110px" },
            { label: "Total Other",       accessor: (r) => fmtVol(r.totalOther), num: true, width: "110px" },
            { label: "Avg Other",         accessor: (r) => fmtVol(r.avgOther),   num: true, width: "110px" },
          ]}
          rows={d.rows}
          rowKey={(r) => r.taluka}
          totalRow={{
            fixedCells: ["TOTAL"],
            productCell: () => null,
            trailingCells: [
              fmtVol(d.totals.totalMilk), fmtVol(d.totals.avgMilk),
              fmtVol(d.totals.totalCurd), fmtVol(d.totals.avgCurd),
              fmtVol(d.totals.totalOther), fmtVol(d.totals.avgOther),
            ],
          }}
        />
      );

      return pages;
    }}
    buildCsv={(from, to, d) => {
      const out: (string | number)[][] = [];
      // Milk (In Ltrs)
      out.push([`Taluka Wise Milk Sales (In Ltrs) — ${from} to ${to}`]);
      out.push(["Taluka", ...d.milkProducts.map((p) => p.reportAlias), "Total Milk (Ltrs)"]);
      d.rows.forEach((r) => out.push([r.taluka, ...d.milkProducts.map((p) => r.milkQty[p.id] ?? 0), r.totalMilk]));
      out.push(["TOTAL", ...d.milkProducts.map((p) => d.totals.milkQty[p.id] ?? 0), d.totals.totalMilk]);
      out.push([]);
      // Curd (In Kgs)
      out.push([`Taluka Wise Curd Sales (In Kgs) — ${from} to ${to}`]);
      out.push(["Taluka", ...d.curdProducts.map((p) => p.reportAlias), "Total Curd (Kgs)"]);
      d.rows.forEach((r) => out.push([r.taluka, ...d.curdProducts.map((p) => r.curdQty[p.id] ?? 0), r.totalCurd]));
      out.push(["TOTAL", ...d.curdProducts.map((p) => d.totals.curdQty[p.id] ?? 0), d.totals.totalCurd]);
      out.push([]);
      // Other (Qty)
      if (d.otherProducts.length > 0) {
        out.push([`Taluka Wise Other Sales (Qty) — ${from} to ${to}`]);
        out.push(["Taluka", ...d.otherProducts.map((p) => p.reportAlias), "Total Other"]);
        d.rows.forEach((r) => out.push([r.taluka, ...d.otherProducts.map((p) => r.otherQty[p.id] ?? 0), r.totalOther]));
        out.push(["TOTAL", ...d.otherProducts.map((p) => d.totals.otherQty[p.id] ?? 0), d.totals.totalOther]);
        out.push([]);
      }
      // Summary
      out.push([`Taluka Wise Summary — ${from} to ${to} (${d.numDays} days)`]);
      out.push(["Taluka", "Total Milk (Ltrs)", "Avg Milk (Ltrs)", "Total Curd (Kgs)", "Avg Curd (Kgs)", "Total Other", "Avg Other"]);
      d.rows.forEach((r) => out.push([r.taluka, r.totalMilk, r.avgMilk, r.totalCurd, r.avgCurd, r.totalOther, r.avgOther]));
      out.push(["TOTAL", d.totals.totalMilk, d.totals.avgMilk, d.totals.totalCurd, d.totals.avgCurd, d.totals.totalOther, d.totals.avgOther]);
      return out;
    }}
  />
);

// ─── B8. Adhoc Sales ────────────────────────────────────────────
export const AdhocSalesReport = () => (
  <SalesReportShell<AdhocResponse>
    title="Adhoc Sales"
    description="One-off direct sales not tied to a route"
    fetcher={(from, to) => fetchAdhocSales({ from, to, limit: 500 })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      return [(
        <div key="p1">
          <ReportHeader title="Adhoc Sales" subtitle={`Period: ${from} to ${to}`} />
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border border-border py-1 px-1.5 text-left font-bold">Date</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Bill #</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Customer</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Items</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Amount ₹</th>
              </tr>
            </thead>
            <tbody>
              {apiData.rows.map((r: any) => (
                <tr key={r.id}>
                  <td className="border border-border py-0.5 px-1.5">{r.date}</td>
                  <td className="border border-border py-0.5 px-1.5 font-mono">{r.billNo}</td>
                  <td className="border border-border py-0.5 px-1.5">{r.customerName ?? "—"}</td>
                  <td className="border border-border py-0.5 px-1.5 text-[10px] text-muted-foreground">{r.itemsText}</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtINR(r.amount)}</td>
                </tr>
              ))}
              <tr className="font-bold bg-muted/40">
                <td colSpan={4} className="border border-border py-1 px-1.5 text-right">TOTAL</td>
                <td className="border border-border py-1 px-1.5 text-right num">{fmtINR(apiData.totalAmount ?? 0)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
    buildCsv={(from, to, d) => {
      const out: any[][] = [["Date", "Bill #", "Customer", "Items", "Amount ₹"]];
      d.rows.forEach(r => out.push([r.indentDate, r.gpNo, r.customerName ?? "", "", r.amount]));
      out.push(["", "", "", "TOTAL", d.totalAmount ?? 0]);
      return out;
    }}
  />
);

// ─── B9. GST Sales Statement ────────────────────────────────────
export const GSTStatement = () => (
  <SalesReportShell<GstStatementResponse>
    title="GST Statement"
    description="GSTR-1 style summary by HSN"
    fetcher={(from, to) => fetchGstStatement({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      return [(
        <div key="p1">
          <ReportHeader title="GST Sales Statement" subtitle={`Period: ${from} to ${to}`} />
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border border-border py-1 px-1.5 text-left font-bold w-10">Sl</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Product</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">HSN</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Qty</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">GST %</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Taxable ₹</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">CGST ₹</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">SGST ₹</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Total ₹</th>
              </tr>
            </thead>
            <tbody>
              {apiData.rows.map(r => (
                <tr key={r.productId}>
                  <td className="border border-border py-0.5 px-1.5 num text-right">{r.sl}</td>
                  <td className="border border-border py-0.5 px-1.5">{r.productName}</td>
                  <td className="border border-border py-0.5 px-1.5 font-mono">{r.hsn}</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtQty(r.qty)}</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{r.gstPct}%</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtINR(r.taxableValue)}</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtINR(r.cgst)}</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtINR(r.sgst)}</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtINR(r.invoiceValue)}</td>
                </tr>
              ))}
              <tr className="font-bold bg-muted/40">
                <td colSpan={3} className="border border-border py-1 px-1.5 text-right">TOTAL</td>
                <td className="border border-border py-1 px-1.5 text-right num">{fmtQty(apiData.totals.qty)}</td>
                <td className="border border-border py-1 px-1.5"></td>
                <td className="border border-border py-1 px-1.5 text-right num">{fmtINR(apiData.totals.taxableValue)}</td>
                <td className="border border-border py-1 px-1.5 text-right num">{fmtINR(apiData.totals.cgst)}</td>
                <td className="border border-border py-1 px-1.5 text-right num">{fmtINR(apiData.totals.sgst)}</td>
                <td className="border border-border py-1 px-1.5 text-right num">{fmtINR(apiData.totals.invoiceValue)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
    buildCsv={(from, to, d) => {
      const out: any[][] = [["Sl", "Product", "HSN", "Qty", "GST %", "Taxable ₹", "CGST ₹", "SGST ₹", "Total ₹"]];
      d.rows.forEach(r => out.push([
        r.sl, r.productName, r.hsn, r.qty, r.gstPct,
        r.taxableValue, r.cgst, r.sgst, r.invoiceValue
      ]));
      out.push(["", "TOTAL", "", d.totals.qty, "", d.totals.taxableValue, d.totals.cgst, d.totals.sgst, d.totals.invoiceValue]);
      return out;
    }}
  />
);

// ─── B11. VIP Sales (Free Samples) ──────────────────────────────
export const VipSalesReport = () => (
  <SalesReportShell<VipSalesResponse>
    title="VIP Sales"
    description="Complimentary samples issued to VIP contacts"
    fetcher={(from, to) => fetchVipSales({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      return [(
        <div key="p1">
          <ReportHeader title="VIP Sales (Free Samples)" subtitle={`Period: ${from} to ${to}`} />
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border border-border py-1 px-1.5 text-left font-bold w-10">Sl</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Date</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">GP #</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">VIP Name</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Designation</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Items</th>
                <th className="border border-border py-1 px-1.5 text-center font-bold num">Qty</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Value ₹</th>
              </tr>
            </thead>
            <tbody>
              {apiData.rows.map(r => (
                <tr key={r.sl}>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{r.sl}</td>
                  <td className="border border-border py-0.5 px-1.5">{r.date}</td>
                  <td className="border border-border py-0.5 px-1.5 font-mono">{r.gpNo}</td>
                  <td className="border border-border py-0.5 px-1.5">{r.vipName || "—"}</td>
                  <td className="border border-border py-0.5 px-1.5 text-muted-foreground">{r.designation ?? "—"}</td>
                  <td className="border border-border py-0.5 px-1.5 text-[10px] text-muted-foreground">{r.itemsText}</td>
                  <td className="border border-border py-0.5 px-1.5 text-center num">{fmtQty(r.totalQty)}</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtINR(r.value)}</td>
                </tr>
              ))}
              <tr className="font-bold bg-muted/40">
                <td colSpan={6} className="border border-border py-1 px-1.5 text-right">TOTAL</td>
                <td className="border border-border py-1 px-1.5 text-center num">{fmtQty(apiData.totalQty)}</td>
                <td className="border border-border py-1 px-1.5 text-right num">{fmtINR(apiData.totalValue)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
    buildCsv={(from, to, d) => {
      const out: any[][] = [
        [`VIP Sales (Free Samples) — ${from} to ${to}`],
        ["Sl", "Date", "GP #", "VIP Name", "Designation", "Items", "Qty", "Value ₹"],
      ];
      d.rows.forEach(r => out.push([
        r.sl, r.date, r.gpNo, r.vipName, r.designation ?? "", r.itemsText, r.totalQty, r.value,
      ]));
      out.push(["", "", "", "", "", "TOTAL", d.totalQty, d.totalValue]);
      return out;
    }}
  />
);