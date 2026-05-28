// apps/web/src/pages/finance/ARAgingPage.tsx
// Finance → AR Aging  (/finance/ar-aging, finance.view)
import { Fragment, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader, {
  FilterBar, StatCard, EmptyState, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Search, AlertTriangle, ChevronDown, ChevronRight } from "lucide-react";
import {
  fetchArAging, fetchArAgingSummary, fetchArAgingDealer, fetchRoutes,
  type ArAgingRow, type AgingBucket,
} from "@/services/api";

const BUCKET_OPTIONS: F9Option[] = [
  { value: "current", label: "Current" },
  { value: "b1_30", label: "1–30 days" },
  { value: "b31_60", label: "31–60 days" },
  { value: "b61_90", label: "61–90 days" },
  { value: "b90_plus", label: "90+ days" },
];
const WORST_TONE: Record<AgingBucket, string> = {
  current: "bg-success/15 text-success",
  b1_30: "bg-warning/10 text-warning",
  b31_60: "bg-warning/15 text-warning",
  b61_90: "bg-warning/20 text-warning",
  b90_plus: "bg-destructive/15 text-destructive",
};
const WORST_LABEL: Record<AgingBucket, string> = {
  current: "Current", b1_30: "1–30", b31_60: "31–60", b61_90: "61–90", b90_plus: "90+",
};

function DealerInvoices({ id }: { id: string }) {
  const { data, isLoading } = useQuery({ queryKey: ["ar-aging-dealer", id], queryFn: () => fetchArAgingDealer(id) });
  if (isLoading) return <div className="p-3"><Skeleton className="h-16 w-full" /></div>;
  const rows = data?.data ?? [];
  if (!rows.length) return <div className="p-3 text-[12px] text-muted-foreground">No unpaid invoices.</div>;
  return (
    <table className="erp-table">
      <thead><tr><th>Invoice</th><th>Date</th><th>Due</th><th className="num" style={{ textAlign: "right" }}>Total</th><th className="num" style={{ textAlign: "right" }}>Paid</th><th className="num" style={{ textAlign: "right" }}>Outstanding</th><th className="num" style={{ textAlign: "right" }}>Overdue</th><th>Last receipt</th></tr></thead>
      <tbody>
        {rows.map((i) => (
          <tr key={i.id}>
            <td className="font-mono text-[11px]">{i.invoiceNumber}</td>
            <td>{fmtDate(i.invoiceDate)}</td>
            <td>{fmtDate(i.dueDate)}</td>
            <td className="num" style={{ textAlign: "right" }}>{fmtINR(i.totalAmount)}</td>
            <td className="num" style={{ textAlign: "right" }}>{fmtINR(i.paidAmount)}</td>
            <td className="num text-destructive" style={{ textAlign: "right" }}>{fmtINR(i.outstanding)}</td>
            <td className="num" style={{ textAlign: "right" }}>{i.daysOverdue}d</td>
            <td className="text-[12px]">{i.lastReceiptDate ? fmtDate(i.lastReceiptDate) : "—"}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export default function ARAgingPage() {
  const [search, setSearch] = useState("");
  const [routeId, setRouteId] = useState<string | null>(null);
  const [bucket, setBucket] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState<string | null>(null);

  useEffect(() => { setPage(1); }, [search, routeId, bucket]);

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const routeOptions: F9Option[] = useMemo(
    () => (routes as any[]).map((r) => ({ value: String(r.id), label: r.name, sublabel: r.code })),
    [routes]
  );

  const filters = {
    search: search.trim() || undefined,
    routeId: routeId ?? undefined,
    bucket: (bucket as AgingBucket | null) ?? undefined,
  };
  const { data, isLoading } = useQuery({
    queryKey: ["ar-aging", filters, page],
    queryFn: () => fetchArAging({ ...filters, page, limit: 50 }),
  });
  const { data: summary } = useQuery({ queryKey: ["ar-aging-summary"], queryFn: fetchArAgingSummary });

  const rows: ArAgingRow[] = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;
  const total = summary?.totalOutstanding ?? 0;
  const seg = (v?: number) => (total > 0 ? `${Math.round(((v ?? 0) / total) * 100)}%` : "0%");

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="AR Aging" subtitle="Unpaid invoices bucketed by days past due, rolled up per dealer" />

      <FilterBar>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Dealer name / code" className="erp-input pl-7 w-full" />
          </div>
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Route</label>
          <F9SearchSelect value={routeId} onChange={setRouteId} options={routeOptions} placeholder="All" />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Bucket</label>
          <F9SearchSelect value={bucket} onChange={setBucket} options={BUCKET_OPTIONS} placeholder="Any" />
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
          <StatCard label="Total Outstanding" value={fmtINR(summary?.totalOutstanding ?? 0)} />
          <StatCard label="Total Overdue" tone="warning" value={fmtINR(summary?.totalOverdue ?? 0)} />
          <StatCard label="90+ Days" tone="danger" value={fmtINR(summary?.criticalAmount ?? 0)} icon={<AlertTriangle className="h-5 w-5" />} />
          <StatCard label="Dealers with dues" value={summary?.dealersWithDues ?? 0} />
          <StatCard label="Dealers in 90+" tone="danger" value={summary?.dealers90PlusCount ?? 0} />
        </div>

        {/* Aging stacked bar */}
        <div className="erp-panel p-3">
          <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Book composition</div>
          <div className="flex h-4 w-full overflow-hidden rounded">
            <div className="bg-success" style={{ width: seg(summary?.bucketCurrent) }} title="Current" />
            <div className="bg-warning/60" style={{ width: seg(summary?.bucket1_30) }} title="1–30" />
            <div className="bg-warning" style={{ width: seg(summary?.bucket31_60) }} title="31–60" />
            <div className="bg-orange-500" style={{ width: seg(summary?.bucket61_90) }} title="61–90" />
            <div className="bg-destructive" style={{ width: seg(summary?.bucket90Plus) }} title="90+" />
          </div>
          <div className="flex gap-4 mt-2 text-[11px] text-muted-foreground flex-wrap">
            <span>Current {fmtINR(summary?.bucketCurrent ?? 0)}</span>
            <span>1–30 {fmtINR(summary?.bucket1_30 ?? 0)}</span>
            <span>31–60 {fmtINR(summary?.bucket31_60 ?? 0)}</span>
            <span>61–90 {fmtINR(summary?.bucket61_90 ?? 0)}</span>
            <span>90+ {fmtINR(summary?.bucket90Plus ?? 0)}</span>
          </div>
        </div>

        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">{Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
          ) : rows.length === 0 ? (
            <EmptyState title="No dealers with outstanding invoices" />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 24 }}></th>
                  <th>Code</th><th>Name</th><th>Route</th>
                  <th className="num" style={{ textAlign: "right" }}>Current</th>
                  <th className="num" style={{ textAlign: "right" }}>1–30</th>
                  <th className="num" style={{ textAlign: "right" }}>31–60</th>
                  <th className="num" style={{ textAlign: "right" }}>61–90</th>
                  <th className="num" style={{ textAlign: "right" }}>90+</th>
                  <th className="num" style={{ textAlign: "right" }}>Total</th>
                  <th className="num" style={{ textAlign: "right" }}>Inv</th>
                  <th>Worst</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((d) => (
                  <Fragment key={d.id}>
                    <tr className="cursor-pointer hover:bg-muted/40" onClick={() => setExpanded(expanded === d.id ? null : d.id)}>
                      <td>{expanded === d.id ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}</td>
                      <td className="font-mono text-[11px]">{d.code}</td>
                      <td className="font-medium">{d.name}</td>
                      <td className="text-[12px]">{d.routeName ?? "—"}</td>
                      <td className="num" style={{ textAlign: "right" }}>{d.currentAmount > 0 ? fmtINR(d.currentAmount) : "—"}</td>
                      <td className="num" style={{ textAlign: "right" }}>{d.b1_30 > 0 ? fmtINR(d.b1_30) : "—"}</td>
                      <td className="num" style={{ textAlign: "right" }}>{d.b31_60 > 0 ? fmtINR(d.b31_60) : "—"}</td>
                      <td className="num" style={{ textAlign: "right" }}>{d.b61_90 > 0 ? fmtINR(d.b61_90) : "—"}</td>
                      <td className="num text-destructive" style={{ textAlign: "right" }}>{d.b90Plus > 0 ? fmtINR(d.b90Plus) : "—"}</td>
                      <td className="num font-semibold" style={{ textAlign: "right" }}>{fmtINR(d.totalOutstanding)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{d.invoiceCount}</td>
                      <td><span className={`inline-block rounded px-1.5 py-0.5 text-[11px] font-medium ${WORST_TONE[d.worstBucket]}`}>{WORST_LABEL[d.worstBucket]}</span></td>
                    </tr>
                    {expanded === d.id && (
                      <tr><td colSpan={12} className="bg-muted/20 p-0"><DealerInvoices id={d.id} /></td></tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          )}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-4 py-2 border-t border-border bg-muted/30 text-[12px]">
              <span className="text-muted-foreground">Page {page} of {totalPages} · {data?.total ?? 0} dealers</span>
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
