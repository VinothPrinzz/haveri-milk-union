import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader, {
  FilterBar,
  EmptyState,
  fmtNum,
  fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ChevronLeft, ChevronRight, Printer, FileBarChart2 } from "lucide-react";
import { fetchStockEntries } from "@/services/api";

function ReportHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="text-center mb-4">
      <p className="text-[12px] font-bold uppercase tracking-wide">HAVERI MILK UNION</p>
      <p className="text-[14px] font-bold mt-0.5">{title}</p>
      {subtitle && <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}

export default function StockReportsPage() {
  const today = new Date().toISOString().split("T")[0];
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [generated, setGenerated] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);

  const { data: stockEntries = [], isLoading } = useQuery({
    queryKey: ["stock-report", from, to],
    queryFn: () => fetchStockEntries(from),
    enabled: generated,
  });

  const handleGenerate = () => {
    setGenerated(true);
    setCurrentPage(0);
  };

  const pages = generated ? [
    <div key="p1" className="text-foreground">
      <ReportHeader title="STOCK POSITION REPORT" subtitle={`${fmtDate(from)} to ${fmtDate(to)}`} />
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className="border border-border py-1.5 px-2 text-left font-bold">Product</th>
            <th className="border border-border py-1.5 px-2 text-left font-bold">Category</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold num">Opening</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold num">Received</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold num">Dispatched</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold num">Wastage</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold num">Closing</th>
          </tr>
        </thead>
        <tbody>
          {(stockEntries as any[]).map((s: any) => (
            <tr key={s.id}>
              <td className="border border-border py-1 px-2">{(s.productName || "").replace("Nandini ", "")}</td>
              <td className="border border-border py-1 px-2 uppercase">{s.category}</td>
              <td className="border border-border py-1 px-2 text-right num">{fmtNum(s.opening)}</td>
              <td className="border border-border py-1 px-2 text-right num">{fmtNum(s.received)}</td>
              <td className="border border-border py-1 px-2 text-right num">{fmtNum(s.dispatched)}</td>
              <td className="border border-border py-1 px-2 text-right num">{fmtNum(s.wastage)}</td>
              <td className="border border-border py-1 px-2 text-right font-semibold num">
                {fmtNum(s.closing ?? (s.opening + s.received - s.dispatched - s.wastage))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  ] : [];

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Stock Reports"
        subtitle="Generate FGS stock position reports"
        actions={
          generated && (
            <Button size="sm" variant="outline" className="h-8" onClick={() => window.print()}>
              <Printer className="h-3.5 w-3.5 mr-1.5" /> Print
            </Button>
          )
        }
      />

      <FilterBar>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="erp-input w-40" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="erp-input w-40" />
        </div>
        <Button size="sm" className="h-8 self-end" onClick={handleGenerate}>
          <FileBarChart2 className="h-3.5 w-3.5 mr-1.5" />
          Generate Report
        </Button>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4">
        {!generated ? (
          <EmptyState title="Choose a date range and click Generate" hint="Stock movements within the range will appear here" />
        ) : isLoading ? (
          <div className="erp-panel p-8 text-center text-muted-foreground">Loading report…</div>
        ) : pages.length === 0 ? (
          <EmptyState title="No stock movements in this range" />
        ) : (
          <div>
            <div className="flex items-center justify-between mb-3 erp-page-actions">
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={currentPage === 0}
                onClick={() => setCurrentPage(p => p - 1)}
              >
                <ChevronLeft className="h-3.5 w-3.5" /> Previous
              </Button>
              <span className="text-[12px] text-muted-foreground">
                Page {currentPage + 1} of {pages.length}
              </span>
              <Button
                variant="outline"
                size="sm"
                className="h-8"
                disabled={currentPage >= pages.length - 1}
                onClick={() => setCurrentPage(p => p + 1)}
              >
                Next <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
            <div className="erp-panel p-6 max-w-[840px] mx-auto print:max-w-full print:p-0 print:border-0 print:shadow-none">
              <div className="print-document">
               {pages[currentPage]}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}