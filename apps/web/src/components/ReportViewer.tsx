import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, Maximize2, Printer } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";

interface ReportViewerProps {
  title: string;
  pages: React.ReactNode[];
}

export function ReportViewer({ title, pages }: ReportViewerProps) {
  const [currentPage, setCurrentPage] = useState(0);

  if (!pages.length) return (
    <Card><CardContent className="py-12 text-center text-muted-foreground">No data for selected range.</CardContent></Card>
  );

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm font-medium text-muted-foreground">{title}</span>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setCurrentPage(Math.max(0, currentPage - 1))} disabled={currentPage === 0}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-sm text-muted-foreground">Page {currentPage + 1} of {pages.length}</span>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setCurrentPage(Math.min(pages.length - 1, currentPage + 1))} disabled={currentPage === pages.length - 1}>
            <ChevronRight className="h-4 w-4" />
          </Button>
          <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => window.print()}><Printer className="h-4 w-4" /></Button>
        </div>
      </div>
      <div className="rounded-lg border bg-white p-8 shadow-sm min-h-[600px]">
        {pages[currentPage]}
      </div>
    </div>
  );
}

export function ReportHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="text-center mb-4 pb-3 border-b">
      <h2 className="text-sm font-bold uppercase tracking-wide">HAVERI MILK UNION</h2>
      <h3 className="text-sm font-bold mt-0.5">{title}</h3>
      {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
    </div>
  );
}
