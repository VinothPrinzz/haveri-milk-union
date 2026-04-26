// apps/web/src/pages/fgs/DispatchSheetPage.tsx
// ════════════════════════════════════════════════════════════════════
// Dispatch Sheet — Loading Checklist (revamp)
//
// Replaces the old route-totals view. This page is the dispatcher's
// morning loading tool:
//
//   1. Top filter bar: Date / Route / Batch — all F9SearchSelect
//      (staff use F9 key + touch on kiosks)
//   2. Summary strip: 4 stats across the top
//   3. Per-route accordion cards — each expands to show
//      item-wise loading table (Product / Category / Pack /
//      Packets / Packets-per-Crate / Crates / Loose Packets / Verified)
//   4. Per-row verify checkbox (local state — dispatcher's tally,
//      not persisted — by design; they tick as they load the truck)
//   5. Per-route actions: Print Loading Slip (A4) + Mark Dispatched
//
// All aggregation is server-side (see dispatch-sheet.ts). This page
// is a dumb consumer — no SUM/FLOOR/MOD in the browser.
// ════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Printer, Send, Package, Truck, Layers } from "lucide-react";
import {
  fetchDispatchSheet,
  markRouteDispatched,
  fetchRoutes,
  fetchBatches,
  type DispatchSheetRoute,
} from "@/services/api";

// ── Status label + color helpers ─────────────────────────────────
const STATUS_STYLES: Record<string, string> = {
  pending:    "bg-muted text-muted-foreground",
  loading:    "bg-amber-100 text-amber-700",
  dispatched: "bg-green-100 text-green-700",
  delivered:  "bg-blue-100 text-blue-700",
};

// Number formatter — Indian locale, no decimals for packet counts.
const fmtInt = new Intl.NumberFormat("en-IN");
const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);

export default function DispatchSheetPage() {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [selectedDate, setSelectedDate]  = useState(today);
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null);

  // Local verify state — keyed by `${routeId}:${productId}`.
  // Cleared when the user changes date/route/batch (fresh load).
  const [verified, setVerified] = useState<Record<string, boolean>>({});

  // Reset verification when filters change.
  useEffect(() => {
    setVerified({});
  }, [selectedDate, selectedRoute, selectedBatch]);

  // ── Filter dropdown data ─────────────────────────────────────
  const { data: routes = [] } = useQuery({
    queryKey: ["routes"],
    queryFn: fetchRoutes,
  });
  const { data: batches = [] } = useQuery({
    queryKey: ["batches"],
    queryFn: fetchBatches,
  });

  const routeOptions: F9Option[] = useMemo(
    () =>
      (routes as any[]).map(r => ({
        value: r.id,
        label: r.name,
        sublabel: r.code,
      })),
    [routes]
  );

  const batchOptions: F9Option[] = useMemo(
    () =>
      (batches as any[]).map(b => ({
        value: b.id,
        label: b.whichBatch || b.batchCode,
        sublabel: b.timing,
      })),
    [batches]
  );

  // ── Main aggregation query ───────────────────────────────────
  const {
    data: sheet,
    isLoading,
    isFetching,
  } = useQuery({
    queryKey: ["dispatch-sheet", selectedDate, selectedRoute, selectedBatch],
    queryFn: () =>
      fetchDispatchSheet({
        date: selectedDate,
        routeId: selectedRoute ?? undefined,
        batchId: selectedBatch ?? undefined,
      }),
  });

  // ── Mark dispatched mutation ─────────────────────────────────
  const dispatchMutation = useMutation({
    mutationFn: (routeId: string) =>
      markRouteDispatched({ routeId, date: selectedDate }),
    onSuccess: res => {
      toast.success(res.message);
      qc.invalidateQueries({ queryKey: ["dispatch-sheet"] });
      qc.invalidateQueries({ queryKey: ["dispatch-assignments"] });
      qc.invalidateQueries({ queryKey: ["indents"] });
    },
    onError: (err: any) =>
      toast.error(err?.message || "Failed to mark as dispatched"),
  });

  // ── Print loading slip ───────────────────────────────────────
  // Uses window.print() scoped to the selected route section.
  // We set a data-attribute on <body> before printing so our print
  // CSS (injected below) can show ONLY that route's card.
  const printLoadingSlip = (routeId: string) => {
    document.body.setAttribute("data-print-route", routeId);
    setTimeout(() => {
      window.print();
      document.body.removeAttribute("data-print-route");
    }, 50);
  };

  const summary = sheet?.summary ?? {
    totalItems:   0,
    totalPackets: 0,
    totalCrates:  0,
    totalRoutes:  0,
  };
  const sheetRoutes = sheet?.routes ?? [];

  return (
    <PageShell
      header={
        <>
          <PageHeader
            title="Dispatch Sheet"
            description={`Loading checklist — ${selectedDate}`}
          />

          {/* Filters */}
          <FilterBar>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Date</label>
              <input
                type="date"
                value={selectedDate}
                onChange={e => setSelectedDate(e.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>

            <div className="min-w-[220px]">
              <label className="text-sm font-medium mb-1.5 block">Route</label>
              <F9SearchSelect
                value={selectedRoute}
                onChange={setSelectedRoute}
                options={routeOptions}
                placeholder="All routes"
                allowClear
              />
            </div>

            <div className="min-w-[220px]">
              <label className="text-sm font-medium mb-1.5 block">Batch</label>
              <F9SearchSelect
                value={selectedBatch}
                onChange={setSelectedBatch}
                options={batchOptions}
                placeholder="All batches"
                allowClear
              />
            </div>

            {isFetching && !isLoading && (
              <div className="text-xs text-muted-foreground pb-2">
                Refreshing…
              </div>
            )}
          </FilterBar>

          {/* Summary strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              icon={<Package className="h-4 w-4 text-muted-foreground" />}
              label="Total Items"
              value={fmtInt.format(summary.totalItems)}
            />
            <StatCard
              icon={<Layers className="h-4 w-4 text-muted-foreground" />}
              label="Total Packets"
              value={fmtInt.format(summary.totalPackets)}
            />
            <StatCard
              icon={<Layers className="h-4 w-4 text-muted-foreground" />}
              label="Total Crates"
              value={fmtInt.format(summary.totalCrates)}
            />
            <StatCard
              icon={<Truck className="h-4 w-4 text-muted-foreground" />}
              label="Total Routes"
              value={fmtInt.format(summary.totalRoutes)}
            />
          </div>
        </>
      }
    >
      {isLoading ? (
        <ScrollableTableBody className="p-4">
          <div className="space-y-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-24 w-full" />
            ))}
          </div>
        </ScrollableTableBody>
      ) : sheetRoutes.length === 0 ? (
        <ScrollableTableBody>
          <div className="h-full flex items-center justify-center">
            <Card className="max-w-md">
              <CardContent className="p-10 text-center">
                <p className="text-sm text-muted-foreground">
                  No indents found for {selectedDate}
                  {selectedRoute && " on this route"}
                  {selectedBatch && " in this batch"}.
                </p>
              </CardContent>
            </Card>
          </div>
        </ScrollableTableBody>
      ) : (
        <ScrollableTableBody className="p-4">
          <Accordion
            type="multiple"
            defaultValue={sheetRoutes.map(r => r.routeId)}
            className="space-y-3"
          >
            {sheetRoutes.map(route => (
              <RouteCard
                key={route.routeId}
                route={route}
                verified={verified}
                setVerified={setVerified}
                onPrint={() => printLoadingSlip(route.routeId)}
                onMarkDispatched={() => dispatchMutation.mutate(route.routeId)}
                isDispatching={dispatchMutation.isPending}
              />
            ))}
          </Accordion>
        </ScrollableTableBody>
      )}

      {/* Print-only CSS.
          Renders just the route the dispatcher clicked print on.
          Rest of the UI (sidebar, filters, other routes) hides.        */}
      <style>{`
        @media print {
          @page { size: A4; margin: 10mm; }
          body > *:not(.print-root) { display: none !important; }
          .print-root { display: block !important; }
          [data-route-card]:not([data-print-visible="true"]) { display: none !important; }
          [data-route-card] { page-break-inside: avoid; }
          .no-print { display: none !important; }
        }
      `}</style>
    </PageShell>
  );
}

// ────────────────────────────────────────────────────────────────────
// Per-route accordion card
// ────────────────────────────────────────────────────────────────────
function RouteCard({
  route,
  verified,
  setVerified,
  onPrint,
  onMarkDispatched,
  isDispatching,
}: {
  route: DispatchSheetRoute;
  verified: Record<string, boolean>;
  setVerified: React.Dispatch<React.SetStateAction<Record<string, boolean>>>;
  onPrint: () => void;
  onMarkDispatched: () => void;
  isDispatching: boolean;
}) {
  const statusClass =
    STATUS_STYLES[route.status] ?? "bg-muted text-muted-foreground";

  // Display-only: strip seconds from "HH:MM:SS"
  const dispatchTime = route.dispatchTime?.slice(0, 5) ?? "—";

  const verifiedCount = route.items.reduce(
    (n, it) => (verified[`${route.routeId}:${it.productId}`] ? n + 1 : n),
    0
  );
  const allVerified =
    route.items.length > 0 && verifiedCount === route.items.length;

  return (
    <AccordionItem
      value={route.routeId}
      data-route-card
      data-print-visible={route.routeId}
      className="border rounded-lg bg-card overflow-hidden data-[state=open]:shadow-sm"
    >
      <AccordionTrigger className="px-4 py-3 hover:no-underline hover:bg-muted/30">
        <div className="flex-1 flex items-center justify-between gap-4 mr-2">
          <div className="flex items-center gap-4 text-left">
            <div>
              <div className="font-semibold text-sm">
                {route.routeCode} — {route.routeName}
              </div>
              <div className="text-xs text-muted-foreground">
                {route.contractorName ?? "No contractor"} ·{" "}
                {route.vehicleNumber ?? "No vehicle"} ·{" "}
                {dispatchTime}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Stat label="Packets" value={route.totals.packets} />
            <Stat label="Crates" value={route.totals.crates} />
            <Stat label="Amount" value={fmtMoney(route.totalAmount)} />
            <span
              className={`text-xs px-2 py-0.5 rounded font-medium capitalize ${statusClass}`}
            >
              {route.status}
            </span>
          </div>
        </div>
      </AccordionTrigger>

      <AccordionContent className="px-0 pb-0">
        {/* Item-wise loading table */}
        <div className="border-t overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-xs text-muted-foreground">
              <tr className="border-b">
                <th className="text-left py-2 px-3 font-medium">Product</th>
                <th className="text-left py-2 px-3 font-medium">Category</th>
                <th className="text-left py-2 px-3 font-medium">Pack</th>
                <th className="text-right py-2 px-3 font-medium">Packets</th>
                <th className="text-right py-2 px-3 font-medium">Pkts/Crate</th>
                <th className="text-right py-2 px-3 font-medium">Crates</th>
                <th className="text-right py-2 px-3 font-medium">Loose</th>
                <th className="text-center py-2 px-3 font-medium no-print">
                  Verified
                </th>
              </tr>
            </thead>
            <tbody>
              {route.items.map(it => {
                const key = `${route.routeId}:${it.productId}`;
                const isOn = verified[key] ?? false;
                return (
                  <tr
                    key={it.productId}
                    className={`border-b last:border-0 ${
                      isOn ? "bg-green-50/40" : "hover:bg-muted/20"
                    }`}
                  >
                    <td className="py-2 px-3 font-medium">{it.productName}</td>
                    <td className="py-2 px-3 text-muted-foreground">
                      {it.category}
                    </td>
                    <td className="py-2 px-3 text-muted-foreground">
                      {it.packSize ? `${it.packSize}` : it.unit}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      {fmtInt.format(it.totalPackets)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-muted-foreground">
                      {it.packetsPerCrate > 0 ? it.packetsPerCrate : "—"}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-semibold">
                      {fmtInt.format(it.crates)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono">
                      {fmtInt.format(it.loosePackets)}
                    </td>
                    <td className="py-2 px-3 text-center no-print">
                      <Checkbox
                        checked={isOn}
                        onCheckedChange={v =>
                          setVerified(prev => ({
                            ...prev,
                            [key]: Boolean(v),
                          }))
                        }
                      />
                    </td>
                  </tr>
                );
              })}
              {/* Footer row: totals */}
              <tr className="bg-muted/40 font-semibold">
                <td colSpan={3} className="py-2 px-3 text-right">
                  Route Total
                </td>
                <td className="py-2 px-3 text-right font-mono">
                  {fmtInt.format(route.totals.packets)}
                </td>
                <td />
                <td className="py-2 px-3 text-right font-mono">
                  {fmtInt.format(route.totals.crates)}
                </td>
                <td />
                <td className="py-2 px-3 text-center text-xs no-print">
                  {verifiedCount}/{route.items.length}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Action buttons */}
        <div className="p-3 bg-muted/20 flex items-center gap-2 justify-end no-print">
          <Button variant="outline" size="sm" onClick={onPrint}>
            <Printer className="h-4 w-4 mr-1.5" />
            Print Loading Slip
          </Button>
          <Button
            size="sm"
            onClick={onMarkDispatched}
            disabled={
              isDispatching ||
              route.status === "dispatched" ||
              route.status === "delivered" ||
              !allVerified
            }
            title={
              !allVerified
                ? "Verify all rows before marking dispatched"
                : route.status === "dispatched"
                  ? "Already dispatched"
                  : ""
            }
          >
            <Send className="h-4 w-4 mr-1.5" />
            {route.status === "dispatched"
              ? "Dispatched"
              : isDispatching
                ? "Marking…"
                : "Mark Dispatched"}
          </Button>
        </div>
      </AccordionContent>
    </AccordionItem>
  );
}

// ────────────────────────────────────────────────────────────────────
// Small UI primitives
// ────────────────────────────────────────────────────────────────────
function StatCard({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        {icon}
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-lg font-semibold">{value}</div>
        </div>
      </CardContent>
    </Card>
  );
}

function Stat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="text-right">
      <div className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="text-sm font-mono font-medium">
        {typeof value === "number" ? fmtInt.format(value) : value}
      </div>
    </div>
  );
}