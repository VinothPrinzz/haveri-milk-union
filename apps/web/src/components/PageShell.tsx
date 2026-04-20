// apps/web/src/components/PageShell.tsx
// ════════════════════════════════════════════════════════════════════
// Global Layout Rule (Marketing v1.4)
//
// Every list/report page uses this shell:
//   1. Top area (PageHeader + filters + action buttons) — NEVER scrolls
//   2. Body area (table or card list) — ONLY the body scrolls
//   3. Table thead uses sticky top-0 to stay visible while scrolling
//
// Usage:
//   <PageShell
//     header={
//       <>
//         <PageHeader title="Customers" description="..." />
//         <FilterBar>...</FilterBar>
//       </>
//     }
//   >
//     <ScrollableTableBody>
//       <table className="w-full">
//         <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur">...</thead>
//         <tbody>...</tbody>
//       </table>
//     </ScrollableTableBody>
//   </PageShell>
//
// If your app layout differs, tweak `headerOffset` (the space consumed
// by the top navigation bar). Default is 4rem (64px).
// ════════════════════════════════════════════════════════════════════

import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface PageShellProps {
  /** Fixed top section: PageHeader, filter cards, action buttons. */
  header: ReactNode;
  /** Body — the scrollable area. Typically wrap with <ScrollableTableBody>. */
  children: ReactNode;
  /** Optional wrapper className */
  className?: string;
  /** Space consumed by the app's top nav. Default "4rem". Adjust if yours is taller. */
  headerOffset?: string;
}

export function PageShell({ header, children, className, headerOffset = "4rem" }: PageShellProps) {
  return (
    <div
      className={cn("flex flex-col min-h-0", className)}
      style={{ height: `calc(100vh - ${headerOffset})` }}
    >
      <div className="flex-shrink-0 pb-4 space-y-4">{header}</div>
      <div className="flex-1 min-h-0 overflow-hidden">{children}</div>
    </div>
  );
}

/**
 * The body wrapper — scrolls vertically. Put this inside PageShell.children.
 * Adds border + bg-card styling so tables look like they live in a panel.
 */
export function ScrollableTableBody({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("h-full overflow-y-auto rounded-lg border bg-card", className)}>
      {children}
    </div>
  );
}

/**
 * Convenience: a filter bar card that sits in the PageShell header slot.
 * Renders its children inline-flex so filters + action buttons lay out
 * horizontally and wrap on narrow screens.
 */
export function FilterBar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-lg border bg-card p-5 flex flex-wrap items-end gap-4", className)}>
      {children}
    </div>
  );
}