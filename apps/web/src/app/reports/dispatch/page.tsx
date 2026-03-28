"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, TableCard, Th, Td, Button } from "@/components/ui";
import { Download } from "lucide-react";
import { exportCSV } from "@/lib/export";
export default function DispatchReportPage() {
  const { data } = useQuery({ queryKey: ["report-dispatch"], queryFn: () => api.get("/api/v1/reports/dispatch") });
  const routes = data?.data ?? [];
  const totalTrips = routes.reduce((a: number,r: any) => a+(r.trips||0), 0);
  const totalCompleted = routes.reduce((a: number,r: any) => a+(r.completed||0), 0);
  const avgEff = totalTrips>0?Math.round((totalCompleted/totalTrips)*100):0;
  const handleExport = () => exportCSV(routes.map((r: any) => ({ Route: r.route_name, Trips: r.trips, Completed: r.completed, AvgDealers: r.avg_dealers, TotalCrates: r.total_crates, Efficiency: totalTrips>0?Math.round((r.completed/r.trips)*100)+"%":"—" })), "dispatch_report");
  return (
    <>
      <PageHeader icon="🚛" title="Route & Dispatch Report" subtitle="Delivery performance and route analytics"
        actions={<Button variant="outline" size="sm" onClick={handleExport}><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-[22px] font-black text-fg">{totalTrips}</div><div className="text-[11px] font-semibold text-muted-fg">Total Trips</div></div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-[22px] font-black text-success">{totalCompleted}</div><div className="text-[11px] font-semibold text-muted-fg">Completed</div></div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-[22px] font-black text-brand">{avgEff}%</div><div className="text-[11px] font-semibold text-muted-fg">Efficiency</div></div>
      </div>
      <TableCard><thead><tr><Th>Route</Th><Th className="text-right">Trips</Th><Th className="text-right">Avg Dealers</Th><Th className="text-right">Total Crates</Th><Th>Efficiency</Th></tr></thead>
        <tbody>{routes.map((r: any) => { const eff=r.trips>0?Math.round((r.completed/r.trips)*100):0; return (<tr key={r.route_name} className="hover:bg-muted/50"><Td className="font-semibold">{r.route_name}</Td><Td className="text-right">{r.trips}</Td><Td className="text-right text-muted-fg">{r.avg_dealers}</Td><Td className="text-right">{r.total_crates}</Td><Td><div className="flex items-center gap-2"><div className="w-16 h-2 bg-muted rounded-full overflow-hidden"><div className="h-full rounded-full" style={{width:`${eff}%`,background:eff>=90?"#16A34A":eff>=80?"#D97706":"#DC2626"}} /></div><span className="text-[11px] font-bold">{eff}%</span></div></Td></tr>); })}</tbody>
      </TableCard>
    </>
  );
}
