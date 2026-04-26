// apps/web/src/pages/fgs/CreateDispatchPage.tsx
// ════════════════════════════════════════════════════════════════════
// Create Dispatch — /fgs/dispatch/create
//
// Layout:
//   • Top form card: Date, Route (F9), Batch (F9), Dispatch Time,
//     Vehicle, Driver Name, Driver Phone, Notes.
//     Dispatch Time and Vehicle auto-fill from the selected route
//     (route's batch dispatch_time > route dispatch_time; contractor
//     vehicle_number) — editable by the dispatcher.
//
//   • Indent selection panel: when Date + Route are set, fetches
//     pending indents for {date, routeId, batchId}. User toggles
//     checkboxes; live totals (indents, items, amount) update under
//     the table.
//
//   • Submit → createDispatch → toast → navigate to /fgs/dispatch-sheet
//     with the same filters preselected so the dispatcher lands on
//     the loading checklist.
//
// The existing GET /orders endpoint is filtered server-side by status,
// date, routeId, and (importantly) batchId via the batch_routes
// junction — so the "pending indents" list already respects all
// filters.
// ════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { PageShell, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Send, Truck } from "lucide-react";
import {
  fetchRoutes,
  fetchBatches,
  fetchIndents,
  createDispatch,
} from "@/services/api";

const fmtInt   = new Intl.NumberFormat("en-IN");
const fmtMoney = (n: number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(n);

export default function CreateDispatchPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const today = new Date().toISOString().slice(0, 10);

  // ── Form state ───────────────────────────────────────────────
  const [date,          setDate]          = useState(today);
  const [routeId,       setRouteId]       = useState<string | null>(null);
  const [batchId,       setBatchId]       = useState<string | null>(null);
  const [dispatchTime,  setDispatchTime]  = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [driverName,    setDriverName]    = useState("");
  const [driverPhone,   setDriverPhone]   = useState("");
  const [notes,         setNotes]         = useState("");

  // Set of selected indent IDs.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // ── Dropdown data ────────────────────────────────────────────
  const { data: routes  = [] } = useQuery({ queryKey: ["routes"],  queryFn: fetchRoutes  });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  const routeOptions: F9Option[] = useMemo(
    () =>
      (routes as any[]).map(r => ({
        value:    r.id,
        label:    r.name,
        sublabel: r.code,
      })),
    [routes]
  );

  // Batches available for the selected route (filtered).
  // If route is not set yet, show all batches. If set, restrict to
  // batches that include this route (via routeIds array from
  // /batches endpoint).
  const batchOptions: F9Option[] = useMemo(() => {
    const all = (batches as any[]).map(b => ({
      value:    b.id,
      label:    b.whichBatch || b.batchCode,
      sublabel: b.timing,
      _routeIds: (b.routeIds ?? []) as string[],
    }));
    if (!routeId) return all.map(({ _routeIds, ...rest }) => rest);
    return all
      .filter(b => b._routeIds.includes(routeId))
      .map(({ _routeIds, ...rest }) => rest);
  }, [batches, routeId]);

  // ── Auto-fill: when route changes, fill vehicle + dispatch time
  // from route / contractor / batch. Dispatcher can still edit.
  const selectedRoute = useMemo(
    () => (routes as any[]).find(r => r.id === routeId) ?? null,
    [routes, routeId]
  );
  const selectedBatch = useMemo(
    () => (batches as any[]).find(b => b.id === batchId) ?? null,
    [batches, batchId]
  );

  // Push auto-fills into the input state — but ONLY if the
  // dispatcher hasn't already typed something (we check empty
  // strings only).
  //
  // NOTE: we don't auto-fill vehicle here because the /routes
  // endpoint doesn't currently surface the contractor's vehicle
  // number. The backend already falls back to the contractor's
  // vehicle at submit time if we send null, so leaving this blank
  // is safe — the saved assignment will still have the right vehicle.
  useEffect(() => {
    if (selectedRoute) {
      // Batch dispatch_time > route dispatch_time (same rule as backend).
      const fromBatch = selectedBatch?.dispatchTime ?? "";
      const fromRoute = selectedRoute?.dispatchTime ?? "";
      const resolved  = (fromBatch || fromRoute || "").slice(0, 5);  // "HH:MM"
      setDispatchTime(cur => (cur && cur.trim().length > 0 ? cur : resolved));
    }
  }, [selectedRoute, selectedBatch]);

  // ── Pending indents for this route+batch+date ────────────────
  // Gate the query on routeId — no point fetching without a route.
  const {
    data: indents = [],
    isLoading: indentsLoading,
    isFetching,
  } = useQuery({
    queryKey: ["indents", "pending", date, routeId, batchId],
    queryFn: () =>
      fetchIndents({
        status:  "pending",
        date,
        routeId: routeId ?? undefined,
        batchId: batchId ?? undefined,
      }),
    enabled: Boolean(routeId && date),
  });

  // Reset selection whenever the result set can change.
  useEffect(() => {
    setSelectedIds(new Set());
  }, [date, routeId, batchId]);

  // ── Derived totals from the selected subset ──────────────────
  const totals = useMemo(() => {
    let ind = 0;
    let items = 0;
    let amount = 0;
    for (const i of indents as any[]) {
      if (selectedIds.has(i.id)) {
        ind    += 1;
        items  += (i.items?.length ?? 0);
        amount += Number(i.totalAmount ?? i.total ?? 0);
      }
    }
    return { indents: ind, items, amount };
  }, [indents, selectedIds]);

  const allSelected =
    indents.length > 0 && selectedIds.size === (indents as any[]).length;

  const toggleAll = () => {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set((indents as any[]).map(i => i.id)));
    }
  };

  const toggleOne = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  // ── Submit ───────────────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: () =>
      createDispatch({
        date,
        routeId:       routeId!,
        batchId,
        dispatchTime:  dispatchTime  || null,
        vehicleNumber: vehicleNumber || null,
        driverName:    driverName    || null,
        driverPhone:   driverPhone   || null,
        notes:         notes         || null,
        indentIds:     Array.from(selectedIds),
      }),
    onSuccess: res => {
      toast.success(res.message);
      qc.invalidateQueries({ queryKey: ["dispatch-sheet"] });
      qc.invalidateQueries({ queryKey: ["dispatch-assignments"] });
      qc.invalidateQueries({ queryKey: ["indents"] });
      // Navigate to the sheet so dispatcher lands on the loading
      // checklist for the route they just created.
      navigate("/fgs/dispatch-sheet");
    },
    onError: (err: any) =>
      toast.error(err?.message || "Failed to create dispatch"),
  });

  const canSubmit =
    Boolean(routeId) &&
    selectedIds.size > 0 &&
    !submitMutation.isPending;

  // ──────────────────────────────────────────────────────────────
  return (
    <PageShell
      header={
        <>
          <PageHeader
            title="Create Dispatch"
            description="Post pending indents to a route and prepare the dispatch"
          >
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate("/fgs/dispatch-sheet")}
            >
              <ArrowLeft className="h-4 w-4 mr-1.5" />
              Back to Sheet
            </Button>
          </PageHeader>

          {/* ── Form card ── */}
          <Card>
            <CardContent className="p-5 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Date
                  </label>
                  <input
                    type="date"
                    value={date}
                    onChange={e => setDate(e.target.value)}
                    className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Route <span className="text-destructive">*</span>
                  </label>
                  <F9SearchSelect
                    value={routeId}
                    onChange={v => {
                      setRouteId(v);
                      // Clear batch if it no longer applies to the new route.
                      if (v && batchId) {
                        const match = (batches as any[]).find(
                          b => b.id === batchId && (b.routeIds ?? []).includes(v)
                        );
                        if (!match) setBatchId(null);
                      }
                    }}
                    options={routeOptions}
                    placeholder="Select route"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Batch
                  </label>
                  <F9SearchSelect
                    value={batchId}
                    onChange={setBatchId}
                    options={batchOptions}
                    placeholder={routeId ? "All batches" : "Select route first"}
                    allowClear
                  />
                </div>

                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Dispatch Time
                  </label>
                  <Input
                    type="time"
                    value={dispatchTime}
                    onChange={e => setDispatchTime(e.target.value)}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Vehicle No.
                  </label>
                  <Input
                    type="text"
                    placeholder="KA-25-1234"
                    value={vehicleNumber}
                    onChange={e => setVehicleNumber(e.target.value)}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Driver Name
                  </label>
                  <Input
                    type="text"
                    placeholder="Driver name"
                    value={driverName}
                    onChange={e => setDriverName(e.target.value)}
                    className="w-full"
                  />
                </div>

                <div>
                  <label className="text-sm font-medium mb-1.5 block">
                    Driver Phone
                  </label>
                  <Input
                    type="tel"
                    placeholder="98xxxxxxxx"
                    value={driverPhone}
                    onChange={e => setDriverPhone(e.target.value)}
                    className="w-full"
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="text-sm font-medium mb-1.5 block">
                    Notes
                  </label>
                  <Textarea
                    placeholder="Optional notes for the loader/driver"
                    value={notes}
                    onChange={e => setNotes(e.target.value)}
                    className="w-full resize-none"
                    rows={1}
                  />
                </div>
              </div>
            </CardContent>
          </Card>
        </>
      }
    >
      {!routeId ? (
        <div className="h-full flex items-center justify-center">
          <Card className="max-w-md">
            <CardContent className="p-10 text-center space-y-2">
              <Truck className="h-10 w-10 mx-auto text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                Select a <span className="font-medium">Route</span> above to
                see pending indents.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : indentsLoading ? (
        <ScrollableTableBody className="p-4">
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </ScrollableTableBody>
      ) : (indents as any[]).length === 0 ? (
        <div className="h-full flex items-center justify-center">
          <Card className="max-w-md">
            <CardContent className="p-10 text-center">
              <p className="text-sm text-muted-foreground">
                No pending indents for this route
                {batchId && " + batch"} on {date}.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="h-full flex flex-col gap-0">
          <ScrollableTableBody className="flex-1">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
                <tr className="text-xs text-muted-foreground">
                  <th className="py-2.5 px-3 font-medium w-10 text-center">
                    <Checkbox
                      checked={allSelected}
                      onCheckedChange={toggleAll}
                      aria-label="Select all"
                    />
                  </th>
                  <th className="text-left py-2.5 px-3 font-medium">Indent No.</th>
                  <th className="text-left py-2.5 px-3 font-medium">Customer</th>
                  <th className="text-left py-2.5 px-3 font-medium">Items</th>
                  <th className="text-right py-2.5 px-3 font-medium">Total</th>
                </tr>
              </thead>
              <tbody>
                {(indents as any[]).map(i => {
                  const checked = selectedIds.has(i.id);
                  return (
                    <tr
                      key={i.id}
                      onClick={() => toggleOne(i.id)}
                      className={`border-b cursor-pointer ${
                        checked ? "bg-primary/5" : "hover:bg-muted/30"
                      }`}
                    >
                      <td className="py-2 px-3 text-center">
                        <Checkbox
                          checked={checked}
                          onCheckedChange={() => toggleOne(i.id)}
                          onClick={e => e.stopPropagation()}
                        />
                      </td>
                      <td className="py-2 px-3 font-mono text-xs">
                        {i.indentNo}
                      </td>
                      <td className="py-2 px-3 font-medium">
                        {i.customerName}
                      </td>
                      <td className="py-2 px-3 text-muted-foreground text-xs">
                        {(i.items ?? [])
                          .map((x: any) => `${x.productName}×${x.qty}`)
                          .join(", ")}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">
                        ₹{Number(i.total ?? 0).toLocaleString("en-IN")}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollableTableBody>

          {/* Live totals + submit */}
          <div className="flex-shrink-0 border-t bg-card rounded-b-lg px-4 py-3 flex items-center gap-6">
            <div className="flex items-center gap-6 text-sm">
              <Stat label="Indents" value={fmtInt.format(totals.indents)} />
              <Stat label="Items"   value={fmtInt.format(totals.items)} />
              <Stat label="Amount"  value={fmtMoney(totals.amount)} />
              {isFetching && (
                <span className="text-xs text-muted-foreground">
                  Refreshing…
                </span>
              )}
            </div>
            <Button
              className="ml-auto"
              disabled={!canSubmit}
              onClick={() => submitMutation.mutate()}
            >
              <Send className="h-4 w-4 mr-1.5" />
              {submitMutation.isPending
                ? "Posting…"
                : `Post ${totals.indents} Indent${totals.indents === 1 ? "" : "s"}`}
            </Button>
          </div>
        </div>
      )}
    </PageShell>
  );
}

// ─── Small primitive ─────────────────────────────────────────────
function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-[10px] uppercase tracking-wide text-muted-foreground">
        {label}
      </span>{" "}
      <span className="font-mono font-medium">{value}</span>
    </div>
  );
}