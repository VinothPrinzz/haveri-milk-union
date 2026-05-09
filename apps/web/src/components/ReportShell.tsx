// apps/web/src/components/ReportShell.tsx
// ════════════════════════════════════════════════════════════════════
// Unified shell for every report page.
// • Generate / Print (orientation toggle) / Expand fullscreen / Export
// • Adaptive canvas: white page sizes to its content; if wider than
//   the viewport, the body scrolls horizontally so nothing gets cut.
// • printMeta renders only on print (above the table).
// ════════════════════════════════════════════════════════════════════
import { useEffect, useState, type ReactNode } from "react";
import PageHeader, { FilterBar, EmptyState, PrintButton } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronLeft, ChevronRight, FileBarChart2, Maximize2, Minimize2,
  Download, ChevronDown,
} from "lucide-react";

export type Exporter = {
  label: string;        // shown in dropdown ("CSV", "Tally XML", "Tally CSV")
  filename: string;     // includes extension
  mimeType: string;
  build: () => string | Blob;
};

export interface ReportShellProps {
  title: string;
  subtitle?: string;
  filters: ReactNode;
  onGenerate: () => void;
  printOrientation?: "portrait" | "landscape";
  printMeta?: ReactNode;
  printFooter?: ReactNode;
  exporters?: Exporter[];
  state: {
    generated: boolean;
    loading: boolean;
    pages: ReactNode[];
    pageLabel?: (idx: number) => string;
    emptyMessage?: string;
  };
  beforePrint?: () => boolean | void;
}

export default function ReportShell({
  title, subtitle, filters, onGenerate,
  printOrientation = "portrait",
  printMeta, printFooter, exporters,
  state, beforePrint,
}: ReportShellProps) {
  const { generated, loading, pages, pageLabel, emptyMessage } = state;
  const [currentPage, setCurrentPage] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => { setCurrentPage(0); }, [generated, pages.length]);

  useEffect(() => {
    const cls = "report-fullscreen";
    if (fullscreen) {
      document.body.classList.add(cls);
      const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setFullscreen(false); };
      window.addEventListener("keydown", onKey);
      return () => {
        document.body.classList.remove(cls);
        window.removeEventListener("keydown", onKey);
      };
    } else {
      document.body.classList.remove(cls);
    }
  }, [fullscreen]);

  const hasPages = generated && pages.length > 0;

  return (
    <div className="flex flex-col h-full report-shell">
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={
          hasPages && (
            <div className="flex items-center gap-2">
              {exporters && exporters.length > 0 && <ExportMenu exporters={exporters} />}
              <PrintButton defaultOrient={printOrientation} beforePrint={beforePrint} />
            </div>
          )
        }
      />

      <FilterBar>
        {filters}
        <div className="ml-auto flex items-end gap-2">
          <Button size="sm" className="h-8" onClick={onGenerate}>
            <FileBarChart2 className="h-3.5 w-3.5 mr-1.5" /> Generate
          </Button>
          <Button
            size="sm" variant="outline" className="h-8"
            disabled={!hasPages}
            title={fullscreen ? "Exit fullscreen (Esc)" : "Expand to fullscreen"}
            onClick={() => setFullscreen(v => !v)}
          >
            {fullscreen
              ? <><Minimize2 className="h-3.5 w-3.5 mr-1.5" /> Exit</>
              : <><Maximize2 className="h-3.5 w-3.5 mr-1.5" /> Expand</>}
          </Button>
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 report-body">
        {!generated ? (
          <EmptyState title="Choose filters and click Generate" />
        ) : loading ? (
          <div className="erp-panel p-8 text-center text-muted-foreground">Loading report…</div>
        ) : pages.length === 0 ? (
          <EmptyState title={emptyMessage ?? "No data for this filter"} />
        ) : (
          <>
            {pages.length > 1 && (
              <div className="flex items-center justify-between mb-3 erp-page-actions">
                <Button variant="outline" size="sm" className="h-8"
                        disabled={currentPage === 0}
                        onClick={() => setCurrentPage(p => p - 1)}>
                  <ChevronLeft className="h-3.5 w-3.5" /> Previous
                </Button>
                <span className="text-[12px] text-muted-foreground">
                  Page {currentPage + 1} of {pages.length}
                  {pageLabel ? ` · ${pageLabel(currentPage)}` : ""}
                </span>
                <Button variant="outline" size="sm" className="h-8"
                        disabled={currentPage >= pages.length - 1}
                        onClick={() => setCurrentPage(p => p + 1)}>
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}

            <div className="report-canvas-wrap">
              <div className="report-canvas" data-orient={printOrientation}>
                {printMeta && <div className="print-only print-letterhead">{printMeta}</div>}
                <div className="print-document">{pages[currentPage]}</div>
                {printFooter && <div className="print-only print-footer">{printFooter}</div>}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ExportMenu({ exporters }: { exporters: Exporter[] }) {
  const handle = (exp: Exporter) => {
    const out = exp.build();
    const blob = out instanceof Blob ? out : new Blob([out], { type: exp.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = exp.filename;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  if (exporters.length === 1) {
    const e = exporters[0];
    return (
      <button type="button" onClick={() => handle(e)}
        className="h-8 px-3 inline-flex items-center gap-1.5 text-[12.5px] border border-border bg-background hover:bg-accent rounded-sm">
        <Download className="h-3.5 w-3.5" /> {e.label}
      </button>
    );
  }

  const [main, ...rest] = exporters;
  return (
    <div className="inline-flex items-stretch">
      <button type="button" onClick={() => handle(main)}
        className="h-8 px-3 inline-flex items-center gap-1.5 text-[12.5px] border border-border bg-background hover:bg-accent rounded-l-sm rounded-r-none border-r-0"
        title={`Export — ${main.label}`}>
        <Download className="h-3.5 w-3.5" /> Export
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground ml-1">{main.label}</span>
      </button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button type="button" aria-label="Other export formats"
            className="h-8 px-1.5 inline-flex items-center border border-border bg-background hover:bg-accent rounded-r-sm rounded-l-none">
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-[12.5px]">
          <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">Export format</DropdownMenuLabel>
          <DropdownMenuItem onClick={() => handle(main)}>{main.label}</DropdownMenuItem>
          {rest.length > 0 && <DropdownMenuSeparator />}
          {rest.map(e => (
            <DropdownMenuItem key={e.label} onClick={() => handle(e)}>{e.label}</DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

export function ReportPrintMeta({
  title, subtitle, rows,
}: {
  title: string;
  subtitle?: string;
  rows?: Array<{ label: string; value: ReactNode }>;
}) {
  return (
    <div className="report-letterhead">
      <h1 className="report-letterhead-co">
        Haveri District Co-operative Milk Producers' Union Ltd.
      </h1>
      <p className="report-letterhead-addr">
        Haveri, Karnataka, India · GSTIN: 29XXXXXXXX1Z5
      </p>
      <h2 className="report-letterhead-title">{title}</h2>
      {subtitle && <p className="report-letterhead-sub">{subtitle}</p>}
      {rows && rows.length > 0 && (
        <div className="report-letterhead-meta">
          {rows.map((r, i) => (
            <span key={i}><strong>{r.label}:</strong> {r.value}</span>
          ))}
        </div>
      )}
      <div className="report-letterhead-printdate">
        Print Date: {new Date().toLocaleString("en-IN")}
      </div>
    </div>
  );
}