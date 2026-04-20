// apps/web/src/components/LiveSearchTable.tsx
// ════════════════════════════════════════════════════════════════════
// Live Search Wrapper (Marketing v1.4)
//
// Wraps a table/list with a search box that filters rows in real-time
// as the user types. Used on product tables in:
//   • Record Indents Page
//   • Gate Pass (Agents) Page
//   • Cash Customer Page
//   • Stock Entry Page
//
// It does NOT render the table — you do, inside the render-prop.
// That way it works with any table (shadcn <Table>, plain <table>,
// card grid, virtualized list, whatever).
//
// Usage:
//   <LiveSearchTable
//     items={products}
//     getSearchableText={p => `${p.code} ${p.name} ${p.reportAlias}`}
//     placeholder="Search by name or code..."
//   >
//     {(filtered) => (
//       <table>
//         <tbody>
//           {filtered.map(p => <tr key={p.id}>...</tr>)}
//         </tbody>
//       </table>
//     )}
//   </LiveSearchTable>
// ════════════════════════════════════════════════════════════════════

import { useState, useMemo, type ReactNode } from "react";
import { Input } from "@/components/ui/input";
import { Search, X } from "lucide-react";
import { cn } from "@/lib/utils";

export interface LiveSearchTableProps<T> {
  items: T[];
  /** Return a single string that contains every searchable field joined. */
  getSearchableText: (item: T) => string;
  /** Render-prop that receives the filtered array. */
  children: (filtered: T[]) => ReactNode;
  placeholder?: string;
  className?: string;
  /** Render an "X of N" count line below the search. */
  showCount?: boolean;
}

export function LiveSearchTable<T>({
  items,
  getSearchableText,
  children,
  placeholder = "Search...",
  className,
  showCount = true,
}: LiveSearchTableProps<T>) {
  const [search, setSearch] = useState("");

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return items;
    return items.filter(item => getSearchableText(item).toLowerCase().includes(q));
  }, [items, search, getSearchableText]);

  return (
    <div className={cn("space-y-2", className)}>
      <div className="relative">
        <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          placeholder={placeholder}
          value={search}
          onChange={e => setSearch(e.target.value)}
          className="pl-8 pr-8"
        />
        {search && (
          <button
            type="button"
            onClick={() => setSearch("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            aria-label="Clear search"
          >
            <X className="h-4 w-4" />
          </button>
        )}
      </div>
      {showCount && search && (
        <p className="text-xs text-muted-foreground">
          Showing {filtered.length} of {items.length}
        </p>
      )}
      {children(filtered)}
    </div>
  );
}