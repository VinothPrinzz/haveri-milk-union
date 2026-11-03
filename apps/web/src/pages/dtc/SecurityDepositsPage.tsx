// apps/web/src/pages/dtc/SecurityDepositsPage.tsx
// DTC Billing → Security Deposits  (/dtc/setup/deposits)
// Every contractor's deposit plan with what has been collected. A row opens
// the contractor's deposit page (/dtc/setup/deposits/:contractorId).
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader, { EmptyState, fmtINR } from "@/components/PageHeader";
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
      <div className="dtc-plain flex-1 overflow-auto p-4 sm:p-6 space-y-4">
        <p className="text-[14px]"><b>{fmtINR(held, false)}</b> held as deposit{due > 0 && <>, <b>{fmtINR(due, false)}</b> still to collect</>}.</p>
        <div className="erp-panel overflow-auto">
          {isLoading ? <div className="p-4 text-muted-foreground">Loading…</div> : rows.length === 0 ? (
            <EmptyState title="No deposit plans yet" hint="Start one with New plan." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Contractor</th><th style={{ width: 260 }}>Collected</th><th className="text-right">Target</th><th>Status</th><th />
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="cursor-pointer" onClick={() => navigate(`/dtc/setup/deposits/${r.contractorId}`)}>
                    <td>{r.contractorName}{r.contractorCode && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{r.contractorCode}</span>}</td>
                    <td>
                      <div className="flex items-center gap-2">
                        <div className="flex-1"><Progress value={r.collected} max={r.targetAmount} tone={r.balanceDue === 0 ? "success" : "primary"} /></div>
                        <span className="num text-[12px] w-20 text-right">{rs2(r.collected)}</span>
                      </div>
                    </td>
                    <td className="text-right num">{rs2(r.targetAmount)}</td>
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
