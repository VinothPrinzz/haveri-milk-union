"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Button, StatCard, TableCard, Th, Td, EmptyState } from "@/components/ui";
import { Printer, Download } from "lucide-react";

export default function DailyDispatchPage() {
  const today = new Date().toISOString().split("T")[0];

  const { data, isLoading } = useQuery({
    queryKey: ["dispatch-daily", today],
    queryFn: () => api.get("/api/v1/dispatch/daily", { date: today }),
  });

  const assignments = data?.assignments ?? [];
  const dispatched = assignments.filter((a: any) => a.status === "dispatched").length;
  const loading_ = assignments.filter((a: any) => a.status === "loading").length;
  const pending = assignments.filter((a: any) => a.status === "pending").length;

  return (
    <>
      <PageHeader
        icon="📋"
        title="Daily Dispatch Sheet"
        subtitle="Today's dispatch assignments and status"
        actions={
          <div className="flex gap-2">
            <Button variant="outline" size="sm"><Printer className="h-3.5 w-3.5" /> Print</Button>
            <Button size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>
          </div>
        }
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border-2 border-success/20 shadow-card p-4 text-center" style={{ background: "rgba(22,163,74,0.05)" }}>
          <div className="font-display text-[28px] font-black text-success">{dispatched}</div>
          <div className="text-[11px] font-semibold text-muted-fg">Dispatched</div>
        </div>
        <div className="bg-card rounded-[10px] border-2 border-warning/20 shadow-card p-4 text-center" style={{ background: "rgba(217,119,6,0.05)" }}>
          <div className="font-display text-[28px] font-black text-warning">{loading_}</div>
          <div className="text-[11px] font-semibold text-muted-fg">Loading</div>
        </div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center">
          <div className="font-display text-[28px] font-black text-muted-fg">{pending}</div>
          <div className="text-[11px] font-semibold text-muted-fg">Pending</div>
        </div>
      </div>

      {/* Dispatch Table */}
      <TableCard>
        <thead>
          <tr>
            <Th>Route</Th>
            <Th>Zone</Th>
            <Th className="text-right">Dealers</Th>
            <Th className="text-right">Crates</Th>
            <Th>Driver</Th>
            <Th>Vehicle</Th>
            <Th>Dispatch Time</Th>
            <Th>Status</Th>
            <Th>Action</Th>
          </tr>
        </thead>
        <tbody>
          {assignments.map((a: any) => (
            <tr
              key={a.id}
              className={`hover:bg-muted/50 transition-colors ${a.status === "loading" ? "bg-warning/[0.03]" : ""}`}
            >
              <Td className="font-semibold">{a.route_name}</Td>
              <Td>{a.zone_name}</Td>
              <Td className="text-right">{a.dealer_count}</Td>
              <Td className="text-right">{a.item_count}</Td>
              <Td>{a.driver_name || "—"}</Td>
              <Td className="font-mono text-[10px]">{a.vehicle_number || "—"}</Td>
              <Td>
                {a.actual_departure_time ? (
                  <span className="text-success font-semibold">
                    {new Date(a.actual_departure_time).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true })}
                  </span>
                ) : (
                  <span className="text-muted-fg">—</span>
                )}
              </Td>
              <Td><Badge variant={a.status}>{a.status}</Badge></Td>
              <Td>
                {a.status !== "dispatched" && (
                  <Button size="sm" className="text-[10px]">
                    ✓ Dispatch
                  </Button>
                )}
              </Td>
            </tr>
          ))}
          {!isLoading && assignments.length === 0 && (
            <tr><td colSpan={9}><EmptyState message="No dispatch assignments for today. Create route assignments first." /></td></tr>
          )}
        </tbody>
      </TableCard>
    </>
  );
}
