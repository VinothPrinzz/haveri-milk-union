"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, StatCard, Card, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import Link from "next/link";

export default function DashboardPage() {
  const { data: windowData } = useQuery({
    queryKey: ["window-status"],
    queryFn: () => api.get("/api/v1/window/status"),
    refetchInterval: 30000,
  });

  const { data: ordersData } = useQuery({
    queryKey: ["recent-orders"],
    queryFn: () => api.get("/api/v1/orders", { page: 1, limit: 6 }),
  });

  const { data: stockData } = useQuery({
    queryKey: ["fgs-overview"],
    queryFn: () => api.get("/api/v1/fgs/overview"),
  });

  const { data: dealersData } = useQuery({
    queryKey: ["dealers-list"],
    queryFn: () => api.get("/api/v1/dealers", { page: 1, limit: 5 }),
  });

  const orders = ordersData?.data ?? [];
  const totalOrders = ordersData?.total ?? 0;
  const totalDealers = dealersData?.total ?? 0;
  const stockSummary = stockData?.summary;

  return (
    <>
      <PageHeader icon="🏠" title="Dashboard" subtitle="Welcome back — here's what's happening today" />

      {/* Stat Cards */}
      <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-4 mb-6">
        <StatCard icon="📦" iconBg="bg-brand-light text-brand" value={totalOrders} label="Total Orders" delta="12% vs yesterday" deltaUp />
        <StatCard icon="✅" iconBg="bg-success/10 text-success" value={orders.filter((o: any) => o.status === "confirmed").length} label="Confirmed" />
        <StatCard icon="🚛" iconBg="bg-info/10 text-info" value={orders.filter((o: any) => o.status === "dispatched").length} label="Dispatched" />
        <StatCard icon="⏳" iconBg="bg-warning/10 text-warning" value={orders.filter((o: any) => o.status === "pending").length} label="Pending" />
        <StatCard icon="👥" iconBg="bg-brand-light text-brand" value={totalDealers} label="Active Dealers" />
        <StatCard icon="⚠️" iconBg="bg-danger/10 text-danger" value={stockSummary?.low ?? 0} label="Low Stock Items" />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-6">
        {/* Revenue Chart Placeholder */}
        <Card className="lg:col-span-2" title="Revenue — Last 7 Days">
          <div className="p-4">
            <div className="flex items-end gap-2 h-[120px]">
              {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day, i) => {
                const heights = [60, 45, 75, 55, 90, 70, 85];
                return (
                  <div key={day} className="flex-1 flex flex-col items-center gap-1">
                    <div
                      className="w-full rounded-t bg-brand/20 hover:bg-brand/40 transition-colors"
                      style={{ height: `${heights[i]}%` }}
                    />
                    <span className="text-[8px] font-semibold text-muted-fg">{day}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        {/* Zone Summary */}
        <Card title="Zone Summary">
          <div className="p-4 space-y-3">
            {(windowData?.windows ?? []).map((w: any) => (
              <div key={w.zoneId} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="text-sm">{w.zoneSlug === "haveri" ? "🏛️" : w.zoneSlug === "ranebennur" ? "🌎" : w.zoneSlug === "savanur" ? "🏘️" : w.zoneSlug === "byadgi" ? "🌿" : w.zoneSlug === "hirekerur" ? "🏡" : "🌿"}</span>
                  <div>
                    <div className="text-[11px] font-bold text-fg">{w.zoneName}</div>
                    <div className="text-[9px] text-muted-fg">{w.openTime}–{w.closeTime}</div>
                  </div>
                </div>
                <Badge variant={w.state === "open" ? "active" : w.state === "warning" ? "pending" : "inactive"}>
                  {w.state === "open" ? "🟢 Open" : w.state === "warning" ? "🟡 Warning" : "⏱ Closed"}
                </Badge>
              </div>
            ))}
          </div>
        </Card>
      </div>

      {/* Recent Indents Table */}
      <TableCard
        header={
          <>
            <span className="font-display text-xs font-bold text-fg">Recent Indents</span>
            <Link href="/orders">
              <Button variant="outline" size="sm">View All</Button>
            </Link>
          </>
        }
      >
        <thead>
          <tr>
            <Th>Order ID</Th>
            <Th>Dealer</Th>
            <Th>Zone</Th>
            <Th className="text-right">Amount</Th>
            <Th>Status</Th>
            <Th>Payment</Th>
          </tr>
        </thead>
        <tbody>
          {orders.map((order: any) => (
            <tr key={order.id} className="hover:bg-muted/50 transition-colors">
              <Td className="font-display text-[10px] font-bold">{order.id.slice(0, 8)}</Td>
              <Td className="font-semibold">{order.dealer_name}</Td>
              <Td>{order.zone_name}</Td>
              <Td className="text-right font-bold text-brand">{formatCurrency(order.grand_total)}</Td>
              <Td><Badge variant={order.status}>{order.status}</Badge></Td>
              <Td><Badge variant={order.payment_mode === "wallet" ? "active" : "pending"}>{order.payment_mode}</Badge></Td>
            </tr>
          ))}
          {orders.length === 0 && (
            <tr><Td className="text-center py-8 text-muted-fg" colSpan={6}>No orders yet</Td></tr>
          )}
        </tbody>
      </TableCard>

      {/* Quick Actions */}
      <Card title="Quick Actions" className="mt-6">
        <div className="p-4 grid grid-cols-2 md:grid-cols-4 gap-3">
          {[
            { icon: "📝", title: "Create Indent", sub: "Via Call Desk", href: "/orders/new" },
            { icon: "📦", title: "Update FGS", sub: "Daily stock entry", href: "/inventory/update" },
            { icon: "🚛", title: "Dispatch Sheet", sub: "Today's routes", href: "/distribution/dispatch" },
            { icon: "💰", title: "Dealer Wallet", sub: "Top-up / deduct", href: "/dealers" },
          ].map((action) => (
            <Link
              key={action.title}
              href={action.href}
              className="flex items-center gap-3 p-3 rounded-lg border border-border hover:border-brand/30 hover:bg-brand-light transition-all cursor-pointer"
            >
              <span className="text-2xl">{action.icon}</span>
              <div>
                <div className="text-xs font-semibold text-fg">{action.title}</div>
                <div className="text-[10px] text-muted-fg">{action.sub}</div>
              </div>
            </Link>
          ))}
        </div>
      </Card>
    </>
  );
}
