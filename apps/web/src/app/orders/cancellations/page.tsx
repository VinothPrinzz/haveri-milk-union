"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, cn } from "@/lib/utils";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Check, X, Clock } from "lucide-react";

export default function CancellationRequestsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["cancellations"], queryFn: () => api.get("/api/v1/cancellations", { page: 1, limit: 50 }) });
  const cancellations = data?.data ?? [];
  const pendingCount = cancellations.filter((c: any) => c.status === "pending").length;
  const [rejectNote, setRejectNote] = useState<Record<string, string>>({});

  const approveMut = useMutation({ mutationFn: (id: string) => api.patch(`/api/v1/cancellations/${id}/approve`), onSuccess: () => qc.invalidateQueries({ queryKey: ["cancellations"] }) });
  const rejectMut = useMutation({ mutationFn: ({ id, reviewNote }: { id: string; reviewNote: string }) => api.patch(`/api/v1/cancellations/${id}/reject`, { reviewNote }), onSuccess: () => qc.invalidateQueries({ queryKey: ["cancellations"] }) });

  return (
    <>
      <PageHeader icon="❌" title="Cancellation Requests" subtitle="Review and process indent cancellation requests"
        actions={pendingCount > 0 ? <Badge variant="pending" className="text-[11px] px-3 py-1">{pendingCount} Pending</Badge> : undefined} />
      <div className="space-y-3">
        {cancellations.map((c: any) => {
          const isPending = c.status === "pending";
          const itemStr = (c.items ?? []).map((i: any) => `${i.product_name} x${i.quantity}`).join(", ");
          return (
            <div key={c.id} className={cn("bg-card rounded-[10px] border shadow-card p-4", isPending ? "border-warning/30" : "border-border", !isPending && "opacity-60")}>
              <div className="flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="flex items-center gap-2 mb-1"><span className="font-display text-[13px] font-bold text-fg">#{c.order_id?.slice(0, 8)}</span><Badge variant={c.status}>{c.status}</Badge></div>
                  <div className="text-[11px] text-muted-fg font-medium space-y-0.5"><div>{c.dealer_name} · {c.zone_name}</div>{itemStr && <div>{itemStr}</div>}<div>Reason: {c.reason}</div>
                    <div className="flex items-center gap-1.5 mt-1"><Clock className="h-3 w-3" />{new Date(c.created_at).toLocaleString("en-IN")} · <strong className="text-fg">{formatCurrency(c.grand_total || 0)}</strong></div>
                    {c.review_note && <div className="mt-1 text-danger">Rejection: {c.review_note}</div>}
                  </div>
                </div>
                {isPending && (
                  <div className="flex flex-col gap-2 shrink-0">
                    <Button size="sm" className="text-success border-success/30 bg-success/5 hover:bg-success/10" variant="outline" disabled={approveMut.isPending} onClick={() => approveMut.mutate(c.id)}><Check className="h-3.5 w-3.5" /> Approve</Button>
                    <div className="flex gap-1"><input value={rejectNote[c.id] ?? ""} onChange={e => setRejectNote(p => ({ ...p, [c.id]: e.target.value }))} placeholder="Reason..." className="h-8 bg-background border border-border rounded-lg px-2 text-[10px] w-32 outline-none" />
                    <Button size="sm" className="text-danger border-danger/30 bg-danger/5 hover:bg-danger/10" variant="outline" disabled={rejectMut.isPending || !rejectNote[c.id]} onClick={() => rejectMut.mutate({ id: c.id, reviewNote: rejectNote[c.id]! })}><X className="h-3.5 w-3.5" /></Button></div>
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {cancellations.length === 0 && <div className="text-center py-12 text-muted-fg text-sm">No cancellation requests</div>}
      </div>
    </>
  );
}
