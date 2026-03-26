"use client";
import { PageHeader, StatCard, Card, TableCard, Th, Td, Badge } from "@/components/ui";
import { formatCurrency } from "@/lib/utils";
import { useState } from "react";

const ZONE_REV = [{ name: "Haveri", rev: 180 }, { name: "Ranebennur", rev: 130 }, { name: "Savanur", rev: 82 }, { name: "Byadgi", rev: 54 }, { name: "Hirekerur", rev: 46 }, { name: "Hangal", rev: 32 }];
const TOP_DEALERS = [
  { name: "Raju Agencies", loc: "Haveri", orders: 28, revenue: 72000, avg: 2571, trend: "up" },
  { name: "Krishna Stores", loc: "Ranebennur", orders: 24, revenue: 58000, avg: 2417, trend: "up" },
  { name: "Laxmi Traders", loc: "Savanur", orders: 20, revenue: 45000, avg: 2250, trend: "down" },
  { name: "Ganesh Dairy", loc: "Byadgi", orders: 18, revenue: 42000, avg: 2333, trend: "up" },
  { name: "Mahalakshmi Agency", loc: "Hirekerur", orders: 15, revenue: 35000, avg: 2333, trend: "down" },
];
const maxRev = Math.max(...ZONE_REV.map(z => z.rev));
const COLORS = ["#1448CC", "#D97706", "#16A34A", "#DC2626", "#9333EA", "#0891B2"];

export default function SalesReportPage() {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  return (
    <>
      <PageHeader icon="📊" title="Sales Report" subtitle="Revenue and order trends · January 2025" />
      <div className="flex items-center gap-2 mb-6"><span className="text-[11px] font-semibold text-muted-fg">Period:</span><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6">
        <StatCard icon="₹" iconBg="bg-success/10 text-success" value="₹4.8L" label="Total Revenue (Jan)" delta="+14% vs Dec" deltaUp />
        <StatCard icon="📋" iconBg="bg-brand-light text-brand" value="412" label="Total Orders" delta="+8%" deltaUp />
        <StatCard icon="💰" iconBg="bg-info/10 text-info" value="₹1,165" label="Avg Order Value" delta="+5%" deltaUp />
        <StatCard icon="👥" iconBg="bg-warning/10 text-warning" value="128" label="Active Dealers" delta="+3" deltaUp />
      </div>
      <Card title="Revenue by Zone (January 2025)" className="mb-6"><div className="p-5">
        <div className="flex items-end gap-4 h-[160px]">{ZONE_REV.map((z, i) => (
          <div key={z.name} className="flex-1 flex flex-col items-center gap-1.5">
            <span className="text-[9px] font-bold" style={{ color: COLORS[i] }}>₹{z.rev}K</span>
            <div className="w-full rounded-t transition-all hover:opacity-80" style={{ height: `${(z.rev / maxRev) * 100}%`, background: COLORS[i], opacity: 0.8 }} />
            <span className="text-[9px] font-bold text-muted-fg">{z.name}</span>
          </div>
        ))}</div>
      </div></Card>
      <TableCard header={<span className="font-display text-xs font-bold text-fg">Dealer-wise Revenue</span>}>
        <thead><tr><Th>Dealer</Th><Th>Location</Th><Th className="text-right">Orders</Th><Th className="text-right">Revenue</Th><Th className="text-right">Avg Order</Th><Th>Trend</Th></tr></thead>
        <tbody>{TOP_DEALERS.map(d => (
          <tr key={d.name} className="hover:bg-muted/50"><Td className="font-semibold">{d.name}</Td><Td>{d.loc}</Td><Td className="text-right">{d.orders}</Td><Td className="text-right font-bold text-brand">₹{(d.revenue/1000).toFixed(0)}K</Td><Td className="text-right text-muted-fg">{formatCurrency(d.avg)}</Td><Td><Badge variant={d.trend==="up"?"active":"cancelled"}>{d.trend==="up"?"↗ Up":"↘ Down"}</Badge></Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
