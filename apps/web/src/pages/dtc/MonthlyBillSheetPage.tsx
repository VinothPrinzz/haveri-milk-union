// apps/web/src/pages/dtc/MonthlyBillSheetPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → one month's bills  (/dtc/bills/:month, /approvals)
//
//   (index)    Route bills  one row per route: days (correctable in a draft),
//                           gross, deductions, net payable. Open a row for the
//                           route's bill. The full 23-column sheet is the
//                           Consolidated DTC Bill report.
//   approvals  Approvals    who signed each step, and what happened when
// The status bar and the button for the signed-in user's step sit in the header.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarPlus, ChevronRight, Printer, RefreshCw, Search, Trash2 } from "lucide-react";
import { ApiError } from "@/lib/apiClient";
import { createRun, deleteRun, fetchRun, regenerateRun, updateBill, type Bill, type RunDetail } from "@/services/dtc";
import { RunActionArea, RunPipeline, RunTimeline } from "./RunActions";
import { RecordBody, RecordHeader, Section, Timeline } from "./ui";
import { RunStatusBadge, errMsg, fmtStamp, monthLong, rs, rs2, useDtcPerms } from "./shared";

export default function MonthlyBillSheetPage() {
  const { month = "" } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const showApprovals = pathname.endsWith("/approvals");
  const qc = useQueryClient();
  const perms = useDtcPerms();

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

  if (notFound) {
    return (
      <div className="flex flex-col h-full">
        <PageHeader title={`${monthLong(month)} bills`} />
        <EmptyState title="Not prepared yet" />
        {perms.prepare && (
          <div className="text-center">
            <Button size="sm" className="h-9" disabled={create.isPending} onClick={() => create.mutate()}>
              <CalendarPlus className="h-3.5 w-3.5 mr-1.5" /> {create.isPending ? "Preparing…" : "Prepare now"}
            </Button>
          </div>
        )}
      </div>
    );
  }
  if (isLoading || !run || !data) {
    return <div className="p-6 space-y-3">{Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}</div>;
  }

  const sum = (k: keyof Bill) => data.bills.reduce((s, b) => s + (Number(b[k]) || 0), 0);
  const qty = sum("qtyLitres");
  const earnings = sum("totalEarnings");
  const cpl = qty > 0 ? (run.costBasis === "gross" ? sum("gross") : earnings) / qty : 0;
  const base = `/dtc/bills/${month}`;

  return (
    <div className="h-full overflow-auto">
      <RecordHeader
        back={{ to: "/dtc/bills", label: "All months" }}
        title={`${monthLong(month)} bills`}
        status={<RunStatusBadge status={run.status} />}
        subtitle={`${run.billCount} routes · ${run.contractorCount} contractors`}
        actions={
          <>
            {editable && (
              <>
                <Button size="sm" variant="ghost" className="h-8" disabled={regen.isPending} onClick={() => regen.mutate()}
                  title="Count days and litres again and refresh automatic deductions. What you typed is kept.">
                  <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${regen.isPending ? "animate-spin" : ""}`} /> Refresh
                </Button>
                <Button size="sm" variant="ghost" className="h-8 w-8 p-0 text-destructive" disabled={discard.isPending} title="Discard this draft"
                  onClick={() => { if (confirm(`Discard the draft ${monthLong(month)} bills and everything entered on them?`)) discard.mutate(); }}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </>
            )}
            <Button size="sm" variant="outline" className="h-8" asChild>
              <Link to={`/dtc/reports/consolidated?month=${month}`}><Printer className="h-3.5 w-3.5 mr-1.5" /> Print</Link>
            </Button>
          </>
        }
        facts={[
          { label: "Total earnings", value: `₹${rs(earnings)}` },
          { label: "Deductions", value: `₹${rs(sum("totalDeductions"))}` },
          { label: "Net payable", value: `₹${rs(sum("payable"))}`, tone: "success", hint: run.status === "approved" ? `${run.paidCount} of ${run.billCount} paid` : undefined },
          { label: "Cost per litre", value: `₹${rs2(cpl)}` },
        ]}
        tabs={[
          { to: base, label: "Route bills", end: true, count: run.billCount },
          { to: `${base}/approvals`, label: "Approvals" },
        ]}
      >
        <div className="mt-4 flex flex-wrap items-start gap-3">
          <RunPipeline run={run} />
          <div className="flex-1 min-w-[260px]"><RunActionArea run={run} /></div>
        </div>
      </RecordHeader>

      <RecordBody wide>
        {showApprovals ? <Approvals data={data} /> : <RouteBills data={data} editable={!!editable} onSaved={refresh} />}
      </RecordBody>
    </div>
  );
}

function RouteBills({ data, editable, onSaved }: { data: RunDetail; editable: boolean; onSaved: () => void }) {
  const navigate = useNavigate();
  const { run } = data;
  const [search, setSearch] = useState("");
  const bills = useMemo(() => {
    const q = search.trim().toLowerCase();
    return data.bills.filter(b => !q || `${b.routeCode} ${b.routeName} ${b.contractorName ?? ""}`.toLowerCase().includes(q));
  }, [data, search]);
  const zeroDays = data.bills.filter(b => b.days === 0).length;
  const noContractor = data.bills.filter(b => !b.contractorId).length;
  const notes = [
    run.status === "draft" && run.returnedComment ? `Sent back: ${run.returnedComment}` : null,
    run.status === "draft" && zeroDays ? `${zeroDays} route${zeroDays === 1 ? " shows" : "s show"} 0 days. Check before submitting.` : null,
    run.status === "draft" && noContractor ? `${noContractor} route${noContractor === 1 ? " has" : "s have"} no contractor.` : null,
  ].filter(Boolean);

  return (
    <>
      {notes.length > 0 && (
        <div className="rounded-md bg-warning/10 px-4 py-3 text-[13px] space-y-0.5">{notes.map(n => <div key={n!}>{n}</div>)}</div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-72 max-w-full">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
          <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Find a route or contractor" className="erp-input pl-8 w-full" />
        </div>
        {editable && <span className="text-[12.5px] text-muted-foreground">Change days here. Open a route to add earnings or deductions.</span>}
      </div>
      <div className="erp-panel overflow-auto">
        {bills.length === 0 ? (
          <EmptyState title={data.bills.length === 0 ? "No routes are set up for billing" : "Nothing matches"} hint={data.bills.length === 0 ? "Set them up in Route Billing Setup, then refresh." : undefined} />
        ) : (
          <table className="erp-table text-[13px]">
            <thead>
              <tr>
                <th>Route</th><th>Contractor</th><th className="text-right">Days</th>
                <th className="text-right">Gross</th><th className="text-right">Deductions</th><th className="text-right">Net payable</th><th /><th />
              </tr>
            </thead>
            <tbody>
              {bills.map(b => (
                <tr key={b.id} className="cursor-pointer" onClick={() => navigate(`/dtc/bills/${run.month}/${b.id}`)}>
                  <td className="whitespace-nowrap"><span className="text-muted-foreground mr-1.5 text-[12px]">{b.routeCode}</span>{b.routeName}</td>
                  <td>{b.contractorName ?? <span className="text-warning">none</span>}</td>
                  <td className="text-right" onClick={e => editable && b.segments.length === 1 && e.stopPropagation()}>
                    <DaysCell bill={b} editable={editable} onSaved={onSaved} />
                  </td>
                  <td className="text-right num">₹{rs(b.gross)}</td>
                  <td className="text-right num">{b.totalDeductions ? `₹${rs(b.totalDeductions)}` : ""}</td>
                  <td className={`text-right num font-medium ${b.net < 0 ? "text-destructive" : ""}`}>₹{rs(b.net)}</td>
                  <td className="whitespace-nowrap text-[12px]">
                    {b.paidOn ? <span className="text-success">Paid</span>
                      : b.onHold ? <span className="text-warning">On hold</span>
                      : b.net < 0 ? <span className="text-destructive">Recover next month</span> : ""}
                  </td>
                  <td><ChevronRight className="h-4 w-4 text-muted-foreground" /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}

function Approvals({ data }: { data: RunDetail }) {
  return (
    <>
      <Section title="Signatures">
        <RunTimeline run={data.run} />
      </Section>
      <Section title="What happened">
        <Timeline items={data.events.map(e => ({
          id: e.id, who: e.userName, when: fmtStamp(e.createdAt), text: e.detail ?? e.action,
          tone: e.action === "send_back" || e.action === "reopen" ? "warning" : e.action === "approve" ? "success" : "default",
        }))} />
      </Section>
    </>
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
      className={`w-16 h-8 text-right num rounded border px-2 bg-background ${seg.daysOverride != null ? "border-info text-info" : "border-input"}`}
    />
  );
}
