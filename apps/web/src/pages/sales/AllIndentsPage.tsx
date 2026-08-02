// ════════════════════════════════════════════════════════════════════
// All Indents — list with status / route / date filters
// Route preserved: /sales/all-indents
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from "react";
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
import { fetchIndentsPage, fetchRoutes, cancelIndent, resolveIndentInvoice, type CancelIndentResult } from "@/services/api";

const STATUS_OPTS: F9Option[] = [
  { value: "draft",            label: "Draft" },
  { value: "payment_required", label: "Payment Required" },
  { value: "confirmed",        label: "Confirmed" },
  { value: "dispatched",       label: "Dispatched" },
  { value: "delivered",        label: "Delivered" },
  { value: "cancelled",        label: "Cancelled" },
];

// Payment column label. "Credit" is reserved for credit institutions
// (customer_type 'Credit Inst-*'), who buy on a monthly account. Every other
// dealer settles from their prepaid available balance → "Wallet". A genuinely
// online-paid order (payment_mode 'upi') is shown as "UPI" rather than folded
// into either bucket.
const isCreditInstitution = (t?: string) => !!t && t.startsWith("Credit Inst");
const paymentLabel = (i: any): string => {
  if (isCreditInstitution(i.customerType)) return "Credit";
  const mode = String(i.paymentMode ?? "").toLowerCase();
  if (mode === "upi") return "UPI";
  return "Wallet";
};

const formatIndentId = (id: string) => id ? `#HMU-${String(id).slice(-4).toUpperCase()}` : "—";

// One-line description of what the refund did, for the success toast.
function refundLine(r: CancelIndentResult): string {
  const amt = fmtINR(r.refund.amount || 0);
  switch (r.refund.method) {
    case "wallet":   return `Refunded ${amt} to the dealer's wallet.`;
    case "credit":   return `Credited ${amt} to the dealer's available balance.`;
    case "razorpay": return `Razorpay bank refund of ${amt} initiated (${r.refund.status ?? "pending"}).`;
    default:         return `No refund applied for a ${r.paymentMode || "—"} order.`;
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

  // Server-side pagination + search. `q` is debounced into `debouncedQ` so we
  // hit the API once the operator pauses typing, and search spans the WHOLE
  // dataset (every page), not just the rows already loaded.
  const PAGE_SIZE = 50;
  const [page, setPage] = useState(1);
  const [debouncedQ, setDebouncedQ] = useState("");
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300);
    return () => clearTimeout(t);
  }, [q]);

  // Any filter/search change returns to the first page.
  useEffect(() => { setPage(1); }, [from, to, status, routeId, debouncedQ]);

  // The indent # is shown as "#HMU-XXXX" (last 4 of the order UUID). Strip that
  // display prefix so a paste of the visible id still matches server-side.
  const searchParam = debouncedQ.replace(/^#?\s*hmu-\s*/i, "").trim();

  // Cancel dialog: the indent being cancelled + the operator's reason +
  // where the refund goes ("balance" store credit or "razorpay" bank refund).
  const [cancelFor, setCancelFor] = useState<any | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [refundMethod, setRefundMethod] = useState<"balance" | "razorpay">("balance");

  // Bank (Razorpay) refunds only apply to orders paid online.
  const bankPossible = cancelFor?.paymentMode === "upi";

  // Open the cancel dialog with a sensible default refund target.
  const openCancel = (i: any) => {
    setCancelFor(i);
    setCancelReason("");
    setRefundMethod(i.paymentMode === "upi" ? "razorpay" : "balance");
  };
  const closeCancel = () => {
    setCancelFor(null);
    setCancelReason("");
  };

  const cancelMut = useMutation({
    mutationFn: ({ id, reason, refundMethod }: { id: string; reason: string; refundMethod: "balance" | "razorpay" }) =>
      cancelIndent(id, reason, refundMethod),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["indents"] });
      toast.success("Indent cancelled", { description: refundLine(res) });
      closeCancel();
    },
    onError: (e: any) => toast.error(e?.message || "Cancellation failed"),
  });

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });

  const { data, isLoading } = useQuery({
    queryKey: ["indents", { from, to, status, routeId, search: searchParam, page }],
    queryFn: () => fetchIndentsPage({
      from, to,
      status: (status ?? undefined) as any,
      routeId: routeId ?? undefined,
      search: searchParam || undefined,
      page,
      limit: PAGE_SIZE,
    }),
  });

  const rows = data?.rows ?? [];
  const total = data?.total ?? 0;
  const totalPages = data?.totalPages ?? 1;

  const routeOpts: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );

  // Sum of the CURRENT page's rows (pagination means the list no longer holds
  // every indent at once, so this is a page subtotal, not an all-time total).
  const grand = rows.reduce(
    (s: number, i: any) => s + (parseFloat(String(i.grand_total ?? i.total ?? 0)) || 0),
    0
  );

  // Open the tax invoice for an indent. Uses the invoice id already on the row
  // when present; otherwise resolves (and generates on demand) via the API.
  const openInvoice = async (i: any) => {
    if (i.invoiceId) { navigate(`/sales/invoices/${i.invoiceId}`); return; }
    try {
      setResolvingId(i.id);
      const { invoiceId } = await resolveIndentInvoice(i.id);
      if (invoiceId) navigate(`/sales/invoices/${invoiceId}`);
      else toast.error("Invoice could not be generated.");
    } catch (e: any) {
      toast.error(e?.message || "Could not open invoice");
    } finally {
      setResolvingId(null);
    }
  };

  // A placed order (or one that already has an invoice row) can show an invoice.
  const canHaveInvoice = (i: any) =>
    !!i.invoiceId || ["confirmed", "dispatched", "delivered"].includes(i.rawStatus);

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
            ) : rows.length === 0 ? (
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
                    <th style={{ width: 120 }}>Payment</th>
                    <th style={{ width: 110 }}>Status</th>
                    <th style={{ width: 170, textAlign: "center" }}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((i: any) => (
                    <tr key={i.id}>
                      <td className="font-mono text-[12px]">
                        {canHaveInvoice(i) ? (
                          <button
                            type="button"
                            onClick={() => openInvoice(i)}
                            disabled={resolvingId === i.id}
                            title={i.invoiceNumber ? `Open invoice ${i.invoiceNumber}` : "Open tax invoice"}
                            className="text-primary hover:underline underline-offset-2 disabled:opacity-60 disabled:cursor-wait"
                          >
                            {resolvingId === i.id ? "Opening…" : formatIndentId(i.id)}
                          </button>
                        ) : (
                          <span className="text-muted-foreground" title="No invoice — indent not confirmed">
                            {formatIndentId(i.id)}
                          </span>
                        )}
                      </td>
                      <td className="text-[12.5px]">{fmtDate(i.rawDate ?? i.date)}</td>
                      <td className="font-medium">
                        {i.dealer_name ?? i.customerName ?? i.customerId}
                        {i.partyType === "employee" && (
                          <span className="ml-1.5 align-middle rounded-sm border px-1 py-px text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
                            Employee Subsidy
                          </span>
                        )}
                      </td>
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
                      <td className="text-[12px] font-medium">{paymentLabel(i)}</td>
                      <td><StatusPill status={i.rawStatus ?? i.status} /></td>
                      <td style={{ textAlign: "center" }}>
                        <div className="flex items-center justify-center gap-1.5">
                          {/* Update / Cancel post to the dealer-order endpoints,
                              which don't know about employee_orders. Re-record
                              the sale to change an employee indent — placing it
                              again for the same day replaces its lines. */}
                          {i.partyType === "employee" ? (
                            <span className="text-[11.5px] text-muted-foreground">Re-record to change</span>
                          ) : (
                            <>
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
                                  onClick={() => openCancel(i)}
                                >
                                  <Ban className="h-3.5 w-3.5 mr-1" /> Cancel
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/40">
                    <td colSpan={5} className="text-right uppercase text-[12.5px] font-semibold tracking-wide">Page Total</td>
                    <td className="num font-bold text-[14px]" style={{ textAlign: "right" }}>{fmtINR(grand)}</td>
                    <td colSpan={3}></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-[12px] print:hidden">
              <span className="text-muted-foreground">Page {page} of {totalPages} · {total} indents</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-7" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</Button>
                <Button variant="outline" size="sm" className="h-7" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Cancel Indent dialog — reason + choice of refund destination */}
      <Dialog open={!!cancelFor} onOpenChange={o => { if (!o) closeCancel(); }}>
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
                  Cancelling restores stock and refunds the dealer to the destination you choose below.
                </div>
              </div>

              {/* Refund destination */}
              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
                  Refund to
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRefundMethod("balance")}
                    className={`rounded-sm border px-3 py-2 text-left text-[12.5px] transition ${
                      refundMethod === "balance"
                        ? "border-primary bg-primary/10 font-medium"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    Available balance
                    <span className="block text-[10.5px] text-muted-foreground font-normal">
                      Store credit on the ledger
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={!bankPossible}
                    onClick={() => setRefundMethod("razorpay")}
                    className={`rounded-sm border px-3 py-2 text-left text-[12.5px] transition disabled:opacity-50 disabled:cursor-not-allowed ${
                      refundMethod === "razorpay"
                        ? "border-primary bg-primary/10 font-medium"
                        : "border-border hover:bg-muted/50"
                    }`}
                  >
                    Bank account
                    <span className="block text-[10.5px] text-muted-foreground font-normal">
                      Razorpay refund
                    </span>
                  </button>
                </div>
                {!bankPossible && (
                  <p className="mt-1 text-[11px] text-muted-foreground">
                    Bank refunds are only available for orders paid online.
                  </p>
                )}
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
            <Button variant="outline" size="sm" className="h-8" onClick={closeCancel}>
              Keep Indent
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8"
              disabled={!cancelReason.trim() || cancelMut.isPending}
              onClick={() => cancelFor && cancelMut.mutate({ id: cancelFor.id, reason: cancelReason.trim(), refundMethod })}
            >
              {cancelMut.isPending ? "Cancelling…" : "Cancel Indent"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}