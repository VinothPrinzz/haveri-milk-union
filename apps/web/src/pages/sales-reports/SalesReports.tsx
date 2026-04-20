import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { ChevronLeft, ChevronRight, Printer } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import {
  fetchDailyStatement, fetchDayRouteCash, fetchOfficerWise,
  fetchCashSales, fetchSalesRegister, fetchCreditSales,
  fetchTalukaAgent, fetchAdhocSales, fetchGstStatement,
  type DailyStatementResponse, type DayRouteCashResponse,
  type OfficerWiseResponse, type SalesGridResponse,
  type CreditSalesResponse, type TalukaAgentResponse,
  type AdhocResponse, type GstStatementResponse,
} from "@/services/report";

// ── helpers ──
const fmtINR = (n: number | string) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const fmtQty = (n: number | string) => String(Number(n || 0));

// ── Shared report header ──
function ReportHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="text-center mb-3">
      <h2 className="text-sm font-bold uppercase tracking-wide">HAVERI MILK UNION LTD — HAVERI</h2>
      <p className="text-xs font-bold mt-1">{title}</p>
      {subtitle && <p className="text-[10px] text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}

// ── Generic shell: filters + fetch + paginate ──
function SalesReportShell<T>({
  title,
  description,
  fetcher,
  renderPages,
}: {
  title: string;
  description: string;
  fetcher: (from: string, to: string) => Promise<T>;
  renderPages: (from: string, to: string, apiData: T | undefined) => React.ReactNode[];
}) {
  const today = new Date().toISOString().split("T")[0];
  const monthStart = today.substring(0, 8) + "01";

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [pages, setPages] = useState<React.ReactNode[]>([]);
  const [generated, setGenerated] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);

  const { data: apiData, isLoading, refetch } = useQuery({
    queryKey: [title, from, to],
    queryFn: () => fetcher(from, to),
    enabled: false,
  });

  const handleGenerate = async () => {
    const result = await refetch();
    const p = renderPages(from, to, result.data);
    setPages(p);
    setCurrentPage(0);
    setGenerated(true);
  };

  return (
    <div>
      <PageHeader title={title} description={description} />
      <Card className="mb-4">
        <CardContent className="p-5 flex flex-wrap items-end gap-4">
          <div>
            <label className="text-sm font-medium mb-1.5 block">From</label>
            <input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">To</label>
            <input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" />
          </div>
          <Button onClick={handleGenerate} disabled={isLoading}>
            {isLoading ? "Generating..." : "Generate Report"}
          </Button>
        </CardContent>
      </Card>

      {generated && pages.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">{title}</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" className="h-8 w-8"
                onClick={() => setCurrentPage(p => Math.max(0, p - 1))} disabled={currentPage === 0}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">Page {currentPage + 1} of {pages.length}</span>
              <Button variant="outline" size="icon" className="h-8 w-8"
                onClick={() => setCurrentPage(p => Math.min(pages.length - 1, p + 1))}
                disabled={currentPage === pages.length - 1}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => window.print()}>
                <Printer className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="border rounded-lg p-6 bg-card min-h-[500px]">
            <div className="max-w-[794px] mx-auto bg-white p-8 shadow-sm print:shadow-none print:p-0">
              {isLoading
                ? <div className="flex items-center justify-center h-96 text-muted-foreground">Loading report...</div>
                : pages[currentPage]}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════
// B1. Daily Sales Statement — 3 pages (Milk / Curd / Lassi)
// ════════════════════════════════════════════════════════════════
export const DailySalesStatement = () => (
  <SalesReportShell<DailyStatementResponse>
    title="Daily Sales Statement"
    description="DMU items daily sales (own production)"
    fetcher={(from, to) => fetchDailyStatement({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      return apiData.groups.map((group, gi) => (
        <div key={gi}>
          <ReportHeader title={`Daily Sales Statement — ${group.label}`} subtitle={`Period: ${from} to ${to}`} />
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="border bg-muted/30">
                <th className="border py-1.5 px-2 text-left font-bold">Date</th>
                {group.products.map(p => <th key={p.id} className="border py-1.5 px-2 text-center font-bold whitespace-nowrap">{p.reportAlias}</th>)}
                <th className="border py-1.5 px-2 text-right font-bold">Total Amount</th>
              </tr>
            </thead>
            <tbody>
              {group.rows.map(row => (
                <tr key={row.date} className="border">
                  <td className="border py-1 px-2 font-medium">{row.date}</td>
                  {group.products.map(p => <td key={p.id} className="border py-1 px-2 text-center">{fmtQty(row.qty[p.id] ?? 0)}</td>)}
                  <td className="border py-1 px-2 text-right">{fmtINR(row.totalAmount)}</td>
                </tr>
              ))}
              <tr className="border font-bold bg-muted/30">
                <td className="border py-1.5 px-2">TOTAL</td>
                {group.products.map(p => <td key={p.id} className="border py-1.5 px-2 text-center">{fmtQty(group.totals.qty[p.id] ?? 0)}</td>)}
                <td className="border py-1.5 px-2 text-right">{fmtINR(group.totals.totalAmount)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      ));
    }}
  />
);

// ════════════════════════════════════════════════════════════════
// B2. Day / Route Wise Cash Sales — 1 page
// ════════════════════════════════════════════════════════════════
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
              <tr className="border bg-muted/30">
                <th className="border py-1.5 px-2 text-left font-bold">Indent Date</th>
                {apiData.routes.map(r => <th key={r.id} className="border py-1.5 px-2 text-center font-bold">{r.name}</th>)}
                <th className="border py-1.5 px-2 text-right font-bold">Total</th>
              </tr>
            </thead>
            <tbody>
              {apiData.dates.map(d => (
                <tr key={d} className="border">
                  <td className="border py-1 px-2 font-medium">{d}</td>
                  {apiData.routes.map(r => (
                    <td key={r.id} className="border py-1 px-2 text-center">{fmtINR(apiData.matrix[d]?.[r.id] ?? 0)}</td>
                  ))}
                  <td className="border py-1 px-2 text-right font-bold">{fmtINR(apiData.dayTotals[d] ?? 0)}</td>
                </tr>
              ))}
              <tr className="border font-bold bg-muted/30">
                <td className="border py-1.5 px-2">TOTAL</td>
                {apiData.routes.map(r => <td key={r.id} className="border py-1.5 px-2 text-center">{fmtINR(apiData.routeTotals[r.id] ?? 0)}</td>)}
                <td className="border py-1.5 px-2 text-right">{fmtINR(apiData.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
  />
);

// ════════════════════════════════════════════════════════════════
// B3. Officer Wise Sales (Qty) — 1 page
// ════════════════════════════════════════════════════════════════
export const OfficerWiseSales = () => (
  <SalesReportShell<OfficerWiseResponse>
    title="Officer Wise Sales (Qty)"
    description="Sales grouped by officer"
    fetcher={(from, to) => fetchOfficerWise({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      return [(
        <div key="p1">
          <ReportHeader title="Officer Wise Sales Report (Qty)" subtitle={`Period: ${from} to ${to}`} />
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="border bg-muted/30">
                <th className="border py-1.5 px-2 text-left font-bold">Product</th>
                {apiData.officers.map(o => <th key={o.id} className="border py-1.5 px-2 text-center font-bold">{o.name}</th>)}
                <th className="border py-1.5 px-2 text-right font-bold">Total</th>
              </tr>
            </thead>
            <tbody>
              {apiData.products.map(p => (
                <tr key={p.id} className="border">
                  <td className="border py-1 px-2 font-medium">{p.reportAlias}</td>
                  {apiData.officers.map(o => <td key={o.id} className="border py-1 px-2 text-center">{fmtQty(apiData.matrix[p.id]?.[o.id] ?? 0)}</td>)}
                  <td className="border py-1 px-2 text-right font-bold">{fmtQty(apiData.productTotals[p.id] ?? 0)}</td>
                </tr>
              ))}
              <tr className="border font-bold bg-muted/30">
                <td className="border py-1.5 px-2">TOTAL</td>
                {apiData.officers.map(o => <td key={o.id} className="border py-1.5 px-2 text-center">{fmtQty(apiData.officerTotals[o.id] ?? 0)}</td>)}
                <td className="border py-1.5 px-2 text-right">{fmtQty(apiData.grandTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
  />
);

// ════════════════════════════════════════════════════════════════
// Shared renderer for B4 (Cash Sales) + B6 (Sales Register)
// Same shape, same JSX — different title/fetcher only.
// ════════════════════════════════════════════════════════════════
function renderSalesGrid(titlePrefix: string, from: string, to: string, apiData: SalesGridResponse | undefined): React.ReactNode[] {
  if (!apiData) return [];
  const page1 = (
    <div key="p1">
      <ReportHeader title={`${titlePrefix} — Product Wise`} subtitle={`Period: ${from} to ${to}`} />
      <table className="w-full text-[10px] border-collapse">
        <thead>
          <tr className="border bg-muted/30">
            <th className="border py-1.5 px-1 text-left font-bold">Code</th>
            <th className="border py-1.5 px-1 text-left font-bold">Route Name</th>
            {apiData.products.map(p => <th key={p.id} className="border py-1.5 px-1 text-center font-bold whitespace-nowrap">{p.reportAlias}</th>)}
            <th className="border py-1.5 px-1 text-right font-bold">Total</th>
          </tr>
        </thead>
        <tbody>
          {apiData.routes.map(r => (
            <tr key={r.id} className="border">
              <td className="border py-1 px-1 font-mono font-medium">{r.code}</td>
              <td className="border py-1 px-1 font-medium">{r.name}</td>
              {apiData.products.map(p => <td key={p.id} className="border py-1 px-1 text-center">{fmtQty(r.qty[p.id] ?? 0)}</td>)}
              <td className="border py-1 px-1 text-right font-bold">{fmtINR(r.total)}</td>
            </tr>
          ))}
          <tr className="border font-bold bg-muted/30">
            <td className="border py-1.5 px-1" colSpan={2}>TOTAL</td>
            {apiData.products.map(p => <td key={p.id} className="border py-1.5 px-1 text-center">{fmtINR(apiData.totals.amount[p.id] ?? 0)}</td>)}
            <td className="border py-1.5 px-1 text-right">{fmtINR(apiData.totals.total)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  const page2 = (
    <div key="p2">
      <ReportHeader title={`${titlePrefix} — Summary`} subtitle={`Period: ${from} to ${to}`} />
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border bg-muted/30">
            <th className="border py-1.5 px-2 text-left font-bold">Code</th>
            <th className="border py-1.5 px-2 text-left font-bold">Route Name</th>
            <th className="border py-1.5 px-2 text-right font-bold">Milk Amount</th>
            <th className="border py-1.5 px-2 text-right font-bold">Product Amount</th>
            <th className="border py-1.5 px-2 text-right font-bold">Total</th>
            <th className="border py-1.5 px-2 text-left font-bold">Contractor</th>
          </tr>
        </thead>
        <tbody>
          {apiData.routes.map(r => (
            <tr key={r.id} className="border">
              <td className="border py-1 px-2 font-mono font-medium">{r.code}</td>
              <td className="border py-1 px-2 font-medium">{r.name}</td>
              <td className="border py-1 px-2 text-right">{fmtINR(r.milkAmount)}</td>
              <td className="border py-1 px-2 text-right">{fmtINR(r.productAmount)}</td>
              <td className="border py-1 px-2 text-right font-bold">{fmtINR(r.total)}</td>
              <td className="border py-1 px-2">{r.contractorName || "—"}</td>
            </tr>
          ))}
          <tr className="border font-bold bg-muted/30">
            <td className="border py-1.5 px-2" colSpan={2}>TOTAL</td>
            <td className="border py-1.5 px-2 text-right">{fmtINR(apiData.totals.milkAmount)}</td>
            <td className="border py-1.5 px-2 text-right">{fmtINR(apiData.totals.productAmount)}</td>
            <td className="border py-1.5 px-2 text-right">{fmtINR(apiData.totals.total)}</td>
            <td className="border py-1.5 px-2"></td>
          </tr>
        </tbody>
      </table>
    </div>
  );

  return [page1, page2];
}

export const CashSalesReport = () => (
  <SalesReportShell<SalesGridResponse>
    title="Cash Sales"
    description="Daily-payment customers' sales"
    fetcher={(from, to) => fetchCashSales({ from, to })}
    renderPages={(from, to, apiData) => renderSalesGrid("Cash Sales Statement", from, to, apiData)}
  />
);

export const SalesRegister = () => (
  <SalesReportShell<SalesGridResponse>
    title="Sales Register"
    description="Combined cash + credit sales by route"
    fetcher={(from, to) => fetchSalesRegister({ from, to })}
    renderPages={(from, to, apiData) => renderSalesGrid("Sales Register", from, to, apiData)}
  />
);

// ════════════════════════════════════════════════════════════════
// B5. Credit Sales — legacy HAVEMUL bill format + summary page
// One page per customer with daily qty × product pivot + tax footer
// Last page: flat summary (Sl No | Code | Name | Total)
// ════════════════════════════════════════════════════════════════
export const CreditSalesReport = () => (
  <SalesReportShell<CreditSalesResponse>
    title="Credit Sales"
    description="Monthly credit institution sales"
    fetcher={(from, to) => fetchCreditSales({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];

      const customerPages = apiData.customers.map(cust => {
        const prods = cust.products;
        const colCount = prods.length;
        // Blank string if 0 — matches legacy print convention
        const q = (n: number) => (n > 0 ? String(n) : "");
        const money = (n: number) => (n > 0 ? n.toFixed(2) : "");

        return (
          <div key={cust.id} className="text-[10px]">
            {/* Two-column header */}
            <div className="flex justify-between items-start mb-2 gap-4">
              <div className="flex-1">
                <p className="font-bold text-xs">[ H A V E M U L ]</p>
                <div className="mt-1 text-[10px]">
                  <p><strong>To,</strong> {cust.name}</p>
                  {cust.address && <p className="ml-6">{cust.address}</p>}
                  {cust.city && <p className="ml-6">{cust.city}</p>}
                </div>
                <div className="mt-1">
                  <p><strong>BILL NO</strong>&nbsp;&nbsp;&nbsp;{cust.billNo}</p>
                  <p><strong>PERIOD</strong>&nbsp;&nbsp;&nbsp;{cust.periodFrom} {cust.periodTo}</p>
                </div>
              </div>
              <div className="text-right">
                <p className="font-bold text-xs">HAVERI MILK UNION LTD — HAVERI</p>
                <div className="mt-1 text-[9px] max-w-[240px] text-right">
                  <p>Buyer's GSTIN : {cust.gstNumber || ""}</p>
                  <p>TAX INVOICE/CR.BILL GSTIN : 29AADAH7841L1Z6 FSSAI NO:11223999000033</p>
                  <p>DECLARATION UNDER GST Act 2017.</p>
                  <p>We declare that we are the first seller in the state liable to tax under GST Act 2017 and that we shall pay the single point tax on above sale.</p>
                </div>
              </div>
            </div>

            {/* Data grid */}
            <table className="w-full border-collapse mt-2">
              <thead>
                {/* Category + product alias row */}
                <tr>
                  <td className="py-0.5 px-1"></td>
                  {prods.map(p => (
                    <td key={p.id} className="py-0.5 px-1 text-center font-bold border-b">
                      <div className="text-[9px] text-muted-foreground">{p.category}</div>
                      <div className="font-bold">{p.reportAlias}</div>
                    </td>
                  ))}
                  <td className="py-0.5 px-1"></td>
                </tr>
                <tr className="border-b">
                  <td className="py-0.5 px-1 font-bold">HSN</td>
                  {prods.map(p => <td key={p.id} className="py-0.5 px-1 text-center">{p.hsn}</td>)}
                  <td className="py-0.5 px-1"></td>
                </tr>
                <tr className="border-b">
                  <td className="py-0.5 px-1 font-bold">Rate</td>
                  {prods.map(p => <td key={p.id} className="py-0.5 px-1 text-center">{p.rate.toFixed(2)}</td>)}
                  <td className="py-0.5 px-1"></td>
                </tr>
                <tr className="border-b">
                  <td className="py-0.5 px-1 font-bold">Date</td>
                  {prods.map(p => <td key={p.id} className="py-0.5 px-1 text-center font-bold">Qty</td>)}
                  <td className="py-0.5 px-1 text-right font-bold">Total Amount</td>
                </tr>
              </thead>
              <tbody>
                {cust.dailyRows.map(row => (
                  <tr key={row.date}>
                    <td className="py-0.5 px-1">{row.day}</td>
                    {row.qty.map((val, i) => (
                      <td key={i} className="py-0.5 px-1 text-center">{q(val)}</td>
                    ))}
                    <td className="py-0.5 px-1 text-right">{money(row.dayTotal)}</td>
                  </tr>
                ))}

                {/* Pkts */}
                <tr className="border-t font-bold">
                  <td className="py-0.5 px-1">Pkts</td>
                  {cust.totals.pkts.map((v, i) => <td key={i} className="py-0.5 px-1 text-center">{v}</td>)}
                  <td className="py-0.5 px-1"></td>
                </tr>
                {/* Kg\ltr */}
                <tr className="font-bold">
                  <td className="py-0.5 px-1">Kg\ltr</td>
                  {cust.totals.kgLtr.map((v, i) => <td key={i} className="py-0.5 px-1 text-center">{v.toFixed(1)}</td>)}
                  <td className="py-0.5 px-1"></td>
                </tr>
                {/* BASIC with grand */}
                <tr className="font-bold">
                  <td className="py-0.5 px-1">BASIC</td>
                  {cust.totals.basic.map((v, i) => <td key={i} className="py-0.5 px-1 text-center">{v.toFixed(2)}</td>)}
                  <td className="py-0.5 px-1 text-right font-bold border-t">{cust.totals.basicGrand.toFixed(2)}</td>
                </tr>
                {/* CGST */}
                <tr>
                  <td className="py-0.5 px-1 font-bold">CGST</td>
                  {cust.totals.cgst.map((v, i) => <td key={i} className="py-0.5 px-1 text-center">{v.toFixed(3)}</td>)}
                  <td className="py-0.5 px-1 text-right">{cust.totals.cgstGrand.toFixed(3)}</td>
                </tr>
                {/* SGST */}
                <tr>
                  <td className="py-0.5 px-1 font-bold">SGST</td>
                  {cust.totals.sgst.map((v, i) => <td key={i} className="py-0.5 px-1 text-center">{v.toFixed(3)}</td>)}
                  <td className="py-0.5 px-1 text-right">{cust.totals.sgstGrand.toFixed(3)}</td>
                </tr>
                {/* Amount with grand */}
                <tr className="border-t font-bold">
                  <td className="py-0.5 px-1">Amount</td>
                  {cust.totals.amount.map((v, i) => <td key={i} className="py-0.5 px-1 text-center">{v.toFixed(2)}</td>)}
                  <td className="py-0.5 px-1 text-right border-t border-b font-bold">{cust.totals.amountGrand.toFixed(2)}</td>
                </tr>
              </tbody>
            </table>

            <div className="mt-4 text-[9px] flex justify-between">
              <div>
                <p>NOTE: - Kindly acknowledge receipt of this bill immediately.</p>
                <p>- Variation in the above bill if any may be intimated within 15 days.</p>
                <p>- Demand Draft should be issued in favour of "THE MANAGING DIRECTOR HAVERI"</p>
                <p className="mt-1 font-bold">CO-OP MILK PRODUCERS SOCIETIES UNION LTD., HAVERI.</p>
              </div>
              <div className="text-right font-bold">AUTHORISED SIGNATURE.</div>
            </div>
          </div>
        );
      });

      const summaryPage = (
        <div key="summary">
          <ReportHeader title="Credit Sales — Summary" subtitle={`Period: ${from} to ${to}`} />
          <p className="text-xs font-bold mb-3">Summary</p>
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="border bg-muted/30">
                <th className="border py-1.5 px-2 text-left font-bold">Sl No.</th>
                <th className="border py-1.5 px-2 text-left font-bold">Code</th>
                <th className="border py-1.5 px-2 text-left font-bold">Name</th>
                <th className="border py-1.5 px-2 text-right font-bold">Total</th>
              </tr>
            </thead>
            <tbody>
              {apiData.summary.map(s => (
                <tr key={s.sl} className="border">
                  <td className="border py-1 px-2">{s.sl}</td>
                  <td className="border py-1 px-2 font-mono font-medium">{s.code}</td>
                  <td className="border py-1 px-2 font-medium">{s.name.toUpperCase()}</td>
                  <td className="border py-1 px-2 text-right">{s.total.toFixed(2)}</td>
                </tr>
              ))}
              <tr className="border font-bold bg-muted/30">
                <td className="border py-1.5 px-2" colSpan={3}>Total</td>
                <td className="border py-1.5 px-2 text-right">{apiData.summaryTotal.toFixed(2)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      );

      return [...customerPages, summaryPage];
    }}
  />
);

// ════════════════════════════════════════════════════════════════
// B7. Taluka / Agent Wise — 2 pages per taluka
// ════════════════════════════════════════════════════════════════
export const TalukaAgentSales = () => (
  <SalesReportShell<TalukaAgentResponse>
    title="Taluka/Agent Wise Sales"
    description="Sales grouped by taluka and agent"
    fetcher={(from, to) => fetchTalukaAgent({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      const pages: React.ReactNode[] = [];
      apiData.talukas.forEach(t => {
        // Detailed page
        pages.push(
          <div key={`detail-${t.name}`}>
            <ReportHeader title="Taluka/Agent Wise Sales" subtitle={`Period: ${from} to ${to}`} />
            <p className="text-xs font-bold mb-2">Taluka Name: {t.name}</p>
            <table className="w-full text-[10px] border-collapse">
              <thead>
                <tr className="border bg-muted/30">
                  <th className="border py-1.5 px-1 text-left font-bold">S.No.</th>
                  <th className="border py-1.5 px-1 text-left font-bold">Code</th>
                  <th className="border py-1.5 px-1 text-left font-bold">Customer Name</th>
                  {apiData.products.map(p => <th key={p.id} className="border py-1.5 px-1 text-center font-bold">{p.reportAlias}</th>)}
                  <th className="border py-1.5 px-1 text-right font-bold">Total (₹)</th>
                </tr>
              </thead>
              <tbody>
                {t.customers.map(c => (
                  <tr key={`${c.code}-${c.sl}`} className="border">
                    <td className="border py-1 px-1">{c.sl}</td>
                    <td className="border py-1 px-1 font-mono">{c.code}</td>
                    <td className="border py-1 px-1 font-medium">{c.name}</td>
                    {apiData.products.map(p => <td key={p.id} className="border py-1 px-1 text-center">{fmtQty(c.qty[p.id] ?? 0)}</td>)}
                    <td className="border py-1 px-1 text-right">{fmtINR(c.total)}</td>
                  </tr>
                ))}
                <tr className="border font-bold bg-muted/30">
                  <td className="border py-1.5 px-1" colSpan={3}>TOTAL</td>
                  {apiData.products.map(p => <td key={p.id} className="border py-1.5 px-1 text-center">{fmtQty(t.detailedTotals.qty[p.id] ?? 0)}</td>)}
                  <td className="border py-1.5 px-1 text-right">{fmtINR(t.detailedTotals.total)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        );

        // Summary page
        pages.push(
          <div key={`summary-${t.name}`}>
            <ReportHeader title="Taluka/Agent Wise Sales — Summary" subtitle={`Period: ${from} to ${to}`} />
            <p className="text-xs font-bold mb-2">Taluka Name: {t.name}</p>
            <table className="w-full text-[10px] border-collapse">
              <thead>
                <tr className="border bg-muted/30">
                  <th className="border py-1.5 px-1 text-left font-bold">S.No.</th>
                  <th className="border py-1.5 px-1 text-left font-bold">Code</th>
                  <th className="border py-1.5 px-1 text-left font-bold">Customer Name</th>
                  <th className="border py-1.5 px-1 text-center font-bold">Cookies 20gm</th>
                  <th className="border py-1.5 px-1 text-center font-bold">Butter Cookies 100gm</th>
                  <th className="border py-1.5 px-1 text-center font-bold">Kodubale 180gm</th>
                  <th className="border py-1.5 px-1 text-center font-bold">Paneer Nippattu 400gm</th>
                  <th className="border py-1.5 px-1 text-center font-bold">Milk Total Qty</th>
                  <th className="border py-1.5 px-1 text-center font-bold">Curd Total Qty</th>
                  <th className="border py-1.5 px-1 text-right font-bold">Total Amount (₹)</th>
                </tr>
              </thead>
              <tbody>
                {t.summary.map(s => (
                  <tr key={`sum-${s.code}-${s.sl}`} className="border">
                    <td className="border py-1 px-1">{s.sl}</td>
                    <td className="border py-1 px-1 font-mono">{s.code}</td>
                    <td className="border py-1 px-1 font-medium">{s.name}</td>
                    <td className="border py-1 px-1 text-center">{fmtQty(s.cookies20)}</td>
                    <td className="border py-1 px-1 text-center">{fmtQty(s.butterCookies100)}</td>
                    <td className="border py-1 px-1 text-center">{fmtQty(s.kodubale180)}</td>
                    <td className="border py-1 px-1 text-center">{fmtQty(s.paneerNippattu400)}</td>
                    <td className="border py-1 px-1 text-center">{fmtQty(s.milkTotalQty)}</td>
                    <td className="border py-1 px-1 text-center">{fmtQty(s.curdTotalQty)}</td>
                    <td className="border py-1 px-1 text-right">{fmtINR(s.totalAmount)}</td>
                  </tr>
                ))}
                <tr className="border font-bold bg-muted/30">
                  <td className="border py-1.5 px-1" colSpan={3}>TOTAL</td>
                  <td className="border py-1.5 px-1 text-center">{fmtQty(t.summaryTotals.cookies20)}</td>
                  <td className="border py-1.5 px-1 text-center">{fmtQty(t.summaryTotals.butterCookies100)}</td>
                  <td className="border py-1.5 px-1 text-center">{fmtQty(t.summaryTotals.kodubale180)}</td>
                  <td className="border py-1.5 px-1 text-center">{fmtQty(t.summaryTotals.paneerNippattu400)}</td>
                  <td className="border py-1.5 px-1 text-center">{fmtQty(t.summaryTotals.milkTotalQty)}</td>
                  <td className="border py-1.5 px-1 text-center">{fmtQty(t.summaryTotals.curdTotalQty)}</td>
                  <td className="border py-1.5 px-1 text-right">{fmtINR(t.summaryTotals.totalAmount)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        );
      });
      return pages;
    }}
  />
);

// ════════════════════════════════════════════════════════════════
// B8. Adhoc Sales Abstract — 1 page
// ════════════════════════════════════════════════════════════════
export const AdhocSalesReport = () => (
  <SalesReportShell<AdhocResponse>
    title="Adhoc Sales Abstract"
    description="Emergency/ad-hoc sales summary"
    fetcher={(from, to) => fetchAdhocSales({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      return [(
        <div key="p1">
          <ReportHeader title="Adhoc Sales Abstract" subtitle={`Period: ${from} to ${to}`} />
          <table className="w-full text-[11px] border-collapse">
            <thead>
              <tr className="border bg-muted/30">
                <th className="border py-1.5 px-2 text-left font-bold">S.No.</th>
                <th className="border py-1.5 px-2 text-left font-bold">Indent Date</th>
                <th className="border py-1.5 px-2 text-left font-bold">GP No.</th>
                <th className="border py-1.5 px-2 text-left font-bold">Customer Name</th>
                <th className="border py-1.5 px-2 text-right font-bold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {apiData.rows.map(r => (
                <tr key={`${r.gpNo}-${r.sl}`} className="border">
                  <td className="border py-1 px-2">{r.sl}</td>
                  <td className="border py-1 px-2">{r.indentDate}</td>
                  <td className="border py-1 px-2 font-mono">{r.gpNo}</td>
                  <td className="border py-1 px-2 font-medium">{r.customerName}</td>
                  <td className="border py-1 px-2 text-right">{fmtINR(r.amount)}</td>
                </tr>
              ))}
              <tr className="border font-bold bg-muted/30">
                <td className="border py-1.5 px-2" colSpan={4}>TOTAL</td>
                <td className="border py-1.5 px-2 text-right">{fmtINR(apiData.totalAmount)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
  />
);

// ════════════════════════════════════════════════════════════════
// B9. GST Sales Statement — 1 page
// ════════════════════════════════════════════════════════════════
export const GSTStatement = () => (
  <SalesReportShell<GstStatementResponse>
    title="GST Sales Statement"
    description="GST-compliant sales with tax breakdowns"
    fetcher={(from, to) => fetchGstStatement({ from, to })}
    renderPages={(from, to, apiData) => {
      if (!apiData) return [];
      return [(
        <div key="p1">
          <ReportHeader title="GST Sales Statement" subtitle={`Period: ${from} to ${to}`} />
          <table className="w-full text-[10px] border-collapse">
            <thead>
              <tr className="border bg-muted/30">
                <th className="border py-1.5 px-1 text-left font-bold">Sl</th>
                <th className="border py-1.5 px-1 text-left font-bold">Product</th>
                <th className="border py-1.5 px-1 text-left font-bold">HSN</th>
                <th className="border py-1.5 px-1 text-right font-bold">Qty</th>
                <th className="border py-1.5 px-1 text-right font-bold">GST%</th>
                <th className="border py-1.5 px-1 text-right font-bold">Taxable Value</th>
                <th className="border py-1.5 px-1 text-right font-bold">CGST</th>
                <th className="border py-1.5 px-1 text-right font-bold">SGST</th>
                <th className="border py-1.5 px-1 text-right font-bold">Total Tax</th>
                <th className="border py-1.5 px-1 text-right font-bold">Invoice Value</th>
              </tr>
            </thead>
            <tbody>
              {apiData.rows.map(r => (
                <tr key={`${r.productId}-${r.gstPct}`} className="border">
                  <td className="border py-1 px-1">{r.sl}</td>
                  <td className="border py-1 px-1 font-medium">{r.productName}</td>
                  <td className="border py-1 px-1 font-mono">{r.hsn}</td>
                  <td className="border py-1 px-1 text-right">{fmtQty(r.qty)}</td>
                  <td className="border py-1 px-1 text-right">{r.gstPct.toFixed(2)}</td>
                  <td className="border py-1 px-1 text-right">{fmtINR(r.taxableValue)}</td>
                  <td className="border py-1 px-1 text-right">{fmtINR(r.cgst)}</td>
                  <td className="border py-1 px-1 text-right">{fmtINR(r.sgst)}</td>
                  <td className="border py-1 px-1 text-right">{fmtINR(r.totalTax)}</td>
                  <td className="border py-1 px-1 text-right font-bold">{fmtINR(r.invoiceValue)}</td>
                </tr>
              ))}
              <tr className="border font-bold bg-muted/30">
                <td className="border py-1.5 px-1" colSpan={3}>TOTAL</td>
                <td className="border py-1.5 px-1 text-right">{fmtQty(apiData.totals.qty)}</td>
                <td className="border py-1.5 px-1"></td>
                <td className="border py-1.5 px-1 text-right">{fmtINR(apiData.totals.taxableValue)}</td>
                <td className="border py-1.5 px-1 text-right">{fmtINR(apiData.totals.cgst)}</td>
                <td className="border py-1.5 px-1 text-right">{fmtINR(apiData.totals.sgst)}</td>
                <td className="border py-1.5 px-1 text-right">{fmtINR(apiData.totals.totalTax)}</td>
                <td className="border py-1.5 px-1 text-right">{fmtINR(apiData.totals.invoiceValue)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )];
    }}
  />
);