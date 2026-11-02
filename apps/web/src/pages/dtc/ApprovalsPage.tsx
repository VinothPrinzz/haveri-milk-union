// apps/web/src/pages/dtc/ApprovalsPage.tsx
// DTC Billing → Approvals  (/dtc/approvals)
// Months waiting at a step of the approval chain, with the buttons for the
// signed-in user's step. "Your turn" lists what this user can act on now.
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader, { EmptyState } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FileStack, Table2 } from "lucide-react";
import { fetchRuns, type RunSummary } from "@/services/dtc";
import { RunActionButtons, RunTimeline, useRunActions } from "./RunActions";
import { RunStatusBadge, monthLong, rs } from "./shared";

export default function ApprovalsPage() {
  const { data: runs = [], isLoading } = useQuery({ queryKey: ["dtc-runs"], queryFn: fetchRuns });
  const waiting = runs.filter(r => r.status !== "approved");
  const recent = runs.filter(r => r.status === "approved").slice(0, 3);

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Approvals" subtitle="Prepared → Pre-audited → Marketing approved → Finance approved (locked)" />
      <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-3">
        {isLoading ? (
          <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}</div>
        ) : waiting.length === 0 ? (
          <EmptyState title="Nothing waiting for approval" hint="Prepared months appear here once Marketing submits them." />
        ) : (
          waiting.map(r => <RunCard key={r.id} run={r} />)
        )}
        {recent.length > 0 && (
          <>
            <div className="erp-section-title pt-2">Recently approved</div>
            {recent.map(r => <RunCard key={r.id} run={r} />)}
          </>
        )}
      </div>
    </div>
  );
}

function RunCard({ run }: { run: RunSummary }) {
  const mine = useRunActions(run).some(a => a.action !== "send_back" && a.action !== "reopen");
  return (
    <div className={`erp-panel p-3 space-y-2 ${mine ? "border-l-4 border-l-primary" : ""}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[14px] font-semibold">{monthLong(run.month)}</span>
        <RunStatusBadge status={run.status} />
        {mine && <span className="text-[11px] rounded bg-primary/10 text-primary px-1.5 py-0.5 font-medium">Your turn</span>}
        <span className="text-[12px] text-muted-foreground">
          {run.billCount} routes · earnings ₹{rs(run.totalEarnings)} · deductions ₹{rs(run.totalDeductions)} · net payable <b className="text-foreground">₹{rs(run.payable)}</b>
        </span>
        <div className="flex-1" />
        <Button size="sm" variant="outline" className="h-7 text-[12px]" asChild>
          <Link to={`/dtc/bills/${run.month}`}><Table2 className="h-3.5 w-3.5 mr-1" /> Bills</Link>
        </Button>
        <Button size="sm" variant="outline" className="h-7 text-[12px]" asChild>
          <Link to={`/dtc/reports/consolidated?month=${run.month}`}><FileStack className="h-3.5 w-3.5 mr-1" /> Consolidated bill</Link>
        </Button>
        <RunActionButtons run={run} size="xs" />
      </div>
      <RunTimeline run={run} />
      {run.status === "draft" && run.returnedComment && (
        <div className="text-[12px] text-warning">Sent back: {run.returnedComment}</div>
      )}
    </div>
  );
}
