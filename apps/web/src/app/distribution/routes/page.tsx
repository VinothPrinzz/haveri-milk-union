"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Plus, Pencil, Truck, Search, X, MapPin } from "lucide-react";
import { useState } from "react";

const MOCK_STOPS: Record<string, string[]> = {
  "Haveri Central": ["Raju Agencies", "Sri Lakshmi Stores", "Ganesh Milk Point", "Venkatesh Dairy", "Basavaraj Agencies", "Mahadevi Enterprises", "Shivakumar Store", "Krishna Dairy", "Laxmi Traders", "Saraswati Dairy", "Patel Milk Center", "Haveri Co-op"],
  "Haveri East": ["Rajesh Agencies", "Kumar Stores", "Manjunath Dairy", "Prasad Traders", "Suresh Milk", "Ganesh Point", "Haveri East Co-op", "Patil Dairy"],
  "Ranebennur Main": ["Krishna Stores", "Lakshmi Traders", "Ganesh Dairy", "Mahalakshmi Agency"],
};

export default function RoutesMasterPage() {
  const [search, setSearch] = useState("");
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ["routes"], queryFn: () => api.get("/api/v1/routes") });
  let routes = data?.routes ?? [];
  if (search) routes = routes.filter((r: any) => r.name.toLowerCase().includes(search.toLowerCase()) || r.code.toLowerCase().includes(search.toLowerCase()));

  return (
    <>
      <PageHeader icon="📍" title="Route Master" subtitle="Define and manage delivery routes across all zones"
        actions={<Button size="sm"><Plus className="h-3.5 w-3.5" /> Add Route</Button>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md"><Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search routes..." className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div></div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {routes.map((r: any) => (
          <div key={r.id} className={`bg-card rounded-[10px] border border-border shadow-card p-4 cursor-pointer hover:border-brand/30 transition-all ${!r.active?"opacity-60":""}`} onClick={() => setSelectedRoute(r.name)}>
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5"><div className="w-10 h-10 rounded-lg bg-brand-light flex items-center justify-center"><Truck className="h-4 w-4 text-brand" /></div><div><div className="text-[13px] font-bold text-fg">{r.name}</div><div className="text-[10px] text-muted-fg font-medium">{r.code}</div></div></div>
              <Badge variant={r.active?"active":"inactive"}>{r.active?"active":"inactive"}</Badge>
            </div>
            <div className="flex items-center gap-3 text-[10px] text-muted-fg font-medium mb-3"><span>{r.zone_icon} {r.zone_name}</span><span>{r.stops} stops</span><span>{r.distance_km} km</span></div>
            <div className="pt-3 border-t border-border flex justify-between items-center">
              <span className="text-[10px] text-brand font-semibold cursor-pointer hover:underline">View Stops →</span>
              <button className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-fg hover:text-fg" onClick={e => e.stopPropagation()}><Pencil className="h-3 w-3" /> Edit</button>
            </div>
          </div>
        ))}
      </div>

      {/* Stops Modal */}
      {selectedRoute && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setSelectedRoute(null)}>
          <div className="bg-card rounded-xl border border-border shadow-lg w-full max-w-md max-h-[70vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-4 border-b border-border">
              <div><div className="font-display text-sm font-bold text-fg">{selectedRoute}</div><div className="text-[10px] text-muted-fg">{(MOCK_STOPS[selectedRoute] ?? []).length} stops</div></div>
              <button onClick={() => setSelectedRoute(null)} className="p-1.5 rounded-md border border-border hover:bg-muted"><X className="h-4 w-4 text-muted-fg" /></button>
            </div>
            <div className="p-4 space-y-2">{(MOCK_STOPS[selectedRoute] ?? ["No stops configured"]).map((stop, i) => (
              <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg border border-border"><div className="w-6 h-6 rounded-full bg-brand-light flex items-center justify-center text-[10px] font-bold text-brand">{i+1}</div><div className="flex items-center gap-2"><MapPin className="h-3.5 w-3.5 text-muted-fg" /><span className="text-[11px] font-semibold text-fg">{stop}</span></div></div>
            ))}</div>
          </div>
        </div>
      )}
    </>
  );
}
