"use client";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Button, TableCard, Th, Td, EmptyState } from "@/components/ui";
import { Download } from "lucide-react";
import { exportCSV } from "@/lib/export";

export default function DailyDispatchPage() {
  const today = new Date().toISOString().split("T")[0];
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ["dispatch-daily", today], queryFn: () => api.get("/api/v1/dispatch/daily", { date: today }) });
  const assignments = data?.assignments ?? [];
  const dispatched = assignments.filter((a: any) => a.status === "dispatched").length;
  const loading_ = assignments.filter((a: any) => a.status === "loading").length;
  const pending = assignments.filter((a: any) => a.status === "pending").length;

  const dispatchMut = useMutation({ mutationFn: (id: string) => api.patch(`/api/v1/dispatch/${id}/status`, { status: "dispatched" }), onSuccess: () => qc.invalidateQueries({ queryKey: ["dispatch-daily"] }) });

  const handleExport = () => exportCSV(assignments.map((a: any) => ({ Route: a.route_name, Zone: a.zone_name, Dealers: a.dealer_count, Crates: a.item_count, Driver: a.driver_name || "", Vehicle: a.vehicle_number || "", Status: a.status })), "dispatch_sheet");

  return (
    <>
      <PageHeader icon="📋" title="Daily Dispatch Sheet" subtitle="Today's dispatch assignments and status"
        actions={<Button size="sm" onClick={handleExport}><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border-2 border-success/20 shadow-card p-4 text-center" style={{background:"rgba(22,163,74,.05)"}}><div className="font-display text-[28px] font-black text-success">{dispatched}</div><div className="text-[11px] font-semibold text-muted-fg">Dispatched</div></div>
        <div className="bg-card rounded-[10px] border-2 border-warning/20 shadow-card p-4 text-center" style={{background:"rgba(217,119,6,.05)"}}><div className="font-display text-[28px] font-black text-warning">{loading_}</div><div className="text-[11px] font-semibold text-muted-fg">Loading</div></div>
        <div className="bg-card rounded-[10px] border border-border shadow-card p-4 text-center"><div className="font-display text-[28px] font-black text-muted-fg">{pending}</div><div className="text-[11px] font-semibold text-muted-fg">Pending</div></div>
      </div>
      <TableCard>
        <thead><tr><Th>Route</Th><Th>Zone</Th><Th className="text-right">Dealers</Th><Th className="text-right">Crates</Th><Th>Driver</Th><Th>Vehicle</Th><Th>Dispatch Time</Th><Th>Status</Th><Th>Action</Th></tr></thead>
        <tbody>{assignments.map((a: any) => (
          <tr key={a.id} className={`hover:bg-muted/50 ${a.status==="loading"?"bg-warning/[0.03]":""}`}><Td className="font-semibold">{a.route_name}</Td><Td>{a.zone_name}</Td><Td className="text-right">{a.dealer_count}</Td><Td className="text-right">{a.item_count}</Td><Td>{a.driver_name||"—"}</Td><Td className="font-mono text-[10px]">{a.vehicle_number||"—"}</Td>
            <Td>{a.actual_departure_time?<span className="text-success font-semibold">{new Date(a.actual_departure_time).toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit",hour12:true})}</span>:<span className="text-muted-fg">—</span>}</Td>
            <Td><Badge variant={a.status}>{a.status}</Badge></Td><Td>{a.status!=="dispatched"&&<Button size="sm" className="text-[10px]" disabled={dispatchMut.isPending} onClick={() => dispatchMut.mutate(a.id)}>✓ Dispatch</Button>}</Td>
          </tr>))}{!isLoading&&assignments.length===0&&<tr><td colSpan={9}><EmptyState message="No dispatch assignments for today" /></td></tr>}</tbody>
      </TableCard>
    </>
  );
}
