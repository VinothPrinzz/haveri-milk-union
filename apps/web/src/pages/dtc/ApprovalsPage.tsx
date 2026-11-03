// apps/web/src/pages/dtc/ApprovalsPage.tsx
// DTC Billing → Approvals  (/dtc/approvals)
// Months waiting at a step of the approval chain, with the buttons for the
// signed-in user's step. "Your turn" lists what this user can act on now.
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader, { EmptyState } from "@/components/PageHeader";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchRuns, type RunSummary } from "@/services/dtc";
import { RunActionArea, RunPipeline, useRunActions } from "./RunActions";
import { monthLong, rs } from "./shared";

export default function ApprovalsPage() {
  const { data: runs = [], isLoading } = useQuery({ queryKey: ["dtc-runs"], queryFn: fetchRuns });
  const waiting = runs.filter(r => r.status !== "approved");
  const recent = runs.filter(r => r.status === "approved").slice(0, 3);

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Approvals" subtitle="Prepared → Pre-audited → Marketing approved → Finance approved (locked)" />
      <div className="dtc-plain flex-1 overflow-auto p-4 sm:p-6 space-y-4">
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
    <div className={`erp-panel px-5 py-4 space-y-3 ${mine ? "ring-1 ring-primary" : ""}`}>
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <Link to={`/dtc/bills/${run.month}`} className="text-[16px] font-semibold hover:underline">{monthLong(run.month)}</Link>
        {mine && <span className="text-[12px] text-primary font-medium">Your turn</span>}
        <span className="text-[13px] text-muted-foreground">{run.billCount} routes · ₹{rs(run.payable)} to pay</span>
        <div className="flex-1" />
        <Link to={`/dtc/bills/${run.month}`} className="text-[13px] text-primary hover:underline">Open bills →</Link>
      </div>
      <div className="flex flex-wrap items-start gap-3">
        <RunPipeline run={run} />
        <div className="flex-1 min-w-[260px]"><RunActionArea run={run} compact /></div>
      </div>
      {run.status === "draft" && run.returnedComment && <div className="text-[12.5px] text-warning">Sent back: {run.returnedComment}</div>}
    </div>
  );
}
