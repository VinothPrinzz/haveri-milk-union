// apps/web/src/pages/masters/RoutesPage.tsx
// ════════════════════════════════════════════════════════════════════
// All Routes / New Route — Marketing v1.4
//
// Changes from v1.3:
//   • PageShell layout
//   • New Batch column in the list
//   • Edit button opens an edit dialog with a functional update form
//   • Delete button with confirm dialog
//   • Route form: removed "Dispatch Time" field, added required Batch F9
//   • Taluka / Contractor / Batch all use F9SearchSelect
// ════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { PageShell, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { Edit, Plus, Trash2 } from "lucide-react";
import {
  fetchRoutes,
  fetchContractors,
  fetchZones,
  fetchBatches,
  createRoute,
  updateRoute,
  deleteRoute,
  type Route as RouteType,
} from "@/services/api";
import { routeSchema, type RouteFormData } from "@/lib/validations";

interface Props {
  tab?: "list" | "new";
}

// ══════════════════════════════════════════════════════════════════
// Shared route form (create + edit)
// ══════════════════════════════════════════════════════════════════
function RouteFormBody({
  initialData,
  autoCode,
  onSubmit,
  isSubmitting,
  onCancel,
}: {
  initialData?: RouteType;
  autoCode?: string;
  onSubmit: (data: RouteFormData) => void | Promise<void>;
  isSubmitting?: boolean;
  onCancel?: () => void;
}) {
  const isEdit = Boolean(initialData);
  const { data: contractors = [] } = useQuery({ queryKey: ["contractors"], queryFn: fetchContractors });
  const { data: zones = [] } = useQuery({ queryKey: ["zones"], queryFn: fetchZones });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  const talukaOptions: F9Option[] = useMemo(
    () => zones.map(z => ({ value: z.id, label: z.name })),
    [zones]
  );
  const contractorOptions: F9Option[] = useMemo(
    () => contractors.map((c: any) => ({ value: c.id, label: c.name, sublabel: c.code })),
    [contractors]
  );
  const batchOptions: F9Option[] = useMemo(
    () =>
      batches.map((b: any) => ({
        value: b.id,
        label: b.whichBatch || b.batchCode,
        sublabel: b.timing,
      })),
    [batches]
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
      : {
          code: autoCode ?? "",
          active: true,
        },
  });

  // Keep auto-code synced (create mode)
  useEffect(() => {
    if (!isEdit && autoCode) form.setValue("code", autoCode);
  }, [autoCode, isEdit, form]);

  const submit = form.handleSubmit(
    async data => {
      if (!data.primaryBatchId) {
        toast.error("Batch is required");
        return;
      }
      if (!data.zoneId) {
        toast.error("Taluka is required");
        return;
      }
      try {
        await onSubmit(data);
      } catch (e: any) {
        toast.error(e?.message || "Failed to save");
      }
    },
    errors => {
      const first = Object.values(errors)[0] as any;
      if (first?.message) toast.error(first.message);
    }
  );

  return (
    <Form {...form}>
      <form onSubmit={submit} className="space-y-4">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <FormField control={form.control} name="code" render={({ field }) => (
            <FormItem>
              <FormLabel>Route Code {!isEdit && "(Auto)"}</FormLabel>
              <FormControl><Input disabled className="bg-muted" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="name" render={({ field }) => (
            <FormItem>
              <FormLabel>Route Name</FormLabel>
              <FormControl><Input placeholder="Haveri City Route 1" {...field} /></FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="zoneId" render={({ field }) => (
            <FormItem>
              <FormLabel>Taluka</FormLabel>
              <FormControl>
                <F9SearchSelect
                  value={field.value || null}
                  onChange={v => field.onChange(v ?? "")}
                  options={talukaOptions}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="contractorId" render={({ field }) => (
            <FormItem>
              <FormLabel>Contractor</FormLabel>
              <FormControl>
                <F9SearchSelect
                  value={field.value || null}
                  onChange={v => field.onChange(v ?? "")}
                  options={contractorOptions}
                  allowAll
                  allLabel="— Unassigned —"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="primaryBatchId" render={({ field }) => (
            <FormItem>
              <FormLabel>Batch</FormLabel>
              <FormControl>
                <F9SearchSelect
                  value={field.value || null}
                  onChange={v => field.onChange(v ?? "")}
                  options={batchOptions}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )} />

          <FormField control={form.control} name="active" render={({ field }) => (
            <FormItem className="flex items-center gap-3 pt-6">
              <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
              <FormLabel className="!mt-0">Active</FormLabel>
            </FormItem>
          )} />
        </div>

        <div className="flex gap-2 justify-end">
          {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
          <Button type="submit" disabled={isSubmitting}>
            <Plus className="h-4 w-4 mr-1" />
            {isSubmitting ? "Saving..." : isEdit ? "Save Changes" : "Save Route"}
          </Button>
        </div>
      </form>
    </Form>
  );
}

// ══════════════════════════════════════════════════════════════════
// Page
// ══════════════════════════════════════════════════════════════════
export default function RoutesPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: routes = [], isLoading } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: contractors = [] } = useQuery({ queryKey: ["contractors"], queryFn: fetchContractors });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  const [editing, setEditing] = useState<RouteType | null>(null);
  const [deleting, setDeleting] = useState<RouteType | null>(null);

  const nextCode = useMemo(() => {
    const nums = routes
      .map(r => r.code)
      .filter(c => /^R\d+$/.test(c))
      .map(c => parseInt(c.slice(1)));
    const maxNum = nums.length ? Math.max(...nums) : 0;
    return `R${maxNum + 1}`;
  }, [routes]);

  const createMutation = useMutation({
    mutationFn: createRoute,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["routes"] });
      toast.success("Route saved");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: RouteFormData }) => updateRoute(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["routes"] });
      toast.success("Route updated");
    },
    onError: (err: Error) => toast.error(err.message),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteRoute(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["routes"] });
      toast.success("Route deleted");
      setDeleting(null);
    },
    onError: (err: Error) => toast.error(err.message),
  });

  // ── New Route tab ─────────────────────────────────────────────
  if (tab === "new") {
    return (
      <div>
        <PageHeader title="New Route" description="Add a new delivery route" />
        <Card>
          <CardContent className="pt-6">
            <RouteFormBody
              autoCode={nextCode}
              onSubmit={async data => {
                await createMutation.mutateAsync(data);
              }}
              isSubmitting={createMutation.isPending}
            />
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── List tab ──────────────────────────────────────────────────
  const batchLabelById = new Map(
    batches.map((b: any) => [b.id, b.whichBatch || b.batchCode])
  );

  return (
    <PageShell
      header={
        <>
          <PageHeader title="All Routes" description="View and manage delivery routes" />
        </>
      }
    >
      {isLoading ? (
        <ScrollableTableBody>
          <div className="p-6 space-y-2">
            {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        </ScrollableTableBody>
      ) : (
        <ScrollableTableBody>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left py-2.5 px-3 font-medium">Code</th>
                <th className="text-left py-2.5 px-3 font-medium">Route Name</th>
                <th className="text-left py-2.5 px-3 font-medium">Taluka</th>
                <th className="text-left py-2.5 px-3 font-medium">Batch</th>
                <th className="text-left py-2.5 px-3 font-medium">Contractor</th>
                <th className="text-right py-2.5 px-3 font-medium">Customers</th>
                <th className="text-left py-2.5 px-3 font-medium">Dispatch Time</th>
                <th className="text-left py-2.5 px-3 font-medium">Status</th>
                <th className="text-center py-2.5 px-3 font-medium">Actions</th>
              </tr>
            </thead>
            <tbody>
              {routes.map(r => (
                <tr key={r.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono text-xs">{r.code}</td>
                  <td className="py-2 px-3 font-medium">{r.name}</td>
                  <td className="py-2 px-3 text-xs">{r.taluka}</td>
                  <td className="py-2 px-3 text-xs">
                    {r.primaryBatchId ? (
                      <span className="font-mono px-1.5 py-0.5 rounded bg-secondary text-secondary-foreground">
                        {batchLabelById.get(r.primaryBatchId) ?? "?"}
                      </span>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="py-2 px-3 text-xs">
                    {r.contractorName ||
                      contractors.find((c: any) => c.id === r.contractorId)?.name ||
                      "—"}
                  </td>
                  <td className="py-2 px-3 font-mono text-right">{r.dealerCount ?? 0}</td>
                  <td className="py-2 px-3 text-xs">{r.dispatchTime || "—"}</td>
                  <td className="py-2 px-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        r.status === "Active"
                          ? "bg-success/10 text-success"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="py-2 px-3">
                    <div className="flex items-center justify-center gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        title="Edit"
                        onClick={() => setEditing(r)}
                      >
                        <Edit className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7 text-destructive hover:text-destructive"
                        title="Delete"
                        onClick={() => setDeleting(r)}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
              {routes.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-muted-foreground text-sm">
                    No routes configured yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollableTableBody>
      )}

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Edit Route — {editing?.code}</DialogTitle>
          </DialogHeader>
          {editing && (
            <RouteFormBody
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

      {/* Delete confirm dialog */}
      <Dialog open={!!deleting} onOpenChange={open => !open && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete route {deleting?.code}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will soft-delete <span className="font-medium">{deleting?.name}</span>. Any
            dealers currently assigned to this route will keep their records but their route
            dropdown will no longer show it.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PageShell>
  );
}