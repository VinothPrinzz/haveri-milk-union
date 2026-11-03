// apps/web/src/pages/dtc/RouteTermsRecordPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → one route's billing record  (/dtc/setup/routes/:routeId)
//
//   Header        route, contractor, billing status, key terms
//   Terms         what the contractor is paid on today (+ a scheduled change)
//   Change terms  the form, on the page: correct today's terms, or record a
//                 revision from a date (old bills keep the old rate)
//   Rate history  every version, with who entered it
//   Recent bills  the last 12 months billed on this route
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from "react";
import { Link, Route, Routes, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Field } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  deleteRouteTerms, fetchRouteRecord, saveRouteTerms,
  type BillingType, type RouteTerms, type RouteTermsInput,
} from "@/services/dtc";
import { BASIS_LABEL, BILLING_TYPE_LABEL, RATE_UNIT, RunStatusBadge, errMsg, fmtDMY, fmtStamp, monthLabel, nice, rs, rs2, useDtcPerms } from "./shared";
import { FieldList, RecordBody, RecordHeader, Section } from "./ui";

const daysUntil = (iso: string, today: string) => Math.round((Date.parse(iso) - Date.parse(today)) / 86400000);

const TYPE_HELP: Record<BillingType, { title: string; text: string }> = {
  km: { title: "Kilometre basis", text: "Days run × km per day × rate per km" },
  trip: { title: "Trip basis", text: "Days run × rate per trip" },
  litre: { title: "Litre / kg basis", text: "Litres/kg carried × rate per litre" },
};

export default function RouteTermsRecordPage() {
  const { routeId = "" } = useParams();
  const perms = useDtcPerms();
  const { data, isLoading } = useQuery({ queryKey: ["dtc-route-record", routeId], queryFn: () => fetchRouteRecord(routeId) });

  if (isLoading || !data) {
    return <div className="p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
  }
  const { route, current: c, history, bills, today } = data;
  const billed = !!c && c.active;
  const ending = c?.contractEnd ? daysUntil(c.contractEnd, today) : null;
  const perDay = billed ? (c!.billingType === "km" ? c!.kmPerDay * c!.rate : c!.billingType === "trip" ? c!.rate : null) : null;
  const base = `/dtc/setup/routes/${route.id}`;

  return (
    <div className="h-full overflow-auto">
      <RecordHeader
        back={{ to: "/dtc/setup/routes", label: "All routes" }}
        code={route.code}
        title={route.name}
        status={billed
          ? <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-success/15 text-success">Billed</span>
          : <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-muted text-muted-foreground">Not billed</span>}
        subtitle={route.contractorName ?? "No contractor assigned"}
        facts={billed ? [
          { label: "Basis", value: BASIS_LABEL[c!.billingType] },
          { label: "Rate", value: `₹${rs2(c!.rate)}`, hint: RATE_UNIT[c!.billingType] },
          { label: "A day's pay", value: perDay != null ? `₹${rs(perDay)}` : "by litres" },
          { label: "Contract ends", value: c!.contractEnd ? fmtDMY(c!.contractEnd) : "—", hint: ending != null ? (ending < 0 ? "already ended" : `in ${ending} days`) : undefined, tone: ending != null && ending <= 30 ? "danger" : "default" },
        ] : undefined}
        tabs={[
          { to: base, label: "Overview", end: true },
          ...(perms.setup ? [{ to: `${base}/edit`, label: c ? "Change terms" : "Set up" }] : []),
          { to: `${base}/history`, label: "Rate history", count: history.length },
          { to: `${base}/bills`, label: "Bills", count: bills.length },
        ]}
      />
      <RecordBody>
        <Routes>
          <Route index element={<Overview data={data} canEdit={perms.setup} />} />
          {perms.setup && <Route path="edit" element={<ChangeTerms data={data} />} />}
          <Route path="history" element={
            <Section title="Rate history" description="Each bill keeps the rate it was made with." flush>
              <HistoryTable routeId={route.id} history={history} canEdit={perms.setup} today={today} />
            </Section>} />
          <Route path="bills" element={<BillsTable bills={bills} />} />
        </Routes>
      </RecordBody>
    </div>
  );
}

function Overview({ data, canEdit }: { data: NonNullable<Awaited<ReturnType<typeof fetchRouteRecord>>>; canEdit: boolean }) {
  const { route, current: c, upcoming } = data;
  if (!c) {
    return (
      <Section title="Not set up yet">
        <p className="text-[13.5px]">This route gets no DTC bill until its terms are entered.</p>
        {canEdit && <Button size="sm" className="h-9 mt-4" asChild><Link to="edit">Set up this route</Link></Button>}
      </Section>
    );
  }
  return (
    <>
      {!route.contractorId && (
        <div className="rounded-md bg-warning/10 px-4 py-3 text-[13px]">No contractor is assigned to this route. Assign one in Masters → Contractors.</div>
      )}
      {c.notes?.startsWith("Imported") && (
        <div className="rounded-md bg-warning/10 px-4 py-3 text-[13px]">
          These terms were copied from the old route master. Check them{canEdit ? <> and <Link to="edit" className="underline">save them again</Link></> : ""}.
        </div>
      )}
      <Section title="Terms in force" description={`Since ${fmtDMY(c.effectiveFrom)}`}>
        {c.active ? (
          <FieldList cols={2} items={[
            { label: "How it's paid", value: TYPE_HELP[c.billingType].text },
            { label: "Rate", value: `₹${rs2(c.rate)} ${RATE_UNIT[c.billingType]}${c.billingType === "km" ? `, ${nice(c.kmPerDay)} km a day` : ""}` },
            { label: "Vehicle", value: [c.vehicleNumber, c.vehicleCapacityMt != null ? `${nice(c.vehicleCapacityMt)} MT` : null, c.insulated ? "insulated" : null].filter(Boolean).join(", ") || "—" },
            { label: "Collects cash from dealers", value: c.cashCollection ? "Yes" : "No" },
            { label: "Agreement", value: c.agreementNo ?? "—" },
            { label: "Contract", value: c.contractStart && c.contractEnd ? `${fmtDMY(c.contractStart)} to ${fmtDMY(c.contractEnd)}` : c.contractEnd ? `Ends ${fmtDMY(c.contractEnd)}` : c.contractStart ? `From ${fmtDMY(c.contractStart)}` : "—" },
            ...(c.notes && !c.notes.startsWith("Imported") ? [{ label: "Notes", value: c.notes, wide: true }] : []),
          ]} />
        ) : <p className="text-[13.5px]">Not billed from {fmtDMY(c.effectiveFrom)}.</p>}
        {c.createdByName && <p className="text-[12px] text-muted-foreground mt-4">Entered by {c.createdByName}, {fmtStamp(c.createdAt)}</p>}
      </Section>
      {upcoming && (
        <Section title={`Changes on ${fmtDMY(upcoming.effectiveFrom)}`}>
          <p className="text-[13.5px]">
            {upcoming.active
              ? `${TYPE_HELP[upcoming.billingType].title}, ₹${rs2(upcoming.rate)} ${RATE_UNIT[upcoming.billingType]}${upcoming.billingType === "km" ? `, ${nice(upcoming.kmPerDay)} km a day` : ""}.`
              : "Billing stops."}
          </p>
        </Section>
      )}
    </>
  );
}

function BillsTable({ bills }: { bills: NonNullable<Awaited<ReturnType<typeof fetchRouteRecord>>>["bills"] }) {
  return (
    <Section title="Bills" description="The last 12 months" flush>
      {bills.length === 0 ? <p className="px-5 py-4 text-[13px] text-muted-foreground">No bills yet.</p> : (
        <table className="erp-table text-[13px]">
          <thead><tr><th>Month</th><th className="text-right">Days</th><th className="text-right">Gross</th><th className="text-right">Deductions</th><th className="text-right">Net</th><th /></tr></thead>
          <tbody>
            {bills.map(b => (
              <tr key={b.id}>
                <td><Link to={`/dtc/bills/${b.month}/${b.id}`} className="hover:underline">{monthLabel(b.month)}</Link></td>
                <td className="text-right num">{b.days}</td>
                <td className="text-right num">₹{rs(b.gross)}</td>
                <td className="text-right num">₹{rs(b.totalDeductions)}</td>
                <td className={cn("text-right num font-medium", b.net < 0 && "text-destructive")}>₹{rs(b.net)}</td>
                <td><RunStatusBadge status={b.runStatus} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

// ─── Change terms (form on the page) ────────────────────────────────
function ChangeTerms({ data }: { data: NonNullable<Awaited<ReturnType<typeof fetchRouteRecord>>> }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { route, current, upcoming, today } = data;
  const base = upcoming ?? current;
  const blank = useMemo(() => ({
    effectiveFrom: current ? today : "2020-01-01",
    active: true,
    billingType: (base?.billingType ?? "km") as BillingType,
    rate: base?.active ? String(base.rate) : "",
    kmPerDay: base?.active && base.kmPerDay ? String(base.kmPerDay) : "",
    vehicleCapacityMt: base?.vehicleCapacityMt != null ? String(base.vehicleCapacityMt) : "",
    vehicleNumber: base?.vehicleNumber ?? route.contractorVehicle ?? "",
    agreementNo: base?.agreementNo ?? "",
    contractStart: base?.contractStart ?? "",
    contractEnd: base?.contractEnd ?? "",
    insulated: base?.insulated ?? false,
    cashCollection: base?.cashCollection ?? false,
    notes: base?.notes?.startsWith("Imported") ? "" : (base?.notes ?? ""),
  }), [data]); // eslint-disable-line react-hooks/exhaustive-deps
  const [f, setF] = useState(blank);
  useEffect(() => setF(blank), [blank]);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF(p => ({ ...p, [k]: v }));
  const dirty = JSON.stringify(f) !== JSON.stringify(blank);
  const correcting = !!current && f.effectiveFrom === current.effectiveFrom;

  const mut = useMutation({
    mutationFn: () => {
      const body: RouteTermsInput = {
        routeId: route.id, effectiveFrom: f.effectiveFrom, active: f.active, billingType: f.billingType,
        rate: Number(f.rate) || 0, kmPerDay: f.billingType === "km" ? Number(f.kmPerDay) || 0 : 0,
        vehicleCapacityMt: f.vehicleCapacityMt ? Number(f.vehicleCapacityMt) : null,
        vehicleNumber: f.vehicleNumber || null, agreementNo: f.agreementNo || null,
        contractStart: f.contractStart || null, contractEnd: f.contractEnd || null,
        insulated: f.insulated, cashCollection: f.cashCollection, notes: f.notes || null,
      };
      return saveRouteTerms(body);
    },
    onSuccess: (r) => {
      toast.success(r.message);
      qc.invalidateQueries({ queryKey: ["dtc-route-record", route.id] });
      qc.invalidateQueries({ queryKey: ["dtc-route-terms"] });
      navigate(`/dtc/setup/routes/${route.id}`);
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const valid = !!f.effectiveFrom && (!f.active || (Number(f.rate) > 0 && (f.billingType !== "km" || Number(f.kmPerDay) > 0)));
  const perDay = f.billingType === "km" ? (Number(f.kmPerDay) || 0) * (Number(f.rate) || 0) : f.billingType === "trip" ? Number(f.rate) || 0 : null;

  return (
    <Section
      title={current ? "Change terms" : "Set up this route"}
      description={current
        ? correcting
          ? `Correcting the terms in force since ${fmtDMY(current.effectiveFrom)}.`
          : `A revision from ${fmtDMY(f.effectiveFrom)}. Months before keep the old rate; a month with both is split.`
        : "The first terms for this route. An early date lets past months be billed too."}
      actions={current && !correcting && (
        <Button size="sm" variant="outline" className="h-7 text-[12px]" onClick={() => set("effectiveFrom", current.effectiveFrom)}>
          Correct current terms instead
        </Button>
      )}
    >
      <div className="space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-[220px_1fr] gap-x-6 gap-y-4">
          <FormLabel title="When" text="The date these terms apply from." />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Field label="Effective from" required>
              <Input type="date" value={f.effectiveFrom} onChange={e => set("effectiveFrom", e.target.value)} className="erp-input" />
            </Field>
            <Field label="Billing">
              <label className="flex items-center gap-2 h-8 text-[13px]">
                <Switch checked={f.active} onCheckedChange={v => set("active", v)} />
                {f.active ? "Billed from this date" : "Stop billing from this date"}
              </label>
            </Field>
          </div>

          {f.active && (
            <>
              <FormLabel title="How the contractor is paid" text="Pick the basis in the tender, then the rate." />
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                  {(["km", "trip", "litre"] as BillingType[]).map(t => (
                    <button key={t} type="button" onClick={() => set("billingType", t)}
                      className={cn("text-left rounded border p-2.5 transition-colors", f.billingType === t ? "border-primary bg-primary/5 ring-1 ring-primary" : "border-border hover:bg-muted/40")}>
                      <div className="text-[13px] font-medium">{TYPE_HELP[t].title}</div>
                      <div className="text-[11.5px] text-muted-foreground">{TYPE_HELP[t].text}</div>
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label={`Rate (₹ ${RATE_UNIT[f.billingType]})`} required>
                    <Input type="number" min="0" step="0.01" value={f.rate} onChange={e => set("rate", e.target.value)} className="erp-input num" />
                  </Field>
                  {f.billingType === "km" && (
                    <Field label="Km per day" required>
                      <Input type="number" min="0" step="0.1" value={f.kmPerDay} onChange={e => set("kmPerDay", e.target.value)} className="erp-input num" />
                    </Field>
                  )}
                  <div className="self-end text-[12.5px] pb-1.5">
                    {perDay != null
                      ? <>Pays <b>₹{rs2(perDay)}</b> per day the route runs</>
                      : <>Pays rate × litres/kg carried in the month</>}
                  </div>
                </div>
              </div>

              <FormLabel title="Vehicle" text="As in the agreement." />
              <div className="space-y-3">
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <Field label="Vehicle number"><Input value={f.vehicleNumber} onChange={e => set("vehicleNumber", e.target.value)} placeholder="KA-27-A-1234" className="erp-input" /></Field>
                  <Field label="Capacity (MT)"><Input type="number" min="0" step="0.1" value={f.vehicleCapacityMt} onChange={e => set("vehicleCapacityMt", e.target.value)} className="erp-input num" /></Field>
                </div>
                <div className="flex flex-wrap gap-6 text-[13px]">
                  <label className="flex items-center gap-2"><Switch checked={f.cashCollection} onCheckedChange={v => set("cashCollection", v)} /> Collects cash from dealers</label>
                  <label className="flex items-center gap-2"><Switch checked={f.insulated} onCheckedChange={v => set("insulated", v)} /> Insulated vehicle</label>
                </div>
              </div>

              <FormLabel title="Contract" text="Tender details. The setup page warns 30 days before the end." />
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                <Field label="Agreement / tender no."><Input value={f.agreementNo} onChange={e => set("agreementNo", e.target.value)} className="erp-input" /></Field>
                <Field label="Contract start"><Input type="date" value={f.contractStart} onChange={e => set("contractStart", e.target.value)} className="erp-input" /></Field>
                <Field label="Contract end"><Input type="date" value={f.contractEnd} onChange={e => set("contractEnd", e.target.value)} className="erp-input" /></Field>
              </div>
            </>
          )}

          <FormLabel title="Notes" />
          <Textarea value={f.notes} onChange={e => set("notes", e.target.value)} className="erp-input min-h-[60px]" placeholder="e.g. Rate revised as per tender 2026-27" />
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border pt-3">
          {dirty && <span className="text-[12px] text-muted-foreground mr-auto">Unsaved changes</span>}
          <Button size="sm" variant="ghost" className="h-8" disabled={!dirty || mut.isPending} onClick={() => setF(blank)}>Reset</Button>
          <Button size="sm" className="h-8" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Saving…" : correcting ? "Save correction" : current ? `Save revision from ${fmtDMY(f.effectiveFrom)}` : "Save terms"}
          </Button>
        </div>
      </div>
    </Section>
  );
}

function FormLabel({ title, text }: { title: string; text?: string }) {
  return (
    <div>
      <div className="text-[13px] font-medium">{title}</div>
      {text && <div className="text-[11.5px] text-muted-foreground">{text}</div>}
    </div>
  );
}

function HistoryTable({ routeId, history, canEdit, today }: { routeId: string; history: RouteTerms[]; canEdit: boolean; today: string }) {
  const qc = useQueryClient();
  const del = useMutation({
    mutationFn: (id: string) => deleteRouteTerms(id),
    onSuccess: (r) => {
      toast.success(r.message);
      qc.invalidateQueries({ queryKey: ["dtc-route-record", routeId] });
      qc.invalidateQueries({ queryKey: ["dtc-route-terms"] });
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!history.length) return <p className="p-4 text-[12.5px] text-muted-foreground">No terms entered yet.</p>;
  const currentId = history.find(h => h.effectiveFrom <= today)?.id;
  return (
    <table className="erp-table text-[12.5px]">
      <thead>
        <tr>
          <th>From</th><th>Billing</th><th className="text-right">Rate</th><th className="text-right">Km/day</th>
          <th>Vehicle</th><th>Contract</th><th>Entered by</th><th />
        </tr>
      </thead>
      <tbody>
        {history.map(t => (
          <tr key={t.id}>
            <td className="whitespace-nowrap">
              {fmtDMY(t.effectiveFrom)}
              {t.id === currentId && <span className="ml-1.5 text-[10.5px] rounded bg-success/15 text-success px-1">in force</span>}
              {t.effectiveFrom > today && <span className="ml-1.5 text-[10.5px] rounded bg-info/15 text-info px-1">scheduled</span>}
            </td>
            <td>{t.active ? BILLING_TYPE_LABEL[t.billingType] : <span className="text-muted-foreground">Not billed</span>}</td>
            <td className="text-right num">{t.active ? rs2(t.rate) : ""}</td>
            <td className="text-right num">{t.active && t.billingType === "km" ? rs2(t.kmPerDay) : ""}</td>
            <td>{[t.vehicleNumber, t.vehicleCapacityMt != null ? `${rs2(t.vehicleCapacityMt)} MT` : null].filter(Boolean).join(" · ")}</td>
            <td className="whitespace-nowrap">{t.contractEnd ? `to ${fmtDMY(t.contractEnd)}` : ""} {t.agreementNo ?? ""}</td>
            <td>{t.createdByName ?? (t.notes?.startsWith("Imported") ? "Imported" : "")}</td>
            <td className="text-right">
              {canEdit && (t.usedInBills
                ? <span className="text-[11px] text-muted-foreground">used in bills</span>
                : (
                  <Button size="sm" variant="ghost" className="h-6 text-destructive" disabled={del.isPending} title="Delete this version"
                    onClick={() => { if (confirm(`Delete the terms from ${fmtDMY(t.effectiveFrom)}?`)) del.mutate(t.id); }}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                ))}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
