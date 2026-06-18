// apps/web/src/pages/fgs/StockEntryBase.tsx
// ════════════════════════════════════════════════════════════════════
// Shared stock-entry table used by both bucketed pages
// (StockEntryMilkCurdPage and StockEntryOthersPage).
//
// Takes a `bucket` prop. Fetches that bucket's rows from the API and
// renders the editable opening/received/dispatched/wastage/closing
// table. Each page is its own route so it can be gated by role
// independently.
// ════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar,
  EmptyState,
  Kbd,
  fmtNum,
} from "@/components/PageHeader";
import { LiveSearchTable } from "@/components/LiveSearchTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Save } from "lucide-react";
import { fetchStockEntries, updateStockEntries } from "@/services/api";
import {
  type StockBucket,
  BUCKET_LABELS,
  BUCKET_SUBTITLES,
  filterByBucket,
} from "@/lib/stock-buckets";

interface Props {
  bucket: StockBucket;
}

export default function StockEntryBase({ bucket }: Props) {
  const qc = useQueryClient();
  const [filterDate, setFilterDate] = useState(new Date().toISOString().split("T")[0]);
  const [edits, setEdits] = useState<Record<string, Record<string, number>>>({});

  // The query key includes the bucket so each page has its own cache
  // slot — switching between pages doesn't show stale data from the
  // other bucket, and React Query refetches per page independently.
  const { data: stockEntries = [], isLoading } = useQuery({
    queryKey: ["stock-entries", bucket, filterDate],
    queryFn: () => fetchStockEntries(filterDate, bucket),
  });

  // Defence in depth: even if the backend hasn't been deployed with
  // the bucket query param yet, the client-side filter still keeps
  // the page showing only its bucket. Once backend is rolled out this
  // is a near-no-op since the server already filtered.
  const visibleEntries = filterByBucket(stockEntries as any[], bucket);

  const setEdit = (productId: string, field: string, value: number) => {
    setEdits(prev => ({
      ...prev,
      [productId]: { ...prev[productId], [field]: value },
    }));
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      // Opening is NOT editable — it's the previous day's closing (auto-filled
      // by the server). Persist that displayed value, never the edits map.
      const openingById = new Map(
        (visibleEntries as any[]).map(s => [s.productId, Number(s.opening ?? 0)]),
      );
      const entriesToSave = Object.entries(edits).map(([productId, e]) => ({
        productId,
        opening:    openingById.get(productId) ?? 0,
        received:   Number(e.received   ?? 0),
        dispatched: Number(e.dispatched ?? 0),
        wastage:    Number(e.wastage    ?? 0),
      }));
      return updateStockEntries(filterDate, entriesToSave);
    },
    onSuccess: () => {
      toast.success("Stock entries saved");
      // Invalidate ALL stock-entries queries so the other bucket page
      // (and Stock Overview / Reports) also pick up any cross-effect.
      qc.invalidateQueries({ queryKey: ["stock-entries"] });
      setEdits({});
    },
    onError: (err: any) => toast.error(err?.message || "Failed to save stock entries"),
  });

  const editsCount = Object.keys(edits).length;

  const computeClosing = (s: any) => {
    const e = edits[s.productId] ?? {};
    // Opening is read-only (previous day's closing) — always use the row value.
    const opening    = s.opening    ?? 0;
    const received   = e.received   ?? s.received   ?? 0;
    const dispatched = e.dispatched ?? s.dispatched ?? 0;
    const wastage    = e.wastage    ?? s.wastage    ?? 0;
    return Number(opening) + Number(received) - Number(dispatched) - Number(wastage);
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={`Stock Entry — ${BUCKET_LABELS[bucket]}`}
        subtitle={BUCKET_SUBTITLES[bucket]}
        actions={
          <Button
            size="sm"
            className="h-8"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || editsCount === 0}
          >
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {saveMutation.isPending
              ? "Saving…"
              : editsCount > 0
              ? `Save ${editsCount} change${editsCount > 1 ? "s" : ""}`
              : "Save"}
            <Kbd className="ml-2">Ctrl+S</Kbd>
          </Button>
        }
      />

      <FilterBar>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Date</label>
          <Input
            type="date"
            value={filterDate}
            onChange={e => setFilterDate(e.target.value)}
            className="erp-input w-44"
          />
        </div>
        {editsCount > 0 && (
          <div className="ml-auto self-end pb-1 text-[12px]">
            <span className="text-warning font-medium">
              {editsCount} unsaved change{editsCount > 1 ? "s" : ""}
            </span>
          </div>
        )}
      </FilterBar>

      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="erp-panel p-4 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="erp-panel p-8">
            <EmptyState title={`No ${BUCKET_LABELS[bucket].toLowerCase()} products`} />
          </div>
        ) : (
          <div className="erp-panel overflow-hidden">
            <LiveSearchTable
              items={visibleEntries}
              getSearchableText={(s: any) => `${s.productName} ${s.category ?? ""}`}
              placeholder="Type to filter products…"
            >
              {filtered => (
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Category</th>
                      <th className="num" style={{ textAlign: "right", width: 110 }}>Opening</th>
                      <th className="num" style={{ textAlign: "right", width: 110 }}>Received</th>
                      <th className="num" style={{ textAlign: "right", width: 110 }}>Dispatched</th>
                      <th className="num" style={{ textAlign: "right", width: 110 }}>Wastage</th>
                      <th className="num" style={{ textAlign: "right", width: 100 }}>Closing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={7}><EmptyState title="No products match your search" /></td></tr>
                    )}
                    {filtered.map((s: any) => {
                      const closing = computeClosing(s);
                      return (
                        <tr key={s.productId}>
                          <td className="font-medium">{s.productName}</td>
                          <td className="text-muted-foreground uppercase">{s.category ?? "—"}</td>
                          <td
                            className="num text-muted-foreground"
                            style={{ textAlign: "right" }}
                            title="Auto-filled from the previous day's closing"
                          >
                            {fmtNum(s.opening ?? 0)}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <StockInput
                              value={edits[s.productId]?.received ?? s.received ?? 0}
                              onChange={v => setEdit(s.productId, "received", v)}
                            />
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <StockInput
                              value={edits[s.productId]?.dispatched ?? s.dispatched ?? 0}
                              onChange={v => setEdit(s.productId, "dispatched", v)}
                            />
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <StockInput
                              value={edits[s.productId]?.wastage ?? s.wastage ?? 0}
                              onChange={v => setEdit(s.productId, "wastage", v)}
                            />
                          </td>
                          <td className="num font-semibold" style={{ textAlign: "right" }}>
                            {closing < 0
                              ? <span className="text-destructive">{fmtNum(closing)}</span>
                              : fmtNum(closing)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </LiveSearchTable>
          </div>
        )}
      </div>
    </div>
  );
}

function StockInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Input
      type="number"
      min="0"
      value={value || ""}
      onChange={e => onChange(parseInt(e.target.value) || 0)}
      className="erp-input h-8 w-24 text-right inline-block num"
    />
  );
}