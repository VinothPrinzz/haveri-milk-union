// apps/web/src/pages/dtc/DepositRecordPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → one contractor's security deposit
//   /dtc/setup/deposits/new             pick the contractor
//   /dtc/setup/deposits/:contractorId   the plan, collections and refund
//
//   Plan          target, instalment, already collected, status (form on the page)
//   Collections   every instalment taken from a bill, month by month
//   Refund        recorded when the contractor leaves; closes the plan
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { todayIST } from "@/lib/istDate";
import { fetchDeposits, fetchDepositRecord, fetchDtcLookups, refundDeposit, saveDeposit, type DepositPlan } from "@/services/dtc";
import { RunStatusBadge, errMsg, fmtDMY, fmtStamp, monthLabel, rs2, useDtcPerms } from "./shared";
import { Progress, RecordHeader, Section, SectionTabs } from "./ui";

export default function DepositRecordPage() {
  const { contractorId = "" } = useParams();
  if (contractorId === "new") return <PickContractor />;
  return <DepositRecord contractorId={contractorId} />;
}

function PickContractor() {
  const navigate = useNavigate();
  const { data: lookups } = useQuery({ queryKey: ["dtc-lookups"], queryFn: fetchDtcLookups });
  const { data: plans = [] } = useQuery({ queryKey: ["dtc-deposits"], queryFn: fetchDeposits });
  const taken = new Set(plans.map(p => p.contractorId));
  const options: F9Option[] = useMemo(
    () => (lookups?.contractors ?? []).filter(c => !taken.has(c.id)).map(c => ({ value: c.id, label: c.name, sublabel: c.code ?? c.phone })),
    [lookups, plans]); // eslint-disable-line react-hooks/exhaustive-deps
  const [id, setId] = useState<string | null>(null);
  return (
    <div className="h-full overflow-auto">
      <RecordHeader back={{ to: "/dtc/setup/deposits", label: "Security Deposits" }} title="New deposit plan" subtitle="Pick the contractor; the plan is set up on their deposit page." />
      <div className="p-3 sm:p-5 max-w-2xl">
        <Section title="Contractor" description="Contractors who already have a plan are not listed.">
          <div className="flex items-end gap-2">
            <div className="flex-1"><F9SearchSelect value={id} onChange={setId} options={options} placeholder="Select contractor" /></div>
            <Button size="sm" className="h-8" disabled={!id} onClick={() => navigate(`/dtc/setup/deposits/${id}`)}>Continue</Button>
          </div>
        </Section>
      </div>
    </div>
  );
}

function DepositRecord({ contractorId }: { contractorId: string }) {
  const perms = useDtcPerms();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["dtc-deposit-record", contractorId], queryFn: () => fetchDepositRecord(contractorId) });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dtc-deposit-record", contractorId] });
    qc.invalidateQueries({ queryKey: ["dtc-deposits"] });
  };
  if (isLoading || !data) return <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
  const { contractor, plan } = data;
  const closed = plan?.status === "closed";

  return (
    <div className="h-full overflow-auto">
      <RecordHeader
        back={{ to: "/dtc/setup/deposits", label: "Security Deposits" }}
        code={contractor.code ?? undefined}
        title={contractor.name}
        subtitle={`Security deposit · ${contractor.phone}`}
        status={plan
          ? <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ${plan.status === "active" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>{plan.status}</span>
          : <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">No plan</span>}
        facts={plan ? [
          { label: "Target", value: `₹${rs2(plan.targetAmount)}` },
          { label: "Per month", value: `₹${rs2(plan.monthlyInstalment)}` },
          { label: "Collected", value: `₹${rs2(data.collected)}`, tone: "info", hint: data.collectedPending ? `+ ₹${rs2(data.collectedPending)} on draft bills` : "on approved bills" },
          { label: "Balance due", value: `₹${rs2(data.balanceDue)}`, tone: data.balanceDue > 0 ? "warning" : "success" },
          { label: "Months to go", value: plan.monthlyInstalment > 0 ? Math.ceil(data.balanceDue / plan.monthlyInstalment) : "—" },
          { label: "Refunded", value: plan.refundedAmount ? `₹${rs2(plan.refundedAmount)}` : "—", hint: plan.refundedOn ? fmtDMY(plan.refundedOn) : undefined },
        ] : undefined}
      >
        {plan && <div className="mt-3 max-w-xl"><Progress value={data.collected} max={plan.targetAmount} tone={data.balanceDue === 0 ? "success" : "primary"} /></div>}
      </RecordHeader>
      <SectionTabs sections={[
        { id: "plan", label: "Plan" },
        { id: "collections", label: "Collections", count: data.collections.length },
        ...(plan ? [{ id: "refund", label: "Refund" }] : []),
      ]} />

      <div className="p-3 sm:p-5 space-y-4 max-w-5xl">
        <PlanSection contractorId={contractorId} plan={plan} canEdit={perms.setup && !closed} onSaved={refresh} />

        <Section id="collections" title="Collections" description="Instalments taken from the contractor's bills (the first route bill of each month)" flush>
          {data.collections.length === 0 ? <p className="p-4 text-[12.5px] text-muted-foreground">Nothing collected yet.</p> : (
            <table className="erp-table text-[12.5px]">
              <thead><tr><th>Month</th><th>Status</th><th>Route bill</th><th className="text-right">Amount</th><th>Remarks</th></tr></thead>
              <tbody>
                {data.collections.map(c => (
                  <tr key={c.id}>
                    <td>{monthLabel(c.month)}</td>
                    <td><RunStatusBadge status={c.runStatus} /></td>
                    <td><span className="font-mono text-[11px] text-muted-foreground mr-1">{c.routeCode}</span>{c.routeName}</td>
                    <td className="text-right num">{rs2(c.amount)}</td>
                    <td className="text-[12px]">{c.remarks ?? ""}{c.source === "manual" && <span className="ml-1 text-muted-foreground">(entered by hand)</span>}</td>
                  </tr>
                ))}
                {plan && plan.openingCollected > 0 && (
                  <tr><td colSpan={3} className="text-muted-foreground">Collected before this system</td><td className="text-right num">{rs2(plan.openingCollected)}</td><td /></tr>
                )}
              </tbody>
            </table>
          )}
        </Section>

        {plan && <RefundSection plan={plan} collected={data.collected} canEdit={perms.pay && !closed} onSaved={refresh} />}
      </div>
    </div>
  );
}

function PlanSection({ contractorId, plan, canEdit, onSaved }: {
  contractorId: string; plan: NonNullable<Awaited<ReturnType<typeof fetchDepositRecord>>>["plan"]; canEdit: boolean; onSaved: () => void;
}) {
  const blank = useMemo(() => ({
    target: plan ? String(plan.targetAmount) : "",
    instalment: plan ? String(plan.monthlyInstalment) : "",
    opening: plan ? String(plan.openingCollected) : "0",
    status: (plan?.status === "paused" ? "paused" : "active") as DepositPlan["status"],
    notes: plan?.notes ?? "",
  }), [plan]);
  const [f, setF] = useState(blank);
  useEffect(() => setF(blank), [blank]);
  const dirty = JSON.stringify(f) !== JSON.stringify(blank);
  const mut = useMutation({
    mutationFn: () => saveDeposit({
      contractorId, targetAmount: Number(f.target), monthlyInstalment: Number(f.instalment),
      openingCollected: Number(f.opening) || 0, status: f.status, notes: f.notes || null,
    }),
    onSuccess: (r) => { toast.success(r.message); onSaved(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const valid = Number(f.target) > 0 && Number(f.instalment) > 0;
  const months = valid ? Math.ceil(Math.max(0, Number(f.target) - (Number(f.opening) || 0)) / Number(f.instalment)) : 0;
  return (
    <Section id="plan" title="Plan"
      description={plan ? `Last changed ${fmtStamp(plan.updatedAt)}` : "No plan yet. Fill in the target and the monthly instalment."}>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <Field label="Target deposit (₹)" required><Input type="number" min="0" disabled={!canEdit} value={f.target} onChange={e => setF({ ...f, target: e.target.value })} className="erp-input num" /></Field>
        <Field label="Instalment per month (₹)" required><Input type="number" min="0" disabled={!canEdit} value={f.instalment} onChange={e => setF({ ...f, instalment: e.target.value })} className="erp-input num" /></Field>
        <Field label="Collected before (₹)"><Input type="number" min="0" disabled={!canEdit} value={f.opening} onChange={e => setF({ ...f, opening: e.target.value })} className="erp-input num" /></Field>
        <Field label="Status">
          <select value={f.status} disabled={!canEdit} onChange={e => setF({ ...f, status: e.target.value as DepositPlan["status"] })} className="erp-input w-full">
            <option value="active">Active: deduct every month</option>
            <option value="paused">Paused</option>
          </select>
        </Field>
        <Field label="Notes" className="sm:col-span-2 lg:col-span-4">
          <Textarea disabled={!canEdit} value={f.notes} onChange={e => setF({ ...f, notes: e.target.value })} className="erp-input min-h-[50px]" placeholder="e.g. As per agreement clause 12, ₹1,00,000 over 10 months" />
        </Field>
      </div>
      <p className="text-[12px] text-muted-foreground mt-2">
        {valid ? `About ${months} month${months === 1 ? "" : "s"} to complete. ` : ""}
        The instalment never takes more than the bill can cover, so a month with little work does not become a debt.
      </p>
      {canEdit && (
        <div className="flex items-center justify-end gap-2 border-t border-border pt-3 mt-3">
          {dirty && <span className="text-[12px] text-muted-foreground mr-auto">Unsaved changes</span>}
          <Button size="sm" variant="ghost" className="h-8" disabled={!dirty} onClick={() => setF(blank)}>Reset</Button>
          <Button size="sm" className="h-8" disabled={!valid || !dirty || mut.isPending} onClick={() => mut.mutate()}>{mut.isPending ? "Saving…" : plan ? "Save plan" : "Start plan"}</Button>
        </div>
      )}
    </Section>
  );
}

function RefundSection({ plan, collected, canEdit, onSaved }: {
  plan: NonNullable<NonNullable<Awaited<ReturnType<typeof fetchDepositRecord>>>["plan"]>; collected: number; canEdit: boolean; onSaved: () => void;
}) {
  const [amount, setAmount] = useState(String(collected));
  const [date, setDate] = useState(todayIST());
  const [reference, setReference] = useState("");
  const mut = useMutation({
    mutationFn: () => refundDeposit(plan.id, { amount: Number(amount), refundedOn: date, reference: reference || null }),
    onSuccess: (r) => { toast.success(r.message); onSaved(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (plan.status === "closed") {
    return (
      <Section id="refund" title="Refund">
        <p className="text-[13px]">Refunded <b>₹{rs2(plan.refundedAmount)}</b> on {fmtDMY(plan.refundedOn)}{plan.refundReference ? ` (${plan.refundReference})` : ""}. The plan is closed.</p>
      </Section>
    );
  }
  return (
    <Section id="refund" title="Refund" description="When the contractor leaves. Recording the refund closes the plan.">
      {!canEdit ? <p className="text-[12.5px] text-muted-foreground">Finance records the refund.</p> : (
        <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
          <Field label="Amount refunded (₹)" required><Input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} className="erp-input num" /></Field>
          <Field label="Date" required><Input type="date" value={date} onChange={e => setDate(e.target.value)} className="erp-input" /></Field>
          <Field label="UTR / cheque no."><Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" /></Field>
          <Button size="sm" variant="outline" className="h-8" disabled={!(Number(amount) > 0) || !date || mut.isPending}
            onClick={() => { if (confirm(`Record a refund of ₹${rs2(Number(amount))} and close the plan?`)) mut.mutate(); }}>
            {mut.isPending ? "Saving…" : "Record refund"}
          </Button>
        </div>
      )}
      <p className="text-[11.5px] text-muted-foreground mt-2">Collected on approved bills: ₹{rs2(collected)}.</p>
    </Section>
  );
}
