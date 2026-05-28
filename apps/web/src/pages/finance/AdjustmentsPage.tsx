// apps/web/src/pages/finance/AdjustmentsPage.tsx
// Finance → Credit Notes & Adjustments  (/finance/adjustments, finance.view)
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, Field, StatCard, EmptyState, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Search, Plus, FileMinus, FilePlus, Ban, RotateCcw } from "lucide-react";
import {
  fetchAdjustments, fetchAdjustmentsSummary, createAdjustment, reverseAdjustment,
  fetchCustomers, type AdjustmentRow, type AdjustmentVoucherType,
} from "@/services/api";

const TYPE_OPTIONS: F9Option[] = [
  { value: "Credit Note", label: "Credit Note" },
  { value: "Debit Note", label: "Debit Note" },
  { value: "Write-off", label: "Write-off" },
];
const REASONS_BY_TYPE: Record<AdjustmentVoucherType, { value: string; label: string }[]> = {
  "Credit Note": [
    { value: "sale_return", label: "Sale return" },
    { value: "billing_error", label: "Billing error" },
    { value: "goodwill", label: "Goodwill" },
    { value: "damaged_goods", label: "Damaged goods" },
    { value: "rate_difference", label: "Rate difference" },
    { value: "other", label: "Other" },
  ],
  "Debit Note": [
    { value: "late_fee", label: "Late fee" },
    { value: "interest", label: "Interest" },
    { value: "bounce_charges", label: "Bounce charges" },
    { value: "missed_billing", label: "Missed billing" },
    { value: "rate_difference", label: "Rate difference" },
    { value: "other", label: "Other" },
  ],
  "Write-off": [{ value: "write_off", label: "Write-off (uncollectible)" }],
};
const TYPE_TONE: Record<AdjustmentVoucherType, string> = {
  "Credit Note": "bg-success/15 text-success",
  "Debit Note": "bg-warning/15 text-warning",
  "Write-off": "bg-destructive/15 text-destructive",
};
const todayStr = () => new Date().toISOString().slice(0, 10);

function NewAdjustmentDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [voucherType, setVoucherType] = useState<AdjustmentVoucherType | null>(null);
  const [dealerId, setDealerId] = useState<string | null>(null);
  const [amount, setAmount] = useState("");
  const [voucherDate, setVoucherDate] = useState(todayStr());
  const [reason, setReason] = useState("");
  const [reasonText, setReasonText] = useState("");

  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const dealerOptions: F9Option[] = useMemo(
    () => (customers as any[]).map((c) => ({ value: String(c.id), label: c.name, sublabel: c.code })),
    [customers]
  );

  useEffect(() => {
    if (voucherType === "Write-off") setReason("write_off");
    else setReason("");
  }, [voucherType]);

  const mut = useMutation({
    mutationFn: () => createAdjustment({
      dealerId: dealerId!, voucherType: voucherType!, reason, reasonText,
      amount: Number(amount), voucherDate,
    }),
    onSuccess: (r) => {
      toast.success(`${voucherType} posted — ${r.voucherNo}`);
      qc.invalidateQueries({ queryKey: ["adjustments"] });
      qc.invalidateQueries({ queryKey: ["adjustments-summary"] });
      onClose();
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const valid = voucherType && dealerId && Number(amount) > 0 && reason && reasonText.trim().length >= 5;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>New Adjustment</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <div className="grid grid-cols-3 gap-2">
            {(["Credit Note", "Debit Note", "Write-off"] as AdjustmentVoucherType[]).map((t) => (
              <button key={t} onClick={() => setVoucherType(t)}
                className={`rounded border p-2 text-left ${voucherType === t ? "border-primary bg-primary/5" : "border-border hover:bg-muted/40"}`}>
                <div className="font-medium text-[12.5px]">{t}</div>
                <div className="text-[10.5px] text-muted-foreground mt-0.5">
                  {t === "Credit Note" ? "Credit the dealer" : t === "Debit Note" ? "Charge the dealer" : "Uncollectible"}
                </div>
              </button>
            ))}
          </div>

          {voucherType && (<>
            <Field label="Dealer" required><F9SearchSelect value={dealerId} onChange={setDealerId} options={dealerOptions} placeholder="Select dealer" /></Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Amount (₹)" required><Input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="erp-input num" /></Field>
              <Field label="Voucher date" required><Input type="date" value={voucherDate} onChange={e => setVoucherDate(e.target.value)} className="erp-input" /></Field>
            </div>
            <Field label="Reason category" required>
              <select value={reason} onChange={e => setReason(e.target.value)} disabled={voucherType === "Write-off"} className="erp-input w-full">
                <option value="">Select…</option>
                {REASONS_BY_TYPE[voucherType].map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </Field>
            <Field label="Reason text" required hint="min 5 chars"><Textarea value={reasonText} onChange={e => setReasonText(e.target.value)} className="erp-input min-h-[60px]" /></Field>
          </>)}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>{mut.isPending ? "Posting…" : "Post Adjustment"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ReverseDialog({ row, onClose }: { row: AdjustmentRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [reasonText, setReasonText] = useState("");
  const mut = useMutation({
    mutationFn: () => reverseAdjustment(row.id, { reasonText }),
    onSuccess: (r) => {
      toast.success(`Reversed — ${r.voucherNo}`);
      qc.invalidateQueries({ queryKey: ["adjustments"] });
      qc.invalidateQueries({ queryKey: ["adjustments-summary"] });
      onClose();
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Reverse {row.voucherType}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <div className="text-muted-foreground">{row.voucherNo} · {row.dealerName} · {fmtINR(row.amount)}</div>
          <Field label="Reason for reversal" required hint="min 5 chars"><Textarea value={reasonText} onChange={e => setReasonText(e.target.value)} className="erp-input min-h-[60px]" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={reasonText.trim().length < 5 || mut.isPending} onClick={() => mut.mutate()}>{mut.isPending ? "Reversing…" : "Confirm Reversal"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function AdjustmentsPage() {
  const [search, setSearch] = useState("");
  const [voucherType, setVoucherType] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [showNew, setShowNew] = useState(false);
  const [reverseRow, setReverseRow] = useState<AdjustmentRow | null>(null);

  useEffect(() => { setPage(1); }, [search, voucherType, dateFrom, dateTo]);

  const filters = {
    search: search.trim() || undefined,
    voucherType: (voucherType as AdjustmentVoucherType | null) ?? undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const { data, isLoading } = useQuery({
    queryKey: ["adjustments", filters, page],
    queryFn: () => fetchAdjustments({ ...filters, page, limit: 50 }),
  });
  const { data: summary } = useQuery({ queryKey: ["adjustments-summary", dateFrom, dateTo], queryFn: () => fetchAdjustmentsSummary({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }) });

  const rows: AdjustmentRow[] = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Credit Notes & Adjustments" subtitle="Credit notes, debit notes, write-offs & reversals"
        actions={<Button size="sm" className="h-8" onClick={() => setShowNew(true)}><Plus className="h-3.5 w-3.5 mr-1.5" />New Adjustment</Button>} />

      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Dealer, voucher, reason" className="erp-input pl-7 w-full" />
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Type</label>
          <F9SearchSelect value={voucherType} onChange={setVoucherType} options={TYPE_OPTIONS} placeholder="Any" />
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
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Credit Notes" tone="success" value={fmtINR(summary?.creditNoteAmount ?? 0)} hint={`${summary?.creditNoteCount ?? 0}`} icon={<FilePlus className="h-5 w-5" />} />
          <StatCard label="Debit Notes" tone="warning" value={fmtINR(summary?.debitNoteAmount ?? 0)} hint={`${summary?.debitNoteCount ?? 0}`} icon={<FileMinus className="h-5 w-5" />} />
          <StatCard label="Write-offs" tone="danger" value={fmtINR(summary?.writeOffAmount ?? 0)} hint={`${summary?.writeOffCount ?? 0}`} icon={<Ban className="h-5 w-5" />} />
          <StatCard label="Reversals" value={summary?.reversalCount ?? 0} icon={<RotateCcw className="h-5 w-5" />} />
        </div>

        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState title="No adjustments match your filter" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Voucher</th><th>Date</th><th>Type</th><th>Dealer</th>
                  <th className="num" style={{ textAlign: "right" }}>Amount</th>
                  <th>Reason</th><th>By</th><th>Status</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((a) => (
                  <tr key={a.id}>
                    <td className="font-mono text-[11px]">{a.voucherNo ?? "—"}</td>
                    <td>{fmtDate(a.voucherDate)}</td>
                    <td><span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${TYPE_TONE[a.voucherType]}`}>{a.voucherType}</span></td>
                    <td className="font-medium">{a.dealerName} <span className="text-muted-foreground font-mono text-[11px]">{a.dealerCode}</span></td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(a.amount)} <span className="text-[10px] text-muted-foreground">{a.ledgerType === "credit" ? "Cr" : "Dr"}</span></td>
                    <td className="text-[12px]">{a.reasonText}</td>
                    <td className="text-[12px]">{a.initiatedByName ?? "—"}</td>
                    <td className="text-[11px]">
                      {a.isReversal ? <span className="text-muted-foreground">reversal</span>
                        : a.isReversed ? <span className="text-warning">reversed</span>
                        : <span className="text-success">active</span>}
                    </td>
                    <td>
                      {!a.isReversal && !a.isReversed && (
                        <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={() => setReverseRow(a)}>Reverse</Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-[12px]">
              <span className="text-muted-foreground">Page {page} of {totalPages} · {data?.total ?? 0} entries</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-7" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</Button>
                <Button variant="outline" size="sm" className="h-7" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {showNew && <NewAdjustmentDialog onClose={() => setShowNew(false)} />}
      {reverseRow && <ReverseDialog row={reverseRow} onClose={() => setReverseRow(null)} />}
    </div>
  );
}
