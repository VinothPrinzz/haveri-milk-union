// apps/web/src/pages/dtc/DtcSettingsPage.tsx
// DTC Billing → Settings  (/dtc/setup/settings)
// How cost per litre is worked out, TDS on transport (section 194C), and the
// signature boxes printed under the Consolidated DTC Bill.
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { fetchDtcSettings, saveDtcSettings, type DtcSettings } from "@/services/dtc";
import { errMsg, useDtcPerms } from "./shared";
import { RecordHeader, SaveBar, Section } from "./ui";

export default function DtcSettingsPage() {
  const perms = useDtcPerms();
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["dtc-settings"], queryFn: fetchDtcSettings });
  const [s, setS] = useState<DtcSettings | null>(null);
  useEffect(() => { if (data) setS(data); }, [data]);
  const dirty = !!s && !!data && JSON.stringify(s) !== JSON.stringify(data);
  const mut = useMutation({
    mutationFn: () => saveDtcSettings({ ...s!, signatures: s!.signatures.map(x => x.trim()).filter(Boolean) }),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-settings"] }); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const ro = !perms.setup;
  const move = (i: number, d: -1 | 1) => setS(p => {
    if (!p) return p;
    const sig = [...p.signatures];
    const j = i + d;
    if (j < 0 || j >= sig.length) return p;
    [sig[i], sig[j]] = [sig[j]!, sig[i]!];
    return { ...p, signatures: sig };
  });

  return (
    <div className="h-full overflow-auto">
      <RecordHeader back={{ to: "/dtc/setup/routes", label: "Route Billing Setup" }} title="DTC Settings" subtitle="Rules that apply to every month's bills" />
      {!s ? <div className="p-5 text-muted-foreground">Loading…</div> : (
        <div className="p-3 sm:p-5 space-y-4 max-w-4xl">
          <Section title="Cost per litre" description="Shown on every bill and on the Cost per Litre report. Applies to months prepared from now on.">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {([
                ["total_earnings", "Total earnings ÷ litres", "Gross payable plus other earnings (extra km, …). What the meeting asked for."],
                ["gross", "Gross payable ÷ litres", "Days × km × rate only, as printed on the Belgaum consolidated bill."],
              ] as const).map(([v, t, d]) => (
                <button key={v} type="button" disabled={ro} onClick={() => setS({ ...s, costPerLitreBasis: v })}
                  className={cn("text-left rounded border p-3", s.costPerLitreBasis === v ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-muted/40")}>
                  <div className="text-[13px] font-medium">{t}</div>
                  <div className="text-[11.5px] text-muted-foreground mt-0.5">{d}</div>
                </button>
              ))}
            </div>
          </Section>

          <Section title="TDS on transport (section 194C)" description="Deducted automatically on each bill when switched on.">
            <label className="flex items-start gap-3 text-[13px]">
              <Switch checked={s.tdsEnabled} disabled={ro} onCheckedChange={v => setS({ ...s, tdsEnabled: v })} />
              <span>
                <b>{s.tdsEnabled ? "TDS is deducted" : "TDS is not deducted"}</b>
                <span className="block text-[12px] text-muted-foreground mt-1 max-w-2xl">
                  1% for an individual or HUF, 2% for a firm or company, and 20% when no PAN is on record.
                  No TDS for a contractor whose PAN and "not more than 10 goods carriages" declaration for the
                  financial year are entered on the Contractor screen. The client said no tax is needed; switch it on only if Finance asks.
                </span>
              </span>
            </label>
          </Section>

          <Section title="Signature boxes" description="Printed in this order under the Consolidated DTC Bill."
            actions={!ro && (
              <Button size="sm" variant="outline" className="h-7 text-[12px]" disabled={s.signatures.length >= 8}
                onClick={() => setS({ ...s, signatures: [...s.signatures, ""] })}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add box
              </Button>
            )}>
            <ol className="space-y-1.5">
              {s.signatures.map((sig, i) => (
                <li key={i} className="flex items-center gap-2">
                  <span className="w-5 text-right text-[12px] text-muted-foreground">{i + 1}</span>
                  <Input value={sig} disabled={ro} maxLength={40} onChange={e => setS({ ...s, signatures: s.signatures.map((x, j) => (j === i ? e.target.value : x)) })} className="erp-input max-w-xs" />
                  {!ro && (
                    <>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={i === 0} onClick={() => move(i, -1)} title="Move up"><ArrowUp className="h-3.5 w-3.5" /></Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0" disabled={i === s.signatures.length - 1} onClick={() => move(i, 1)} title="Move down"><ArrowDown className="h-3.5 w-3.5" /></Button>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" disabled={s.signatures.length <= 1}
                        onClick={() => setS({ ...s, signatures: s.signatures.filter((_, j) => j !== i) })} title="Remove"><Trash2 className="h-3.5 w-3.5" /></Button>
                    </>
                  )}
                </li>
              ))}
            </ol>
            <div className="mt-4 grid gap-3 text-center text-[10.5px]" style={{ gridTemplateColumns: `repeat(${Math.max(1, s.signatures.length)}, minmax(0,1fr))` }}>
              {s.signatures.map((sig, i) => <div key={i} className="border-t border-foreground/50 pt-1 truncate">{sig || "—"}</div>)}
            </div>
          </Section>

          <SaveBar visible={dirty} note="Unsaved changes">
            <Button size="sm" variant="ghost" className="h-8" onClick={() => setS(data!)}>Discard</Button>
            <Button size="sm" className="h-8" disabled={mut.isPending || s.signatures.every(x => !x.trim())} onClick={() => mut.mutate()}>
              {mut.isPending ? "Saving…" : "Save settings"}
            </Button>
          </SaveBar>
        </div>
      )}
    </div>
  );
}
