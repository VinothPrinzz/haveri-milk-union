// apps/web/src/pages/sales/InvoicesListPage.tsx
// ════════════════════════════════════════════════════════════════════
// Invoices List — /sales/invoices
// Paginated list with filters (search, date range, route, payment
// status). Row click navigates to /sales/invoices/:id. Summary strip
// aggregates the current page so the user gets instant context.
// ════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Eye, Receipt, AlertCircle, IndianRupee, CheckCircle2,
} from "lucide-react";
import {
  fetchInvoicesList,
  fetchRoutes,
  type InvoiceListRow,
} from "@/services/api";

const fmtMoney = (n: string | number) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(typeof n === "string" ? parseFloat(n) || 0 : n);

const fmtInt = new Intl.NumberFormat("en-IN");

const fmtDate = (iso: string) => {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric",
  });
};

const STATUS_STYLES: Record<string, string> = {
  paid:    "bg-green-100 text-green-700",
  unpaid:  "bg-rose-100 text-rose-700",
  partial: "bg-amber-100 text-amber-700",
};

const STATUS_OPTIONS: F9Option[] = [
  { value: "paid",    label: "Paid" },
  { value: "unpaid",  label: "Unpaid" },
  { value: "partial", label: "Partial" },
];

export default function InvoicesListPage() {
  const navigate = useNavigate();

  // Filters
  const [search,        setSearch]        = useState("");
  const [dateFrom,      setDateFrom]      = useState("");
  const [dateTo,        setDateTo]        = useState("");
  const [routeId,       setRouteId]       = useState<string | null>(null);
  const [paymentStatus, setPaymentStatus] = useState<string | null>(null);
  const [page,          setPage]          = useState(1);

  useEffect(() => { setPage(1); }, [search, dateFrom, dateTo, routeId, paymentStatus]);

  const { data: routes = [] } = useQuery({
    queryKey: ["routes"],
    queryFn: fetchRoutes,
  });

  const routeOptions: F9Option[] = useMemo(
    () => (routes as any[]).map(r => ({
      value:    r.id,
      label:    r.name,
      sublabel: r.code,
    })),
    [routes]
  );

  // Debounced search
  const [debouncedSearch, setDebouncedSearch] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(t);
  }, [search]);

  const { data, isLoading, isFetching } = useQuery({
    queryKey: [
      "invoices",
      debouncedSearch, dateFrom, dateTo, routeId, paymentStatus, page,
    ],
    queryFn: () => fetchInvoicesList({
      search:        debouncedSearch || undefined,
      dateFrom:      dateFrom        || undefined,
      dateTo:        dateTo          || undefined,
      routeId:       routeId         ?? undefined,
      paymentStatus: (paymentStatus ?? undefined) as any,
      page,
      limit: 50,
    }),
  });

  const rows: InvoiceListRow[] = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;
  const totalCount = data?.total      ?? 0;

  const summary = useMemo(() => {
    let total = 0, paid = 0, unpaid = 0;
    for (const r of rows) {
      const amt = parseFloat(r.totalAmount) || 0;
      total += amt;
      if (r.paymentStatus === "paid")   paid   += amt;
      if (r.paymentStatus === "unpaid") unpaid += amt;
    }
    return { total, paid, unpaid };
  }, [rows]);

  return (
    <PageShell
      header={
        <>
          <PageHeader
            title="Invoices"
            description="All tax invoices — view, filter, print"
          />

          <FilterBar>
            <div className="min-w-[220px] flex-1">
              <label className="text-sm font-medium mb-1.5 block">Search</label>
              <Input
                type="search"
                placeholder="Invoice no., customer"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>

            <div className="min-w-[200px]">
              <label className="text-sm font-medium mb-1.5 block">Route</label>
              <F9SearchSelect
                value={routeId}
                onChange={setRouteId}
                options={routeOptions}
                placeholder="All routes"
                allowClear
              />
            </div>

            <div className="min-w-[180px]">
              <label className="text-sm font-medium mb-1.5 block">Status</label>
              <F9SearchSelect
                value={paymentStatus}
                onChange={setPaymentStatus}
                options={STATUS_OPTIONS}
                placeholder="All"
                allowClear
              />
            </div>

            {isFetching && !isLoading && (
              <div className="text-xs text-muted-foreground pb-2">Refreshing…</div>
            )}
          </FilterBar>

          {/* Summary strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <StatCard
              icon={<Receipt className="h-4 w-4 text-muted-foreground" />}
              label="Invoices (page)"
              value={fmtInt.format(rows.length)}
              sublabel={`of ${fmtInt.format(totalCount)} total`}
            />
            <StatCard
              icon={<IndianRupee className="h-4 w-4 text-muted-foreground" />}
              label="Amount (page)"
              value={fmtMoney(summary.total)}
            />
            <StatCard
              icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
              label="Paid (page)"
              value={fmtMoney(summary.paid)}
            />
            <StatCard
              icon={<AlertCircle className="h-4 w-4 text-rose-600" />}
              label="Outstanding (page)"
              value={fmtMoney(summary.unpaid)}
            />
          </div>
        </>
      }
    >
      {isLoading ? (
        <ScrollableTableBody className="p-4">
          <div className="space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </ScrollableTableBody>
      ) : rows.length === 0 ? (
        <div className="h-full flex items-center justify-center">
          <Card className="max-w-md">
            <CardContent className="p-10 text-center space-y-2">
              <Receipt className="h-10 w-10 mx-auto text-muted-foreground/50" />
              <p className="text-sm text-muted-foreground">
                No invoices match the current filters.
              </p>
            </CardContent>
          </Card>
        </div>
      ) : (
        <div className="h-full flex flex-col">
          <ScrollableTableBody className="flex-1">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
                <tr className="text-xs text-muted-foreground">
                  <th className="text-left  py-2.5 px-3 font-medium">Invoice No.</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Date</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Customer</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Route</th>
                  <th className="text-right py-2.5 px-3 font-medium">Items</th>
                  <th className="text-right py-2.5 px-3 font-medium">Subtotal</th>
                  <th className="text-right py-2.5 px-3 font-medium">GST</th>
                  <th className="text-right py-2.5 px-3 font-medium">Total</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Pay Mode</th>
                  <th className="text-left  py-2.5 px-3 font-medium">Status</th>
                  <th className="text-right py-2.5 px-3 font-medium w-16">View</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  const statusClass =
                    STATUS_STYLES[r.paymentStatus] ?? "bg-muted text-muted-foreground";
                  return (
                    <tr
                      key={r.id}
                      onClick={() => navigate(`/sales/invoices/${r.id}`)}
                      className="border-b cursor-pointer hover:bg-muted/30"
                    >
                      <td className="py-2 px-3 font-mono text-xs">{r.invoiceNumber}</td>
                      <td className="py-2 px-3 text-muted-foreground text-xs">
                        {fmtDate(r.invoiceDate)}
                      </td>
                      <td className="py-2 px-3 font-medium">
                        {r.dealerName}
                        {r.dealerCode && (
                          <span className="ml-1.5 text-[10px] font-mono text-muted-foreground">
                            {r.dealerCode}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-3 text-muted-foreground text-xs">
                        {r.routeName ?? "—"}
                      </td>
                      <td className="py-2 px-3 text-right font-mono">{r.itemCount}</td>
                      <td className="py-2 px-3 text-right font-mono text-muted-foreground">
                        {fmtMoney(r.taxableAmount)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono text-muted-foreground">
                        {fmtMoney(r.totalTax)}
                      </td>
                      <td className="py-2 px-3 text-right font-mono font-semibold">
                        {fmtMoney(r.totalAmount)}
                      </td>
                      <td className="py-2 px-3 text-xs text-muted-foreground capitalize">
                        {r.paymentMode ?? "—"}
                      </td>
                      <td className="py-2 px-3">
                        <span
                          className={`text-[11px] px-2 py-0.5 rounded font-medium capitalize ${statusClass}`}
                        >
                          {r.paymentStatus}
                          {r.overdueDays > 0 && r.paymentStatus !== "paid" && (
                            <span className="ml-1 text-[10px] font-normal">
                              · {r.overdueDays}d
                            </span>
                          )}
                        </span>
                      </td>
                      <td className="py-2 px-3 text-right">
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7"
                          onClick={e => {
                            e.stopPropagation();
                            navigate(`/sales/invoices/${r.id}`);
                          }}
                          title="View invoice"
                        >
                          <Eye className="h-4 w-4" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollableTableBody>

          {totalPages > 1 && (
            <div className="flex-shrink-0 border-t bg-card rounded-b-lg px-4 py-2 flex items-center justify-between text-sm">
              <span className="text-xs text-muted-foreground">
                Page {page} of {totalPages} · {fmtInt.format(totalCount)} invoices
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}

function StatCard({
  icon, label, value, sublabel,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  sublabel?: string;
}) {
  return (
    <Card>
      <CardContent className="p-4 flex items-center gap-3">
        {icon}
        <div>
          <div className="text-xs text-muted-foreground">{label}</div>
          <div className="text-lg font-semibold">{value}</div>
          {sublabel && (
            <div className="text-[10px] text-muted-foreground">{sublabel}</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}