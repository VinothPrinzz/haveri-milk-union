// apps/web/src/pages/finance/FinanceDashboardPage.tsx
// Finance → Dashboard  (/finance/dashboard, finance.view)
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import PageHeader, { StatCard, fmtINR, fmtDate } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Skeleton } from "@/components/ui/skeleton";
import { AlertCircle, ChevronRight } from "lucide-react";
import { fetchFinanceDashboard } from "@/services/api";

const PERIOD_OPTIONS: F9Option[] = [
  { value: "today", label: "Today" },
  { value: "mtd", label: "Month to date" },
  { value: "last30", label: "Last 30 days" },
];
const SEV_DOT: Record<string, string> = {
  critical: "bg-destructive", high: "bg-warning", medium: "bg-muted-foreground",
};

export default function FinanceDashboardPage() {
  const nav = useNavigate();
  const [period, setPeriod] = useState<string>("mtd");
  const { data, isLoading } = useQuery({
    queryKey: ["finance-dashboard", period],
    queryFn: () => fetchFinanceDashboard({ period }),
  });

  const r = data?.receivables;
  const total = r?.totalOutstanding ?? 0;
  const seg = (v?: number) => (total > 0 ? `${Math.round(((v ?? 0) / total) * 100)}%` : "0%");

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Finance Dashboard" subtitle="What needs your attention today"
        actions={<div className="w-44"><F9SearchSelect value={period} onChange={(v) => setPeriod(v ?? "mtd")} options={PERIOD_OPTIONS} placeholder="Period" /></div>} />

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {isLoading ? (
          <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
        ) : data ? (<>
          {/* Hero tiles */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <StatCard label="Total Outstanding" value={fmtINR(data.receivables.totalOutstanding)} />
            <StatCard label="Overdue" tone="warning" value={fmtINR(data.receivables.totalOverdue)} />
            <StatCard label="Collected Today" tone="success" value={fmtINR(data.collections.today)} />
            <StatCard label="Collected (period)" tone="info" value={fmtINR(data.collections.thisMonth)} />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Receivables health */}
            <div className="lg:col-span-2 erp-panel p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Receivables Health</div>
              <div className="flex h-5 w-full overflow-hidden rounded">
                <div className="bg-success" style={{ width: seg(data.receivables.aging.current) }} title="Current" />
                <div className="bg-warning/60" style={{ width: seg(data.receivables.aging.b1_30) }} title="1–30" />
                <div className="bg-warning" style={{ width: seg(data.receivables.aging.b31_60) }} title="31–60" />
                <div className="bg-orange-500" style={{ width: seg(data.receivables.aging.b61_90) }} title="61–90" />
                <div className="bg-destructive" style={{ width: seg(data.receivables.aging.b90Plus) }} title="90+" />
              </div>
              <div className="flex gap-4 mt-2 text-[11px] text-muted-foreground flex-wrap">
                <span>Current {fmtINR(data.receivables.aging.current)}</span>
                <span>1–30 {fmtINR(data.receivables.aging.b1_30)}</span>
                <span>31–60 {fmtINR(data.receivables.aging.b31_60)}</span>
                <span>61–90 {fmtINR(data.receivables.aging.b61_90)}</span>
                <span className="text-destructive">90+ {fmtINR(data.receivables.aging.b90Plus)}</span>
              </div>
              <div className="text-[12px] text-muted-foreground mt-3">{data.receivables.dealersWithDues} dealers with dues · Overdue {fmtINR(data.receivables.totalOverdue)}</div>
            </div>

            {/* Collection mix */}
            <div className="erp-panel p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Collection mix (period)</div>
              <div className="space-y-1.5">
                {Object.entries(data.collections.byMode).filter(([, v]) => v > 0).map(([mode, v]) => (
                  <div key={mode} className="flex justify-between text-[12px]">
                    <span className="capitalize">{mode}</span><span className="num">{fmtINR(v)}</span>
                  </div>
                ))}
                {Object.values(data.collections.byMode).every(v => v === 0) && <div className="text-[12px] text-muted-foreground">No collections in period</div>}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
            {/* Attention */}
            <div className="lg:col-span-2 erp-panel p-4">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2 flex items-center gap-1.5"><AlertCircle className="h-3.5 w-3.5" /> Attention</div>
              {data.attention.length === 0 ? (
                <div className="text-[13px] text-success py-4">All clear — nothing needs attention.</div>
              ) : (
                <div className="divide-y divide-border/60">
                  {data.attention.map((a, i) => (
                    <button key={i} onClick={() => nav(a.link)} className="w-full flex items-center justify-between py-2 hover:bg-muted/40 px-1 text-left">
                      <span className="flex items-center gap-2 text-[13px]">
                        <span className={`h-2 w-2 rounded-full ${SEV_DOT[a.severity] ?? "bg-muted-foreground"}`} />
                        {a.label}
                      </span>
                      <span className="flex items-center gap-1 text-[12px] text-muted-foreground"><b>{a.count}</b><ChevronRight className="h-3.5 w-3.5" /></span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Quick stats */}
            <div className="space-y-3">
              <StatCard label="Cheques in hand" tone="info" value={fmtINR(data.cheques.inHandAmount)} hint={`${data.cheques.inHandCount} cheques`} className="cursor-pointer" />
              <StatCard label="Online pending settlement" tone="warning" value={fmtINR(data.online.pendingSettlement)} hint={`${data.online.notPosted} not posted`} />
              <StatCard label="Dealers over limit" tone={data.creditControl.overLimitCount > 0 ? "danger" : "default"} value={data.creditControl.overLimitCount} hint={`Exposure ${fmtINR(data.creditControl.totalExposure)}`} />
            </div>
          </div>

          {/* Recent activity */}
          <div className="erp-panel overflow-hidden">
            <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">Recent activity</div>
            <table className="erp-table">
              <thead><tr><th>Date</th><th>Dealer</th><th>Voucher</th><th>Type</th><th className="num" style={{ textAlign: "right" }}>Amount</th></tr></thead>
              <tbody>
                {data.recent.map((x, i) => (
                  <tr key={i}>
                    <td>{fmtDate(x.date)}</td>
                    <td>{x.dealerName}</td>
                    <td className="text-[12px]">{x.voucherType ?? "—"} <span className="font-mono text-[10px] text-muted-foreground">{x.voucherNo ?? ""}</span></td>
                    <td className={x.type === "credit" ? "text-success" : "text-destructive"}>{x.type}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(x.amount)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>) : null}
      </div>
    </div>
  );
}
