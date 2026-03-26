"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Plus, Pencil, Truck } from "lucide-react";

export default function RoutesMasterPage() {
  const { data } = useQuery({
    queryKey: ["routes"],
    queryFn: () => api.get("/api/v1/routes"),
  });

  const routes = data?.routes ?? [];

  return (
    <>
      <PageHeader
        icon="📍"
        title="Route Master"
        subtitle="Define and manage delivery routes across all zones"
        actions={<Button size="sm"><Plus className="h-3.5 w-3.5" /> Add Route</Button>}
      />

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {routes.map((r: any) => (
          <div
            key={r.id}
            className={`bg-card rounded-[10px] border border-border shadow-card p-4 ${!r.active ? "opacity-60" : ""}`}
          >
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-10 h-10 rounded-lg bg-brand-light flex items-center justify-center">
                  <Truck className="h-4 w-4 text-brand" />
                </div>
                <div>
                  <div className="text-[13px] font-bold text-fg">{r.name}</div>
                  <div className="text-[10px] text-muted-fg font-medium">{r.code}</div>
                </div>
              </div>
              <Badge variant={r.active ? "active" : "inactive"}>
                {r.active ? "active" : "inactive"}
              </Badge>
            </div>

            <div className="flex items-center gap-3 text-[10px] text-muted-fg font-medium mb-3">
              <span>{r.zone_icon} {r.zone_name}</span>
              <span>{r.stops} stops</span>
              <span>{r.distance_km} km</span>
            </div>

            <div className="pt-3 border-t border-border flex justify-end">
              <button className="flex items-center gap-1.5 text-[10px] font-semibold text-muted-fg hover:text-fg transition-colors">
                <Pencil className="h-3 w-3" /> Edit
              </button>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
