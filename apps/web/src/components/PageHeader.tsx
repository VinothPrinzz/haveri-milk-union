import React, { ReactNode } from "react";
import { cn } from "@/lib/utils";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu";
import { ChevronDown, Printer } from "lucide-react";

/* ──────────────────────────────────────────────────────────────────
   PageHeader (erp-page-header)
   ────────────────────────────────────────────────────────────────── */
interface PageHeaderProps {
  title: string;
  description?: string; // legacy alias for `subtitle`
  subtitle?: string;
  children?: ReactNode; // legacy alias for `actions`
  actions?: ReactNode;
  className?: string;
}

export default function PageHeader({
  title,
  description,
  subtitle,
  children,
  actions,
  className,
}: PageHeaderProps) {
  const sub = subtitle ?? description;
  const acts = actions ?? children;
  return (
    <div
      className={cn(
        "erp-page-header flex items-center justify-between px-3 py-2 sm:px-4 sm:py-3 border-b border-border bg-panel",
        className
      )}
    >
      <div className="min-w-0">
        <h1 className="text-[14px] sm:text-[16px] font-semibold text-foreground leading-tight truncate">{title}</h1>
        {sub && <div className="text-[11.5px] sm:text-[13px] text-muted-foreground mt-0.5 truncate">{sub}</div>}
      </div>
      {acts && <div className="erp-page-actions flex items-center gap-1.5 sm:gap-2 shrink-0">{acts}</div>}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   Print Orientation Helper + PrintButton
   ────────────────────────────────────────────────────────────────── */

/**
 * Mounts (or replaces) a <style id="erp-print-orient"> tag with the
 * given orientation, then triggers window.print().
 */
export function setPrintOrientation(orient: "portrait" | "landscape" | null) {
  const id = "erp-print-orient";
  document.getElementById(id)?.remove();
  if (!orient) return;

  const style = document.createElement("style");
  style.id = id;
  style.textContent = `@media print { @page { size: A4 ${orient}; margin: 14mm 12mm 16mm 12mm; } }`;
  document.head.appendChild(style);
}

/**
 * Drop-in replacement for bare Print buttons.
 * Clicking the main area prints in the last-used orientation.
 * Chevron opens menu to choose Portrait / Landscape / Default.
 */
export function PrintButton({
  className = "",
  label = "Print",
  defaultOrient = "portrait" as const,
  beforePrint,
}: {
  className?: string;
  label?: string;
  defaultOrient?: "portrait" | "landscape";
  /** Optional pre-print hook — return false to abort */
  beforePrint?: () => boolean | void;
}) {
  const stored =
    typeof window !== "undefined"
      ? (window.localStorage.getItem("erp:printOrient") as "portrait" | "landscape" | null)
      : null;

  const orient = stored ?? defaultOrient;

  const doPrint = (o: "portrait" | "landscape") => {
    if (beforePrint && beforePrint() === false) return;
    setPrintOrientation(o);
    try {
      window.localStorage.setItem("erp:printOrient", o);
    } catch {}
    setTimeout(() => window.print(), 30);
  };

  return (
    <div className={`inline-flex items-stretch ${className}`}>
      <button
        type="button"
        onClick={() => doPrint(orient)}
        className="h-8 px-3 inline-flex items-center gap-1.5 text-[12.5px] border border-border bg-background hover:bg-accent rounded-l-sm rounded-r-none border-r-0"
        title={`Print (${orient})`}
      >
        <Printer className="h-3.5 w-3.5" />
        {label}
        <span className="text-[10px] uppercase tracking-wide text-muted-foreground ml-1">
          {orient === "portrait" ? "P" : "L"}
        </span>
      </button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            aria-label="Choose orientation"
            className="h-8 px-1.5 inline-flex items-center border border-border bg-background hover:bg-accent rounded-r-sm rounded-l-none"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="text-[12.5px]">
          <DropdownMenuLabel className="text-[10.5px] uppercase tracking-wide text-muted-foreground">
            Page orientation
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => doPrint("portrait")}>
            <span className="mr-2">▯</span> Portrait
            {orient === "portrait" && <span className="ml-auto text-[11px] text-primary">●</span>}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => doPrint("landscape")}>
            <span className="mr-2">▭</span> Landscape
            {orient === "landscape" && <span className="ml-auto text-[11px] text-primary">●</span>}
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onClick={() => {
              setPrintOrientation(null);
              window.print();
            }}
          >
            Use browser default
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   FilterBar / FormSection / Field / FormFooter / StatCard / StatusPill / EmptyState / fmt helpers
   (unchanged — kept for completeness)
   ────────────────────────────────────────────────────────────────── */

export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "erp-filterbar flex flex-wrap items-end gap-2 px-3 py-2 sm:px-4 sm:py-2.5 bg-panel border-b border-border",
        className
      )}
    >
      {children}
    </div>
  );
}

export function FormSection({
  title,
  children,
  cols = 2,
  className,
}: {
  title: string;
  children: ReactNode;
  cols?: 1 | 2 | 3 | 4;
  className?: string;
}) {
  const grid =
    cols === 1
      ? "grid-cols-1"
      : cols === 2
      ? "grid-cols-1 md:grid-cols-2"
      : cols === 3
      ? "grid-cols-1 md:grid-cols-3"
      : "grid-cols-1 md:grid-cols-2 lg:grid-cols-4";

  return (
    <div className={cn("erp-panel p-4 mb-3", className)}>
      <div className="erp-section-title">{title}</div>
      <div className={cn("grid gap-3", grid)}>{children}</div>
    </div>
  );
}

export function Field({
  label,
  hint,
  required,
  children,
  error,
  className,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  error?: string;
  className?: string;
}) {
  return (
    <label className={cn("block", className)}>
      <div className="text-[11.5px] font-medium text-muted-foreground mb-1 flex items-center gap-1.5 uppercase tracking-wide">
        <span>{label}</span>
        {required && <span className="text-destructive">*</span>}
        {hint && <span className="kbd">{hint}</span>}
      </div>
      {children}
      {error && <div className="text-[11.5px] text-destructive mt-1">{error}</div>}
    </label>
  );
}

export function FormFooter({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "sticky bottom-0 z-10 -mx-4 px-4 py-2.5 bg-panel border-t border-border flex items-center justify-end gap-2 no-print",
        className
      )}
    >
      {children}
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  tone = "default",
  icon,
  className,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: "default" | "success" | "warning" | "danger" | "info";
  icon?: ReactNode;
  className?: string;
}) {
  const toneClass = {
    default: "border-l-primary",
    success: "border-l-success",
    warning: "border-l-warning",
    danger: "border-l-destructive",
    info: "border-l-info",
  }[tone];

  return (
    <div className={cn("erp-panel p-2.5 sm:p-3 border-l-4", toneClass, className)}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-[10px] sm:text-[11px] uppercase tracking-wider text-muted-foreground font-medium truncate">
            {label}
          </div>
          <div className="text-[16px] sm:text-[20px] font-semibold mt-0.5 sm:mt-1 num truncate">{value}</div>
          {hint && <div className="text-[10px] sm:text-[11px] text-muted-foreground mt-0.5 truncate">{hint}</div>}
        </div>
        {icon && <div className="text-muted-foreground/60 shrink-0">{icon}</div>}
      </div>
    </div>
  );
}

export function StatusPill({ status, className }: { status?: string | null; className?: string }) {
  const s = (status ?? "draft").toString().toLowerCase();
  const cls =
    s === "pending"
      ? "status-pending"
      : s === "confirmed" || s === "paid" || s === "approved" || s === "pass" || s === "active" || s === "delivered"
      ? "status-confirmed"
      : s === "dispatched"
      ? "status-dispatched"
      : s === "cancelled" || s === "rejected" || s === "fail" || s === "unpaid" || s === "out_of_stock"
      ? "status-cancelled"
      : s === "low" || s === "critical"
      ? "status-pending"
      : "status-draft";

  return <span className={cn("status-pill", cls, className)}>{s.replace(/_/g, " ")}</span>;
}

export function EmptyState({ title, hint, className }: { title: string; hint?: string; className?: string }) {
  return (
    <div className={cn("text-center py-16 text-muted-foreground", className)}>
      <div className="text-[14px] font-medium">{title}</div>
      {hint && <div className="text-[12px] mt-1">{hint}</div>}
    </div>
  );
}

export function fmtINR(n: number | string | null | undefined, withDecimals = true) {
  const num = typeof n === "string" ? parseFloat(n) : (n ?? 0);
  if (isNaN(num)) return "₹0";
  return num.toLocaleString("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: withDecimals ? 2 : 0,
    maximumFractionDigits: withDecimals ? 2 : 0,
  });
}

export function fmtNum(n: number | string | null | undefined, decimals = 0) {
  const num = typeof n === "string" ? parseFloat(n) : (n ?? 0);
  if (isNaN(num)) return "0";
  return num.toLocaleString("en-IN", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function fmtDate(d: string | Date | null | undefined) {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  if (isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("en-IN", { day: "2-digit", month: "short", year: "numeric" });
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cn("kbd", className)}>{children}</span>;
}