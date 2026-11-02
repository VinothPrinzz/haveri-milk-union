// apps/web/src/pages/dtc/MonthlyBillSheetPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → one month's bills  (/dtc/bills/:month)
//
// The month at a glance, laid out like the Consolidated DTC Bill: one row
// per route with days, km, rate, litres, gross, other earnings, deductions,
// net payable and cost per litre. In a draft, days can be corrected right
// here; everything else is entered on the route's bill (click the row).
// The approval buttons for the signed-in user's stage sit in the header.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState, StatCard, fmtINR } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertTriangle, ArrowLeft, CalendarPlus, Printer, RefreshCw, Search, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/apiClient";
import { createRun, deleteRun, fetchRun, regenerateRun, updateBill, type Bill } from "@/services/dtc";
import { RunActionButtons, RunTimeline } from "./RunActions";
import {
  BILLING_TYPE_LABEL, RunStatusBadge, errMsg, monthLong, qtyFmt, rs, rs2, useDtcPerms,
} from "./shared";

export default function MonthlyBillSheetPage() {
  const { month = "" } = useParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const perms = useDtcPerms();
  const [search, setSearch] = useState("");

  const { data, isLoading, error } = useQuery({
    queryKey: ["dtc-run", month],
    queryFn: () => fetchRun(month),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const notFound = error instanceof ApiError && error.status === 404;
  const run = data?.run;
  const editable = run?.status === "draft" && perms.prepare;

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["dtc-run", month] });
    qc.invalidateQueries({ queryKey: ["dtc-runs"] });
  };
  const regen = useMutation({
    mutationFn: () => regenerateRun(run!.id),
    onSuccess: (r) => { toast.success(r.message); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const discard = useMutation({
    mutationFn: () => deleteRun(run!.id),
    onSuccess: (r) => { toast.success(r.message); qc.invalidateQueries({ queryKey: ["dtc-runs"] }); navigate("/dtc/bills"); },
    onError: (e) => toast.error(errMsg(e)),
  });
  const create = useMutation({
    mutationFn: () => createRun(month),
    onSuccess: (r) => { toast.success(r.message); refresh(); },
    onError: (e) => toast.error(errMsg(e)),
  });

  const bills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.bills ?? []).filter(b =>
      !q || `${b.routeCode} ${b.routeName} ${b.contractorName ?? ""} ${b.vehicleNumber ?? ""}`.toLowerCase().includes(q));
  }, [data, search]);
  const totals = useMemo(() => {
    const all = data?.bills ?? [];
    const sum = (k: keyof Bill) => all.reduce((s, b) => s + (Number(b[k]) || 0), 0);
    const qty = sum("qtyLitres");
    const earnings = sum("totalEarnings");
    return {
      qty, gross: sum("gross"), other: sum("otherEarnings"), earnings,
      deductions: sum("totalDeductions"), payable: sum("payable"), carry: sum("carryForward"),
      cpl: qty > 0 ? (run?.costBasis === "gross" ? sum("gross") : earnings) / qty : 0,
      zeroDays: all.filter(b => b.days === 0).length,
      noContractor: all.filter(b => !b.contractorId).length,
    };
  }, [data, run]);

  if (notFound) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title={`DTC Bills: ${monthLong(month)}`} />
        <EmptyState title="Bills for this month are not prepared yet" />
        {perms.prepare && (
          <div className="text-center">
            <Button size="sm" className="h-8" disabled={create.isPending} onClick={() => create.mutate()}>
              <CalendarPlus className="h-3.5 w-3.5 mr-1.5" /> {create.isPending ? "Preparing…" : "Prepare now"}
            </Button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={`DTC Bills: ${monthLong(month)}`}
        subtitle={run ? `${run.billCount} routes · ${run.contractorCount} contractors · generated ${run.generatedByName ? `by ${run.generatedByName}` : ""}` : "Loading…"}
        actions={run && (
          <>
            <Button size="sm" variant="ghost" className="h-8" onClick={() => navigate("/dtc/bills")}><ArrowLeft className="h-3.5 w-3.5 mr-1" /> Months</Button>
            <Button size="sm" variant="outline" className="h-8" asChild>
              <Link to={`/dtc/reports/consolidated?month=${month}`}><Printer className="h-3.5 w-3.5 mr-1.5" /> Consolidated bill</Link>
            </Button>
            {editable && (
              <>
                <Button size="sm" variant="outline" className="h-8" disabled={regen.isPending} onClick={() => regen.mutate()}
                  title="Refresh days, litres, rates and automatic deductions. Your entries and day corrections are kept.">
                  <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${regen.isPending ? "animate-spin" : ""}`} /> Regenerate
                </Button>
                <Button size="sm" variant="ghost" className="h-8 text-destructive" disabled={discard.isPending}
                  onClick={() => { if (confirm(`Discard the draft ${monthLong(month)} bills and everything entered on them?`)) discard.mutate(); }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <RunActionButtons run={run} />
          </>
        )}
      />

      <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-3">
        {isLoading || !run || !data ? (
          <div className="space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
        ) : (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <RunStatusBadge status={run.status} className="text-[12px] px-2 py-1" />
              <RunTimeline run={run} className="flex-1" />
            </div>

            {run.status === "draft" && run.returnedComment && (
              <div className="erp-panel p-3 border-l-4 border-l-warning text-[12.5px] flex gap-2">
                <AlertTriangle className="h-4 w-4 text-warning shrink-0 mt-0.5" />
                <div><b>Sent back:</b> {run.returnedComment}</div>
              </div>
            )}
            {run.status === "draft" && (totals.zeroDays > 0 || totals.noContractor > 0) && (
              <div className="erp-panel p-3 border-l-4 border-l-warning text-[12.5px] space-y-0.5">
                {totals.zeroDays > 0 && <div>{totals.zeroDays} route{totals.zeroDays === 1 ? " has" : "s have"} 0 days: no sale or dispatch found on the route this month. Check them before submitting.</div>}
                {totals.noContractor > 0 && <div>{totals.noContractor} route{totals.noContractor === 1 ? " has" : "s have"} no contractor assigned (Masters → Contractors).</div>}
              </div>
            )}

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <StatCard label="Gross payable" value={fmtINR(totals.gross, false)} />
              <StatCard label="Other earnings" value={fmtINR(totals.other, false)} />
              <StatCard label="Total earnings" value={fmtINR(totals.earnings, false)} tone="info" />
              <StatCard label="Deductions" value={fmtINR(totals.deductions, false)} tone="warning" />
              <StatCard label="Net payable" value={fmtINR(totals.payable, false)} tone="success"
                hint={totals.carry > 0 ? `₹${rs(totals.carry)} to recover next month` : undefined} />
              <StatCard label="Cost per litre" value={`₹${rs2(totals.cpl)}`} hint={`${qtyFmt(totals.qty)} L/kg carried`} />
            </div>

            <div className="flex items-center gap-2">
              <div className="relative w-72 max-w-full">
                <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Route, contractor, vehicle" className="erp-input pl-7 w-full" />
              </div>
              {editable && <span className="text-[11.5px] text-muted-foreground">Correct days in the Days column; click a row to add earnings and deductions.</span>}
            </div>

            <div className="erp-panel overflow-auto">
              {bills.length === 0 ? (
                <EmptyState title="No route bills" hint={run.billCount === 0 ? "No route has billing terms for this month. Set them up in Route Billing Setup, then regenerate." : "Nothing matches the search"} />
              ) : (
                <table className="erp-table text-[12px]">
                  <thead>
                    <tr>
                      <th className="text-right">Sl</th><th>Route</th><th>Contractor</th><th>Type</th>
                      <th className="text-right">Cap (MT)</th><th className="text-right">Days</th>
                      <th className="text-right">Km/Day</th><th className="text-right">Rate</th>
                      <th className="text-right">Qty L/Kg</th><th className="text-right">Gross</th>
                      <th className="text-right">Other earn.</th><th className="text-right">Total earn.</th>
                      <th className="text-right">Deductions</th><th className="text-right">Net payable</th>
                      <th className="text-right">Cost/Ltr</th><th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bills.map((b, i) => (
                      <tr key={b.id} className="cursor-pointer" onClick={() => navigate(`/dtc/bills/${month}/${b.id}`)}>
                        <td className="text-right num">{i + 1}</td>
                        <td className="whitespace-nowrap"><span className="font-mono text-[10.5px] text-muted-foreground mr-1">{b.routeCode}</span>{b.routeName}</td>
                        <td>{b.contractorName ?? <span className="text-warning">none</span>}</td>
                        <td>{BILLING_TYPE_LABEL[b.billingType]}{b.segments.length > 1 && <span className="text-[10px] text-info ml-1" title="Rate changed during the month">split</span>}</td>
                        <td className="text-right num">{b.vehicleCapacityMt != null ? rs2(b.vehicleCapacityMt) : ""}</td>
                        <td className="text-right" onClick={e => editable && b.segments.length === 1 && e.stopPropagation()}>
                          <DaysCell bill={b} editable={!!editable} onSaved={refresh} />
                        </td>
                        <td className="text-right num">{b.billingType === "km" ? rs2(b.kmPerDay) : ""}</td>
                        <td className="text-right num">{rs2(b.rate)}</td>
                        <td className="text-right num">{qtyFmt(b.qtyLitres)}</td>
                        <td className="text-right num">{rs(b.gross)}</td>
                        <td className="text-right num">{b.otherEarnings ? rs2(b.otherEarnings) : ""}</td>
                        <td className="text-right num">{rs(b.totalEarnings)}</td>
                        <td className="text-right num">{b.totalDeductions ? rs(b.totalDeductions) : ""}</td>
                        <td className={`text-right num font-medium ${b.net < 0 ? "text-destructive" : ""}`}>{rs(b.net)}</td>
                        <td className="text-right num">{rs2(b.costPerLitre)}</td>
                        <td className="whitespace-nowrap text-[11px]">
                          {b.paidOn ? <span className="text-success">Paid {b.paidOn.slice(8, 10)}/{b.paidOn.slice(5, 7)}</span>
                            : b.onHold ? <span className="text-warning" title={b.holdReason ?? ""}>On hold</span>
                            : b.carryForward > 0 ? <span className="text-destructive" title="Recovered from the next month's bill">₹{rs(b.carryForward)} to recover</span>
                            : ""}
                        </td>
                      </tr>
                    ))}
                    <tr className="font-semibold bg-muted/40">
                      <td /><td colSpan={7}>TOTAL</td>
                      <td className="text-right num">{qtyFmt(totals.qty)}</td>
                      <td className="text-right num">{rs(totals.gross)}</td>
                      <td className="text-right num">{rs2(totals.other)}</td>
                      <td className="text-right num">{rs(totals.earnings)}</td>
                      <td className="text-right num">{rs(totals.deductions)}</td>
                      <td className="text-right num">{rs(totals.payable - totals.carry)}</td>
                      <td className="text-right num">{rs2(totals.cpl)}</td>
                      <td />
                    </tr>
                  </tbody>
                </table>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

/** Days, editable inline on a single-segment draft bill. */
function DaysCell({ bill, editable, onSaved }: { bill: Bill; editable: boolean; onSaved: () => void }) {
  const seg = bill.segments[0];
  const overridden = bill.segments.some(s => s.daysOverride != null);
  const [val, setVal] = useState<string | null>(null);
  const mut = useMutation({
    mutationFn: (days: number | null) => updateBill(bill.id, { segments: [{ key: seg!.key, daysOverride: days }] }),
    onSuccess: () => { setVal(null); onSaved(); },
    onError: (e) => { toast.error(errMsg(e)); setVal(null); },
  });
  const title = bill.segments.map(s => `${s.from.slice(8)}–${s.to.slice(8)}: ${s.autoDays} days found${s.daysOverride != null ? `, set to ${s.daysOverride}` : ""}`).join("\n");
  if (!editable || bill.segments.length !== 1 || !seg) {
    return <span className="num" title={title}>{bill.days}{overridden && <span className="text-info">*</span>}</span>;
  }
  const commit = () => {
    if (val == null) return;
    const n = val.trim() === "" ? null : Math.max(0, Math.round(Number(val)));
    if (n === (seg.daysOverride ?? seg.autoDays)) { setVal(null); return; }
    mut.mutate(n);
  };
  return (
    <input
      type="number" min={0} max={31}
      value={val ?? String(seg.daysOverride ?? seg.autoDays)}
      title={`${title}\nClear the box to go back to the days found.`}
      onChange={e => setVal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setVal(null); }}
      disabled={mut.isPending}
      className={`w-14 h-6 text-right num rounded border px-1 bg-background ${seg.daysOverride != null ? "border-info text-info" : "border-input"}`}
    />
  );
}
