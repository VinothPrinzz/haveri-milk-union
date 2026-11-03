// apps/web/src/pages/dtc/AdvanceFormPage.tsx
// DTC Billing → Record advance  (/dtc/payments/advances/new)
// Money paid to a contractor before the month's bill; it is deducted
// ("Advance recovery") from the bill of the month chosen here.
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { todayIST } from "@/lib/istDate";
import { fetchAdvances, fetchDtcLookups, recordAdvance, type PayMode } from "@/services/dtc";
import { MonthInput, PAY_MODES, errMsg, fmtDMY, monthLabel, rs2, useDtcPerms } from "./shared";
import { RecordHeader, Section } from "./ui";

export default function AdvanceFormPage() {
  const perms = useDtcPerms();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { data: lookups } = useQuery({ queryKey: ["dtc-lookups"], queryFn: fetchDtcLookups });
  const { data: advances = [] } = useQuery({ queryKey: ["dtc-advances"], queryFn: fetchAdvances });
  const contractorOptions: F9Option[] = useMemo(
    () => (lookups?.contractors ?? []).map(c => ({ value: c.id, label: c.name, sublabel: c.code ?? c.phone })), [lookups]);
  const [contractorId, setContractorId] = useState<string | null>(null);
  const contractor = lookups?.contractors.find(c => c.id === contractorId);
  const routes = useMemo(() => (lookups?.routes ?? []).filter(r => r.contractorId === contractorId), [lookups, contractorId]);
  const [routeId, setRouteId] = useState("");
  const [paidOn, setPaidOn] = useState(todayIST());
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState<PayMode>("neft");
  const [reference, setReference] = useState("");
  const [recoverMonth, setRecoverMonth] = useState(todayIST().slice(0, 7));
  const [notes, setNotes] = useState("");
  const open = advances.filter(a => a.contractorId === contractorId && !a.cancelledAt && a.recoveredRunStatus !== "approved");

  const mut = useMutation({
    mutationFn: () => recordAdvance({
      contractorId: contractorId!, routeId: routeId || null, paidOn, amount: Number(amount), mode,
      reference: reference || null, recoverMonth, notes: notes || null,
    }),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-advances"] }); navigate("/dtc/payments?tab=advances"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const valid = !!contractorId && Number(amount) > 0 && !!paidOn && (mode === "cash" || !!reference.trim());

  return (
    <div className="h-full overflow-auto">
      <RecordHeader back={{ to: "/dtc/payments?tab=advances", label: "Advances" }} title="Record advance"
        subtitle="Paid to a contractor before the bill; recovered from the bill of the month you choose." />
      <div className="p-3 sm:p-5 space-y-4 max-w-4xl">
        {!perms.pay && <p className="text-[12.5px] text-muted-foreground">Only Finance can record advances.</p>}
        <Section title="Contractor">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Contractor" required>
              <F9SearchSelect value={contractorId} onChange={v => { setContractorId(v); setRouteId(""); }} options={contractorOptions} placeholder="Select contractor" />
            </Field>
            <Field label="Recover from route bill">
              <select value={routeId} disabled={routes.length < 2} onChange={e => setRouteId(e.target.value)} className="erp-input w-full">
                <option value="">{routes.length ? "Their first route bill" : "—"}</option>
                {routes.map(r => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
              </select>
            </Field>
          </div>
          {contractor && (
            <div className="mt-3 text-[12.5px] text-muted-foreground">
              Bank: {contractor.bankName ?? "—"} {contractor.accountNo ?? ""} {contractor.ifscCode ? `· ${contractor.ifscCode}` : ""}
              {open.length > 0 && (
                <div className="mt-1 text-warning">
                  Already has {open.length} advance{open.length === 1 ? "" : "s"} not yet recovered: {open.map(a => `₹${rs2(a.amount)} (${fmtDMY(a.paidOn)}, recover ${monthLabel(a.recoverMonth)})`).join("; ")}
                </div>
              )}
            </div>
          )}
        </Section>

        <Section title="Payment">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            <Field label="Paid on" required><Input type="date" value={paidOn} onChange={e => setPaidOn(e.target.value)} className="erp-input" /></Field>
            <Field label="Amount (₹)" required><Input type="number" min="0" value={amount} onChange={e => setAmount(e.target.value)} className="erp-input num" /></Field>
            <Field label="Mode" required>
              <select value={mode} onChange={e => setMode(e.target.value as PayMode)} className="erp-input w-full">
                {PAY_MODES.map(m => <option key={m.value} value={m.value}>{m.label}</option>)}
              </select>
            </Field>
            <Field label={mode === "cheque" ? "Cheque number" : "UTR / reference"} required={mode !== "cash"}>
              <Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" />
            </Field>
          </div>
        </Section>

        <Section title="Recovery" description="The advance is deducted from this month's bill. The month must not be sent for approval yet.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Recover in bill month" required><MonthInput value={recoverMonth} onChange={setRecoverMonth} className="w-full" /></Field>
            <Field label="Notes"><Textarea value={notes} onChange={e => setNotes(e.target.value)} className="erp-input min-h-[34px]" /></Field>
          </div>
        </Section>

        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" className="h-8" onClick={() => navigate("/dtc/payments?tab=advances")}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!perms.pay || !valid || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Saving…" : amount ? `Record ₹${rs2(Number(amount))} advance` : "Record advance"}
          </Button>
        </div>
      </div>
    </div>
  );
}
