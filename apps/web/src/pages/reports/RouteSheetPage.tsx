import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { fetchBatches } from "@/services/api";
import { fetchRouteSheet, type RouteSheetResponse } from "@/services/report";

const fmtINR = (n: number | string) => `₹${Number(n || 0).toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const fmtQty = (n: number | string) => String(Number(n || 0));

export default function RouteSheetPage() {
  const today = new Date().toISOString().split("T")[0];
  const [batch, setBatch] = useState<string>("");
  const [date, setDate] = useState<string>(today);
  const [currentPage, setCurrentPage] = useState(0);
  const [generated, setGenerated] = useState(false);

  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  const { data, isLoading, refetch } = useQuery<RouteSheetResponse>({
    queryKey: ["route-sheet", date, batch],
    queryFn: () => fetchRouteSheet({ date, batchId: batch || undefined }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setCurrentPage(0);
    setGenerated(true);
  };

  const pages = generated && data ? data.routes.map(route => (
    <div key={route.id}>
      {/* Header */}
      <div className="text-center mb-3">
        <h2 className="text-sm font-bold uppercase tracking-wide">HAVERI MILK UNION LTD — HAVERI</h2>
        <p className="text-xs font-bold mt-1">Route Sheet</p>
        <div className="text-[10px] text-muted-foreground mt-1 grid grid-cols-2 gap-1 text-left max-w-md mx-auto">
          <div><strong>Route:</strong> {route.name} ({route.code})</div>
          <div><strong>Date:</strong> {data.date}</div>
          <div><strong>Contractor:</strong> {route.contractor.name ?? "—"}</div>
          <div><strong>Vehicle:</strong> {route.contractor.vehicleNumber ?? "—"}</div>
          <div><strong>Dispatch:</strong> {route.dispatchTime ?? "—"}</div>
          <div><strong>Batch:</strong> {data.batch?.name ?? "All"}</div>
        </div>
      </div>

      {/* Table */}
      <table className="w-full text-[10px] border-collapse">
        <thead>
          <tr className="border bg-muted/30">
            <th className="border py-1.5 px-1 text-left font-bold">Sl</th>
            <th className="border py-1.5 px-1 text-left font-bold">Customer</th>
            {data.acrossProducts.map(p => (
              <th key={p.id} className="border py-1.5 px-1 text-center font-bold whitespace-nowrap">{p.reportAlias}</th>
            ))}
            <th className="border py-1.5 px-1 text-center font-bold">Other Products</th>
            <th className="border py-1.5 px-1 text-right font-bold">Net Amount</th>
            <th className="border py-1.5 px-1 text-right font-bold">Crates</th>
          </tr>
        </thead>
        <tbody>
          {route.customers.map(cust => (
            <tr key={cust.id} className="border">
              <td className="border py-1 px-1">{cust.sl}</td>
              <td className="border py-1 px-1 font-medium">
                <span className="font-mono text-[9px] text-muted-foreground">{cust.code}</span> {cust.name}
              </td>
              {data.acrossProducts.map(p => (
                <td key={p.id} className="border py-1 px-1 text-center">{cust.acrossQty[p.id] ? fmtQty(cust.acrossQty[p.id]) : "—"}</td>
              ))}
              <td className="border py-1 px-1 text-[9px] text-muted-foreground">{cust.othersText || "—"}</td>
              <td className="border py-1 px-1 text-right font-mono">{cust.netAmount ? fmtINR(cust.netAmount) : "—"}</td>
              <td className="border py-1 px-1 text-right">{cust.crates || "—"}</td>
            </tr>
          ))}
          <tr className="border font-bold bg-muted/30">
            <td className="border py-1 px-1" colSpan={2}>TOTAL</td>
            {data.acrossProducts.map(p => (
              <td key={p.id} className="border py-1 px-1 text-center">{fmtQty(route.totals.acrossQty[p.id] ?? 0) || "—"}</td>
            ))}
            <td className="border py-1 px-1 text-center">{fmtQty(route.totals.othersQty) || "—"}</td>
            <td className="border py-1 px-1 text-right font-mono">{fmtINR(route.totals.netAmount)}</td>
            <td className="border py-1 px-1 text-right">{route.totals.crates}</td>
          </tr>
          {route.customers.length === 0 && (
            <tr>
              <td colSpan={data.acrossProducts.length + 5} className="py-3 text-center text-muted-foreground">
                No customers on this route
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )) : [];

  return (
    <div>
      <PageHeader title="Route Sheet" description="Daily route-wise customer indent sheet" />

      <Card className="mb-4">
        <CardContent className="p-5 flex flex-wrap items-end gap-4">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Batch</label>
            <Select value={batch || "all"} onValueChange={(value) => setBatch(value === "all" ? "" : value)}>
              <SelectTrigger className="w-44"><SelectValue placeholder="All Batches" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All Batches</SelectItem>
                {batches.map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>{b.whichBatch || b.batchCode || b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <label className="text-sm font-medium mb-1.5 block">Date</label>
            <input type="date" value={date} onChange={e => setDate(e.target.value)}
              className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm" />
          </div>
          <Button onClick={handleGenerate} disabled={isLoading}>
            {isLoading ? "Generating..." : "Generate Report"}
          </Button>
        </CardContent>
      </Card>

      {generated && pages.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">Route Sheet — {data?.routes[currentPage]?.name}</span>
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
              {pages[currentPage]}
            </div>
          </div>
        </div>
      )}

      {generated && pages.length === 0 && !isLoading && (
        <Card><CardContent className="p-10 text-center text-muted-foreground">No active routes to display.</CardContent></Card>
      )}
    </div>
  );
}