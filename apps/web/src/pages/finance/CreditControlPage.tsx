// apps/web/src/pages/finance/CreditControlPage.tsx
// Finance → Available Balances  (/finance/credit-control, finance.view)
//
// Prepaid model: customers have NO credit limit. Each row shows the customer's
// Available Balance (opening + top-ups − purchases, floored at 0). A customer
// whose balance is ≤ 0 ("empty") must record a payment before they can indent.
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader, {
  FilterBar, StatCard, EmptyState, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, AlertTriangle, Wallet, Clock } from "lucide-react";
import {
  fetchCreditControl, fetchCreditControlSummary, fetchRoutes,
  type CreditControlRow, type BalanceBucket,
} from "@/services/api";

const STATUS_OPTIONS: F9Option[] = [
  { value: "funded", label: "Funded (has balance)" },
  { value: "empty",  label: "Empty (needs top-up)" },
];
const PAYMODE_OPTIONS: F9Option[] = [
  { value: "Cash", label: "Cash" },
  { value: "Credit", label: "Credit" },
];
const BUCKET_TONE: Record<BalanceBucket, string> = {
  funded: "bg-success/15 text-success",
  empty:  "bg-muted text-muted-foreground",
};
const BUCKET_LABEL: Record<BalanceBucket, string> = {
  funded: "Funded",
  empty:  "Empty",
};

export default function CreditControlPage() {
  const [search, setSearch] = useState("");
  const [routeId, setRouteId] = useState<string | null>(null);
  const [payMode, setPayMode] = useState<string | null>(null);
  const [bucket, setBucket] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => { setPage(1); }, [search, routeId, payMode, bucket]);

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const routeOptions: F9Option[] = useMemo(
    () => (routes as any[]).map((r) => ({ value: String(r.id), label: r.name, sublabel: r.code })),
    [routes]
  );

  const filters = {
    search: search.trim() || undefined,
    routeId: routeId ?? undefined,
    payMode: (payMode as "Cash" | "Credit" | null) ?? undefined,
    statusBucket: (bucket as BalanceBucket | null) ?? undefined,
  };
  const { data, isLoading } = useQuery({
    queryKey: ["credit-control", filters, page],
    queryFn: () => fetchCreditControl({ ...filters, page, limit: 50 }),
  });
  const { data: summary } = useQuery({
    queryKey: ["credit-control-summary"],
    queryFn: fetchCreditControlSummary,
  });

  const rows: CreditControlRow[] = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Available Balances" subtitle="Prepaid customer balances — top-ups minus purchases. No credit limit; customers spend only what they've paid in." />

      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Customer name / code" className="erp-input pl-7 w-full" />
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Route</label>
          <F9SearchSelect value={routeId} onChange={setRouteId} options={routeOptions} placeholder="All" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Pay Mode</label>
          <F9SearchSelect value={payMode} onChange={setPayMode} options={PAYMODE_OPTIONS} placeholder="Any" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Status</label>
          <F9SearchSelect value={bucket} onChange={setBucket} options={STATUS_OPTIONS} placeholder="Any" />
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total Available" tone="success" value={fmtINR(summary?.totalPrepaid ?? 0)} icon={<Wallet className="h-5 w-5" />} />
          <StatCard label="Funded Customers" tone="default" value={summary?.fundedCount ?? 0} hint="have balance" />
          <StatCard label="Empty Customers" tone={(summary?.emptyCount ?? 0) > 0 ? "warning" : "default"} value={summary?.emptyCount ?? 0} hint="need top-up" icon={<AlertTriangle className="h-5 w-5" />} />
          <StatCard label="Dormant 30d + dues" tone={(summary?.dormantWithDuesCount ?? 0) > 0 ? "warning" : "default"} value={summary?.dormantWithDuesCount ?? 0} icon={<Clock className="h-5 w-5" />} />
        </div>

        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState title="No customers match your filter" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Code</th><th>Name</th><th>Route</th><th>Pay</th>
                  <th className="num" style={{ textAlign: "right" }}>Available Balance</th>
                  <th className="num" style={{ textAlign: "right" }}>Owed</th>
                  <th>Status</th>
                  <th>Last payment</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <tr key={d.id} className={d.statusBucket === "empty" ? "bg-muted/20" : ""}>
                    <td className="font-mono text-[11px]">{d.code}</td>
                    <td className="font-medium">{d.name}</td>
                    <td className="text-[12px]">{d.route_name ?? "—"}</td>
                    <td className="text-[12px]">{d.pay_mode}</td>
                    <td className="num text-success" style={{ textAlign: "right" }}>{fmtINR(d.availableBalance)}</td>
                    <td className="num text-destructive" style={{ textAlign: "right" }}>{d.outstanding > 0 ? fmtINR(d.outstanding) : "—"}</td>
                    <td><span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${BUCKET_TONE[d.statusBucket]}`}>{BUCKET_LABEL[d.statusBucket]}</span></td>
                    <td className="text-[12px]">{d.lastPaymentAt ? fmtDate(d.lastPaymentAt) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-[12px]">
              <span className="text-muted-foreground">Page {page} of {totalPages} · {data?.total ?? 0} customers</span>
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
