// apps/web/src/pages/dtc/ui.tsx
// ════════════════════════════════════════════════════════════════════
// Record-page building blocks for DTC Billing.
//
// The module follows the list → record-page pattern of established ERPs
// (SAP Fiori list report + object page, Odoo list + form view, ERPNext
// list + form): every record opens on its own page with a URL. A record's
// parts (summary, earnings, history, …) are separate pages behind tabs, so
// each page does one job. Headers carry at most four figures; labels are
// in sentence case. Dialogs are kept for consequential confirmations only.
// ════════════════════════════════════════════════════════════════════
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Link, NavLink } from "react-router-dom";
import { ArrowLeft, Check } from "lucide-react";
import { cn } from "@/lib/utils";

/** Page header for a record: back link, title, status, actions, key figures. */
export function RecordHeader({
  back, title, code, subtitle, status, actions, facts, tabs, children,
}: {
  back?: { to: string; label: string };
  title: ReactNode;
  code?: string;
  subtitle?: ReactNode;
  status?: ReactNode;
  actions?: ReactNode;
  /** At most four: the numbers someone opens this page for. */
  facts?: { label: string; value: ReactNode; hint?: ReactNode; tone?: "default" | "success" | "warning" | "danger" | "info" }[];
  /** The record's pages, as tabs under the header. */
  tabs?: { to: string; label: string; end?: boolean; count?: number }[];
  children?: ReactNode;
}) {
  const tone = {
    default: "", success: "text-success", warning: "text-warning", danger: "text-destructive", info: "text-info",
  };
  return (
    <div className="bg-panel border-b border-border">
      <div className={cn("px-4 sm:px-6 pt-3", tabs ? "pb-0" : "pb-4")}>
        {back && (
          <Link to={back.to} className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground mb-1.5">
            <ArrowLeft className="h-3.5 w-3.5" /> {back.label}
          </Link>
        )}
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {code && <span className="font-mono text-[12px] rounded bg-muted px-1.5 py-0.5 text-muted-foreground">{code}</span>}
              <h1 className="text-[17px] sm:text-[19px] font-semibold leading-tight truncate">{title}</h1>
              {status}
            </div>
            {subtitle && <div className="text-[12.5px] text-muted-foreground mt-1">{subtitle}</div>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
        </div>
        {facts && facts.length > 0 && (
          <dl className="mt-4 flex flex-wrap gap-x-10 gap-y-3">
            {facts.slice(0, 4).map(f => (
              <div key={f.label} className="min-w-0">
                <dt className="text-[12px] text-muted-foreground">{f.label}</dt>
                <dd className={cn("text-[20px] font-semibold num leading-tight", tone[f.tone ?? "default"])}>{f.value}</dd>
                {f.hint && <dd className="text-[11.5px] text-muted-foreground">{f.hint}</dd>}
              </div>
            ))}
          </dl>
        )}
        {children}
        {tabs && (
          <nav className="mt-4 -mb-px flex gap-1 overflow-x-auto no-print">
            {tabs.map(t => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.end}
                className={({ isActive }) => cn(
                  "h-10 inline-flex items-center px-3 text-[13px] whitespace-nowrap border-b-2 transition-colors",
                  isActive ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
                )}
              >
                {t.label}
                {!!t.count && <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[11px] text-muted-foreground">{t.count}</span>}
              </NavLink>
            ))}
          </nav>
        )}
      </div>
    </div>
  );
}

/** Content column under a record header. */
export function RecordBody({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn("dtc-plain px-4 sm:px-6 py-5 space-y-5", wide ? "max-w-7xl" : "max-w-4xl")}>{children}</div>;
}

/** Odoo-style status pipeline: done steps, the current step, the rest. */
export function StatusPipeline({ steps, current, className }: {
  steps: { key: string; label: string; detail?: ReactNode }[];
  current: string;
  className?: string;
}) {
  const idx = steps.findIndex(s => s.key === current);
  return (
    <ol className={cn("flex flex-wrap gap-y-1", className)}>
      {steps.map((s, i) => {
        const done = i < idx || (i === idx && i === steps.length - 1);
        const active = i === idx && !done;
        return (
          <li
            key={s.key}
            className={cn(
              "relative flex items-center gap-1.5 h-8 pl-5 pr-4 text-[12px] first:pl-3 first:rounded-l last:rounded-r",
              "[clip-path:polygon(0_0,calc(100%-10px)_0,100%_50%,calc(100%-10px)_100%,0_100%,10px_50%)] first:[clip-path:polygon(0_0,calc(100%-10px)_0,100%_50%,calc(100%-10px)_100%,0_100%)] -ml-1.5 first:ml-0",
              done ? "bg-success/15 text-success" : active ? "bg-primary text-primary-foreground font-medium" : "bg-muted text-muted-foreground",
            )}
            title={typeof s.detail === "string" ? s.detail : undefined}
          >
            {done && <Check className="h-3.5 w-3.5" />}
            <span className="whitespace-nowrap">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

/** Fiori-style anchor bar: tabs that scroll to sections and track the one in view. */
export function SectionTabs({ sections }: { sections: { id: string; label: string; count?: number }[] }) {
  const [active, setActive] = useState(sections[0]?.id);
  useEffect(() => {
    const els = sections.map(s => document.getElementById(s.id)).filter(Boolean) as HTMLElement[];
    if (!els.length) return;
    const obs = new IntersectionObserver(entries => {
      const seen = entries.filter(e => e.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
      if (seen[0]) setActive(seen[0].target.id);
    }, { rootMargin: "-120px 0px -60% 0px" });
    els.forEach(e => obs.observe(e));
    return () => obs.disconnect();
  }, [sections.map(s => s.id).join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <nav className="sticky top-0 z-30 bg-panel border-b border-border px-3 sm:px-5 flex gap-1 overflow-x-auto no-print shadow-[0_1px_0_hsl(var(--border))]">
      {sections.map(s => (
        <button
          key={s.id}
          type="button"
          onClick={() => document.getElementById(s.id)?.scrollIntoView({ behavior: "smooth", block: "start" })}
          className={cn(
            "h-9 px-3 text-[12.5px] whitespace-nowrap border-b-2 -mb-px transition-colors",
            active === s.id ? "border-primary text-foreground font-medium" : "border-transparent text-muted-foreground hover:text-foreground",
          )}
        >
          {s.label}
          {s.count != null && <span className="ml-1.5 rounded-full bg-muted px-1.5 text-[10.5px]">{s.count}</span>}
        </button>
      ))}
    </nav>
  );
}

/** A titled block of the record page. */
export function Section({ id, title, description, actions, children, className, flush }: {
  id?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Content runs edge to edge (tables). */
  flush?: boolean;
}) {
  return (
    <section id={id} className={cn("erp-panel scroll-mt-12", className)}>
      <header className="flex flex-wrap items-start gap-2 px-5 pt-4 pb-3">
        <div className="flex-1 min-w-0">
          <h2 className="text-[14.5px] font-semibold">{title}</h2>
          {description && <p className="text-[12.5px] text-muted-foreground mt-0.5">{description}</p>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-1.5">{actions}</div>}
      </header>
      <div className={flush ? "border-t border-border" : "px-5 pb-5"}>{children}</div>
    </section>
  );
}

/** Read-only label / value pairs in a responsive grid. */
export function FieldList({ items, cols = 3 }: {
  items: { label: string; value: ReactNode; wide?: boolean }[];
  cols?: 2 | 3 | 4;
}) {
  const grid = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-2 lg:grid-cols-3", 4: "sm:grid-cols-2 lg:grid-cols-4" }[cols];
  return (
    <dl className={cn("grid grid-cols-1 gap-x-8 gap-y-4", grid)}>
      {items.map(i => (
        <div key={i.label} className={cn("min-w-0", i.wide && "sm:col-span-2 lg:col-span-full")}>
          <dt className="text-[12px] text-muted-foreground">{i.label}</dt>
          <dd className="text-[13.5px] mt-0.5 break-words">{i.value ?? "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Activity trail (Odoo chatter / ERPNext timeline). */
export function Timeline({ items, empty = "No activity yet." }: {
  items: { id: string; who: string | null; when: string; text: ReactNode; tone?: "default" | "success" | "warning" | "danger" }[];
  empty?: string;
}) {
  if (!items.length) return <p className="text-[12px] text-muted-foreground">{empty}</p>;
  const dot = { default: "bg-muted-foreground/40", success: "bg-success", warning: "bg-warning", danger: "bg-destructive" };
  return (
    <ol className="relative border-l border-border ml-2 space-y-3">
      {items.map(i => (
        <li key={i.id} className="pl-4 relative">
          <span className={cn("absolute -left-[5px] top-1.5 h-2.5 w-2.5 rounded-full ring-2 ring-background", dot[i.tone ?? "default"])} />
          <div className="text-[12.5px]">
            <span className="font-medium">{i.who ?? "System"}</span>
            <span className="text-muted-foreground"> · {i.when}</span>
          </div>
          <div className="text-[12.5px] mt-0.5">{i.text}</div>
        </li>
      ))}
    </ol>
  );
}

/** Bottom bar that stays in view while a form on the page has unsaved changes. */
export function SaveBar({ visible, children, note }: { visible: boolean; children: ReactNode; note?: ReactNode }) {
  if (!visible) return null;
  return (
    <div className="sticky bottom-0 z-20 -mx-3 sm:-mx-5 px-3 sm:px-5 py-2.5 bg-panel border-t border-border shadow-[0_-2px_8px_rgba(0,0,0,0.04)] flex items-center gap-2 no-print">
      <div className="flex-1 text-[12px] text-muted-foreground">{note}</div>
      {children}
    </div>
  );
}

/** A small panel that opens in place (instead of a pop-up) for a reason / confirmation. */
export function InlinePanel({ open, title, tone = "default", children }: {
  open: boolean; title: ReactNode; tone?: "default" | "warning" | "danger"; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { if (open) ref.current?.scrollIntoView({ behavior: "smooth", block: "nearest" }); }, [open]);
  if (!open) return null;
  const border = { default: "border-l-primary", warning: "border-l-warning", danger: "border-l-destructive" }[tone];
  return (
    <div ref={ref} className={cn("erp-panel border-l-4 p-3 space-y-2", border)}>
      <div className="text-[13px] font-semibold">{title}</div>
      {children}
    </div>
  );
}

/** Progress bar with a label (deposit collected, …). */
export function Progress({ value, max, tone = "primary" }: { value: number; max: number; tone?: "primary" | "success" }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="h-2 rounded-full bg-muted overflow-hidden" title={`${pct.toFixed(0)}%`}>
      <div className={cn("h-full rounded-full", tone === "success" ? "bg-success" : "bg-primary")} style={{ width: `${pct}%` }} />
    </div>
  );
}

/** A short sentence or two that says what the page is about, in plain words. */
export function Summary({ children }: { children: ReactNode }) {
  return <p className="text-[14px] leading-relaxed">{children}</p>;
}

/** Receipt-style money breakdown: rows, then a total line. */
export function Breakdown({ rows, total }: {
  rows: { label: ReactNode; value: ReactNode; sign?: "+" | "−"; muted?: boolean }[];
  total: { label: ReactNode; value: ReactNode; tone?: "success" | "danger" };
}) {
  return (
    <div className="text-[13.5px]">
      {rows.map((r, i) => (
        <div key={i} className={cn("flex justify-between gap-4 py-1.5", r.muted && "text-muted-foreground")}>
          <span>{r.sign && <span className="inline-block w-4 text-muted-foreground">{r.sign}</span>}{r.label}</span>
          <span className="num">{r.value}</span>
        </div>
      ))}
      <div className={cn("flex justify-between gap-4 pt-2 mt-1 border-t border-border font-semibold text-[15px]",
        total.tone === "success" && "text-success", total.tone === "danger" && "text-destructive")}>
        <span>{total.label}</span><span className="num">{total.value}</span>
      </div>
    </div>
  );
}
