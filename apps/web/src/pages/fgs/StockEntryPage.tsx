// apps/web/src/pages/fgs/StockEntryPage.tsx
// ════════════════════════════════════════════════════════════════════
// Stock Entry — Marketing v1.4
//
// Changes vs v1.3:
//   • PageShell layout (fixed header, scrollable body)
//   • Product table wrapped in LiveSearchTable (type to filter)
//   • Edits persist across searches (they're keyed by productId)
// ════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { LiveSearchTable } from "@/components/LiveSearchTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Save } from "lucide-react";
import { fetchStockEntries, updateStockEntries } from "@/services/api";

export default function StockEntryPage() {
  const qc = useQueryClient();

  const [filterDate, setFilterDate] = useState(new Date().toISOString().split("T")[0]);
  const [edits, setEdits] = useState<Record<string, Record<string, number>>>({});

  const { data: stockEntries = [], isLoading } = useQuery({
    queryKey: ["stock-entries", filterDate],
    queryFn: () => fetchStockEntries(filterDate),
  });

  const setEdit = (productId: string, field: string, value: number) => {
    setEdits(prev => ({
      ...prev,
      [productId]: { ...prev[productId], [field]: value },
    }));
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const entriesToSave = Object.entries(edits).map(([productId, e]) => ({
        productId,
        opening: Number(e.opening ?? 0),
        received: Number(e.received ?? 0),
        dispatched: Number(e.dispatched ?? 0),
        wastage: Number(e.wastage ?? 0),
      }));
      return updateStockEntries(filterDate, entriesToSave);
    },
    onSuccess: () => {
      toast.success("Stock entries saved");
      qc.invalidateQueries({ queryKey: ["stock-entries"] });
      setEdits({});
    },
    onError: (err: any) => {
      toast.error(err?.message || "Failed to save stock entries");
    },
  });

  const handleSave = () => {
    if (Object.keys(edits).length === 0) return;
    saveMutation.mutate();
  };

  const editsCount = Object.keys(edits).length;

  // Compute live-edited closing for display
  const computeClosing = (s: any) => {
    const e = edits[s.productId] ?? {};
    const opening = e.opening ?? s.opening ?? 0;
    const received = e.received ?? s.received ?? 0;
    const dispatched = e.dispatched ?? s.dispatched ?? 0;
    const wastage = e.wastage ?? s.wastage ?? 0;
    return opening + received - dispatched - wastage;
  };

  return (
    <PageShell
      header={
        <>
          <PageHeader
            title="Stock Entry"
            description="Record stock received, dispatched, or adjusted"
          >
            <Button
              onClick={handleSave}
              disabled={saveMutation.isPending || editsCount === 0}
            >
              <Save className="h-4 w-4 mr-1" />
              {saveMutation.isPending
                ? "Saving..."
                : editsCount > 0
                  ? `Save ${editsCount} change${editsCount > 1 ? "s" : ""}`
                  : "Save"}
            </Button>
          </PageHeader>
          <FilterBar>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Date</label>
              <Input
                type="date"
                value={filterDate}
                onChange={e => setFilterDate(e.target.value)}
                className="w-44"
              />
            </div>
            {editsCount > 0 && (
              <div className="text-xs text-muted-foreground pb-2">
                <span className="text-warning font-medium">
                  {editsCount} unsaved change{editsCount > 1 ? "s" : ""}
                </span>
              </div>
            )}
          </FilterBar>
        </>
      }
    >
      {isLoading ? (
        <ScrollableTableBody>
          <div className="p-6 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </ScrollableTableBody>
      ) : (
        <ScrollableTableBody className="p-4">
          <LiveSearchTable
            items={stockEntries as any[]}
            getSearchableText={s => `${s.productName} ${s.category ?? ""}`}
            placeholder="Search products by name or category..."
          >
            {filtered => (
              <table className="w-full text-sm">
                <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
                  <tr className="text-xs text-muted-foreground">
                    <th className="text-left py-2.5 px-3 font-medium">Product</th>
                    <th className="text-left py-2.5 px-3 font-medium">Category</th>
                    <th className="text-right py-2.5 px-3 font-medium">Opening</th>
                    <th className="text-right py-2.5 px-3 font-medium">Received</th>
                    <th className="text-right py-2.5 px-3 font-medium">Dispatched</th>
                    <th className="text-right py-2.5 px-3 font-medium">Wastage</th>
                    <th className="text-right py-2.5 px-3 font-medium">Closing</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((s: any) => {
                    const closing = computeClosing(s);
                    const isEdited = !!edits[s.productId];
                    return (
                      <tr
                        key={s.productId}
                        className={`border-b hover:bg-muted/20 ${
                          isEdited ? "bg-warning/5" : ""
                        }`}
                      >
                        <td className="py-1.5 px-3 font-medium">{s.productName}</td>
                        <td className="py-1.5 px-3 text-xs">{s.category ?? "—"}</td>
                        <td className="py-1.5 px-3 text-right">
                          <StockInput
                            value={edits[s.productId]?.opening ?? s.opening ?? 0}
                            onChange={v => setEdit(s.productId, "opening", v)}
                          />
                        </td>
                        <td className="py-1.5 px-3 text-right">
                          <StockInput
                            value={edits[s.productId]?.received ?? s.received ?? 0}
                            onChange={v => setEdit(s.productId, "received", v)}
                          />
                        </td>
                        <td className="py-1.5 px-3 text-right">
                          <StockInput
                            value={edits[s.productId]?.dispatched ?? s.dispatched ?? 0}
                            onChange={v => setEdit(s.productId, "dispatched", v)}
                          />
                        </td>
                        <td className="py-1.5 px-3 text-right">
                          <StockInput
                            value={edits[s.productId]?.wastage ?? s.wastage ?? 0}
                            onChange={v => setEdit(s.productId, "wastage", v)}
                          />
                        </td>
                        <td className="py-1.5 px-3 text-right font-mono font-semibold">
                          {closing < 0 ? (
                            <span className="text-destructive">{closing}</span>
                          ) : (
                            closing
                          )}
                        </td>
                      </tr>
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td
                        colSpan={7}
                        className="py-10 text-center text-muted-foreground text-sm"
                      >
                        No products match your search.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            )}
          </LiveSearchTable>
        </ScrollableTableBody>
      )}
    </PageShell>
  );
}

function StockInput({
  value,
  onChange,
}: {
  value: number;
  onChange: (v: number) => void;
}) {
  return (
    <Input
      type="number"
      min="0"
      value={value || ""}
      onChange={e => onChange(parseInt(e.target.value) || 0)}
      className="h-8 w-20 text-right font-mono inline-block"
    />
  );
}