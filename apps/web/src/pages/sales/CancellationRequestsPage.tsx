// ════════════════════════════════════════════════════════════════════
// Cancellation Requests — approve / reject pending cancellations
// Route preserved: /sales/cancellations
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, Field, EmptyState, StatusPill, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Check, X } from "lucide-react";
import { fetchCancellationRequests, approveCancellation, rejectCancellation } from "@/services/api";

const STATUS_OPTS: F9Option[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
];

export default function CancellationRequestsPage() {
  const qc = useQueryClient();
  const [status, setStatus] = useState<string | null>("pending");
  const [rejectFor, setRejectFor] = useState<string | null>(null);
  const [rejectNote, setRejectNote] = useState("");

  const { data: requests = [], isLoading } = useQuery({
    queryKey: ["cancellation-requests", { status }],
    queryFn: () => fetchCancellationRequests(),
  });

  const approveMut = useMutation({
    mutationFn: (id: string) => approveCancellation(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cancellation-requests"] });
      qc.invalidateQueries({ queryKey: ["indents"] });
      toast.success("Cancellation approved");
    },
    onError: (e: any) => toast.error(e?.message || "Approve failed"),
  });

  const rejectMut = useMutation({
    mutationFn: ({ id, note }: { id: string; note: string }) =>
      rejectCancellation(id, note),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["cancellation-requests"] });
      toast.success("Cancellation rejected");
      setRejectFor(null);
      setRejectNote("");
    },
    onError: (e: any) => toast.error(e?.message || "Reject failed"),
  });

  const filtered = useMemo(() => requests, [requests]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Cancellation Requests" subtitle="Review dealer-submitted cancellation requests" />
      <FilterBar>
        <Field label="Status">
          <F9SearchSelect value={status} onChange={setStatus} options={STATUS_OPTS} allowAll className="w-44" />
        </Field>
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState title="No cancellation requests." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>Date</th>
                  <th style={{ width: 130 }}>Indent #</th>
                  <th>Dealer</th>
                  <th>Route</th>
                  <th>Items</th>
                  <th className="num" style={{ width: 130, textAlign: "right" }}>Total ₹</th>
                  <th>Reason</th>
                  <th style={{ width: 100 }}>Status</th>
                  <th style={{ width: 200, textAlign: "center" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((r: any) => (
                  <tr key={r.id}>
                    <td className="text-[12.5px]">{fmtDate(r.created_at ?? r.requestTime ?? r.date)}</td>
                    <td className="font-mono text-[12px]">
                      #HMU-{String(r.order_id ?? r.orderId ?? "").slice(-4).toUpperCase() || "—"}
                    </td>
                    <td className="font-medium">{r.dealer_name ?? r.customerName ?? "—"}</td>
                    <td>{r.route_code ?? r.route_name ?? "—"}</td>
                    <td>
                      {(r.items ?? []).length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          {(r.items ?? []).map((it: any, k: number) => (
                            <span key={k} className="text-[12px]">
                              <span className="num font-medium">{it.quantity ?? it.qty}×</span>{" "}
                              {it.product_name ?? it.productName}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {fmtINR(parseFloat(String(r.grand_total ?? r.totalAmount ?? 0)) || 0)}
                    </td>
                    <td className="text-[12.5px] text-muted-foreground">{r.reason ?? "—"}</td>
                    <td><StatusPill status={r.status} /></td>
                    <td style={{ textAlign: "center" }}>
                      {(r.status === "pending" || r.status === "Pending") ? (
                        <div className="flex items-center justify-center gap-1.5">
                          <Button
                            size="sm"
                            className="h-7 px-2.5 bg-success hover:bg-success/90 text-white"
                            onClick={() => approveMut.mutate(r.id)}
                            disabled={approveMut.isPending}
                          >
                            <Check className="h-3.5 w-3.5 mr-1" /> Approve
                          </Button>
                          <Button
                            size="sm"
                            variant="outline"
                            className="h-7 px-2.5 text-destructive"
                            onClick={() => { setRejectFor(r.id); setRejectNote(""); }}
                          >
                            <X className="h-3.5 w-3.5 mr-1" /> Reject
                          </Button>
                        </div>
                      ) : (
                        <span className="text-muted-foreground text-[12.5px]">—</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Reject Reason Dialog */}
      <Dialog open={!!rejectFor} onOpenChange={o => !o && setRejectFor(null)}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">Reject Cancellation</DialogTitle>
          </DialogHeader>
          <div className="py-2">
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
              Reason for rejection <span className="text-destructive">*</span>
            </label>
            <Input
              className="erp-input"
              value={rejectNote}
              onChange={e => setRejectNote(e.target.value)}
              placeholder="Required"
            />
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={() => setRejectFor(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8"
              disabled={!rejectNote.trim() || rejectMut.isPending}
              onClick={() => rejectFor && rejectMut.mutate({ id: rejectFor, note: rejectNote.trim() })}
            >
              {rejectMut.isPending ? "Rejecting…" : "Reject"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}