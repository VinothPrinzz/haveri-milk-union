import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import { Edit, Plus, Trash2, Save, X } from "lucide-react";
import PageHeader, {
  FilterBar, FormSection, Field, FormFooter, StatusPill,
} from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  fetchRoutes, 
  fetchContractors, 
  fetchZones, 
  fetchBatches,
  fetchCustomers,        // ← added
  createRoute, 
  updateRoute, 
  deleteRoute, 
  type Route as RouteType,
} from "@/services/api";
import { routeSchema, type RouteFormData } from "@/lib/validations";

interface Props { tab?: "list" | "new"; }

// ─── Shared form body (create + edit) ─────────────────────────────────
function RouteFormBody({
  initialData, autoCode, onSubmit, isSubmitting, onCancel, embedded,
}: {
  initialData?: RouteType;
  autoCode?: string;
  onSubmit: (data: RouteFormData) => void | Promise<void>;
  isSubmitting?: boolean;
  onCancel?: () => void;
  embedded?: boolean;
}) {
  const isEdit = Boolean(initialData);
  const { data: contractors = [] } = useQuery({ queryKey: ["contractors"], queryFn: fetchContractors });
  const { data: zones = [] } = useQuery({ queryKey: ["zones"], queryFn: fetchZones });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  const talukaOptions: F9Option[] = useMemo(() => zones.map(z => ({ value: z.id, label: z.name })), [zones]);
  const contractorOptions: F9Option[] = useMemo(
    () => contractors.map((c: any) => ({ value: c.id, label: c.name, sublabel: c.code })),
    [contractors],
  );
  const batchOptions: F9Option[] = useMemo(
    () => batches.map((b: any) => ({ value: b.id, label: b.whichBatch || b.batchCode, sublabel: b.timing })),
    [batches],
  );

  const form = useForm<RouteFormData>({
    resolver: zodResolver(routeSchema),
    defaultValues: initialData
      ? {
          code: initialData.code, 
          name: initialData.name,
          zoneId: initialData.zoneId ?? "",
          contractorId: initialData.contractorId ?? "",
          primaryBatchId: initialData.primaryBatchId ?? "",
          active: initialData.status === "Active",
        }
      : { code: autoCode ?? "", active: true },
  });

  useEffect(() => {
    if (!isEdit && autoCode) form.setValue("code", autoCode);
  }, [autoCode, isEdit, form]);

  const submit = form.handleSubmit(
    async data => {
      if (!data.primaryBatchId) return toast.error("Batch is required");
      if (!data.zoneId) return toast.error("Taluka is required");
      try { await onSubmit(data); }
      catch (e: any) { toast.error(e?.message || "Failed to save"); }
    },
    errors => {
      const first = Object.values(errors)[0] as any;
      if (first?.message) toast.error(first.message);
    },
  );

  const Wrap = embedded
    ? ({ children }: { children: React.ReactNode }) => <div>{children}</div>
    : ({ children }: { children: React.ReactNode }) => <div className="p-4">{children}</div>;

  return (
    <Wrap>
      <form onSubmit={submit}>
        <FormSection title="Route Details" cols={2}>
          <Field label="Route Code" hint={isEdit ? undefined : "Auto"}>
            <Input className="erp-input bg-muted font-mono" disabled {...form.register("code")} />
          </Field>
          <Field label="Route Name" required error={form.formState.errors.name?.message}>
            <Input className="erp-input" placeholder="Haveri City Route 1" {...form.register("name")} />
          </Field>
          <Field label="Taluka" hint="F9" required>
            <F9SearchSelect
              value={form.watch("zoneId") || null}
              onChange={v => form.setValue("zoneId", v ?? "")}
              options={talukaOptions}
            />
          </Field>
          <Field label="Contractor" hint="F9">
            <F9SearchSelect
              value={form.watch("contractorId") || null}
              onChange={v => form.setValue("contractorId", v ?? "")}
              options={contractorOptions}
              allowAll
              allLabel="— Unassigned —"
            />
          </Field>
          <Field label="Batch" hint="F9" required>
            <F9SearchSelect
              value={form.watch("primaryBatchId") || null}
              onChange={v => form.setValue("primaryBatchId", v ?? "")}
              options={batchOptions}
            />
          </Field>
          <Field label="Active">
            <div className="flex items-center gap-3 h-9">
              <Switch checked={form.watch("active")} onCheckedChange={v => form.setValue("active", v)} />
              <span className="text-[13px]">{form.watch("active") ? "Active" : "Inactive"}</span>
            </div>
          </Field>
        </FormSection>

        {embedded ? (
          <div className="flex justify-end gap-2 pt-2">
            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={onCancel}>
              <X className="w-3.5 h-3.5 mr-1.5" /> Cancel
            </Button>
            <Button type="submit" size="sm" className="h-8 bg-primary hover:bg-primary-hover" disabled={isSubmitting}>
              <Save className="w-3.5 h-3.5 mr-1.5" /> {isSubmitting ? "Saving…" : (isEdit ? "Update" : "Save")}
            </Button>
          </div>
        ) : (
          <FormFooter>
            <Button type="button" variant="ghost" size="sm" className="h-8" onClick={() => form.reset()}>Cancel</Button>
            <Button type="submit" size="sm" className="h-8 bg-primary hover:bg-primary-hover" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save Route"}
            </Button>
          </FormFooter>
        )}
      </form>
    </Wrap>
  );
}

// ─── Page ─────────────────────────────────────────────────────────────
export default function RoutesPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: routes = [], isLoading } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: contractors = [] } = useQuery({ queryKey: ["contractors"], queryFn: fetchContractors });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });
  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers }); // ← added

  const [editing, setEditing] = useState<RouteType | null>(null);
  const [deleting, setDeleting] = useState<RouteType | null>(null);
  const [viewing, setViewing] = useState<RouteType | null>(null); // ← added

  const nextCode = useMemo(() => {
    const nums = routes.map(r => r.code).filter(c => /^R\d+$/.test(c)).map(c => parseInt(c.slice(1)));
    const max = nums.length ? Math.max(...nums) : 0;
    return `R${max + 1}`;
  }, [routes]);

  const createMutation = useMutation({
    mutationFn: createRoute,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["routes"] }); toast.success("Route saved"); },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: RouteFormData }) => updateRoute(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["routes"] }); toast.success("Route updated"); },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRoute(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["routes"] }); toast.success("Route deleted"); setDeleting(null); },
    onError: (err: Error) => toast.error(err.message),
  });

  const batchLabelById = new Map(batches.map((b: any) => [b.id, b.whichBatch || b.batchCode]));

  // ─── New tab ───────────────────────────────────────────────────
  if (tab === "new") {
    return (
      <div>
        <PageHeader title="New Route" subtitle="Add a new delivery route" />
        <RouteFormBody
          autoCode={nextCode}
          onSubmit={async d => {
            await createMutation.mutateAsync(d);
          }}
          isSubmitting={createMutation.isPending}
        />
      </div>
    );
  }

  // ─── List tab ──────────────────────────────────────────────────
  return (
    <div>
      <PageHeader
        title="All Routes"
        subtitle={`${routes.length} route(s) configured`}
        actions={
          <Button size="sm" className="h-8 bg-primary hover:bg-primary-hover" asChild>
            <a href="/masters/routes/new"><Plus className="w-3.5 h-3.5 mr-1.5" />New Route</a>
          </Button>
        }
      />

      <div className="p-4">
        <div className="erp-panel overflow-hidden">
          <div className="overflow-auto max-h-[calc(100vh-220px)]">
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Code</th>
                  <th>Route Name</th>
                  <th>Taluka</th>
                  <th>Contractor</th>
                  <th>Batch</th>
                  <th>Dispatch</th>
                  <th style={{ textAlign: "center", width: "180px" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {isLoading && Array.from({ length: 6 }).map((_, i) => (
                  <tr key={`s-${i}`} className={i % 2 === 1 ? "zebra" : ""}>
                    {Array.from({ length: 7 }).map((_, j) => (
                      <td key={j}><Skeleton className="h-3.5 w-full" /></td>
                    ))}
                  </tr>
                ))}

                {!isLoading && routes.map((r, i) => (
                  <tr key={r.id} className={i % 2 === 1 ? "zebra" : ""}>
                    <td className="font-mono text-[12px]">{r.code}</td>
                    <td className="font-medium">{r.name}</td>
                    <td>{r.taluka || "—"}</td>
                    <td>{r.contractorName || contractors.find((c: any) => c.id === r.contractorId)?.name || "—"}</td>
                    <td>
                      {r.primaryBatchId ? (
                        <span className="font-mono text-[11px] px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">
                          {batchLabelById.get(r.primaryBatchId) ?? "?"}
                        </span>
                      ) : <span className="text-muted-foreground">—</span>}
                    </td>
                    <td>{r.dispatchTime || "—"}</td>
                    <td style={{ textAlign: "center" }}>
                      <div className="flex items-center justify-center gap-1.5">
                        <Button 
                          variant="outline" 
                          size="sm" 
                          className="h-7 px-2.5 text-[12px]" 
                          onClick={() => setViewing(r)}
                        >
                          View
                        </Button>
                        <Button 
                          size="sm" 
                          className="h-7 px-2.5 text-[12px]" 
                          onClick={() => setEditing(r)}
                        >
                          Update
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}

                {!isLoading && routes.length === 0 && (
                  <tr><td colSpan={7} className="py-8 text-center text-muted-foreground">No routes configured yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Edit dialog - unchanged */}
      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="max-w-3xl rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">Edit Route — <span className="font-mono">{editing?.code}</span></DialogTitle>
          </DialogHeader>
          {editing && (
            <RouteFormBody
              embedded
              initialData={editing}
              onCancel={() => setEditing(null)}
              onSubmit={async data => {
                await updateMutation.mutateAsync({ id: editing.id, data });
                setEditing(null);
              }}
              isSubmitting={updateMutation.isPending}
            />
          )}
        </DialogContent>
      </Dialog>

      {/* View dialog - added */}
      <Dialog open={!!viewing} onOpenChange={o => !o && setViewing(null)}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-auto">
          <DialogHeader>
            <DialogTitle>{viewing?.code} — {viewing?.name}</DialogTitle>
          </DialogHeader>
          {viewing && (() => {
            const onRoute = customers.filter((c: any) => 
              c.routes?.some((r: any) => r.routeId === viewing.id)
            );

            const Row = ({ label, value }: { label: string; value: any }) => (
              <div className="flex items-baseline gap-2 py-1 border-b border-border/60 last:border-0">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground w-32 shrink-0">{label}</span>
                <span className="text-[13px] font-medium">{value || <span className="text-muted-foreground">—</span>}</span>
              </div>
            );

            return (
              <>
                <div className="grid grid-cols-2 gap-x-6">
                  <Row label="Code"         value={<span className="font-mono">{viewing.code}</span>} />
                  <Row label="Status"       value={<StatusPill status={(viewing as any).active === false ? "draft" : "active"} />} />
                  <Row label="Name"         value={viewing.name} />
                  <Row label="Taluka"       value={viewing.taluka} />
                  <Row label="Contractor"   value={viewing.contractorName} />
                  <Row label="Batch"        value={batchLabelById.get(viewing.primaryBatchId)} />
                  <Row label="Dispatch"     value={viewing.dispatchTime} />
                  <Row label="Vehicle"      value={(viewing as any).vehicleNumber} />
                  <Row label="Driver"       value={(viewing as any).driverName} />
                </div>

                <div className="erp-panel mt-4">
                  <div className="px-3 py-2 erp-section-title !mb-0 !border-b !pb-2 flex items-center justify-between">
                    <span>Customers Assigned</span>
                    <span className="text-[11px] normal-case font-normal text-muted-foreground num">{onRoute.length}</span>
                  </div>
                  <div className="overflow-auto max-h-[40vh]">
                    <table className="erp-table">
                      <thead>
                        <tr><th style={{ width: "60px" }}>#</th><th>Code</th><th>Name</th><th>Type</th><th>Phone</th></tr>
                      </thead>
                      <tbody>
                        {onRoute.length === 0 ? (
                          <tr><td colSpan={5} className="text-center text-muted-foreground py-8">No customers on this route.</td></tr>
                        ) : onRoute.map((c: any, i: number) => (
                          <tr key={c.id}>
                            <td className="num">{i + 1}</td>
                            <td className="font-mono text-[12px]">{c.code}</td>
                            <td className="font-medium">{c.name}</td>
                            <td>{c.type}</td>
                            <td>{c.phone}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </>
            );
          })()}

          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setViewing(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm - unchanged */}
      <Dialog open={!!deleting} onOpenChange={open => !open && setDeleting(null)}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">
              Delete route <span className="font-mono">{deleting?.code}</span>?
            </DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">
            This will soft-delete <span className="font-medium text-foreground">{deleting?.name}</span>.
            Dealers currently on this route will keep their records but their dropdown will no longer show it.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" size="sm" className="h-8" onClick={() => deleting && deleteMutation.mutate(deleting.id)} disabled={deleteMutation.isPending}>
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}