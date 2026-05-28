// apps/web/src/pages/finance/DayBookPage.tsx
// Finance → Day Book  (/finance/day-book, finance.view)
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader, { StatCard, EmptyState, fmtINR, fmtDate, PrintButton } from "@/components/PageHeader";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchDayBook } from "@/services/api";

const todayStr = () => new Date().toISOString().slice(0, 10);

export default function DayBookPage() {
  const [date, setDate] = useState(todayStr());
  const [physicalCount, setPhysicalCount] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["day-book", date],
    queryFn: () => fetchDayBook(date),
  });

  const cashCollected = data?.summary.cashCollected ?? 0;
  const variance = useMemo(() => {
    if (physicalCount === "") return null;
    return Number(physicalCount) - cashCollected;
  }, [physicalCount, cashCollected]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Day Book" subtitle="Daily cash book — close the day & tally physical cash"
        actions={<PrintButton label="Print Day Book" />} />

      <div className="flex items-end gap-2 px-4 py-2.5 bg-panel border-b border-border no-print">
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Date</label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="erp-input w-40" />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {isLoading ? (
          <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : data ? (<>
          {/* Summary strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <StatCard label="Total Receipts" value={fmtINR(data.summary.totalReceipts)} />
            <StatCard label="Cash" tone="success" value={fmtINR(data.summary.byMode["cash"] ?? 0)} />
            <StatCard label="UPI" value={fmtINR(data.summary.byMode["upi"] ?? 0)} />
            <StatCard label="Cheque" value={fmtINR(data.summary.byMode["cheque"] ?? 0)} />
            <StatCard label="Refunds Out" tone="warning" value={fmtINR(data.summary.refundsOut)} />
            <StatCard label="Net" tone="info" value={fmtINR(data.summary.net)} />
          </div>

          {/* Cash card */}
          <div className="erp-panel p-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Cash position (informational — deposit tracking not persisted in v1)</div>
            <div className="flex items-end gap-6 flex-wrap">
              <div>
                <div className="text-[11px] text-muted-foreground">Cash collected today</div>
                <div className="text-[18px] font-semibold num">{fmtINR(cashCollected)}</div>
              </div>
              <div className="no-print">
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Physical count</label>
                <Input type="number" min="0" step="0.01" value={physicalCount} onChange={e => setPhysicalCount(e.target.value)} placeholder="Enter counted cash" className="erp-input num w-40" />
              </div>
              {variance !== null && (
                <div>
                  <div className="text-[11px] text-muted-foreground">Variance</div>
                  <div className={`text-[18px] font-semibold num ${Math.abs(variance) < 0.01 ? "text-success" : "text-destructive"}`}>{fmtINR(variance)}</div>
                </div>
              )}
            </div>
          </div>

          {/* Route-wise cash */}
          <div className="erp-panel overflow-hidden">
            <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">Route-wise cash collection</div>
            {data.routeWise.length === 0 ? <div className="p-3 text-[12px] text-muted-foreground">No cash receipts today.</div> : (
              <table className="erp-table">
                <thead><tr><th>Route</th><th className="num" style={{ textAlign: "right" }}>Receipts</th><th className="num" style={{ textAlign: "right" }}>Collected</th></tr></thead>
                <tbody>
                  {data.routeWise.map((r, i) => (
                    <tr key={i}><td>{r.name ?? "— Unassigned —"}</td><td className="num" style={{ textAlign: "right" }}>{r.receipts}</td><td className="num" style={{ textAlign: "right" }}>{fmtINR(r.collected)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Day-book lines */}
          <div className="erp-panel overflow-hidden">
            <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">Transactions — {fmtDate(date)}</div>
            {data.lines.length === 0 ? <EmptyState title="No transactions on this day" /> : (
              <table className="erp-table">
                <thead>
                  <tr><th>Mode</th><th>Dealer</th><th>Route</th><th>Reference</th><th>Invoice</th><th>By</th><th className="num" style={{ textAlign: "right" }}>Amount</th></tr>
                </thead>
                <tbody>
                  {data.lines.map((l) => (
                    <tr key={l.id}>
                      <td className="capitalize">{l.mode}</td>
                      <td className="font-medium">{l.dealerName} <span className="text-muted-foreground font-mono text-[11px]">{l.dealerCode}</span></td>
                      <td className="text-[12px]">{l.routeName ?? "—"}</td>
                      <td className="text-[12px] font-mono">{l.reference ?? "—"}</td>
                      <td className="text-[12px] font-mono">{l.invoiceNumber ?? "—"}</td>
                      <td className="text-[12px]">{l.receivedByName ?? "—"}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(l.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>) : null}
      </div>
    </div>
  );
}
