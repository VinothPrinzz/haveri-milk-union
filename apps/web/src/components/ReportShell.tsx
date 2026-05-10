// apps/web/src/components/ReportShell.tsx
// ════════════════════════════════════════════════════════════════════
// Unified shell for every report page.
//
// Key improvements:
// • ?clean=1 mode (opened in new tab) → shows ONLY the paper (pure print preview).
//   No header, no filter bar, no buttons, no pager toolbar — just the report pages.
// • Fullscreen mode → immersive "paper-only" view with tiny floating HUD
//   (auto-fades, reappears on mouse move / key press).
// • Normal view keeps full UI (header + filters + Generate button + pager).
// • Ctrl+P / Cmd+P still works everywhere with correct orientation.
// • Arrow keys / Home / End still work for navigation.
// ════════════════════════════════════════════════════════════════════

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";
import PageHeader, {
  FilterBar,
  EmptyState,
  PrintButton,
  setPrintOrientation,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ChevronLeft,
  ChevronRight,
  FileBarChart2,
  Maximize2,
  Minimize2,
  Download,
  ChevronDown,
  ExternalLink,
  X,
} from "lucide-react";

export type Exporter = {
  label: string;
  filename: string;
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
  title,
  subtitle,
  filters,
  onGenerate,
  printOrientation = "portrait",
  printMeta,
  printFooter,
  exporters,
  state,
  beforePrint,
}: ReportShellProps) {
  const { generated, loading, pages, pageLabel, emptyMessage } = state;

  const [currentPage, setCurrentPage] = useState(0);
  const [fullscreen, setFullscreen] = useState(false);
  const [hudVisible, setHudVisible] = useState(true);
  const hudTimer = useRef<number | null>(null);

  const location = useLocation();
  const isClean = new URLSearchParams(location.search).get("clean") === "1";

  // Reset page when report changes
  useEffect(() => {
    setCurrentPage(0);
  }, [generated, pages.length]);

  // ── Fullscreen body class + Esc handler ──
  useEffect(() => {
    const cls = "report-fullscreen";
    if (fullscreen) {
      document.body.classList.add(cls);
      const onKey = (e: KeyboardEvent) => {
        if (e.key === "Escape") setFullscreen(false);
      };
      window.addEventListener("keydown", onKey);
      return () => {
        document.body.classList.remove(cls);
        window.removeEventListener("keydown", onKey);
      };
    } else {
      document.body.classList.remove(cls);
    }
  }, [fullscreen]);

  // ── HUD auto-fade (only in fullscreen) ──
  useEffect(() => {
    if (!fullscreen) {
      setHudVisible(true);
      return;
    }

    const bump = () => {
      setHudVisible(true);
      if (hudTimer.current) window.clearTimeout(hudTimer.current);
      hudTimer.current = window.setTimeout(() => setHudVisible(false), 2500);
    };

    bump();
    window.addEventListener("mousemove", bump);
    window.addEventListener("keydown", bump);

    return () => {
      window.removeEventListener("mousemove", bump);
      window.removeEventListener("keydown", bump);
      if (hudTimer.current) window.clearTimeout(hudTimer.current);
    };
  }, [fullscreen]);

  // ── Keyboard shortcuts ──
  useEffect(() => {
    if (!generated || pages.length === 0) return;

    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      const editable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        (e.target as HTMLElement)?.isContentEditable;

      if (editable) return;

      // Ctrl/Cmd + P → Print
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "p") {
        if (beforePrint && beforePrint() === false) return;
        e.preventDefault();
        const stored = window.localStorage.getItem("erp:printOrient") as
          | "portrait"
          | "landscape"
          | null;
        setPrintOrientation(stored ?? printOrientation);
        setTimeout(() => window.print(), 30);
        return;
      }

      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

      if (e.key === "ArrowRight" || e.key === "PageDown") {
        if (currentPage < pages.length - 1) {
          e.preventDefault();
          setCurrentPage((p) => Math.min(pages.length - 1, p + 1));
        }
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        if (currentPage > 0) {
          e.preventDefault();
          setCurrentPage((p) => Math.max(0, p - 1));
        }
      } else if (e.key === "Home") {
        e.preventDefault();
        setCurrentPage(0);
      } else if (e.key === "End") {
        e.preventDefault();
        setCurrentPage(pages.length - 1);
      }
    };

    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [generated, pages.length, currentPage, printOrientation, beforePrint]);

  const openInNewTab = () => {
    const url = new URL(window.location.href);
    url.searchParams.set("clean", "1");
    window.open(url.toString(), "_blank", "noopener,noreferrer");
  };

  const hasPages = generated && pages.length > 0;

  // ── Decide whether to show full UI or pure paper mode ──
  const showFullUI = !isClean && !fullscreen;

  return (
    <div className="flex flex-col h-full report-shell">
      {/* PageHeader + FilterBar only in normal mode */}
      {showFullUI && (
        <>
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

              {!isClean && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-8"
                  disabled={!hasPages}
                  title="Open clean view in a new tab"
                  onClick={openInNewTab}
                >
                  <ExternalLink className="h-3.5 w-3.5 mr-1.5" /> Open
                </Button>
              )}

              <Button
                size="sm"
                variant="outline"
                className="h-8"
                disabled={!hasPages}
                title={fullscreen ? "Exit fullscreen (Esc)" : "Expand to fullscreen"}
                onClick={() => setFullscreen((v) => !v)}
              >
                {fullscreen ? (
                  <>
                    <Minimize2 className="h-3.5 w-3.5 mr-1.5" /> Exit
                  </>
                ) : (
                  <>
                    <Maximize2 className="h-3.5 w-3.5 mr-1.5" /> Fullscreen
                  </>
                )}
              </Button>
            </div>
          </FilterBar>
        </>
      )}

      {/* Main content area */}
      <div
        className={`flex-1 overflow-auto report-body ${
          isClean || fullscreen ? "p-0" : "p-4"
        }`}
      >
        {!generated ? (
          <EmptyState title="Choose filters and click Generate" />
        ) : loading ? (
          <div className="erp-panel p-8 text-center text-muted-foreground">
            Loading report…
          </div>
        ) : pages.length === 0 ? (
          <EmptyState title={emptyMessage ?? "No data for this filter"} />
        ) : (
          <>
            {/* Pager toolbar only in normal mode */}
            {pages.length > 1 && showFullUI && (
              <div className="flex items-center justify-between mb-3 erp-page-actions report-pager-toolbar">
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={currentPage === 0}
                  onClick={() => setCurrentPage((p) => p - 1)}
                >
                  <ChevronLeft className="h-3.5 w-3.5" /> Previous
                </Button>

                <span className="text-[12px] text-muted-foreground">
                  Page {currentPage + 1} of {pages.length}
                  {pageLabel ? ` · ${pageLabel(currentPage)}` : ""}
                  <span className="ml-3 hidden md:inline text-[11px] opacity-70">
                    ← / → to navigate · Ctrl+P to print
                  </span>
                </span>

                <Button
                  variant="outline"
                  size="sm"
                  className="h-8"
                  disabled={currentPage >= pages.length - 1}
                  onClick={() => setCurrentPage((p) => p + 1)}
                >
                  Next <ChevronRight className="h-3.5 w-3.5" />
                </Button>
              </div>
            )}

            {/* The actual report paper */}
            <div className="report-canvas-wrap">
              <div className="report-canvas" data-orient={printOrientation}>
                {printMeta && <div className="print-only print-letterhead">{printMeta}</div>}

                <div className="print-document">
                  {/* Screen view (single page) */}
                  <div className="report-page-screen">{pages[currentPage]}</div>

                  {/* Print view (all pages stacked with page-breaks) */}
                  <div className="report-pages-print">
                    {pages.map((p, i) => (
                      <div key={i} className="report-print-page">
                        {p}
                      </div>
                    ))}
                  </div>
                </div>

                {printFooter && <div className="print-only print-footer">{printFooter}</div>}
              </div>
            </div>
          </>
        )}
      </div>

      {/* Floating HUD — only in fullscreen mode */}
      {fullscreen && hasPages && (
        <div
          className={`report-fs-hud ${hudVisible ? "is-visible" : ""}`}
          onMouseEnter={() => setHudVisible(true)}
        >
          <button
            className="report-fs-btn"
            disabled={currentPage === 0}
            onClick={() => setCurrentPage((p) => Math.max(0, p - 1))}
            title="Previous (←)"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>

          <span className="report-fs-info">
            {currentPage + 1} / {pages.length}
            {pageLabel && <span className="report-fs-info-label"> · {pageLabel(currentPage)}</span>}
          </span>

          <button
            className="report-fs-btn"
            disabled={currentPage >= pages.length - 1}
            onClick={() => setCurrentPage((p) => Math.min(pages.length - 1, p + 1))}
            title="Next (→)"
          >
            <ChevronRight className="h-4 w-4" />
          </button>

          <span className="report-fs-sep" />

          <button
            className="report-fs-btn"
            onClick={() => {
              if (beforePrint && beforePrint() === false) return;
              const stored = window.localStorage.getItem("erp:printOrient") as
                | "portrait"
                | "landscape"
                | null;
              setPrintOrientation(stored ?? printOrientation);
              setTimeout(() => window.print(), 30);
            }}
            title="Print (Ctrl+P)"
          >
            <span className="text-[11px] tracking-wide font-medium">PRINT</span>
          </button>

          <button
            className="report-fs-btn report-fs-exit"
            onClick={() => setFullscreen(false)}
            title="Exit fullscreen (Esc)"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      )}
    </div>
  );
}

/* ExportMenu and ReportPrintMeta remain unchanged */
function ExportMenu({ exporters }: { exporters: Exporter[] }) {
  const handle = (exp: Exporter) => {
    const out = exp.build();
    const blob = out instanceof Blob ? out : new Blob([out], { type: exp.mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = exp.filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (exporters.length === 1) {
    const only = exporters[0];
    return (
      <Button variant="outline" size="sm" className="h-8" onClick={() => handle(only)}>
        <Download className="h-3.5 w-3.5 mr-1.5" /> Export {only.label}
      </Button>
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-8">
          <Download className="h-3.5 w-3.5 mr-1.5" /> Export
          <ChevronDown className="h-3.5 w-3.5 ml-1" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="text-[12.5px]">
        <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
          Format
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {exporters.map((e) => (
          <DropdownMenuItem key={e.label} onClick={() => handle(e)}>
            {e.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ReportPrintMeta({
  title,
  subtitle,
  rows,
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
            <span key={i}>
              <strong>{r.label}:</strong> {r.value}
            </span>
          ))}
        </div>
      )}
      <div className="report-letterhead-printdate">
        Print Date: {new Date().toLocaleString("en-IN")}
      </div>
    </div>
  );
}