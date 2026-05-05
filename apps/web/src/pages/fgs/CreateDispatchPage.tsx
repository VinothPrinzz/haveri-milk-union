import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FormSection,
  Field,
  FormFooter,
  EmptyState,
  fmtINR,
} from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowLeft, Send } from "lucide-react";
import {
  fetchRoutes,
  fetchBatches,
  fetchPendingIndents,
  createDispatch,
} from "@/services/api";

export default function CreateDispatchPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);

  const [date, setDate]                 = useState(today);
  const [routeId, setRouteId]           = useState<string | null>(null);
  const [batchId, setBatchId]           = useState<string | null>(null);
  const [dispatchTime, setDispatchTime] = useState("");
  const [vehicleNumber, setVehicleNumber] = useState("");
  const [driverName, setDriverName]     = useState("");
  const [driverPhone, setDriverPhone]   = useState("");
  const [notes, setNotes]               = useState("");
  const [selectedIds, setSelectedIds]   = useState<Set<string>>(new Set());

  const { data: routes = [] }  = useQuery({ queryKey: ["routes"],  queryFn: fetchRoutes });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  const routeOptions: F9Option[] = (routes as any[]).map((r: any) => ({
    value: r.id, label: r.name, sublabel: r.code,
  }));
  const batchOptions: F9Option[] = useMemo(() => {
    if (!routeId) return (batches as any[]).map((b: any) => ({ value: b.id, label: b.name }));
    return (batches as any[])
      .filter((b: any) => (b.routeIds ?? []).includes(routeId))
      .map((b: any) => ({ value: b.id, label: b.name }));
  }, [batches, routeId]);

  // Auto-fill defaults from selected route
  useEffect(() => {
    const r = (routes as any[]).find((x: any) => x.id === routeId);
    if (r) {
      if (r.dispatchTime && !dispatchTime) setDispatchTime(r.dispatchTime);
      if (r.contractor?.vehicleNumber && !vehicleNumber) setVehicleNumber(r.contractor.vehicleNumber);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [routeId, routes]);

  // Pending indents for the chosen filter
  const { data: pending = [], isLoading: pLoading } = useQuery({
    queryKey: ["pending-indents", date, routeId, batchId],
    queryFn: () => fetchPendingIndents({ date, routeId: routeId!, batchId: batchId ?? undefined }),
    enabled: !!routeId,
  });

  const totals = useMemo(() => {
    const sel = (pending as any[]).filter((p: any) => selectedIds.has(p.id));
    return {
      indents: sel.length,
      items:   sel.reduce((s: number, x: any) => s + (x.itemCount ?? 0), 0),
      amount:  sel.reduce((s: number, x: any) => s + Number(x.totalAmount ?? 0), 0),
    };
  }, [pending, selectedIds]);

  const submitMutation = useMutation({
    mutationFn: () => createDispatch({
      date,
      routeId: routeId!,
      batchId,
      dispatchTime: dispatchTime || null,
      vehicleNumber: vehicleNumber || null,
      driverName: driverName || null,
      driverPhone: driverPhone || null,
      notes: notes || null,
      indentIds: Array.from(selectedIds),
    }),
    onSuccess: () => {
      toast.success("Dispatch created");
      qc.invalidateQueries({ queryKey: ["dispatch-sheet"] });
      qc.invalidateQueries({ queryKey: ["pending-indents"] });
      navigate("/fgs/dispatch-sheet");
    },
    onError: (err: any) => toast.error(err?.message || "Failed to create dispatch"),
  });

  const canSubmit = !!routeId && selectedIds.size > 0 && !submitMutation.isPending;

  const toggleAll = () => {
    if (selectedIds.size === (pending as any[]).length) setSelectedIds(new Set());
    else setSelectedIds(new Set((pending as any[]).map((p: any) => p.id)));
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Create Dispatch"
        subtitle="Post pending indents to a route and prepare the dispatch"
        actions={
          <Button size="sm" variant="outline" className="h-8" onClick={() => navigate("/fgs/dispatch-sheet")}>
            <ArrowLeft className="h-3.5 w-3.5 mr-1.5" /> Back to Sheet
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-4 pb-20 space-y-4">
        <FormSection title="Dispatch Details" cols={3}>
          <Field label="Date" required>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="erp-input" />
          </Field>
          <Field label="Route" required hint="F9">
            <F9SearchSelect
              value={routeId}
              onChange={v => {
                setRouteId(v);
                if (v && batchId) {
                  const match = (batches as any[]).find((b: any) => b.id === batchId && (b.routeIds ?? []).includes(v));
                  if (!match) setBatchId(null);
                }
              }}
              options={routeOptions}
              placeholder="Select route"
            />
          </Field>
          <Field label="Batch">
            <F9SearchSelect
              value={batchId}
              onChange={setBatchId}
              options={batchOptions}
              placeholder={routeId ? "All batches for route" : "Select route first"}
            />
          </Field>
          <Field label="Dispatch Time">
            <Input type="time" value={dispatchTime} onChange={e => setDispatchTime(e.target.value)} className="erp-input" />
          </Field>
          <Field label="Vehicle No.">
            <Input value={vehicleNumber} onChange={e => setVehicleNumber(e.target.value)} className="erp-input" placeholder="KA-25-AB-1234" />
          </Field>
          <Field label="Driver Name">
            <Input value={driverName} onChange={e => setDriverName(e.target.value)} className="erp-input" />
          </Field>
          <Field label="Driver Phone">
            <Input value={driverPhone} onChange={e => setDriverPhone(e.target.value)} className="erp-input" />
          </Field>
          <Field label="Notes">
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} className="erp-input min-h-[60px]" placeholder="Special instructions…" />
          </Field>
        </FormSection>

        <div className="erp-panel">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/40">
            <h3 className="erp-section-title">Pending Indents</h3>
            <div className="text-[12px] text-muted-foreground">
              {selectedIds.size > 0
                ? <>Selected <span className="num font-semibold text-foreground">{totals.indents}</span> · Items <span className="num font-semibold text-foreground">{totals.items}</span> · {fmtINR(totals.amount)}</>
                : <>{(pending as any[]).length} indent{(pending as any[]).length !== 1 ? "s" : ""} pending</>}
            </div>
          </div>

          {!routeId ? (
            <EmptyState title="Select a route to load pending indents" />
          ) : pLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : (pending as any[]).length === 0 ? (
            <EmptyState title="No pending indents for this filter" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 36, textAlign: "center" }}>
                    <Checkbox
                      checked={selectedIds.size === (pending as any[]).length && (pending as any[]).length > 0}
                      onCheckedChange={toggleAll}
                    />
                  </th>
                  <th>Indent</th>
                  <th>Dealer</th>
                  <th className="num" style={{ textAlign: "right", width: 90 }}>Items</th>
                  <th className="num" style={{ textAlign: "right", width: 130 }}>Amount ₹</th>
                </tr>
              </thead>
              <tbody>
                {(pending as any[]).map((p: any) => (
                  <tr
                    key={p.id}
                    className="cursor-pointer"
                    onClick={() => {
                      setSelectedIds(prev => {
                        const next = new Set(prev);
                        if (next.has(p.id)) next.delete(p.id); else next.add(p.id);
                        return next;
                      });
                    }}
                  >
                    <td style={{ textAlign: "center" }}>
                      <Checkbox
                        checked={selectedIds.has(p.id)}
                        onCheckedChange={() => {/* row handles */}}
                        onClick={(e: any) => e.stopPropagation()}
                      />
                    </td>
                    <td className="font-mono text-[12.5px]">{p.code ?? p.id}</td>
                    <td>{p.dealerName}</td>
                    <td className="num" style={{ textAlign: "right" }}>{p.itemCount ?? 0}</td>
                    <td className="num font-medium" style={{ textAlign: "right" }}>{fmtINR(p.totalAmount ?? 0)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <FormFooter>
        <Button variant="outline" className="h-9" onClick={() => navigate("/fgs/dispatch-sheet")}>Cancel</Button>
        <Button className="h-9" disabled={!canSubmit} onClick={() => submitMutation.mutate()}>
          <Send className="h-3.5 w-3.5 mr-1.5" />
          {submitMutation.isPending ? "Creating…" : "Create Dispatch"}
        </Button>
      </FormFooter>
    </div>
  );
}