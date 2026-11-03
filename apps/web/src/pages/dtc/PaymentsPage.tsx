// apps/web/src/pages/dtc/PaymentsPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → Payments & Advances  (/dtc/payments, ?tab=paid|advances)
//
//   To pay    approved bills not yet paid, grouped by contractor. Tick the
//             bills; the payment details (date, mode, UTR) open below the
//             table, with the bank upload file for the same selection.
//   Paid      payment history; a wrong payment is reversed in its row.
//   Advances  money paid mid-month, recovered from a chosen month's bill.
//             New advances are recorded on their own page.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState, Field, StatCard, fmtINR } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { AlertTriangle, Banknote, Download, Plus, Undo2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";
import {
  cancelAdvance, fetchAdvances, fetchPayments, fetchPendingPayments, recordPayment, reversePayment,
  type PayMode, type PendingBill,
} from "@/services/dtc";
import { MonthInput, PAY_MODES, errMsg, fmtDMY, monthLabel, rs, rs2, useDtcPerms } from "./shared";

const modeLabel = (m: string) => PAY_MODES.find(p => p.value === m)?.label ?? m;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const REFRESH = ["dtc-pending-payments", "dtc-payments", "dtc-runs", "dtc-run", "dtc-bill", "dtc-advances"];

export default function PaymentsPage() {
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") ?? "pending";
  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Payments & Advances" subtitle="Pay approved DTC bills, keep the payment record, and track advances" />
      <div className="flex-1 overflow-auto p-3 sm:p-4">
        <Tabs value={tab} onValueChange={v => setParams(v === "pending" ? {} : { tab: v })}>
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

// ─── To pay ─────────────────────────────────────────────────────────
function PendingTab() {
  const perms = useDtcPerms();
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-pending-payments"], queryFn: fetchPendingPayments });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [paidOn, setPaidOn] = useState(todayIST());
  const [mode, setMode] = useState<PayMode>("neft");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");

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
  const contractors = new Set(chosen.map(b => b.contractorId)).size;
  const missingBank = chosen.filter(r => !r.accountNo || !r.ifscCode);

  const toggle = (ids: string[], on: boolean) => setSelected(prev => {
    const n = new Set(prev);
    ids.forEach(id => (on ? n.add(id) : n.delete(id)));
    return n;
  });

  const pay = useMutation({
    mutationFn: () => recordPayment({ billIds: chosen.map(b => b.billId), paidOn, mode, reference: reference || null, notes: notes || null }),
    onSuccess: (r) => {
      toast.success(r.message);
      REFRESH.forEach(k => qc.invalidateQueries({ queryKey: [k] }));
      setSelected(new Set()); setReference(""); setNotes("");
    },
    onError: (e) => toast.error(errMsg(e)),
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
    const url = URL.createObjectURL(new Blob([toCsv(out)], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `dtc-bank-upload_${todayIST()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-3 mt-3">
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <StatCard label="Waiting payment" value={fmtINR(rows.reduce((s, r) => s + r.payable, 0), false)} hint={plural(rows.length, "bill")} tone="warning" />
        <StatCard label="On hold" value={rows.filter(r => r.onHold).length} hint="released on the bill page" tone={rows.some(r => r.onHold) ? "danger" : "default"} />
        <StatCard label="Ticked" value={fmtINR(chosenTotal, false)} hint={`${plural(chosen.length, "bill")} · ${plural(contractors, "contractor")}`} tone="info" />
      </div>

      <div className="erp-panel overflow-auto">
        {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? (
          <EmptyState title="Nothing to pay" hint="Bills appear here once a month is approved by Finance." />
        ) : (
          <table className="erp-table text-[12.5px]">
            <thead>
              <tr>
                <th style={{ width: 30 }}>
                  <input type="checkbox" aria-label="Tick all" checked={payable.length > 0 && payable.every(r => selected.has(r.billId))}
                    onChange={e => toggle(payable.map(r => r.billId), e.target.checked)} />
                </th>
                <th>Contractor / route bill</th><th>Month</th><th>Bank account</th><th className="text-right">Payable (₹)</th>
              </tr>
            </thead>
            <tbody>
              {groups.map(g => {
                const ids = g.bills.filter(b => !b.onHold).map(b => b.billId);
                const total = g.bills.reduce((s, b) => s + b.payable, 0);
                return [
                  <tr key={g.key} className="bg-muted/40 font-medium">
                    <td><input type="checkbox" aria-label={`Tick ${g.name}`} disabled={ids.length === 0} checked={ids.length > 0 && ids.every(id => selected.has(id))} onChange={e => toggle(ids, e.target.checked)} /></td>
                    <td>{g.name}{g.bank.contractorCode && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{g.bank.contractorCode}</span>}</td>
                    <td />
                    <td className="text-[12px] font-normal">
                      {g.bank.accountNo
                        ? <>{g.bank.bankName ?? ""} · {g.bank.accountNo} · {g.bank.ifscCode ?? <span className="text-warning">no IFSC</span>}</>
                        : <span className="text-warning">No bank details: add them in Masters → Contractors</span>}
                    </td>
                    <td className="text-right num">{rs(total)}</td>
                  </tr>,
                  ...g.bills.map(b => (
                    <tr key={b.billId} className={b.onHold ? "opacity-60" : ""}>
                      <td><input type="checkbox" disabled={b.onHold} checked={selected.has(b.billId)} onChange={e => toggle([b.billId], e.target.checked)} /></td>
                      <td className="pl-7">
                        <Link to={`/dtc/bills/${b.month}/${b.billId}`} className="hover:underline">
                          <span className="font-mono text-[11px] text-muted-foreground mr-1.5">{b.routeCode}</span>{b.routeName}
                        </Link>
                      </td>
                      <td>{monthLabel(b.month)}</td>
                      <td className="text-[12px] text-warning">{b.onHold ? `On hold: ${b.holdReason ?? ""}` : ""}</td>
                      <td className="text-right num">{rs(b.payable)}</td>
                    </tr>
                  )),
                ];
              })}
            </tbody>
          </table>
        )}
      </div>

      {chosen.length > 0 && (
        <div className="erp-panel border-l-4 border-l-primary sticky bottom-0 z-10 shadow-[0_-2px_10px_rgba(0,0,0,0.06)]">
          <div className="px-4 pt-3 pb-2 border-b border-border flex flex-wrap items-center gap-2">
            <div className="flex-1">
              <div className="text-[13.5px] font-semibold">Payment details</div>
              <div className="text-[12px] text-muted-foreground">
                {plural(chosen.length, "bill")} of {plural(contractors, "contractor")}, total <b className="text-foreground">₹{rs2(chosenTotal)}</b>
              </div>
            </div>
            <Button size="sm" variant="outline" className="h-8" onClick={bankFile}><Download className="h-3.5 w-3.5 mr-1.5" /> Bank upload file (CSV)</Button>
          </div>
          <div className="p-4 space-y-3">
            {missingBank.length > 0 && (
              <div className="text-[12.5px] text-warning flex gap-2"><AlertTriangle className="h-4 w-4 shrink-0" />{plural(missingBank.length, "ticked bill")} without an account number or IFSC on the contractor.</div>
            )}
            {perms.pay ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
                <Field label="Paid on" required><Input type="date" value={paidOn} max={todayIST()} onChange={e => setPaidOn(e.target.value)} className="erp-input" /></Field>
                <Field label="Mode" required>
                  <select value={mode} onChange={e => setMode(e.target.value as PayMode)} className="erp-input w-full">
                    {PAY_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
                  </select>
                </Field>
                <Field label={mode === "cheque" ? "Cheque number" : "UTR / reference"} required={mode !== "cash"}>
                  <Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" />
                </Field>
                <Field label="Notes"><Input value={notes} onChange={e => setNotes(e.target.value)} className="erp-input" /></Field>
                <Button size="sm" className="h-8" disabled={!paidOn || (mode !== "cash" && !reference.trim()) || pay.isPending} onClick={() => pay.mutate()}>
                  <Banknote className="h-3.5 w-3.5 mr-1.5" /> {pay.isPending ? "Saving…" : `Record ₹${rs(chosenTotal)} paid`}
                </Button>
              </div>
            ) : <p className="text-[12.5px] text-muted-foreground">Finance records the payment.</p>}
            {contractors > 1 && perms.pay && <p className="text-[11.5px] text-muted-foreground">All ticked bills get the same reference. For separate transfers, tick one contractor at a time.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Paid ───────────────────────────────────────────────────────────
function PaidTab() {
  const perms = useDtcPerms();
  const qc = useQueryClient();
  const [month, setMonth] = useState("");
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-payments", month], queryFn: () => fetchPayments(month ? { month } : {}) });
  const [reversing, setReversing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const rev = useMutation({
    mutationFn: () => reversePayment(reversing!, reason),
    onSuccess: (r) => { toast.success(r.message); setReversing(null); setReason(""); REFRESH.forEach(k => qc.invalidateQueries({ queryKey: [k] })); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const live = rows.filter(r => !r.reversedAt);
  return (
    <div className="space-y-3 mt-3">
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Bill month"><MonthInput value={month} onChange={setMonth} className="w-40" /></Field>
        {month && <Button size="sm" variant="ghost" className="h-8" onClick={() => setMonth("")}>All months</Button>}
        <div className="flex-1" />
        <span className="text-[12.5px] pb-1.5">Paid <b>₹{rs2(live.reduce((s, r) => s + r.amount, 0))}</b> · {plural(live.length, "bill")}</span>
      </div>
      <div className="erp-panel overflow-auto">
        {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? <EmptyState title="No payments yet" /> : (
          <table className="erp-table text-[12.5px]">
            <thead><tr><th>Paid on</th><th>Contractor</th><th>Route bill</th><th>Bill month</th><th>Mode</th><th>Reference</th><th className="text-right">Amount</th><th>By</th><th /></tr></thead>
            <tbody>
              {rows.map(r => [
                <tr key={r.id} className={r.reversedAt ? "text-muted-foreground" : ""}>
                  <td className={r.reversedAt ? "line-through" : ""}>{fmtDMY(r.paidOn)}</td>
                  <td>{r.contractorName ?? ""}</td>
                  <td><Link to={`/dtc/bills/${r.month}/${r.billId}`} className="hover:underline"><span className="font-mono text-[11px] text-muted-foreground mr-1">{r.routeCode}</span>{r.routeName}</Link></td>
                  <td>{monthLabel(r.month)}</td>
                  <td>{modeLabel(r.mode)}</td>
                  <td className="font-mono text-[11.5px]">{r.reference ?? ""}</td>
                  <td className={cn("text-right num", r.reversedAt && "line-through")}>{rs2(r.amount)}</td>
                  <td className="text-[12px]">{r.reversedAt ? <>Reversed by {r.reversedByName ?? ""}<span className="block text-[11px]">{r.reverseReason}</span></> : r.createdByName ?? ""}</td>
                  <td className="text-right">
                    {perms.pay && !r.reversedAt && reversing !== r.id && (
                      <Button size="sm" variant="ghost" className="h-6 text-destructive text-[11.5px]" onClick={() => { setReversing(r.id); setReason(""); }}>
                        <Undo2 className="h-3.5 w-3.5 mr-1" /> Reverse
                      </Button>
                    )}
                  </td>
                </tr>,
                reversing === r.id && (
                  <tr key={`${r.id}-rev`} className="bg-destructive/5">
                    <td colSpan={9}>
                      <div className="flex flex-wrap items-center gap-2 py-1">
                        <span className="text-[12.5px]">Reverse this payment? The bill becomes unpaid again.</span>
                        <Input autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (at least 5 characters), e.g. transfer returned by bank" className="erp-input h-7 flex-1 min-w-[240px]" />
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => setReversing(null)}>Cancel</Button>
                        <Button size="sm" variant="destructive" className="h-7" disabled={reason.trim().length < 5 || rev.isPending} onClick={() => rev.mutate()}>Reverse payment</Button>
                      </div>
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ─── Advances ───────────────────────────────────────────────────────
function AdvancesTab() {
  const perms = useDtcPerms();
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-advances"], queryFn: fetchAdvances });
  const [cancelling, setCancelling] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const cancel = useMutation({
    mutationFn: () => cancelAdvance(cancelling!, reason),
    onSuccess: (r) => { toast.success(r.message); setCancelling(null); setReason(""); qc.invalidateQueries({ queryKey: ["dtc-advances"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const outstanding = rows.filter(r => !r.cancelledAt && r.recoveredRunStatus !== "approved").reduce((s, r) => s + r.amount, 0);
  return (
    <div className="space-y-3 mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[12.5px]">Not yet recovered on an approved bill: <b>₹{rs2(outstanding)}</b></span>
        <div className="flex-1" />
        {perms.pay && (
          <Button size="sm" className="h-8" asChild>
            <Link to="/dtc/payments/advances/new"><Plus className="h-3.5 w-3.5 mr-1.5" /> Record advance</Link>
          </Button>
        )}
      </div>
      <div className="erp-panel overflow-auto">
        {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? <EmptyState title="No advances" /> : (
          <table className="erp-table text-[12.5px]">
            <thead><tr><th>Paid on</th><th>Contractor</th><th className="text-right">Amount</th><th>Mode / reference</th><th>Recover in</th><th>Status</th><th>By</th><th /></tr></thead>
            <tbody>
              {rows.map(a => [
                <tr key={a.id} className={a.cancelledAt ? "text-muted-foreground" : ""}>
                  <td>{fmtDMY(a.paidOn)}</td>
                  <td>{a.contractorName}{a.routeCode && <span className="ml-1 text-[11px] text-muted-foreground">({a.routeCode})</span>}</td>
                  <td className={cn("text-right num", a.cancelledAt && "line-through")}>{rs2(a.amount)}</td>
                  <td>{modeLabel(a.mode)} {a.reference ?? ""}</td>
                  <td>{monthLabel(a.recoverMonth)}</td>
                  <td className="text-[12px]">
                    {a.cancelledAt ? <span title={a.cancelReason ?? ""}>Cancelled</span>
                      : a.recoveredInMonth
                        ? (a.recoveredRunStatus === "approved" ? <span className="text-success">Recovered</span> : <Link to={`/dtc/bills/${a.recoveredInMonth}`} className="hover:underline">On draft bill</Link>)
                        : <span className="text-warning">Waiting for that month's bills</span>}
                  </td>
                  <td className="text-[12px]">{a.createdByName ?? ""}</td>
                  <td className="text-right">
                    {perms.pay && !a.cancelledAt && a.recoveredRunStatus !== "approved" && cancelling !== a.id && (
                      <Button size="sm" variant="ghost" className="h-6 text-destructive text-[11.5px]" onClick={() => { setCancelling(a.id); setReason(""); }}>
                        <XCircle className="h-3.5 w-3.5 mr-1" /> Cancel
                      </Button>
                    )}
                  </td>
                </tr>,
                cancelling === a.id && (
                  <tr key={`${a.id}-c`} className="bg-destructive/5">
                    <td colSpan={8}>
                      <div className="flex flex-wrap items-center gap-2 py-1">
                        <span className="text-[12.5px]">Cancel this advance?</span>
                        <Input autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Reason (at least 5 characters)" className="erp-input h-7 flex-1 min-w-[240px]" />
                        <Button size="sm" variant="ghost" className="h-7" onClick={() => setCancelling(null)}>Keep it</Button>
                        <Button size="sm" variant="destructive" className="h-7" disabled={reason.trim().length < 5 || cancel.isPending} onClick={() => cancel.mutate()}>Cancel advance</Button>
                      </div>
                    </td>
                  </tr>
                ),
              ])}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
