// ════════════════════════════════════════════════════════════════════
// Dispatch Sheet — loading checklist by route, scoped to one stock bucket.
//
// Shared table used by both bucketed pages (DispatchSheetMilkCurdPage and
// DispatchSheetOthersPage). The plant runs two physical SK diaries — Milk &
// Curd vs. everything else — so each diary's operator loads only their own
// products. Takes a `bucket` prop; the API is asked for that bucket and each
// page is its own route so it can be gated by role independently (mirrors
// StockEntryBase.tsx).
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, EmptyState, StatusPill, StatCard, fmtINR, fmtDate, fmtNum,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Skeleton } from "@/components/ui/skeleton";
import { F9SearchSelect } from "@/components/F9SearchSelect";
import { Printer, Send, Package, Truck, Layers } from "lucide-react";
import {
  fetchDispatchSheet,
  markRouteDispatched,
  fetchRoutes,
  fetchBatches,
  type DispatchSheetRoute,
} from "@/services/api";
import { type StockBucket, BUCKET_LABELS, filterByBucket } from "@/lib/stock-buckets";

// Crates ± loose packets, mirroring the Route Sheet formula
// (apps/api/src/routes/reports.ts): round to the NEAREST full crate, then the
// signed remainder becomes Pkt (+) (extra packets over the rounded crates) or
// Pkt (−) (packets short of the rounded-up crates). With round (not floor) the
// remainder can be negative, which is what makes Pkt (−) possible.
function cratePkts(totalPackets: number, packetsPerCrate: number) {
  if (!packetsPerCrate || packetsPerCrate <= 0) {
    return { crates: 0, pktPlus: totalPackets, pktMinus: 0 };
  }
  const crates = Math.round(totalPackets / packetsPerCrate);
  const diff = totalPackets - crates * packetsPerCrate;
  return {
    crates,
    pktPlus: diff > 0 ? diff : 0,
    pktMinus: diff < 0 ? -diff : 0,
  };
}

interface Props {
  bucket: StockBucket;
}

export default function DispatchSheetBase({ bucket }: Props) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});

  // Reset verification when filters change
  useEffect(() => {
    setVerified({});
  }, [selectedDate, selectedRoute, selectedBatch]);

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  // Bucket is part of the query key so each page caches independently and the
  // server returns only that diary's products.
  const { data, isLoading } = useQuery({
    queryKey: ["dispatch-sheet", bucket, selectedDate, selectedRoute, selectedBatch],
    queryFn: () => fetchDispatchSheet({
      date: selectedDate,
      routeId: selectedRoute ?? undefined,
      batchId: selectedBatch ?? undefined,
      bucket,
    }),
  });

  const routeOptions = (routes as any[]).map((r: any) => ({
    value: r.id, label: r.name, sublabel: r.code,
  }));

  const batchOptions = (batches as any[]).map((b: any) => ({
    value: b.id, label: b.name,
  }));

  const markDispatched = useMutation({
    mutationFn: (routeId: string) => markRouteDispatched({ date: selectedDate, routeId }),
    onSuccess: () => {
      toast.success("Route marked as dispatched");
      qc.invalidateQueries({ queryKey: ["dispatch-sheet"] });
    },
    onError: (err: any) => toast.error(err?.message || "Failed to mark dispatched"),
  });

  // Defence in depth: even if the API hasn't been deployed with the bucket
  // param yet, keep only this bucket's product rows (and drop routes that end
  // up empty), then recompute per-route packet/crate totals from what's left.
  // Once the backend filter is live this is a near-no-op. Header dealer/amount
  // figures come from the (already bucket-scoped) server response.
  const sheetRoutes: DispatchSheetRoute[] = useMemo(() => {
    return (data?.routes ?? [])
      .map(r => {
        const items = filterByBucket(r.items, bucket);
        const packets = items.reduce((s, it) => s + (it.totalPackets ?? 0), 0);
        const crates  = items.reduce(
          (s, it) => s + cratePkts(it.totalPackets ?? 0, it.packetsPerCrate ?? 0).crates, 0,
        );
        return { ...r, items, totals: { packets, crates } };
      })
      .filter(r => r.items.length > 0);
  }, [data, bucket]);

  // Crates per route, summed from the same round-based formula as the rows,
  // so the header badge / summary stay consistent with the per-product cells.
  const routeCrates = (r: DispatchSheetRoute) => r.totals.crates;
  const totalCrates = sheetRoutes.reduce((s, r) => s + routeCrates(r), 0);

  // Summary recomputed from the filtered routes so the StatCards always match
  // the visible table, regardless of whether the backend did the filtering.
  const summary = data ? {
    totalRoutes:  sheetRoutes.length,
    totalItems:   sheetRoutes.reduce((s, r) => s + r.items.length, 0),
    totalPackets: sheetRoutes.reduce((s, r) => s + r.totals.packets, 0),
  } : null;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={`Dispatch Sheet — ${BUCKET_LABELS[bucket]}`}
        subtitle={data
          ? `${fmtDate(data.date)} — ${BUCKET_LABELS[bucket]} loading checklist by route`
          : `${BUCKET_LABELS[bucket]} daily loading checklist`}
        actions={
          <Button size="sm" variant="outline" className="h-8" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5 mr-1.5" /> Print
          </Button>
        }
      />

      <FilterBar>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Date</label>
          <Input type="date" value={selectedDate} onChange={e => setSelectedDate(e.target.value)} className="erp-input w-40" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Route</label>
          <F9SearchSelect value={selectedRoute} onChange={setSelectedRoute} options={routeOptions} placeholder="All routes" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Batch</label>
          <F9SearchSelect value={selectedBatch} onChange={setSelectedBatch} options={batchOptions} placeholder="All batches" />
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {summary && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Routes" value={fmtNum(summary.totalRoutes)} icon={<Truck className="h-5 w-5" />} tone="default" />
            <StatCard label="Items" value={fmtNum(summary.totalItems)} icon={<Package className="h-5 w-5" />} />
            <StatCard label="Packets" value={fmtNum(summary.totalPackets)} icon={<Layers className="h-5 w-5" />} />
            <StatCard label="Crates" value={fmtNum(totalCrates)} icon={<Package className="h-5 w-5" />} tone="success" />
          </div>
        )}

        {isLoading ? (
          <div className="erp-panel p-4 space-y-2">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-10 w-full" />)}
          </div>
        ) : sheetRoutes.length === 0 ? (
          <EmptyState title="No dispatch data for this filter" />
        ) : (
          <Accordion type="multiple" className="space-y-3">
            {sheetRoutes.map(r => (
              <AccordionItem key={r.routeId} value={r.routeId} className="erp-panel border-0">
                <div className="print-document">
                  <AccordionTrigger className="px-4 py-3 hover:no-underline">
                    <div className="flex items-center justify-between w-full pr-3">
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-[12.5px] text-muted-foreground">{r.routeCode}</span>
                        <span className="font-semibold text-[14px]">{r.routeName}</span>
                        {r.contractorName && <span className="text-[12px] text-muted-foreground">· {r.contractorName}</span>}
                      </div>
                      <div className="flex items-center gap-4 text-[12px]">
                        <span><span className="text-muted-foreground">Dealers</span> <span className="font-semibold num">{r.dealerCount}</span></span>
                        <span><span className="text-muted-foreground">Packets</span> <span className="font-semibold num">{fmtNum(r.totals.packets)}</span></span>
                        <span><span className="text-muted-foreground">Crates</span> <span className="font-semibold num">{fmtNum(routeCrates(r))}</span></span>
                        <span className="font-medium num">{fmtINR(r.totalAmount)}</span>
                        <StatusPill status={r.status} />
                      </div>
                    </div>
                  </AccordionTrigger>

                  <AccordionContent className="border-t border-border bg-muted/20">
                    <table className="erp-table">
                      <thead>
                        <tr>
                          <th>Product</th>
                          <th>Category</th>
                          <th>Pack</th>
                          <th className="num" style={{ textAlign: "right", width: 100 }}>Packets</th>
                          <th className="num" style={{ textAlign: "right", width: 90 }}>Per Crate</th>
                          <th className="num" style={{ textAlign: "right", width: 90 }}>Crates</th>
                          <th className="num" style={{ textAlign: "right", width: 90 }}>Pkt (+)</th>
                          <th className="num" style={{ textAlign: "right", width: 90 }}>Pkt (−)</th>
                          <th style={{ width: 80, textAlign: "center" }}>Verify</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.items.map(it => {
                          const k = `${r.routeId}:${it.productId}`;
                          // Pkt (+) / Pkt (−) and crates auto-generated from the
                          // route-sheet formula — no manual entry.
                          const cp = cratePkts(it.totalPackets ?? 0, it.packetsPerCrate ?? 0);

                          return (
                            <tr key={it.productId}>
                              <td className="font-medium">{it.productName}</td>
                              <td className="text-muted-foreground">{it.category}</td>
                              <td className="text-muted-foreground">{it.packSize ?? "—"}{it.unit && ` ${it.unit}`}</td>
                              <td className="num font-semibold" style={{ textAlign: "right" }}>{fmtNum(it.totalPackets)}</td>
                              <td className="num text-muted-foreground" style={{ textAlign: "right" }}>{fmtNum(it.packetsPerCrate)}</td>
                              <td className="num font-semibold" style={{ textAlign: "right" }}>{fmtNum(cp.crates)}</td>
                              <td className="num font-semibold" style={{ textAlign: "right" }}>{cp.pktPlus > 0 ? fmtNum(cp.pktPlus) : "—"}</td>
                              <td className="num font-semibold" style={{ textAlign: "right" }}>{cp.pktMinus > 0 ? fmtNum(cp.pktMinus) : "—"}</td>
                              <td style={{ textAlign: "center" }}>
                                <Checkbox
                                  checked={!!verified[k]}
                                  onCheckedChange={v => setVerified(prev => ({ ...prev, [k]: !!v }))}
                                />
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>

                    <div className="flex justify-end gap-2 px-4 py-3 border-t border-border bg-panel">
                      <Button size="sm" variant="outline" className="h-8" onClick={() => window.print()}>
                        <Printer className="h-3.5 w-3.5 mr-1.5" /> Print Loading Slip
                      </Button>
                      <Button
                        size="sm"
                        className="h-8"
                        disabled={r.status === "dispatched" || r.status === "delivered" || markDispatched.isPending}
                        onClick={() => markDispatched.mutate(r.routeId)}
                      >
                        <Send className="h-3.5 w-3.5 mr-1.5" />
                        Mark Dispatched
                      </Button>
                    </div>
                  </AccordionContent>
                </div>
              </AccordionItem>
            ))}
          </Accordion>
        )}
      </div>
    </div>
  );
}
