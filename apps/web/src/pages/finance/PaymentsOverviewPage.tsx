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
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Wallet, TrendingUp, Receipt, Search } from "lucide-react";
import {
  fetchCustomers,
  fetchPayments,
  recordPayment,
  updatePayment,
  deletePayment,
  fetchInvoicesForCustomer,
  type PaymentMode,
  type PaymentRow,
  type PaymentStatus,
} from "@/services/api";
import { todayIST } from "@/lib/istDate";
import { useAuth } from "@/lib/auth";

// Roles that may edit / delete a recorded receipt. Mirrors the API's
// requireExactRole("super_admin", "manager") on PATCH / DELETE /payments/:id.
const CAN_EDIT = new Set(["manager", "super_admin"]);

// Everything a receipt feeds — refetched after a record, edit or delete.
const PAYMENT_QUERY_KEYS = [
  "payments", "invoices", "invoice", "invoices-for-customer", "dealer-ledger",
  "dealer-ledger-summary", "ar-aging", "ar-aging-summary", "ar-aging-dealer",
  "credit-control", "credit-control-summary", "finance-dashboard", "cheques", "cheques-summary",
];

const MODE_LABELS: Record<PaymentMode, string> = {
  cash:   "Cash",
  upi:    "UPI",
  cheque: "Cheque",
  neft:   "NEFT",
  rtgs:   "RTGS",
  credit: "Credit",
  wallet: "Wallet",
};

// Display status for a payment. For cheques this is the live cheque-register
// lifecycle (so a cancel/bounce there reflects here); other modes are one-shot.
const STATUS_META: Record<PaymentStatus, { label: string; cls: string }> = {
  completed: { label: "Completed", cls: "bg-success/15 text-success" },
  received:  { label: "In hand",   cls: "bg-info/15 text-info" },
  deposited: { label: "Deposited", cls: "bg-warning/15 text-warning" },
  cleared:   { label: "Cleared",   cls: "bg-success/15 text-success" },
  bounced:   { label: "Bounced",   cls: "bg-destructive/15 text-destructive" },
  cancelled: { label: "Cancelled", cls: "bg-muted text-muted-foreground" },
};

function PaymentStatusBadge({ status }: { status: PaymentStatus }) {
  const m = STATUS_META[status] ?? STATUS_META.completed;
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${m.cls}`}>
      {m.label}
    </span>
  );
}

// Cheque cancel/bounce reverses the ledger but keeps the payment row for audit;
// these rows no longer represent money received, so they're struck through.
const isReversed = (s: PaymentStatus) => s === "bounced" || s === "cancelled";

const MODE_OPTIONS: F9Option[] = (Object.keys(MODE_LABELS) as PaymentMode[]).map(m => ({
  value: m, label: MODE_LABELS[m],
}));

export default function PaymentsOverviewPage() {
  const [search,   setSearch]   = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");
  const [mode,     setMode]     = useState<string | null>(null);
  const [dealerId, setDealerId] = useState<string | null>(null);
  const [page,     setPage]     = useState(1);
  const [recordOpen, setRecordOpen] = useState(false);
  const [editing, setEditing] = useState<PaymentRow | null>(null);
  const [deleting, setDeleting] = useState<PaymentRow | null>(null);

  const { user } = useAuth();
  const canEdit = CAN_EDIT.has(user?.role ?? "");

  useEffect(() => { setPage(1); }, [search, dateFrom, dateTo, mode, dealerId]);

  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const customerOptions: F9Option[] = useMemo(
    () => (customers as any[]).map((c: any) => ({
      value: String(c.customerId ?? c.id),
      label: c.customerName ?? c.name,
      sublabel: c.code,
    })),
    [customers]
  );

  const { data, isLoading } = useQuery({
    queryKey: ["payments", search, dateFrom, dateTo, mode, dealerId, page],
    queryFn: () => fetchPayments({
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
  const summary = data?.summary ?? { totalReceived: 0, totalCount: 0, receivedToday: 0 };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Payments Overview"
        subtitle="All payments received from dealers"
        actions={
          <Button size="sm" className="h-8" onClick={() => setRecordOpen(true)}>
            <Plus className="h-3.5 w-3.5 mr-1.5" /> Record Payment
          </Button>
        }
      />

      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Dealer, invoice #, reference…"
              className="erp-input pl-7 w-full"
            />
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="erp-input w-40" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
          <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="erp-input w-40" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Mode</label>
          <F9SearchSelect value={mode} onChange={setMode} options={MODE_OPTIONS} placeholder="Any" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Customer</label>
          <F9SearchSelect value={dealerId} onChange={setDealerId} options={customerOptions} placeholder="All" />
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatCard label="Total Received" value={fmtINR(summary.totalReceived)} tone="success" icon={<Wallet className="h-5 w-5" />} />
          <StatCard label="Today" value={fmtINR(summary.receivedToday)} tone="default" icon={<TrendingUp className="h-5 w-5" />} />
          <StatCard label="Transactions" value={String(summary.totalCount)} icon={<Receipt className="h-5 w-5" />} />
        </div>

        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title="No payments match your filter" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Received Date</th>
                  <th>Customer</th>
                  <th>Mode</th>
                  <th>Status</th>
                  <th>Reference</th>
                  <th className="num" style={{ textAlign: "right", width: 130 }}>Amount ₹</th>
                  <th>Invoice</th>
                  {canEdit && <th>Actions</th>}
                </tr>
              </thead>
              <tbody>
                {rows.map((p: any) => {
                  const reversed = isReversed(p.status);
                  return (
                    <tr key={p.id} className={reversed ? "bg-destructive/5" : ""}>
                      <td>{fmtDate(p.receivedDate ?? p.receivedAt ?? p.received_date ?? p.createdAt)}</td>
                      <td className="font-medium">{p.customerName ?? p.dealerName ?? ""}</td>
                      <td>{MODE_LABELS[p.mode as PaymentMode] ?? p.mode}</td>
                      <td><PaymentStatusBadge status={p.status} /></td>
                      <td className="font-mono text-[12px] text-muted-foreground">{p.reference ?? ""}</td>
                      <td className={`num font-semibold ${reversed ? "text-muted-foreground line-through" : ""}`} style={{ textAlign: "right" }}>{fmtINR(p.amount)}</td>
                      <td className="font-mono text-[12px]">{p.invoiceNumber ?? ""}</td>
                      {canEdit && (
                        <td>
                          {p.editable && (
                            <div className="flex gap-1">
                              <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={() => setEditing(p)}>Edit</Button>
                              <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={() => setDeleting(p)}>Delete</Button>
                            </div>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-[12px]">
              <span className="text-muted-foreground">Page {page} of {totalPages} · {data?.total ?? 0} records</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-7" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</Button>
                <Button variant="outline" size="sm" className="h-7" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      <RecordPaymentDialog open={recordOpen} onOpenChange={setRecordOpen} customerOptions={customerOptions} />
      {editing && <EditPaymentDialog payment={editing} onClose={() => setEditing(null)} />}
      {deleting && <DeletePaymentDialog payment={deleting} onClose={() => setDeleting(null)} />}
    </div>
  );
}

// "RTGS · T1EH-RELIANCE · ₹1,340.84 · 20 Aug 2026" — which receipt a dialog acts on.
function paymentSummary(p: PaymentRow) {
  return [
    MODE_LABELS[p.mode] ?? p.mode, p.dealerName, fmtINR(p.amount), fmtDate(p.receivedDate),
  ].filter(Boolean).join(" · ");
}

// ── Delete Payment Dialog ────────────────────────────────────────
function DeletePaymentDialog({ payment, onClose }: { payment: PaymentRow; onClose: () => void }) {
  const qc = useQueryClient();
  const mut = useMutation({
    mutationFn: () => deletePayment(payment.id),
    onSuccess: () => {
      toast.success("Payment deleted");
      for (const key of PAYMENT_QUERY_KEYS) qc.invalidateQueries({ queryKey: [key] });
      onClose();
    },
    onError: (err: any) => toast.error(err?.message || "Failed to delete payment"),
  });
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Delete Payment</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <div className="text-muted-foreground">{paymentSummary(payment)}</div>
          <p className="text-[12px]">
            {payment.invoiceNumber
              ? <>Invoice {payment.invoiceNumber} will show as due again, and the receipt is reversed with a matching debit on the customer's ledger.</>
              : <>The receipt is reversed with a matching debit on the customer's ledger.</>}
            {" "}This cannot be undone.
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" variant="destructive" className="h-8" disabled={mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Deleting…" : "Delete Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Edit Payment Dialog ──────────────────────────────────────────
// Corrects a recorded receipt. Customer and invoices are fixed: a changed
// amount is re-applied to the same invoices by the API. Wallet receipts keep
// their mode (the API refuses a switch to or from Wallet), and cheques never
// reach here — they are corrected from the Cheque Register.
const EDIT_MODE_OPTIONS = MODE_OPTIONS.filter(o => o.value !== "cheque" && o.value !== "wallet");

function EditPaymentDialog({ payment, onClose }: { payment: PaymentRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount]         = useState(Number(payment.amount).toFixed(2));
  const [pMode, setPMode]           = useState<string | null>(payment.mode);
  const [receivedAt, setReceivedAt] = useState(String(payment.receivedDate ?? "").slice(0, 10));
  const [reference, setReference]   = useState(payment.reference ?? "");
  const [notes, setNotes]           = useState(payment.notes ?? "");
  const isWallet = payment.mode === "wallet";

  const save = useMutation({
    mutationFn: () => updatePayment(payment.id, {
      amount: Number(amount),
      mode: pMode as PaymentMode,
      receivedDate: receivedAt,
      reference: reference.trim() || null,
      notes: notes.trim() || null,
    }),
    onSuccess: () => {
      toast.success("Payment updated");
      for (const key of PAYMENT_QUERY_KEYS) qc.invalidateQueries({ queryKey: [key] });
      onClose();
    },
    onError: (err: any) => toast.error(err?.message || "Failed to update payment"),
  });

  const canSave = Number(amount) > 0 && !!pMode && !!receivedAt && !save.isPending;

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Edit Payment</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <div className="text-muted-foreground">{paymentSummary(payment)}</div>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount (₹)" required>
              <Input
                type="number" min="0" step="0.01" value={amount}
                onChange={e => setAmount(e.target.value)}
                className="erp-input num"
              />
            </Field>
            <Field label="Received date" required>
              <Input type="date" value={receivedAt} onChange={e => setReceivedAt(e.target.value)} className="erp-input" />
            </Field>
          </div>
          <Field label="Mode" required>
            {isWallet ? (
              <Input value={MODE_LABELS.wallet} disabled className="erp-input" />
            ) : (
              <F9SearchSelect value={pMode} onChange={setPMode} options={EDIT_MODE_OPTIONS} placeholder="Select mode" />
            )}
          </Field>
          {payment.invoiceNumber && (
            <p className="text-[12px]">
              Settles {payment.invoiceNumber}. A changed amount is re-applied to the same
              invoice(s), oldest due first. To settle different invoices, delete this
              payment and record it again.
            </p>
          )}
          <Field label="Reference">
            <Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" placeholder="UPI txn id, etc." />
          </Field>
          <Field label="Notes">
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} className="erp-input min-h-[60px]" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!canSave} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save Changes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ── Record Payment Dialog ────────────────────────────────────────
// One receipt can settle several invoices. The amount is applied oldest-due
// first across the ticked invoices (same order the API uses); anything left
// over stays on the dealer's account.
function RecordPaymentDialog({
  open, onOpenChange, customerOptions,
}: { open: boolean; onOpenChange: (v: boolean) => void; customerOptions: F9Option[] }) {
  const qc = useQueryClient();
  const [customerId, setCustomerId] = useState<string | null>(null);
  const [amount, setAmount]         = useState("");
  const [amountTouched, setAmountTouched] = useState(false);
  const [pMode, setPMode]           = useState<string | null>(null);
  const [receivedAt, setReceivedAt] = useState(todayIST());
  const [selected, setSelected]     = useState<Set<string>>(new Set());
  const [reference, setReference]   = useState("");
  const [notes, setNotes]           = useState("");

  const { data: invoices = [], isLoading: invoicesLoading } = useQuery({
    queryKey: ["invoices-for-customer", customerId],
    queryFn: () => fetchInvoicesForCustomer(customerId!),
    enabled: !!customerId && open,
  });

  // New customer → old invoice selection no longer applies.
  useEffect(() => { setSelected(new Set()); }, [customerId]);

  const selectedInvoices = useMemo(() => invoices.filter(i => selected.has(i.id)), [invoices, selected]);
  const selectedTotal = round2(selectedInvoices.reduce((s, i) => s + i.balance, 0));

  // Until the user types an amount, it follows the ticked invoices' total.
  useEffect(() => {
    if (!amountTouched) setAmount(selectedTotal > 0 ? selectedTotal.toFixed(2) : "");
  }, [selectedTotal, amountTouched]);

  const applied = useMemo(() => {
    let left = Math.round((Number(amount) || 0) * 100);
    const map = new Map<string, number>();
    for (const inv of selectedInvoices) {
      const take = Math.min(left, Math.round(inv.balance * 100));
      if (take > 0) { map.set(inv.id, take / 100); left -= take; }
    }
    return { map, onAccount: left / 100 };
  }, [amount, selectedInvoices]);

  const toggle = (id: string, on: boolean) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (on) next.add(id); else next.delete(id);
      return next;
    });
  const allSelected = invoices.length > 0 && selected.size === invoices.length;
  const toggleAll = (on: boolean) => setSelected(on ? new Set(invoices.map(i => i.id)) : new Set());

  const reset = () => {
    setCustomerId(null); setAmount(""); setAmountTouched(false); setPMode(null);
    setReceivedAt(todayIST());
    setSelected(new Set()); setReference(""); setNotes("");
  };

  const save = useMutation({
    mutationFn: () => recordPayment({
      dealerId: customerId!,
      amount: Number(amount),
      mode: pMode as PaymentMode,
      receivedDate: receivedAt,
      invoiceIds: selectedInvoices.map(i => i.id),
      reference: reference || undefined,
      notes: notes || undefined,
    }),
    onSuccess: (res) => {
      const n = res.allocations?.length ?? 0;
      toast.success(
        n > 0
          ? `Payment recorded — settled ${n} invoice${n > 1 ? "s" : ""}` +
            (res.unallocated > 0 ? `, ${fmtINR(res.unallocated)} on account` : "")
          : "Payment recorded on account"
      );
      for (const key of PAYMENT_QUERY_KEYS) qc.invalidateQueries({ queryKey: [key] });
      reset();
      onOpenChange(false);
    },
    onError: (err: any) => toast.error(err?.message || "Failed to record payment"),
  });

  const canSave = !!customerId && Number(amount) > 0 && !!pMode && !save.isPending;

  return (
    <Dialog open={open} onOpenChange={v => { if (!v) reset(); onOpenChange(v); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Record Payment</DialogTitle></DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Customer" required hint="F9">
            <F9SearchSelect
              value={customerId}
              onChange={setCustomerId}
              options={customerOptions}
              placeholder="Search customer"
            />
          </Field>
          <Field label="Mode" required>
            <F9SearchSelect value={pMode} onChange={setPMode} options={MODE_OPTIONS} placeholder="Select mode" />
          </Field>

          <div className="col-span-2">
            <div className="text-[11.5px] font-medium text-muted-foreground mb-1 flex items-center justify-between uppercase tracking-wide">
              <span>Invoices to settle (optional)</span>
              {selected.size > 0 && (
                <span className="normal-case tracking-normal">
                  {selected.size} selected · {fmtINR(selectedTotal)} outstanding
                </span>
              )}
            </div>
            <div className="border border-border rounded max-h-56 overflow-auto">
              {!customerId ? (
                <div className="p-3 text-[12px] text-muted-foreground">Pick a customer to see their unpaid invoices.</div>
              ) : invoicesLoading ? (
                <div className="p-3 space-y-1.5">
                  {Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-6 w-full" />)}
                </div>
              ) : invoices.length === 0 ? (
                <div className="p-3 text-[12px] text-muted-foreground">No unpaid invoices — the payment will be recorded on account.</div>
              ) : (
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>
                        <Checkbox checked={allSelected} onCheckedChange={v => toggleAll(v === true)} aria-label="Select all invoices" />
                      </th>
                      <th>Invoice</th>
                      <th>Date</th>
                      <th>Due</th>
                      <th className="num" style={{ textAlign: "right" }}>Overdue</th>
                      <th className="num" style={{ textAlign: "right" }}>Outstanding ₹</th>
                      <th className="num" style={{ textAlign: "right" }}>Applying ₹</th>
                    </tr>
                  </thead>
                  <tbody>
                    {invoices.map(inv => {
                      const on = selected.has(inv.id);
                      const take = applied.map.get(inv.id) ?? 0;
                      return (
                        <tr key={inv.id} className={`cursor-pointer ${on ? "bg-primary/5" : ""}`} onClick={() => toggle(inv.id, !on)}>
                          <td onClick={e => e.stopPropagation()}>
                            <Checkbox checked={on} onCheckedChange={v => toggle(inv.id, v === true)} aria-label={`Select ${inv.invoiceNumber}`} />
                          </td>
                          <td className="font-mono text-[12px]">{inv.invoiceNumber}</td>
                          <td>{fmtDate(inv.invoiceDate)}</td>
                          <td>{inv.dueDate ? fmtDate(inv.dueDate) : "—"}</td>
                          <td className={`num ${inv.overdueDays > 0 ? "text-destructive" : "text-muted-foreground"}`} style={{ textAlign: "right" }}>
                            {inv.overdueDays > 0 ? `${inv.overdueDays}d` : "—"}
                          </td>
                          <td className="num" style={{ textAlign: "right" }}>{fmtINR(inv.balance)}</td>
                          <td className="num font-semibold" style={{ textAlign: "right" }}>
                            {on ? (take > 0 ? fmtINR(take) : <span className="text-muted-foreground font-normal">—</span>) : ""}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          <Field label="Amount" required>
            <Input
              type="number" min="0" step="0.01" value={amount}
              onChange={e => { setAmount(e.target.value); setAmountTouched(true); }}
              className="erp-input num"
            />
          </Field>
          <Field label="Received Date">
            <Input type="date" value={receivedAt} onChange={e => setReceivedAt(e.target.value)} className="erp-input" />
          </Field>
          {selected.size > 0 && Number(amount) > 0 && (
            <div className="col-span-2 text-[12px] text-muted-foreground -mt-1">
              {fmtINR(round2(Number(amount) - applied.onAccount))} applied to {applied.map.size} invoice{applied.map.size === 1 ? "" : "s"}
              {applied.onAccount > 0 && <> · {fmtINR(applied.onAccount)} kept on account</>}
              {Number(amount) < selectedTotal && <> · {fmtINR(round2(selectedTotal - Number(amount)))} will remain due</>}
            </div>
          )}
          <Field label="Reference">
            <Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" placeholder="UPI txn id, cheque no, etc." />
          </Field>
          <Field label="Notes">
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} className="erp-input min-h-[60px]" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button disabled={!canSave} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Record"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const round2 = (n: number) => Math.round(n * 100) / 100;
