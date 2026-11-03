// apps/web/src/pages/dtc/RecurringChargesPage.tsx
// DTC Billing → GPS & Fixed Charges  (/dtc/setup/charges)
// Monthly fixed deductions per route (GPS rent, …), added to the route's bill
// automatically for every month in their From–To range. Edited in place in
// the table (ERPNext-style editable grid); a new charge is the last row.
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Check, Pencil, Plus, Trash2, X } from "lucide-react";
import { todayIST } from "@/lib/istDate";
import {
  createCharge, deleteCharge, fetchCharges, fetchDtcLookups, updateCharge,
  type RecurringCharge, type RecurringChargeInput,
} from "@/services/dtc";
import { MonthInput, errMsg, monthLabel, rs2, useDtcPerms } from "./shared";

const pick = (c: RecurringCharge): RecurringChargeInput => ({
  routeId: c.routeId, head: c.head, description: c.description, monthlyAmount: c.monthlyAmount,
  fromMonth: c.fromMonth, toMonth: c.toMonth, active: c.active,
});

export default function RecurringChargesPage() {
  const perms = useDtcPerms();
  const qc = useQueryClient();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-charges"], queryFn: fetchCharges });
  const [editing, setEditing] = useState<string | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: ["dtc-charges"] });
  const toggle = useMutation({
    mutationFn: (c: RecurringCharge) => updateCharge(c.id, { ...pick(c), active: !c.active }),
    onSuccess: refresh,
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteCharge(id),
    onSuccess: (r) => { toast.success(r.message); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const active = rows.filter(r => r.active);
  const gps = active.filter(r => r.head === "gps");

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="GPS & Fixed Charges" subtitle="Monthly deductions added to a route's bill automatically (GPS rent and similar)" />
      <div className="dtc-plain flex-1 overflow-auto p-4 sm:p-6 space-y-4">
        <p className="text-[14px]"><b>₹{rs2(active.reduce((s, r) => s + r.monthlyAmount, 0))}</b> is deducted every month across {active.length} charge{active.length === 1 ? "" : "s"}{gps.length ? `, ${gps.length} of them GPS rent` : ""}.</p>
        <div className="erp-panel overflow-auto">
          {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : (
            <table className="erp-table text-[12.5px]">
              <thead>
                <tr>
                  <th style={{ width: "22%" }}>Route</th><th style={{ width: 150 }}>Head</th><th>Description (printed on the bill)</th>
                  <th className="text-right" style={{ width: 120 }}>Per month (₹)</th><th style={{ width: 150 }}>From</th><th style={{ width: 170 }}>To</th>
                  <th style={{ width: 50 }}>On</th><th style={{ width: 80 }} />
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 && !perms.setup && <tr><td colSpan={8}><EmptyState title="No charges yet" /></td></tr>}
                {rows.map(c => editing === c.id
                  ? <ChargeRow key={c.id} charge={c} onDone={() => { setEditing(null); refresh(); }} onCancel={() => setEditing(null)} />
                  : (
                    <tr key={c.id} className={c.active ? "" : "opacity-55"}>
                      <td><span className="font-mono text-[11px] text-muted-foreground mr-1.5">{c.routeCode}</span>{c.routeName}</td>
                      <td>{c.head === "gps" ? "GPS" : "Other deduction"}</td>
                      <td>{c.description}</td>
                      <td className="text-right num">{rs2(c.monthlyAmount)}</td>
                      <td>{monthLabel(c.fromMonth)}</td>
                      <td>{c.toMonth ? monthLabel(c.toMonth) : <span className="text-muted-foreground">ongoing</span>}</td>
                      <td><Switch checked={c.active} disabled={!perms.setup || toggle.isPending} onCheckedChange={() => toggle.mutate(c)} /></td>
                      <td className="text-right whitespace-nowrap">
                        {perms.setup && (
                          <>
                            <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title="Edit" onClick={() => setEditing(c.id)}><Pencil className="h-3.5 w-3.5" /></Button>
                            {!c.used && (
                              <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" title="Delete" disabled={del.isPending}
                                onClick={() => { if (confirm("Delete this charge?")) del.mutate(c.id); }}>
                                <Trash2 className="h-3.5 w-3.5" />
                              </Button>
                            )}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                {perms.setup && editing == null && <ChargeRow onDone={refresh} />}
              </tbody>
            </table>
          )}
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          A change reaches a draft month when its bills are regenerated. Months sent for approval are not changed.
          A charge already on bills can't be deleted; switch it off instead.
        </p>
      </div>
    </div>
  );
}

function ChargeRow({ charge, onDone, onCancel }: { charge?: RecurringCharge; onDone: () => void; onCancel?: () => void }) {
  const { data: lookups } = useQuery({ queryKey: ["dtc-lookups"], queryFn: fetchDtcLookups });
  const routes = useMemo(() => lookups?.routes ?? [], [lookups]);
  const blank: RecurringChargeInput = {
    routeId: "", head: "gps", description: "GPS rent", monthlyAmount: 0,
    fromMonth: todayIST().slice(0, 7), toMonth: null, active: true,
  };
  const [f, setF] = useState<RecurringChargeInput>(charge ? pick(charge) : blank);
  const [amount, setAmount] = useState(charge ? String(charge.monthlyAmount) : "");
  const mut = useMutation({
    mutationFn: () => {
      const body = { ...f, monthlyAmount: Number(amount) };
      return charge ? updateCharge(charge.id, body) : createCharge(body);
    },
    onSuccess: (r) => {
      toast.success(r.message);
      if (!charge) { setF(blank); setAmount(""); }
      onDone();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const valid = !!f.routeId && f.description.trim().length >= 2 && Number(amount) > 0;
  return (
    <tr className={charge ? "bg-primary/5" : "bg-muted/20"}>
      <td>
        <select value={f.routeId} onChange={e => setF({ ...f, routeId: e.target.value })} className="erp-input w-full h-7">
          <option value="">{charge ? "" : "New charge: pick a route…"}</option>
          {routes.map(r => <option key={r.id} value={r.id}>{r.code} · {r.name}</option>)}
        </select>
      </td>
      <td>
        <select value={f.head} onChange={e => {
          const head = e.target.value as RecurringChargeInput["head"];
          setF({ ...f, head, description: f.description === "GPS rent" && head !== "gps" ? "" : head === "gps" && !f.description ? "GPS rent" : f.description });
        }} className="erp-input w-full h-7">
          <option value="gps">GPS</option>
          <option value="other_deduction">Other deduction</option>
        </select>
      </td>
      <td><Input value={f.description} onChange={e => setF({ ...f, description: e.target.value })} className="erp-input h-7" /></td>
      <td><Input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="erp-input h-7 text-right num" /></td>
      <td><MonthInput value={f.fromMonth} onChange={v => setF({ ...f, fromMonth: v })} className="h-7 w-full" /></td>
      <td>
        <div className="flex items-center gap-1">
          <MonthInput value={f.toMonth ?? ""} onChange={v => setF({ ...f, toMonth: v })} className="h-7 w-full" />
          {f.toMonth && <button type="button" title="Ongoing" className="text-muted-foreground" onClick={() => setF({ ...f, toMonth: null })}><X className="h-3.5 w-3.5" /></button>}
        </div>
      </td>
      <td />
      <td className="text-right whitespace-nowrap">
        <Button size="sm" className="h-7 px-2" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
          {charge ? <Check className="h-3.5 w-3.5" /> : <><Plus className="h-3.5 w-3.5 mr-0.5" />Add</>}
        </Button>
        {charge && <Button size="sm" variant="ghost" className="h-7 w-7 p-0 ml-0.5" title="Cancel" onClick={onCancel}><X className="h-3.5 w-3.5" /></Button>}
      </td>
    </tr>
  );
}
