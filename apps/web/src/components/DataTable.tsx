import React, { ReactNode, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { Search, ChevronLeft, ChevronRight } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T, idx: number) => ReactNode;
  width?: string;
  align?: "left" | "right" | "center";
  className?: string;
  sortable?: boolean;
}

interface DataTableProps<T extends { id?: string | number }> {
  columns: Column<T>[];
  rows: T[];
  empty?: string;
  footer?: ReactNode;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string | undefined;
  isLoading?: boolean;
  /** Set max-height on the scroll container. Default `calc(100vh - 260px)`. */
  maxHeight?: string;
}

/**
 * ERP DataTable — sticky thead, dense rows, tabular nums on right-aligned columns,
 * zebra striping, hover row tint, optional footer (totals/pagination).
 */
export function DataTable<T extends { id?: string | number }>({
  columns, rows, empty = "No records found.", footer, onRowClick, rowClassName,
  isLoading, maxHeight,
}: DataTableProps<T>) {
  return (
    <div className="erp-panel overflow-hidden">
      <div className="overflow-auto" style={{ maxHeight: maxHeight ?? "calc(100vh - 260px)" }}>
        <table className="erp-table">
          <thead>
            <tr>
              {columns.map(c => (
                <th
                  key={c.key}
                  style={{ width: c.width, textAlign: c.align ?? "left" }}
                  className={cn(c.className, c.align === "right" && "num")}
                >
                  {c.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {isLoading && (
              <>
                {Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`skel-${i}`} className={i % 2 === 1 ? "zebra" : ""}>
                    {columns.map(c => (
                      <td key={c.key}>
                        <div className="h-3.5 bg-muted/70 rounded-sm animate-pulse" />
                      </td>
                    ))}
                  </tr>
                ))}
              </>
            )}
            {!isLoading && rows.length === 0 && (
              <tr>
                <td colSpan={columns.length} className="text-center py-8 text-muted-foreground">
                  {empty}
                </td>
              </tr>
            )}
            {!isLoading && rows.map((r, i) => (
              <tr
                key={(r.id as React.Key) ?? i}
                className={cn(
                  i % 2 === 1 && "zebra",
                  onRowClick && "cursor-pointer",
                  rowClassName?.(r)
                )}
                onClick={() => onRowClick?.(r)}
              >
                {columns.map(c => (
                  <td
                    key={c.key}
                    style={{ textAlign: c.align ?? "left" }}
                    className={cn(c.className, c.align === "right" && "num")}
                  >
                    {c.cell(r, i)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {footer && (
        <div className="px-3 py-2 border-t border-border bg-muted/30 text-[12px]">{footer}</div>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────────────
   LegacyDataTable — TanStack-table-shaped for any old call-sites
   that still import { DataTable } and pass a TanStack ColumnDef[].
   New code should use the `DataTable` above with `Column<T>`.
   ────────────────────────────────────────────────────────────────── */
import {
  useReactTable, getCoreRowModel, getFilteredRowModel,
  getPaginationRowModel, flexRender, type ColumnDef,
} from "@tanstack/react-table";

export function LegacyDataTable<TData>({
  columns, data, searchPlaceholder = "Search...", pageSize = 20,
}: { columns: ColumnDef<TData>[]; data: TData[]; searchPlaceholder?: string; pageSize?: number }) {
  const [globalFilter, setGlobalFilter] = useState("");
  const table = useReactTable({
    data, columns,
    getCoreRowModel: getCoreRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    getPaginationRowModel: getPaginationRowModel(),
    onGlobalFilterChange: setGlobalFilter,
    globalFilterFn: "includesString",
    state: { globalFilter },
    initialState: { pagination: { pageSize } },
  });

  return (
    <div>
      <div className="flex items-center justify-between mb-2">
        <div className="relative w-72">
          <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <Input
            placeholder={searchPlaceholder}
            value={globalFilter}
            onChange={e => setGlobalFilter(e.target.value)}
            className="erp-input pl-8"
          />
        </div>
        <span className="text-[12px] text-muted-foreground num">
          {table.getFilteredRowModel().rows.length} record(s)
        </span>
      </div>
      <div className="erp-panel overflow-hidden">
        <div className="overflow-auto max-h-[calc(100vh-280px)]">
          <table className="erp-table">
            <thead>
              {table.getHeaderGroups().map(hg => (
                <tr key={hg.id}>
                  {hg.headers.map(h => (
                    <th key={h.id}>
                      {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                    </th>
                  ))}
                </tr>
              ))}
            </thead>
            <tbody>
              {table.getRowModel().rows.length ? (
                table.getRowModel().rows.map((row, i) => (
                  <tr key={row.id} className={i % 2 === 1 ? "zebra" : ""}>
                    {row.getVisibleCells().map(cell => (
                      <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                    ))}
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={columns.length} className="h-24 text-center text-muted-foreground">No results.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
      <div className="flex items-center justify-between mt-2 text-[12px] text-muted-foreground">
        <span className="num">Page {table.getState().pagination.pageIndex + 1} of {Math.max(table.getPageCount(), 1)}</span>
        <div className="flex gap-1">
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => table.previousPage()} disabled={!table.getCanPreviousPage()}>
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
          <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => table.nextPage()} disabled={!table.getCanNextPage()}>
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>
    </div>
  );
}