// apps/web/src/pages/masters/BatchesPage.tsx
// ════════════════════════════════════════════════════════════════════
// All Batches / New Batch — Marketing v1.4
//
// Changes:
//   • Edit button on each batch card is functional (opens edit dialog)
//   • Delete button deletes the batch (with confirm)
//   • Each route row in a batch has a Remove button (detaches from batch)
//   • Edit form includes new `dispatchTime` field (HH:MM, optional)
// ════════════════════════════════════════════════════════════════════

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Edit, Plus, Trash2, X } from "lucide-react";
import {
  fetchBatches,
  fetchRoutes,
  createBatch,
  updateBatch,
  deleteBatch,
  removeRouteFromBatch,
  type Batch,
} from "@/services/api";
import { batchSchema, type BatchFormData } from "@/lib/validations";

interface Props {
  tab?: "list" | "new";
}

const BATCH_WHICH_OPTIONS = ["Morning", "Afternoon", "Evening", "Night"] as const;

export default function BatchesPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });

  const [editing, setEditing] = useState<Batch | null>(null);
  const [deleting, setDeleting] = useState<Batch | null>(null);

  const createMutation = useMutation({
    mutationFn: createBatch,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["batches"] });
      toast.success("Batch saved");
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: BatchFormData }) => updateBatch(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["batches"] });
      toast.success("Batch updated");
    },
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

  // ── New Batch tab ─────────────────────────────────────────────
  const createForm = useForm<BatchFormData>({
    resolver: zodResolver(batchSchema),
    defaultValues: {
      batchCode: "",
      whichBatch: "Morning",
      timing: "",
      dispatchTime: "",
    },
  });

  if (tab === "new") {
    return (
      <div>
        <PageHeader title="New Batch" description="Add a new distribution batch" />
        <Card>
          <CardContent className="pt-6">
            <Form {...createForm}>
              <form
                onSubmit={createForm.handleSubmit(data => {
                  createMutation.mutate(data, {
                    onSuccess: () => createForm.reset(),
                  });
                })}
                className="space-y-4"
              >
                <BatchFormFields control={createForm.control} />
                <Button type="submit" disabled={createMutation.isPending}>
                  <Plus className="h-4 w-4 mr-1" />
                  {createMutation.isPending ? "Saving..." : "Save Batch"}
                </Button>
              </form>
            </Form>
          </CardContent>
        </Card>
      </div>
    );
  }

  // ── List tab ──────────────────────────────────────────────────
  return (
    <div>
      <PageHeader title="All Batches" description="Distribution batch timings and assigned routes" />
      <div className="space-y-4">
        {batches.length === 0 && (
          <Card>
            <CardContent className="p-8 text-center text-muted-foreground text-sm">
              No batches configured yet.
            </CardContent>
          </Card>
        )}
        {batches.map(batch => (
          <Card key={batch.id}>
            <CardContent className="pt-6">
              <div className="flex items-center justify-between mb-4">
                <div>
                  <div className="flex items-center gap-2">
                    <h3 className="font-semibold">{batch.whichBatch} Batch</h3>
                    <span className="text-xs font-mono bg-muted px-2 py-0.5 rounded">
                      {batch.batchCode}
                    </span>
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        batch.status === "Active"
                          ? "bg-success/10 text-success"
                          : "bg-muted text-muted-foreground"
                      }`}
                    >
                      {batch.status}
                    </span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-0.5">
                    {batch.whichBatch} — {batch.timing}
                    {batch.dispatchTime && (
                      <>
                        {" · "}
                        <span className="text-xs">
                          Dispatch at <span className="font-mono">{batch.dispatchTime}</span>
                        </span>
                      </>
                    )}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7"
                    title="Edit"
                    onClick={() => setEditing(batch)}
                  >
                    <Edit className="h-3.5 w-3.5" />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 text-destructive hover:text-destructive"
                    title="Delete"
                    onClick={() => setDeleting(batch)}
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>

              <p className="text-xs text-muted-foreground font-medium mb-2">
                Routes in this batch ({batch.routeIds.length}):
              </p>
              {batch.routeIds.length === 0 ? (
                <p className="text-xs text-muted-foreground italic pl-3">No routes assigned.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-muted-foreground text-xs">
                      <th className="text-left py-1 px-3 font-medium">Code</th>
                      <th className="text-left py-1 px-3 font-medium">Route Name</th>
                      <th className="text-left py-1 px-3 font-medium">Dispatch Time</th>
                      <th className="text-left py-1 px-3 font-medium">Status</th>
                      <th className="text-right py-1 px-3 font-medium">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {batch.routeIds.map(rid => {
                      const r = routes.find((rt: any) => rt.id === rid);
                      if (!r) return null;
                      return (
                        <tr key={rid} className="border-t hover:bg-muted/20">
                          <td className="py-1.5 px-3 font-mono text-xs">{r.code}</td>
                          <td className="py-1.5 px-3 font-medium">{r.name}</td>
                          <td className="py-1.5 px-3 text-xs">{r.dispatchTime || "—"}</td>
                          <td className="py-1.5 px-3">
                            <span
                              className={`text-xs px-1.5 py-0.5 rounded ${
                                r.status === "Active"
                                  ? "bg-success/10 text-success"
                                  : "bg-muted text-muted-foreground"
                              }`}
                            >
                              {r.status}
                            </span>
                          </td>
                          <td className="py-1.5 px-3 text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              className="h-7 text-destructive hover:text-destructive"
                              onClick={() =>
                                removeRouteMutation.mutate({ batchId: batch.id, routeId: rid })
                              }
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
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Batch — {editing?.batchCode}</DialogTitle>
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

      {/* Delete confirm dialog */}
      <Dialog open={!!deleting} onOpenChange={open => !open && setDeleting(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Delete batch {deleting?.batchCode}?</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            This will soft-delete the <span className="font-medium">{deleting?.whichBatch}</span>{" "}
            batch. Routes currently in this batch will be detached but not deleted.
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
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Shared form fields (create + edit)
// ══════════════════════════════════════════════════════════════════
function BatchFormFields({ control, isEdit = false }: { control: any; isEdit?: boolean }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <FormField
        control={control}
        name="batchCode"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Batch Code</FormLabel>
            <FormControl>
              <Input
                placeholder="e.g. BT04"
                disabled={isEdit}
                className={isEdit ? "bg-muted" : ""}
                {...field}
              />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="whichBatch"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Which Batch</FormLabel>
            <FormControl>
              <Select onValueChange={field.onChange} value={field.value ?? "Morning"}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {BATCH_WHICH_OPTIONS.map(w => (
                    <SelectItem key={w} value={w}>{w}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="timing"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Timing (display text)</FormLabel>
            <FormControl>
              <Input placeholder="e.g. 5:00 AM - 8:00 AM" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />

      <FormField
        control={control}
        name="dispatchTime"
        render={({ field }) => (
          <FormItem>
            <FormLabel>Dispatch Time</FormLabel>
            <FormControl>
              <Input type="time" {...field} />
            </FormControl>
            <FormMessage />
          </FormItem>
        )}
      />
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Edit form (uses shared fields)
// ══════════════════════════════════════════════════════════════════
function BatchEditForm({
  initialData,
  onSubmit,
  isSubmitting,
  onCancel,
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
      dispatchTime: initialData.dispatchTime ?? "",
    },
  });

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(data => onSubmit(data))} className="space-y-4">
        <BatchFormFields control={form.control} isEdit />
        <div className="flex gap-2 justify-end">
          {onCancel && <Button type="button" variant="outline" onClick={onCancel}>Cancel</Button>}
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </form>
    </Form>
  );
}