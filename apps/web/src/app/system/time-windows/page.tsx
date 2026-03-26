"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Pencil } from "lucide-react";

export default function TimeWindowsPage() {
  const { data } = useQuery({ queryKey: ["window-status"], queryFn: () => api.get("/api/v1/window/status") });
  const windows = data?.windows ?? [];
  return (
    <>
      <PageHeader icon="⏰" title="Time Windows" subtitle="Configure indent ordering windows for each zone"
        actions={<Button variant="outline" size="sm"><Pencil className="h-3.5 w-3.5" /> Edit Windows</Button>} />
      <div className="space-y-3">
        {windows.map((w: any) => (
          <div key={w.zoneId} className="bg-card rounded-[10px] border border-border shadow-card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2"><span className="text-base">⏱</span><span className="text-[12px] font-semibold text-fg">{w.zoneName} Zone</span></div>
              <Badge variant={w.active ? "active" : "inactive"}>{w.active ? "active" : "inactive"}</Badge>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-lg" style={{background:"rgba(22,163,74,.1)"}}>
                <div className="text-[10px] text-muted-fg font-semibold">Opens</div>
                <div className="font-display text-[13px] font-bold text-success mt-1">{w.openTime}</div>
              </div>
              <div className="p-3 rounded-lg" style={{background:"rgba(217,119,6,.1)"}}>
                <div className="text-[10px] text-muted-fg font-semibold">Warning</div>
                <div className="font-display text-[13px] font-bold text-warning mt-1">{w.warningMinutes} min before</div>
              </div>
              <div className="p-3 rounded-lg" style={{background:"rgba(220,38,38,.1)"}}>
                <div className="text-[10px] text-muted-fg font-semibold">Closes</div>
                <div className="font-display text-[13px] font-bold text-danger mt-1">{w.closeTime}</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
