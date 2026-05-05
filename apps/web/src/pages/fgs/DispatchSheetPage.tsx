// ════════════════════════════════════════════════════════════════════
// Dispatch Sheet — loading checklist by route
// Route preserved: /fgs/dispatch-sheet
// ════════════════════════════════════════════════════════════════════
import { useEffect, useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, Field, EmptyState, StatusPill, StatCard, fmtINR, fmtDate, fmtNum,
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

export default function DispatchSheetPage() {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [selectedDate, setSelectedDate] = useState(today);
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);
  const [verified, setVerified] = useState<Record<string, boolean>>({});
  const [adjustments, setAdjustments] = useState<Record<string, { pktPlus: number; pktMinus: number }>>({});

  // Reset verification and adjustments when filters change
  useEffect(() => {
    setVerified({});
    setAdjustments({});
  }, [selectedDate, selectedRoute, selectedBatch]);

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  const { data, isLoading } = useQuery({
    queryKey: ["dispatch-sheet", selectedDate, selectedRoute, selectedBatch],
    queryFn: () => fetchDispatchSheet({
      date: selectedDate,
      routeId: selectedRoute ?? undefined,
      batchId: selectedBatch ?? undefined,
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

  const summary = data?.summary;
  const sheetRoutes: DispatchSheetRoute[] = data?.routes ?? [];

  const adj = (routeId: string, productId: string) =>
    adjustments[`${routeId}::${productId}`] ?? { pktPlus: 0, pktMinus: 0 };

  const setAdj = (routeId: string, productId: string, patch: Partial<{ pktPlus: number; pktMinus: number }>) => {
    setAdjustments(prev => ({
      ...prev,
      [`${routeId}::${productId}`]: { ...adj(routeId, productId), ...patch },
    }));
  };

  const eff = (pendingQty: number, a: { pktPlus: number; pktMinus: number }) =>
    Math.max(0, pendingQty + (a.pktPlus || 0) - (a.pktMinus || 0));

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Dispatch Sheet"
        subtitle={data ? `${fmtDate(data.date)} — loading checklist by route` : "Daily loading checklist"}
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
            <StatCard label="Crates" value={fmtNum(summary.totalCrates)} icon={<Package className="h-5 w-5" />} tone="success" />
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
                        <span><span className="text-muted-foreground">Crates</span> <span className="font-semibold num">{fmtNum(r.totals.crates)}</span></span>
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
                          const a = adj(r.routeId, it.productId);
                          const effectivePackets = eff(it.totalPackets ?? 0, a);

                          return (
                            <tr key={it.productId}>
                              <td className="font-medium">{it.productName}</td>
                              <td className="text-muted-foreground">{it.category}</td>
                              <td className="text-muted-foreground">{it.packSize ?? "—"}{it.unit && ` ${it.unit}`}</td>
                              <td className="num font-semibold" style={{ textAlign: "right" }}>{fmtNum(it.totalPackets)}</td>
                              <td className="num text-muted-foreground" style={{ textAlign: "right" }}>{fmtNum(it.packetsPerCrate)}</td>
                              <td className="num font-semibold" style={{ textAlign: "right" }}>{fmtNum(it.crates)}</td>
                              <td className="num" style={{ textAlign: "right" }}>
                                <Input
                                  className="erp-input num text-right h-7 px-1 w-16"
                                  type="number" min="0"
                                  value={a.pktPlus || ""}
                                  onChange={e => setAdj(r.routeId, it.productId, { pktPlus: parseInt(e.target.value) || 0 })}
                                />
                              </td>
                              <td className="num" style={{ textAlign: "right" }}>
                                <Input
                                  className="erp-input num text-right h-7 px-1 w-16"
                                  type="number" min="0"
                                  value={a.pktMinus || ""}
                                  onChange={e => setAdj(r.routeId, it.productId, { pktMinus: parseInt(e.target.value) || 0 })}
                                />
                              </td>
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