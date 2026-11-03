// apps/web/src/pages/dtc/SecurityDepositsPage.tsx
// DTC Billing → Security Deposits  (/dtc/setup/deposits)
// Every contractor's deposit plan with what has been collected. A row opens
// the contractor's deposit page (/dtc/setup/deposits/:contractorId).
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader, { EmptyState, StatCard, fmtINR } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { ChevronRight, Plus } from "lucide-react";
import { fetchDeposits } from "@/services/dtc";
import { fmtDMY, rs2, useDtcPerms } from "./shared";
import { Progress } from "./ui";

export default function SecurityDepositsPage() {
  const perms = useDtcPerms();
  const navigate = useNavigate();
  const { data: rows = [], isLoading } = useQuery({ queryKey: ["dtc-deposits"], queryFn: fetchDeposits });
  const held = rows.reduce((s, r) => s + r.collected - r.refundedAmount, 0);
  const due = rows.filter(r => r.status !== "closed").reduce((s, r) => s + r.balanceDue, 0);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Security Deposits"
        subtitle="Deposit collected from contractors in monthly instalments, deducted from their bills"
        actions={perms.setup && (
          <Button size="sm" className="h-8" onClick={() => navigate("/dtc/setup/deposits/new")}><Plus className="h-3.5 w-3.5 mr-1.5" /> New plan</Button>
        )}
      />
      <div className="flex-1 overflow-auto p-3 sm:p-4 space-y-3">
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <StatCard label="Deposit held" value={fmtINR(held)} tone="info" hint="collected on approved bills, less refunds" />
          <StatCard label="Still to collect" value={fmtINR(due)} tone="warning" />
          <StatCard label="Plans" value={rows.length} hint={`${rows.filter(r => r.status === "active").length} active`} />
        </div>
        <div className="erp-panel overflow-auto">
          {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? (
            <EmptyState title="No deposit plans yet" hint="Start one with New plan." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Contractor</th><th className="text-right">Target</th><th className="text-right">Per month</th>
                  <th style={{ width: 200 }}>Collected</th><th className="text-right">Balance due</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => navigate(`/dtc/setup/deposits/${r.contractorId}`)}>
                    <td>{r.contractorName}{r.contractorCode && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{r.contractorCode}</span>}</td>
                    <td className="text-right num">{rs2(r.targetAmount)}</td>
                    <td className="text-right num">{rs2(r.monthlyInstalment)}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="flex-1"><Progress value={r.collected} max={r.targetAmount} tone={r.balanceDue === 0 ? "success" : "primary"} /></div>
                        <span className="num text-[12px] w-20 text-right">{rs2(r.collected)}</span>
                      </div>
                      {r.collectedPending > 0 && <div className="text-[10.5px] text-muted-foreground">+ ₹{rs2(r.collectedPending)} on bills not yet approved</div>}
                    </td>
                    <td className="text-right num">{rs2(r.balanceDue)}</td>
                    <td className="capitalize">{r.status}{r.refundedAmount > 0 && <span className="block text-[11px] text-muted-foreground normal-case">refunded {fmtDMY(r.refundedOn)}</span>}</td>
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
