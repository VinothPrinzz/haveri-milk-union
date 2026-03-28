"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, Button } from "@/components/ui";
import { Download } from "lucide-react";
import { exportCSV } from "@/lib/export";
export default function ZoneRevenuePage() {
  const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState("");
  const { data } = useQuery({ queryKey: ["report-zones", dateFrom, dateTo], queryFn: () => api.get("/api/v1/reports/zone-revenue", { dateFrom: dateFrom||undefined, dateTo: dateTo||undefined }) });
  const zones = data?.data ?? [];
  const handleExport = () => exportCSV(zones.map((z: any) => ({ Zone: z.name, Dealers: z.dealer_count, Orders: z.order_count, Revenue: z.revenue, Percentage: z.percentage+"%" })), "zone_revenue");
  return (
    <>
      <PageHeader icon="🌍" title="Zone-wise Revenue" subtitle="Revenue breakdown by delivery zones"
        actions={<Button variant="outline" size="sm" onClick={handleExport}><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="flex items-center gap-2 mb-6"><span className="text-[11px] font-semibold text-muted-fg">Period:</span><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">{zones.map((z: any) => (
        <div key={z.slug} className="bg-card rounded-[10px] border border-border shadow-card p-4">
          <div className="flex items-center gap-2 mb-1"><span className="text-lg">{z.icon||"📍"}</span><div><div className="text-[13px] font-bold text-fg">{z.name}</div><div className="text-[10px] text-muted-fg">{z.dealer_count} dealers · {z.order_count} orders</div></div></div>
          <div className="font-display text-[22px] font-black text-fg mt-2">{formatCurrency(z.revenue)}</div>
          <div className="flex items-center gap-2 mt-2"><div className="flex-1 h-2 bg-muted rounded-full overflow-hidden"><div className="h-full bg-brand rounded-full" style={{width:`${z.percentage}%`}} /></div><span className="text-[10px] font-bold text-muted-fg">{z.percentage}%</span></div>
        </div>
      ))}</div>
    </>
  );
}
