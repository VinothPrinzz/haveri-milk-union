import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { fetchGatePassReport, type GatePassResponse } from "@/services/report";

const fmtINR = (n: number | string) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;

const ROWS_PER_PAGE = 20;

export default function GatePassReportPage() {
  const today = new Date().toISOString().split("T")[0];
  const monthStart = today.substring(0, 8) + "01";

  const [fromDate, setFromDate] = useState(monthStart);
  const [toDate, setToDate] = useState(today);
  const [showReport, setShowReport] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);

  const { data, isLoading, refetch } = useQuery<GatePassResponse>({
    queryKey: ["gate-pass-report", fromDate, toDate],
    queryFn: () => fetchGatePassReport({ from: fromDate, to: toDate, limit: 500 }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setCurrentPage(0);
    setShowReport(true);
  };

  const rows = data?.rows ?? [];
  const totalAmount = data?.totalAmount ?? 0;

  // Client-side visual pagination (~20 rows per printed page)
  const pageCount = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const visibleRows = rows.slice(currentPage * ROWS_PER_PAGE, (currentPage + 1) * ROWS_PER_PAGE);

  const reportPage = (
    <div>
      <div className="text-center mb-3">
        <h2 className="text-sm font-bold uppercase tracking-wide">HAVERI MILK UNION LTD — HAVERI</h2>
        <p className="text-xs font-bold mt-1">Gate Pass Sales Report</p>
        <p className="text-[10px] text-muted-foreground mt-0.5">Period: {fromDate} to {toDate}</p>
      </div>

      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border bg-muted/30">
            <th className="border py-1.5 px-2 text-left font-bold">GP No.</th>
            <th className="border py-1.5 px-2 text-left font-bold">Date</th>
            <th className="border py-1.5 px-2 text-left font-bold">Agent Name</th>
            <th className="border py-1.5 px-2 text-left font-bold">Items</th>
            <th className="border py-1.5 px-2 text-right font-bold">Amount</th>
          </tr>
        </thead>
        <tbody>
          {visibleRows.map(r => (
            <tr key={r.gpNo + r.date} className="border">
              <td className="border py-1 px-2 font-mono">{r.gpNo}</td>
              <td className="border py-1 px-2">{r.date}</td>
              <td className="border py-1 px-2 font-medium">{r.agentName}</td>
              <td className="border py-1 px-2 text-[10px] text-muted-foreground whitespace-pre-line">
                {r.items.map(it => `${it.name} x ${it.qty}`).join(", ")}
              </td>
              <td className="border py-1 px-2 text-right">{fmtINR(r.amount)}</td>
            </tr>
          ))}

          {/* Grand total shown only on the last visual page */}
          {currentPage === pageCount - 1 && (
            <tr className="border font-bold bg-muted/30">
              <td className="border py-1.5 px-2" colSpan={4}>TOTAL</td>
              <td className="border py-1.5 px-2 text-right">{fmtINR(totalAmount)}</td>
            </tr>
          )}

          {rows.length === 0 && (
            <tr><td colSpan={5} className="py-8 text-center text-muted-foreground">No gate pass sales in this period</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div>
      <PageHeader title="Gate Pass Report" description="Summary of gate-pass (agent) direct sales" />

      <Card className="mb-4">
        <CardContent className="p-5 flex flex-wrap items-end gap-4">
          <div>
            <label className="text-sm font-medium mb-1.5 block">From</label>
            <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)}
              className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm" />
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">To</label>
            <input type="date" value={toDate} onChange={e => setToDate(e.target.value)}
              className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm" />
          </div>
          <Button onClick={handleGenerate} disabled={isLoading}>
            {isLoading ? "Generating..." : "Generate Report"}
          </Button>
        </CardContent>
      </Card>

      {showReport && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">Gate Pass Report</span>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="icon" className="h-8 w-8"
                onClick={() => setCurrentPage(p => Math.max(0, p - 1))} disabled={currentPage === 0}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">Page {currentPage + 1} of {pageCount}</span>
              <Button variant="outline" size="icon" className="h-8 w-8"
                onClick={() => setCurrentPage(p => Math.min(pageCount - 1, p + 1))}
                disabled={currentPage === pageCount - 1}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="icon" className="h-8 w-8" onClick={() => window.print()}>
                <Printer className="h-4 w-4" />
              </Button>
            </div>
          </div>

          <div className="border rounded-lg p-6 bg-card min-h-[500px]">
            <div className="max-w-[794px] mx-auto bg-white p-8 shadow-sm print:shadow-none print:p-0">
              {reportPage}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}