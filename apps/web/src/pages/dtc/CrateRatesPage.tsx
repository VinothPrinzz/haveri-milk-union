// apps/web/src/pages/dtc/CrateRatesPage.tsx
// DTC Billing → Crate Rates  (/dtc/setup/crate-rates)
// The amount charged per crate short. The rate in force at the end of the
// bill month is offered when a crate shortage is entered on a bill.
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState, Field } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Trash2 } from "lucide-react";
import { todayIST } from "@/lib/istDate";
import { deleteCrateRate, fetchCrateRates, saveCrateRate } from "@/services/dtc";
import { errMsg, fmtDMY, rs2, useDtcPerms } from "./shared";

export default function CrateRatesPage() {
  const perms = useDtcPerms();
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["dtc-crate-rates"], queryFn: fetchCrateRates });
  const rows = data?.data ?? [];
  const today = data?.today ?? todayIST();
  const current = rows.find(r => r.effectiveFrom <= today);

  const [effectiveFrom, setEffectiveFrom] = useState(todayIST());
  const [rate, setRate] = useState("");
  const [notes, setNotes] = useState("");
  const save = useMutation({
    mutationFn: () => saveCrateRate({ effectiveFrom, rate: Number(rate), notes: notes || null }),
    onSuccess: (r) => { toast.success(r.message); setRate(""); setNotes(""); qc.invalidateQueries({ queryKey: ["dtc-crate-rates"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteCrateRate(id),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-crate-rates"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Crate Rates" subtitle="Amount deducted per crate short, by the date the rate applies from" />
      <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-3 max-w-3xl">
        <div className="erp-panel p-3 text-[13px]">
          Current rate: <b>{current ? `₹${rs2(current.rate)} per crate` : "not set"}</b>
          {current && <span className="text-muted-foreground"> (from {fmtDMY(current.effectiveFrom)})</span>}
        </div>

        {perms.setup && (
          <div className="erp-panel p-3">
            <div className="erp-section-title">New rate</div>
            <div className="grid grid-cols-1 sm:grid-cols-4 gap-3 items-end">
              <Field label="From date" required>
                <Input type="date" value={effectiveFrom} onChange={e => setEffectiveFrom(e.target.value)} className="erp-input" />
              </Field>
              <Field label="Rate per crate (₹)" required>
                <Input type="number" min="0" step="0.01" value={rate} onChange={e => setRate(e.target.value)} className="erp-input num" />
              </Field>
              <Field label="Notes">
                <Input value={notes} onChange={e => setNotes(e.target.value)} className="erp-input" />
              </Field>
              <Button size="sm" className="h-8" disabled={!effectiveFrom || !(Number(rate) > 0) || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save Rate"}
              </Button>
            </div>
          </div>
        )}

        <div className="erp-panel overflow-auto">
          {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? (
            <EmptyState title="No crate rate yet" hint="Add the current rate per crate above." />
          ) : (
            <table className="erp-table">
              <thead><tr><th>From</th><th className="text-right">Rate per crate</th><th>Notes</th><th>By</th><th /></tr></thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id}>
                    <td>{fmtDMY(r.effectiveFrom)}{r.id === current?.id && <span className="ml-2 text-[10.5px] text-success">current</span>}</td>
                    <td className="text-right num">₹{rs2(r.rate)}</td>
                    <td>{r.notes ?? ""}</td>
                    <td>{r.createdByName ?? ""}</td>
                    <td className="text-right">
                      {perms.setup && (
                        <Button size="sm" variant="ghost" className="h-6 text-destructive" disabled={del.isPending}
                          onClick={() => { if (confirm(`Delete the rate from ${fmtDMY(r.effectiveFrom)}?`)) del.mutate(r.id); }}>
                          <Trash2 className="h-3.5 w-3.5" />
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
          Deleting a rate does not change bills already prepared: each crate deduction keeps the rate it was entered with.
        </p>
      </div>
    </div>
  );
}
