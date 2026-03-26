"use client";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Pencil, Search, X } from "lucide-react";
import { useState } from "react";

const ASSIGNMENTS = [
  { route: "Haveri Central", time: "5:30 AM", vehicle: "KA-25-AB-1234", driver: "Ramesh K.", dealers: 12, items: 45, dealerList: ["Raju Agencies (15 items)", "Sri Lakshmi (8 items)", "Ganesh Milk (12 items)", "Venkatesh (10 items)"] },
  { route: "Haveri East", time: "5:45 AM", vehicle: "KA-25-XY-4321", driver: "Kumar S.", dealers: 8, items: 32, dealerList: ["Rajesh Agencies (10 items)", "Kumar Stores (8 items)", "Prasad Traders (14 items)"] },
  { route: "Ranebennur Main", time: "5:00 AM", vehicle: "KA-25-CD-5678", driver: "Suresh M.", dealers: 15, items: 60, dealerList: ["Krishna Stores (20 items)", "Lakshmi Traders (18 items)", "Ganesh Dairy (12 items)", "Mahalakshmi (10 items)"] },
  { route: "Savanur Route A", time: "5:15 AM", vehicle: "KA-25-EF-9012", driver: "Manjunath R.", dealers: 10, items: 38, dealerList: ["Savanur Agency (15 items)", "Patil Dairy (12 items)", "Shivakumar (11 items)"] },
  { route: "Byadgi Circle", time: "6:00 AM", vehicle: "KA-25-GH-3456", driver: "Prasad B.", dealers: 6, items: 20, dealerList: ["Byadgi Dairy (10 items)", "Mahadevi (10 items)"] },
  { route: "Hirekerur Town", time: "5:30 AM", vehicle: "KA-25-IJ-7890", driver: "Mahesh H.", dealers: 9, items: 28, dealerList: ["Ganesh Center (12 items)", "Hirekerur Co-op (16 items)"] },
];

export default function AssignmentsPage() {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<typeof ASSIGNMENTS[0] | null>(null);
  const filtered = search ? ASSIGNMENTS.filter(a => a.route.toLowerCase().includes(search.toLowerCase())) : ASSIGNMENTS;

  return (
    <>
      <PageHeader icon="🔀" title="Route Assignments" subtitle="Assign dealers and products to delivery routes"
        actions={<Button size="sm">Reassign Routes</Button>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md"><Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search routes..." className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((a, i) => (
          <div key={i} className="bg-card rounded-[10px] border border-border shadow-card p-4 cursor-pointer hover:border-brand/30 transition-all" onClick={() => setSelected(a)}>
            <div className="flex items-start justify-between mb-2"><div><div className="text-[13px] font-bold text-fg">{a.route}</div><div className="text-[10px] text-muted-fg">Departure: {a.time}</div></div><button className="p-1.5 rounded-md border border-border hover:bg-muted" onClick={e => e.stopPropagation()}><Pencil className="h-3.5 w-3.5 text-muted-fg" /></button></div>
            <div className="flex gap-4 text-[10px] text-muted-fg font-medium"><span>🚛 {a.vehicle}</span><span>👥 {a.dealers} dealers</span><span>📦 {a.items} items</span></div>
            <div className="text-[10px] text-muted-fg mt-2">Driver: {a.driver}</div>
            <div className="mt-2 pt-2 border-t border-border"><span className="text-[10px] text-brand font-semibold cursor-pointer hover:underline">View Details →</span></div>
          </div>
        ))}
      </div>

      {selected && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSelected(null)}>
          <div className="bg-card rounded-xl border border-border shadow-lg w-full max-w-md" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div><div className="font-display text-sm font-bold text-fg">{selected.route}</div><div className="text-[10px] text-muted-fg">{selected.vehicle} · {selected.driver} · {selected.time}</div></div>
              <button onClick={() => setSelected(null)} className="p-1.5 rounded-md border border-border hover:bg-muted"><X className="h-4 w-4 text-muted-fg" /></button>
            </div>
            <div className="p-4"><div className="text-[11px] font-bold text-fg mb-2">Dealers & Items ({selected.dealers} dealers, {selected.items} items)</div>
              <div className="space-y-1.5">{selected.dealerList.map((d, i) => (
                <div key={i} className="flex items-center gap-2 p-2 rounded-lg border border-border text-[11px]"><span className="w-5 h-5 rounded-full bg-brand-light flex items-center justify-center text-[9px] font-bold text-brand">{i+1}</span><span className="font-medium text-fg">{d}</span></div>
              ))}</div>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
