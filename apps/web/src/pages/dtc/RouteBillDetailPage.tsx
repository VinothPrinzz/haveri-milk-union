// apps/web/src/pages/dtc/RouteBillDetailPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → one route's bill  (/dtc/bills/:month/:billId/*)
//
// The bill is split into small pages behind tabs, each doing one job:
//   (index)      Summary     the bill in plain words: how the gross is worked
//                            out (days × km × rate) and gross + earnings − deductions
//   earnings     Earnings    extra km / trips / litres and others (editable table)
//   deductions   Deductions  crate, short km, dues, … (editable table)
//   contractor   Contractor  bank, PAN / TDS, vehicle
//   history      History     who changed what, payments
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Link, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, Check, ChevronLeft, ChevronRight, Hand, Pencil, Plus, RotateCcw, Trash2, Unlock, X } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  addBillLine, deleteBillLine, fetchBill, fetchRun, holdBill, restoreAutoLines, updateBill, updateBillLine,
  type BillDetail, type BillLine, type BillSegment,
} from "@/services/dtc";
import {
  BILLING_TYPE_LABEL, DEDUCTION_HEADS, EARNING_HEADS, HEAD_LABEL, RATE_UNIT, RunStatusBadge,
  errMsg, fmtDMY, fmtStamp, monthLong, nice, qtyFmt, rs, rs2, useDtcPerms,
} from "./shared";
import { Breakdown, FieldList, InlinePanel, RecordBody, RecordHeader, Section, Summary, Timeline } from "./ui";

type HeadDef = { head: string; label: string; unit?: string; usesBillRate?: string; usesCrateRate?: boolean };
const ALL_HEADS = [...EARNING_HEADS, ...DEDUCTION_HEADS] as HeadDef[];

export default function RouteBillDetailPage() {
  const { month = "", billId = "" } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const qc = useQueryClient();
  const perms = useDtcPerms();
  const [holdOpen, setHoldOpen] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ["dtc-bill", billId], queryFn: () => fetchBill(billId) });
  const { data: run } = useQuery({ queryKey: ["dtc-run", month], queryFn: () => fetchRun(month) });
  const bill = data?.bill;
  const editable = bill?.runStatus === "draft" && perms.prepare;
  const base = `/dtc/bills/${month}/${billId}`;
  const sub = pathname.startsWith(base) ? pathname.slice(base.length) : "";

  const order = run?.bills ?? [];
  const idx = order.findIndex(b => b.id === billId);
  const prev = idx > 0 ? order[idx - 1] : null;
  const next = idx >= 0 && idx < order.length - 1 ? order[idx + 1] : null;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dtc-bill", billId] });
    qc.invalidateQueries({ queryKey: ["dtc-run", month] });
    qc.invalidateQueries({ queryKey: ["dtc-runs"] });
  };
  const hold = useMutation({
    mutationFn: ({ on, reason }: { on: boolean; reason?: string }) => holdBill(billId, on, reason),
    onSuccess: (r) => { toast.success(r.message); setHoldOpen(false); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  if (isLoading || !bill || !data) {
    return <div className="p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
  }
  const earnings = bill.lines.filter(l => l.kind === "earning");
  const deductions = bill.lines.filter(l => l.kind === "deduction");

  return (
    <div className="h-full overflow-auto">
      <RecordHeader
        back={{ to: `/dtc/bills/${month}`, label: `${monthLong(month)} bills` }}
        code={bill.routeCode}
        title={bill.routeName}
        status={
          <>
            <RunStatusBadge status={bill.runStatus} />
            {bill.onHold && <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-warning/15 text-warning">On hold</span>}
            {bill.paidOn && <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-success/15 text-success">Paid</span>}
          </>
        }
        subtitle={`${bill.contractorName ?? "No contractor"} · ${monthLong(month)}`}
        actions={
          <>
            {perms.pay && !bill.paidOn && (bill.onHold
              ? <Button size="sm" variant="outline" className="h-8" disabled={hold.isPending} onClick={() => hold.mutate({ on: false })}><Unlock className="h-3.5 w-3.5 mr-1.5" /> Release</Button>
              : <Button size="sm" variant="ghost" className="h-8" onClick={() => setHoldOpen(v => !v)}><Hand className="h-3.5 w-3.5 mr-1.5" /> Hold payment</Button>)}
            <Button size="sm" variant="outline" className="h-8 w-8 p-0" disabled={!prev} title={prev ? `Previous: ${prev.routeName}` : ""}
              onClick={() => prev && navigate(`/dtc/bills/${month}/${prev.id}${sub}`)}><ChevronLeft className="h-4 w-4" /></Button>
            <Button size="sm" variant="outline" className="h-8 w-8 p-0" disabled={!next} title={next ? `Next: ${next.routeName}` : ""}
              onClick={() => next && navigate(`/dtc/bills/${month}/${next.id}${sub}`)}><ChevronRight className="h-4 w-4" /></Button>
          </>
        }
        facts={[
          { label: "Days run", value: bill.days },
          { label: "Gross", value: `₹${rs(bill.gross)}` },
          { label: "Deductions", value: `₹${rs(bill.totalDeductions)}` },
          { label: bill.net < 0 ? "To recover" : "Net payable", value: `₹${rs(Math.abs(bill.net))}`, tone: bill.net < 0 ? "danger" : "success" },
        ]}
        tabs={[
          { to: base, label: "Summary", end: true },
          { to: `${base}/earnings`, label: "Earnings", count: earnings.length },
          { to: `${base}/deductions`, label: "Deductions", count: deductions.length },
          { to: `${base}/contractor`, label: "Contractor" },
          { to: `${base}/history`, label: "History" },
        ]}
      >
        {holdOpen && <div className="mt-3 max-w-xl"><HoldPanel open busy={hold.isPending} onCancel={() => setHoldOpen(false)} onHold={reason => hold.mutate({ on: true, reason })} /></div>}
      </RecordHeader>

      <RecordBody>
        {bill.onHold && (
          <div className="rounded-md bg-warning/10 px-4 py-3 text-[13px]"><b>On hold:</b> {bill.holdReason}</div>
        )}
        <Routes>
          <Route index element={<SummaryPage data={data} editable={!!editable} onSaved={refresh} />} />
          <Route path="earnings" element={
            <LinesSection key="earning" kind="earning" data={data} lines={earnings} editable={!!editable} onSaved={refresh} />} />
          <Route path="deductions" element={
            <>
              <LinesSection key="deduction" kind="deduction" data={data} lines={deductions} editable={!!editable} onSaved={refresh} />
              {editable && bill.suppressedAuto.length > 0 && <RestoreAuto billId={bill.id} count={bill.suppressedAuto.length} onDone={refresh} />}
            </>} />
          <Route path="contractor" element={<ContractorPage data={data} />} />
          <Route path="history" element={<HistoryPage data={data} />} />
        </Routes>
      </RecordBody>
    </div>
  );
}

// ─── Summary ────────────────────────────────────────────────────────
function SummaryPage({ data, editable, onSaved }: { data: BillDetail; editable: boolean; onSaved: () => void }) {
  const { bill } = data;
  const how = bill.billingType === "km"
    ? <>paid <b>₹{rs2(bill.rate)} a km</b> for <b>{nice(bill.kmPerDay)} km a day</b></>
    : bill.billingType === "trip" ? <>paid <b>₹{rs2(bill.rate)} a trip</b></> : <>paid <b>₹{rs2(bill.rate)} a litre</b> carried</>;
  return (
    <>
      <Summary>
        {bill.contractorName ?? "The contractor"} is {how}. In {monthLong(data.bill.month)} the route ran on <b>{bill.days} days</b> and
        carried <b>{qtyFmt(bill.qtyLitres)} litres/kg</b> of milk and products.
        {bill.paidOn && <> Paid on {fmtDMY(bill.paidOn)}{bill.paymentReference ? ` (${bill.paymentReference})` : ""}.</>}
      </Summary>
      {!editable && bill.runStatus !== "draft" && (
        <p className="text-[12.5px] text-muted-foreground">This month is with the approvers, so the bill can't be changed now.</p>
      )}
      <GrossSection data={data} editable={editable} onSaved={onSaved} />
      <Section title="The bill">
        <Breakdown
          rows={[
            { label: "Gross", value: `₹${rs(bill.gross)}` },
            { label: <Link to="earnings" className="hover:underline">Other earnings</Link>, value: `₹${rs2(bill.otherEarnings)}`, sign: "+" },
            { label: <Link to="deductions" className="hover:underline">Deductions</Link>, value: `₹${rs(bill.totalDeductions)}`, sign: "−" },
          ]}
          total={{ label: bill.net < 0 ? "To recover next month" : "Net payable", value: `₹${rs(Math.abs(bill.net))}`, tone: bill.net < 0 ? "danger" : "success" }}
        />
        <p className="text-[12px] text-muted-foreground mt-3">Cost of transport: ₹{rs2(bill.costPerLitre)} a litre.</p>
      </Section>
      <NotesSection billId={bill.id} notes={bill.notes} editable={editable} onSaved={onSaved} />
    </>
  );
}

function ContractorPage({ data }: { data: BillDetail }) {
  const { bill } = data;
  return (
    <>
      <Section title="Contractor">
        <FieldList cols={2} items={[
          { label: "Name", value: bill.contractorName ? <>{bill.contractorName}{bill.contractorCode ? ` (${bill.contractorCode})` : ""}</> : "—" },
          { label: "Phone", value: bill.contractorPhone ?? "—" },
          { label: "Bank account", value: bill.accountNo ? `${bill.bankName ?? ""} ${bill.accountNo}` : <span className="text-warning">Not on record</span> },
          { label: "IFSC", value: bill.ifscCode ?? <span className="text-warning">Not on record</span> },
          { label: "PAN", value: bill.panNumber ?? <span className="text-warning">Not on record</span> },
          { label: "TDS declaration", value: bill.tdsDeclarationFy ? `Given for ${bill.tdsDeclarationFy}` : "Not given" },
        ]} />
        {bill.contractorId && <Link to={`/dtc/reports/ledger?contractor=${bill.contractorId}`} className="inline-block mt-4 text-[13px] text-primary hover:underline">See all their bills →</Link>}
      </Section>
      <Section title="Route and vehicle">
        <FieldList cols={2} items={[
          { label: "Paid on", value: `${BILLING_TYPE_LABEL[bill.billingType]} basis, ₹${rs2(bill.rate)} ${RATE_UNIT[bill.billingType]}` },
          { label: "Vehicle", value: [bill.vehicleNumber, bill.vehicleCapacityMt != null ? `${nice(bill.vehicleCapacityMt)} MT` : null].filter(Boolean).join(", ") || "—" },
          { label: "Collects cash", value: bill.cashCollection ? `Yes. Sales on the route this month: ₹${rs(data.routeSales)}` : "No" },
        ]} />
        <Link to={`/dtc/setup/routes/${bill.routeId}`} className="inline-block mt-4 text-[13px] text-primary hover:underline">Route terms →</Link>
      </Section>
    </>
  );
}

function HistoryPage({ data }: { data: BillDetail }) {
  return (
    <>
      <Section title="Payments">
        {data.payments.length === 0 ? <p className="text-[13px] text-muted-foreground">Not paid yet.</p> : (
          <ul className="space-y-1.5 text-[13px]">
            {data.payments.map(p => (
              <li key={p.id} className={p.reversedAt ? "text-muted-foreground" : ""}>
                <span className={p.reversedAt ? "line-through" : ""}>₹{rs2(p.amount)} on {fmtDMY(p.paidOn)}, {p.mode.toUpperCase()} {p.reference ?? ""}</span>
                {p.reversedAt && <> (reversed: {p.reverseReason})</>}
              </li>
            ))}
          </ul>
        )}
      </Section>
      <Section title="What happened">
        <Timeline items={data.events.map(e => ({
          id: e.id, who: e.userName, when: fmtStamp(e.createdAt), text: e.detail ?? e.action,
          tone: e.action === "paid" ? "success" : e.action === "held" ? "warning" : "default",
        }))} />
      </Section>
    </>
  );
}

function HoldPanel({ open, busy, onCancel, onHold }: { open: boolean; busy: boolean; onCancel: () => void; onHold: (reason: string) => void }) {
  const [reason, setReason] = useState("");
  return (
    <InlinePanel open={open} tone="warning" title="Hold this bill from payment">
      <Textarea autoFocus value={reason} onChange={e => setReason(e.target.value)} placeholder="Why (at least 5 characters), e.g. km dispute with the route officer" className="erp-input min-h-[60px]" />
      <div className="flex justify-end gap-1.5">
        <Button size="sm" variant="ghost" className="h-8" onClick={onCancel}>Cancel</Button>
        <Button size="sm" className="h-8" disabled={reason.trim().length < 5 || busy} onClick={() => onHold(reason)}>Hold payment</Button>
      </div>
    </InlinePanel>
  );
}

// ─── Days & gross ───────────────────────────────────────────────────
function GrossSection({ data, editable, onSaved }: { data: BillDetail; editable: boolean; onSaved: () => void }) {
  const { bill } = data;
  const mut = useMutation({
    mutationFn: (u: { key: string; daysOverride: number | null }) => updateBill(bill.id, { segments: [u] }),
    onSuccess: onSaved,
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Section title="How the gross is worked out" flush
      description={editable ? "Days are counted from sales and dispatch on the route. Change them if the vehicle ran on other days." : undefined}>
      <table className="erp-table text-[13px]">
        <thead>
          <tr>
            <th>Period</th><th className="text-right">Days found</th><th className="text-right">Days billed</th><th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {bill.segments.map(s => <SegmentRow key={s.key} s={s} editable={editable} busy={mut.isPending} onSave={d => mut.mutate({ key: s.key, daysOverride: d })} />)}
          <tr className="font-semibold">
            <td colSpan={2}>Gross</td>
            <td className="text-right num">{bill.days}</td>
            <td className="text-right num">₹{rs(bill.gross)}</td>
          </tr>
        </tbody>
      </table>
      {bill.segments.length > 1 && <p className="px-5 py-3 text-[12px] text-muted-foreground">The rate changed during the month, so each part is paid at its own rate.</p>}
    </Section>
  );
}

function SegmentRow({ s, editable, busy, onSave }: { s: BillSegment; editable: boolean; busy: boolean; onSave: (d: number | null) => void }) {
  const [val, setVal] = useState(String(s.daysOverride ?? s.autoDays));
  const [showDates, setShowDates] = useState(false);
  useEffect(() => setVal(String(s.daysOverride ?? s.autoDays)), [s.daysOverride, s.autoDays]);
  const days = s.daysOverride ?? s.autoDays;
  const formula = s.billingType === "km" ? `${days} days × ${nice(s.kmPerDay)} km × ₹${rs2(s.rate)}`
    : s.billingType === "trip" ? `${days} trips × ₹${rs2(s.rate)}` : `${qtyFmt(s.qty)} litres × ₹${rs2(s.rate)}`;
  const commit = () => {
    const n = val.trim() === "" ? null : Math.max(0, Math.round(Number(val)));
    if (n === days) return;
    onSave(n === s.autoDays ? null : n);
  };
  return (
    <>
      <tr>
        <td className="whitespace-nowrap">
          {fmtDMY(s.from)} – {fmtDMY(s.to)}
          <div className="text-[12px] text-muted-foreground">{formula}</div>
        </td>
        <td className="text-right">
          <button type="button" className="num underline decoration-dotted underline-offset-2" onClick={() => setShowDates(v => !v)} title="Show the dates">{s.autoDays}</button>
        </td>
        <td className="text-right">
          {editable ? (
            <span className="inline-flex items-center gap-1">
              <input type="number" min={0} max={31} value={val} disabled={busy} aria-label="Days billed"
                onChange={e => setVal(e.target.value)} onBlur={commit}
                onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className={cn("w-16 h-8 text-right num rounded border px-2 bg-background", s.daysOverride != null ? "border-info text-info" : "border-input")} />
              {s.daysOverride != null && (
                <button type="button" title="Back to the days found" className="text-muted-foreground hover:text-foreground" onClick={() => onSave(null)}><RotateCcw className="h-3.5 w-3.5" /></button>
              )}
            </span>
          ) : <span className="num">{days}</span>}
        </td>
        <td className="text-right num">₹{rs2(s.amount)}</td>
      </tr>
      {showDates && (
        <tr>
          <td colSpan={4} className="text-[12.5px] text-muted-foreground bg-muted/20">
            {s.runDates?.length
              ? <>Ran on {s.runDates.map(d => Number(d.slice(8, 10))).join(", ")}</>
              : "No sale or dispatch found on this route in this period."}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Earnings / deductions: editable table ──────────────────────────
function LinesSection({ kind, data, lines, editable, onSaved }: {
  kind: "earning" | "deduction"; data: BillDetail; lines: BillLine[]; editable: boolean; onSaved: () => void;
}) {
  const title = kind === "earning" ? "Other earnings" : "Deductions";
  const description = kind === "earning"
    ? "Paid on top of the gross: extra km, extra trips, extra litres."
    : "Taken off the bill: crates or packets short, short km, dues, penalties. Rows marked auto come from setup.";
  const [editing, setEditing] = useState<string | null>(null);
  const del = useMutation({
    mutationFn: (l: BillLine) => deleteBillLine(data.bill.id, l.id),
    onSuccess: (r) => { toast.success(r.message); onSaved(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return (
    <Section title={title} description={description} flush
      actions={<span className="text-[14px] font-semibold num">₹{rs2(total)}</span>}>
      <table className="erp-table text-[13px]">
        <thead>
          <tr>
            <th style={{ width: "24%" }}>Head</th><th className="text-right" style={{ width: 100 }}>Qty</th>
            <th className="text-right" style={{ width: 110 }}>Rate (₹)</th><th className="text-right" style={{ width: 120 }}>Amount (₹)</th>
            <th>Remarks</th><th style={{ width: 80 }} />
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 && !editable && <tr><td colSpan={6} className="text-muted-foreground">Nothing this month.</td></tr>}
          {lines.map(l => editing === l.id
            ? <LineEditor key={l.id} kind={kind} data={data} line={l} onDone={() => { setEditing(null); onSaved(); }} onCancel={() => setEditing(null)} />
            : (
              <tr key={l.id}>
                <td>
                  {HEAD_LABEL[l.head] ?? l.head}
                  {l.source === "auto" && <span className="ml-1.5 text-[10px] rounded bg-info/15 text-info px-1" title="Added from setup; refreshed on regenerate">auto</span>}
                </td>
                <td className="text-right num">{l.qty != null && l.head !== "tds" ? nice(l.qty) : ""}</td>
                <td className="text-right num">{l.rate != null ? (l.head === "tds" ? `${l.rate}%` : rs2(l.rate)) : ""}</td>
                <td className="text-right num font-medium">{rs2(l.amount)}</td>
                <td className="text-[12px]">{l.remarks ?? ""}</td>
                <td className="text-right whitespace-nowrap">
                  {editable && (
                    <>
                      {!(l.source === "auto" && l.head === "tds") && (
                        <Button size="sm" variant="ghost" className="h-6 w-6 p-0" title="Edit" onClick={() => setEditing(l.id)}><Pencil className="h-3.5 w-3.5" /></Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-6 w-6 p-0 text-destructive" title="Remove" disabled={del.isPending}
                        onClick={() => {
                          const msg = l.source === "auto"
                            ? `Remove this automatic ${HEAD_LABEL[l.head] ?? l.head} row? It stays off this bill when the month is regenerated.`
                            : `Remove ${HEAD_LABEL[l.head] ?? l.head} ₹${rs2(l.amount)}?`;
                          if (confirm(msg)) del.mutate(l);
                        }}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </td>
              </tr>
            ))}
          {editable && editing == null && <LineEditor kind={kind} data={data} onDone={onSaved} />}
        </tbody>
      </table>
    </Section>
  );
}

/** One editable row: a new line (bottom of the table) or an existing one. */
function LineEditor({ kind, data, line, onDone, onCancel }: {
  kind: "earning" | "deduction"; data: BillDetail; line?: BillLine; onDone: () => void; onCancel?: () => void;
}) {
  const { bill } = data;
  const heads = (kind === "earning" ? EARNING_HEADS : DEDUCTION_HEADS.filter(h => h.head !== "tds" || !bill.lines.some(l => l.head === "tds"))) as HeadDef[];
  const [head, setHead] = useState(line?.head ?? heads[0]!.head);
  const def = useMemo(() => ALL_HEADS.find(h => h.head === head), [head]);
  const defaultRate = (d?: HeadDef) =>
    d?.usesCrateRate ? (data.crateRate ? String(data.crateRate) : "")
      : d?.usesBillRate && d.usesBillRate === bill.billingType ? String(bill.rate) : "";
  const [qty, setQty] = useState(line?.qty != null ? String(line.qty) : "");
  const [rate, setRate] = useState(line ? (line.rate != null ? String(line.rate) : "") : defaultRate(def));
  const [amount, setAmount] = useState(line && line.qty == null ? String(line.amount) : "");
  const [remarks, setRemarks] = useState(line?.remarks ?? "");
  const hasUnit = !!def?.unit;
  const both = hasUnit && qty !== "" && rate !== "";
  const computed = both ? Math.round(Number(qty) * Number(rate) * 100) / 100 : Number(amount) || 0;

  const pickHead = (h: string) => {
    setHead(h);
    const d = ALL_HEADS.find(x => x.head === h);
    setRate(defaultRate(d)); setQty(""); setAmount("");
  };
  const mut = useMutation({
    mutationFn: () => {
      const body = { qty: both ? Number(qty) : null, rate: both ? Number(rate) : null, amount: both ? null : Number(amount), remarks: remarks || null };
      return line ? updateBillLine(bill.id, line.id, body) : addBillLine(bill.id, { head, ...body });
    },
    onSuccess: () => {
      toast.success(line ? "Updated" : `${HEAD_LABEL[head]} ₹${rs2(computed)} added`);
      if (!line) { setQty(""); setAmount(""); setRemarks(""); }
      onDone();
    },
    onError: (e) => toast.error(errMsg(e)),
  });
  const submit = () => { if (computed > 0 && !mut.isPending) mut.mutate(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === "Enter") submit(); if (e.key === "Escape") onCancel?.(); };

  return (
    <tr className={line ? "bg-primary/5" : "bg-muted/20"}>
      <td>
        {line ? (
          <span>{HEAD_LABEL[line.head] ?? line.head}{line.source === "auto" && <span className="block text-[10.5px] text-muted-foreground">becomes manual when saved</span>}</span>
        ) : (
          <select value={head} onChange={e => pickHead(e.target.value)} className="erp-input w-full h-7">
            {heads.map(h => <option key={h.head} value={h.head}>{h.label}</option>)}
          </select>
        )}
      </td>
      <td>
        {hasUnit
          ? <Input type="number" min="0" value={qty} onChange={e => setQty(e.target.value)} onKeyDown={onKey} placeholder={def?.unit} className="erp-input h-7 text-right num" />
          : <span className="block text-right text-muted-foreground text-[11px]">—</span>}
      </td>
      <td>
        {hasUnit
          ? <Input type="number" min="0" step="0.01" value={rate} onChange={e => setRate(e.target.value)} onKeyDown={onKey} className="erp-input h-7 text-right num" />
          : <span className="block text-right text-muted-foreground text-[11px]">—</span>}
      </td>
      <td>
        {both
          ? <div className="text-right num font-medium pr-1">{rs2(computed)}</div>
          : <Input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} onKeyDown={onKey} placeholder="0.00" className="erp-input h-7 text-right num" />}
      </td>
      <td>
        <Input value={remarks} onChange={e => setRemarks(e.target.value)} onKeyDown={onKey}
          placeholder={head === "crate" ? "e.g. 5 crates short as per audit" : head === "km" ? "e.g. As per route officer recommendation" : "Remarks"}
          className="erp-input h-7" />
        {head === "crate" && !data.crateRate && <div className="text-[10.5px] text-warning mt-0.5">No crate rate set (Setup → Crate Rates): type the rate.</div>}
      </td>
      <td className="text-right whitespace-nowrap">
        <Button size="sm" className="h-7 px-2" disabled={!(computed > 0) || mut.isPending} onClick={submit} title={line ? "Save" : "Add"}>
          {line ? <Check className="h-3.5 w-3.5" /> : <><Plus className="h-3.5 w-3.5 mr-0.5" />Add</>}
        </Button>
        {line && <Button size="sm" variant="ghost" className="h-7 w-7 p-0 ml-0.5" onClick={onCancel} title="Cancel"><X className="h-3.5 w-3.5" /></Button>}
      </td>
    </tr>
  );
}

function RestoreAuto({ billId, count, onDone }: { billId: string; count: number; onDone: () => void }) {
  const mut = useMutation({
    mutationFn: () => restoreAutoLines(billId),
    onSuccess: (r) => { toast.success(r.message); onDone(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="text-[12.5px] text-muted-foreground flex flex-wrap items-center gap-2">
      <AlertTriangle className="h-4 w-4 text-warning" />
      {count} automatic row{count === 1 ? " was" : "s were"} removed or changed by hand.
      <Button size="sm" variant="outline" className="h-7 ml-auto" disabled={mut.isPending} onClick={() => mut.mutate()}>
        <RotateCcw className="h-3 w-3 mr-1" /> Restore automatic rows
      </Button>
    </div>
  );
}

function NotesSection({ billId, notes, editable, onSaved }: { billId: string; notes: string | null; editable: boolean; onSaved: () => void }) {
  const [val, setVal] = useState(notes ?? "");
  useEffect(() => setVal(notes ?? ""), [notes]);
  const mut = useMutation({
    mutationFn: () => updateBill(billId, { notes: val || null }),
    onSuccess: () => { toast.success("Notes saved"); onSaved(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!editable && !notes) return null;
  return (
    <Section title="Notes">
      {editable
        ? <Textarea value={val} onChange={e => setVal(e.target.value)} onBlur={() => { if ((notes ?? "") !== val) mut.mutate(); }} className="erp-input min-h-[60px]" placeholder="Anything the pre-auditor should know about this bill" />
        : <p className="text-[12.5px] whitespace-pre-wrap">{notes}</p>}
    </Section>
  );
}
