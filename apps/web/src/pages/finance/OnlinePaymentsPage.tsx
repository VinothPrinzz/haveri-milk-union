// apps/web/src/pages/finance/OnlinePaymentsPage.tsx
// ═══════════════════════════════════════════════════════════════════════
// Finance → Online Payments
//
// Every Razorpay transaction the dealers put through the app — credit
// top-ups and per-order pay-now. Lets the accountant see status, drill
// into a txn, issue refunds, and sign off reconciliation.
//
// Route:  /finance/online-payments     (finance.view)
// ═══════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar,
  Field,
  StatCard,
  EmptyState,
  fmtINR,
  fmtDate,
} from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from "@/components/ui/dialog";
import {
  Wallet, TrendingUp, RotateCcw, AlertTriangle, Search, CheckCircle2,
  XCircle, Clock,
} from "lucide-react";
import {
  fetchCustomers,
  fetchOnlinePayments,
  fetchOnlinePaymentsSummary,
  fetchOnlinePayment,
  refundOnlinePayment,
  reconcileOnlinePayment,
  type OnlinePaymentRow,
  type RazorpayStatus,
} from "@/services/api";

// ── Static option lists ───────────────────────────────────────────────
const STATUS_OPTIONS: F9Option[] = [
  { value: "paid",      label: "Paid" },
  { value: "failed",    label: "Failed" },
  { value: "refunded",  label: "Refunded" },
  { value: "created",   label: "Created" },
  { value: "attempted", label: "Attempted" },
];
const KIND_OPTIONS: F9Option[] = [
  { value: "credit_topup",  label: "Credit Top-up" },
  { value: "order_payment", label: "Order Payment" },
];
const RECON_OPTIONS: F9Option[] = [
  { value: "unreconciled", label: "Unreconciled" },
  { value: "reconciled",   label: "Reconciled" },
];
const KIND_LABEL: Record<string, string> = {
  credit_topup:  "Credit Top-up",
  order_payment: "Order Payment",
};

// ── Status badge ──────────────────────────────────────────────────────
function StatusBadge({ status }: { status: RazorpayStatus }) {
  const map: Record<RazorpayStatus, { cls: string; label: string }> = {
    paid:      { cls: "bg-success/15 text-success",       label: "Paid" },
    refunded:  { cls: "bg-info/15 text-info",             label: "Refunded" },
    failed:    { cls: "bg-destructive/15 text-destructive", label: "Failed" },
    created:   { cls: "bg-muted text-muted-foreground",   label: "Created" },
    attempted: { cls: "bg-warning/15 text-warning",       label: "Attempted" },
  };
  const s = map[status];
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${s.cls}`}>
      {s.label}
    </span>
  );
}

export default function OnlinePaymentsPage() {
  const [search,   setSearch]   = useState("");
  const [status,   setStatus]   = useState<string | null>(null);
  const [kind,     setKind]     = useState<string | null>(null);
  const [recon,    setRecon]    = useState<string | null>(null);
  const [dealerId, setDealerId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");
  const [page,     setPage]     = useState(1);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [search, status, kind, recon, dealerId, dateFrom, dateTo]);

  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const customerOptions: F9Option[] = useMemo(
    () => (customers as any[]).map((c: any) => ({
      value: String(c.customerId ?? c.id),
      label: c.customerName ?? c.name,
      sublabel: c.code,
    })),
    [customers]
  );

  const filters = {
    search:   search.trim() || undefined,
    status:   (status as RazorpayStatus | null) ?? undefined,
    kind:     (kind as any) ?? undefined,
    recon:    (recon as any) ?? undefined,
    dealerId: dealerId ?? undefined,
    dateFrom: dateFrom || undefined,
    dateTo:   dateTo   || undefined,
  };

  const { data, isLoading } = useQuery({
    queryKey: ["online-payments", filters, page],
    queryFn: () => fetchOnlinePayments({ ...filters, page, limit: 50 }),
  });

  const { data: summary } = useQuery({
    queryKey: ["online-payments-summary", dateFrom, dateTo],
    queryFn: () => fetchOnlinePaymentsSummary({
      dateFrom: dateFrom || undefined,
      dateTo:   dateTo   || undefined,
    }),
  });

  const rows: OnlinePaymentRow[] = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Online Payments"
        subtitle="Razorpay transactions — credit top-ups & order payments (Axis Bank settlement)"
      />

      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Dealer, order_… / pay_… id"
              className="erp-input pl-7 w-full"
            />
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Status</label>
          <F9SearchSelect value={status} onChange={setStatus} options={STATUS_OPTIONS} placeholder="Any" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Type</label>
          <F9SearchSelect value={kind} onChange={setKind} options={KIND_OPTIONS} placeholder="Any" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Reconciliation</label>
          <F9SearchSelect value={recon} onChange={setRecon} options={RECON_OPTIONS} placeholder="Any" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Dealer</label>
          <F9SearchSelect value={dealerId} onChange={setDealerId} options={customerOptions} placeholder="All" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="erp-input w-36" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
          <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="erp-input w-36" />
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* KPI tiles */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard label="Net Collected" tone="success"
            value={fmtINR(summary?.netCollected ?? 0)}
            hint={`Gross ${fmtINR(summary?.grossCollected ?? 0)}`}
            icon={<Wallet className="h-5 w-5" />} />
          <StatCard label="Collected Today"
            value={fmtINR(summary?.collectedToday ?? 0)}
            icon={<TrendingUp className="h-5 w-5" />} />
          <StatCard label="Refunded" tone="info"
            value={fmtINR(summary?.totalRefunded ?? 0)}
            icon={<RotateCcw className="h-5 w-5" />} />
          <StatCard label="Unreconciled"
            tone={(summary?.unreconciledCount ?? 0) > 0 ? "warning" : "default"}
            value={fmtINR(summary?.unreconciledAmount ?? 0)}
            hint={`${summary?.unreconciledCount ?? 0} txns pending sign-off`}
            icon={<AlertTriangle className="h-5 w-5" />} />
          <StatCard label="Success Rate"
            tone={(summary?.successRate ?? 100) >= 90 ? "success" : "warning"}
            value={summary?.successRate != null ? `${summary.successRate}%` : "—"}
            hint={`${summary?.failedCount ?? 0} failed`}
            icon={<CheckCircle2 className="h-5 w-5" />} />
        </div>

        {/* Table */}
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title="No online payments match your filter" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Dealer</th>
                  <th>Type</th>
                  <th>Razorpay Ref</th>
                  <th className="num" style={{ textAlign: "right", width: 120 }}>Amount ₹</th>
                  <th className="num" style={{ textAlign: "right", width: 110 }}>Refunded ₹</th>
                  <th>Status</th>
                  <th style={{ textAlign: "center", width: 70 }}>Books</th>
                  <th style={{ textAlign: "center", width: 90 }}>Reconciled</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((p) => (
                  <tr
                    key={p.id}
                    className="cursor-pointer hover:bg-muted/40"
                    onClick={() => setDetailId(p.id)}
                  >
                    <td>{fmtDate(p.paidAt ?? p.createdAt)}</td>
                    <td className="font-medium">
                      {p.dealerName}
                      {p.dealerCode && (
                        <span className="text-muted-foreground font-mono text-[11px] ml-1">
                          {p.dealerCode}
                        </span>
                      )}
                    </td>
                    <td className="text-[12px]">{KIND_LABEL[p.kind] ?? p.kind}</td>
                    <td className="font-mono text-[11px] text-muted-foreground">
                      {p.razorpayPaymentId ?? p.razorpayOrderId}
                    </td>
                    <td className="num font-semibold" style={{ textAlign: "right" }}>
                      {fmtINR(p.amount)}
                    </td>
                    <td className="num text-info" style={{ textAlign: "right" }}>
                      {p.amountRefunded > 0 ? fmtINR(p.amountRefunded) : "—"}
                    </td>
                    <td><StatusBadge status={p.status} /></td>
                    <td style={{ textAlign: "center" }}>
                      {p.status === "paid" || p.status === "refunded" ? (
                        p.postedToBooks
                          ? <CheckCircle2 className="h-4 w-4 text-success inline" />
                          : <XCircle className="h-4 w-4 text-destructive inline" />
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      {p.reconciledAt
                        ? <CheckCircle2 className="h-4 w-4 text-success inline" />
                        : (p.status === "paid" || p.status === "refunded")
                          ? <Clock className="h-4 w-4 text-warning inline" />
                          : <span className="text-muted-foreground">—</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-[12px]">
              <span className="text-muted-foreground">
                Page {page} of {totalPages} · {data?.total ?? 0} records
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-7"
                  disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>
                  Previous
                </Button>
                <Button variant="outline" size="sm" className="h-7"
                  disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {detailId && (
        <PaymentDetailDialog
          id={detailId}
          onClose={() => setDetailId(null)}
        />
      )}
    </div>
  );
}

// ── Detail dialog: payment + refunds + ledger + actions ───────────────
function PaymentDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const qc = useQueryClient();
  const [refundOpen, setRefundOpen] = useState(false);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["online-payment", id],
    queryFn: () => fetchOnlinePayment(id),
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["online-payment", id] });
    qc.invalidateQueries({ queryKey: ["online-payments"] });
    qc.invalidateQueries({ queryKey: ["online-payments-summary"] });
    qc.invalidateQueries({ queryKey: ["razorpay-reconciliation"] });
  };

  const refund = useMutation({
    mutationFn: () => refundOnlinePayment(id, {
      amount: refundAmount ? Number(refundAmount) : undefined,
      reason: refundReason.trim(),
    }),
    onSuccess: (r) => {
      toast.success(r.fullyRefunded ? "Fully refunded" : "Partial refund initiated");
      setRefundOpen(false); setRefundAmount(""); setRefundReason("");
      invalidate();
    },
    onError: (e: any) => toast.error(e?.message ?? "Refund failed"),
  });

  const reconcile = useMutation({
    mutationFn: (val: boolean) => reconcileOnlinePayment(id, val),
    onSuccess: (r) => { toast.success(r.message); invalidate(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const p = data?.payment;
  const remaining = p ? p.amount - p.amountRefunded : 0;
  const canRefund = p && p.status === "paid" && remaining > 0;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader><DialogTitle>Online Payment</DialogTitle></DialogHeader>

        {isLoading || !p ? (
          <div className="space-y-2 py-4">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
          </div>
        ) : (
          <div className="space-y-4 text-[13px]">
            {/* Key facts */}
            <div className="grid grid-cols-2 gap-x-6 gap-y-1.5">
              <Row k="Dealer" v={`${p.dealerName}${p.dealerCode ? " · " + p.dealerCode : ""}`} />
              <Row k="Type" v={KIND_LABEL[p.kind] ?? p.kind} />
              <Row k="Amount" v={fmtINR(p.amount)} />
              <Row k="Refunded" v={p.amountRefunded > 0 ? fmtINR(p.amountRefunded) : "—"} />
              <Row k="Status" v={<StatusBadge status={p.status} />} />
              <Row k="Paid at" v={p.paidAt ? fmtDate(p.paidAt) : "—"} />
              <Row k="Order id" v={p.razorpayOrderId} mono />
              <Row k="Payment id" v={p.razorpayPaymentId ?? "—"} mono />
              <Row k="Webhook" v={p.webhookReceived ? "Received" : "Not received"} />
              <Row k="Posted to books" v={
                p.postedToBooks
                  ? <span className="text-success">Yes</span>
                  : <span className="text-destructive">No</span>
              } />
            </div>

            {p.errorDescription && (
              <div className="rounded bg-destructive/10 text-destructive px-3 py-2 text-[12px]">
                {p.errorCode ? `[${p.errorCode}] ` : ""}{p.errorDescription}
              </div>
            )}

            {/* Refunds */}
            {data!.refunds.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Refunds</div>
                <table className="erp-table">
                  <thead><tr><th>Date</th><th>Amount</th><th>Status</th><th>Reason</th><th>By</th></tr></thead>
                  <tbody>
                    {data!.refunds.map((r) => (
                      <tr key={r.id}>
                        <td>{fmtDate(r.createdAt)}</td>
                        <td className="num">{fmtINR(r.amount)}</td>
                        <td className="capitalize">{r.status}</td>
                        <td className="text-[12px]">{r.reason}</td>
                        <td className="text-[12px]">{r.initiatedByName ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Linked ledger rows */}
            {data!.ledger.length > 0 && (
              <div>
                <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1">Ledger entries</div>
                <table className="erp-table">
                  <thead><tr><th>Voucher</th><th>Type</th><th>Amount</th><th>Particulars</th></tr></thead>
                  <tbody>
                    {data!.ledger.map((l) => (
                      <tr key={l.id}>
                        <td className="font-mono text-[11px]">{l.voucherNo ?? "—"}</td>
                        <td className={l.type === "credit" ? "text-success" : "text-destructive"}>
                          {l.type}
                        </td>
                        <td className="num">{fmtINR(l.amount)}</td>
                        <td className="text-[12px]">{l.particulars ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Inline refund form */}
            {refundOpen && (
              <div className="rounded border border-border p-3 space-y-3 bg-muted/30">
                <div className="text-[12px] font-medium">
                  Refund — up to {fmtINR(remaining)} remaining
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <Field label="Amount (blank = full)">
                    <Input type="number" min="0" step="0.01" max={remaining}
                      value={refundAmount}
                      onChange={e => setRefundAmount(e.target.value)}
                      placeholder={remaining.toFixed(2)}
                      className="erp-input num" />
                  </Field>
                  <Field label="Reason" required>
                    <Textarea value={refundReason}
                      onChange={e => setRefundReason(e.target.value)}
                      className="erp-input min-h-[38px]" />
                  </Field>
                </div>
                <div className="flex justify-end gap-2">
                  <Button variant="outline" size="sm" className="h-7"
                    onClick={() => setRefundOpen(false)}>Cancel</Button>
                  <Button size="sm" className="h-7"
                    disabled={refundReason.trim().length < 3 || refund.isPending}
                    onClick={() => refund.mutate()}>
                    {refund.isPending ? "Processing…" : "Confirm Refund"}
                  </Button>
                </div>
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2">
          {p && (p.status === "paid" || p.status === "refunded") && (
            <Button variant="outline" size="sm" className="h-8"
              disabled={reconcile.isPending}
              onClick={() => reconcile.mutate(!p.reconciledAt)}>
              {p.reconciledAt ? "Clear reconciliation" : "Mark reconciled"}
            </Button>
          )}
          {canRefund && !refundOpen && (
            <Button variant="outline" size="sm" className="h-8"
              onClick={() => setRefundOpen(true)}>
              <RotateCcw className="h-3.5 w-3.5 mr-1.5" /> Refund
            </Button>
          )}
          <Button size="sm" className="h-8" onClick={onClose}>Close</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-3 border-b border-border/50 py-1">
      <span className="text-muted-foreground">{k}</span>
      <span className={mono ? "font-mono text-[11.5px]" : "font-medium text-right"}>{v}</span>
    </div>
  );
}