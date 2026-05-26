// apps/web/src/pages/finance/RazorpayReconciliationPage.tsx
// ═══════════════════════════════════════════════════════════════════════
// Finance → Reconciliation
//
// Ties the Razorpay gateway record against the internal books. Every
// captured txn falls into one bucket:
//
//   • matched      — paid, has an internal payments row, signed off
//   • needs_review — paid, posted to books, awaiting finance sign-off
//   • not_posted   — paid in Razorpay but NO internal row. Money the
//                    ledger has not seen — applyPaidPayment failed.
//                    THIS IS THE BUCKET THAT MUST STAY EMPTY.
//   • stale        — created/attempted >24h, never paid (abandoned)
//
// Route:  /finance/reconciliation     (finance.view)
// ═══════════════════════════════════════════════════════════════════════
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, StatCard, EmptyState, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import {
  CheckCircle2, Clock, AlertOctagon, Archive,
} from "lucide-react";
import {
  fetchRazorpayReconciliation,
  reconcileOnlinePayment,
  type ReconRow,
  type ReconBucket,
} from "@/services/api";

const BUCKET_META: Record<ReconBucket, {
  label: string; tone: "success" | "warning" | "danger" | "default"; desc: string;
}> = {
  matched:      { label: "Matched",      tone: "success", desc: "Posted & signed off" },
  needs_review: { label: "Needs Review", tone: "warning", desc: "Posted, awaiting sign-off" },
  not_posted:   { label: "Not Posted",   tone: "danger",  desc: "Paid but missing from books" },
  stale:        { label: "Stale",        tone: "default", desc: "Abandoned >24h" },
};

function BucketBadge({ bucket }: { bucket: ReconBucket }) {
  const cls: Record<ReconBucket, string> = {
    matched:      "bg-success/15 text-success",
    needs_review: "bg-warning/15 text-warning",
    not_posted:   "bg-destructive/15 text-destructive",
    stale:        "bg-muted text-muted-foreground",
  };
  return (
    <span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${cls[bucket]}`}>
      {BUCKET_META[bucket].label}
    </span>
  );
}

export default function RazorpayReconciliationPage() {
  const qc = useQueryClient();
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");
  const [bucket,   setBucket]   = useState<"all" | ReconBucket>("all");

  // Default the window to the current month on first mount.
  useEffect(() => {
    const now = new Date();
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    setDateFrom(first.toISOString().slice(0, 10));
    setDateTo(now.toISOString().slice(0, 10));
  }, []);

  const { data, isLoading } = useQuery({
    queryKey: ["razorpay-reconciliation", dateFrom, dateTo, bucket],
    queryFn: () => fetchRazorpayReconciliation({
      dateFrom: dateFrom || undefined,
      dateTo:   dateTo   || undefined,
      bucket,
    }),
    enabled: !!dateFrom && !!dateTo,
  });

  const reconcile = useMutation({
    mutationFn: (id: string) => reconcileOnlinePayment(id, true),
    onSuccess: () => {
      toast.success("Marked reconciled");
      qc.invalidateQueries({ queryKey: ["razorpay-reconciliation"] });
      qc.invalidateQueries({ queryKey: ["online-payments"] });
      qc.invalidateQueries({ queryKey: ["online-payments-summary"] });
    },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });

  const rows: ReconRow[] = data?.data ?? [];
  const s = data?.summary;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Reconciliation"
        subtitle="Razorpay gateway record vs the internal ledger"
      />

      <FilterBar>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
          <Input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="erp-input w-40" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
          <Input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="erp-input w-40" />
        </div>
        <div className="flex items-end gap-1.5">
          {(["all", "not_posted", "needs_review", "matched", "stale"] as const).map(b => (
            <Button
              key={b}
              size="sm"
              variant={bucket === b ? "default" : "outline"}
              className="h-8 text-[12px]"
              onClick={() => setBucket(b)}
            >
              {b === "all" ? "All" : BUCKET_META[b as ReconBucket].label}
            </Button>
          ))}
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {/* Bucket tiles */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Matched" tone="success"
            value={String(s?.matched.count ?? 0)}
            hint={fmtINR(s?.matched.amount ?? 0)}
            icon={<CheckCircle2 className="h-5 w-5" />} />
          <StatCard label="Needs Review" tone="warning"
            value={String(s?.needs_review.count ?? 0)}
            hint={fmtINR(s?.needs_review.amount ?? 0)}
            icon={<Clock className="h-5 w-5" />} />
          <StatCard label="Not Posted"
            tone={(s?.not_posted.count ?? 0) > 0 ? "danger" : "success"}
            value={String(s?.not_posted.count ?? 0)}
            hint={fmtINR(s?.not_posted.amount ?? 0)}
            icon={<AlertOctagon className="h-5 w-5" />} />
          <StatCard label="Stale"
            value={String(s?.stale.count ?? 0)}
            hint={fmtINR(s?.stale.amount ?? 0)}
            icon={<Archive className="h-5 w-5" />} />
        </div>

        {(s?.not_posted.count ?? 0) > 0 && (
          <div className="rounded border border-destructive/40 bg-destructive/10 text-destructive px-3 py-2 text-[12.5px] flex items-center gap-2">
            <AlertOctagon className="h-4 w-4 shrink-0" />
            {s!.not_posted.count} payment(s) totalling {fmtINR(s!.not_posted.amount)} were
            captured by Razorpay but never reached the ledger. Investigate the
            webhook / applyPaidPayment for each before closing the books.
          </div>
        )}

        {/* Table */}
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState title="Nothing to reconcile in this window" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Dealer</th>
                  <th>Razorpay Payment</th>
                  <th className="num" style={{ textAlign: "right", width: 120 }}>Amount ₹</th>
                  <th>Internal Row</th>
                  <th>Bucket</th>
                  <th style={{ width: 130 }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDate(r.paidAt ?? r.createdAt)}</td>
                    <td className="font-medium">
                      {r.dealerName}
                      {r.dealerCode && (
                        <span className="text-muted-foreground font-mono text-[11px] ml-1">
                          {r.dealerCode}
                        </span>
                      )}
                    </td>
                    <td className="font-mono text-[11px] text-muted-foreground">
                      {r.razorpayPaymentId ?? r.razorpayOrderId}
                    </td>
                    <td className="num font-semibold" style={{ textAlign: "right" }}>
                      {fmtINR(r.amount)}
                    </td>
                    <td>
                      {r.internalPaymentId
                        ? <span className="text-success text-[12px]">Posted</span>
                        : <span className="text-destructive text-[12px]">Missing</span>}
                    </td>
                    <td><BucketBadge bucket={r.bucket} /></td>
                    <td>
                      {r.bucket === "needs_review" && (
                        <Button size="sm" variant="outline" className="h-7 text-[12px]"
                          disabled={reconcile.isPending}
                          onClick={() => reconcile.mutate(r.id)}>
                          Mark reconciled
                        </Button>
                      )}
                      {r.bucket === "matched"  && <span className="text-muted-foreground text-[12px]">—</span>}
                      {r.bucket === "stale"    && <span className="text-muted-foreground text-[12px]">No action</span>}
                      {r.bucket === "not_posted" && (
                        <span className="text-destructive text-[12px]">Investigate</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <p className="text-[11.5px] text-muted-foreground">
          Showing up to 500 rows. Narrow the date window for a complete view.
          Reconciliation here is at the payment level — settlement-batch
          matching against the Axis Bank statement is the next layer
          (settlements table, Phase 2).
        </p>
      </div>
    </div>
  );
}