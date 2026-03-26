"use client";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Pencil } from "lucide-react";
const ASSIGNMENTS = [
  { route: "Haveri Central", time: "5:30 AM", vehicle: "KA-25-AB-1234", driver: "Ramesh K.", dealers: 12, items: 45 },
  { route: "Haveri East", time: "5:45 AM", vehicle: "KA-25-XY-4321", driver: "Kumar S.", dealers: 8, items: 32 },
  { route: "Ranebennur Main", time: "5:00 AM", vehicle: "KA-25-CD-5678", driver: "Suresh M.", dealers: 15, items: 60 },
  { route: "Savanur Route A", time: "5:15 AM", vehicle: "KA-25-EF-9012", driver: "Manjunath R.", dealers: 10, items: 38 },
  { route: "Byadgi Circle", time: "6:00 AM", vehicle: "KA-25-GH-3456", driver: "Prasad B.", dealers: 6, items: 20 },
  { route: "Hirekerur Town", time: "5:30 AM", vehicle: "KA-25-IJ-7890", driver: "Mahesh H.", dealers: 9, items: 28 },
];
export default function AssignmentsPage() {
  return (
    <>
      <PageHeader icon="🔀" title="Route Assignments" subtitle="Assign dealers and products to delivery routes"
        actions={<Button size="sm">Reassign Routes</Button>} />
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {ASSIGNMENTS.map((a, i) => (
          <div key={i} className="bg-card rounded-[10px] border border-border shadow-card p-4">
            <div className="flex items-start justify-between mb-2">
              <div><div className="text-[13px] font-bold text-fg">{a.route}</div><div className="text-[10px] text-muted-fg">Departure: {a.time}</div></div>
              <button className="p-1.5 rounded-md border border-border hover:bg-muted"><Pencil className="h-3.5 w-3.5 text-muted-fg" /></button>
            </div>
            <div className="flex gap-4 text-[10px] text-muted-fg font-medium">
              <span>🚛 {a.vehicle}</span><span>👥 {a.dealers} dealers</span><span>📦 {a.items} items</span>
            </div>
            <div className="text-[10px] text-muted-fg mt-2">Driver: {a.driver}</div>
          </div>
        ))}
      </div>
    </>
  );
}
