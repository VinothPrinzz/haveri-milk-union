// apps/web/src/pages/dtc/RecurringChargesPage.tsx
// DTC Billing → GPS & Fixed Charges  (/dtc/setup/charges)
// Monthly fixed deductions per route (GPS rent, …). They are added to the
// route's bill automatically for every month in their From–To range.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState, Field } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Pencil, Plus, Trash2 } from "lucide-react";
import { todayIST } from "@/lib/istDate";
import {
  createCharge, deleteCharge, fetchCharges, fetchDtcLookups, updateCharge,
  type RecurringCharge, type RecurringChargeInput,
} from "@/services/dtc";
import { MonthInput, errMsg, monthLabel, rs2, useDtcPerms } from "./shared";

export default function RecurringChargesPage() {
  const perms = useDtcPerms();
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-charges"], queryFn: fetchCharges });
  const [editing, setEditing] = useState<RecurringCharge | "new" | null>(null);
  const toggle = useMutation({
    mutationFn: (c: RecurringCharge) => updateCharge(c.id, { ...pick(c), active: !c.active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["dtc-charges"] }),
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteCharge(id),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-charges"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const monthlyTotal = rows.filter(r => r.active).reduce((s, r) => s + r.monthlyAmount, 0);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="GPS & Fixed Charges"
        subtitle="Monthly deductions added to a route's bill automatically (GPS rent and similar)"
        actions={perms.setup && (
          <Button size="sm" className="h-8" onClick={() => setEditing("new")}><Plus className="h-3.5 w-3.5 mr-1.5" /> Add Charge</Button>
        )}
      />
      <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-3">
        <div className="erp-panel overflow-auto">
          {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? (
            <EmptyState title="No charges yet" hint="Add the GPS rent for each vehicle that has one." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr><th>Route</th><th>Head</th><th>Description</th><th className="text-right">Per month</th><th>From</th><th>To</th><th>On</th><th /></tr>
              </thead>
              <tbody>
                {rows.map(c => (
                  <tr key={c.id} className={c.active ? "" : "opacity-60"}>
                    <td><span className="font-mono text-[11px] text-muted-foreground mr-1.5">{c.routeCode}</span>{c.routeName}</td>
                    <td>{c.head === "gps" ? "GPS" : "Other deduction"}</td>
                    <td>{c.description}</td>
                    <td className="text-right num">₹{rs2(c.monthlyAmount)}</td>
                    <td>{monthLabel(c.fromMonth)}</td>
                    <td>{c.toMonth ? monthLabel(c.toMonth) : "ongoing"}</td>
                    <td><Switch checked={c.active} disabled={!perms.setup || toggle.isPending} onCheckedChange={() => toggle.mutate(c)} /></td>
                    <td className="text-right whitespace-nowrap">
                      {perms.setup && (
                        <>
                          <Button size="sm" variant="ghost" className="h-6" onClick={() => setEditing(c)}><Pencil className="h-3.5 w-3.5" /></Button>
                          {!c.used && (
                            <Button size="sm" variant="ghost" className="h-6 text-destructive" disabled={del.isPending}
                              onClick={() => { if (confirm("Delete this charge?")) del.mutate(c.id); }}>
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          )}
                        </>
                      )}
                    </td>
                  </tr>
                ))}
                <tr className="font-semibold bg-muted/30">
                  <td colSpan={3}>Active charges per month</td>
                  <td className="text-right num">₹{rs2(monthlyTotal)}</td>
                  <td colSpan={4} />
                </tr>
              </tbody>
            </table>
          )}
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          Changes reach a draft month when its bills are regenerated. Bills sent for approval are not changed.
        </p>
      </div>
      {editing && <ChargeDialog charge={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
    </div>
  );
}

const pick = (c: RecurringCharge): RecurringChargeInput => ({
  routeId: c.routeId, head: c.head, description: c.description, monthlyAmount: c.monthlyAmount,
  fromMonth: c.fromMonth, toMonth: c.toMonth, active: c.active,
});

function ChargeDialog({ charge, onClose }: { charge: RecurringCharge | null; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: lookups } = useQuery({ queryKey: ["dtc-lookups"], queryFn: fetchDtcLookups });
  const routeOptions: F9Option[] = useMemo(
    () => (lookups?.routes ?? []).map(r => ({ value: r.id, label: r.name, sublabel: r.code })), [lookups]);
  const [f, setF] = useState<RecurringChargeInput>(charge ? pick(charge) : {
    routeId: "", head: "gps", description: "GPS rent", monthlyAmount: 0,
    fromMonth: todayIST().slice(0, 7), toMonth: null, active: true,
  });
  const [amount, setAmount] = useState(charge ? String(charge.monthlyAmount) : "");
  const mut = useMutation({
    mutationFn: () => {
      const body = { ...f, monthlyAmount: Number(amount) };
      return charge ? updateCharge(charge.id, body) : createCharge(body);
    },
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-charges"] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const valid = !!f.routeId && f.description.trim().length >= 2 && Number(amount) > 0;
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>{charge ? "Edit Charge" : "Add Charge"}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <Field label="Route" required>
            <F9SearchSelect value={f.routeId || null} onChange={v => setF({ ...f, routeId: v ?? "" })} options={routeOptions} placeholder="Select route" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Head" required>
              <select value={f.head} onChange={e => setF({ ...f, head: e.target.value as RecurringChargeInput["head"] })} className="erp-input w-full">
                <option value="gps">GPS</option>
                <option value="other_deduction">Other deduction</option>
              </select>
            </Field>
            <Field label="Amount per month (₹)" required>
              <Input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="erp-input num" />
            </Field>
          </div>
          <Field label="Description (printed on the bill)" required>
            <Input value={f.description} onChange={e => setF({ ...f, description: e.target.value })} className="erp-input" />
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="From month" required><MonthInput value={f.fromMonth} onChange={v => setF({ ...f, fromMonth: v })} /></Field>
            <Field label="To month (blank = ongoing)">
              <div className="flex gap-1">
                <MonthInput value={f.toMonth ?? ""} onChange={v => setF({ ...f, toMonth: v })} />
                {f.toMonth && <Button size="sm" variant="ghost" className="h-8" onClick={() => setF({ ...f, toMonth: null })}>Clear</Button>}
              </div>
            </Field>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
