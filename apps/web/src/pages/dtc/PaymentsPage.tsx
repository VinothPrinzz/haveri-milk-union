// apps/web/src/pages/dtc/PaymentsPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → Payments & Advances  (/dtc/payments)
//
//   To pay    approved bills not yet paid, grouped by contractor. Tick the
//             bills, download the bank upload file (CSV) and record the
//             payment with its UTR / cheque number.
//   Paid      payment history; a wrong payment can be reversed.
//   Advances  money paid to a contractor mid-month, recovered from the
//             bill of the month chosen.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState, Field, StatCard, fmtINR } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, Banknote, Download, Plus, Undo2, XCircle } from "lucide-react";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";
import {
  cancelAdvance, fetchAdvances, fetchDtcLookups, fetchPayments, fetchPendingPayments, recordAdvance,
  recordPayment, reversePayment, type PayMode, type PendingBill,
} from "@/services/dtc";
import { MonthInput, PAY_MODES, errMsg, fmtDMY, monthLabel, rs, rs2, useDtcPerms } from "./shared";

export default function PaymentsPage() {
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Payments & Advances" subtitle="Pay approved DTC bills, keep the payment record, and track advances" />
      <div className="flex-1 overflow-auto p-3 sm:p-4">
        <Tabs defaultValue="pending">
          <TabsList>
            <TabsTrigger value="pending">To pay</TabsTrigger>
            <TabsTrigger value="paid">Paid</TabsTrigger>
            <TabsTrigger value="advances">Advances</TabsTrigger>
          </TabsList>
          <TabsContent value="pending"><PendingTab /></TabsContent>
          <TabsContent value="paid"><PaidTab /></TabsContent>
          <TabsContent value="advances"><AdvancesTab /></TabsContent>
        </Tabs>
      </div>
    </div>
  );
}

const modeLabel = (m: string) => PAY_MODES.find(p => p.value === m)?.label ?? m;

// ─── To pay ─────────────────────────────────────────────────────────
function PendingTab() {
  const perms = useDtcPerms();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-pending-payments"], queryFn: fetchPendingPayments });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paying, setPaying] = useState(false);

  const groups = useMemo(() => {
    const m = new Map<string, { key: string; name: string; bank: PendingBill; bills: PendingBill[] }>();
    for (const r of rows) {
      const key = r.contractorId ?? `none:${r.billId}`;
      if (!m.has(key)) m.set(key, { key, name: r.contractorName ?? "No contractor", bank: r, bills: [] });
      m.get(key)!.bills.push(r);
    }
    return Array.from(m.values());
  }, [rows]);
  const payable = rows.filter(r => !r.onHold);
  const chosen = rows.filter(r => selected.has(r.billId));
  const chosenTotal = chosen.reduce((s, r) => s + r.payable, 0);
  const missingBank = chosen.filter(r => !r.accountNo || !r.ifscCode);

  const toggle = (ids: string[], on: boolean) => setSelected(prev => {
    const n = new Set(prev);
    ids.forEach(id => (on ? n.add(id) : n.delete(id)));
    return n;
  });

  const bankFile = () => {
    // One line per contractor: their ticked bills are paid in one transfer.
    const byContractor = new Map<string, PendingBill[]>();
    for (const r of chosen) {
      const k = r.contractorId ?? r.billId;
      if (!byContractor.has(k)) byContractor.set(k, []);
      byContractor.get(k)!.push(r);
    }
    const out: (string | number)[][] = [["Beneficiary Name", "Account Number", "IFSC", "Amount", "Narration"]];
    for (const bills of byContractor.values()) {
      const b = bills[0]!;
      const months = Array.from(new Set(bills.map(x => monthLabel(x.month)))).join(", ");
      out.push([
        b.contractorName ?? "", b.accountNo ?? "", b.ifscCode ?? "",
        bills.reduce((s, x) => s + x.payable, 0).toFixed(2),
        `DTC ${months} ${bills.map(x => x.routeCode).join(" ")}`.slice(0, 60),
      ]);
    }
    const blob = new Blob([toCsv(out)], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dtc-bank-upload_${todayIST()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3 mt-3">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Waiting payment" value={fmtINR(rows.reduce((s, r) => s + r.payable, 0), false)} hint={`${rows.length} bill${rows.length === 1 ? "" : "s"}`} tone="warning" />
        <StatCard label="On hold" value={rows.filter(r => r.onHold).length} hint="released on the bill page" tone={rows.some(r => r.onHold) ? "danger" : "default"} />
        <StatCard label="Ticked" value={fmtINR(chosenTotal, false)} hint={`${chosen.length} bill${chosen.length === 1 ? "" : "s"}`} tone="info" />
        <div className="erp-panel p-2.5 flex flex-col gap-1.5 justify-center">
          <Button size="sm" variant="outline" className="h-8" disabled={chosen.length === 0} onClick={bankFile}>
            <Download className="h-3.5 w-3.5 mr-1.5" /> Bank upload file
          </Button>
          {perms.pay && (
            <Button size="sm" className="h-8" disabled={chosen.length === 0} onClick={() => setPaying(true)}>
              <Banknote className="h-3.5 w-3.5 mr-1.5" /> Record payment
            </Button>
          )}
        </div>
      </div>
      {missingBank.length > 0 && (
        <div className="erp-panel p-2.5 border-l-4 border-l-warning text-[12.5px] flex gap-2">
          <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
          {missingBank.length} ticked bill{missingBank.length === 1 ? " has" : "s have"} no account number or IFSC on the contractor (Masters → Contractors).
        </div>
      )}
      <div className="erp-panel overflow-auto">
        {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? (
          <EmptyState title="Nothing to pay" hint="Bills appear here once a month is approved by Finance." />
        ) : (
          <table className="erp-table text-[12.5px]">
            <thead>
              <tr>
                <th style={{ width: 30 }}>
                  <input type="checkbox" checked={payable.length > 0 && payable.every(r => selected.has(r.billId))}
                    onChange={e => toggle(payable.map(r => r.billId), e.target.checked)} />
                </th>
                <th>Contractor / route</th><th>Month</th><th>Bank</th><th className="text-right">Payable</th><th />
              </tr>
            </thead>
            <tbody>
              {groups.map(g => {
                const ids = g.bills.filter(b => !b.onHold).map(b => b.billId);
                const total = g.bills.reduce((s, b) => s + b.payable, 0);
                return [
                  <tr key={g.key} className="bg-muted/30 font-medium">
                    <td><input type="checkbox" disabled={ids.length === 0} checked={ids.length > 0 && ids.every(id => selected.has(id))} onChange={e => toggle(ids, e.target.checked)} /></td>
                    <td>{g.name}{g.bank.contractorCode && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{g.bank.contractorCode}</span>}</td>
                    <td />
                    <td className="text-[11.5px]">
                      {g.bank.accountNo
                        ? <>{g.bank.bankName ?? ""} {g.bank.accountNo} · {g.bank.ifscCode ?? <span className="text-warning">no IFSC</span>}</>
                        : <span className="text-warning">no bank details</span>}
                    </td>
                    <td className="text-right num">{rs(total)}</td>
                    <td />
                  </tr>,
                  ...g.bills.map(b => (
                    <tr key={b.billId} className={b.onHold ? "opacity-60" : ""}>
                      <td><input type="checkbox" disabled={b.onHold} checked={selected.has(b.billId)} onChange={e => toggle([b.billId], e.target.checked)} /></td>
                      <td className="pl-6"><span className="font-mono text-[11px] text-muted-foreground mr-1.5">{b.routeCode}</span>{b.routeName}</td>
                      <td>{monthLabel(b.month)}</td>
                      <td className="text-[11.5px] text-warning">{b.onHold ? `On hold: ${b.holdReason ?? ""}` : ""}</td>
                      <td className="text-right num">{rs(b.payable)}</td>
                      <td />
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        )}
      </div>
      {paying && <PayDialog bills={chosen} onClose={() => setPaying(false)} onDone={() => setSelected(new Set())} />}
    </div>
  );
}

function PayDialog({ bills, onClose, onDone }: { bills: PendingBill[]; onClose: () => void; onDone: () => void }) {
  const qc = useQueryClient();
  const [paidOn, setPaidOn] = useState(todayIST());
  const [mode, setMode] = useState<PayMode>("neft");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const contractors = new Set(bills.map(b => b.contractorId)).size;
  const mut = useMutation({
    mutationFn: () => recordPayment({ billIds: bills.map(b => b.billId), paidOn, mode, reference: reference || null, notes: notes || null }),
    onSuccess: (r) => {
      toast.success(r.message);
      ["dtc-pending-payments", "dtc-payments", "dtc-runs", "dtc-run", "dtc-bill"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      onDone();
      onClose();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Record payment</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <p>{bills.length} bill{bills.length === 1 ? "" : "s"} of {contractors} contractor{contractors === 1 ? "" : "s"}, total <b>₹{rs2(bills.reduce((s, b) => s + b.payable, 0))}</b>.</p>
          {contractors > 1 && <p className="text-[12px] text-muted-foreground">All ticked bills get the same reference. For separate transfers, record each contractor on its own.</p>}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Paid on" required><Input type="date" value={paidOn} max={todayIST()} onChange={e => setPaidOn(e.target.value)} className="erp-input" /></Field>
            <Field label="Mode" required>
              <select value={mode} onChange={e => setMode(e.target.value as PayMode)} className="erp-input w-full">
                {PAY_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
          </div>
          <Field label={mode === "cheque" ? "Cheque number" : "UTR / reference"} required={mode !== "cash"}>
            <Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" />
          </Field>
          <Field label="Notes"><Input value={notes} onChange={e => setNotes(e.target.value)} className="erp-input" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!paidOn || (mode !== "cash" && !reference.trim()) || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Saving…" : "Record payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Paid ───────────────────────────────────────────────────────────
function PaidTab() {
  const perms = useDtcPerms();
  const qc = useQueryClient();
  const [month, setMonth] = useState<string>("");
  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["dtc-payments", month], queryFn: () => fetchPayments(month ? { month } : {}),
  });
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const rev = useMutation({
    mutationFn: () => reversePayment(reversing!, reason),
    onSuccess: (r) => {
      toast.success(r.message); setReversing(null); setReason("");
      ["dtc-pending-payments", "dtc-payments", "dtc-runs", "dtc-run", "dtc-bill"].forEach(k => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const live = rows.filter(r => !r.reversedAt);
  return (
    <div className="space-y-3 mt-3">
      <div className="flex items-end gap-2">
        <Field label="Bill month"><MonthInput value={month} onChange={setMonth} className="w-40" /></Field>
        {month && <Button size="sm" variant="ghost" className="h-8" onClick={() => setMonth("")}>All months</Button>}
        <div className="flex-1" />
        <span className="text-[12.5px] pb-1.5">Paid: <b>₹{rs2(live.reduce((s, r) => s + r.amount, 0))}</b> ({live.length} bill{live.length === 1 ? "" : "s"})</span>
      </div>
      <div className="erp-panel overflow-auto">
        {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? <EmptyState title="No payments yet" /> : (
          <table className="erp-table text-[12.5px]">
            <thead><tr><th>Paid on</th><th>Contractor</th><th>Route</th><th>Bill month</th><th>Mode</th><th>Reference</th><th className="text-right">Amount</th><th>By</th><th /></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id} className={r.reversedAt ? "opacity-60 line-through" : ""} title={r.reverseReason ?? undefined}>
                  <td>{fmtDMY(r.paidOn)}</td>
                  <td>{r.contractorName ?? ""}</td>
                  <td><span className="font-mono text-[11px] text-muted-foreground mr-1">{r.routeCode}</span>{r.routeName}</td>
                  <td>{monthLabel(r.month)}</td>
                  <td>{modeLabel(r.mode)}</td>
                  <td className="font-mono text-[11.5px]">{r.reference ?? ""}</td>
                  <td className="text-right num">{rs2(r.amount)}</td>
                  <td>{r.reversedAt ? `reversed by ${r.reversedByName ?? ""}` : r.createdByName ?? ""}</td>
                  <td className="text-right">
                    {perms.pay && !r.reversedAt && (
                      <Button size="sm" variant="ghost" className="h-6 text-destructive" onClick={() => setReversing(r.id)} title="Reverse payment">
                        <Undo2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {reversing && (
        <Dialog open onOpenChange={v => { if (!v) setReversing(null); }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Reverse payment</DialogTitle></DialogHeader>
            <p className="text-[12.5px]">The bill becomes unpaid again. Use this when a transfer failed or was recorded against the wrong bill.</p>
            <Field label="Reason" required hint="min 5 chars"><Textarea value={reason} onChange={e => setReason(e.target.value)} className="erp-input min-h-[60px]" /></Field>
            <DialogFooter>
              <Button variant="outline" size="sm" className="h-8" onClick={() => setReversing(null)}>Cancel</Button>
              <Button size="sm" variant="destructive" className="h-8" disabled={reason.trim().length < 5 || rev.isPending} onClick={() => rev.mutate()}>Reverse</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

// ─── Advances ───────────────────────────────────────────────────────
function AdvancesTab() {
  const perms = useDtcPerms();
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-advances"], queryFn: fetchAdvances });
  const [adding, setAdding] = useState(false);
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) => cancelAdvance(id, reason),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-advances"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const outstanding = rows.filter(r => !r.cancelledAt && r.recoveredRunStatus !== "approved").reduce((s, r) => s + r.amount, 0);
  return (
    <div className="space-y-3 mt-3">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px]">Not yet recovered on an approved bill: <b>₹{rs2(outstanding)}</b></span>
        <div className="flex-1" />
        {perms.pay && <Button size="sm" className="h-8" onClick={() => setAdding(true)}><Plus className="h-3.5 w-3.5 mr-1.5" /> Record advance</Button>}
      </div>
      <div className="erp-panel overflow-auto">
        {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? <EmptyState title="No advances" /> : (
          <table className="erp-table text-[12.5px]">
            <thead><tr><th>Paid on</th><th>Contractor</th><th className="text-right">Amount</th><th>Mode / ref</th><th>Recover in</th><th>Status</th><th /></tr></thead>
            <tbody>
              {rows.map(a => (
                <tr key={a.id} className={a.cancelledAt ? "opacity-60" : ""}>
                  <td>{fmtDMY(a.paidOn)}</td>
                  <td>{a.contractorName}{a.routeCode && <span className="ml-1 text-[11px] text-muted-foreground">({a.routeCode})</span>}</td>
                  <td className="text-right num">{rs2(a.amount)}</td>
                  <td>{modeLabel(a.mode)} {a.reference ?? ""}</td>
                  <td>{monthLabel(a.recoverMonth)}</td>
                  <td className="text-[12px]">
                    {a.cancelledAt ? <span title={a.cancelReason ?? ""}>Cancelled</span>
                      : a.recoveredInMonth ? (a.recoveredRunStatus === "approved" ? <span className="text-success">Recovered</span> : "On draft bill")
                      : "Waiting"}
                  </td>
                  <td className="text-right">
                    {perms.pay && !a.cancelledAt && a.recoveredRunStatus !== "approved" && (
                      <Button size="sm" variant="ghost" className="h-6 text-destructive" disabled={cancel.isPending} title="Cancel advance"
                        onClick={() => { const reason = prompt("Why cancel this advance? (at least 5 characters)"); if (reason && reason.trim().length >= 5) cancel.mutate({ id: a.id, reason }); }}>
                        <XCircle className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <AdvanceDialog onClose={() => setAdding(false)} />}
    </div>
  );
}

function AdvanceDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: lookups } = useQuery({ queryKey: ["dtc-lookups"], queryFn: fetchDtcLookups });
  const contractorOptions: F9Option[] = useMemo(
    () => (lookups?.contractors ?? []).map(c => ({ value: c.id, label: c.name, sublabel: c.code ?? c.phone })), [lookups]);
  const [contractorId, setContractorId] = useState<string | null>(null);
  const routeOptions: F9Option[] = useMemo(
    () => (lookups?.routes ?? []).filter(r => r.contractorId === contractorId).map(r => ({ value: r.id, label: r.name, sublabel: r.code })),
    [lookups, contractorId]);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [paidOn, setPaidOn] = useState(todayIST());
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<PayMode>("neft");
  const [reference, setReference] = useState("");
  const [recoverMonth, setRecoverMonth] = useState(todayIST().slice(0, 7));
  const [notes, setNotes] = useState("");
  const mut = useMutation({
    mutationFn: () => recordAdvance({
      contractorId: contractorId!, routeId, paidOn, amount: Number(amount), mode,
      reference: reference || null, recoverMonth, notes: notes || null,
    }),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-advances"] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Record advance</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <Field label="Contractor" required>
            <F9SearchSelect value={contractorId} onChange={v => { setContractorId(v); setRouteId(null); }} options={contractorOptions} placeholder="Select contractor" />
          </Field>
          {routeOptions.length > 1 && (
            <Field label="Recover from route (optional)">
              <F9SearchSelect value={routeId} onChange={setRouteId} options={routeOptions} placeholder="First route bill" allowClear />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Paid on" required><Input type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} className="erp-input" /></Field>
            <Field label="Amount (₹)" required><Input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} className="erp-input num" /></Field>
            <Field label="Mode" required>
              <select value={mode} onChange={e => setMode(e.target.value as PayMode)} className="erp-input w-full">
                {PAY_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
            <Field label="UTR / cheque no."><Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" /></Field>
            <Field label="Recover in bill month" required><MonthInput value={recoverMonth} onChange={setRecoverMonth} /></Field>
          </div>
          <Field label="Notes"><Input value={notes} onChange={e => setNotes(e.target.value)} className="erp-input" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!contractorId || !(Number(amount) > 0) || !paidOn || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Saving…" : "Record advance"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
