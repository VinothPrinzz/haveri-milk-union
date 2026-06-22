// ════════════════════════════════════════════════════════════════════
// All Indents — list with status / route / date filters
// Route preserved: /sales/all-indents
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, Field, EmptyState, StatusPill, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Printer, X, Ban } from "lucide-react";
import { fetchIndents, fetchRoutes, cancelIndent, type CancelIndentResult } from "@/services/api";

const STATUS_OPTS: F9Option[] = [
  { value: "confirmed",  label: "Confirmed" },
  { value: "dispatched", label: "Dispatched" },
  { value: "delivered",  label: "Delivered" },
  { value: "cancelled",  label: "Cancelled" },
];

const formatIndentId = (id: string) => id ? `#HMU-${String(id).slice(-4).toUpperCase()}` : "—";

// One-line description of what the auto-refund did, for the success toast.
function refundLine(r: CancelIndentResult): string {
  const amt = fmtINR(r.refund.amount || 0);
  switch (r.refund.method) {
    case "wallet":   return `Refunded ${amt} to the dealer's wallet.`;
    case "credit":   return `Reversed ${amt} on the dealer's credit ledger.`;
    case "razorpay": return `Razorpay refund of ${amt} initiated (${r.refund.status ?? "pending"}).`;
    default:         return `No auto-refund applies for a ${r.paymentMode || "—"} order.`;
  }
}

export default function AllIndentsPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<string | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [q, setQ] = useState("");

  // Cancel dialog: the indent being cancelled + the operator's reason.
  const [cancelFor, setCancelFor] = useState<any | null>(null);
  const [cancelReason, setCancelReason] = useState("");

  const cancelMut = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => cancelIndent(id, reason),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["indents"] });
      toast.success("Indent cancelled", { description: refundLine(res) });
      setCancelFor(null);
      setCancelReason("");
    },
    onError: (e: any) => toast.error(e?.message || "Cancellation failed"),
  });

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });

  const { data: indents = [], isLoading } = useQuery({
    queryKey: ["indents", { from, to, status, routeId }],
    queryFn: () => fetchIndents({
      from, to,
      status: (status ?? undefined) as any,
      routeId: routeId ?? undefined,
    }),
  });

  const routeOpts: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return indents;
    return indents.filter((i: any) =>
      (i.code ?? "").toLowerCase().includes(s) ||
      (i.customerName ?? "").toLowerCase().includes(s)
    );
  }, [indents, q]);

  const grand = filtered.reduce(
    (s: number, i: any) => s + (parseFloat(String(i.grand_total ?? i.total ?? 0)) || 0),
    0
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="All Indents"
        subtitle="Search and review every indent across statuses"
        actions={
          <Button size="sm" variant="outline" className="h-8" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5 mr-1" /> Print
          </Button>
        }
      />

      <FilterBar>
        <Field label="From"><Input type="date" className="erp-input w-36" value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" className="erp-input w-36" value={to} onChange={e => setTo(e.target.value)} /></Field>
        <Field label="Status"><F9SearchSelect value={status} onChange={setStatus} options={STATUS_OPTS} allowAll className="w-44" /></Field>
        <Field label="Route"><F9SearchSelect value={routeId} onChange={setRouteId} options={routeOpts} allowAll className="w-56" /></Field>
        <Field label="Search"><Input className="erp-input w-56" placeholder="indent # / customer" value={q} onChange={e => setQ(e.target.value)} /></Field>
        {(status || routeId || q) && (
          <div className="flex items-end">
            <Button size="sm" variant="outline" className="h-8" onClick={() => { setStatus(null); setRouteId(null); setQ(""); }}>
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          </div>
        )}
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          <div className="print-document">
            {isLoading ? (
              <div className="p-3 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState title="No indents match this filter." />
            ) : (
              <table className="erp-table">
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>Indent #</th>
                    <th style={{ width: 110 }}>Date</th>
                    <th>Customer</th>
                    <th>Route</th>
                    <th style={{ width: "30%" }}>Items</th>
                    <th className="num" style={{ width: 130, textAlign: "right" }}>Total ₹</th>
                    <th style={{ width: 110 }}>Status</th>
                    <th style={{ width: 170, textAlign: "center" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((i: any) => (
                    <tr key={i.id}>
                      <td className="font-mono text-[12px]">{formatIndentId(i.id)}</td>
                      <td className="text-[12.5px]">{fmtDate(i.rawDate ?? i.date)}</td>
                      <td className="font-medium">{i.dealer_name ?? i.customerName ?? i.customerId}</td>
                      <td>{i.route_code ?? i.route_name ?? i.routeName ?? i.routeId ?? "—"}</td>
                      <td>
                        {(i.items ?? i.lines ?? []).length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {(i.items ?? i.lines ?? []).map((it: any, k: number) => (
                              <span key={k} className="text-[12px]">
                                <span className="num font-medium">{it.quantity ?? it.qty}×</span>{" "}
                                {it.product_name ?? it.productName ?? it.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(parseFloat(String(i.grand_total ?? i.total ?? 0)) || 0)}</td>
                      <td><StatusPill status={i.status} /></td>
                      <td style={{ textAlign: "center" }}>
                        <div className="flex items-center justify-center gap-1.5">
                          <Button
                            size="sm"
                            className="h-7 px-2.5 text-[12px]"
                            onClick={() => navigate(`/sales/direct-sales/modify?indentId=${i.id}&type=order`)}
                          >
                            Update
                          </Button>
                          {i.status === "Confirmed" && i.windowOpen && (
                            <Button
                              size="sm"
                              variant="outline"
                              className="h-7 px-2.5 text-[12px] text-destructive"
                              onClick={() => { setCancelFor(i); setCancelReason(""); }}
                            >
                              <Ban className="h-3.5 w-3.5 mr-1" /> Cancel
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/40">
                    <td colSpan={5} className="text-right uppercase text-[12.5px] font-semibold tracking-wide">Grand Total</td>
                    <td className="num font-bold text-[14px]" style={{ textAlign: "right" }}>{fmtINR(grand)}</td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      </div>

      {/* Cancel Indent dialog — reason + auto-refund by payment mode */}
      <Dialog open={!!cancelFor} onOpenChange={o => { if (!o) { setCancelFor(null); setCancelReason(""); } }}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">Cancel Indent</DialogTitle>
          </DialogHeader>
          {cancelFor && (
            <div className="py-2 space-y-3">
              <div className="text-[12.5px] text-muted-foreground space-y-1">
                <div>
                  <span className="font-mono">{formatIndentId(cancelFor.id)}</span>
                  {" · "}
                  <span className="font-medium text-foreground">
                    {cancelFor.dealer_name ?? cancelFor.customerName ?? "—"}
                  </span>
                </div>
                <div>
                  Total <span className="num font-medium text-foreground">{fmtINR(parseFloat(String(cancelFor.grand_total ?? cancelFor.total ?? 0)) || 0)}</span>
                  {" · "}
                  Payment mode <span className="font-medium text-foreground uppercase">{cancelFor.paymentMode || "—"}</span>
                </div>
                <div className="text-[11.5px]">
                  Cancelling restores stock and auto-refunds the dealer per the
                  payment mode (wallet → wallet, credit → ledger, UPI → Razorpay).
                </div>
              </div>
              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
                  Reason <span className="text-destructive">*</span>
                </label>
                <Input
                  className="erp-input"
                  value={cancelReason}
                  onChange={e => setCancelReason(e.target.value)}
                  placeholder="Why is this indent being cancelled?"
                  autoFocus
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={() => { setCancelFor(null); setCancelReason(""); }}>
              Keep Indent
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8"
              disabled={!cancelReason.trim() || cancelMut.isPending}
              onClick={() => cancelFor && cancelMut.mutate({ id: cancelFor.id, reason: cancelReason.trim() })}
            >
              {cancelMut.isPending ? "Cancelling…" : "Cancel Indent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}