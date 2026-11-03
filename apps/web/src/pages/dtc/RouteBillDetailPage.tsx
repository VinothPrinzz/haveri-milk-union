// apps/web/src/pages/dtc/RouteBillDetailPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → one route's bill  (/dtc/bills/:month/:billId)
//
// A record page: the header carries the bill's figures and its approval
// stage; the sections below are
//   Days & gross          days and litres found, correctable per part of the month
//   Other earnings        } editable tables: add a row at the bottom, edit in
//   Deductions            } place; automatic rows (GPS, deposit, advance,
//                         } last month's balance, TDS) are marked "auto"
//   Contractor & vehicle  bank, PAN / TDS status, route terms
//   Activity & payments   who changed what, payment record
// Holding a bill from payment opens in place under the header.
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
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
  errMsg, fmtDMY, fmtStamp, monthLong, qtyFmt, rs, rs2, useDtcPerms,
} from "./shared";
import { RunPipeline } from "./RunActions";
import { FieldList, InlinePanel, RecordHeader, Section, SectionTabs, Timeline } from "./ui";

type HeadDef = { head: string; label: string; unit?: string; usesBillRate?: string; usesCrateRate?: boolean };
const ALL_HEADS = [...EARNING_HEADS, ...DEDUCTION_HEADS] as HeadDef[];

export default function RouteBillDetailPage() {
  const { month = "", billId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const perms = useDtcPerms();
  const [holdOpen, setHoldOpen] = useState(false);

  const { data, isLoading } = useQuery({ queryKey: ["dtc-bill", billId], queryFn: () => fetchBill(billId) });
  const { data: run } = useQuery({ queryKey: ["dtc-run", month], queryFn: () => fetchRun(month) });
  const bill = data?.bill;
  const editable = bill?.runStatus === "draft" && perms.prepare;

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
    return <div className="p-4 space-y-2">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
  }
  const earnings = bill.lines.filter(l => l.kind === "earning");
  const deductions = bill.lines.filter(l => l.kind === "deduction");

  return (
    <div className="h-full overflow-auto">
      <RecordHeader
        back={{ to: `/dtc/bills/${month}`, label: `DTC Bills: ${monthLong(month)}` }}
        code={bill.routeCode}
        title={bill.routeName}
        status={
          <>
            <RunStatusBadge status={bill.runStatus} />
            {bill.onHold && <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-warning/15 text-warning">On hold</span>}
            {bill.paidOn && <span className="rounded px-1.5 py-0.5 text-[11px] font-medium bg-success/15 text-success">Paid {fmtDMY(bill.paidOn)}</span>}
          </>
        }
        subtitle={<>
          {monthLong(month)} · {bill.contractorName ?? "no contractor"} · {BILLING_TYPE_LABEL[bill.billingType]} @ ₹{rs2(bill.rate)} {RATE_UNIT[bill.billingType]}
          {bill.billingType === "km" ? ` × ${rs2(bill.kmPerDay)} km/day` : ""}
          {idx >= 0 && <span className="ml-2">· route {idx + 1} of {order.length}</span>}
        </>}
        actions={
          <>
            <Button size="sm" variant="outline" className="h-8" disabled={!prev} onClick={() => prev && navigate(`/dtc/bills/${month}/${prev.id}`)} title={prev ? `${prev.routeCode} ${prev.routeName}` : ""}>
              <ChevronLeft className="h-3.5 w-3.5 mr-0.5" /> Previous
            </Button>
            <Button size="sm" variant="outline" className="h-8" disabled={!next} onClick={() => next && navigate(`/dtc/bills/${month}/${next.id}`)} title={next ? `${next.routeCode} ${next.routeName}` : ""}>
              Next <ChevronRight className="h-3.5 w-3.5 ml-0.5" />
            </Button>
            {perms.pay && !bill.paidOn && (bill.onHold
              ? <Button size="sm" variant="outline" className="h-8" disabled={hold.isPending} onClick={() => hold.mutate({ on: false })}><Unlock className="h-3.5 w-3.5 mr-1.5" /> Release for payment</Button>
              : <Button size="sm" variant="outline" className="h-8" onClick={() => setHoldOpen(v => !v)}><Hand className="h-3.5 w-3.5 mr-1.5" /> Hold payment</Button>)}
          </>
        }
        facts={[
          { label: "Days", value: bill.days, hint: `${qtyFmt(bill.qtyLitres)} L/kg carried` },
          { label: "Gross payable", value: `₹${rs(bill.gross)}` },
          { label: "Other earnings", value: `₹${rs2(bill.otherEarnings)}` },
          { label: "Total deductions", value: `₹${rs(bill.totalDeductions)}`, tone: "warning" },
          {
            label: bill.net < 0 ? "Net (to recover)" : "Net payable", value: `₹${rs(bill.net)}`,
            tone: bill.net < 0 ? "danger" : "success",
            hint: bill.carryForward > 0 ? "recovered from next month's bill" : `earnings ₹${rs(bill.totalEarnings)}`,
          },
          { label: "Cost per litre", value: `₹${rs2(bill.costPerLitre)}` },
        ]}
      >
        {run && <div className="mt-3"><RunPipeline run={run.run} /></div>}
        <div className="mt-3">
          <HoldPanel open={holdOpen} busy={hold.isPending} onCancel={() => setHoldOpen(false)} onHold={reason => hold.mutate({ on: true, reason })} />
        </div>
      </RecordHeader>

      <SectionTabs sections={[
        { id: "gross", label: "Days & gross" },
        { id: "earnings", label: "Other earnings", count: earnings.length },
        { id: "deductions", label: "Deductions", count: deductions.length },
        { id: "contractor", label: "Contractor & vehicle" },
        { id: "activity", label: "Activity & payments", count: data.events.length },
      ]} />

      <div className="p-3 sm:p-5 space-y-4 max-w-6xl">
        {bill.onHold && (
          <div className="erp-panel p-3 border-l-4 border-l-warning text-[12.5px]"><b>On hold for payment:</b> {bill.holdReason}</div>
        )}
        {!editable && bill.runStatus !== "draft" && (
          <div className="text-[12px] text-muted-foreground">
            This month is with the approvers, so the bill is read-only. To correct it, the approver sends the month back.
          </div>
        )}

        <GrossSection data={data} editable={!!editable} onSaved={refresh} />

        <LinesSection id="earnings" title="Other earnings" kind="earning" data={data} lines={earnings} editable={!!editable} onSaved={refresh}
          description="Extra km, extra trips, extra litres and other amounts paid on top of the gross." />
        <LinesSection id="deductions" title="Deductions" kind="deduction" data={data} lines={deductions} editable={!!editable} onSaved={refresh}
          description="Crate and packet shortage, short km, dues, penalties and others. Rows marked auto come from setup and are refreshed on regenerate." />

        {editable && bill.suppressedAuto.length > 0 && <RestoreAuto billId={bill.id} count={bill.suppressedAuto.length} onDone={refresh} />}

        <Section id="contractor" title="Contractor & vehicle">
          <FieldList cols={3} items={[
            { label: "Contractor", value: bill.contractorName ? <>{bill.contractorName}{bill.contractorCode ? ` (${bill.contractorCode})` : ""}</> : "—" },
            { label: "Phone", value: bill.contractorPhone ?? "—" },
            { label: "Bank", value: bill.bankName ?? "—" },
            { label: "Account no.", value: bill.accountNo ?? <span className="text-warning">not on record</span> },
            { label: "IFSC", value: bill.ifscCode ?? <span className="text-warning">not on record</span> },
            { label: "PAN", value: bill.panNumber ?? <span className="text-warning">not on record</span> },
            { label: "194C declaration", value: bill.tdsDeclarationFy ? `for ${bill.tdsDeclarationFy}` : "—" },
            { label: "Vehicle", value: [bill.vehicleNumber, bill.vehicleCapacityMt != null ? `${rs2(bill.vehicleCapacityMt)} MT` : null].filter(Boolean).join(" · ") || "—" },
            { label: "Cash collection route", value: bill.cashCollection ? <>Yes · sales billed on the route this month ₹{rs(data.routeSales)}</> : "No" },
          ]} />
          <div className="mt-3 flex flex-wrap gap-3 text-[12.5px]">
            {bill.contractorId && <Link to={`/dtc/reports/ledger?contractor=${bill.contractorId}`} className="text-primary hover:underline">Contractor ledger →</Link>}
            <Link to={`/dtc/setup/routes/${bill.routeId}`} className="text-primary hover:underline">Route billing terms →</Link>
          </div>
          {bill.cashCollection && <p className="text-[11.5px] text-muted-foreground mt-2">Cash-collection route: enter any cash the driver did not hand over as a Dues deduction.</p>}
        </Section>

        <NotesSection billId={bill.id} notes={bill.notes} editable={!!editable} onSaved={refresh} />

        <Section id="activity" title="Activity & payments">
          <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6">
            <Timeline items={data.events.map(e => ({
              id: e.id, who: e.userName, when: fmtStamp(e.createdAt), text: e.detail ?? e.action,
              tone: e.action === "paid" ? "success" : e.action === "held" || e.action === "line_removed" ? "warning" : "default",
            }))} />
            <div>
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-1.5">Payments</div>
              {data.payments.length === 0 ? <p className="text-[12.5px] text-muted-foreground">Not paid yet.</p> : (
                <ul className="space-y-1.5 text-[12.5px]">
                  {data.payments.map(p => (
                    <li key={p.id} className={p.reversedAt ? "line-through text-muted-foreground" : ""}>
                      ₹{rs2(p.amount)} on {fmtDMY(p.paidOn)} · {p.mode.toUpperCase()} {p.reference ?? ""}
                      {p.reversedAt && <span className="no-underline"> (reversed: {p.reverseReason})</span>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>
        </Section>
      </div>
    </div>
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
    <Section id="gross" title="Days & gross payable" flush
      description="Days are the dates the route sold or was dispatched. Correct the billed days if the vehicle ran on other days.">
      <table className="erp-table text-[12.5px]">
        <thead>
          <tr>
            <th>Period</th><th>Billing</th><th className="text-right">Rate</th><th className="text-right">Km/day</th>
            <th className="text-right">Days found</th><th className="text-right">Days billed</th>
            <th className="text-right">Litres/kg</th><th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {bill.segments.map(s => <SegmentRow key={s.key} s={s} editable={editable} busy={mut.isPending} onSave={d => mut.mutate({ key: s.key, daysOverride: d })} />)}
          <tr className="font-semibold bg-muted/40">
            <td colSpan={5}>Gross payable (rounded to the rupee)</td>
            <td className="text-right num">{bill.days}</td>
            <td className="text-right num">{qtyFmt(bill.qtyLitres)}</td>
            <td className="text-right num">₹{rs(bill.gross)}</td>
          </tr>
        </tbody>
      </table>
      {bill.segments.length > 1 && <p className="px-4 py-2 text-[11.5px] text-muted-foreground">The rate changed during the month, so each part is billed at its own rate.</p>}
    </Section>
  );
}

function SegmentRow({ s, editable, busy, onSave }: { s: BillSegment; editable: boolean; busy: boolean; onSave: (d: number | null) => void }) {
  const [val, setVal] = useState(String(s.daysOverride ?? s.autoDays));
  const [showDates, setShowDates] = useState(false);
  useEffect(() => setVal(String(s.daysOverride ?? s.autoDays)), [s.daysOverride, s.autoDays]);
  const days = s.daysOverride ?? s.autoDays;
  const formula = s.billingType === "km" ? `${days} days × ${rs2(s.kmPerDay)} km × ₹${rs2(s.rate)}`
    : s.billingType === "trip" ? `${days} days × ₹${rs2(s.rate)}` : `${qtyFmt(s.qty)} L/kg × ₹${rs2(s.rate)}`;
  const commit = () => {
    const n = val.trim() === "" ? null : Math.max(0, Math.round(Number(val)));
    if (n === days) return;
    onSave(n === s.autoDays ? null : n);
  };
  return (
    <>
      <tr>
        <td className="whitespace-nowrap">{fmtDMY(s.from)} – {fmtDMY(s.to)}</td>
        <td>{BILLING_TYPE_LABEL[s.billingType]}</td>
        <td className="text-right num">{rs2(s.rate)}</td>
        <td className="text-right num">{s.billingType === "km" ? rs2(s.kmPerDay) : ""}</td>
        <td className="text-right">
          <button type="button" className="num underline decoration-dotted underline-offset-2" onClick={() => setShowDates(v => !v)} title="Show the dates">{s.autoDays}</button>
        </td>
        <td className="text-right">
          {editable ? (
            <span className="inline-flex items-center gap-1">
              <input type="number" min={0} max={31} value={val} disabled={busy}
                onChange={e => setVal(e.target.value)} onBlur={commit}
                onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
                className={cn("w-16 h-7 text-right num rounded border px-1.5 bg-background", s.daysOverride != null ? "border-info text-info" : "border-input")} />
              {s.daysOverride != null && (
                <button type="button" title="Back to the days found" className="text-muted-foreground hover:text-foreground" onClick={() => onSave(null)}><RotateCcw className="h-3.5 w-3.5" /></button>
              )}
            </span>
          ) : <span className="num">{days}{s.daysOverride != null && <span className="text-info">*</span>}</span>}
        </td>
        <td className="text-right num">{qtyFmt(s.qty)}</td>
        <td className="text-right num">₹{rs2(s.amount)}<div className="text-[10.5px] text-muted-foreground">{formula}</div></td>
      </tr>
      {showDates && (
        <tr>
          <td colSpan={8} className="text-[12px] text-muted-foreground bg-muted/20">
            {s.runDates?.length
              ? <>Ran on: {s.runDates.map(d => <span key={d} className="inline-block rounded bg-background border border-border px-1 mr-1 mb-0.5 num">{d.slice(8, 10)}</span>)}</>
              : "No sale or dispatch found on this route in this period."}
            {s.daysOverride != null && <> · Billed for {s.daysOverride} days, corrected by hand.</>}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Earnings / deductions: editable table ──────────────────────────
function LinesSection({ id, title, description, kind, data, lines, editable, onSaved }: {
  id: string; title: string; description: string; kind: "earning" | "deduction";
  data: BillDetail; lines: BillLine[]; editable: boolean; onSaved: () => void;
}) {
  const [editing, setEditing] = useState<string | null>(null);
  const del = useMutation({
    mutationFn: (l: BillLine) => deleteBillLine(data.bill.id, l.id),
    onSuccess: (r) => { toast.success(r.message); onSaved(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return (
    <Section id={id} title={title} description={description} flush
      actions={<span className="text-[13px] font-semibold num">Total ₹{rs2(total)}</span>}>
      <table className="erp-table text-[12.5px]">
        <thead>
          <tr>
            <th style={{ width: "24%" }}>Head</th><th className="text-right" style={{ width: 100 }}>Qty</th>
            <th className="text-right" style={{ width: 110 }}>Rate (₹)</th><th className="text-right" style={{ width: 120 }}>Amount (₹)</th>
            <th>Remarks</th><th style={{ width: 80 }} />
          </tr>
        </thead>
        <tbody>
          {lines.length === 0 && !editable && <tr><td colSpan={6} className="text-muted-foreground">None.</td></tr>}
          {lines.map(l => editing === l.id
            ? <LineEditor key={l.id} kind={kind} data={data} line={l} onDone={() => { setEditing(null); onSaved(); }} onCancel={() => setEditing(null)} />
            : (
              <tr key={l.id}>
                <td>
                  {HEAD_LABEL[l.head] ?? l.head}
                  {l.source === "auto" && <span className="ml-1.5 text-[10px] rounded bg-info/15 text-info px-1" title="Added from setup; refreshed on regenerate">auto</span>}
                </td>
                <td className="text-right num">{l.qty != null && l.head !== "tds" ? rs2(l.qty) : ""}</td>
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
    <div className="erp-panel p-3 text-[12.5px] flex flex-wrap items-center gap-2">
      <AlertTriangle className="h-4 w-4 text-warning" />
      {count} automatic row{count === 1 ? " was" : "s were"} removed or changed by hand on this bill.
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
    <Section title="Notes" description={editable ? "Saved when you click away" : undefined}>
      {editable
        ? <Textarea value={val} onChange={e => setVal(e.target.value)} onBlur={() => { if ((notes ?? "") !== val) mut.mutate(); }} className="erp-input min-h-[60px]" placeholder="Anything the pre-auditor should know about this bill" />
        : <p className="text-[12.5px] whitespace-pre-wrap">{notes}</p>}
    </Section>
  );
}
