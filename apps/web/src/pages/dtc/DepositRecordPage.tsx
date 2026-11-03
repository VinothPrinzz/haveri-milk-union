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
import { Route, Routes, useNavigate, useParams } from "react-router-dom";
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
import { RunStatusBadge, errMsg, fmtDMY, fmtStamp, monthLabel, rs, rs2, useDtcPerms } from "./shared";
import { Progress, RecordBody, RecordHeader, Section, Summary } from "./ui";

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
  if (isLoading || !data) return <div className="p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
  const { contractor, plan } = data;
  const closed = plan?.status === "closed";
  const base = `/dtc/setup/deposits/${contractorId}`;

  return (
    <div className="h-full overflow-auto">
      <RecordHeader
        back={{ to: "/dtc/setup/deposits", label: "All deposits" }}
        code={contractor.code ?? undefined}
        title={contractor.name}
        subtitle="Security deposit"
        status={plan
          ? <span className={`rounded px-1.5 py-0.5 text-[11px] font-medium capitalize ${plan.status === "active" ? "bg-success/15 text-success" : "bg-muted text-muted-foreground"}`}>{plan.status}</span>
          : undefined}
        facts={plan ? [
          { label: "Target", value: `₹${rs(plan.targetAmount)}` },
          { label: "Collected", value: `₹${rs(data.collected)}`, tone: "info" },
          { label: "Still to collect", value: `₹${rs(data.balanceDue)}` },
        ] : undefined}
        tabs={plan ? [
          { to: base, label: "Overview", end: true },
          ...(perms.setup && !closed ? [{ to: `${base}/edit`, label: "Edit plan" }] : []),
          { to: `${base}/collections`, label: "Collections", count: data.collections.length },
          { to: `${base}/refund`, label: "Refund" },
        ] : undefined}
      />
      <RecordBody>
        {!plan ? (
          perms.setup ? <PlanSection contractorId={contractorId} plan={null} canEdit onSaved={refresh} />
            : <p className="text-[13.5px] text-muted-foreground">No deposit plan for this contractor.</p>
        ) : (
          <Routes>
            <Route index element={<DepositOverview data={data} />} />
            {perms.setup && !closed && <Route path="edit" element={<PlanSection contractorId={contractorId} plan={plan} canEdit onSaved={refresh} />} />}
            <Route path="collections" element={<Collections data={data} />} />
            <Route path="refund" element={<RefundSection plan={plan} collected={data.collected} canEdit={perms.pay && !closed} onSaved={refresh} />} />
          </Routes>
        )}
      </RecordBody>
    </div>
  );
}

function DepositOverview({ data }: { data: NonNullable<Awaited<ReturnType<typeof fetchDepositRecord>>> }) {
  const plan = data.plan!;
  const months = plan.monthlyInstalment > 0 ? Math.ceil(data.balanceDue / plan.monthlyInstalment) : 0;
  return (
    <Section title="Progress">
      <Progress value={data.collected} max={plan.targetAmount} tone={data.balanceDue === 0 ? "success" : "primary"} />
      <Summary>
        <span className="block mt-3">
          ₹{rs(data.collected)} of ₹{rs(plan.targetAmount)} collected.
          {plan.status === "closed"
            ? ` Refunded ₹${rs(plan.refundedAmount)} on ${fmtDMY(plan.refundedOn)}; the plan is closed.`
            : data.balanceDue > 0
              ? ` ₹${rs(plan.monthlyInstalment)} is taken from the bill each month, so about ${months} more month${months === 1 ? "" : "s"}.`
              : " The full deposit has been collected."}
          {plan.status === "paused" && " The plan is paused: nothing is taken until it is made active again."}
        </span>
      </Summary>
      {data.collectedPending > 0 && <p className="text-[12.5px] text-muted-foreground mt-2">₹{rs2(data.collectedPending)} more is on bills that are not approved yet.</p>}
      {plan.notes && <p className="text-[13px] mt-3">{plan.notes}</p>}
    </Section>
  );
}

function Collections({ data }: { data: NonNullable<Awaited<ReturnType<typeof fetchDepositRecord>>> }) {
  return (
    <Section title="Collections" description="Taken from the contractor's first route bill each month" flush>
      {data.collections.length === 0 ? <p className="px-5 py-4 text-[13px] text-muted-foreground">Nothing collected yet.</p> : (
        <table className="erp-table text-[13px]">
          <thead><tr><th>Month</th><th>Route</th><th className="text-right">Amount</th><th /></tr></thead>
          <tbody>
            {data.collections.map(c => (
              <tr key={c.id}>
                <td>{monthLabel(c.month)}</td>
                <td>{c.routeName}</td>
                <td className="text-right num">₹{rs2(c.amount)}</td>
                <td><RunStatusBadge status={c.runStatus} /></td>
              </tr>
            ))}
            {data.plan && data.plan.openingCollected > 0 && (
              <tr><td colSpan={2} className="text-muted-foreground">Collected before this system</td><td className="text-right num">₹{rs2(data.plan.openingCollected)}</td><td /></tr>
            )}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function PlanSection({ contractorId, plan, canEdit, onSaved: onSavedProp }: {
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
  const navigate = useNavigate();
  const onSaved = () => { onSavedProp(); navigate(`/dtc/setup/deposits/${contractorId}`); };
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
    <Section title={plan ? "Edit plan" : "Start a deposit plan"}
      description={plan ? `Last changed ${fmtStamp(plan.updatedAt)}` : "Fill in the target and how much to take each month."}>
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
      <Section title="Refund">
        <p className="text-[13px]">Refunded <b>₹{rs2(plan.refundedAmount)}</b> on {fmtDMY(plan.refundedOn)}{plan.refundReference ? ` (${plan.refundReference})` : ""}. The plan is closed.</p>
      </Section>
    );
  }
  return (
    <Section title="Refund" description="When the contractor leaves. Recording the refund closes the plan.">
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
