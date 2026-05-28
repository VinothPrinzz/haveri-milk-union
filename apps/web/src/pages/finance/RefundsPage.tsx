// apps/web/src/pages/finance/RefundsPage.tsx
// Finance → Refunds  (/finance/refunds, finance.view)
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, StatCard, EmptyState, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, RotateCcw, AlertTriangle, XCircle, CheckCircle2 } from "lucide-react";
import {
  fetchRefunds, fetchRefundsSummary, resyncRefund, type RefundRow,
} from "@/services/api";

const STATUS_OPTIONS: F9Option[] = [
  { value: "pending", label: "Pending" },
  { value: "processed", label: "Processed" },
  { value: "failed", label: "Failed" },
];
function StatusBadge({ status }: { status: RefundRow["status"] }) {
  const map = {
    processed: "bg-success/15 text-success",
    pending: "bg-warning/15 text-warning",
    failed: "bg-destructive/15 text-destructive",
  } as const;
  return <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${map[status]}`}>{status}</span>;
}

export default function RefundsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [search, status, dateFrom, dateTo]);

  const filters = {
    search: search.trim() || undefined,
    status: (status as RefundRow["status"] | null) ?? undefined,
    dateFrom: dateFrom || undefined,
    dateTo: dateTo || undefined,
  };
  const { data, isLoading } = useQuery({
    queryKey: ["refunds", filters, page],
    queryFn: () => fetchRefunds({ ...filters, page, limit: 50 }),
  });
  const { data: summary } = useQuery({
    queryKey: ["refunds-summary", dateFrom, dateTo],
    queryFn: () => fetchRefundsSummary({ dateFrom: dateFrom || undefined, dateTo: dateTo || undefined }),
  });

  const resync = useMutation({
    mutationFn: (id: string) => resyncRefund(id),
    onSuccess: (r) => {
      toast.success(`Resynced — ${r.status}`);
      qc.invalidateQueries({ queryKey: ["refunds"] });
      qc.invalidateQueries({ queryKey: ["refunds-summary"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Resync failed"),
  });

  const rows: RefundRow[] = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Refunds" subtitle="Razorpay refunds — status, ledger linkage & gateway resync" />

      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Dealer, reason, rfnd_/pay_ id" className="erp-input pl-7 w-full" />
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Status</label>
          <F9SearchSelect value={status} onChange={setStatus} options={STATUS_OPTIONS} placeholder="Any" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="erp-input w-36" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
          <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="erp-input w-36" />
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total Refunded" tone="info" value={fmtINR(summary?.totalRefunded ?? 0)} hint={`${summary?.refundCount ?? 0} processed`} icon={<RotateCcw className="h-5 w-5" />} />
          <StatCard label="Pending" tone="warning" value={fmtINR(summary?.pendingAmount ?? 0)} hint={`${summary?.pendingCount ?? 0} at gateway`} />
          <StatCard label="Failed" tone="danger" value={fmtINR(summary?.failedAmount ?? 0)} hint={`${summary?.failedCount ?? 0} failed`} icon={<XCircle className="h-5 w-5" />} />
          <StatCard label="Unlinked (must be 0)" tone={(summary?.unlinkedCount ?? 0) > 0 ? "danger" : "success"} value={summary?.unlinkedCount ?? 0} hint="no ledger entry" icon={<AlertTriangle className="h-5 w-5" />} />
        </div>

        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState title="No refunds match your filter" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Date</th><th>Voucher</th><th>Refund ID</th><th>Dealer</th>
                  <th className="num" style={{ textAlign: "right" }}>Amount</th>
                  <th>Reason</th><th>By</th><th>Status</th><th style={{ textAlign: "center" }}>Ledger</th><th></th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.createdAt)}</td>
                    <td className="font-mono text-[11px]">{r.voucherNo ?? "—"}</td>
                    <td className="font-mono text-[11px] text-muted-foreground">{r.razorpayRefundId ?? "—"}</td>
                    <td className="font-medium">{r.dealerName} <span className="text-muted-foreground font-mono text-[11px]">{r.dealerCode}</span></td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(r.amount)}</td>
                    <td className="text-[12px]">{r.reason}</td>
                    <td className="text-[12px]">{r.initiatedByName ?? "—"}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td style={{ textAlign: "center" }}>
                      {r.ledgerEntryId ? <CheckCircle2 className="h-4 w-4 text-success inline" /> : <AlertTriangle className="h-4 w-4 text-warning inline" />}
                    </td>
                    <td>
                      {r.status === "pending" && (
                        <Button variant="outline" size="sm" className="h-6 text-[11px]" disabled={resync.isPending} onClick={() => resync.mutate(r.id)}>
                          Resync
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-[12px]">
              <span className="text-muted-foreground">Page {page} of {totalPages} · {data?.total ?? 0} refunds</span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" className="h-7" disabled={page <= 1} onClick={() => setPage(p => Math.max(1, p - 1))}>Previous</Button>
                <Button variant="outline" size="sm" className="h-7" disabled={page >= totalPages} onClick={() => setPage(p => Math.min(totalPages, p + 1))}>Next</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
