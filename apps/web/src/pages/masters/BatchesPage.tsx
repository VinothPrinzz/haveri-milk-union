// ════════════════════════════════════════════════════════════════════
// All Batches / New Batch — ERP refactor
// Routes preserved: /masters/batches + /masters/batches/new
// All mutations (create/update/delete/removeRouteFromBatch) preserved.
// ════════════════════════════════════════════════════════════════════
import { useState } from "react";
import { useSaveShortcut } from "@/lib/useKeyboardNav";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import PageHeader, {
  FormSection,
  FormFooter,
  StatusPill,
  EmptyState,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Form, FormField, FormItem, FormLabel, FormControl, FormMessage,
} from "@/components/ui/form";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { Edit, Plus, Trash2, X } from "lucide-react";
import {
  fetchBatches, fetchRoutes, createBatch, updateBatch, deleteBatch,
  removeRouteFromBatch, type Batch,
} from "@/services/api";
import { batchSchema, type BatchFormData } from "@/lib/validations";

interface Props { tab?: "list" | "new"; }

const BATCH_WHICH_OPTIONS = ["Morning", "Afternoon", "Evening", "Night"] as const;

export default function BatchesPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });

  const [editing, setEditing] = useState<Batch | null>(null);
  const [deleting, setDeleting] = useState<Batch | null>(null);

  const createMutation = useMutation({
    mutationFn: createBatch,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["batches"] }); toast.success("Batch saved"); },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: BatchFormData }) => updateBatch(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["batches"] }); toast.success("Batch updated"); },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteBatch(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["batches"] });
      qc.invalidateQueries({ queryKey: ["routes"] });
      toast.success("Batch deleted");
      setDeleting(null);
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const removeRouteMutation = useMutation({
    mutationFn: ({ batchId, routeId }: { batchId: string; routeId: string }) =>
      removeRouteFromBatch(batchId, routeId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["batches"] });
      qc.invalidateQueries({ queryKey: ["routes"] });
      toast.success("Route removed from batch");
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const createForm = useForm<BatchFormData>({
    resolver: zodResolver(batchSchema),
    defaultValues: { batchCode: "", whichBatch: "Morning", timing: "" },
  });

  const submitNewBatch = createForm.handleSubmit(data => {
    createMutation.mutate(data, { onSuccess: () => createForm.reset() });
  });
  useSaveShortcut(() => submitNewBatch(), tab === "new" && !createMutation.isPending);

  if (tab === "new") {
    return (
      <div>
        <PageHeader title="New Batch" subtitle="Add a new distribution batch" />
        <div className="p-4">
          <Form {...createForm}>
            <form onSubmit={submitNewBatch}>
              <FormSection title="Batch Details" cols={2}>
                <BatchFormFields control={createForm.control} />
              </FormSection>
              <FormFooter>
                <Button type="submit" size="sm" className="h-8" disabled={createMutation.isPending}>
                  <Plus className="h-3.5 w-3.5 mr-1" />
                  {createMutation.isPending ? "Saving…" : "Save Batch"}
                </Button>
              </FormFooter>
            </form>
          </Form>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="All Batches"
        subtitle="Distribution batch timings and assigned routes"
        actions={
          <Button asChild size="sm" className="h-8">
            <a href="/masters/batches/new"><Plus className="h-3.5 w-3.5 mr-1" /> New Batch</a>
          </Button>
        }
      />
      <div className="p-3 space-y-3">
        {batches.length === 0 && (
          <div className="erp-panel">
            <EmptyState title="No batches configured yet." hint="Create your first batch with the New button above." />
          </div>
        )}
        {batches.map(batch => (
          <div key={batch.id} className="erp-panel p-3">
            <div className="flex items-center justify-between mb-3 pb-2 border-b border-border">
              <div>
                <div className="flex items-center gap-2">
                  <h3 className="text-[14.5px] font-semibold">{batch.whichBatch} Batch</h3>
                  <span className="text-[11.5px] font-mono bg-muted text-muted-foreground px-1.5 py-0.5 rounded">
                    {batch.batchCode}
                  </span>
                  <StatusPill status={batch.status === "Active" ? "active" : "draft"} />
                </div>
                <p className="text-[12.5px] text-muted-foreground mt-0.5">
                  {batch.whichBatch} — {batch.timing}
                </p>
              </div>
              <div className="flex items-center gap-1">
                <Button variant="ghost" size="icon" className="h-7 w-7" title="Edit" onClick={() => setEditing(batch)}>
                  <Edit className="h-3.5 w-3.5" />
                </Button>
                <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive hover:text-destructive" title="Delete" onClick={() => setDeleting(batch)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>

            <p className="text-[11.5px] uppercase tracking-wide text-muted-foreground font-medium mb-1.5">
              Routes in this batch ({batch.routeIds.length})
            </p>
            {batch.routeIds.length === 0 ? (
              <p className="text-[12.5px] text-muted-foreground italic pl-3">No routes assigned.</p>
            ) : (
              <table className="erp-table">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>Code</th>
                    <th>Route Name</th>
                    <th style={{ width: 90 }}>Status</th>
                    <th style={{ width: 110, textAlign: "right" }}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {batch.routeIds.map(rid => {
                    const r = routes.find((rt: any) => rt.id === rid);
                    if (!r) return null;
                    return (
                      <tr key={rid}>
                        <td className="font-mono">{r.code}</td>
                        <td className="font-medium">{r.name}</td>
                        <td><StatusPill status={r.status === "Active" ? "active" : "draft"} /></td>
                        <td style={{ textAlign: "right" }}>
                          <Button
                            variant="ghost" size="sm"
                            className="h-7 text-destructive hover:text-destructive"
                            onClick={() => removeRouteMutation.mutate({ batchId: batch.id, routeId: rid })}
                            disabled={removeRouteMutation.isPending}
                            title="Remove route from this batch"
                          >
                            <X className="h-3.5 w-3.5 mr-1" /> Remove
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        ))}
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="max-w-2xl rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">
              Edit Batch — <span className="font-mono">{editing?.batchCode}</span>
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <BatchEditForm
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

      {/* Delete confirm */}
      <Dialog open={!!deleting} onOpenChange={open => !open && setDeleting(null)}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">
              Delete batch <span className="font-mono">{deleting?.batchCode}</span>?
            </DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">
            This will soft-delete the <span className="font-medium text-foreground">{deleting?.whichBatch}</span> batch.
            Routes currently in this batch will be detached but not deleted.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button variant="destructive" size="sm" className="h-8"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BatchFormFields({ control, isEdit = false }: { control: any; isEdit?: boolean }) {
  return (
    <>
      <FormField control={control} name="batchCode" render={({ field }) => (
        <FormItem>
          <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">Batch Code</FormLabel>
          <FormControl>
            <Input placeholder="e.g. BT04" disabled={isEdit} className={isEdit ? "bg-muted" : ""} {...field} />
          </FormControl>
          <FormMessage className="text-[11.5px]" />
        </FormItem>
      )}/>
      <FormField control={control} name="whichBatch" render={({ field }) => (
        <FormItem>
          <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">Which Batch</FormLabel>
          <FormControl>
            <Select onValueChange={field.onChange} value={field.value ?? "Morning"}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {BATCH_WHICH_OPTIONS.map(w => <SelectItem key={w} value={w}>{w}</SelectItem>)}
              </SelectContent>
            </Select>
          </FormControl>
          <FormMessage className="text-[11.5px]" />
        </FormItem>
      )}/>
      <FormField control={control} name="timing" render={({ field }) => (
        <FormItem>
          <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">Timing (display)</FormLabel>
          <FormControl><Input placeholder="e.g. 5:00 AM - 8:00 AM" {...field} /></FormControl>
          <FormMessage className="text-[11.5px]" />
        </FormItem>
      )}/>
    </>
  );
}

function BatchEditForm({
  initialData, onSubmit, isSubmitting, onCancel,
}: {
  initialData: Batch;
  onSubmit: (data: BatchFormData) => void | Promise<void>;
  isSubmitting?: boolean;
  onCancel?: () => void;
}) {
  const form = useForm<BatchFormData>({
    resolver: zodResolver(batchSchema),
    defaultValues: {
      batchCode: initialData.batchCode,
      whichBatch: initialData.whichBatch as any,
      timing: initialData.timing ?? "",
    },
  });

  const submitBatch = form.handleSubmit(data => onSubmit(data));
  useSaveShortcut(() => submitBatch(), !isSubmitting);

  return (
    <Form {...form}>
      <form onSubmit={submitBatch}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <BatchFormFields control={form.control} isEdit />
        </div>
        <div className="mt-4 flex gap-2 justify-end">
          {onCancel && <Button type="button" variant="outline" size="sm" className="h-8" onClick={onCancel}>Cancel</Button>}
          <Button type="submit" size="sm" className="h-8" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : "Save Changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}