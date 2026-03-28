"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, StatCard, Card, TableCard, Th, Td } from "@/components/ui";
import { exportCSV } from "@/lib/export";
const COLORS = ["#1448CC","#D97706","#16A34A","#DC2626","#9333EA","#0891B2"];
export default function SalesReportPage() {
  const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState("");
  const { data } = useQuery({ queryKey: ["report-sales", dateFrom, dateTo], queryFn: () => api.get("/api/v1/reports/sales", { dateFrom: dateFrom||undefined, dateTo: dateTo||undefined }) });
  const s = data?.summary ?? {}; const zones = data?.zoneRevenue ?? []; const dealers = data?.topDealers ?? [];
  const maxRev = Math.max(...zones.map((z: any) => parseFloat(z.revenue) || 0), 1);
  return (
    <>
      <PageHeader icon="📊" title="Sales Report" subtitle="Revenue and order trends" />
      <div className="flex items-center gap-2 mb-6"><span className="text-[11px] font-semibold text-muted-fg">Period:</span><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6"><StatCard icon="₹" iconBg="bg-success/10 text-success" value={formatCurrency(s.total_revenue||0)} label="Total Revenue" /><StatCard icon="📋" iconBg="bg-brand-light text-brand" value={s.total_orders??0} label="Total Orders" /><StatCard icon="💰" iconBg="bg-info/10 text-info" value={formatCurrency(s.avg_order_value||0)} label="Avg Order Value" /><StatCard icon="👥" iconBg="bg-warning/10 text-warning" value={s.activeDealers??0} label="Active Dealers" /></div>
      {zones.length>0&&<Card title="Revenue by Zone" className="mb-6"><div className="p-5"><div className="flex items-end gap-4 h-[160px]">{zones.map((z: any,i: number) => { const rev=parseFloat(z.revenue)||0; return (<div key={z.zone_name} className="flex-1 flex flex-col items-center gap-1.5"><span className="text-[9px] font-bold" style={{color:COLORS[i%6]}}>{formatCurrency(rev)}</span><div className="w-full rounded-t hover:opacity-80" style={{height:`${(rev/maxRev)*100}%`,background:COLORS[i%6],opacity:.8,minHeight:"4px"}} /><span className="text-[9px] font-bold text-muted-fg">{z.zone_name}</span></div>); })}</div></div></Card>}
      <TableCard header={<span className="font-display text-xs font-bold text-fg">Top Dealers</span>}>
        <thead><tr><Th>Dealer</Th><Th>Zone</Th><Th className="text-right">Orders</Th><Th className="text-right">Revenue</Th><Th className="text-right">Avg Order</Th></tr></thead>
        <tbody>{dealers.map((d: any) => (<tr key={d.name} className="hover:bg-muted/50"><Td className="font-semibold">{d.name}</Td><Td>{d.zone_name}</Td><Td className="text-right">{d.orders}</Td><Td className="text-right font-bold text-brand">{formatCurrency(d.revenue)}</Td><Td className="text-right text-muted-fg">{formatCurrency(d.avg_order)}</Td></tr>))}</tbody>
      </TableCard>
    </>
  );
}
