// apps/web/src/pages/finance/PaymentsOverviewPage.tsx
// ════════════════════════════════════════════════════════════════════
// Payments Overview — /finance/payments
//
// Layout:
//   ├─ PageHeader with "Record Payment" CTA (opens dialog)
//   ├─ Summary strip — 3 stat cards (Total Received, Today, Count)
//   ├─ Filter bar — Search, From, To, Mode (F9), Customer (F9)
//   └─ DataTable (column order per spec):
//        Received Date | Overdue | Customer | Mode | Reference |
//        Amount | Invoice No.
//
// Server-side filtering / pagination via fetchPayments().
//
// Record Payment dialog (POST /payments):
//   • Customer (F9, required) — searchable dealer dropdown
//   • Amount (required, numeric > 0)
//   • Mode (F9: cash / upi / cheque / neft / rtgs / credit / wallet)
//   • Received Date (default today)
//   • Invoice (F9, optional) — shows recent unpaid invoices for the
//     selected customer; selecting one updates payment_status
//   • Reference (text, e.g. UPI txn id, cheque no)
//   • Notes (optional)
//
// On success: invalidates payments + invoices + ledger queries so
// every dependent page (Invoice list, Detail, Dealer Ledger) shows
// the new payment immediately.
// ════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { Plus, Wallet, IndianRupee, CalendarCheck, Hash } from "lucide-react";
import {
  fetchPayments,
  recordPayment,
  fetchCustomers,
  fetchInvoicesList,
  type PaymentRow,
  type PaymentMode,
} from "@/services/api";

// ── Formatters ────────────────────────────────────────────────
const fmtMoney = (n: number | string) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(typeof n === "string" ? parseFloat(n) || 0 : n);

const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    day:   "2-digit",
    month: "short",
    year:  "numeric",
  });
};

// ── Mode → display label / badge color ────────────────────────
const MODE_LABELS: Record<PaymentMode, string> = {
  cash:   "Cash",
  upi:    "UPI",
  cheque: "Cheque",
  neft:   "NEFT",
  rtgs:   "RTGS",
  credit: "Credit",
  wallet: "Wallet",
};

const MODE_STYLES: Record<PaymentMode, string> = {
  cash:   "bg-emerald-50 text-emerald-700 border-emerald-200",
  upi:    "bg-blue-50 text-blue-700 border-blue-200",
  cheque: "bg-amber-50 text-amber-700 border-amber-200",
  neft:   "bg-violet-50 text-violet-700 border-violet-200",
  rtgs:   "bg-violet-50 text-violet-700 border-violet-200",
  credit: "bg-slate-50 text-slate-700 border-slate-200",
  wallet: "bg-indigo-50 text-indigo-700 border-indigo-200",
};

const MODE_OPTIONS: F9Option[] = (Object.keys(MODE_LABELS) as PaymentMode[]).map(
  m => ({ value: m, label: MODE_LABELS[m] })
);

export default function PaymentsOverviewPage() {
  // Filter state
  const [search,   setSearch]   = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");
  const [mode,     setMode]     = useState<string | null>(null);
  const [dealerId, setDealerId] = useState<string | null>(null);
  const [page,     setPage]     = useState(1);

  // Record-payment dialog
  const [recordOpen, setRecordOpen] = useState(false);

  useEffect(() => {
    setPage(1);
  }, [search, dateFrom, dateTo, mode, dealerId]);

  // ── Customers (for customer filter F9) ───────────────────────
  const { data: customers = [] } = useQuery({
    queryKey: ["customers"],
    queryFn: fetchCustomers,
  });
  const customerOptions: F9Option[] = useMemo(
    () =>
      (customers as any[]).map(c => ({
        value:    String(c.customerId),
        label:    c.customerName,
        sublabel: c.code,
      })),
    [customers]
  );

  // ── Main query ───────────────────────────────────────────────
  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["payments", search, dateFrom, dateTo, mode, dealerId, page],
    queryFn: () =>
      fetchPayments({
        search:   search.trim() || undefined,
        dateFrom: dateFrom || undefined,
        dateTo:   dateTo   || undefined,
        mode:     (mode as PaymentMode | null) ?? undefined,
        dealerId: dealerId ?? undefined,
        page,
        limit: 50,
      }),
  });

  const rows: PaymentRow[] = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;
  const summary = data?.summary ?? {
    totalReceived: 0,
    totalCount:    0,
    receivedToday: 0,
  };

  return (
    <PageShell
      header={
        <>
          <PageHeader
            title="Payments"
            description="All receipts received from customers"
          >
            <Button size="sm" onClick={() => setRecordOpen(true)}>
              <Plus className="h-4 w-4 mr-1.5" />
              Record Payment
            </Button>
          </PageHeader>

          {/* Summary strip */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <StatCard
              icon={<IndianRupee className="h-5 w-5 text-emerald-600" />}
              label="Total Received"
              value={fmtMoney(summary.totalReceived)}
              hint={`${summary.totalCount} payments in current view`}
            />
            <StatCard
              icon={<CalendarCheck className="h-5 w-5 text-blue-600" />}
              label="Received Today"
              value={fmtMoney(summary.receivedToday)}
            />
            <StatCard
              icon={<Hash className="h-5 w-5 text-violet-600" />}
              label="Total Count"
              value={summary.totalCount.toLocaleString("en-IN")}
            />
          </div>

          <FilterBar>
            <div className="min-w-[240px] flex-1">
              <label className="text-sm font-medium mb-1.5 block">Search</label>
              <Input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Customer, invoice no., or reference"
                className="w-full"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>
            <div className="min-w-[140px]">
              <label className="text-sm font-medium mb-1.5 block">Mode</label>
              <F9SearchSelect
                value={mode}
                onChange={setMode}
                options={MODE_OPTIONS}
                placeholder="All modes"
                allowClear
              />
            </div>
            <div className="min-w-[220px]">
              <label className="text-sm font-medium mb-1.5 block">Customer</label>
              <F9SearchSelect
                value={dealerId}
                onChange={setDealerId}
                options={customerOptions}
                placeholder="All customers"
                allowClear
              />
            </div>
            {isFetching && !isLoading && (
              <div className="text-xs text-muted-foreground pb-2">Refreshing…</div>
            )}
          </FilterBar>
        </>
      }
    >
      {isLoading ? (
        <ScrollableTableBody className="p-4">
          <div className="space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </ScrollableTableBody>
      ) : rows.length === 0 ? (
        <div className="h-full flex items-center justify-center">
          <Card className="max-w-md">
            <CardContent className="p-10 text-center space-y-2">
              <Wallet className="h-10 w-10 mx-auto text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No payments match the current filters.
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRecordOpen(true)}
              >
                <Plus className="h-4 w-4 mr-1.5" />
                Record First Payment
              </Button>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="h-full flex flex-col">
          <ScrollableTableBody className="flex-1">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
                <tr className="text-xs text-muted-foreground">
                  <th className="text-left  py-2.5 px-3 font-medium">Received Date</th>
                  <th className="text-right py-2.5 px-3 font-medium">Overdue</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Customer</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Mode</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Reference</th>
                  <th className="text-right py-2.5 px-3 font-medium">Amount</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Invoice No.</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b hover:bg-muted/30">
                    <td className="py-2 px-3 text-xs">
                      {fmtDate(r.receivedDate)}
                    </td>
                    <td className="py-2 px-3 text-right">
                      {r.overdueDays > 0 ? (
                        <span className="text-rose-600 font-mono text-xs">
                          {r.overdueDays}d
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="py-2 px-3 font-medium">
                      {r.dealerName}
                      {r.dealerCode && (
                        <span className="text-[10px] text-muted-foreground ml-1.5">
                          ({r.dealerCode})
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`text-[11px] px-2 py-0.5 rounded border font-medium ${
                          MODE_STYLES[r.mode] ?? "bg-muted"
                        }`}
                      >
                        {MODE_LABELS[r.mode] ?? r.mode}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-xs text-muted-foreground max-w-[200px] truncate">
                      {r.reference ?? "—"}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-semibold">
                      {fmtMoney(r.amount)}
                    </td>
                    <td className="py-2 px-3 font-mono text-xs">
                      {r.invoiceNumber ?? (
                        <span className="text-muted-foreground italic">
                          On-account
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTableBody>

          {totalPages > 1 && (
            <div className="flex-shrink-0 border-t bg-card rounded-b-lg px-4 py-2 flex items-center justify-between text-sm">
              <span className="text-xs text-muted-foreground">
                Page {page} of {totalPages} · {data?.total ?? 0} payments
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      <RecordPaymentDialog
        open={recordOpen}
        onClose={() => setRecordOpen(false)}
        customers={customerOptions}
      />
    </PageShell>
  );
}

// ════════════════════════════════════════════════════════════════════
// Record Payment dialog
// ════════════════════════════════════════════════════════════════════
function RecordPaymentDialog({
  open,
  onClose,
  customers,
}: {
  open: boolean;
  onClose: () => void;
  customers: F9Option[];
}) {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [dealerId,     setDealerId]     = useState<string | null>(null);
  const [amount,       setAmount]       = useState("");
  const [mode,         setMode]         = useState<PaymentMode>("cash");
  const [receivedDate, setReceivedDate] = useState(today);
  const [invoiceId,    setInvoiceId]    = useState<string | null>(null);
  const [reference,    setReference]    = useState("");
  const [notes,        setNotes]        = useState("");

  // Reset on close.
  useEffect(() => {
    if (!open) {
      setDealerId(null);
      setAmount("");
      setMode("cash");
      setReceivedDate(today);
      setInvoiceId(null);
      setReference("");
      setNotes("");
    }
  }, [open, today]);

  // ── Outstanding invoices for the selected customer ─────────
  // Only fetch when a customer is picked AND the dialog is open.
  const { data: invoicesResp } = useQuery({
    queryKey: ["invoices-outstanding", dealerId],
    queryFn: () =>
      fetchInvoicesList({
        // search by dealer code/name — backend supports search filter
        search: customers.find(c => c.value === dealerId)?.label,
        paymentStatus: "unpaid",   // also fetches partial below if extended
        limit: 50,
      }),
    enabled: Boolean(open && dealerId),
  });

  // Backend returns either "unpaid" or "partial" — we render both.
  // Run a second query for partial invoices, merged client-side.
  const { data: partialResp } = useQuery({
    queryKey: ["invoices-partial", dealerId],
    queryFn: () =>
      fetchInvoicesList({
        search: customers.find(c => c.value === dealerId)?.label,
        paymentStatus: "partial",
        limit: 50,
      }),
    enabled: Boolean(open && dealerId),
  });

  const invoiceOptions: F9Option[] = useMemo(() => {
    const list = [
      ...(invoicesResp?.data ?? []),
      ...(partialResp?.data ?? []),
    ].filter(i => i.dealerId === dealerId);  // strict filter — search is fuzzy
    return list.map(i => {
      const due = parseFloat(i.totalAmount) - parseFloat(i.paidAmount);
      return {
        value: i.id,
        label: `${i.invoiceNumber} — ${fmtMoney(due)} due`,
        sublabel: fmtDate(i.invoiceDate),
      };
    });
  }, [invoicesResp, partialResp, dealerId]);

  // ── Submit ───────────────────────────────────────────────────
  const submitMutation = useMutation({
    mutationFn: () =>
      recordPayment({
        dealerId:     dealerId!,
        amount:       parseFloat(amount),
        mode,
        receivedDate,
        invoiceId:    invoiceId || null,
        reference:    reference.trim() || undefined,
        notes:        notes.trim() || undefined,
      }),
    onSuccess: res => {
      toast.success(res.message);
      // Cascade invalidations — every dependent surface refreshes.
      qc.invalidateQueries({ queryKey: ["payments"] });
      qc.invalidateQueries({ queryKey: ["invoices"] });
      qc.invalidateQueries({ queryKey: ["invoice"] });          // detail page
      qc.invalidateQueries({ queryKey: ["dealer-ledger"] });
      qc.invalidateQueries({ queryKey: ["dealer-ledger-summary"] });
      qc.invalidateQueries({ queryKey: ["invoices-outstanding"] });
      qc.invalidateQueries({ queryKey: ["invoices-partial"] });
      onClose();
    },
    onError: (err: any) =>
      toast.error(err?.message || "Failed to record payment"),
  });

  const amountNum = parseFloat(amount) || 0;
  const canSubmit =
    Boolean(dealerId) &&
    amountNum > 0 &&
    Boolean(receivedDate) &&
    !submitMutation.isPending;

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Record Payment</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Customer */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              Customer <span className="text-destructive">*</span>
            </label>
            <F9SearchSelect
              value={dealerId}
              onChange={v => {
                setDealerId(v);
                setInvoiceId(null);  // reset linked invoice when customer changes
              }}
              options={customers}
              placeholder="Search customer"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            {/* Amount */}
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                Amount (₹) <span className="text-destructive">*</span>
              </label>
              <Input
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={amount}
                onChange={e => setAmount(e.target.value)}
              />
            </div>

            {/* Received Date */}
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                Received Date <span className="text-destructive">*</span>
              </label>
              <input
                type="date"
                value={receivedDate}
                onChange={e => setReceivedDate(e.target.value)}
                className="h-9 w-full rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>

            {/* Mode */}
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                Mode <span className="text-destructive">*</span>
              </label>
              <F9SearchSelect
                value={mode}
                onChange={v => v && setMode(v as PaymentMode)}
                options={MODE_OPTIONS}
                placeholder="Mode"
              />
            </div>

            {/* Reference */}
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                Reference
              </label>
              <Input
                type="text"
                placeholder={
                  mode === "upi"
                    ? "UPI txn id"
                    : mode === "cheque"
                      ? "Cheque no."
                      : mode === "neft" || mode === "rtgs"
                        ? "Bank ref"
                        : "Optional"
                }
                value={reference}
                onChange={e => setReference(e.target.value)}
              />
            </div>
          </div>

          {/* Invoice (optional) */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">
              Apply to Invoice (optional)
            </label>
            <F9SearchSelect
              value={invoiceId}
              onChange={setInvoiceId}
              options={invoiceOptions}
              placeholder={
                !dealerId
                  ? "Select customer first"
                  : invoiceOptions.length === 0
                    ? "No outstanding invoices"
                    : "Search invoice"
              }
              allowClear
              disabled={!dealerId}
            />
            <p className="text-[11px] text-muted-foreground mt-1">
              Leave blank for an on-account receipt (no specific invoice).
            </p>
          </div>

          {/* Notes */}
          <div>
            <label className="text-sm font-medium mb-1.5 block">Notes</label>
            <Textarea
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Optional internal notes"
              rows={2}
              className="resize-none"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            disabled={!canSubmit}
            onClick={() => submitMutation.mutate()}
          >
            {submitMutation.isPending ? "Recording…" : "Record Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Stat card primitive ─────────────────────────────────────────
function StatCard({
  icon,
  label,
  value,
  hint,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-start gap-3">
        <div className="mt-0.5">{icon}</div>
        <div className="flex-1">
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-lg font-semibold">{value}</div>
          {hint && (
            <div className="text-[11px] text-muted-foreground mt-0.5">{hint}</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}