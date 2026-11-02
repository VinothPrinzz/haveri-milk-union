// apps/web/src/pages/dtc/RouteBillDetailPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → one route's bill  (/dtc/bills/:month/:billId)
//
// Days and litres found for the month (correctable), the gross worked out
// from the route terms, and the earnings / deductions on the bill:
//   • typed by the clerk: extra km, crate / packet shortage, short km, dues,
//     penalties, … — qty × rate fills the amount;
//   • added automatically: GPS and fixed charges, the security deposit
//     instalment, advances to recover, last month's negative balance, TDS.
// Removing an automatic line keeps it off when the month is regenerated.
// Finance can hold the bill from payment here.
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { Field } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ArrowLeft, ChevronLeft, ChevronRight, Hand, Pencil, Plus, RotateCcw, Trash2, Unlock } from "lucide-react";
import {
  addBillLine, deleteBillLine, fetchBill, fetchRun, holdBill, restoreAutoLines, updateBill, updateBillLine,
  type BillLine, type BillDetail, type BillSegment,
} from "@/services/dtc";
import {
  BILLING_TYPE_LABEL, DEDUCTION_HEADS, EARNING_HEADS, HEAD_LABEL, InfoRow, RATE_UNIT, RunStatusBadge,
  errMsg, fmtDMY, fmtStamp, monthLong, qtyFmt, rs, rs2, useDtcPerms,
} from "./shared";

export default function RouteBillDetailPage() {
  const { month = "", billId = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const perms = useDtcPerms();

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

  if (isLoading || !bill || !data) {
    return <div className="p-4 space-y-2">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>;
  }
  const earnings = bill.lines.filter(l => l.kind === "earning");
  const deductions = bill.lines.filter(l => l.kind === "deduction");

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={`${bill.routeCode}: ${bill.routeName}`}
        subtitle={`DTC bill for ${monthLong(month)} · ${bill.contractorName ?? "no contractor"}`}
        actions={
          <>
            <Button size="sm" variant="ghost" className="h-8" asChild>
              <Link to={`/dtc/bills/${month}`}><ArrowLeft className="h-3.5 w-3.5 mr-1" /> {monthLong(month)}</Link>
            </Button>
            <Button size="sm" variant="outline" className="h-8" disabled={!prev} onClick={() => prev && navigate(`/dtc/bills/${month}/${prev.id}`)} title={prev ? `${prev.routeCode} ${prev.routeName}` : ""}>
              <ChevronLeft className="h-3.5 w-3.5" />
            </Button>
            <Button size="sm" variant="outline" className="h-8" disabled={!next} onClick={() => next && navigate(`/dtc/bills/${month}/${next.id}`)} title={next ? `${next.routeCode} ${next.routeName}` : ""}>
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            {perms.pay && !bill.paidOn && <HoldButton billId={bill.id} onHold={bill.onHold} onDone={refresh} />}
          </>
        }
      />

      <div className="flex-1 overflow-auto p-3 sm:p-4">
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-3">
          <div className="space-y-3 min-w-0">
            {bill.onHold && (
              <div className="erp-panel p-3 border-l-4 border-l-warning text-[12.5px]">
                <b>On hold for payment:</b> {bill.holdReason}
              </div>
            )}
            {!editable && bill.runStatus !== "draft" && (
              <div className="text-[12px] text-muted-foreground">
                This month is <RunStatusBadge status={bill.runStatus} />; the bill can't be edited. To correct it, the approver sends the month back.
              </div>
            )}

            <SegmentsPanel data={data} editable={!!editable} onSaved={refresh} />

            <LinesPanel title="Other earnings" lines={earnings} billId={bill.id} editable={!!editable} onSaved={refresh} />
            <LinesPanel title="Deductions" lines={deductions} billId={bill.id} editable={!!editable} onSaved={refresh} />

            {editable && <AddLineForm data={data} onSaved={refresh} />}

            {editable && bill.suppressedAuto.length > 0 && (
              <RestoreAuto billId={bill.id} count={bill.suppressedAuto.length} onDone={refresh} />
            )}

            <NotesPanel billId={bill.id} notes={bill.notes} editable={!!editable} onSaved={refresh} />

            <ActivityPanel data={data} />
          </div>

          <div className="space-y-3">
            <div className="erp-panel p-3">
              <div className="erp-section-title">Bill</div>
              <InfoRow label="Gross payable">₹{rs(bill.gross)}</InfoRow>
              <InfoRow label="Other earnings">₹{rs2(bill.otherEarnings)}</InfoRow>
              <InfoRow label="Total earnings">₹{rs(bill.totalEarnings)}</InfoRow>
              <InfoRow label="Total deductions">₹{rs(bill.totalDeductions)}</InfoRow>
              <div className="border-t border-border my-1.5" />
              <InfoRow label={bill.net < 0 ? "Net (negative)" : "Net payable"}>
                <span className={`text-[15px] ${bill.net < 0 ? "text-destructive" : "text-success"}`}>₹{rs(bill.net)}</span>
              </InfoRow>
              {bill.carryForward > 0 && (
                <p className="text-[11.5px] text-destructive mt-1">
                  Deductions are more than the earnings. ₹{rs(bill.carryForward)} is recovered from the contractor's next bill.
                </p>
              )}
              <InfoRow label="Cost per litre">₹{rs2(bill.costPerLitre)}</InfoRow>
              {bill.paidOn && (
                <p className="text-[12px] text-success mt-1.5">Paid on {fmtDMY(bill.paidOn)} ({bill.paymentMode?.toUpperCase()} {bill.paymentReference ?? ""})</p>
              )}
            </div>

            <div className="erp-panel p-3">
              <div className="erp-section-title">Route & vehicle</div>
              <InfoRow label="Billing">{BILLING_TYPE_LABEL[bill.billingType]} @ ₹{rs2(bill.rate)} {RATE_UNIT[bill.billingType]}</InfoRow>
              {bill.billingType === "km" && <InfoRow label="Km per day">{rs2(bill.kmPerDay)}</InfoRow>}
              <InfoRow label="Vehicle">{bill.vehicleNumber ?? "—"}</InfoRow>
              <InfoRow label="Capacity">{bill.vehicleCapacityMt != null ? `${rs2(bill.vehicleCapacityMt)} MT` : "—"}</InfoRow>
              <InfoRow label="Litres/kg carried">{qtyFmt(bill.qtyLitres)}</InfoRow>
              {bill.cashCollection && (
                <InfoRow label="Sales billed on route">₹{rs(data.routeSales)}</InfoRow>
              )}
              {bill.cashCollection && (
                <p className="text-[11px] text-muted-foreground">Cash-collection route: enter any cash not handed over as Dues.</p>
              )}
            </div>

            <div className="erp-panel p-3">
              <div className="erp-section-title">Contractor</div>
              <InfoRow label="Name">{bill.contractorName ?? "—"}</InfoRow>
              <InfoRow label="Phone">{bill.contractorPhone ?? "—"}</InfoRow>
              <InfoRow label="Bank">{bill.bankName ?? "—"}</InfoRow>
              <InfoRow label="Account / IFSC">{bill.accountNo ? `${bill.accountNo} / ${bill.ifscCode ?? "no IFSC"}` : "—"}</InfoRow>
              <InfoRow label="PAN">{bill.panNumber ?? <span className="text-warning">not on record</span>}</InfoRow>
              <InfoRow label="194C declaration">{bill.tdsDeclarationFy ?? "—"}</InfoRow>
              {bill.contractorId && (
                <Link to={`/dtc/reports/ledger?contractor=${bill.contractorId}`} className="text-[12px] text-primary underline">Contractor ledger</Link>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── Days / segments ────────────────────────────────────────────────
function SegmentsPanel({ data, editable, onSaved }: { data: BillDetail; editable: boolean; onSaved: () => void }) {
  const { bill } = data;
  const [open, setOpen] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (u: { key: string; daysOverride: number | null }) => updateBill(bill.id, { segments: [u] }),
    onSuccess: onSaved,
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="erp-panel overflow-auto">
      <div className="px-3 pt-2.5 erp-section-title">Gross payable</div>
      <table className="erp-table text-[12px]">
        <thead>
          <tr>
            <th>Period</th><th>Type</th><th className="text-right">Rate</th><th className="text-right">Km/day</th>
            <th className="text-right">Days found</th><th className="text-right">Days billed</th>
            <th className="text-right">Litres/kg</th><th className="text-right">Amount</th>
          </tr>
        </thead>
        <tbody>
          {bill.segments.map((s: BillSegment) => (
            <SegmentRow key={s.key} s={s} editable={editable} busy={mut.isPending}
              open={open === s.key} onToggle={() => setOpen(open === s.key ? null : s.key)}
              onSave={(d) => mut.mutate({ key: s.key, daysOverride: d })} />
          ))}
          <tr className="font-semibold bg-muted/40">
            <td colSpan={5}>Gross payable (rounded to the rupee)</td>
            <td className="text-right num">{bill.days}</td>
            <td className="text-right num">{qtyFmt(bill.qtyLitres)}</td>
            <td className="text-right num">₹{rs(bill.gross)}</td>
          </tr>
        </tbody>
      </table>
      {bill.segments.length > 1 && (
        <p className="px-3 py-2 text-[11.5px] text-muted-foreground">The rate changed during the month, so the month is billed in parts.</p>
      )}
    </div>
  );
}

function SegmentRow({ s, editable, busy, open, onToggle, onSave }: {
  s: BillSegment; editable: boolean; busy: boolean; open: boolean; onToggle: () => void; onSave: (d: number | null) => void;
}) {
  const [val, setVal] = useState(String(s.daysOverride ?? s.autoDays));
  useEffect(() => setVal(String(s.daysOverride ?? s.autoDays)), [s.daysOverride, s.autoDays]);
  const formula = s.billingType === "km"
    ? `${s.daysOverride ?? s.autoDays} × ${rs2(s.kmPerDay)} km × ₹${rs2(s.rate)}`
    : s.billingType === "trip" ? `${s.daysOverride ?? s.autoDays} × ₹${rs2(s.rate)}` : `${qtyFmt(s.qty)} × ₹${rs2(s.rate)}`;
  const commit = () => {
    const n = val.trim() === "" ? null : Math.max(0, Math.round(Number(val)));
    if (n === (s.daysOverride ?? s.autoDays)) return;
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
          <button type="button" className="underline decoration-dotted num" onClick={onToggle} title="Show the dates">{s.autoDays}</button>
        </td>
        <td className="text-right">
          {editable ? (
            <input type="number" min={0} max={31} value={val} disabled={busy}
              onChange={e => setVal(e.target.value)} onBlur={commit}
              onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); }}
              className={`w-16 h-6 text-right num rounded border px-1 bg-background ${s.daysOverride != null ? "border-info text-info" : "border-input"}`} />
          ) : (
            <span className="num">{s.daysOverride ?? s.autoDays}{s.daysOverride != null && <span className="text-info">*</span>}</span>
          )}
        </td>
        <td className="text-right num">{qtyFmt(s.qty)}</td>
        <td className="text-right num" title={formula}>₹{rs2(s.amount)}<div className="text-[10px] text-muted-foreground">{formula}</div></td>
      </tr>
      {open && (
        <tr>
          <td colSpan={8} className="text-[11.5px] text-muted-foreground bg-muted/20">
            {s.runDates && s.runDates.length
              ? <>Days the route sold or was dispatched: {s.runDates.map(d => d.slice(8, 10)).join(", ")}</>
              : "No sale or dispatch found on this route in this period."}
            {s.daysOverride != null && <> · Billed for {s.daysOverride} days (corrected by hand).</>}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Lines ──────────────────────────────────────────────────────────
function LinesPanel({ title, lines, billId, editable, onSaved }: {
  title: string; lines: BillLine[]; billId: string; editable: boolean; onSaved: () => void;
}) {
  const [editing, setEditing] = useState<BillLine | null>(null);
  const del = useMutation({
    mutationFn: (l: BillLine) => deleteBillLine(billId, l.id),
    onSuccess: (r) => { toast.success(r.message); onSaved(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const total = lines.reduce((s, l) => s + l.amount, 0);
  return (
    <div className="erp-panel overflow-auto">
      <div className="px-3 pt-2.5 erp-section-title">{title}</div>
      {lines.length === 0 ? (
        <div className="px-3 pb-3 text-[12px] text-muted-foreground">None.</div>
      ) : (
        <table className="erp-table text-[12px]">
          <thead><tr><th>Head</th><th className="text-right">Qty</th><th className="text-right">Rate</th><th className="text-right">Amount</th><th>Remarks</th><th /></tr></thead>
          <tbody>
            {lines.map(l => (
              <tr key={l.id}>
                <td className="whitespace-nowrap">
                  {HEAD_LABEL[l.head] ?? l.head}
                  {l.source === "auto" && <span className="ml-1.5 text-[10px] rounded bg-info/15 text-info px-1">auto</span>}
                </td>
                <td className="text-right num">{l.qty != null && l.head !== "tds" ? rs2(l.qty) : ""}</td>
                <td className="text-right num">{l.rate != null ? (l.head === "tds" ? `${l.rate}%` : rs2(l.rate)) : ""}</td>
                <td className="text-right num">₹{rs2(l.amount)}</td>
                <td className="text-[11.5px]">{l.remarks ?? ""}</td>
                <td className="text-right whitespace-nowrap">
                  {editable && (
                    <>
                      {!(l.source === "auto" && l.head === "tds") && (
                        <Button size="sm" variant="ghost" className="h-6" onClick={() => setEditing(l)}><Pencil className="h-3.5 w-3.5" /></Button>
                      )}
                      <Button size="sm" variant="ghost" className="h-6 text-destructive" disabled={del.isPending}
                        onClick={() => {
                          const msg = l.source === "auto"
                            ? `Remove this automatic ${HEAD_LABEL[l.head] ?? l.head} line? It stays off this bill when the month is regenerated.`
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
            <tr className="font-semibold bg-muted/40">
              <td colSpan={3}>Total</td><td className="text-right num">₹{rs2(total)}</td><td colSpan={2} />
            </tr>
          </tbody>
        </table>
      )}
      {editing && <EditLineDialog billId={billId} line={editing} onClose={() => setEditing(null)} onSaved={onSaved} />}
    </div>
  );
}

function EditLineDialog({ billId, line, onClose, onSaved }: { billId: string; line: BillLine; onClose: () => void; onSaved: () => void }) {
  const [qty, setQty] = useState(line.qty != null ? String(line.qty) : "");
  const [rate, setRate] = useState(line.rate != null ? String(line.rate) : "");
  const [amount, setAmount] = useState(String(line.amount));
  const [remarks, setRemarks] = useState(line.remarks ?? "");
  const both = qty !== "" && rate !== "";
  const computed = both ? Math.round(Number(qty) * Number(rate) * 100) / 100 : Number(amount) || 0;
  const mut = useMutation({
    mutationFn: () => updateBillLine(billId, line.id, {
      qty: both ? Number(qty) : null, rate: both ? Number(rate) : null, amount: both ? null : Number(amount), remarks: remarks || null,
    }),
    onSuccess: (r) => { toast.success(r.message); onSaved(); onClose(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Edit {HEAD_LABEL[line.head] ?? line.head}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          {line.source === "auto" && <p className="text-[12px] text-muted-foreground">An edited automatic line becomes a manual one and is no longer updated on regeneration.</p>}
          <div className="grid grid-cols-3 gap-2">
            <Field label="Qty"><Input type="number" min="0" value={qty} onChange={e => setQty(e.target.value)} className="erp-input num" /></Field>
            <Field label="Rate (₹)"><Input type="number" min="0" step="0.01" value={rate} onChange={e => setRate(e.target.value)} className="erp-input num" /></Field>
            <Field label="Amount (₹)">
              <Input type="number" min="0" step="0.01" value={both ? String(computed) : amount} disabled={both} onChange={e => setAmount(e.target.value)} className="erp-input num" />
            </Field>
          </div>
          <Field label="Remarks"><Input value={remarks} onChange={e => setRemarks(e.target.value)} className="erp-input" /></Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!(computed > 0) || mut.isPending} onClick={() => mut.mutate()}>{mut.isPending ? "Saving…" : "Save"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddLineForm({ data, onSaved }: { data: BillDetail; onSaved: () => void }) {
  const { bill } = data;
  const [kind, setKind] = useState<"deduction" | "earning">("deduction");
  const heads = kind === "earning" ? EARNING_HEADS : DEDUCTION_HEADS.filter(h => h.head !== "tds" || !bill.lines.some(l => l.head === "tds"));
  const [head, setHead] = useState("crate");
  const def = useMemo(() => [...EARNING_HEADS, ...DEDUCTION_HEADS].find(h => h.head === head), [head]);
  const [qty, setQty] = useState("");
  const [rate, setRate] = useState("");
  const [amount, setAmount] = useState("");
  const [remarks, setRemarks] = useState("");

  // Offer the right rate for the head: the crate rate, or the bill's own rate.
  useEffect(() => {
    const d = [...EARNING_HEADS, ...DEDUCTION_HEADS].find(h => h.head === head) as
      { usesBillRate?: string; usesCrateRate?: boolean; unit?: string } | undefined;
    if (d?.usesCrateRate) setRate(data.crateRate ? String(data.crateRate) : "");
    else if (d?.usesBillRate && d.usesBillRate === bill.billingType) setRate(String(bill.rate));
    else setRate("");
    setQty(""); setAmount("");
  }, [head, data.crateRate, bill.billingType, bill.rate]);

  const hasUnit = !!(def as { unit?: string } | undefined)?.unit;
  const both = hasUnit && qty !== "" && rate !== "";
  const computed = both ? Math.round(Number(qty) * Number(rate) * 100) / 100 : Number(amount) || 0;
  const mut = useMutation({
    mutationFn: () => addBillLine(bill.id, {
      head, qty: both ? Number(qty) : null, rate: both ? Number(rate) : null, amount: both ? null : Number(amount), remarks: remarks || null,
    }),
    onSuccess: () => { toast.success(`${HEAD_LABEL[head]} ₹${rs2(computed)} added`); setQty(""); setAmount(""); setRemarks(""); onSaved(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="erp-panel p-3">
      <div className="erp-section-title flex items-center gap-2">
        Add
        <div className="flex rounded border border-border overflow-hidden text-[11.5px] font-normal normal-case tracking-normal">
          {(["deduction", "earning"] as const).map(k => (
            <button key={k} type="button"
              onClick={() => { setKind(k); setHead(k === "earning" ? "extra_km" : "crate"); }}
              className={`px-2.5 py-0.5 ${kind === k ? "bg-primary text-primary-foreground" : ""}`}>
              {k === "deduction" ? "Deduction" : "Other earning"}
            </button>
          ))}
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-6 gap-2 items-end">
        <Field label="Head" className="col-span-2">
          <select value={head} onChange={e => setHead(e.target.value)} className="erp-input w-full">
            {heads.map(h => <option key={h.head} value={h.head}>{h.label}</option>)}
          </select>
        </Field>
        {hasUnit ? (
          <>
            <Field label={`Qty (${(def as { unit?: string }).unit})`}>
              <Input type="number" min="0" value={qty} onChange={e => setQty(e.target.value)} className="erp-input num" />
            </Field>
            <Field label="Rate (₹)">
              <Input type="number" min="0" step="0.01" value={rate} onChange={e => setRate(e.target.value)} className="erp-input num" />
            </Field>
          </>
        ) : (
          <Field label="Amount (₹)" className="col-span-2">
            <Input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="erp-input num" />
          </Field>
        )}
        <Field label="Remarks" className="col-span-2 md:col-span-1">
          <Input value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="e.g. As per route officer" className="erp-input" />
        </Field>
        <Button size="sm" className="h-8" disabled={!(computed > 0) || mut.isPending} onClick={() => mut.mutate()}>
          <Plus className="h-3.5 w-3.5 mr-1" /> {computed > 0 ? `₹${rs2(computed)}` : "Add"}
        </Button>
      </div>
      {head === "crate" && !data.crateRate && <p className="text-[11.5px] text-warning mt-1.5">No crate rate is set (DTC Billing → Crate Rates). Type the rate.</p>}
      {hasUnit && (def as { usesBillRate?: string }).usesBillRate && (def as { usesBillRate?: string }).usesBillRate !== bill.billingType && (
        <p className="text-[11.5px] text-muted-foreground mt-1.5">This route is billed {BILLING_TYPE_LABEL[bill.billingType]}: type the rate to use.</p>
      )}
    </div>
  );
}

function RestoreAuto({ billId, count, onDone }: { billId: string; count: number; onDone: () => void }) {
  const mut = useMutation({
    mutationFn: () => restoreAutoLines(billId),
    onSuccess: (r) => { toast.success(r.message); onDone(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  return (
    <div className="text-[12px] text-muted-foreground flex items-center gap-2">
      {count} automatic line{count === 1 ? " was" : "s were"} removed or changed by hand on this bill.
      <Button size="sm" variant="outline" className="h-7" disabled={mut.isPending} onClick={() => mut.mutate()}>
        <RotateCcw className="h-3 w-3 mr-1" /> Restore automatic lines
      </Button>
    </div>
  );
}

function NotesPanel({ billId, notes, editable, onSaved }: { billId: string; notes: string | null; editable: boolean; onSaved: () => void }) {
  const [val, setVal] = useState(notes ?? "");
  useEffect(() => setVal(notes ?? ""), [notes]);
  const mut = useMutation({
    mutationFn: () => updateBill(billId, { notes: val || null }),
    onSuccess: () => { toast.success("Notes saved"); onSaved(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (!editable && !notes) return null;
  return (
    <div className="erp-panel p-3">
      <div className="erp-section-title">Notes</div>
      {editable
        ? <Textarea value={val} onChange={e => setVal(e.target.value)} onBlur={() => { if ((notes ?? "") !== val) mut.mutate(); }} className="erp-input min-h-[50px]" />
        : <p className="text-[12.5px] whitespace-pre-wrap">{notes}</p>}
    </div>
  );
}

function ActivityPanel({ data }: { data: BillDetail }) {
  if (data.events.length === 0 && data.payments.length === 0) return null;
  return (
    <div className="erp-panel p-3">
      <div className="erp-section-title">Activity</div>
      <ul className="space-y-1 text-[12px]">
        {data.events.map(e => (
          <li key={e.id} className="flex gap-2">
            <span className="text-muted-foreground whitespace-nowrap">{fmtStamp(e.createdAt)}</span>
            <span className="font-medium whitespace-nowrap">{e.userName ?? ""}</span>
            <span>{e.detail ?? e.action}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function HoldButton({ billId, onHold, onDone }: { billId: string; onHold: boolean; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const mut = useMutation({
    mutationFn: (v: boolean) => holdBill(billId, v, reason),
    onSuccess: (r) => { toast.success(r.message); setOpen(false); setReason(""); onDone(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  if (onHold) {
    return (
      <Button size="sm" variant="outline" className="h-8" disabled={mut.isPending} onClick={() => mut.mutate(false)}>
        <Unlock className="h-3.5 w-3.5 mr-1.5" /> Release for payment
      </Button>
    );
  }
  return (
    <>
      <Button size="sm" variant="outline" className="h-8" onClick={() => setOpen(true)}><Hand className="h-3.5 w-3.5 mr-1.5" /> Hold payment</Button>
      {open && (
        <Dialog open onOpenChange={v => { if (!v) setOpen(false); }}>
          <DialogContent className="max-w-md">
            <DialogHeader><DialogTitle>Hold this bill from payment</DialogTitle></DialogHeader>
            <Field label="Why" required hint="min 5 chars">
              <Textarea autoFocus value={reason} onChange={e => setReason(e.target.value)} className="erp-input min-h-[70px]" />
            </Field>
            <DialogFooter>
              <Button variant="outline" size="sm" className="h-8" onClick={() => setOpen(false)}>Cancel</Button>
              <Button size="sm" className="h-8" disabled={reason.trim().length < 5 || mut.isPending} onClick={() => mut.mutate(true)}>Hold</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
