// apps/web/src/pages/dtc/BillRunsPage.tsx
// DTC Billing → Monthly Bills  (/dtc/bills)
// Every month's bills with their approval status and totals, and the
// "Prepare bills" action that generates a month from the route terms,
// dispatch days and sales on each route.
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState, FilterBar } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { CalendarPlus, ChevronRight } from "lucide-react";
import { todayIST } from "@/lib/istDate";
import { createRun, fetchRuns } from "@/services/dtc";
import { FilterLabel, MonthInput, RunStatusBadge, errMsg, monthLabel, prevMonth, rs, useDtcPerms } from "./shared";

export default function BillRunsPage() {
  const perms = useDtcPerms();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const thisMonth = todayIST().slice(0, 7);
  const [month, setMonth] = useState(prevMonth(todayIST()));
  const { data: runs = [], isLoading } = useQuery({ queryKey: ["dtc-runs"], queryFn: fetchRuns });
  const existing = runs.find(r => r.month === month);

  const create = useMutation({
    mutationFn: () => createRun(month),
    onSuccess: (r) => {
      toast.success(r.message);
      qc.invalidateQueries({ queryKey: ["dtc-runs"] });
      navigate(`/dtc/bills/${r.month}`);
    },
    onError: (e) => toast.error(errMsg(e)),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Monthly DTC Bills" subtitle="Transport contractor bills, one month at a time: prepare, check, approve, pay" />
      <FilterBar>
        <div>
          <FilterLabel>Bill month</FilterLabel>
          <MonthInput value={month} onChange={setMonth} max={thisMonth} className="w-40" />
        </div>
        {existing ? (
          <Button size="sm" className="h-8 self-end" onClick={() => navigate(`/dtc/bills/${month}`)}>
            Open {monthLabel(month)} <ChevronRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        ) : perms.prepare ? (
          <Button size="sm" className="h-8 self-end" disabled={create.isPending} onClick={() => create.mutate()}>
            <CalendarPlus className="h-3.5 w-3.5 mr-1.5" /> {create.isPending ? "Preparing…" : `Prepare ${monthLabel(month)} bills`}
          </Button>
        ) : (
          <span className="self-end pb-1.5 text-[12px] text-muted-foreground">Not prepared yet. Marketing prepares the bills.</span>
        )}
        {month === thisMonth && !existing && perms.prepare && (
          <span className="self-end pb-1.5 text-[12px] text-warning">The month is not over: days and litres will grow until it ends. Regenerate before submitting.</span>
        )}
      </FilterBar>

      <div className="flex-1 overflow-auto p-3 sm:p-4">
        <div className="erp-panel overflow-auto">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : runs.length === 0 ? (
            <EmptyState title="No bills prepared yet" hint="Set up the routes in Route Billing Setup, then prepare a month above." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Month</th><th>Status</th><th className="text-right">Routes</th><th className="text-right">Contractors</th>
                  <th className="text-right">Gross</th><th className="text-right">Total earnings</th>
                  <th className="text-right">Deductions</th><th className="text-right">Net payable</th>
                  <th className="text-right">Paid</th><th>Prepared by</th><th />
                </tr>
              </thead>
              <tbody>
                {runs.map(r => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => navigate(`/dtc/bills/${r.month}`)}>
                    <td className="font-medium">{monthLabel(r.month)}</td>
                    <td><RunStatusBadge status={r.status} /></td>
                    <td className="text-right num">{r.billCount}</td>
                    <td className="text-right num">{r.contractorCount}</td>
                    <td className="text-right num">{rs(r.gross)}</td>
                    <td className="text-right num">{rs(r.totalEarnings)}</td>
                    <td className="text-right num">{rs(r.totalDeductions)}</td>
                    <td className="text-right num font-medium">{rs(r.payable)}</td>
                    <td className="text-right num">
                      {r.status === "approved" ? `${r.paidCount} / ${r.billCount}` : ""}
                      {r.onHoldCount > 0 && <span className="ml-1 text-[10.5px] text-warning">{r.onHoldCount} held</span>}
                    </td>
                    <td className="text-[12px]">{r.generatedByName ?? ""}</td>
                    <td><ChevronRight className="h-4 w-4 text-muted-foreground" /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
