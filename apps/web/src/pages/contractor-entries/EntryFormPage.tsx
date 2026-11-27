// apps/web/src/pages/contractor-entries/EntryFormPage.tsx
// Contractor Entries → Record contractor entry
//   /contractor-entries/new   a new entry
//   /contractor-entries/:id   an entry, editable until its month's bills go for approval
//
// The route's contractor, vehicle and terms fill in from the route. The
// "On the bill" panel previews the line the entry puts on the route's DTC
// bill; the API works the amount out again when it is saved.
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  Boxes, Camera, Gauge, Gavel, MapPinPlus, PackageMinus, PackageX, Plus, Trash2, X,
} from "lucide-react";
import { Field } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { todayIST } from "@/lib/istDate";
import {
  createOfficerEntry, deleteOfficerEntry, fetchEntryLookups, fetchOfficerEntry, fetchRouteDealers,
  updateOfficerEntry, uploadEntryPhoto,
  type EntryInput, type EntryType, type OfficerEntry, type ReportSource, type Shift,
} from "@/services/officerEntries";
import { HEAD_LABEL, RATE_UNIT, RUN_STATUS_LABEL, errMsg, fmtDMY, monthLabel, nice, rs2 } from "@/pages/dtc/shared";
import { RecordHeader, Section } from "@/pages/dtc/ui";
import { EntryStatusPill, PENALTY_REASONS, money, qtyText, useCanRecordEntries } from "./shared";

type Pick6 = "short_supply" | "crate_shortage" | "product_shortage" | "km_short" | "extra" | "penalty";
const PICKS: { key: Pick6; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: "short_supply", label: "Short supply", icon: PackageMinus },
  { key: "crate_shortage", label: "Crate shortage", icon: Boxes },
  { key: "product_shortage", label: "Product shortage", icon: PackageX },
  { key: "km_short", label: "Km short", icon: Gauge },
  { key: "extra", label: "Extra km or trip", icon: MapPinPlus },
  { key: "penalty", label: "Penalty", icon: Gavel },
];
const HEAD_OF: Record<EntryType, string> = {
  short_supply: "short_supply", product_shortage: "packet", crate_shortage: "crate",
  km_short: "km", penalty: "penalty", extra_km: "extra_km", extra_trip: "extra_trip",
};

interface ItemRow { key: string; productId: string | null; qty: string }
const newRow = (): ItemRow => ({ key: Math.random().toString(36).slice(2), productId: null, qty: "" });
const num = (s: string) => (s.trim() === "" ? null : Number(s));
const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

export default function EntryFormPage() {
  const { id } = useParams();
  const isNew = !id || id === "new";
  const navigate = useNavigate();
  const qc = useQueryClient();
  const canRecord = useCanRecordEntries();

  const { data: existing, isLoading: loadingEntry } = useQuery({
    queryKey: ["officer-entry", id], queryFn: () => fetchOfficerEntry(id!), enabled: !isNew,
  });
  const entry = existing?.entry;

  // ── Form state ──
  const [entryDate, setEntryDate] = useState(todayIST());
  const [routeId, setRouteId] = useState<string | null>(null);
  const [shift, setShift] = useState<Shift>("morning");
  const [pick, setPick] = useState<Pick6>("short_supply");
  const [extraKind, setExtraKind] = useState<"extra_km" | "extra_trip">("extra_km");
  const [dealerId, setDealerId] = useState<string | null>(null);
  const [ssSource, setSsSource] = useState<ReportSource>("customer_call");
  const [psSource, setPsSource] = useState<ReportSource>("dispatch_check");
  const [items, setItems] = useState<ItemRow[]>([newRow()]);
  const [cratesSent, setCratesSent] = useState("");
  const [cratesReturned, setCratesReturned] = useState("");
  const [kmRun, setKmRun] = useState("");
  const [kmReason, setKmReason] = useState("");
  const [extraQty, setExtraQty] = useState("");
  const [extraReason, setExtraReason] = useState("");
  const [penaltyReason, setPenaltyReason] = useState("");
  const [penaltyAmount, setPenaltyAmount] = useState("");
  const [reference, setReference] = useState("");
  const [remarks, setRemarks] = useState("");
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  // Load an existing entry into the form once.
  const loaded = useRef<string | null>(null);
  useEffect(() => {
    if (!entry || loaded.current === entry.id) return;
    loaded.current = entry.id;
    setEntryDate(entry.entryDate);
    setRouteId(entry.routeId);
    setShift(entry.shift);
    setPick(entry.type === "extra_km" || entry.type === "extra_trip" ? "extra" : entry.type as Pick6);
    if (entry.type === "extra_km" || entry.type === "extra_trip") setExtraKind(entry.type);
    setDealerId(entry.dealerId);
    if (entry.type === "short_supply" && entry.reportSource) setSsSource(entry.reportSource);
    if (entry.type === "product_shortage" && entry.reportSource) setPsSource(entry.reportSource);
    setItems(entry.items.length ? entry.items.map(i => ({ ...newRow(), productId: i.productId, qty: String(i.qty) })) : [newRow()]);
    setCratesSent(entry.cratesSent != null ? String(entry.cratesSent) : "");
    setCratesReturned(entry.cratesReturned != null ? String(entry.cratesReturned) : "");
    setKmRun(entry.kmRun != null ? String(entry.kmRun) : "");
    if (entry.type === "km_short") setKmReason(entry.reason ?? "");
    if (entry.type === "extra_km" || entry.type === "extra_trip") {
      setExtraQty(entry.qty != null ? String(entry.qty) : "");
      setExtraReason(entry.reason ?? "");
    }
    if (entry.type === "penalty") {
      setPenaltyReason(entry.reason ?? "");
      setPenaltyAmount(String(entry.amount));
      setReference(entry.reference ?? "");
    }
    setRemarks(entry.remarks ?? "");
    setPhotoUrl(entry.photoUrl);
  }, [entry]);

  // ── Lookups for the date / route ──
  const { data: lookups } = useQuery({
    queryKey: ["officer-entry-lookups", entryDate],
    queryFn: () => fetchEntryLookups(entryDate),
    enabled: /^\d{4}-\d{2}-\d{2}$/.test(entryDate),
    placeholderData: (prev) => prev,
  });
  const route = lookups?.routes.find(r => r.id === routeId) ?? null;
  const terms = route?.terms ?? null;
  const { data: dealers = [] } = useQuery({
    queryKey: ["officer-entry-dealers", routeId], queryFn: () => fetchRouteDealers(routeId!), enabled: !!routeId,
  });

  const routeOptions: F9Option[] = useMemo(() => (lookups?.routes ?? []).map(r => ({
    value: r.id, label: `${r.code} · ${r.name}`, sublabel: r.contractorName ?? "No contractor",
  })), [lookups]);
  const dealerOptions: F9Option[] = useMemo(() => dealers.map(d => ({
    value: d.id, label: d.name, sublabel: [d.code, d.phone].filter(Boolean).join(" · "),
  })), [dealers]);
  const productOptions: F9Option[] = useMemo(() => (lookups?.products ?? []).map(p => ({
    value: p.id, label: p.name, sublabel: `${p.code ?? ""} · ₹${rs2(p.price)}`, searchText: `${p.fullName} ${p.code ?? ""}`,
  })), [lookups]);
  const priceOf = (pid: string | null) => lookups?.products.find(p => p.id === pid)?.price ?? 0;

  const type: EntryType = pick === "extra" ? extraKind : pick;
  const head = HEAD_OF[type];
  const kind = type === "extra_km" || type === "extra_trip" ? "earning" : "deduction";
  const tripBasis = type === "extra_trip" && terms?.billingType === "trip";

  // ── Preview of the bill line ──
  const preview = useMemo((): { amount: number; calc: ReactNode } => {
    switch (type) {
      case "short_supply":
      case "product_shortage": {
        const lines = items.filter(i => i.productId && Number(i.qty) > 0)
          .map(i => ({ qty: Number(i.qty), rate: priceOf(i.productId) }));
        const amount = r2(lines.reduce((s, l) => s + r2(l.qty * l.rate), 0));
        const packets = lines.reduce((s, l) => s + l.qty, 0);
        const calc = lines.length === 0 ? "Add the products short"
          : lines.length <= 2 ? lines.map(l => `${qtyText(l.qty)} × ₹${rs2(l.rate)}`).join(" + ")
          : `${lines.length} products, ${qtyText(packets)} packets at dealer price`;
        return { amount, calc };
      }
      case "crate_shortage": {
        const short = Math.max(0, (Number(cratesSent) || 0) - (Number(cratesReturned) || 0));
        const rate = lookups?.crateRate ?? 0;
        return { amount: r2(short * rate), calc: `${short} crates × ₹${rs2(rate)}` };
      }
      case "km_short": {
        const short = terms && kmRun !== "" ? Math.max(0, r2(terms.kmPerDay - Number(kmRun))) : 0;
        const rate = terms?.perKmRate ?? 0;
        return { amount: r2(short * rate), calc: `${nice(short)} km × ₹${rs2(rate)}` };
      }
      case "extra_km":
      case "extra_trip": {
        const q = Number(extraQty) || 0;
        const rate = tripBasis ? terms?.rate ?? 0 : terms?.perKmRate ?? 0;
        return { amount: r2(q * rate), calc: `${nice(q)} ${tripBasis ? (q === 1 ? "trip" : "trips") : "km"} × ₹${rs2(rate)}` };
      }
      case "penalty":
        return { amount: r2(Number(penaltyAmount) || 0), calc: "Penalty amount as entered" };
    }
  }, [type, items, cratesSent, cratesReturned, kmRun, extraQty, penaltyAmount, terms, tripBasis, lookups]); // eslint-disable-line react-hooks/exhaustive-deps

  const monthLocked = !!lookups?.runStatus && lookups.runStatus !== "draft";
  const readOnly = !canRecord || !!entry?.locked;
  const billStatus = (() => {
    if (entry && entry.routeId === routeId && entry.entryDate.slice(0, 7) === entryDate.slice(0, 7)) {
      return <EntryStatusPill status={entry.status} />;
    }
    if (!lookups) return "—";
    if (!lookups.runStatus) return "Not prepared yet";
    return lookups.runStatus === "draft" ? "Draft" : `Locked · ${RUN_STATUS_LABEL[lookups.runStatus as keyof typeof RUN_STATUS_LABEL] ?? lookups.runStatus}`;
  })();

  // ── Save ──
  const body = (): EntryInput => {
    const base: EntryInput = { entryDate, routeId: routeId!, shift, type, remarks: remarks.trim() || null, photoUrl };
    const list = items.filter(i => i.productId && Number(i.qty) > 0).map(i => ({ productId: i.productId!, qty: Number(i.qty) }));
    switch (type) {
      case "short_supply": return { ...base, dealerId, reportSource: ssSource, items: list };
      case "product_shortage": return { ...base, dealerId, reportSource: psSource, items: list };
      case "crate_shortage": return { ...base, cratesSent: num(cratesSent), cratesReturned: num(cratesReturned) };
      case "km_short": return { ...base, kmRun: num(kmRun), reason: kmReason.trim() || null };
      case "extra_km":
      case "extra_trip": return { ...base, qty: num(extraQty), reason: extraReason.trim() || null };
      case "penalty": return { ...base, reason: penaltyReason || null, amount: num(penaltyAmount), reference: reference.trim() || null };
    }
  };
  const resetDetail = () => {
    setDealerId(null); setItems([newRow()]); setCratesSent(""); setCratesReturned("");
    setKmRun(""); setKmReason(""); setExtraQty(""); setExtraReason("");
    setPenaltyReason(""); setPenaltyAmount(""); setReference(""); setRemarks(""); setPhotoUrl(null);
  };
  const save = useMutation({
    mutationFn: async (_again: boolean) => (isNew ? createOfficerEntry(body()) : updateOfficerEntry(id!, body())),
    onSuccess: (r, again) => {
      toast.success(r.message);
      qc.invalidateQueries({ queryKey: ["officer-entries"] });
      qc.invalidateQueries({ queryKey: ["officer-entry", id] });
      if (again) {
        resetDetail();
        if (!isNew) navigate("/contractor-entries/new");
      } else {
        navigate("/contractor-entries");
      }
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const remove = useMutation({
    mutationFn: () => deleteOfficerEntry(id!),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["officer-entries"] }); navigate("/contractor-entries"); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const onPhoto = async (file: File | undefined) => {
    if (!file) return;
    setUploading(true);
    try { setPhotoUrl(await uploadEntryPhoto(file)); toast.success("Photo added"); }
    catch (e) { toast.error(errMsg(e)); }
    finally { setUploading(false); }
  };

  if (!isNew && (loadingEntry || !entry)) {
    return <div className="p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
  }

  const canSave = !readOnly && !monthLocked && !!routeId && preview.amount > 0 && !save.isPending && !uploading
    && ((type !== "short_supply" && type !== "product_shortage") || !!dealerId) && (type !== "penalty" || !!penaltyReason);

  return (
    <div className="h-full overflow-auto">
      <RecordHeader
        back={{ to: "/contractor-entries", label: "My contractor entries" }}
        title={isNew ? "Record contractor entry" : "Contractor entry"}
        status={entry && <EntryStatusPill status={entry.status} />}
        subtitle={entry ? `Recorded by ${entry.createdByName ?? "—"} · ${fmtDMY(entry.createdAt)}` : undefined}
        actions={!isNew && !readOnly && (
          <Button size="sm" variant="ghost" className="h-8 text-destructive" disabled={remove.isPending}
            onClick={() => { if (confirm("Delete this entry? Its line comes off the bill.")) remove.mutate(); }}>
            <Trash2 className="h-3.5 w-3.5 mr-1.5" /> Delete
          </Button>
        )}
      />
      <div className="p-3 sm:p-5 max-w-6xl">
        {entry?.locked && (
          <p className="mb-4 rounded-md bg-muted px-4 py-2.5 text-[13px]">
            Locked: {monthLabel(entry.month)} bills have been sent for approval.
          </p>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_300px] gap-4 items-start">
          <fieldset disabled={readOnly} className="space-y-4 min-w-0">
            {/* ── Route and contractor ── */}
            <Section title="Route and contractor">
              <div className="grid grid-cols-1 sm:grid-cols-[150px_minmax(0,1fr)_140px] gap-3">
                <Field label="Date" required>
                  <Input type="date" value={entryDate} max={todayIST()} onChange={e => setEntryDate(e.target.value)} className="erp-input" />
                </Field>
                <Field label="Route" required>
                  <F9SearchSelect value={routeId} onChange={v => { setRouteId(v); setDealerId(null); }} options={routeOptions}
                    placeholder="Select your route" disabled={readOnly} />
                </Field>
                <Field label="Shift" required>
                  <select value={shift} onChange={e => setShift(e.target.value as Shift)} className="erp-input w-full">
                    <option value="morning">Morning</option>
                    <option value="evening">Evening</option>
                  </select>
                </Field>
              </div>
              {route && (
                <dl className="mt-3 grid grid-cols-1 sm:grid-cols-3 gap-x-6 gap-y-2 rounded-md border border-amber-200/70 bg-amber-50/70 px-4 py-3 text-[12.5px] dark:border-amber-900/50 dark:bg-amber-950/20">
                  <div><dt className="text-muted-foreground">Contractor</dt><dd className="font-medium">{route.contractorName ?? "No contractor"}{route.contractorPhone ? ` · ${route.contractorPhone}` : ""}</dd></div>
                  <div><dt className="text-muted-foreground">Vehicle</dt><dd className="font-medium">{route.vehicleNumber ?? "—"}</dd></div>
                  <div><dt className="text-muted-foreground">Route terms</dt><dd className="font-medium">
                    {terms
                      ? <>₹{rs2(terms.rate)} {RATE_UNIT[terms.billingType]}{terms.kmPerDay > 0 ? ` · ${nice(terms.kmPerDay)} km a day` : ""}</>
                      : <span className="text-warning">No terms on this date</span>}
                  </dd></div>
                </dl>
              )}
            </Section>

            {/* ── What happened ── */}
            <Section title="What happened">
              <div role="radiogroup" aria-label="Type of entry" className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                {PICKS.map(p => {
                  const on = pick === p.key;
                  const Icon = p.icon;
                  return (
                    <button key={p.key} type="button" role="radio" aria-checked={on} onClick={() => setPick(p.key)}
                      className={cn(
                        "flex items-center gap-2.5 rounded-md border px-3 py-2.5 text-left text-[13px] transition-colors",
                        on ? "border-primary bg-primary/5 ring-1 ring-primary font-medium" : "border-border hover:bg-muted/50",
                      )}>
                      <Icon className={cn("h-4 w-4 shrink-0", on ? "text-primary" : "text-muted-foreground")} />
                      {p.label}
                    </button>
                  );
                })}
              </div>

              <div className="mt-4 space-y-3">
                {pick === "short_supply" && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Field label="Customer on this route" required>
                        <F9SearchSelect value={dealerId} onChange={setDealerId} options={dealerOptions}
                          placeholder={routeId ? "Select customer" : "Pick the route first"} disabled={readOnly || !routeId} />
                      </Field>
                      <Field label="How you came to know" required>
                        <select value={ssSource} onChange={e => setSsSource(e.target.value as ReportSource)} className="erp-input w-full">
                          <option value="customer_call">Customer phoned</option>
                          <option value="officer_visit">Found on visit</option>
                        </select>
                      </Field>
                    </div>
                    <ItemsTable items={items} setItems={setItems} options={productOptions} priceOf={priceOf} readOnly={readOnly} />
                  </>
                )}

                {pick === "product_shortage" && (
                  <>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <Field label="Agent who was short" required>
                        <F9SearchSelect value={dealerId} onChange={setDealerId} options={dealerOptions}
                          placeholder={routeId ? "Select agent" : "Pick the route first"} disabled={readOnly || !routeId} />
                      </Field>
                      <Field label="Found at" required>
                        <select value={psSource} onChange={e => setPsSource(e.target.value as ReportSource)} className="erp-input w-full">
                          <option value="dispatch_check">Dispatch check</option>
                          <option value="return_check">Return check</option>
                          <option value="on_route">On the route</option>
                        </select>
                      </Field>
                    </div>
                    <ItemsTable items={items} setItems={setItems} options={productOptions} priceOf={priceOf} readOnly={readOnly} />
                  </>
                )}

                {pick === "crate_shortage" && (
                  <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                    <Field label="Crates sent" required>
                      <Input type="number" inputMode="numeric" min="0" value={cratesSent} onChange={e => setCratesSent(e.target.value)} className="erp-input num" />
                    </Field>
                    <Field label="Crates returned" required>
                      <Input type="number" inputMode="numeric" min="0" value={cratesReturned} onChange={e => setCratesReturned(e.target.value)} className="erp-input num" />
                    </Field>
                    <ReadOnlyField label="Short" value={Math.max(0, (Number(cratesSent) || 0) - (Number(cratesReturned) || 0))} />
                    <ReadOnlyField label="Rate per crate" value={lookups?.crateRate ? `₹${rs2(lookups.crateRate)}` : <span className="text-warning">Not set</span>} />
                  </div>
                )}

                {pick === "km_short" && (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                      <ReadOnlyField label="Route km for the day" value={terms?.kmPerDay ? nice(terms.kmPerDay) : "—"} />
                      <Field label="Km actually run" required>
                        <Input type="number" inputMode="decimal" min="0" value={kmRun} onChange={e => setKmRun(e.target.value)} className="erp-input num" />
                      </Field>
                      <ReadOnlyField label="Short km" value={terms && kmRun !== "" ? nice(Math.max(0, terms.kmPerDay - Number(kmRun))) : "—"} />
                      <ReadOnlyField label="Rate per km" value={terms?.perKmRate != null ? `₹${rs2(terms.perKmRate)}` : "—"} />
                    </div>
                    <Field label="Reason">
                      <Input value={kmReason} onChange={e => setKmReason(e.target.value)} placeholder="e.g. Skipped Guttal stop" className="erp-input" />
                    </Field>
                  </>
                )}

                {pick === "extra" && (
                  <>
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                      <Field label="Kind" required>
                        <select value={extraKind} onChange={e => setExtraKind(e.target.value as "extra_km" | "extra_trip")} className="erp-input w-full">
                          <option value="extra_km">Extra km</option>
                          <option value="extra_trip">Extra trip</option>
                        </select>
                      </Field>
                      <Field label={tripBasis ? "Trips" : "Km"} required>
                        <Input type="number" inputMode="decimal" min="0" value={extraQty} onChange={e => setExtraQty(e.target.value)} className="erp-input num" />
                      </Field>
                      <ReadOnlyField label={tripBasis ? "Rate per trip" : "Rate per km"}
                        value={tripBasis ? `₹${rs2(terms?.rate ?? 0)}` : terms?.perKmRate != null ? `₹${rs2(terms.perKmRate)}` : "—"} />
                    </div>
                    <Field label="Why it was needed" required>
                      <Input value={extraReason} onChange={e => setExtraReason(e.target.value)} placeholder="e.g. Second trip for wedding order" className="erp-input" />
                    </Field>
                  </>
                )}

                {pick === "penalty" && (
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                    <Field label="Reason" required>
                      <select value={penaltyReason} onChange={e => setPenaltyReason(e.target.value)} className="erp-input w-full">
                        <option value="">Select</option>
                        {PENALTY_REASONS.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
                      </select>
                    </Field>
                    <Field label="Amount (₹)" required>
                      <Input type="number" inputMode="decimal" min="0" step="0.01" value={penaltyAmount} onChange={e => setPenaltyAmount(e.target.value)} className="erp-input num" />
                    </Field>
                    <Field label="Order or notice no.">
                      <Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" />
                    </Field>
                  </div>
                )}
              </div>
            </Section>

            {/* ── Notes ── */}
            <Section title="Notes">
              <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,1fr)_200px] gap-3">
                <Field label="Remarks" required={pick === "penalty" && penaltyReason === "other"}>
                  <Textarea value={remarks} onChange={e => setRemarks(e.target.value)} className="erp-input min-h-[60px]" />
                </Field>
                <div>
                  <div className="text-[11.5px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">Photo</div>
                  {photoUrl ? (
                    <div className="relative inline-block">
                      <a href={photoUrl} target="_blank" rel="noreferrer">
                        <img src={photoUrl} alt="Entry photo" className="h-24 w-32 object-cover rounded border border-border" />
                      </a>
                      {!readOnly && (
                        <button type="button" onClick={() => setPhotoUrl(null)} title="Remove photo"
                          className="absolute -top-2 -right-2 rounded-full bg-background border border-border p-0.5">
                          <X className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  ) : (
                    <label className={cn("flex h-24 items-center justify-center gap-2 rounded border border-dashed border-input text-[12.5px] text-muted-foreground",
                      !readOnly && "cursor-pointer hover:bg-muted/40")}>
                      <Camera className="h-4 w-4" /> {uploading ? "Uploading…" : "Add photo (optional)"}
                      <input type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="hidden"
                        disabled={readOnly || uploading} onChange={e => { onPhoto(e.target.files?.[0]); e.target.value = ""; }} />
                    </label>
                  )}
                </div>
              </div>
            </Section>
          </fieldset>

          {/* ── On the bill ── */}
          <aside className="erp-panel p-4 space-y-3 lg:sticky lg:top-4">
            <div className="text-[14.5px] font-semibold">On the bill</div>
            <div className="flex items-center gap-2">
              <span className={cn("rounded-full px-2 py-0.5 text-[11px] font-medium",
                kind === "deduction" ? "bg-destructive/10 text-destructive" : "bg-success/15 text-success")}>
                {kind === "deduction" ? "Deduction" : "Addition"}
              </span>
              <span className="text-[13px]">{HEAD_LABEL[head] ?? head}</span>
            </div>
            <div className={cn("text-[28px] font-semibold num leading-tight", kind === "deduction" ? "text-destructive" : "text-success")}>
              {kind === "deduction" ? "−" : "+"}{money(preview.amount)}
            </div>
            <div className="text-[12.5px] text-muted-foreground num">{preview.calc}</div>
            <dl className="border-t border-border pt-3 space-y-2 text-[12.5px]">
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Contractor</dt><dd className="text-right font-medium">{route?.contractorName ?? "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Bill</dt><dd className="text-right font-medium">{route ? `${route.code} · ${monthLabel(entryDate.slice(0, 7))}` : "—"}</dd></div>
              <div className="flex justify-between gap-3"><dt className="text-muted-foreground">Bill status</dt><dd className="text-right font-medium">{billStatus}</dd></div>
            </dl>
            {!readOnly && monthLocked && (
              <p className="text-[12px] text-warning">{monthLabel(entryDate.slice(0, 7))} bills have been sent for approval. Pick another date.</p>
            )}
            {!readOnly && (
              <div className="flex flex-col gap-2 pt-1">
                <Button className="h-9" disabled={!canSave} onClick={() => save.mutate(false)}>
                  {save.isPending ? "Saving…" : "Save entry"}
                </Button>
                <Button variant="outline" className="h-9" disabled={!canSave} onClick={() => save.mutate(true)}>
                  Save and add another
                </Button>
              </div>
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function ReadOnlyField({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <div className="text-[11.5px] font-medium text-muted-foreground mb-1 uppercase tracking-wide">{label}</div>
      <div className="h-8 flex items-center rounded border border-transparent bg-muted/50 px-2 text-[12.5px] num">{value}</div>
    </div>
  );
}

/** Products short: product, packets, rate (dealer price on the date), value. */
function ItemsTable({ items, setItems, options, priceOf, readOnly }: {
  items: ItemRow[]; setItems: (f: (rows: ItemRow[]) => ItemRow[]) => void;
  options: F9Option[]; priceOf: (id: string | null) => number; readOnly: boolean;
}) {
  const update = (key: string, patch: Partial<ItemRow>) => setItems(rows => rows.map(r => (r.key === key ? { ...r, ...patch } : r)));
  const total = items.reduce((s, i) => s + r2((Number(i.qty) || 0) * priceOf(i.productId)), 0);
  return (
    <div>
      <div className="hidden sm:grid grid-cols-[minmax(0,1fr)_100px_100px_110px_32px] gap-2 text-[11.5px] font-medium text-muted-foreground uppercase tracking-wide pb-1">
        <span>Product</span><span className="text-right">Packets short</span><span className="text-right">Rate</span><span className="text-right">Value</span><span />
      </div>
      <div className="space-y-2">
        {items.map(i => {
          const rate = priceOf(i.productId);
          const used = new Set(items.filter(x => x.key !== i.key).map(x => x.productId));
          return (
            <div key={i.key} className="grid grid-cols-[minmax(0,1fr)_32px] sm:grid-cols-[minmax(0,1fr)_100px_100px_110px_32px] gap-2 items-center rounded sm:rounded-none border sm:border-0 border-border p-2 sm:p-0">
              <div className="col-span-1">
                <F9SearchSelect value={i.productId} onChange={v => update(i.key, { productId: v })}
                  options={options.filter(o => !used.has(o.value))} placeholder="Select product" disabled={readOnly} />
              </div>
              <div className="sm:hidden row-span-1 flex justify-end">
                {!readOnly && items.length > 1 && (
                  <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" title="Remove"
                    onClick={() => setItems(rows => rows.filter(r => r.key !== i.key))}><Trash2 className="h-3.5 w-3.5" /></Button>
                )}
              </div>
              <div className="col-span-2 sm:col-span-1 grid grid-cols-3 sm:contents gap-2">
                <Input type="number" inputMode="numeric" min="1" step="1" value={i.qty} placeholder="Packets" aria-label="Packets short"
                  onChange={e => update(i.key, { qty: e.target.value })} className="erp-input text-right num" />
                <div className="h-8 flex items-center justify-end rounded bg-muted/50 px-2 text-[12.5px] num">{rate ? `₹${rs2(rate)}` : "—"}</div>
                <div className="h-8 flex items-center justify-end px-2 text-[12.5px] num font-medium">₹{rs2((Number(i.qty) || 0) * rate)}</div>
              </div>
              <div className="hidden sm:flex justify-end">
                {!readOnly && items.length > 1 && (
                  <Button type="button" size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive" title="Remove"
                    onClick={() => setItems(rows => rows.filter(r => r.key !== i.key))}><Trash2 className="h-3.5 w-3.5" /></Button>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center justify-between mt-2">
        {!readOnly ? (
          <Button type="button" size="sm" variant="ghost" className="h-8 px-2" onClick={() => setItems(rows => [...rows, newRow()])}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add product
          </Button>
        ) : <span />}
        <span className="text-[13px] font-semibold num pr-2 sm:pr-[42px]">₹{rs2(total)}</span>
      </div>
    </div>
  );
}
