// apps/web/src/pages/sales/AllIndentsPage.tsx
// ════════════════════════════════════════════════════════════════════
// All Indents — Marketing v1.4
//
// Filter-first UX with 4 F9 pickers (Route, Status, Customer, Date)
// plus a Generate button. Table renders only after Generate is clicked.
// ════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { X } from "lucide-react";
import {
  fetchIndents,
  fetchRoutes,
  fetchCustomers,
} from "@/services/api";

const STATUS_OPTIONS: F9Option[] = [
  { value: "Pending", label: "Pending" },
  { value: "Posted", label: "Posted" },
  { value: "Dispatched", label: "Dispatched" },
  { value: "Cancelled", label: "Cancelled" },
];

// Last 30 days of date options for the Date F9 (spec says Date is F9)
function buildDateOptions(): F9Option[] {
  const out: F9Option[] = [];
  const today = new Date();
  for (let i = 0; i < 30; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() - i);
    const iso = d.toISOString().split("T")[0];
    out.push({
      value: iso,
      label: iso,
      sublabel:
        i === 0 ? "Today" :
        i === 1 ? "Yesterday" :
        d.toLocaleDateString("en-IN", { day: "2-digit", month: "short" }),
    });
  }
  return out;
}

const STATUS_COLOR: Record<string, string> = {
  Pending: "bg-warning/10 text-warning",
  Posted: "bg-primary/10 text-primary",
  Dispatched: "bg-success/10 text-success",
  Cancelled: "bg-destructive/10 text-destructive",
};

export default function AllIndentsPage() {
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });

  const [routeFilter, setRouteFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [customerFilter, setCustomerFilter] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [generated, setGenerated] = useState(false);

  // Fetch gated behind Generate
  const { data: indents = [], isLoading, refetch } = useQuery({
    queryKey: ["indents", "filtered", routeFilter, statusFilter, customerFilter, dateFilter],
    queryFn: () =>
      fetchIndents({
        routeId: routeFilter ?? undefined,
        status: statusFilter ?? undefined,
        dealerId: customerFilter ?? undefined,
        date: dateFilter ?? undefined,
      }),
    enabled: false,
  });

  const routeOptions: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );
  const customerOptions: F9Option[] = useMemo(
    () =>
      customers.map((c: any) => ({
        value: c.id,
        label: c.name,
        sublabel: c.code,
        searchText: `${c.code} ${c.name} ${c.phone ?? ""}`,
      })),
    [customers]
  );
  const dateOptions = useMemo(buildDateOptions, []);

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  const clearFilters = () => {
    setRouteFilter(null);
    setStatusFilter(null);
    setCustomerFilter(null);
    setDateFilter(null);
    setGenerated(false);
  };

  return (
    <PageShell
      header={
        <>
          <PageHeader title="All Indents" description="View all recorded indents" />
          <FilterBar>
            <F9SearchSelect
              label="Route"
              value={routeFilter}
              onChange={setRouteFilter}
              options={routeOptions}
              allowAll
              className="w-56"
            />
            <F9SearchSelect
              label="Status"
              value={statusFilter}
              onChange={setStatusFilter}
              options={STATUS_OPTIONS}
              allowAll
              className="w-44"
            />
            <F9SearchSelect
              label="Customer"
              value={customerFilter}
              onChange={setCustomerFilter}
              options={customerOptions}
              allowAll
              className="w-64"
            />
            <F9SearchSelect
              label="Date"
              value={dateFilter}
              onChange={setDateFilter}
              options={dateOptions}
              allowAll
              className="w-56"
            />
            <Button onClick={handleGenerate} disabled={isLoading}>
              {isLoading ? "Loading..." : "Generate"}
            </Button>
            {generated && (
              <Button variant="outline" onClick={clearFilters}>
                <X className="h-4 w-4 mr-1" /> Clear
              </Button>
            )}
          </FilterBar>
        </>
      }
    >
      {!generated ? (
        <EmptyHint message="Set filters above (or leave as All) and click Generate." />
      ) : isLoading ? (
        <ScrollableTableBody>
          <div className="p-6 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-8 w-full" />
            ))}
          </div>
        </ScrollableTableBody>
      ) : (
        <ScrollableTableBody>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left py-2.5 px-3 font-medium">Indent No.</th>
                <th className="text-left py-2.5 px-3 font-medium">Date</th>
                <th className="text-left py-2.5 px-3 font-medium">Customer</th>
                <th className="text-left py-2.5 px-3 font-medium">Route</th>
                <th className="text-left py-2.5 px-3 font-medium">Items</th>
                <th className="text-right py-2.5 px-3 font-medium">Total</th>
                <th className="text-left py-2.5 px-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {(indents as any[]).map(i => (
                <tr key={i.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono text-xs">{i.indentNo || i.id.slice(0, 8)}</td>
                  <td className="py-2 px-3 text-xs">{i.date || "—"}</td>
                  <td className="py-2 px-3 font-medium">{i.customerName}</td>
                  <td className="py-2 px-3 text-xs">{i.routeName || i.routeId || "—"}</td>
                  <td className="py-2 px-3 text-xs text-muted-foreground max-w-md truncate">
                    {(i.items ?? []).map((x: any) => `${x.productName}×${x.qty}`).join(", ")}
                  </td>
                  <td className="py-2 px-3 text-right font-mono">
                    ₹{(i.total ?? 0).toLocaleString()}
                  </td>
                  <td className="py-2 px-3">
                    <span
                      className={`text-xs px-2 py-0.5 rounded ${
                        STATUS_COLOR[i.status] ?? "bg-muted text-muted-foreground"
                      }`}
                    >
                      {i.status}
                    </span>
                  </td>
                </tr>
              ))}
              {indents.length === 0 && (
                <tr>
                  <td colSpan={7} className="py-10 text-center text-muted-foreground text-sm">
                    No indents match the selected filters.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollableTableBody>
      )}
    </PageShell>
  );
}

function EmptyHint({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <Card className="max-w-md">
        <CardContent className="p-8 text-center">
          <p className="text-sm text-muted-foreground">{message}</p>
        </CardContent>
      </Card>
    </div>
  );
}