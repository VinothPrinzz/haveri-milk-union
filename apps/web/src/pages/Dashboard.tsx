import { useQuery } from "@tanstack/react-query";
import { get } from "@/lib/apiClient";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Package, ShoppingCart, Users, TrendingUp, AlertTriangle, Warehouse } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import PageHeader from "@/components/PageHeader";

interface DashboardSummary {
  today: { orderCount: number; revenue: number; itemsSold: number; directSalesCount: number; directSalesRevenue: number };
  pendingIndents: number;
  activeCustomers: number;
  totalWalletBalance: number;
  stockAlerts: { outOfStock: number; critical: number; low: number };
  recentOrders: { id: string; status: string; grand_total: number; item_count: number; created_at: string; dealer_name: string; zone_name: string }[];
  stockOverview: { id: string; name: string; stock: number; stock_status: string; category_name: string }[];
  zoneBreakdown: { zone_name: string; orders: number; revenue: number }[];
}

function StatCard({ title, value, icon: Icon, color }: { title: string; value: string | number; icon: React.ComponentType<{ className?: string }>; color: string }) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex justify-between items-center">
          <div>
            <p className="text-xs text-muted-foreground">{title}</p>
            <p className="text-2xl font-bold mt-1">{value}</p>
          </div>
          <Icon className={`h-8 w-8 ${color} opacity-70`} />
        </div>
      </CardContent>
    </Card>
  );
}

const statusColors: Record<string, string> = {
  pending: "bg-warning/10 text-warning", confirmed: "bg-primary/10 text-primary",
  dispatched: "bg-purple-100 text-purple-700", delivered: "bg-success/10 text-success",
  cancelled: "bg-destructive/10 text-destructive",
};

export default function Dashboard() {
  const { data, isLoading, error } = useQuery<DashboardSummary>({
    queryKey: ["dashboard-summary"],
    queryFn: () => get<DashboardSummary>("/dashboard/summary"),
    refetchInterval: 60_000,
  });

  const stats = data ? [
    { label: "Today's Orders", value: data.today.orderCount, icon: ShoppingCart, color: "text-primary" },
    { label: "Today's Revenue", value: `₹${Math.round(data.today.revenue).toLocaleString()}`, icon: TrendingUp, color: "text-success" },
    { label: "Active Customers", value: data.activeCustomers, icon: Users, color: "text-primary" },
    { label: "Pending Indents", value: data.pendingIndents, icon: Package, color: "text-warning" },
    { label: "Low / Out of Stock", value: data.stockAlerts.low + data.stockAlerts.critical + data.stockAlerts.outOfStock, icon: AlertTriangle, color: "text-destructive" },
  ] : [];

  const chartData = (data?.zoneBreakdown ?? []).map(z => ({
    zone: (z.zone_name ?? "").replace(/ ?Zone$/i, ""),
    revenue: Math.round(z.revenue ?? 0),
  }));

  return (
    <div>
      <PageHeader title="Dashboard" description="Overview of marketing operations" />

      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-28" />)}
        </div>
      ) : error ? (
        <div className="mb-6 p-4 rounded-lg bg-destructive/10 text-destructive text-sm">
          Could not load dashboard data. Please check API connection and authentication.
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5 gap-4 mb-6">
          {stats.map(s => <StatCard key={s.label} title={s.label} value={s.value} icon={s.icon} color={s.color} />)}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="col-span-2">
          <CardHeader className="pb-2"><CardTitle className="text-base">Revenue by Zone</CardTitle></CardHeader>
          <CardContent>
            {isLoading ? <Skeleton className="h-52" /> : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData.length ? chartData : [{ zone: "Loading", revenue: 0 }]}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="zone" tick={{ fontSize: 11 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `₹${(v / 1000).toFixed(0)}k`} />
                  <Tooltip formatter={(v: number) => [`₹${v.toLocaleString()}`, "Revenue"]} />
                  <Bar dataKey="revenue" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base flex items-center gap-2">
              <Warehouse className="h-4 w-4" /> Current Stock Levels
            </CardTitle>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? <div className="p-5"><Skeleton className="h-40" /></div> : (
              <div className="overflow-auto rounded-b-lg border-t">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/30">
                      <th className="text-left py-2.5 px-3 font-medium text-muted-foreground">Product</th>
                      <th className="text-right py-2.5 px-3 font-medium text-muted-foreground">Current Stock</th>
                      <th className="text-left py-2.5 px-3 font-medium text-muted-foreground">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data?.stockOverview ?? []).map(s => (
                      <tr key={s.id} className="border-b last:border-0 hover:bg-muted/30">
                        <td className="py-2 px-3">{s.name.replace("Nandini ", "")}</td>
                        <td className="py-2 px-3 text-right font-mono">{s.stock}</td>
                        <td className="py-2 px-3">
                          {s.stock_status === "out_of_stock"
                            ? <span className="text-xs px-2 py-0.5 rounded bg-destructive/10 text-destructive">Out of Stock</span>
                            : (s.stock_status === "critical" || s.stock_status === "low")
                            ? <span className="text-xs px-2 py-0.5 rounded bg-warning/10 text-warning">Low</span>
                            : <span className="text-xs px-2 py-0.5 rounded bg-success/10 text-success">OK</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {(data?.recentOrders?.length ?? 0) > 0 && (
        <Card className="mt-4">
          <CardHeader className="pb-2"><CardTitle className="text-base">Recent Orders</CardTitle></CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <th className="text-left py-2.5 px-3 font-medium">Dealer</th>
                  <th className="text-left py-2.5 px-3 font-medium">Zone</th>
                  <th className="text-right py-2.5 px-3 font-medium">Items</th>
                  <th className="text-right py-2.5 px-3 font-medium">Amount</th>
                  <th className="text-left py-2.5 px-3 font-medium">Status</th>
                  <th className="text-left py-2.5 px-3 font-medium">Time</th>
                </tr>
              </thead>
              <tbody>
                {data!.recentOrders.map(o => (
                  <tr key={o.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-2 px-3 font-medium">{o.dealer_name}</td>
                    <td className="py-2 px-3 text-muted-foreground">{o.zone_name}</td>
                    <td className="py-2 px-3 text-right font-mono">{o.item_count}</td>
                    <td className="py-2 px-3 text-right font-mono">₹{Math.round(o.grand_total).toLocaleString()}</td>
                    <td className="py-2 px-3"><span className={`text-xs px-2 py-0.5 rounded font-medium ${statusColors[o.status] ?? "bg-secondary"}`}>{o.status}</span></td>
                    <td className="py-2 px-3 text-muted-foreground text-xs">{new Date(o.created_at).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" })}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
