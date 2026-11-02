// apps/web/src/pages/dtc/RouteBillingPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → Route Billing Setup  (/dtc/setup/routes)
//
// How each route's contractor is paid: billing type (KM / Trip / Litre),
// vehicle capacity, rate, km per day, and the contract (tender) details.
// Terms are versioned by "effective from": a rate revision is saved from a
// date, so bills already prepared keep the rate they were made with.
// Also holds the module settings (cost-per-litre basis, TDS, signatures).
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState, FilterBar, Field } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertTriangle, History, Pencil, Plus, Search, Settings2, Trash2 } from "lucide-react";
import { todayIST } from "@/lib/istDate";
import {
  deleteRouteTerms, fetchDtcSettings, fetchRouteTerms, fetchRouteTermsHistory, saveDtcSettings, saveRouteTerms,
  type BillingType, type DtcSettings, type RouteTerms, type RouteTermsInput, type RouteTermsRow,
} from "@/services/dtc";
import { BILLING_TYPE_LABEL, FilterLabel, RATE_UNIT, errMsg, fmtDMY, rs2, useDtcPerms } from "./shared";

const daysUntil = (iso: string, today: string) =>
  Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);

type Filter = "all" | "missing" | "expiring" | "verify";

export default function RouteBillingPage() {
  const perms = useDtcPerms();
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [editing, setEditing] = useState<RouteTermsRow | null>(null);
  const [history, setHistory] = useState<RouteTermsRow | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ["dtc-route-terms"], queryFn: fetchRouteTerms });
  const today = data?.today ?? todayIST();
  const rows = data?.data ?? [];

  const flags = (r: RouteTermsRow) => {
    const end = r.current?.contractEnd;
    return {
      missing: !r.current || !r.current.active,
      expiring: !!end && daysUntil(end, today) <= 30,
      verify: !!r.current?.notes?.startsWith("Imported"),
    };
  };
  const counts = useMemo(() => ({
    missing: rows.filter(r => flags(r).missing).length,
    expiring: rows.filter(r => flags(r).expiring).length,
    verify: rows.filter(r => flags(r).verify).length,
  }), [rows, today]); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = rows.filter(r => {
    const q = search.trim().toLowerCase();
    if (q && !`${r.routeCode} ${r.routeName} ${r.contractorName ?? ""}`.toLowerCase().includes(q)) return false;
    if (filter !== "all" && !flags(r)[filter]) return false;
    return true;
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Route Billing Setup"
        subtitle="How each route's transport contractor is paid: KM, Trip or Litre basis, rate, km per day and contract"
        actions={perms.setup && (
          <Button size="sm" variant="outline" className="h-8" onClick={() => setSettingsOpen(true)}>
            <Settings2 className="h-3.5 w-3.5 mr-1.5" /> DTC Settings
          </Button>
        )}
      />
      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <FilterLabel>Search</FilterLabel>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Route or contractor" className="erp-input pl-7 w-full" />
          </div>
        </div>
        <div>
          <FilterLabel>Show</FilterLabel>
          <select value={filter} onChange={e => setFilter(e.target.value as Filter)} className="erp-input w-56">
            <option value="all">All routes ({rows.length})</option>
            <option value="missing">Not set up / not billed ({counts.missing})</option>
            <option value="expiring">Contract ending in 30 days ({counts.expiring})</option>
            <option value="verify">Imported, to verify ({counts.verify})</option>
          </select>
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-3">
        {(counts.expiring > 0 || counts.verify > 0) && (
          <div className="erp-panel p-3 border-l-4 border-l-warning text-[12.5px] space-y-1">
            {counts.expiring > 0 && (
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
                {counts.expiring === 1 ? "1 route contract ends" : `${counts.expiring} route contracts end`} within 30 days (or already ended). Renew the tender or record new terms.
              </div>
            )}
            {counts.verify > 0 && (
              <div className="flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0" />
                {counts.verify} route{counts.verify === 1 ? " was" : "s were"} copied from the old route master. Check the billing type and rate, then save.
              </div>
            )}
          </div>
        )}

        <div className="erp-panel overflow-auto">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : shown.length === 0 ? (
            <EmptyState title="No routes match" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Route</th><th>Contractor</th><th>Type</th>
                  <th className="text-right">Veh Cap (MT)</th>
                  <th className="text-right">Rate (₹)</th>
                  <th className="text-right">Km / Day</th>
                  <th>Vehicle</th><th>Contract ends</th><th>From</th><th>Next change</th><th></th>
                </tr>
              </thead>
              <tbody>
                {shown.map(r => {
                  const c = r.current;
                  const f = flags(r);
                  return (
                    <tr key={r.routeId}>
                      <td><span className="font-mono text-[11px] text-muted-foreground mr-1.5">{r.routeCode}</span>{r.routeName}</td>
                      <td>{r.contractorName ?? <span className="text-muted-foreground">No contractor</span>}</td>
                      {c && c.active ? (
                        <>
                          <td>
                            {BILLING_TYPE_LABEL[c.billingType]}
                            {c.cashCollection && <span className="ml-1.5 text-[10.5px] rounded bg-info/15 text-info px-1">cash</span>}
                            {c.insulated && <span className="ml-1 text-[10.5px] rounded bg-muted px-1">insulated</span>}
                          </td>
                          <td className="text-right num">{c.vehicleCapacityMt != null ? rs2(c.vehicleCapacityMt) : ""}</td>
                          <td className="text-right num whitespace-nowrap">{rs2(c.rate)}<div className="text-[10.5px] text-muted-foreground">{RATE_UNIT[c.billingType]}</div></td>
                          <td className="text-right num">{c.billingType === "km" ? rs2(c.kmPerDay) : ""}</td>
                          <td className="font-mono text-[11px]">{c.vehicleNumber ?? ""}</td>
                          <td className={`whitespace-nowrap ${f.expiring ? "text-warning font-medium" : ""}`}>
                            {c.contractEnd ? fmtDMY(c.contractEnd) : ""}
                            {c.agreementNo && <div className="text-[10.5px] text-muted-foreground">{c.agreementNo}</div>}
                          </td>
                          <td className="text-[12px] whitespace-nowrap">
                            {fmtDMY(c.effectiveFrom)}
                            {f.verify && <div className="text-[10.5px] text-warning">Imported: verify</div>}
                          </td>
                        </>
                      ) : (
                        <td colSpan={7} className="text-muted-foreground text-[12px]">
                          {c && !c.active ? `Not billed from ${fmtDMY(c.effectiveFrom)}` : "Not set up: this route is not billed"}
                        </td>
                      )}
                      <td className="text-[12px]">
                        {r.upcoming
                          ? <>{fmtDMY(r.upcoming.effectiveFrom)}: {r.upcoming.active ? `₹${rs2(r.upcoming.rate)} ${BILLING_TYPE_LABEL[r.upcoming.billingType]}` : "stop billing"}</>
                          : ""}
                      </td>
                      <td className="whitespace-nowrap text-right">
                        {perms.setup && (
                          <Button size="sm" variant="outline" className="h-7 mr-1" onClick={() => setEditing(r)}>
                            {c ? <Pencil className="h-3 w-3 mr-1" /> : <Plus className="h-3 w-3 mr-1" />}{c ? "Change" : "Set up"}
                          </Button>
                        )}
                        {r.versionCount > 0 && (
                          <Button size="sm" variant="ghost" className="h-7" onClick={() => setHistory(r)} title="Rate history">
                            <History className="h-3.5 w-3.5" />
                          </Button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {editing && <TermsDialog row={editing} today={today} onClose={() => setEditing(null)} />}
      {history && <HistoryDialog row={history} onClose={() => setHistory(null)} canEdit={perms.setup} />}
      {settingsOpen && <SettingsDialog onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

// ─── Add / change terms ─────────────────────────────────────────────
function TermsDialog({ row, today, onClose }: { row: RouteTermsRow; today: string; onClose: () => void }) {
  const qc = useQueryClient();
  const base = row.upcoming ?? row.current;
  const [f, setF] = useState({
    effectiveFrom: row.current ? today : "2020-01-01",
    active: true,
    billingType: (base?.billingType ?? "km") as BillingType,
    rate: base ? String(base.rate) : "",
    kmPerDay: base ? String(base.kmPerDay || "") : "",
    vehicleCapacityMt: base?.vehicleCapacityMt != null ? String(base.vehicleCapacityMt) : "",
    vehicleNumber: base?.vehicleNumber ?? "",
    agreementNo: base?.agreementNo ?? "",
    contractStart: base?.contractStart ?? "",
    contractEnd: base?.contractEnd ?? "",
    insulated: base?.insulated ?? false,
    cashCollection: base?.cashCollection ?? false,
    notes: base?.notes?.startsWith("Imported") ? "" : (base?.notes ?? ""),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }));
  const sameAsCurrent = row.current && f.effectiveFrom === row.current.effectiveFrom;

  const mut = useMutation({
    mutationFn: () => {
      const body: RouteTermsInput = {
        routeId: row.routeId,
        effectiveFrom: f.effectiveFrom,
        active: f.active,
        billingType: f.billingType,
        rate: Number(f.rate) || 0,
        kmPerDay: f.billingType === "km" ? Number(f.kmPerDay) || 0 : 0,
        vehicleCapacityMt: f.vehicleCapacityMt ? Number(f.vehicleCapacityMt) : null,
        vehicleNumber: f.vehicleNumber || null,
        agreementNo: f.agreementNo || null,
        contractStart: f.contractStart || null,
        contractEnd: f.contractEnd || null,
        insulated: f.insulated,
        cashCollection: f.cashCollection,
        notes: f.notes || null,
      };
      return saveRouteTerms(body);
    },
    onSuccess: (r) => {
      toast.success(r.message);
      qc.invalidateQueries({ queryKey: ["dtc-route-terms"] });
      qc.invalidateQueries({ queryKey: ["dtc-terms-history", row.routeId] });
      onClose();
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  const valid = !!f.effectiveFrom && (!f.active || (Number(f.rate) > 0 && (f.billingType !== "km" || Number(f.kmPerDay) > 0)));
  const perDay = f.billingType === "km" ? (Number(f.kmPerDay) || 0) * (Number(f.rate) || 0)
    : f.billingType === "trip" ? Number(f.rate) || 0 : null;

  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{row.routeCode}: {row.routeName}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3 text-[13px] max-h-[70vh] overflow-auto pr-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Effective from" required>
              <Input type="date" value={f.effectiveFrom} onChange={e => set("effectiveFrom", e.target.value)} className="erp-input" />
            </Field>
            <Field label="Billed">
              <div className="flex items-center gap-2 h-8">
                <Switch checked={f.active} onCheckedChange={v => set("active", v)} />
                <span>{f.active ? "Billed from this date" : "Stop billing from this date"}</span>
              </div>
            </Field>
          </div>
          <p className="text-[11.5px] text-muted-foreground -mt-1">
            {row.current
              ? sameAsCurrent
                ? "Same date as the current terms: this corrects them."
                : `A rate revision from ${fmtDMY(f.effectiveFrom)}. Bills before that date keep the old rate; a month with both is split.`
              : "The first terms for this route. Use an early date so past months can be billed too."}
            {row.current && !sameAsCurrent && (
              <button type="button" className="ml-1 underline text-primary" onClick={() => set("effectiveFrom", row.current!.effectiveFrom)}>
                Correct the current terms instead
              </button>
            )}
          </p>

          {f.active && (
            <>
              <Field label="Billing type" required>
                <div className="flex gap-2">
                  {(["km", "trip", "litre"] as BillingType[]).map(t => (
                    <button key={t} type="button" onClick={() => set("billingType", t)}
                      className={`h-8 px-3 rounded border text-[12.5px] ${f.billingType === t ? "border-primary bg-primary/10 font-medium" : "border-border"}`}>
                      {t === "km" ? "Kilometre basis" : t === "trip" ? "Trip basis" : "Litre / kg basis"}
                    </button>
                  ))}
                </div>
              </Field>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field label={`Rate (₹ ${RATE_UNIT[f.billingType]})`} required>
                  <Input type="number" min="0" step="0.01" value={f.rate} onChange={e => set("rate", e.target.value)} className="erp-input num" />
                </Field>
                {f.billingType === "km" && (
                  <Field label="Km per day" required>
                    <Input type="number" min="0" step="0.1" value={f.kmPerDay} onChange={e => set("kmPerDay", e.target.value)} className="erp-input num" />
                  </Field>
                )}
                <Field label="Vehicle capacity (MT)">
                  <Input type="number" min="0" step="0.1" value={f.vehicleCapacityMt} onChange={e => set("vehicleCapacityMt", e.target.value)} className="erp-input num" />
                </Field>
              </div>
              <div className="text-[12px] text-muted-foreground">
                {perDay != null
                  ? <>Pays <b className="text-foreground">₹{rs2(perDay)}</b> per day the route runs{f.billingType === "km" ? " (km per day × rate)" : ""}.</>
                  : <>Pays the rate × litres/kg of milk and products carried on the route in the month.</>}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <Field label="Vehicle number">
                  <Input value={f.vehicleNumber} onChange={e => set("vehicleNumber", e.target.value)} placeholder="KA-27-A-1234" className="erp-input" />
                </Field>
                <Field label="Agreement / tender no.">
                  <Input value={f.agreementNo} onChange={e => set("agreementNo", e.target.value)} className="erp-input" />
                </Field>
                <Field label="Contract start">
                  <Input type="date" value={f.contractStart} onChange={e => set("contractStart", e.target.value)} className="erp-input" />
                </Field>
                <Field label="Contract end">
                  <Input type="date" value={f.contractEnd} onChange={e => set("contractEnd", e.target.value)} className="erp-input" />
                </Field>
              </div>
              <div className="flex flex-wrap gap-5">
                <label className="flex items-center gap-2"><Switch checked={f.cashCollection} onCheckedChange={v => set("cashCollection", v)} /> Vehicle collects cash from dealers</label>
                <label className="flex items-center gap-2"><Switch checked={f.insulated} onCheckedChange={v => set("insulated", v)} /> Insulated vehicle</label>
              </div>
            </>
          )}
          <Field label="Notes">
            <Textarea value={f.notes} onChange={e => set("notes", e.target.value)} className="erp-input min-h-[50px]" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Saving…" : "Save Terms"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─── Version history ────────────────────────────────────────────────
function HistoryDialog({ row, onClose, canEdit }: { row: RouteTermsRow; onClose: () => void; canEdit: boolean }) {
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery({
    queryKey: ["dtc-terms-history", row.routeId],
    queryFn: () => fetchRouteTermsHistory(row.routeId),
  });
  const del = useMutation({
    mutationFn: (id: string) => deleteRouteTerms(id),
    onSuccess: (r) => {
      toast.success(r.message);
      qc.invalidateQueries({ queryKey: ["dtc-terms-history", row.routeId] });
      qc.invalidateQueries({ queryKey: ["dtc-route-terms"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-3xl">
        <DialogHeader><DialogTitle>Rate history: {row.routeCode} {row.routeName}</DialogTitle></DialogHeader>
        <div className="max-h-[60vh] overflow-auto">
          <table className="erp-table w-full text-[12px]">
            <thead>
              <tr><th>From</th><th>Type</th><th className="text-right">Rate</th><th className="text-right">Km/day</th><th>Contract</th><th>By</th><th /></tr>
            </thead>
            <tbody>
              {isLoading && <tr><td colSpan={7} className="text-center py-4 text-muted-foreground">Loading…</td></tr>}
              {data.map((t: RouteTerms) => (
                <tr key={t.id}>
                  <td>{fmtDMY(t.effectiveFrom)}</td>
                  <td>{t.active ? BILLING_TYPE_LABEL[t.billingType] : <span className="text-muted-foreground">Not billed</span>}</td>
                  <td className="text-right num">{t.active ? rs2(t.rate) : ""}</td>
                  <td className="text-right num">{t.active && t.billingType === "km" ? rs2(t.kmPerDay) : ""}</td>
                  <td>{t.contractEnd ? `to ${fmtDMY(t.contractEnd)}` : ""} {t.agreementNo ?? ""}</td>
                  <td>{t.createdByName ?? (t.notes?.startsWith("Imported") ? "Imported" : "")}</td>
                  <td className="text-right">
                    {canEdit && (t.usedInBills
                      ? <span className="text-[11px] text-muted-foreground">used in bills</span>
                      : (
                        <Button size="sm" variant="ghost" className="h-6 text-destructive" disabled={del.isPending}
                          onClick={() => { if (confirm(`Delete the terms from ${fmtDMY(t.effectiveFrom)}?`)) del.mutate(t.id); }}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ─── Module settings ────────────────────────────────────────────────
function SettingsDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["dtc-settings"], queryFn: fetchDtcSettings });
  const [draft, setDraft] = useState<DtcSettings | null>(null);
  const s = draft ?? data ?? null;
  const mut = useMutation({
    mutationFn: () => saveDtcSettings(s!),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-settings"] }); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>DTC Settings</DialogTitle></DialogHeader>
        {!s ? <div className="py-6 text-center text-muted-foreground">Loading…</div> : (
          <div className="space-y-4 text-[13px]">
            <Field label="Cost per litre is worked out on">
              <select value={s.costPerLitreBasis} onChange={e => setDraft({ ...s, costPerLitreBasis: e.target.value as DtcSettings["costPerLitreBasis"] })} className="erp-input w-full">
                <option value="total_earnings">Total earnings (gross + other earnings)</option>
                <option value="gross">Gross payable only</option>
              </select>
            </Field>
            <label className="flex items-start gap-2">
              <Switch checked={s.tdsEnabled} onCheckedChange={v => setDraft({ ...s, tdsEnabled: v })} />
              <span>
                Deduct TDS under section 194C
                <span className="block text-[11.5px] text-muted-foreground">
                  1% (individual / HUF) or 2% (firm, company); 20% when no PAN is on record. No TDS for a contractor
                  whose PAN and "not more than 10 goods carriages" declaration for the year are on the Contractor screen.
                </span>
              </span>
            </label>
            <Field label="Signature boxes on the printed bill" hint="one per line">
              <Textarea
                value={s.signatures.join("\n")}
                onChange={e => setDraft({ ...s, signatures: e.target.value.split("\n").map(x => x.trim()).filter(Boolean) })}
                className="erp-input min-h-[120px]"
              />
            </Field>
            <p className="text-[11.5px] text-muted-foreground">
              The cost-per-litre basis applies to months prepared from now on.
            </p>
          </div>
        )}
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!s || s.signatures.length === 0 || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Saving…" : "Save Settings"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
