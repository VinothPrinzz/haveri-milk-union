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
  fetchTalukaAgent, fetchAdhocSales, fetchGstStatement,
  type DailyStatementResponse, type DayRouteCashResponse,
  type OfficerWiseResponse, type SalesGridResponse, type SalesGridRoute,
  type CreditSalesResponse, type TalukaAgentResponse,
  type AdhocResponse, type GstStatementResponse,
} from "@/services/report";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import { ColumnPagedTable, paginateColumns } from "@/lib/reportColumnPaging";

const fmtQty = (n: number | string) => String(Number(n || 0));

// ─────────────────────────────────────────────────────────────
// Shared shell — wraps every sales report
// ─────────────────────────────────────────────────────────────
function SalesReportShell<T>({
  title, description,
  fetcher,
  renderPages,
  buildCsv,
  printOrientation = "portrait",
}: {
  title: string;
  description: string;
  fetcher: (from: string, to: string) => Promise<T>;
  renderPages: (from: string, to: string, data: T | undefined) => ReactNode[];
  buildCsv?: (from: string, to: string, data: T) => (string | number | null | undefined)[][];
  printOrientation?: "portrait" | "landscape";
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
      printMeta={
        <ReportPrintMeta/>
      }
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

// ─── B1. Daily Sales Statement ──────────────────────────────────
export const DailySalesStatement = () => (
  <SalesReportShell<DailyStatementResponse>
    title="Daily Sales Statement"
    description="DMU items daily sales (own production)"
    fetcher={(from, to) => fetchDailyStatement({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
    
      return apiData.groups.flatMap((group, gi) => {
        const productPages = paginateColumns(group.products, 12);
    
        return productPages.map((prodChunk, pi) => (
          <ColumnPagedTable
            key={`${gi}-${pi}`}
            title={`Daily Sales Statement — ${group.label} • Cols ${pi + 1}/${productPages.length}`}
            fixedHead={[{ label: "Date", accessor: r => r.date }]}
            productCols={prodChunk}
            productCellRender={(row, p) => fmtQty(row.qty[p.id] ?? 0)}
            trailingHead={[
              { label: "Total Amount", accessor: r => fmtINR(r.totalAmount), num: true }
            ]}
            rows={group.rows}
            totalRow={{
              fixedCells: ["TOTAL"],
              productCell: (p) => fmtQty(group.totals.qty[p.id] ?? 0),
              trailingCells: [fmtINR(group.totals.totalAmount)],
            }}
          />
        ));
      });
    }}
    buildCsv={(from, to, d) => {
      const out: any[][] = [];
      d.groups.forEach(g => {
        out.push([`${g.label} — ${from} to ${to}`]);
        out.push(["Date", ...g.products.map(p => p.reportAlias), "Total Amount"]);
        g.rows.forEach(row =>
          out.push([row.date, ...g.products.map(p => row.qty[p.id] ?? 0), row.totalAmount])
        );
        out.push(["TOTAL", ...g.products.map(p => g.totals.qty[p.id] ?? 0), g.totals.totalAmount]);
        out.push([]); // blank line between groups
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
      return [(
        <div key="p1">
          <ReportHeader title="Day/Route Wise Cash Sales" subtitle={`Period: ${from} to ${to}`} />
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border border-border py-1.5 px-2 text-left font-bold">Indent Date</th>
                {apiData.routes.map(r => <th key={r.id} className="border border-border py-1.5 px-2 text-center font-bold">{r.name}</th>)}
                <th className="border border-border py-1.5 px-2 text-right font-bold num">Total</th>
              </tr>
            </thead>
            <tbody>
              {apiData.dates.map(d => (
                <tr key={d}>
                  <td className="border border-border py-1 px-2 font-medium">{d}</td>
                  {apiData.routes.map(r => (
                    <td key={r.id} className="border border-border py-1 px-2 text-right num">{fmtINR(apiData.matrix[d]?.[r.id] ?? 0)}</td>
                  ))}
                  <td className="border border-border py-1 px-2 text-right font-bold num">{fmtINR(apiData.dayTotals[d] ?? 0)}</td>
                </tr>
              ))}
              <tr className="font-bold bg-muted/40">
                <td className="border border-border py-1.5 px-2">TOTAL</td>
                {apiData.routes.map(r => <td key={r.id} className="border border-border py-1.5 px-2 text-right num">{fmtINR(apiData.routeTotals[r.id] ?? 0)}</td>)}
                <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(apiData.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
    buildCsv={(from, to, d) => {
      const out: any[][] = [];
      out.push(["Day/Route Wise Cash Sales", `${from} to ${to}`]);
      out.push(["Date", ...d.routes.map(r => r.name), "Total"]);
      d.dates.forEach(date => {
        out.push([
          date,
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
      return [(
        <div key="p1">
          <ReportHeader title="Officer Wise Sales" subtitle={`Period: ${from} to ${to}`} />
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
                    <td key={o.id} className="border border-border py-1 px-2 text-right num">{fmtQty(apiData.matrix[p.id]?.[o.id] ?? 0)}</td>
                  ))}
                  <td className="border border-border py-1 px-2 text-right font-bold num">{fmtQty(apiData.productTotals[p.id] ?? 0)}</td>
                </tr>
              ))}
              <tr className="font-bold bg-muted/40">
                <td className="border border-border py-1.5 px-2">TOTAL</td>
                {apiData.officers.map(o => <td key={o.id} className="border border-border py-1.5 px-2 text-right num">{fmtQty(apiData.officerTotals[o.id] ?? 0)}</td>)}
                <td className="border border-border py-1.5 px-2 text-right num">{fmtQty(apiData.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
    buildCsv={(from, to, d) => {
      const out: any[][] = [["Product", ...d.officers.map(o => o.name), "Total"]];
      d.products.forEach(p => out.push([
        p.reportAlias,
        ...d.officers.map(o => d.matrix[p.id]?.[o.id] ?? 0),
        d.productTotals[p.id] ?? 0
      ]));
      out.push(["TOTAL", ...d.officers.map(o => d.officerTotals[o.id] ?? 0), d.grandTotal]);
      return out;
    }}
  />
);

const ROUTES_PER_PAGE = 8; // adjust for A4 landscape fit
 
export const CashSalesReport = () => (
  <SalesReportShell<SalesGridResponse>
    title="Cash Sales"
    description="Cash-mode sales grid by product × route"
    fetcher={(from, to) => fetchCashSales({ from, to })}
    printOrientation="landscape"
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
 
      // Paginate ROUTES into column chunks
      const routePages = paginateColumns(apiData.routes, ROUTES_PER_PAGE);
      const pageCount = routePages.length;
 
      return routePages.map((routeChunk, pageIdx) => {
        // Per-route qty grand total (across all products in the response)
        const routeQtyTotal = (r: SalesGridRoute) =>
          apiData.products.reduce((s, p) => s + (r.qty[p.id] ?? 0), 0);
 
        // Grand qty total (bottom-right corner)
        const grandQtyTotal = apiData.products.reduce(
          (s, p) => s + (apiData.totals.qty[p.id] ?? 0),
          0
        );
 
        return (
          <div key={pageIdx} className="report-page">
            <ReportHeader
              title="Cash Sales"
              subtitle={`Period: ${from} to ${to} · Columns ${pageIdx + 1}/${pageCount}`}
            />
 
            <table className="w-full text-[11px] border-collapse">
              <thead>
                {/* Row 1: route codes */}
                <tr className="bg-muted/50">
                  <th className="border border-border py-1.5 px-2 text-left font-bold">
                    Product
                  </th>
                  {routeChunk.map(r => (
                    <th
                      key={r.id}
                      className="border border-border py-1 px-2 text-center font-bold"
                    >
                      <div className="font-mono text-[10px] text-muted-foreground">{r.code}</div>
                      <div>{r.name}</div>
                      <div className="font-normal text-[9.5px] text-muted-foreground truncate max-w-[90px]">
                        {r.contractorName ?? ""}
                      </div>
                    </th>
                  ))}
                  {/* Grand-total column only on the last page */}
                  {pageIdx === pageCount - 1 && (
                    <th className="border border-border py-1.5 px-2 text-right font-bold num">
                      Total Qty
                    </th>
                  )}
                </tr>
              </thead>
 
              <tbody>
                {apiData.products.map(p => (
                  <tr key={p.id}>
                    <td className="border border-border py-1 px-2 font-medium">
                      {p.reportAlias}
                    </td>
                    {routeChunk.map(r => (
                      <td
                        key={r.id}
                        className="border border-border py-1 px-2 text-right num"
                      >
                        {fmtQty(r.qty[p.id] ?? 0)}
                      </td>
                    ))}
                    {/* Row total (grand total across ALL routes, not just this chunk) */}
                    {pageIdx === pageCount - 1 && (
                      <td className="border border-border py-1 px-2 text-right font-bold num">
                        {fmtQty(apiData.totals.qty[p.id] ?? 0)}
                      </td>
                    )}
                  </tr>
                ))}
 
                {/* ── TOTAL QTY row ── */}
                <tr className="font-bold bg-muted/40">
                  <td className="border border-border py-1.5 px-2">TOTAL</td>
                  {routeChunk.map(r => (
                    <td
                      key={r.id}
                      className="border border-border py-1.5 px-2 text-right num"
                    >
                      {fmtQty(routeQtyTotal(r))}
                    </td>
                  ))}
                  {pageIdx === pageCount - 1 && (
                    <td className="border border-border py-1.5 px-2 text-right num">
                      {fmtQty(grandQtyTotal)}
                    </td>
                  )}
                </tr>
 
                {/* ── TOTAL AMOUNT row — only on last page ── */}
                {pageIdx === pageCount - 1 && (
                  <>
                    <tr className="font-bold bg-muted/20">
                      <td className="border border-border py-1 px-2">Milk ₹</td>
                      {routeChunk.map(r => (
                        <td
                          key={r.id}
                          className="border border-border py-1 px-2 text-right num"
                        >
                          {fmtINR(r.milkAmount)}
                        </td>
                      ))}
                      <td className="border border-border py-1 px-2 text-right num">
                        {fmtINR(apiData.totals.milkAmount)}
                      </td>
                    </tr>
                    <tr className="font-bold bg-muted/20">
                      <td className="border border-border py-1 px-2">Product ₹</td>
                      {routeChunk.map(r => (
                        <td
                          key={r.id}
                          className="border border-border py-1 px-2 text-right num"
                        >
                          {fmtINR(r.productAmount)}
                        </td>
                      ))}
                      <td className="border border-border py-1 px-2 text-right num">
                        {fmtINR(apiData.totals.productAmount)}
                      </td>
                    </tr>
                    <tr className="font-bold bg-muted/40">
                      <td className="border border-border py-1.5 px-2">Total ₹</td>
                      {routeChunk.map(r => (
                        <td
                          key={r.id}
                          className="border border-border py-1.5 px-2 text-right num"
                        >
                          {fmtINR(r.total)}
                        </td>
                      ))}
                      <td className="border border-border py-1.5 px-2 text-right num">
                        {fmtINR(apiData.totals.total)}
                      </td>
                    </tr>
                  </>
                )}
              </tbody>
            </table>
          </div>
        );
      });
    }}
 
    buildCsv={(from, to, d) => {
      // CSV: product rows × route columns (transposed)
      const header = [
        "Product",
        ...d.routes.map(r => `${r.code} ${r.name}`),
        "Total Qty",
      ];
      const rows: (string | number)[][] = [header];
 
      d.products.forEach(p => {
        rows.push([
          p.reportAlias,
          ...d.routes.map(r => r.qty[p.id] ?? 0),
          d.totals.qty[p.id] ?? 0,
        ]);
      });
 
      // Total qty row
      rows.push([
        "TOTAL QTY",
        ...d.routes.map(r =>
          d.products.reduce((s, p) => s + (r.qty[p.id] ?? 0), 0)
        ),
        d.products.reduce((s, p) => s + (d.totals.qty[p.id] ?? 0), 0),
      ]);
      // Milk ₹ row
      rows.push(["Milk ₹",    ...d.routes.map(r => r.milkAmount),    d.totals.milkAmount]);
      // Product ₹ row
      rows.push(["Product ₹", ...d.routes.map(r => r.productAmount), d.totals.productAmount]);
      // Total ₹ row
      rows.push(["Total ₹",   ...d.routes.map(r => r.total),         d.totals.total]);
 
      return rows;
    }}
  />
);

// ─── Sales Register ─────────────────────────────────────────────
export const SalesRegister = () => (
  <SalesReportShell<SalesGridResponse>
    title="Sales Register"
    description="All sales (cash + credit) by route × product"
    fetcher={(from, to) => fetchSalesRegister({ from, to })}
    printOrientation="landscape"
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];

      const COLUMNS_PER_PAGE = 10; // Adjust after print testing

      const productPages = paginateColumns(apiData.products, COLUMNS_PER_PAGE);

      return productPages.map((productChunk, i) => (
        <ColumnPagedTable
          key={i}
          title={`Sales Register • Columns ${i + 1} of ${productPages.length}`}
          // pageInfo={{ current: i + 1, total: productPages.length }} // alternative

          fixedHead={[
            { label: "Code", accessor: r => r.code },
            { label: "Route", accessor: r => r.name },
            { label: "Contractor", accessor: r => r.contractorName ?? "—" },
          ]}

          productCols={productChunk}
          productCellRender={(row, prod) => fmtQty(row.qty[prod.id] ?? 0)}

          trailingHead={[
            { label: "Milk ₹", accessor: r => fmtINR(r.milkAmount), num: true },
            { label: "Product ₹", accessor: r => fmtINR(r.productAmount), num: true },
            { label: "Total ₹", accessor: r => fmtINR(r.total), num: true },
          ]}

          rows={apiData.routes}
          rowKey={r => r.id}

          totalRow={{
            fixedCells: ["TOTAL", "", ""],
            productCell: (prod) => fmtQty(apiData.totals.qty[prod.id] ?? 0),
            trailingCells: [
              fmtINR(apiData.totals.milkAmount),
              fmtINR(apiData.totals.productAmount),
              fmtINR(apiData.totals.total),
            ],
          }}
        />
      ));
    }}
    buildCsv={buildSalesGridCsv}
  />
);

// ─── B5. Credit Sales ───────────────────────────────────────────
export const CreditSalesReport = () => (
  <SalesReportShell<CreditSalesResponse>
    title="Credit Sales"
    description="Credit-bill format with per-customer breakdown"
    fetcher={(from, to) => fetchCreditSales({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      return apiData.customers.map((b, i) => (
        <div key={i}>
          <ReportHeader title="Credit Sales" subtitle={`${b.name} · Period: ${from} to ${to}`} />
          <div className="text-[11px] mb-2 grid grid-cols-2 gap-1">
            <div><strong>Customer Code:</strong> {b.code}</div>
            <div><strong>Address:</strong> {b.address ?? "—"}</div>
            {b.gstNumber && <div><strong>GSTIN:</strong> <span className="font-mono">{b.gstNumber}</span></div>}
            <div><strong>Bill #:</strong> {b.billNo}</div>
            <div><strong>Period:</strong> {b.periodFrom} — {b.periodTo}</div>
          </div>
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border border-border py-1 px-1.5 text-left font-bold">Day</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Date</th>
                {b.products.map(p => (
                  <th key={p.id} className="border border-border py-1 px-1.5 text-center font-bold">{p.reportAlias}</th>
                ))}
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Day Total ₹</th>
              </tr>
            </thead>
            <tbody>
              {b.dailyRows.map((row, j) => (
                <tr key={j}>
                  <td className="border border-border py-0.5 px-1.5 text-center">{row.day}</td>
                  <td className="border border-border py-0.5 px-1.5">{row.date}</td>
                  {b.products.map((p, pi) => (
                    <td key={p.id} className="border border-border py-0.5 px-1.5 text-center num">{fmtQty(row.qty[pi] ?? 0)}</td>
                  ))}
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtINR(row.dayTotal)}</td>
                </tr>
              ))}
              <tr className="font-bold bg-muted/40">
                <td colSpan={2} className="border border-border py-1 px-1.5 text-right">TOTAL</td>
                {b.products.map((p, pi) => (
                  <td key={p.id} className="border border-border py-1 px-1.5 text-center num">{fmtQty(b.totals.pkts[pi] ?? 0)}</td>
                ))}
                <td className="border border-border py-1 px-1.5 text-right num">{fmtINR(b.totals.amountGrand)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ));
    }}
    buildCsv={buildSalesGridCsv as any}   // Using grid helper as per your instruction
  />
);

// ─── B7. Taluka / Agent Wise ────────────────────────────────────
export const TalukaAgentSales = () => (
  <SalesReportShell<TalukaAgentResponse>
    title="Taluka / Agent Wise Sales"
    description="Sales aggregated by taluka and agent"
    fetcher={(from, to) => fetchTalukaAgent({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      return [(
        <div key="p1">
          <ReportHeader title="Taluka / Agent Wise Sales" subtitle={`Period: ${from} to ${to}`} />
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border border-border py-1.5 px-2 text-left font-bold">Taluka</th>
                <th className="border border-border py-1.5 px-2 text-left font-bold">Agent</th>
                <th className="border border-border py-1.5 px-2 text-right font-bold num">Orders</th>
                <th className="border border-border py-1.5 px-2 text-right font-bold num">Quantity</th>
                <th className="border border-border py-1.5 px-2 text-right font-bold num">Amount ₹</th>
              </tr>
            </thead>
            <tbody>
              {apiData.talukas.flatMap((t, ti) =>
                t.customers.map((r: any, i: number) => (
                  <tr key={`${ti}-${i}`}>
                    <td className="border border-border py-1 px-2 font-medium">{i === 0 ? t.name : ""}</td>
                    <td className="border border-border py-1 px-2">{r.name}</td>
                    <td className="border border-border py-1 px-2 text-right num">{fmtQty(r.orders ?? 0)}</td>
                    <td className="border border-border py-1 px-2 text-right num">{fmtQty(r.total ?? 0)}</td>
                    <td className="border border-border py-1 px-2 text-right num">{fmtINR(r.amount ?? r.total ?? 0)}</td>
                  </tr>
                ))
              )}
              <tr className="font-bold bg-muted/40">
                <td colSpan={2} className="border border-border py-1.5 px-2 text-right">TOTAL</td>
                <td className="border border-border py-1.5 px-2 text-right num">—</td>
                <td className="border border-border py-1.5 px-2 text-right num">—</td>
                <td className="border border-border py-1.5 px-2 text-right num">—</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
    buildCsv={(from, to, d) => {
      const out: any[][] = [["Taluka", "Agent", "Orders", "Quantity", "Amount ₹"]];
      d.talukas.forEach(t => {
        t.customers.forEach(r => {
          const quantity = Object.values(r.qty ?? {}).reduce((sum, n) => sum + (Number(n) || 0), 0);
          out.push([t.name || "", r.name, 0, quantity, r.total ?? 0]);
        });
      });
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