"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Modal, FormField, FormInput } from "@/components/ui/modal";
import { Pencil } from "lucide-react";

export default function TimeWindowsPage() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["window-status"], queryFn: () => api.get("/api/v1/window/status") });
  const windows = data?.windows ?? [];
  const [editWin, setEditWin] = useState<any>(null);
  const [editForm, setEditForm] = useState({ openTime: "", closeTime: "", warningMinutes: "" });

  const openEdit = (w: any) => { setEditForm({ openTime: w.openTime||"", closeTime: w.closeTime||"", warningMinutes: String(w.warningMinutes||30) }); setEditWin(w); };

  // Note: would need a PUT /api/v1/window/:zoneId endpoint — for now shows the modal pattern
  const saveMut = useMutation({ mutationFn: async () => { /* TODO: wire to API when endpoint is built */ return Promise.resolve(); }, onSuccess: () => { qc.invalidateQueries({ queryKey: ["window-status"] }); setEditWin(null); } });

  return (
    <>
      <PageHeader icon="⏰" title="Time Windows" subtitle="Configure indent ordering windows for each zone" />
      <div className="space-y-3">
        {windows.map((w: any) => (
          <div key={w.zoneId} className="bg-card rounded-[10px] border border-border shadow-card p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2"><span className="text-base">⏱</span><span className="text-[12px] font-semibold text-fg">{w.zoneName} Zone</span></div>
              <div className="flex items-center gap-2"><Badge variant={w.active?"active":"inactive"}>{w.active?"active":"inactive"}</Badge>
                <button className="p-1.5 rounded-md border border-border hover:bg-muted" onClick={() => openEdit(w)}><Pencil className="h-3.5 w-3.5 text-muted-fg" /></button>
              </div>
            </div>
            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 rounded-lg" style={{background:"rgba(22,163,74,.1)"}}><div className="text-[10px] text-muted-fg font-semibold">Opens</div><div className="font-display text-[13px] font-bold text-success mt-1">{w.openTime}</div></div>
              <div className="p-3 rounded-lg" style={{background:"rgba(217,119,6,.1)"}}><div className="text-[10px] text-muted-fg font-semibold">Warning</div><div className="font-display text-[13px] font-bold text-warning mt-1">{w.warningMinutes} min before</div></div>
              <div className="p-3 rounded-lg" style={{background:"rgba(220,38,38,.1)"}}><div className="text-[10px] text-muted-fg font-semibold">Closes</div><div className="font-display text-[13px] font-bold text-danger mt-1">{w.closeTime}</div></div>
            </div>
          </div>
        ))}
      </div>
      <Modal open={!!editWin} onClose={() => setEditWin(null)} title={`Edit — ${editWin?.zoneName} Zone`}>
        <div className="space-y-3">
          <FormField label="Open Time"><FormInput type="time" value={editForm.openTime} onChange={e => setEditForm(f => ({...f, openTime: e.target.value}))} /></FormField>
          <FormField label="Close Time"><FormInput type="time" value={editForm.closeTime} onChange={e => setEditForm(f => ({...f, closeTime: e.target.value}))} /></FormField>
          <FormField label="Warning Minutes Before Close"><FormInput type="number" value={editForm.warningMinutes} onChange={e => setEditForm(f => ({...f, warningMinutes: e.target.value}))} /></FormField>
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setEditWin(null)}>Cancel</Button>
            <Button size="sm" disabled={saveMut.isPending} onClick={() => saveMut.mutate()}>{saveMut.isPending?"Saving...":"Save Changes"}</Button></div>
        </div>
      </Modal>
    </>
  );
}
