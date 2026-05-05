import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { EmptyState } from "@/components/PageHeader";

interface ReportViewerProps {
  title: string;
  pages: React.ReactNode[];
}

export function ReportViewer({ title, pages }: ReportViewerProps) {
  const [currentPage, setCurrentPage] = useState(0);

  if (!pages.length) {
    return (
      <div className="erp-panel">
        <EmptyState title="No data for selected range." hint="Adjust your filters and try again." />
      </div>
    );
  }

  return (
    <div className="erp-panel">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border no-print">
        <span className="text-[12px] uppercase tracking-wide font-semibold text-muted-foreground">{title}</span>
        <div className="flex items-center gap-1">
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setCurrentPage(Math.max(0, currentPage - 1))} disabled={currentPage === 0}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <span className="text-[12px] text-muted-foreground px-2 num">Page {currentPage + 1} of {pages.length}</span>
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setCurrentPage(Math.min(pages.length - 1, currentPage + 1))} disabled={currentPage === pages.length - 1}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2 ml-1" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5 mr-1.5" /> Print
          </Button>
        </div>
      </div>
      <div className="bg-white p-6 min-h-[600px]">
        {pages[currentPage]}
      </div>
    </div>
  );
}

/** Used inside a single report page when an in-page letterhead is desired
    in addition to the global ErpShell letterhead. */
export function ReportHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="text-center mb-4 pb-3 border-b border-foreground/30">
      <h2 className="text-[13px] font-bold uppercase tracking-wide">HAVERI MILK UNION</h2>
      <h3 className="text-[13px] font-bold mt-0.5">{title}</h3>
      {subtitle && <p className="text-[11px] text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}