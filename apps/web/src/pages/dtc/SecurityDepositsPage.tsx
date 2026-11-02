// apps/web/src/pages/dtc/SecurityDepositsPage.tsx
// DTC Billing → Security Deposits  (/dtc/setup/deposits)
// A deposit plan per contractor: the target, the monthly instalment taken
// from the contractor's bill, and what has been collected. The instalment
// never takes more than the bill can cover. Refunded when the contractor leaves.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState, Field, StatCard, fmtINR } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pencil, Plus, Undo2 } from "lucide-react";
import { todayIST } from "@/lib/istDate";
import { fetchDeposits, fetchDtcLookups, refundDeposit, saveDeposit, type DepositPlan } from "@/services/dtc";
import { errMsg, fmtDMY, rs2, useDtcPerms } from "./shared";

export default function SecurityDepositsPage() {
  const perms = useDtcPerms();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-deposits"], queryFn: fetchDeposits });
  const [editing, setEditing] = useState<DepositPlan | "new" | null>(null);
  const [refunding, setRefunding] = useState<DepositPlan | null>(null);
  const held = rows.reduce((s, r) => s + r.collected - r.refundedAmount, 0);
  const due = rows.filter(r => r.status !== "closed").reduce((s, r) => s + r.balanceDue, 0);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Security Deposits"
        subtitle="Deposit collected from contractors in monthly instalments, deducted from their bills"
        actions={perms.setup && (
          <Button size="sm" className="h-8" onClick={() => setEditing("new")}><Plus className="h-3.5 w-3.5 mr-1.5" /> New Plan</Button>
        )}
      />
      <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatCard label="Deposit held" value={fmtINR(held)} tone="info" hint="collected on approved bills, less refunds" />
          <StatCard label="Still to collect" value={fmtINR(due)} tone="warning" />
          <StatCard label="Plans" value={rows.length} hint={`${rows.filter(r => r.status === "active").length} active`} />
        </div>
        <div className="erp-panel overflow-auto">
          {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? (
            <EmptyState title="No deposit plans yet" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Contractor</th><th className="text-right">Target</th><th className="text-right">Per month</th>
                  <th className="text-right">Collected</th><th className="text-right">In draft bills</th>
                  <th className="text-right">Balance due</th><th>Status</th><th>Refund</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td>{r.contractorName}{r.contractorCode && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{r.contractorCode}</span>}</td>
                    <td className="text-right num">{rs2(r.targetAmount)}</td>
                    <td className="text-right num">{rs2(r.monthlyInstalment)}</td>
                    <td className="text-right num">{rs2(r.collected)}</td>
                    <td className="text-right num text-muted-foreground">{r.collectedPending ? rs2(r.collectedPending) : ""}</td>
                    <td className="text-right num">{rs2(r.balanceDue)}</td>
                    <td className="capitalize">{r.status}</td>
                    <td className="text-[12px]">{r.refundedAmount > 0 ? `₹${rs2(r.refundedAmount)} on ${fmtDMY(r.refundedOn)}` : ""}</td>
                    <td className="text-right whitespace-nowrap">
                      {perms.setup && r.status !== "closed" && (
                        <Button size="sm" variant="ghost" className="h-6" onClick={() => setEditing(r)}><Pencil className="h-3.5 w-3.5" /></Button>
                      )}
                      {perms.pay && r.status !== "closed" && (
                        <Button size="sm" variant="outline" className="h-6 text-[11px] ml-1" onClick={() => setRefunding(r)}>
                          <Undo2 className="h-3 w-3 mr-1" /> Refund
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          The instalment goes on the contractor's first route bill of the month, and only up to what that bill can cover,
          so a month with little work does not turn into a debt.
        </p>
      </div>
      {editing && <PlanDialog plan={editing === "new" ? null : editing} existing={rows} onClose={() => setEditing(null)} />}
      {refunding && <RefundDialog plan={refunding} onClose={() => setRefunding(null)} />}
    </div>
  );
}

function PlanDialog({ plan, existing, onClose }: { plan: DepositPlan | null; existing: DepositPlan[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: lookups } = useQuery({ queryKey: ["dtc-lookups"], queryFn: fetchDtcLookups });
  const taken = new Set(existing.map(e => e.contractorId));
  const options: F9Option[] = useMemo(
    () => (lookups?.contractors ?? [])
      .filter(c => plan?.contractorId === c.id || !taken.has(c.id))
      .map(c => ({ value: c.id, label: c.name, sublabel: c.code ?? c.phone })),
    [lookups, plan]); // eslint-disable-line react-hooks/exhaustive-deps
  const [contractorId, setContractorId] = useState<string | null>(plan?.contractorId ?? null);
  const [target, setTarget] = useState(plan ? String(plan.targetAmount) : "");
  const [instalment, setInstalment] = useState(plan ? String(plan.monthlyInstalment) : "");
  const [opening, setOpening] = useState(plan ? String(plan.openingCollected) : "0");
  const [status, setStatus] = useState<DepositPlan["status"]>(plan?.status ?? "active");
  const [notes, setNotes] = useState(plan?.notes ?? "");
  const mut = useMutation({
    mutationFn: () => saveDeposit({
      contractorId: contractorId!, targetAmount: Number(target), monthlyInstalment: Number(instalment),
      openingCollected: Number(opening) || 0, status, notes: notes || null,
    }),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-deposits"] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const valid = !!contractorId && Number(target) > 0 && Number(instalment) > 0;
  const months = valid ? Math.ceil(Math.max(0, Number(target) - (Number(opening) || 0)) / Number(instalment)) : 0;
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{plan ? `Deposit plan: ${plan.contractorName}` : "New Deposit Plan"}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          {!plan && (
            <Field label="Contractor" required>
              <F9SearchSelect value={contractorId} onChange={setContractorId} options={options} placeholder="Select contractor" />
            </Field>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Target deposit (₹)" required><Input type="number" min="0" value={target} onChange={e => setTarget(e.target.value)} className="erp-input num" /></Field>
            <Field label="Instalment per month (₹)" required><Input type="number" min="0" value={instalment} onChange={e => setInstalment(e.target.value)} className="erp-input num" /></Field>
            <Field label="Already collected before (₹)"><Input type="number" min="0" value={opening} onChange={e => setOpening(e.target.value)} className="erp-input num" /></Field>
            <Field label="Status">
              <select value={status} onChange={e => setStatus(e.target.value as DepositPlan["status"])} className="erp-input w-full">
                <option value="active">Active: deduct every month</option>
                <option value="paused">Paused</option>
              </select>
            </Field>
          </div>
          {valid && <p className="text-[12px] text-muted-foreground">About {months} month{months === 1 ? "" : "s"} to complete.</p>}
          <Field label="Notes"><Textarea value={notes} onChange={e => setNotes(e.target.value)} className="erp-input min-h-[50px]" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>{mut.isPending ? "Saving…" : "Save Plan"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RefundDialog({ plan, onClose }: { plan: DepositPlan; onClose: () => void }) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState(String(plan.collected));
  const [date, setDate] = useState(todayIST());
  const [reference, setReference] = useState("");
  const mut = useMutation({
    mutationFn: () => refundDeposit(plan.id, { amount: Number(amount), refundedOn: date, reference: reference || null }),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-deposits"] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Refund deposit: {plan.contractorName}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <p>Collected so far: <b>₹{rs2(plan.collected)}</b>. Recording the refund closes the plan.</p>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Amount refunded (₹)" required><Input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} className="erp-input num" /></Field>
            <Field label="Date" required><Input type="date" value={date} onChange={e => setDate(e.target.value)} className="erp-input" /></Field>
          </div>
          <Field label="UTR / cheque no."><Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!(Number(amount) > 0) || !date || mut.isPending} onClick={() => mut.mutate()}>{mut.isPending ? "Saving…" : "Record Refund"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
