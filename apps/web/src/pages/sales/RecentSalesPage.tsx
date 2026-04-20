// apps/web/src/pages/sales/RecentSalesPage.tsx
// ════════════════════════════════════════════════════════════════════
// Recent Sales — Marketing v1.4
//
// Five F9 filters (Customer, Type, Route, Date, Sales) + Generate
// button. Table hidden until Generate is clicked.
//
// "Sales" filter meaning (confirmed): filters by direct_sale channel:
//   all / Gate Pass (Agents) / Cash Customer
// "Type" filter: payment mode (cash / upi / credit)
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
  fetchDirectSales,
  fetchRoutes,
  fetchCustomers,
  fetchCashCustomers,
} from "@/services/api";

const TYPE_OPTIONS: F9Option[] = [
  { value: "cash", label: "Cash" },
  { value: "upi", label: "UPI" },
  { value: "credit", label: "Credit" },
  { value: "wallet", label: "Wallet" },
];

const SALES_OPTIONS: F9Option[] = [
  { value: "agent", label: "Gate Pass (Agents)" },
  { value: "cash", label: "Cash Customer" },
];

// Last 30 days for the Date F9
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

export default function RecentSalesPage() {
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const { data: cashCustomers = [] } = useQuery({
    queryKey: ["cash-customers"],
    queryFn: fetchCashCustomers,
  });

  // Filter state
  const [customerFilter, setCustomerFilter] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [routeFilter, setRouteFilter] = useState<string | null>(null);
  const [dateFilter, setDateFilter] = useState<string | null>(null);
  const [salesFilter, setSalesFilter] = useState<string | null>(null);
  const [generated, setGenerated] = useState(false);

  // Fetch — gated by Generate click
  const { data: sales = [], isLoading, refetch } = useQuery({
    queryKey: [
      "recent-sales",
      salesFilter,
      routeFilter,
      dateFilter,
    ],
    queryFn: () =>
      fetchDirectSales({
        customerType: salesFilter ?? undefined,
        routeId: routeFilter ?? undefined,
        dateFrom: dateFilter ?? undefined,
        dateTo: dateFilter ?? undefined,
      }),
    enabled: false,
  });

  // Client-side filter for customer + type (backend doesn't support these as direct filters
  // but the page-level F9s for customer + type need to work regardless)
  const filtered = useMemo(() => {
    if (!generated) return [];
    return (sales as any[]).filter(s => {
      if (customerFilter && s.customerId !== customerFilter) return false;
      if (typeFilter && s.paymentMode?.toLowerCase() !== typeFilter) return false;
      return true;
    });
  }, [sales, customerFilter, typeFilter, generated]);

  // F9 option lists
  const routeOptions: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );

  // Customer F9 = agent dealers + cash customers
  const customerOptions: F9Option[] = useMemo(() => {
    const agents = customers.map((c: any) => ({
      value: c.id,
      label: c.name,
      sublabel: `${c.code} · Agent`,
      searchText: `${c.code} ${c.name} ${c.phone ?? ""}`,
    }));
    const cash = cashCustomers.map((c: any) => ({
      value: c.id,
      label: c.name,
      sublabel: `Cash · ${c.phone ?? "—"}`,
      searchText: `${c.name} ${c.phone ?? ""}`,
    }));
    return [...agents, ...cash];
  }, [customers, cashCustomers]);

  const dateOptions = useMemo(buildDateOptions, []);

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  const clearFilters = () => {
    setCustomerFilter(null);
    setTypeFilter(null);
    setRouteFilter(null);
    setDateFilter(null);
    setSalesFilter(null);
    setGenerated(false);
  };

  return (
    <PageShell
      header={
        <>
          <PageHeader title="Recent Sales" description="Recent gate pass + cash customer sales" />
          <FilterBar>
            <F9SearchSelect
              label="Customer"
              value={customerFilter}
              onChange={setCustomerFilter}
              options={customerOptions}
              allowAll
              className="w-64"
            />
            <F9SearchSelect
              label="Type"
              value={typeFilter}
              onChange={setTypeFilter}
              options={TYPE_OPTIONS}
              allowAll
              className="w-40"
            />
            <F9SearchSelect
              label="Route"
              value={routeFilter}
              onChange={setRouteFilter}
              options={routeOptions}
              allowAll
              className="w-56"
            />
            <F9SearchSelect
              label="Date"
              value={dateFilter}
              onChange={setDateFilter}
              options={dateOptions}
              allowAll
              className="w-56"
            />
            <F9SearchSelect
              label="Sales"
              value={salesFilter}
              onChange={setSalesFilter}
              options={SALES_OPTIONS}
              allowAll
              className="w-52"
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
                <th className="text-left py-2.5 px-3 font-medium">GP No.</th>
                <th className="text-left py-2.5 px-3 font-medium">Date</th>
                <th className="text-left py-2.5 px-3 font-medium">Customer</th>
                <th className="text-left py-2.5 px-3 font-medium">Type</th>
                <th className="text-left py-2.5 px-3 font-medium">Route</th>
                <th className="text-left py-2.5 px-3 font-medium">Items</th>
                <th className="text-left py-2.5 px-3 font-medium">Pay Mode</th>
                <th className="text-right py-2.5 px-3 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((s: any) => (
                <tr key={s.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono text-xs">{s.gpNo || "—"}</td>
                  <td className="py-2 px-3 text-xs">{s.date}</td>
                  <td className="py-2 px-3 font-medium">{s.customerName}</td>
                  <td className="py-2 px-3 text-xs">
                    <span
                      className={`px-2 py-0.5 rounded ${
                        s.type === "agent"
                          ? "bg-primary/10 text-primary"
                          : "bg-secondary text-secondary-foreground"
                      }`}
                    >
                      {s.type === "agent" ? "Gate Pass" : "Cash"}
                    </span>
                  </td>
                  <td className="py-2 px-3 text-xs">{s.routeName || "—"}</td>
                  <td className="py-2 px-3 text-xs text-muted-foreground max-w-xs truncate">
                    {(s.items ?? [])
                      .map((x: any) => `${x.productName}×${x.qty}`)
                      .join(", ")}
                  </td>
                  <td className="py-2 px-3 text-xs uppercase">{s.payMode}</td>
                  <td className="py-2 px-3 text-right font-mono">
                    ₹{(s.total ?? 0).toLocaleString()}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-muted-foreground text-sm">
                    No sales match the selected filters.
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