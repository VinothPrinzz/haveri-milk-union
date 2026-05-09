import React, { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * PageShell — kept for backward compatibility with existing call-sites.
 * In the ERP refactor most pages no longer need this wrapper; the
 * scrolling behavior moved into <main> in AppLayout. We pass through
 * children with minimal styling so nothing breaks during incremental
 * migration.
 */
export interface PageShellProps {
  header: ReactNode;
  children: ReactNode;
  className?: string;
  headerOffset?: string;
}

export function PageShell({ header, children, className }: PageShellProps) {
  return (
    <div className={cn("flex flex-col h-full min-h-0", className)}>
      <div className="shrink-0">{header}</div>
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/** Body wrapper (compat). Now uses .erp-panel chrome. */
export function ScrollableTableBody({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("h-full overflow-y-auto erp-panel", className)}>
      {children}
    </div>
  );
}

/**
 * FilterBar variant exported here for compat (PageHeader.tsx also exports one).
 * Both render the same `.erp-filterbar` styling.
 */
export function FilterBar({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn(
      "erp-filterbar flex flex-wrap items-end gap-2 px-4 py-2.5 bg-panel border-b border-border",
      className
    )}>
      {children}
    </div>
  );
}