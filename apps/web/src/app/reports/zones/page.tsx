"use client";
import { PageHeader, Button } from "@/components/ui";
import { Download } from "lucide-react";
import { useState } from "react";
const ZONES = [
  { name: "Haveri", icon: "🏛️", dealers: 32, orders: 85, revenue: 185000, pct: 30, growth: 12 },
  { name: "Ranebennur", icon: "🌎", dealers: 24, orders: 62, revenue: 142000, pct: 23, growth: 8 },
  { name: "Savanur", icon: "🏘️", dealers: 18, orders: 40, revenue: 95000, pct: 15, growth: 3 },
  { name: "Byadgi", icon: "🌿", dealers: 15, orders: 35, revenue: 78000, pct: 13, growth: 5 },
  { name: "Hirekerur", icon: "🏡", dealers: 12, orders: 28, revenue: 65000, pct: 11, growth: 15 },
  { name: "Hangal", icon: "🌿", dealers: 10, orders: 22, revenue: 52000, pct: 8, growth: 10 },
];
export default function ZoneRevenuePage() {
  const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState("");
  return (
    <>
      <PageHeader icon="🌍" title="Zone-wise Revenue" subtitle="Revenue breakdown by delivery zones"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="flex items-center gap-2 mb-6"><span className="text-[11px] font-semibold text-muted-fg">Period:</span><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">{ZONES.map(z => (
        <div key={z.name} className="bg-card rounded-[10px] border border-border shadow-card p-4">
          <div className="flex items-center gap-2 mb-1"><span className="text-lg">{z.icon}</span><div><div className="text-[13px] font-bold text-fg">{z.name}</div><div className="text-[10px] text-muted-fg">{z.dealers} dealers · {z.orders} orders</div></div></div>
          <div className="font-display text-[22px] font-black text-fg mt-2">₹{(z.revenue/1000).toFixed(0)}K</div>
          <div className="flex items-center gap-2 mt-2"><div className="flex-1 h-2 bg-muted rounded-full overflow-hidden"><div className="h-full bg-brand rounded-full" style={{width:`${z.pct}%`}} /></div><span className="text-[10px] font-bold text-muted-fg">{z.pct}%</span></div>
          <div className="text-[10px] font-semibold text-success mt-1.5">↑ {z.growth}% vs last month</div>
        </div>
      ))}</div>
    </>
  );
}
