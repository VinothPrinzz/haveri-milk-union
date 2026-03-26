"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Button, TableCard, Th, Td } from "@/components/ui";
import { Plus, Pencil } from "lucide-react";

export default function VehicleMasterPage() {
  const { data } = useQuery({ queryKey: ["vehicles"], queryFn: () => api.get("/api/v1/vehicles") });
  const vehicles = data?.vehicles ?? [];
  return (
    <>
      <PageHeader icon="🚛" title="Vehicle Master" subtitle="Manage delivery vehicles and drivers"
        actions={<Button size="sm"><Plus className="h-3.5 w-3.5" /> Add Vehicle</Button>} />
      <TableCard>
        <thead><tr><Th>Vehicle No.</Th><Th>Type</Th><Th>Capacity</Th><Th>Driver</Th><Th>Phone</Th><Th>Status</Th><Th>Action</Th></tr></thead>
        <tbody>{vehicles.map((v: any) => (
          <tr key={v.id} className="hover:bg-muted/50">
            <Td className="font-mono text-[11px] font-bold">{v.number}</Td><Td className="capitalize">{v.type}</Td><Td>{v.capacity||"—"}</Td>
            <Td className="font-semibold">{v.driverName||"—"}</Td><Td className="text-muted-fg">{v.driverPhone||"—"}</Td>
            <Td><Badge variant={v.active ? "active" : "inactive"}>{v.active ? "Active" : "Inactive"}</Badge></Td>
            <Td><button className="p-1.5 rounded-md border border-border hover:bg-muted"><Pencil className="h-3.5 w-3.5 text-muted-fg" /></button></Td>
          </tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
