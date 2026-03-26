"use client";
import { PageHeader, StatCard, TableCard, Th, Td, Button } from "@/components/ui";
import { Download } from "lucide-react";
const DATA = [
  { route: "Haveri Central", trips: 25, avg: "42 min", dealers: 12, crates: 450, eff: 92 },
  { route: "Ranebennur Main", trips: 25, avg: "55 min", dealers: 15, crates: 520, eff: 80 },
  { route: "Savanur Route A", trips: 24, avg: "35 min", dealers: 10, crates: 380, eff: 92 },
  { route: "Haveri East", trips: 25, avg: "38 min", dealers: 8, crates: 320, eff: 96 },
  { route: "Byadgi Circle", trips: 22, avg: "48 min", dealers: 6, crates: 200, eff: 82 },
  { route: "Hirekerur Town", trips: 24, avg: "45 min", dealers: 9, crates: 280, eff: 88 },
];
export default function DispatchReportPage() {
  return (
    <>
      <PageHeader icon="🚛" title="Route & Dispatch Report" subtitle="Delivery performance and route analytics"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-[22px] font-black text-fg">145</div><div className="text-[11px] font-semibold text-muted-fg">Total Trips</div></div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-[22px] font-black text-fg">44 min</div><div className="text-[11px] font-semibold text-muted-fg">Avg Duration</div></div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-[22px] font-black text-brand">88%</div><div className="text-[11px] font-semibold text-muted-fg">Efficiency</div></div>
      </div>
      <TableCard header={<span className="font-display text-xs font-bold text-fg">Route Performance</span>}>
        <thead><tr><Th>Route</Th><Th className="text-right">Trips</Th><Th className="text-right">Avg Time</Th><Th className="text-right">Dealers</Th><Th className="text-right">Crates</Th><Th>Efficiency</Th></tr></thead>
        <tbody>{DATA.map(d => (
          <tr key={d.route} className="hover:bg-muted/50"><Td className="font-semibold">{d.route}</Td><Td className="text-right">{d.trips}</Td><Td className="text-right text-muted-fg">{d.avg}</Td><Td className="text-right">{d.dealers}</Td><Td className="text-right">{d.crates}</Td>
            <Td><div className="flex items-center gap-2"><div className="w-16 h-2 bg-muted rounded-full overflow-hidden"><div className="h-full rounded-full" style={{width:`${d.eff}%`,background:d.eff>=90?"#16A34A":d.eff>=80?"#D97706":"#DC2626"}} /></div><span className="text-[11px] font-bold">{d.eff}%</span></div></Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
