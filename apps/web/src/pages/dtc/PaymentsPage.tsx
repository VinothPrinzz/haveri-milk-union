// apps/web/src/pages/dtc/PaymentsPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → Payments  (/dtc/payments/*)
//
//   (index)    To pay    approved bills not yet paid, by contractor. Tick
//                        bills, then "Continue to payment".
//   record     Pay       the ticked bills and the payment form (date, mode,
//                        UTR), with the bank upload file
//   paid       Paid      payment history; a wrong payment is reversed in its row
//   advances   Advances  money paid before the bill, recovered later
// New advances: /dtc/payments/advances/new (AdvanceFormPage).
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { Link, Route, Routes, useNavigate, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { EmptyState, Field } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ArrowRight, Download, Plus, Undo2, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";
import {
  cancelAdvance, fetchAdvances, fetchPayments, fetchPendingPayments, recordPayment, reversePayment,
  type PayMode, type PendingBill,
} from "@/services/dtc";
import { MonthInput, PAY_MODES, errMsg, fmtDMY, monthLabel, rs, rs2, useDtcPerms } from "./shared";
import { RecordBody, RecordHeader, Section } from "./ui";

const modeLabel = (m: string) => PAY_MODES.find(p => p.value === m)?.label ?? m;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const REFRESH = ["dtc-pending-payments", "dtc-payments", "dtc-runs", "dtc-run", "dtc-bill", "dtc-advances"];

export default function PaymentsPage() {
  return (
    <div className="h-full overflow-auto">
      <RecordHeader
        title="Payments"
        subtitle="Pay approved bills and keep track of advances"
        tabs={[
          { to: "/dtc/payments", label: "To pay", end: true },
          { to: "/dtc/payments/paid", label: "Paid" },
          { to: "/dtc/payments/advances", label: "Advances" },
        ]}
      />
      <RecordBody wide>
        <Routes>
          <Route index element={<PendingTab />} />
          <Route path="record" element={<RecordPayment />} />
          <Route path="paid" element={<PaidTab />} />
          <Route path="advances" element={<AdvancesTab />} />
        </Routes>
      </RecordBody>
    </div>
  );
}

function groupByContractor(rows: PendingBill[]) {
  const m = new Map<string, { key: string; name: string; bank: PendingBill; bills: PendingBill[] }>();
  for (const r of rows) {
    const key = r.contractorId ?? `none:${r.billId}`;
    if (!m.has(key)) m.set(key, { key, name: r.contractorName ?? "No contractor", bank: r, bills: [] });
    m.get(key)!.bills.push(r);
  }
  return Array.from(m.values());
}

function bankFile(chosen: PendingBill[]) {
  // One line per contractor: their bills are paid in one transfer.
  const out: (string | number)[][] = [["Beneficiary Name", "Account Number", "IFSC", "Amount", "Narration"]];
  for (const g of groupByContractor(chosen)) {
    const b = g.bank;
    const months = Array.from(new Set(g.bills.map(x => monthLabel(x.month)))).join(", ");
    out.push([
      b.contractorName ?? "", b.accountNo ?? "", b.ifscCode ?? "",
      g.bills.reduce((s, x) => s + x.payable, 0).toFixed(2),
      `DTC ${months} ${g.bills.map(x => x.routeCode).join(" ")}`.slice(0, 60),
    ]);
  }
  const url = URL.createObjectURL(new Blob([toCsv(out)], { type: "text/csv" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `dtc-bank-upload_${todayIST()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── To pay ─────────────────────────────────────────────────────────
function PendingTab() {
  const navigate = useNavigate();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-pending-payments"], queryFn: fetchPendingPayments });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const groups = useMemo(() => groupByContractor(rows), [rows]);
  const chosen = rows.filter(r => selected.has(r.billId));
  const chosenTotal = chosen.reduce((s, r) => s + r.payable, 0);
  const held = rows.filter(r => r.onHold).length;
  const toggle = (ids: string[], on: boolean) => setSelected(prev => {
    const n = new Set(prev);
    ids.forEach(id => (on ? n.add(id) : n.delete(id)));
    return n;
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (rows.length === 0) return <EmptyState title="Nothing to pay" hint="Bills show up here once Finance approves a month." />;

  return (
    <>
      <p className="text-[14px]">
        <b>₹{rs(rows.reduce((s, r) => s + r.payable, 0))}</b> to pay on {plural(rows.length, "bill")}
        {held > 0 && <span className="text-warning">, {held} on hold</span>}. Tick the bills you are paying.
      </p>
      <div className="space-y-3">
        {groups.map(g => {
          const ids = g.bills.filter(b => !b.onHold).map(b => b.billId);
          const all = ids.length > 0 && ids.every(id => selected.has(id));
          return (
            <div key={g.key} className={cn("erp-panel", all && "ring-1 ring-primary")}>
              <label className="flex items-center gap-3 px-5 py-3 cursor-pointer">
                <input type="checkbox" className="h-4 w-4" disabled={ids.length === 0} checked={all} onChange={e => toggle(ids, e.target.checked)} />
                <span className="flex-1 min-w-0">
                  <span className="font-medium text-[14px]">{g.name}</span>
                  <span className="block text-[12.5px] text-muted-foreground">
                    {g.bank.accountNo ? `${g.bank.bankName ?? "Bank"} · ${g.bank.accountNo}${g.bank.ifscCode ? ` · ${g.bank.ifscCode}` : ""}` : <span className="text-warning">No bank details on record</span>}
                  </span>
                </span>
                <span className="num font-semibold text-[15px]">₹{rs(g.bills.reduce((s, b) => s + b.payable, 0))}</span>
              </label>
              <div className="border-t border-border">
                {g.bills.map(b => (
                  <label key={b.billId} className={cn("flex items-center gap-3 px-5 py-2 text-[13px] cursor-pointer hover:bg-muted/30", b.onHold && "opacity-60 cursor-default")}>
                    <input type="checkbox" className="h-4 w-4 ml-6" disabled={b.onHold} checked={selected.has(b.billId)} onChange={e => toggle([b.billId], e.target.checked)} />
                    <span className="flex-1">{b.routeName} <span className="text-muted-foreground">· {monthLabel(b.month)}</span>
                      {b.onHold && <span className="text-warning"> · on hold: {b.holdReason}</span>}
                    </span>
                    <span className="num">₹{rs(b.payable)}</span>
                  </label>
                ))}
              </div>
            </div>
          );
        })}
      </div>
      {chosen.length > 0 && (
        <div className="sticky bottom-0 z-10 -mx-4 sm:-mx-6 px-4 sm:px-6 py-3 bg-panel border-t border-border flex flex-wrap items-center gap-3 shadow-[0_-2px_10px_rgba(0,0,0,0.05)]">
          <span className="flex-1 text-[14px]">{plural(chosen.length, "bill")} ticked · <b>₹{rs2(chosenTotal)}</b></span>
          <Button size="sm" variant="outline" className="h-9" onClick={() => bankFile(chosen)}><Download className="h-3.5 w-3.5 mr-1.5" /> Bank file</Button>
          <Button size="sm" className="h-9" onClick={() => navigate(`record?bills=${chosen.map(c => c.billId).join(",")}`)}>
            Continue to payment <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
          </Button>
        </div>
      )}
    </>
  );
}

// ─── Record a payment (its own page) ────────────────────────────────
function RecordPayment() {
  const perms = useDtcPerms();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const ids = new Set((params.get("bills") ?? "").split(",").filter(Boolean));
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-pending-payments"], queryFn: fetchPendingPayments });
  const chosen = rows.filter(r => ids.has(r.billId) && !r.onHold);
  const groups = groupByContractor(chosen);
  const total = chosen.reduce((s, r) => s + r.payable, 0);
  const [paidOn, setPaidOn] = useState(todayIST());
  const [mode, setMode] = useState<PayMode>("neft");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const pay = useMutation({
    mutationFn: () => recordPayment({ billIds: chosen.map(b => b.billId), paidOn, mode, reference: reference || null, notes: notes || null }),
    onSuccess: (r) => { toast.success(r.message); REFRESH.forEach(k => qc.invalidateQueries({ queryKey: [k] })); navigate("/dtc/payments/paid"); },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (isLoading) return <p className="text-muted-foreground">Loading…</p>;
  if (chosen.length === 0) {
    return <EmptyState title="No bills to pay here" hint="They may already be paid. Go back to To pay and tick them again." />;
  }
  return (
    <>
      <Link to="/dtc/payments" className="text-[13px] text-muted-foreground hover:text-foreground">← Back to the list</Link>
      <Section title={`Paying ₹${rs2(total)}`} description={`${plural(chosen.length, "bill")} of ${plural(groups.length, "contractor")}`}>
        <div className="space-y-3">
          {groups.map(g => (
            <div key={g.key} className="text-[13.5px]">
              <div className="flex justify-between font-medium"><span>{g.name}</span><span className="num">₹{rs2(g.bills.reduce((s, b) => s + b.payable, 0))}</span></div>
              <div className="text-[12.5px] text-muted-foreground">
                {g.bank.accountNo ? `${g.bank.bankName ?? "Bank"} · ${g.bank.accountNo}${g.bank.ifscCode ? ` · ${g.bank.ifscCode}` : " · no IFSC"}` : <span className="text-warning">No bank details on record</span>}
              </div>
              <div className="text-[12.5px] text-muted-foreground">{g.bills.map(b => `${b.routeName} (${monthLabel(b.month)})`).join(", ")}</div>
            </div>
          ))}
        </div>
        <Button size="sm" variant="outline" className="h-8 mt-4" onClick={() => bankFile(chosen)}><Download className="h-3.5 w-3.5 mr-1.5" /> Download bank file</Button>
      </Section>

      {perms.pay ? (
        <Section title="Payment details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Field label="Paid on" required><Input type="date" value={paidOn} max={todayIST()} onChange={e => setPaidOn(e.target.value)} className="erp-input" /></Field>
            <Field label="How it was paid" required>
              <select value={mode} onChange={e => setMode(e.target.value as PayMode)} className="erp-input w-full">
                {PAY_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
            <Field label={mode === "cheque" ? "Cheque number" : "UTR / reference"} required={mode !== "cash"}>
              <Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" />
            </Field>
            <Field label="Notes"><Input value={notes} onChange={e => setNotes(e.target.value)} className="erp-input" /></Field>
          </div>
          {groups.length > 1 && <p className="text-[12.5px] text-muted-foreground mt-3">All these bills get the same reference. For separate transfers, pay one contractor at a time.</p>}
          <div className="flex justify-end gap-2 mt-5">
            <Button size="sm" variant="ghost" className="h-9" onClick={() => navigate("/dtc/payments")}>Cancel</Button>
            <Button size="sm" className="h-9" disabled={!paidOn || (mode !== "cash" && !reference.trim()) || pay.isPending} onClick={() => pay.mutate()}>
              {pay.isPending ? "Saving…" : `Record ₹${rs(total)} as paid`}
            </Button>
          </div>
        </Section>
      ) : <p className="text-[13px] text-muted-foreground">Finance records payments.</p>}
    </>
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
    <div className="space-y-4">
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
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px]"><b>₹{rs2(outstanding)}</b> in advances still to recover</span>
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
