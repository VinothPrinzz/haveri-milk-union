import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { get } from "@/lib/apiClient";
import {
  Package, ShoppingCart, Users, TrendingUp, AlertTriangle, Truck,
  ClipboardCheck, Boxes, Wallet, Plus,
} from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
} from "recharts";
import PageHeader, {
  StatCard, StatusPill, fmtINR, fmtDate, EmptyState,
} from "@/components/PageHeader";
import { DataTable, Column } from "@/components/DataTable";

interface DashboardSummary {
  today: { orderCount: number; revenue: number; itemsSold: number; directSalesCount: number; directSalesRevenue: number };
  pendingIndents: number;
  activeCustomers: number;
  stockAlerts: { outOfStock: number; critical: number; low: number };
  recentOrders: { id: string; status: string; grand_total: number; item_count: number; created_at: string; dealer_name: string; zone_name: string }[];
  stockOverview: { id: string; name: string; stock: number; stock_status: string; category_name: string; unit?: string }[];
  // API actually returns: { name, slug, color, order_count, revenue }
  zoneBreakdown: { name?: string; zone_name?: string; order_count?: number; orders?: number; revenue: number | string }[];
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { data, isLoading, error } = useQuery<DashboardSummary>({
    queryKey: ["dashboard-summary"],
    queryFn: () => get<DashboardSummary>("/dashboard/summary"),
    refetchInterval: 60_000,
  });

  const today = new Date().toLocaleDateString("en-IN", {
    weekday: "long", day: "2-digit", month: "short", year: "numeric",
  });

  const stockAlertCount =
  (data?.stockAlerts?.low ?? 0) +
  (data?.stockAlerts?.critical ?? 0) +
  (data?.stockAlerts?.outOfStock ?? 0);

  const chartData = (data?.zoneBreakdown ?? []).map(z => {
    const label = (z.name ?? z.zone_name ?? "—").toString();
    const rev = typeof z.revenue === "number" ? z.revenue : parseFloat(String(z.revenue ?? 0)) || 0;
    return {
      zone: label.replace(/ ?Zone$/i, ""),
      revenue: Math.round(rev),
    };
  });

  const recentCols: Column<DashboardSummary["recentOrders"][number]>[] = [
    { key: "dealer", header: "Dealer", cell: r => <span className="font-medium">{r.dealer_name}</span> },
    { key: "zone", header: "Zone", cell: r => <span className="text-muted-foreground">{r.zone_name}</span> },
    { key: "items", header: "Items", cell: r => r.item_count, align: "right" },
    { key: "amount", header: "Amount ₹", cell: r => fmtINR(r.grand_total), align: "right" },
    { key: "status", header: "Status", cell: r => <StatusPill status={r.status} /> },
    {
      key: "time", header: "Time",
      cell: r => (
        <span className="text-muted-foreground text-[12px]">
          {new Date(r.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}
        </span>
      ),
    },
  ];

  return (
    <div>
      <PageHeader
        title="Dashboard"
        subtitle={`Welcome back. Here's your union snapshot for ${today}.`}
      />

      <div className="p-4 space-y-3">
        {/* Row 1 — KPI strip */}
        {isLoading ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-20 rounded-sm" />)}
          </div>
        ) : error ? (
          <div className="erp-panel p-3 border-l-4 border-l-destructive bg-destructive/5">
            <div className="text-[13px] text-destructive font-medium">
              Could not load dashboard data. Please check API connection and authentication.
            </div>
          </div>
        ) : data && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard label="Today's Orders"     value={data.today.orderCount}            icon={<ShoppingCart className="w-5 h-5" />} tone="info" />
            <StatCard label="Today's Revenue"    value={fmtINR(data.today.revenue, false)} icon={<TrendingUp className="w-5 h-5" />}   tone="success" />
            <StatCard label="Active Customers"   value={data.activeCustomers}             icon={<Users className="w-5 h-5" />}        tone="default" />
            <StatCard label="Pending Indents"    value={data.pendingIndents}              icon={<ClipboardCheck className="w-5 h-5" />} tone="warning" />
            <StatCard label="Stock Alerts"       value={stockAlertCount}                  icon={<AlertTriangle className="w-5 h-5" />} tone="danger" hint={`${data.stockAlerts.outOfStock} OOS · ${data.stockAlerts.critical} crit · ${data.stockAlerts.low} low`} />
          </div>
        )}

        {/* Row 2 — Revenue by Zone + Stock Overview */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <div className="erp-panel p-3 lg:col-span-2">
            <div className="erp-section-title flex items-center justify-between">
              <span>Revenue by Zone</span>
              <span className="text-[11px] normal-case font-normal text-muted-foreground">in ₹</span>
            </div>
            {isLoading ? <Skeleton className="h-52" /> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData.length ? chartData : [{ zone: "—", revenue: 0 }]}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="zone" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: number) => [fmtINR(v), "Revenue"]} contentStyle={{ borderRadius: 4, fontSize: 12 }} />
                  <Bar dataKey="revenue" fill="hsl(var(--info))" radius={[2, 2, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          <div className="erp-panel">
            <div className="px-3 py-2 erp-section-title !mb-0 !border-b !pb-2 flex items-center gap-2">
              <Boxes className="w-3.5 h-3.5" /> Current Stock Levels
            </div>
            <div className="overflow-auto max-h-[220px]">
              {isLoading ? <div className="p-3"><Skeleton className="h-40" /></div> : (
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th className="num" style={{ textAlign: "right" }}>Stock</th>
                      <th>Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.stockOverview ?? []).map((s, i) => (
                      <tr key={s.id} className={i % 2 === 1 ? "zebra" : ""}>
                        <td className="truncate max-w-[160px]">{s.name.replace("Nandini ", "")}</td>
                        <td className="num" style={{ textAlign: "right" }}>{s.stock}</td>
                        <td>
                          {s.stock_status === "out_of_stock" ? <StatusPill status="cancelled" /> :
                           (s.stock_status === "critical" || s.stock_status === "low") ? <StatusPill status="pending" /> :
                           <StatusPill status="confirmed" />}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>

        {/* Row 3 — Quick actions */}
        <div className="erp-panel p-3">
          <div className="erp-section-title">Quick Actions</div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-2">
            {[
              { l: "Record Indent",   p: "/sales/record-indents",     i: ShoppingCart },
              { l: "Dealer Indents",  p: "/sales/dealer-indents",     i: ClipboardCheck },
              { l: "Create Dispatch", p: "/fgs/dispatch/create",      i: Truck },
              { l: "Stock Entry",     p: "/fgs/stock-entry",          i: Boxes },
              { l: "New Customer",    p: "/masters/customers/new",    i: Users },
              { l: "Receive Payment", p: "/finance/payments",         i: Wallet },
            ].map(q => {
              const I = q.i;
              return (
                <button
                  key={q.p}
                  onClick={() => navigate(q.p)}
                  className="flex items-center gap-2 px-2.5 py-2 border border-border rounded-sm hover:bg-accent text-[12.5px] text-left bg-panel"
                >
                  <I className="w-3.5 h-3.5 text-primary shrink-0" />
                  <span className="truncate">{q.l}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Row 4 — Recent Indents */}
        <div className="erp-panel">
          <div className="px-3 py-2 erp-section-title !mb-0 !border-b !pb-2">Recent Indents</div>
          <div className="overflow-auto max-h-[320px]">
            {isLoading ? (
              <div className="p-3"><Skeleton className="h-40" /></div>
            ) : (data?.recentOrders?.length ?? 0) === 0 ? (
              <EmptyState title="No recent indents." />
            ) : (
              <DataTable
                columns={recentCols}
                rows={(data?.recentOrders ?? []).map(o => ({ ...o }))}
                maxHeight="280px"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}