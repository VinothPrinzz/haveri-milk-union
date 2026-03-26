"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Plus } from "lucide-react";

export default function ZoneConfigPage() {
  const { data } = useQuery({ queryKey: ["window-status"], queryFn: () => api.get("/api/v1/window/status") });
  const windows = data?.windows ?? [];
  const zoneIcons: Record<string, string> = { haveri: "🏛️", ranebennur: "🌎", savanur: "🏘️", byadgi: "🌿", hirekerur: "🏡", hangal: "🌿" };
  const zoneColors: Record<string, string> = { haveri: "#1448CC", ranebennur: "#D97706", savanur: "#16A34A", byadgi: "#DC2626", hirekerur: "#9333EA", hangal: "#0891B2" };
  return (
    <>
      <PageHeader icon="🌐" title="Zone Configuration" subtitle="Manage delivery zones and location settings"
        actions={<Button size="sm"><Plus className="h-3.5 w-3.5" /> Add Zone</Button>} />
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {windows.map((w: any) => {
          const color = zoneColors[w.zoneSlug] || "#1448CC";
          return (
            <div key={w.zoneId} className="bg-card rounded-[10px] border border-border shadow-card p-4">
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-2">
                  <span className="text-2xl">{zoneIcons[w.zoneSlug] || "📍"}</span>
                  <div><div className="text-[13px] font-semibold text-fg">{w.zoneName}</div><div className="text-[10px] text-muted-fg">ID: {w.zoneSlug}</div></div>
                </div>
                <Badge variant="active">Active</Badge>
              </div>
              <div className="flex items-center gap-1.5 mt-2.5">
                <div className="w-3 h-3 rounded-full" style={{background: color}} /><span className="text-[11px] text-muted-fg">{color}</span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}
