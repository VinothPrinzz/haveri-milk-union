// ════════════════════════════════════════════════════════════════════
// Recent Sales — list view of recently posted sales
// Route preserved: /sales/direct-sales/recent
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, Field, EmptyState, StatusPill, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Ban, Printer, Search, X } from "lucide-react";
import {
  fetchRecentDirectSales as fetchRecentSales,
  cancelDirectSale,
  resolveDirectSaleInvoice,
  type CancelDirectSaleResult,
} from "@/services/api";
import { todayIST } from "@/lib/istDate";
import { payModeLabel as payLabel, isBilledMode as isBilled } from "@/lib/payMode";

// What the UI exposes as a filter, → what customer_type to match
const SALE_TYPE_OPTS: F9Option[] = [
  { value: "agent",             label: "Gate Pass" },
  { value: "cash",              label: "Cash" },
  { value: "vip_sample",        label: "VIP Sample" },
  { value: "employee_subsidy",  label: "Employee Subsidy" },
];

const TYPE_LABEL: Record<string, string> = {
  agent: "Gate Pass",
  cash: "Cash",
  vip_sample: "VIP Sample",
  employee_subsidy: "Employee Subsidy",
};

const formatBillId = (s: any) =>
  s.bill_no ?? s.invoice_number ?? s.gpNo ?? (s.id ? `#GP-${String(s.id).slice(-4).toUpperCase()}` : "");

// One-line description of what the cancellation did, for the success toast.
function cancelLine(r: CancelDirectSaleResult): string {
  const amt = fmtINR(r.refund.amount || 0);
  const parts: string[] = [];
  switch (r.refund.method) {
    case "razorpay":
      parts.push(`Bank refund of ${amt} initiated.`);
      break;
    case "credit":
      parts.push(r.refund.note ?? `Credited ${amt} to the agent's available balance.`);
      break;
    default:
      parts.push(r.refund.note ?? "Nothing was collected, so there is nothing to refund.");
  }
  if (r.refund.method === "razorpay" && r.refund.note) parts.push(r.refund.note);
  if (r.cashReceiptReversed) parts.push(`Counter receipt of ${fmtINR(r.cashReceiptReversed)} reversed.`);
  return parts.join(" ");
}

export default function RecentSalesPage() {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const today = todayIST();
  const sevenAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(sevenAgo);
  const [to, setTo] = useState(today);
  const [saleType, setSaleType] = useState<string | null>(null);  // ← NEW
  const [q, setQ] = useState("");
  const [resolvingId, setResolvingId] = useState<string | null>(null);

  // Cancel dialog: the sale being cancelled, the reason, and where any
  // collected money goes ("razorpay" bank refund or "balance" store credit).
  const [cancelFor, setCancelFor] = useState<any | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const [refundMethod, setRefundMethod] = useState<"razorpay" | "balance">("razorpay");

  const { data: sales = [], isLoading } = useQuery({
    queryKey: ["recent-sales", { from, to }],
    queryFn: () => fetchRecentSales(),
  });

  // Date range + sale-type filter (date is normalized to YYYY-MM-DD)
  const filtered = useMemo(() => {
    return (sales ?? []).filter((s: any) => {
      const dateOk = (!from || s.date >= from) && (!to || s.date <= to);
      const typeOk = !saleType || s.customerType === saleType;
      return dateOk && typeOk;
    });
  }, [sales, from, to, saleType]);

  const searchFiltered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return filtered;
    return filtered.filter((r: any) =>
      (formatBillId(r) ?? "").toLowerCase().includes(term) ||
      (r.customerName ?? "").toLowerCase().includes(term)
    );
  }, [filtered, q]);

  // A cancelled sale stays listed (struck through) but counts for nothing.
  const grand = searchFiltered.reduce(
    (s: number, r: any) => s + (r.status === "cancelled" ? 0 : (parseFloat(String(r.total ?? 0)) || 0)), 0
  );

  const cancelMut = useMutation({
    mutationFn: ({ id, reason, refundMethod }: { id: string; reason: string; refundMethod: "razorpay" | "balance" }) =>
      cancelDirectSale(id, reason, refundMethod),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["recent-sales"] });
      qc.invalidateQueries({ queryKey: ["recent-direct-sales"] });
      toast.success("Sale cancelled", { description: cancelLine(res) });
      closeCancel();
    },
    onError: (e: any) => toast.error(e?.message || "Cancellation failed"),
  });

  // Gateway money taken for the sale; only an agent pass can take store credit.
  const collected = Number(cancelFor?.collected ?? 0);
  const hasCollected = collected > 0.001;
  const balancePossible = hasCollected && cancelFor?.customerType === "agent";

  const openCancel = (s: any) => {
    setCancelFor(s);
    setCancelReason("");
    setRefundMethod("razorpay");
  };
  const closeCancel = () => {
    setCancelFor(null);
    setCancelReason("");
  };

  // The bill # opens the sale's tax invoice, generating it on first use.
  const openInvoice = async (s: any) => {
    if (s.invoiceId) {
      navigate(`/sales/invoices/${s.invoiceId}`);
      return;
    }
    try {
      setResolvingId(s.id);
      const { invoiceId } = await resolveDirectSaleInvoice(s.id);
      if (invoiceId) navigate(`/sales/invoices/${invoiceId}`);
      else toast.error("Invoice could not be generated.");
    } catch (e: any) {
      toast.error(e?.message || "Could not open invoice");
    } finally {
      setResolvingId(null);
    }
  };

  // Employee subsidy sales are indents now: invoiced (and cancelled) on the
  // indent rail from All Indents, not here.
  const canOpenInvoice = (s: any) => !!s.invoiceId || s.customerType !== "employee_subsidy";
  const canCancel = (s: any) => s.status !== "cancelled" && s.customerType !== "employee_subsidy";

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Recent Sales"
        subtitle="Gate pass, cash, VIP sample & employee subsidy"
        actions={
          <Button size="sm" variant="outline" className="h-8" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5 mr-1" /> Print
          </Button>
        }
      />

      <FilterBar>
        <Field label="From">
          <Input type="date" className="erp-input w-36" value={from} onChange={e => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" className="erp-input w-36" value={to} onChange={e => setTo(e.target.value)} />
        </Field>
        <Field label="Sale Type">
          <F9SearchSelect
            value={saleType} onChange={setSaleType}
            options={SALE_TYPE_OPTS} allowAll className="w-48"
          />
        </Field>
        <Field label="Search">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="erp-input pl-7 w-72" placeholder="bill # / party"
                   value={q} onChange={e => setQ(e.target.value)} />
          </div>
        </Field>
        {(q || saleType) && (
          <div className="flex items-end">
            <Button size="sm" variant="outline" className="h-8"
                    onClick={() => { setQ(""); setSaleType(null); }}>
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          </div>
        )}
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : searchFiltered.length === 0 ? (
            <EmptyState title="No sales found in this range." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>Bill #</th>
                  <th style={{ width: 110 }}>Date</th>
                  <th style={{ width: 130 }}>Type</th>
                  <th>Customer</th>
                  <th style={{ width: "26%" }}>Items</th>
                  <th style={{ width: 80 }}>Pay</th>
                  <th className="num" style={{ width: 120, textAlign: "right" }}>Total ₹</th>
                  <th style={{ width: 100 }}>Status</th>
                  <th style={{ width: 170, textAlign: "center" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {searchFiltered.map((s: any) => {
                  const cancelled = s.status === "cancelled";
                  return (
                    <tr key={s.id} className={cancelled ? "opacity-60" : undefined}>
                      <td className="font-mono text-[12.5px]">
                        {canOpenInvoice(s) ? (
                          <button
                            type="button"
                            onClick={() => openInvoice(s)}
                            disabled={resolvingId === s.id}
                            title="Open tax invoice"
                            className="text-primary hover:underline underline-offset-2 disabled:opacity-60 disabled:cursor-wait"
                          >
                            {resolvingId === s.id ? "Opening…" : formatBillId(s)}
                          </button>
                        ) : (
                          <span
                            className="text-muted-foreground"
                            title="Invoiced on the indent rail; open it from All Indents"
                          >
                            {formatBillId(s)}
                          </span>
                        )}
                      </td>
                      <td className="text-[12.5px]">{fmtDate(s.date)}</td>
                      <td className="text-[12px]">{TYPE_LABEL[s.customerType] ?? ""}</td>
                      <td className="font-medium">{s.customerName ?? "Walk-in"}</td>
                      <td>
                        {(s.items ?? []).length === 0 ? (
                          null
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {s.items.map((it: any, k: number) => (
                              <span key={k} className="text-[12px]">
                                <span className="num font-medium">{it.qty}×</span>{" "}
                                {it.productName}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="text-[12px]">
                        {payLabel(s.paymentMode || s.payMode)}
                        {isBilled(s.paymentMode) && (
                          <span className="ml-1 text-[10px] text-muted-foreground">(billed)</span>
                        )}
                      </td>
                      <td
                        className="num"
                        style={{ textAlign: "right", textDecoration: cancelled ? "line-through" : undefined }}
                      >
                        {fmtINR(s.total)}
                      </td>
                      <td><StatusPill status={cancelled ? "cancelled" : "confirmed"} /></td>
                      <td style={{ textAlign: "center" }}>
                        <div className="flex items-center justify-center gap-1.5">
                          {cancelled ? (
                            <span
                              className="text-[11.5px] text-muted-foreground"
                              title={s.cancellationReason ?? undefined}
                            >
                              {s.cancellationReason ? String(s.cancellationReason).slice(0, 28) : "Cancelled"}
                            </span>
                          ) : (
                            <>
                              <Button
                                size="sm" className="h-7 px-2.5 text-[12px]"
                                onClick={() => navigate(`/sales/direct-sales/modify?indentId=${s.id}&type=direct-sale`)}
                              >
                                Update
                              </Button>
                              {canCancel(s) && (
                                <Button
                                  size="sm" variant="outline"
                                  className="h-7 px-2.5 text-[12px] text-destructive"
                                  onClick={() => openCancel(s)}
                                >
                                  <Ban className="h-3.5 w-3.5 mr-1" /> Cancel
                                </Button>
                              )}
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-muted/40">
                  <td colSpan={6} className="text-right uppercase text-[12.5px] font-semibold tracking-wide">Grand Total</td>
                  <td className="num font-bold text-[14px]" style={{ textAlign: "right" }}>{fmtINR(grand)}</td>
                  <td colSpan={2}></td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>

      {/* Cancel dialog — reason + where any collected money goes. */}
      <Dialog open={!!cancelFor} onOpenChange={(o) => { if (!o) closeCancel(); }}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">Cancel Sale</DialogTitle>
          </DialogHeader>
          {cancelFor && (
            <div className="py-2 space-y-3">
              <div className="text-[12.5px] text-muted-foreground space-y-1">
                <div>
                  <span className="font-mono">{formatBillId(cancelFor)}</span>
                  {" · "}
                  <span className="font-medium text-foreground">{cancelFor.customerName ?? "Walk-in"}</span>
                </div>
                <div>
                  Total <span className="num font-medium text-foreground">{fmtINR(parseFloat(String(cancelFor.total ?? 0)) || 0)}</span>
                  {" · "}
                  Payment mode <span className="font-medium text-foreground">{payLabel(cancelFor.paymentMode || cancelFor.payMode)}</span>
                </div>
                <div className="text-[11.5px]">
                  Cancelling restores stock and closes any live counter QR.
                </div>
              </div>

              {hasCollected ? (
                <div>
                  <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
                    Refund {fmtINR(collected)} to
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setRefundMethod("razorpay")}
                      className={`rounded-sm border px-3 py-2 text-left text-[12.5px] transition ${
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
                    <button
                      type="button"
                      disabled={!balancePossible}
                      onClick={() => setRefundMethod("balance")}
                      className={`rounded-sm border px-3 py-2 text-left text-[12.5px] transition disabled:opacity-50 disabled:cursor-not-allowed ${
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
                  </div>
                  {!balancePossible && (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Store credit is only available on an agent gate pass; a counter customer has no ledger.
                    </p>
                  )}
                </div>
              ) : (
                <div className="rounded-sm border border-border bg-muted/40 px-3 py-2 text-[11.5px] text-muted-foreground">
                  {cancelFor.paymentMode === "cash" ? (
                    <>
                      This sale was settled in cash at the counter, so hand back{" "}
                      <span className="font-medium text-foreground">
                        {fmtINR(parseFloat(String(cancelFor.total ?? 0)) || 0)}
                      </span>{" "}
                      in cash. The counter receipt will be reversed.
                    </>
                  ) : cancelFor.paymentMode === "wallet" ? (
                    <>
                      This pass was taken against the agent's balance.{" "}
                      <span className="font-medium text-foreground">
                        {fmtINR(parseFloat(String(cancelFor.total ?? 0)) || 0)}
                      </span>{" "}
                      goes straight back onto it. Nothing changes hands at the counter.
                    </>
                  ) : cancelFor.paymentMode === "credit" ? (
                    <>
                      This pass was billed to the agent, not collected for. The{" "}
                      <span className="font-medium text-foreground">
                        {fmtINR(parseFloat(String(cancelFor.total ?? 0)) || 0)}
                      </span>{" "}
                      charged to their account will be written back.
                    </>
                  ) : (
                    <>Nothing was collected for this sale, so there is nothing to refund.</>
                  )}
                </div>
              )}

              <div>
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
                  Reason <span className="text-destructive">*</span>
                </label>
                <Input
                  className="erp-input"
                  value={cancelReason}
                  onChange={e => setCancelReason(e.target.value)}
                  placeholder="Why is this sale being cancelled?"
                  autoFocus
                />
              </div>
            </div>
          )}
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={closeCancel}>
              Keep Sale
            </Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8"
              disabled={!cancelReason.trim() || cancelMut.isPending}
              onClick={() => cancelFor && cancelMut.mutate({ id: cancelFor.id, reason: cancelReason.trim(), refundMethod })}
            >
              {cancelMut.isPending ? "Cancelling…" : "Cancel Sale"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
