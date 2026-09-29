import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { fmtINR } from "@/components/PageHeader";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import {
  fetchDailyStatement, fetchDayRouteCash, fetchOfficerWise,
  fetchCashSales, fetchSalesRegister, fetchCreditSales,
  fetchTalukaAgent, fetchAdhocSales, fetchGstStatement, fetchVipSales,
  fetchTalukaWise, fetchAgentSales,
  type DailyStatementResponse, type DayRouteCashResponse,
  type OfficerWiseResponse, type SalesGridResponse,
  type CreditSalesResponse, type CreditBillCustomer, type TalukaAgentResponse,
  type AdhocResponse, type GstStatementResponse, type VipSalesResponse,
  type TalukaWiseResponse, type TalukaWiseRow, type AgentSalesResponse,
  type ProductLite, type SaleType,
} from "@/services/report";
import { fetchCustomers } from "@/services/api";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import { ColumnPagedTable, paginateColumns, type ColumnDef } from "@/lib/reportColumnPaging";
import { computeKgLtr } from "@/lib/kgLtr";
import { todayIST } from "@/lib/istDate";
import { payModeLabel } from "@/lib/payMode";

const fmtQty = (n: number | string) => String(Number(n || 0));

// dd-mm-yyyy — the on-paper date format the union uses across sales reports.
const fmtDMY = (iso: string) => {
  const [y, m, d] = (iso ?? "").split("-");
  return y && m && d ? `${d}-${m}-${y}` : (iso ?? "");
};
const fmtPeriod = (from: string, to: string) => `${fmtDMY(from)} to ${fmtDMY(to)}`;

// Ltr/Kg volume: blank for 0 (keeps grids readable), else up to 2 decimals.
const fmtVol = (n: number) =>
  n ? Number(n).toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "";

// Volume of one product column's packet count, using its DB pack_size + unit.
const volOf = (packets: number, p: { packSize?: number; unit?: string }) =>
  computeKgLtr(packets, p.packSize ?? 0, p.unit ?? "");

/** "Ltr" / "Kg" for a product's unit (ml counts as Ltr, g as Kg). */
const volUnit = (unit?: string) => {
  const u = (unit ?? "").trim().toLowerCase();
  if (u === "l" || u === "ltr" || u === "litre" || u === "liter" || u === "ml") return "Ltr";
  if (u === "kg" || u === "g" || u === "gm" || u === "gram" || u === "grams") return "Kg";
  return unit ?? "";
};

// Sales Type filter: which rail a report reads. Cash is the default.
const SALE_TYPE_OPTIONS: { value: SaleType; label: string }[] = [
  { value: "cash", label: "Cash" },
  { value: "credit", label: "Credit" },
  { value: "all", label: "Cash + Credit" },
];
const saleTypeLabel = (t?: SaleType) =>
  SALE_TYPE_OPTIONS.find(o => o.value === t)?.label ?? "Cash";

// ─────────────────────────────────────────────────────────────
// Shared shell — wraps every sales report
// ─────────────────────────────────────────────────────────────
function SalesReportShell<T>({
  title, description,
  fetcher,
  renderPages,
  buildCsv,
  printOrientation = "portrait",
  printTitle,
  printMeta,
  saleTypeFilter = false,
  dealerFilter = false,
}: {
  title: string;
  description: string;
  fetcher: (from: string, to: string, saleType?: SaleType, dealerId?: string) => Promise<T>;
  renderPages: (from: string, to: string, data: T | undefined, saleType?: SaleType, dealerId?: string) => ReactNode[];
  buildCsv?: (from: string, to: string, data: T, saleType?: SaleType, dealerId?: string) => (string | number | null | undefined)[][];
  printOrientation?: "portrait" | "landscape";
  /** Title on the printed letterhead; defaults to `title`. */
  printTitle?: string;
  /** Per-page letterhead. Pass `null` to omit it (e.g. the credit bill, which
   *  carries its own printed header). Defaults to the union letterhead with
   *  the period (and the sales type / dealer when those filters are on). */
  printMeta?: ReactNode;
  /** Show the Cash / Credit / Cash + Credit selector. */
  saleTypeFilter?: boolean;
  /** Show a dealer picker (blank = all dealers). */
  dealerFilter?: boolean;
}) {
  const today = todayIST();
  const monthStart = today.substring(0, 8) + "01";
  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [saleTypeSel, setSaleTypeSel] = useState<SaleType>("cash");
  const [dealerSel, setDealerSel] = useState("");
  const [generated, setGenerated] = useState(false);

  const saleType = saleTypeFilter ? saleTypeSel : undefined;
  const dealerId = dealerFilter && dealerSel ? dealerSel : undefined;

  const { data: customers = [] } = useQuery({
    queryKey: ["customers"], queryFn: fetchCustomers, enabled: dealerFilter,
  });
  const dealerOptions: F9Option[] = useMemo(
    () => (customers as any[]).map(c => ({
      value: String(c.id),
      label: String(c.name),
      sublabel: String(c.code ?? ""),
      searchText: String(c.code ?? ""),
    })),
    [customers],
  );
  const dealerName = dealerOptions.find(o => o.value === dealerSel)?.label ?? "All dealers";

  const { data, isLoading, refetch } = useQuery<T>({
    queryKey: [`sr:${title}`, from, to, saleType, dealerId],
    queryFn: () => fetcher(from, to, saleType, dealerId),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  const pages = generated ? renderPages(from, to, data, saleType, dealerId) : [];

  const meta = printMeta === undefined
    ? (
      <ReportPrintMeta
        title={printTitle ?? title}
        rows={[
          { label: "Period", value: fmtPeriod(from, to) },
          ...(saleType ? [{ label: "Sales", value: saleTypeLabel(saleType) }] : []),
          ...(dealerFilter ? [{ label: "Dealer", value: dealerName }] : []),
        ]}
      />
    )
    : printMeta;

  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const exporters: Exporter[] = (data && buildCsv) ? [{
    label: "CSV",
    filename: `${slug(title)}${saleType ? `_${slug(saleTypeLabel(saleType))}` : ""}_${from}_${to}.csv`,
    mimeType: "text/csv",
    build: () => toCsv(buildCsv(from, to, data, saleType, dealerId)),
  }] : [];

  return (
    <ReportShell
      title={title}
      subtitle={description}
      printOrientation={printOrientation}
      filters={
        <>
          {dealerFilter && (
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Dealer</label>
              <div className="w-64">
                <F9SearchSelect
                  value={dealerSel}
                  onChange={v => setDealerSel(v ?? "")}
                  options={dealerOptions}
                  allowAll
                  allLabel="All dealers"
                  placeholder="All dealers"
                />
              </div>
            </div>
          )}
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="erp-input w-40" />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="erp-input w-40" />
          </div>
          {saleTypeFilter && (
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Sales Type</label>
              <Select value={saleTypeSel} onValueChange={v => setSaleTypeSel(v as SaleType)}>
                <SelectTrigger className="erp-input w-44"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SALE_TYPE_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          )}
        </>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={meta}
      state={{ generated, loading: isLoading, pages }}
    />
  );
}

// A small note line above a report page's table (column page, units…).
// The title and period live on the letterhead now, so this carries only
// what differs from page to page.
function ReportPageNote({ children }: { children?: ReactNode }) {
  if (!children) return null;
  return <p className="report-page-note">{children}</p>;
}

// ─── Shared "cash-style" grid (Cash Sales + Sales Register) ─────
// Product (rows) × Route (columns) qty grid with a trailing Total-Qty
// column and Total-Qty / Milk ₹ / Product ₹ / Total ₹ footer rows. Qty
// values are centre-aligned; the ₹ footer rows stay right-aligned.
// Routes are spread evenly across the pages (A4 landscape fit).
const CASH_ROUTES_PER_PAGE = 6;
const REGISTER_ROUTES_PER_PAGE = 9;

function renderCashStyleGrid(
  apiData: SalesGridResponse,
  asVolume = false,
  maxRoutesPerPage = CASH_ROUTES_PER_PAGE,
): ReactNode[] {
  const pageCount0 = Math.max(1, Math.ceil(apiData.routes.length / maxRoutesPerPage));
  const perPage = Math.ceil(apiData.routes.length / pageCount0);
  const routePages = paginateColumns(apiData.routes, perPage);
  const pageCount = routePages.length;

  // Cell + total formatters: packet counts, or Ltr/Kg volume (Sales Register).
  const one = (packets: number, p: ProductLite) =>
    asVolume ? volOf(packets, p) : packets;
  const fmtCell = (v: number) => (asVolume ? fmtVol(v) : fmtQty(v));

  return routePages.map((routeChunk, pageIdx) => {
    const routeQtyTotal = (r: (typeof routeChunk)[number]) =>
      apiData.products.reduce((s, p) => s + one(r.qty[p.id] ?? 0, p), 0);
    const grandQtyTotal = apiData.products.reduce(
      (s, p) => s + one(apiData.totals.qty[p.id] ?? 0, p), 0);
    const isLast = pageIdx === pageCount - 1;

    return (
      <div key={pageIdx} className="report-page">
        <ReportPageNote>{`Columns ${pageIdx + 1}/${pageCount}${asVolume ? " · Qty in Ltr / Kg" : ""}`}</ReportPageNote>
        <table className="cash-grid w-full text-[11px] border-collapse">
          <thead>
            <tr className="bg-muted/50">
              <th className="cg-product border border-border py-1.5 px-2 text-left font-bold">Product</th>
              {routeChunk.map(r => (
                <th key={r.id} className="border border-border py-1 px-2 text-center font-bold">
                  <div className="font-mono text-[10px] text-muted-foreground">{r.code}</div>
                  <div className="cg-route-name">{r.name}</div>
                  <div className="cg-route-sub font-normal text-[9.5px] text-muted-foreground">
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
  (from: string, to: string, d: SalesGridResponse, saleType?: SaleType) => {
    const cell = (packets: number, p: ProductLite) =>
      asVolume ? Math.round(volOf(packets, p) * 100) / 100 : packets;
    const rows: (string | number)[][] = [
      [`${fmtPeriod(from, to)}${asVolume ? " · Qty in Ltr/Kg" : ""}${saleType ? ` · Sales: ${saleTypeLabel(saleType)}` : ""}`],
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
// Landscape. Small category groups share a page (up to 10 product columns):
// the first group's products are the paged columns and the rest follow its
// Total Qty as trailing columns, so Milk, Curd and Lassi can sit on one sheet.

export const DailySalesStatement = () => (
  <SalesReportShell<DailyStatementResponse>
    title="Daily Sales Statement"
    description="DMU items daily sales (own production)"
    fetcher={(from, to) => fetchDailyStatement({ from, to })}
    printOrientation="landscape"
    renderPages={(_from, _to, apiData) => {
      if (!apiData) return [];
      const DAILY_COLS_PER_PAGE = 10;
      // Milk & Lassi pages read in litres, Curd page in kilograms.
      const unitOf = (g: { key: string }) => (g.key === "curd" ? "Kgs" : "Ltrs");

      // Pack whole groups onto sheets while they fit.
      type Group = DailyStatementResponse["groups"][number];
      const sheets: Group[][] = [];
      for (const g of apiData.groups) {
        const last = sheets[sheets.length - 1];
        const used = last ? last.reduce((s, x) => s + x.products.length, 0) : 0;
        if (last && used + g.products.length <= DAILY_COLS_PER_PAGE) last.push(g);
        else sheets.push([g]);
      }

      return sheets.flatMap((sheet, si) => {
        const [lead, ...rest] = sheet;
        // A lead group too wide for one sheet is split evenly.
        const pageCount = Math.max(1, Math.ceil(lead.products.length / DAILY_COLS_PER_PAGE));
        const productPages = paginateColumns(lead.products, Math.ceil(lead.products.length / pageCount));
        // Row's total volume = Σ every product in the lead group (one unit),
        // so it doesn't change across column-paged chunks.
        const leadVol = (qty: Record<string, number>) =>
          lead.products.reduce((s, p) => s + volOf(qty[p.id] ?? 0, p), 0);
        const restProducts = rest.flatMap(g => g.products);
        const trailing: ColumnDef<{ date: string; qty: Record<string, number> }>[] = [
          { label: `Total Qty (${unitOf(lead)})`, accessor: r => fmtVol(leadVol(r.qty)), num: true, width: "110px" },
          ...restProducts.map(p => ({
            label: p.reportAlias,
            accessor: (r: { qty: Record<string, number> }) => fmtVol(volOf(r.qty[p.id] ?? 0, p)),
            className: "prod-col",
            width: "60px",
          })),
        ];

        // One row per date across every group on the sheet.
        const byDate = new Map<string, Record<string, number>>();
        for (const g of sheet) for (const r of g.rows) byDate.set(r.date, { ...(byDate.get(r.date) ?? {}), ...r.qty });
        const rows = apiData.dates.map(date => ({ date, qty: byDate.get(date) ?? {} }));
        const totals: Record<string, number> = Object.assign({}, ...sheet.map(g => g.totals.qty));

        return productPages.map((prodChunk, pi) => (
          <ColumnPagedTable
            key={`${si}-${pi}`}
            title={`${sheet.map(g => `${g.label} (${unitOf(g)})`).join(" · ")}${productPages.length > 1 ? ` · Cols ${pi + 1}/${productPages.length}` : ""}`}
            fixedLayout
            fixedHead={[{ label: "Date", accessor: r => fmtDMY(r.date), width: "90px" }]}
            productCols={prodChunk}
            productCellRender={(row, p) => fmtVol(volOf(row.qty[p.id] ?? 0, p))}
            trailingHead={trailing}
            rows={rows}
            totalRow={{
              fixedCells: ["TOTAL"],
              productCell: (p) => fmtVol(volOf(totals[p.id] ?? 0, p)),
              trailingCells: [fmtVol(leadVol(totals)), ...restProducts.map(p => fmtVol(volOf(totals[p.id] ?? 0, p)))],
            }}
          />
        ));
      });
    }}
    buildCsv={(from, to, d) => {
      // One section per category page: Date + per-product Ltr/Kg + Total Qty.
      const out: any[][] = [[`Daily Sales Statement (${fmtPeriod(from, to)})`]];
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
    description="Cash sales by day and route: dealer indents (wallet, UPI, cash), counter sales and gate passes. Excludes credit institution sales and the employee subsidy, both settled on credit."
    fetcher={(from, to) => fetchDayRouteCash({ from, to })}
    printOrientation="landscape"
    renderPages={(_from, _to, apiData) => {
      if (!apiData) return [];
      // Up to 9 route columns per landscape page, spread evenly.
      const pageCount = Math.max(1, Math.ceil(apiData.routes.length / 9));
      const routePages = paginateColumns(apiData.routes, Math.ceil(apiData.routes.length / pageCount));
      return routePages.map((routeChunk, pi) => (
        <div key={pi}>
          <ReportPageNote>
            {`Cols ${pi + 1}/${routePages.length} · Indents + counter sales + gate passes · Excludes credit sales: credit institutions (billed on Credit Sales) and employee subsidy (Employee Credit)`}
          </ReportPageNote>
          <table className="cash-grid w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="cg-date border border-border py-1.5 px-2 text-left font-bold">Date</th>
                {routeChunk.map(r => (
                  <th key={r.id} className="border border-border py-1.5 px-2 text-center font-bold">
                    <div className="cg-route-name">{r.name}</div>
                  </th>
                ))}
                <th className="cg-total border border-border py-1.5 px-2 text-right font-bold num">Total</th>
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
      out.push(["Day/Route Wise Cash Sales", fmtPeriod(from, to)]);
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
    renderPages={(_from, _to, apiData) => {
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
          <ReportPageNote>Qty in Ltr / Kg</ReportPageNote>
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
        [`Officer Wise Sales (${fmtPeriod(from, to)}) · Qty in Ltr/Kg`],
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
    description="Cash sales by product × route: dealer indents (wallet, UPI, cash), counter sales and gate passes. Excludes credit institutions and the employee subsidy, both settled on credit."
    fetcher={(from, to) => fetchCashSales({ from, to })}
    printOrientation="landscape"
    renderPages={(_from, _to, apiData) => (apiData ? renderCashStyleGrid(apiData) : [])}
    buildCsv={makeCashGridCsv(false)}
  />
);

// ─── Sales Register ─────────────────────────────────────────────
// Same product × route grid as Cash Sales, in Ltr/Kg, for the chosen sales
// type (server: register endpoint).
export const SalesRegister = () => (
  <SalesReportShell<SalesGridResponse>
    title="Sales Register"
    description="Sales by product × route in Ltr/Kg, split by cash or credit. Route-less counter sales, gate passes and the employee subsidy print under ADHOC."
    fetcher={(from, to, saleType) => fetchSalesRegister({ from, to, saleType })}
    printOrientation="landscape"
    saleTypeFilter
    renderPages={(_from, _to, apiData) =>
      apiData ? renderCashStyleGrid(apiData, true, REGISTER_ROUTES_PER_PAGE) : []}
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
const nRaw  = (n: number) => String(Math.round((Number(n) || 0) * 100) / 100); // 1454.11
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
  // Cell classes: product columns, the row-label column, the total column.
  const th = "cb-cell cb-prod align-bottom";
  const td = "cb-cell cb-prod";
  const thLabel = "cb-cell cb-label align-bottom text-left";
  const tdLabel = "cb-cell cb-label text-left";
  const thTotal = "cb-cell cb-total align-bottom";
  const tdTotal = "cb-cell cb-total";
  return (
    <div className="credit-bill text-[14px] leading-tight font-mono">
      {/* Top banner */}
      <div className="flex items-center justify-between mb-1">
        <span className="tracking-[0.25em]">[ H A V E M U L ]</span>
        <span className="font-bold tracking-wide">HAVERI MILK UNION LTD - HAVERI</span>
        <span>Page {pageNo}</span>
      </div>

      {/* Two-column header: buyer block | union GST declaration */}
      <div className="credit-bill-head grid grid-cols-2">
        <div className="p-1.5 whitespace-pre-wrap">
          <div>To, {b.name}</div>
          {b.address && <div className="pl-4">{b.address}</div>}
          {b.city && <div className="pl-4">{b.city}</div>}
          <div className="mt-1 border-t border-border pt-1">
            <div>BILL NO&nbsp;&nbsp;{b.billNo}</div>
            <div>PERIOD&nbsp;&nbsp;&nbsp;{b.periodFrom} {b.periodTo}</div>
          </div>
        </div>
        <div className="cb-head-right p-1.5">
          <div>Buyer's GSTIN : {b.gstNumber ?? ""}</div>
          <div>TAX INVOICE/CR.BILL GSTIN : {UNION_GSTIN} FSSAI NO:{UNION_FSSAI}</div>
          <div>DECLARATION UNDER GST Act 2017.</div>
          <div>We declare that we are the first seller in the state liable to tax under GST Act 2017 and that we shall pay the single point tax on above sale.</div>
        </div>
      </div>

      {/* Product grid: session / name / HSN / rate header stack, daily qty, footer totals.
          One column per product PRICE (key), so a revised rate is its own column. */}
      <table className="credit-bill-grid no-ledger mt-1.5">
        <thead>
          <tr>
            <th className={thLabel}></th>
            {b.products.map(p => <th key={p.key} className={`${th} text-center`}>{p.session}</th>)}
            <th className={thTotal}></th>
          </tr>
          <tr>
            <th className={thLabel}>Pkt</th>
            {b.products.map(p => <th key={p.key} className={`${th} cb-name text-center`}>{p.reportAlias}</th>)}
            <th className={thTotal}></th>
          </tr>
          <tr>
            <th className={thLabel}>HSN</th>
            {b.products.map(p => <th key={p.key} className={`${th} text-right`}>{p.hsn}</th>)}
            <th className={thTotal}></th>
          </tr>
          <tr>
            <th className={thLabel}>Rate</th>
            {b.products.map(p => <th key={p.key} className={`${th} text-right`}>{nRate(p.rate)}</th>)}
            <th className={thTotal}></th>
          </tr>
          <tr>
            <th className={thLabel}>Date</th>
            {b.products.map(p => <th key={p.key} className={`${th} text-right`}>Qty</th>)}
            <th className={`${thTotal} text-right`}>Total Amount</th>
          </tr>
        </thead>
        <tbody>
          {activeRows.map((row, ri) => (
            <tr key={ri}>
              <td className={tdLabel}>{row.day}</td>
              {b.products.map((p, pi) => <td key={p.key} className={`${td} text-right`}>{nPk(row.qty[pi] ?? 0)}</td>)}
              <td className={`${tdTotal} text-right`}>{row.dayTotal ? nAmt(row.dayTotal) : ""}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="font-semibold">
            <td className={tdLabel}>Pkts</td>
            {b.products.map((p, i) => <td key={p.key} className={`${td} text-right`}>{nPk(b.totals.pkts[i] ?? 0)}</td>)}
            <td className={tdTotal}></td>
          </tr>
          <tr>
            <td className={tdLabel}>Kg\ltr</td>
            {b.products.map((p, i) => <td key={p.key} className={`${td} text-right`}>{nKg(b.totals.kgLtr[i] ?? 0)}</td>)}
            <td className={tdTotal}></td>
          </tr>
          <tr>
            <td className={tdLabel}>BASIC</td>
            {b.products.map((p, i) => <td key={p.key} className={`${td} text-right`}>{nRaw(b.totals.basic[i] ?? 0)}</td>)}
            <td className={`${tdTotal} text-right`}>{nAmt(b.totals.basicGrand)}</td>
          </tr>
          <tr>
            <td className={tdLabel}>CGST</td>
            {b.products.map((p, i) => <td key={p.key} className={`${td} text-right`}>{nRaw(b.totals.cgst[i] ?? 0)}</td>)}
            <td className={`${tdTotal} text-right`}>{nRaw(b.totals.cgstGrand)}</td>
          </tr>
          <tr>
            <td className={tdLabel}>SGST</td>
            {b.products.map((p, i) => <td key={p.key} className={`${td} text-right`}>{nRaw(b.totals.sgst[i] ?? 0)}</td>)}
            <td className={`${tdTotal} text-right`}>{nRaw(b.totals.sgstGrand)}</td>
          </tr>
          <tr className="font-semibold">
            <td className={tdLabel}>Amount</td>
            {b.products.map((p, i) => <td key={p.key} className={`${td} text-right`}>{nAmt(b.totals.amount[i] ?? 0)}</td>)}
            <td className={`${tdTotal} text-right`}>{nAmt(b.totals.amountGrand)}</td>
          </tr>
        </tfoot>
      </table>

      {/* Notes + signature */}
      <div className="cb-notes flex justify-between mt-2 text-[12px]">
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
    <div className="credit-bill text-[14px] leading-tight font-mono">
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
    description="Monthly credit bill: credit institutions only"
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
        [`Credit Sales (Credit Institutions), ${d.periodFrom} to ${d.periodTo}`],
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

// ─── B7. Agent Wise Taluka Sales ────────────────────────────────
// Legacy "Taluka wise agent wise sales statement" layout: one taluka per
// sheet. Each taluka renders a product × agent matrix in Ltr / Kg (only the
// products the taluka sold, agents paged across the sheet, the amount per
// agent as the footer) followed by a summary page (Milk / Curd totals +
// amount per agent).

export const TalukaAgentSales = () => (
  <SalesReportShell<TalukaAgentResponse>
    title="Agent wise taluka sales"
    description="Agent wise taluka sales statement: one taluka per page"
    printOrientation="landscape"
    fetcher={(from, to) => fetchTalukaAgent({ from, to })}
    renderPages={(_from, _to, apiData) => {
      if (!apiData) return [];
      const AGENTS_PER_PAGE = 8;

      type ProductRow = {
        sl: number; id: string; name: string; unit: string;
        vol: Record<string, number>; total: number;
      };
      const productHead: ColumnDef<ProductRow>[] = [
        { label: "Sl No.", accessor: r => r.sl, width: "34px", num: true },
        { label: "Product Name", accessor: r => r.name, width: "180px" },
        { label: "Unit", accessor: r => r.unit, width: "34px" },
      ];
      const customerHead: ColumnDef<TalukaAgentResponse["talukas"][number]["summary"][number]>[] = [
        { label: "Sl", accessor: r => r.sl, width: "30px", num: true },
        { label: "Code", accessor: r => r.code, width: "48px" },
        { label: "Customer Name", accessor: r => r.name, width: "170px" },
      ];

      return apiData.talukas.flatMap((t, ti) => {
        const nodes: ReactNode[] = [];

        // Rows: products the taluka actually sold, in Ltr / Kg per agent.
        const rows: ProductRow[] = apiData.products
          .filter(p => (t.detailedTotals.qty[p.id] ?? 0) !== 0)
          .map((p, i) => ({
            sl: i + 1,
            id: p.id,
            name: p.reportAlias,
            unit: volUnit(p.unit),
            vol: Object.fromEntries(t.customers.map(c => [c.id, volOf(c.qty[p.id] ?? 0, p)])),
            total: volOf(t.detailedTotals.qty[p.id] ?? 0, p),
          }));
        // Columns: the agents, paged across the sheet.
        const agentCols = t.customers.map(c => ({
          id: c.id,
          reportAlias: c.code ? `${c.code} ${c.name}` : c.name,
          amount: c.total,
        }));
        const agentPages = paginateColumns(agentCols, AGENTS_PER_PAGE);

        agentPages.forEach((chunk, pi) => {
          nodes.push(
            <ColumnPagedTable
              key={`d-${ti}-${pi}`}
              title={`Taluka Name: ${t.name} (Qty in Ltr / Kg)${agentPages.length > 1 ? ` · Agents ${pi + 1}/${agentPages.length}` : ""}`}
              fixedLayout
              productColWidth="80px"
              fixedHead={productHead}
              productCols={chunk as any}
              productCellRender={(row, a) => fmtVol(row.vol[a.id] ?? 0)}
              trailingHead={[{ label: "Total", accessor: r => fmtVol(r.total), num: true, width: "74px" }]}
              rows={rows}
              rowKey={r => r.id}
              totalRow={{
                fixedCells: ["", "TOTAL AMOUNT (₹)", ""],
                productCell: (a: any) => fmtINR(a.amount),
                trailingCells: [fmtINR(t.detailedTotals.total)],
              }}
            />
          );
        });

        // ── Summary page (milk/curd totals + amount per agent) ──
        nodes.push(
          <ColumnPagedTable
            key={`s-${ti}`}
            title={`Taluka Name: ${t.name} · Summary`}
            fixedHead={customerHead}
            productCols={[] as ProductLite[]}
            productCellRender={() => null}
            trailingHead={[
              { label: "Milk Total (Ltr)", accessor: (r) => fmtVol(r.milkTotalQty), num: true },
              { label: "Curd Total (Kg)",  accessor: (r) => fmtVol(r.curdTotalQty), num: true },
              { label: "Total Amt ₹",      accessor: (r) => fmtINR(r.totalAmount), num: true },
            ]}
            rows={t.summary}
            rowKey={(r) => r.id}
            totalRow={{
              fixedCells: ["", "", "TOTAL"],
              productCell: () => null,
              trailingCells: [
                fmtVol(t.summaryTotals.milkTotalQty),
                fmtVol(t.summaryTotals.curdTotalQty),
                fmtINR(t.summaryTotals.totalAmount),
              ],
            }}
          />
        );

        return nodes;
      });
    }}
    buildCsv={(from, to, d) => {
      const out: (string | number)[][] = [];
      out.push(["Agent wise taluka sales statement", `Period ${fmtPeriod(from, to)}`]);
      d.talukas.forEach((t) => {
        const sold = d.products.filter(p => (t.detailedTotals.qty[p.id] ?? 0) !== 0);
        out.push([]);
        out.push([`Taluka Name: ${t.name}`, "Qty in Ltr / Kg"]);
        // product × agent matrix
        out.push([
          "Sl No.", "Product Name", "Unit",
          ...t.customers.map(c => (c.code ? `${c.code} ${c.name}` : c.name)),
          "Total",
        ]);
        sold.forEach((p, i) => out.push([
          i + 1, p.reportAlias, volUnit(p.unit),
          ...t.customers.map(c => volOf(c.qty[p.id] ?? 0, p)),
          volOf(t.detailedTotals.qty[p.id] ?? 0, p),
        ]));
        out.push(["", "TOTAL AMOUNT (₹)", "", ...t.customers.map(c => c.total), t.detailedTotals.total]);
        // summary
        out.push([]);
        out.push(["Sl", "Code", "Customer Name", "Milk Total (Ltr)", "Curd Total (Kg)", "Total Amt"]);
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
// Milk sales (In Ltrs) per taluka × milk product, the same for curd
// (In Kgs) and other products, and a per-taluka summary of Total / Avg.
// Volumes come from the API (packets × pack_size), so this only formats +
// paginates them.
export const TalukaWiseReport = () => (
  <SalesReportShell<TalukaWiseResponse>
    title="Taluka Wise Report"
    description="Taluka wise milk (Ltrs) & curd (Kgs) sales with totals & averages"
    printOrientation="landscape"
    fetcher={(from, to) => fetchTalukaWise({ from, to })}
    renderPages={(_from, _to, d) => {
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
            title={`Milk Sales (In Ltrs)${milkChunks.length > 1 ? ` · Products ${pi + 1}/${milkChunks.length}` : ""}`}
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
            title={`Curd Sales (In Kgs)${curdChunks.length > 1 ? ` · Products ${pi + 1}/${curdChunks.length}` : ""}`}
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
              title={`Other Sales (Qty)${otherChunks.length > 1 ? ` · Products ${pi + 1}/${otherChunks.length}` : ""}`}
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
          title={`Summary · ${d.numDays} day(s)`}
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
      out.push([`Taluka Wise Milk Sales (In Ltrs), ${fmtPeriod(from, to)}`]);
      out.push(["Taluka", ...d.milkProducts.map((p) => p.reportAlias), "Total Milk (Ltrs)"]);
      d.rows.forEach((r) => out.push([r.taluka, ...d.milkProducts.map((p) => r.milkQty[p.id] ?? 0), r.totalMilk]));
      out.push(["TOTAL", ...d.milkProducts.map((p) => d.totals.milkQty[p.id] ?? 0), d.totals.totalMilk]);
      out.push([]);
      // Curd (In Kgs)
      out.push([`Taluka Wise Curd Sales (In Kgs), ${fmtPeriod(from, to)}`]);
      out.push(["Taluka", ...d.curdProducts.map((p) => p.reportAlias), "Total Curd (Kgs)"]);
      d.rows.forEach((r) => out.push([r.taluka, ...d.curdProducts.map((p) => r.curdQty[p.id] ?? 0), r.totalCurd]));
      out.push(["TOTAL", ...d.curdProducts.map((p) => d.totals.curdQty[p.id] ?? 0), d.totals.totalCurd]);
      out.push([]);
      // Other (Qty)
      if (d.otherProducts.length > 0) {
        out.push([`Taluka Wise Other Sales (Qty), ${fmtPeriod(from, to)}`]);
        out.push(["Taluka", ...d.otherProducts.map((p) => p.reportAlias), "Total Other"]);
        d.rows.forEach((r) => out.push([r.taluka, ...d.otherProducts.map((p) => r.otherQty[p.id] ?? 0), r.totalOther]));
        out.push(["TOTAL", ...d.otherProducts.map((p) => d.totals.otherQty[p.id] ?? 0), d.totals.totalOther]);
        out.push([]);
      }
      // Summary
      out.push([`Taluka Wise Summary (${fmtPeriod(from, to)}, ${d.numDays} days)`]);
      out.push(["Taluka", "Total Milk (Ltrs)", "Avg Milk (Ltrs)", "Total Curd (Kgs)", "Avg Curd (Kgs)", "Total Other", "Avg Other"]);
      d.rows.forEach((r) => out.push([r.taluka, r.totalMilk, r.avgMilk, r.totalCurd, r.avgCurd, r.totalOther, r.avgOther]));
      out.push(["TOTAL", d.totals.totalMilk, d.totals.avgMilk, d.totals.totalCurd, d.totals.avgCurd, d.totals.totalOther, d.totals.avgOther]);
      return out;
    }}
  />
);

// ─── B7c. Agent Sales ───────────────────────────────────────────
// The legacy per-customer statement: one block per agent listing each
// packet at the GST-inclusive rate it was billed (a revised price is its own
// line, → A / → B), packets, Ltr / Kg and amount, closed by the agent's total
// and Milk / Curd / Other volume + value lines. A grand-total block follows
// when more than one agent is on the report.
const volumeLines = (v: AgentSalesResponse["totals"] | AgentSalesResponse["agents"][number]) => [
  { label: "Total Milk (Ltrs)",             vol: v.milkLtr,  amt: null },
  { label: "Total Milk Amount",             vol: null,       amt: v.milkAmount },
  { label: "Total Curd (Kgs)",              vol: v.curdKg,   amt: null },
  { label: "Total Curd Amount",             vol: null,       amt: v.curdAmount },
  { label: "Total Other Products (Kg/Ltr)", vol: v.otherQty, amt: null },
  { label: "Total Other Products Amount",   vol: null,       amt: v.otherAmount },
];

function renderAgentBlock(a: AgentSalesResponse["agents"][number]) {
  const td = "border border-border px-2 py-0.5";
  return (
    <div className="text-[11px] leading-tight agent-block">
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-muted/40">
            <th className={`${td} text-left w-16`}>Code</th>
            <th className={`${td} text-left w-48`}>Customer Name</th>
            <th className={`${td} text-left`}>Packet Name</th>
            <th className={`${td} text-right w-20`}>Rate</th>
            <th className={`${td} text-right w-20`}>Qty No</th>
            <th className={`${td} text-right w-24`}>Qty Ltrs/ Kg</th>
            <th className={`${td} text-right w-28`}>Amount</th>
          </tr>
          <tr>
            <td className={td}>{a.code}</td>
            <td className={td} colSpan={6}>{a.name}</td>
          </tr>
        </thead>
        <tbody>
          {a.lines.map((l, i) => (
            <tr key={`${l.productId}-${i}`}>
              <td className={td}></td>
              <td className={td}></td>
              <td className={td}>{l.name}</td>
              <td className={`${td} text-right num`}>{nAmt(l.rate)}</td>
              <td className={`${td} text-right num`}>{l.qtyNo}</td>
              <td className={`${td} text-right num`}>{nAmt(l.qtyVol)}</td>
              <td className={`${td} text-right num`}>{nAmt(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tbody className="agent-block-totals">
          <tr className="font-bold bg-muted/40">
            <td className={td} colSpan={6}>Total:</td>
            <td className={`${td} text-right num`}>{nAmt(a.total)}</td>
          </tr>
          {volumeLines(a).map(r => (
            <tr key={r.label}>
              <td className={td} colSpan={5}>{r.label}</td>
              <td className={`${td} text-right num`}>{r.vol === null ? "" : nAmt(r.vol)}</td>
              <td className={`${td} text-right num`}>{r.amt === null ? "" : nAmt(r.amt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderAgentGrandTotal(d: AgentSalesResponse) {
  const td = "border border-border px-2 py-0.5";
  const rows = [
    { label: "Total Milk (Ltrs)",             vol: d.totals.milkLtr,  amt: null },
    { label: "Total Milk Amount",             vol: null,              amt: d.totals.milkAmount },
    { label: "Total Curd (Kgs)",              vol: d.totals.curdKg,   amt: null },
    { label: "Total Curd Amount",             vol: null,              amt: d.totals.curdAmount },
    { label: "Total Other Products (Kg/Ltr)", vol: d.totals.otherQty, amt: null },
    { label: "Total Other Products Amount",   vol: null,              amt: d.totals.otherAmount },
  ];
  return (
    <div className="text-[11px] leading-tight">
      <div className="font-bold mb-1">Grand Total: {d.agents.length} agents</div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-muted/40">
            <th className={`${td} text-left`}>Particulars</th>
            <th className={`${td} text-right w-32`}>Qty Ltrs/ Kg</th>
            <th className={`${td} text-right w-36`}>Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(r => (
            <tr key={r.label}>
              <td className={td}>{r.label}</td>
              <td className={`${td} text-right num`}>{r.vol === null ? "" : nAmt(r.vol)}</td>
              <td className={`${td} text-right num`}>{r.amt === null ? "" : nAmt(r.amt)}</td>
            </tr>
          ))}
          <tr className="font-bold bg-muted/40">
            <td className={td} colSpan={2}>Total:</td>
            <td className={`${td} text-right num`}>{nAmt(d.totals.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

export const AgentSalesReport = () => (
  <SalesReportShell<AgentSalesResponse>
    title="Agent Sales"
    description="Per agent product statement: rate, packets, Ltr/Kg and amount"
    dealerFilter
    fetcher={(from, to, _saleType, dealerId) => fetchAgentSales({ from, to, dealerId })}
    renderPages={(_from, _to, d) => {
      if (!d || d.agents.length === 0) return [];
      const pages: ReactNode[] = d.agents.map(a => <div key={a.id}>{renderAgentBlock(a)}</div>);
      if (d.agents.length > 1) pages.push(<div key="grand-total">{renderAgentGrandTotal(d)}</div>);
      return pages;
    }}
    buildCsv={(from, to, d) => {
      const out: (string | number)[][] = [["Agent Sales", `Period ${fmtPeriod(from, to)}`]];
      d.agents.forEach(a => {
        out.push([]);
        out.push(["Code", "Customer Name", "Packet Name", "Rate", "Qty No", "Qty Ltrs/Kg", "Amount"]);
        a.lines.forEach((l, i) => out.push([
          i === 0 ? a.code : "", i === 0 ? a.name : "", l.name, l.rate, l.qtyNo, l.qtyVol, l.amount,
        ]));
        out.push(["", "", "Total:", "", "", "", a.total]);
        volumeLines(a).forEach(r => out.push(["", "", r.label, "", "", r.vol ?? "", r.amt ?? ""]));
      });
      out.push([]);
      out.push(["GRAND TOTAL", "", "", "", "", "", d.totals.total]);
      out.push(["Total Milk (Ltrs)", "", "", "", "", d.totals.milkLtr, d.totals.milkAmount]);
      out.push(["Total Curd (Kgs)", "", "", "", "", d.totals.curdKg, d.totals.curdAmount]);
      out.push(["Total Other Products (Kg/Ltr)", "", "", "", "", d.totals.otherQty, d.totals.otherAmount]);
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
    renderPages={(_from, _to, apiData) => {
      if (!apiData) return [];
      return [(
        <div key="p1">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border border-border py-1 px-1.5 text-left font-bold">Date</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Bill #</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Customer</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Pay</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Items</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Amount ₹</th>
              </tr>
            </thead>
            <tbody>
              {apiData.rows.map(r => (
                <tr key={r.id}>
                  <td className="border border-border py-0.5 px-1.5">{fmtDMY(r.date)}</td>
                  <td className="border border-border py-0.5 px-1.5 font-mono">{r.billNo}</td>
                  <td className="border border-border py-0.5 px-1.5">{r.customerName ?? ""}</td>
                  <td className="border border-border py-0.5 px-1.5 uppercase">{payModeLabel(r.payMode)}</td>
                  <td className="border border-border py-0.5 px-1.5 text-[10px] text-muted-foreground">{r.itemsText}</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtINR(r.amount)}</td>
                </tr>
              ))}
              <tr className="font-bold bg-muted/40">
                <td colSpan={5} className="border border-border py-1 px-1.5 text-right">TOTAL</td>
                <td className="border border-border py-1 px-1.5 text-right num">{fmtINR(apiData.totalAmount ?? 0)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
    buildCsv={(from, to, d) => {
      const out: any[][] = [
        [`Adhoc Sales, ${fmtPeriod(from, to)}`],
        ["Date", "Bill #", "Customer", "Pay", "Items", "Amount ₹"],
      ];
      d.rows.forEach(r => out.push([fmtDMY(r.date), r.billNo, r.customerName ?? "", payModeLabel(r.payMode), r.itemsText, r.amount]));
      out.push(["", "", "", "", "TOTAL", d.totalAmount ?? 0]);
      return out;
    }}
  />
);

// ─── B9. GST Sales Statement ────────────────────────────────────
// One row per product and billed rate, for the chosen sales type.
export const GSTStatement = () => (
  <SalesReportShell<GstStatementResponse>
    title="GST Statement"
    printTitle="GST Sales Statement"
    description="GSTR-1 style summary by HSN and rate, split by cash or credit"
    fetcher={(from, to, saleType) => fetchGstStatement({ from, to, saleType })}
    saleTypeFilter
    renderPages={(_from, _to, apiData) => {
      if (!apiData) return [];
      return [(
        <div key="p1">
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="bg-muted/50">
                <th className="border border-border py-1 px-1.5 text-left font-bold w-10">Sl</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">Product</th>
                <th className="border border-border py-1 px-1.5 text-left font-bold">HSN</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Qty</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Rate ₹</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">GST %</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Taxable ₹</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">CGST ₹</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">SGST ₹</th>
                <th className="border border-border py-1 px-1.5 text-right font-bold num">Total ₹</th>
              </tr>
            </thead>
            <tbody>
              {apiData.rows.map(r => (
                <tr key={r.sl}>
                  <td className="border border-border py-0.5 px-1.5 num text-right">{r.sl}</td>
                  <td className="border border-border py-0.5 px-1.5">{r.productName}</td>
                  <td className="border border-border py-0.5 px-1.5 font-mono">{r.hsn}</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtQty(r.qty)}</td>
                  <td className="border border-border py-0.5 px-1.5 text-right num">{fmtINR(r.rate)}</td>
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
    buildCsv={(from, to, d, saleType) => {
      const out: any[][] = [
        [`GST Sales Statement, ${fmtPeriod(from, to)}${saleType ? `, Sales: ${saleTypeLabel(saleType)}` : ""}`],
        ["Sl", "Product", "HSN", "Qty", "Rate ₹", "GST %", "Taxable ₹", "CGST ₹", "SGST ₹", "Total ₹"],
      ];
      d.rows.forEach(r => out.push([
        r.sl, r.productName, r.hsn, r.qty, r.rate, r.gstPct,
        r.taxableValue, r.cgst, r.sgst, r.invoiceValue
      ]));
      out.push(["", "TOTAL", "", d.totals.qty, "", "", d.totals.taxableValue, d.totals.cgst, d.totals.sgst, d.totals.invoiceValue]);
      return out;
    }}
  />
);

// ─── B11. VIP Sales (Free Samples) ──────────────────────────────
export const VipSalesReport = () => (
  <SalesReportShell<VipSalesResponse>
    title="VIP Sales"
    printTitle="VIP Sales (Free Samples)"
    description="Complimentary samples issued to VIP contacts"
    fetcher={(from, to) => fetchVipSales({ from, to })}
    renderPages={(_from, _to, apiData) => {
      if (!apiData) return [];
      return [(
        <div key="p1">
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
                  <td className="border border-border py-0.5 px-1.5">{fmtDMY(r.date)}</td>
                  <td className="border border-border py-0.5 px-1.5 font-mono">{r.gpNo}</td>
                  <td className="border border-border py-0.5 px-1.5">{r.vipName || ""}</td>
                  <td className="border border-border py-0.5 px-1.5 text-muted-foreground">{r.designation ?? ""}</td>
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
        [`VIP Sales (Free Samples), ${fmtPeriod(from, to)}`],
        ["Sl", "Date", "GP #", "VIP Name", "Designation", "Items", "Qty", "Value ₹"],
      ];
      d.rows.forEach(r => out.push([
        r.sl, fmtDMY(r.date), r.gpNo, r.vipName, r.designation ?? "", r.itemsText, r.totalQty, r.value,
      ]));
      out.push(["", "", "", "", "", "TOTAL", d.totalQty, d.totalValue]);
      return out;
    }}
  />
);
