import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fetchStockEntries } from "@/services/api";
import { ChevronLeft, ChevronRight, Printer } from "lucide-react";

// Shared report header
function ReportHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="text-center mb-4">
      <p className="font-bold text-sm uppercase tracking-wide">HAVERI MILK UNION</p>
      <p className="font-bold text-base mt-0.5">{title}</p>
      {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}

export default function StockReportsPage() {
  const today = new Date().toISOString().split("T")[0];

  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [generated, setGenerated] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);

  // API accepts a single snapshot date; use report end-date.
  const { data: stockEntries = [] } = useQuery({
    queryKey: ["stock-report", from, to],           // Important: dates in queryKey
    queryFn: () => fetchStockEntries(to),
    enabled: generated,                             // Only fetch after Generate is clicked
  });

  const pages = generated ? [
    <div key="p1">
      <ReportHeader 
        title="STOCK POSITION REPORT" 
        subtitle={`${from} to ${to}`} 
      />
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="border bg-muted/30">
            <th className="border py-1.5 px-2 text-left font-bold">Product</th>
            <th className="border py-1.5 px-2 text-left font-bold">Category</th>
            <th className="border py-1.5 px-2 text-right font-bold">Opening</th>
            <th className="border py-1.5 px-2 text-right font-bold">Received</th>
            <th className="border py-1.5 px-2 text-right font-bold">Dispatched</th>
            <th className="border py-1.5 px-2 text-right font-bold">Wastage</th>
            <th className="border py-1.5 px-2 text-right font-bold">Closing</th>
          </tr>
        </thead>
        <tbody>
          {stockEntries.map(s => (
            <tr key={s.id} className="border">
              <td className="border py-1 px-2">{s.productName.replace("Nandini ", "")}</td>
              <td className="border py-1 px-2">{s.category}</td>
              <td className="border py-1 px-2 text-right">{s.opening}</td>
              <td className="border py-1 px-2 text-right">{s.received}</td>
              <td className="border py-1 px-2 text-right">{s.dispatched}</td>
              <td className="border py-1 px-2 text-right">{s.wastage}</td>
              <td className="border py-1 px-2 text-right font-semibold">
                {s.closing ?? (s.opening + s.received - s.dispatched - s.wastage)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ] : [];

  const handleGenerate = () => {
    setGenerated(true);
    setCurrentPage(0);
  };

  return (
    <div>
      <PageHeader title="Stock Reports" description="Generate FGS stock position reports" />

      {/* Date pickers + Generate button */}
      <div className="border rounded-lg p-4 mb-4 bg-card flex items-end gap-4">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">From</label>
          <input 
            type="date" 
            value={from} 
            onChange={e => setFrom(e.target.value)}
            className="h-9 w-40 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
          />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium text-muted-foreground">To</label>
          <input 
            type="date" 
            value={to} 
            onChange={e => setTo(e.target.value)}
            className="h-9 w-40 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
          />
        </div>
        <Button onClick={handleGenerate}>Generate Report</Button>
      </div>

      {generated && pages.length > 0 && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <span className="text-sm font-medium">Stock Position Report</span>
            <div className="flex items-center gap-2">
              <Button 
                variant="outline" 
                size="icon" 
                className="h-8 w-8" 
                onClick={() => setCurrentPage(p => Math.max(0, p - 1))} 
                disabled={currentPage === 0}
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {currentPage + 1} of {pages.length}
              </span>
              <Button 
                variant="outline" 
                size="icon" 
                className="h-8 w-8" 
                onClick={() => setCurrentPage(p => Math.min(pages.length - 1, p + 1))} 
                disabled={currentPage === pages.length - 1}
              >
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
    </div>
  );
}