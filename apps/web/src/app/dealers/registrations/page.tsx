"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, TableCard, Th, Td } from "@/components/ui";
import { Eye, Check, X } from "lucide-react";

export default function RegistrationsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["registrations"], queryFn: () => api.get("/api/v1/registrations") });
  const regs = data?.data ?? [];
  const pendingCount = regs.filter((r: any) => r.status === "pending").length;
  const [rejectNote, setRejectNote] = useState<Record<string, string>>({});

  const approveMut = useMutation({ mutationFn: (id: string) => api.patch(`/api/v1/registrations/${id}/approve`), onSuccess: () => qc.invalidateQueries({ queryKey: ["registrations"] }) });
  const rejectMut = useMutation({ mutationFn: ({ id, reviewNote }: { id: string; reviewNote: string }) => api.patch(`/api/v1/registrations/${id}/reject`, { reviewNote }), onSuccess: () => qc.invalidateQueries({ queryKey: ["registrations"] }) });

  return (
    <>
      <PageHeader icon="👤" title="Registrations" subtitle="New dealer registration requests"
        actions={pendingCount > 0 ? <Badge variant="pending" className="text-[11px] px-3 py-1">{pendingCount} Pending</Badge> : undefined} />
      <TableCard>
        <thead><tr><Th>Type</Th><Th>Status</Th><Th>Submitted Data</Th><Th>Date</Th><Th>Actions</Th></tr></thead>
        <tbody>{regs.map((r: any) => {
          let parsed: any = {}; try { parsed = JSON.parse(r.submittedData); } catch {}
          return (
            <tr key={r.id} className="hover:bg-muted/50">
              <Td className="font-semibold capitalize">{r.type.replace(/_/g, " ")}</Td>
              <Td><Badge variant={r.status}>{r.status}</Badge></Td>
              <Td className="text-[10px] text-muted-fg max-w-[300px] truncate">{parsed.name || ""} {parsed.phone || ""} {parsed.city || ""}</Td>
              <Td className="text-muted-fg">{new Date(r.createdAt).toLocaleDateString("en-IN")}</Td>
              <Td>{r.status === "pending" && <div className="flex gap-1">
                <button className="p-1.5 rounded-md border border-success/30 hover:bg-success/10" onClick={() => approveMut.mutate(r.id)} disabled={approveMut.isPending}><Check className="h-3.5 w-3.5 text-success" /></button>
                <input value={rejectNote[r.id] ?? ""} onChange={e => setRejectNote(p => ({...p, [r.id]: e.target.value}))} placeholder="Reason" className="h-8 bg-background border border-border rounded-lg px-2 text-[10px] w-28 outline-none" />
                <button className="p-1.5 rounded-md border border-danger/30 hover:bg-danger/10" disabled={rejectMut.isPending || !rejectNote[r.id]} onClick={() => rejectMut.mutate({ id: r.id, reviewNote: rejectNote[r.id]! })}><X className="h-3.5 w-3.5 text-danger" /></button>
              </div>}</Td>
            </tr>);
        })}{regs.length === 0 && <tr><td colSpan={5} className="text-center py-8 text-muted-fg text-[12px]">No registration requests</td></tr>}</tbody>
      </TableCard>
    </>
  );
}
