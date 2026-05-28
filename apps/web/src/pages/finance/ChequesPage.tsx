// apps/web/src/pages/finance/ChequesPage.tsx
// Finance → Cheque Register  (/finance/cheques, finance.view)
import { useEffect, useState } from "react";
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
import { Search, Banknote, Landmark, CheckCircle2, XCircle, AlertTriangle, Printer } from "lucide-react";
import {
  fetchCheques, fetchChequesSummary, depositCheque, clearCheque, bounceCheque, cancelCheque,
  printDepositSlip, type ChequeRow, type ChequeStatus,
} from "@/services/api";

const STATUS_OPTIONS: F9Option[] = [
  { value: "received", label: "Received (in hand)" },
  { value: "deposited", label: "Deposited" },
  { value: "cleared", label: "Cleared" },
  { value: "bounced", label: "Bounced" },
  { value: "stopped", label: "Stopped" },
  { value: "cancelled", label: "Cancelled" },
];
const STATUS_TONE: Record<ChequeStatus, string> = {
  received: "bg-info/15 text-info",
  deposited: "bg-warning/15 text-warning",
  cleared: "bg-success/15 text-success",
  bounced: "bg-destructive/15 text-destructive",
  stopped: "bg-destructive/10 text-destructive",
  cancelled: "bg-muted text-muted-foreground",
};
const BOUNCE_REASONS = ["Insufficient funds", "Stop payment", "Signature mismatch", "Account closed", "Other"];
const todayStr = () => new Date().toISOString().slice(0, 10);

type ActionType = "deposit" | "clear" | "bounce" | "cancel";

function ActionDialog({ cheque, type, onClose }: { cheque: ChequeRow; type: ActionType; onClose: () => void }) {
  const qc = useQueryClient();
  const [depositedDate, setDepositedDate] = useState(todayStr());
  const [depositedToBank, setDepositedToBank] = useState("Axis Current");
  const [depositSlipNo, setDepositSlipNo] = useState("");
  const [clearedDate, setClearedDate] = useState(todayStr());
  const [bouncedDate, setBouncedDate] = useState(todayStr());
  const [bounceReason, setBounceReason] = useState(BOUNCE_REASONS[0]);
  const [bankCharges, setBankCharges] = useState("");
  const [passCharges, setPassCharges] = useState(false);
  const [cancelReason, setCancelReason] = useState("");

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["cheques"] });
    qc.invalidateQueries({ queryKey: ["cheques-summary"] });
  };

  const mut = useMutation({
    mutationFn: () => {
      if (type === "deposit") return depositCheque(cheque.id, { depositedDate, depositedToBank, depositSlipNo: depositSlipNo || undefined });
      if (type === "clear") return clearCheque(cheque.id, { clearedDate });
      if (type === "bounce") return bounceCheque(cheque.id, { bouncedDate, bounceReason, bankCharges: bankCharges ? Number(bankCharges) : 0, passChargesToDealer: passCharges });
      return cancelCheque(cheque.id, { reason: cancelReason });
    },
    onSuccess: (r: any) => { toast.success(r.message ?? "Done"); invalidate(); onClose(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const title = { deposit: "Deposit Cheque", clear: "Mark Cleared", bounce: "Mark Bounced", cancel: "Cancel Cheque" }[type];
  const canSubmit = type === "cancel" ? cancelReason.trim().length >= 3 : true;

  return (
    <Dialog open onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <div className="text-muted-foreground">
            {cheque.chequeNumber} · {cheque.bankName} · {fmtINR(cheque.amount)} · {cheque.dealerName}
          </div>

          {type === "deposit" && (<>
            <Field label="Deposited date" required><Input type="date" value={depositedDate} onChange={e => setDepositedDate(e.target.value)} className="erp-input" /></Field>
            <Field label="To bank" required><Input value={depositedToBank} onChange={e => setDepositedToBank(e.target.value)} className="erp-input" /></Field>
            <Field label="Deposit slip no."><Input value={depositSlipNo} onChange={e => setDepositSlipNo(e.target.value)} className="erp-input" /></Field>
          </>)}

          {type === "clear" && (
            <Field label="Cleared date" required><Input type="date" value={clearedDate} onChange={e => setClearedDate(e.target.value)} className="erp-input" /></Field>
          )}

          {type === "bounce" && (<>
            <Field label="Bounced date" required><Input type="date" value={bouncedDate} onChange={e => setBouncedDate(e.target.value)} className="erp-input" /></Field>
            <Field label="Reason" required>
              <select value={bounceReason} onChange={e => setBounceReason(e.target.value)} className="erp-input w-full">
                {BOUNCE_REASONS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </Field>
            <Field label="Bank charges (₹)"><Input type="number" min="0" step="0.01" value={bankCharges} onChange={e => setBankCharges(e.target.value)} className="erp-input num" /></Field>
            <label className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" checked={passCharges} onChange={e => setPassCharges(e.target.checked)} />
              Pass charges to dealer
            </label>
            <div className="rounded bg-warning/10 text-warning px-3 py-2 text-[12px]">This reverses the ledger credit and rolls back any linked invoice.</div>
          </>)}

          {type === "cancel" && (<>
            <Field label="Reason" required><Textarea value={cancelReason} onChange={e => setCancelReason(e.target.value)} className="erp-input min-h-[60px]" placeholder="Recorded by mistake before deposit" /></Field>
            <div className="rounded bg-destructive/10 text-destructive px-3 py-2 text-[12px]">Cancel only for cheques recorded in error before deposit. Reverses the ledger credit.</div>
          </>)}
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!canSubmit || mut.isPending} onClick={() => mut.mutate()}>{mut.isPending ? "Saving…" : "Confirm"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default function ChequesPage() {
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [action, setAction] = useState<{ cheque: ChequeRow; type: ActionType } | null>(null);

  useEffect(() => { setPage(1); }, [search, status, dateFrom, dateTo]);

  const filters = {
    search: search.trim() || undefined,
    status: (status as ChequeStatus | null) ?? undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const { data, isLoading } = useQuery({
    queryKey: ["cheques", filters, page],
    queryFn: () => fetchCheques({ ...filters, page, limit: 50 }),
  });
  const { data: summary } = useQuery({ queryKey: ["cheques-summary"], queryFn: () => fetchChequesSummary() });

  const rows: ChequeRow[] = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Cheque Register" subtitle="Receipt → deposit → clear / bounce lifecycle"
        actions={<Button variant="outline" size="sm" className="h-8" onClick={() => printDepositSlip()}><Printer className="h-3.5 w-3.5 mr-1.5" />Deposit Slip</Button>} />

      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Dealer, cheque no, bank" className="erp-input pl-7 w-full" />
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Status</label>
          <F9SearchSelect value={status} onChange={setStatus} options={STATUS_OPTIONS} placeholder="Any" />
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
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard label="In Hand" tone="info" value={fmtINR(summary?.inHandAmount ?? 0)} hint={`${summary?.inHandCount ?? 0} cheques`} icon={<Banknote className="h-5 w-5" />} />
          <StatCard label="In Bank" tone="warning" value={fmtINR(summary?.inBankAmount ?? 0)} hint={`${summary?.inBankCount ?? 0} awaiting clearance`} icon={<Landmark className="h-5 w-5" />} />
          <StatCard label="Cleared" tone="success" value={fmtINR(summary?.clearedAmount ?? 0)} hint={`${summary?.clearedCount ?? 0}`} icon={<CheckCircle2 className="h-5 w-5" />} />
          <StatCard label="Bounced" tone="danger" value={fmtINR(summary?.bouncedAmount ?? 0)} hint={`${summary?.bouncedCount ?? 0}`} icon={<XCircle className="h-5 w-5" />} />
          <StatCard label="Stagnant > 3d" tone={(summary?.stagnantInHandCount ?? 0) > 0 ? "warning" : "default"} value={summary?.stagnantInHandCount ?? 0} hint="undeposited" icon={<AlertTriangle className="h-5 w-5" />} />
        </div>

        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState title="No cheques match your filter" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Received</th><th>Cheque #</th><th>Dealer</th><th>Bank</th>
                  <th className="num" style={{ textAlign: "right" }}>Amount</th>
                  <th>Status</th><th className="num" style={{ textAlign: "right" }}>Ageing</th>
                  <th>Deposited</th><th>Cleared/Bounced</th><th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((c) => (
                  <tr key={c.id}>
                    <td>{fmtDate(c.receivedDate)}</td>
                    <td className="font-mono text-[11px]">{c.chequeNumber}</td>
                    <td className="font-medium">{c.dealerName} <span className="text-muted-foreground font-mono text-[11px]">{c.dealerCode}</span></td>
                    <td className="text-[12px]">{c.bankName}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(c.amount)}</td>
                    <td><span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${STATUS_TONE[c.status]}`}>{c.status}</span></td>
                    <td className="num" style={{ textAlign: "right" }}>{c.ageingDays > 0 ? `${c.ageingDays}d` : "—"}</td>
                    <td className="text-[12px]">{c.depositedDate ? fmtDate(c.depositedDate) : "—"}</td>
                    <td className="text-[12px]">
                      {c.clearedDate ? fmtDate(c.clearedDate) : c.bouncedDate ? <span className="text-destructive">{fmtDate(c.bouncedDate)}{c.bounceReason ? ` · ${c.bounceReason}` : ""}</span> : "—"}
                    </td>
                    <td>
                      <div className="flex gap-1">
                        {c.status === "received" && (<>
                          <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={() => setAction({ cheque: c, type: "deposit" })}>Deposit</Button>
                          <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={() => setAction({ cheque: c, type: "cancel" })}>Cancel</Button>
                        </>)}
                        {c.status === "deposited" && (<>
                          <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={() => setAction({ cheque: c, type: "clear" })}>Cleared</Button>
                          <Button variant="outline" size="sm" className="h-6 text-[11px]" onClick={() => setAction({ cheque: c, type: "bounce" })}>Bounced</Button>
                        </>)}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-[12px]">
              <span className="text-muted-foreground">Page {page} of {totalPages} · {data?.total ?? 0} cheques</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-7" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</Button>
                <Button variant="outline" size="sm" className="h-7" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</Button>
              </div>
            </div>
          )}
        </div>
      </div>

      {action && <ActionDialog cheque={action.cheque} type={action.type} onClose={() => setAction(null)} />}
    </div>
  );
}
