"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Modal, FormField, FormInput, FormSelect } from "@/components/ui/modal";
import { Plus, Pencil, Truck, Search, MapPin, Trash2 } from "lucide-react";

type Stop = { name: string; distanceFromPrev: number };

function StopsEditor({ stops, onChange }: { stops: Stop[]; onChange: (s: Stop[]) => void }) {
  const addStop = () => onChange([...stops, { name: "", distanceFromPrev: 0 }]);
  const removeStop = (i: number) => onChange(stops.filter((_, idx) => idx !== i));
  const updateStop = (i: number, field: keyof Stop, val: any) => onChange(stops.map((s, idx) => idx === i ? { ...s, [field]: val } : s));
  const total = stops.reduce((s, st) => s + (st.distanceFromPrev || 0), 0);
  return (
    <div>
      <div className="flex items-center justify-between mb-2"><span className="text-[11px] font-semibold text-fg">Stops ({stops.length}) · Total: {total.toFixed(1)} km</span>
        <button type="button" onClick={addStop} className="text-[10px] font-semibold text-brand hover:underline">+ Add Stop</button></div>
      <div className="space-y-2 max-h-[300px] overflow-y-auto">{stops.map((s, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="w-5 h-5 rounded-full bg-brand-light flex items-center justify-center text-[9px] font-bold text-brand shrink-0">{i+1}</span>
          <FormInput value={s.name} onChange={e => updateStop(i, "name", e.target.value)} placeholder="Stop name" className="flex-1" />
          <FormInput type="number" min={0} step={0.1} value={s.distanceFromPrev} onChange={e => updateStop(i, "distanceFromPrev", parseFloat(e.target.value) || 0)} placeholder="km" className="w-20" />
          <span className="text-[9px] text-muted-fg">km</span>
          <button onClick={() => removeStop(i)} className="p-1 rounded border border-border hover:bg-danger/10"><Trash2 className="h-3 w-3 text-danger" /></button>
        </div>
      ))}</div>
    </div>
  );
}

export default function RoutesMasterPage() {
  const [search, setSearch] = useState(""); const [showAdd, setShowAdd] = useState(false); const [showEdit, setShowEdit] = useState<any>(null); const [viewRoute, setViewRoute] = useState<any>(null);
  const [addForm, setAddForm] = useState({ name: "", code: "", zoneId: "" }); const [addStops, setAddStops] = useState<Stop[]>([]);
  const [editForm, setEditForm] = useState({ name: "", code: "", active: true }); const [editStops, setEditStops] = useState<Stop[]>([]);
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["routes"], queryFn: () => api.get("/api/v1/routes") });
  const { data: windowData } = useQuery({ queryKey: ["window-status"], queryFn: () => api.get("/api/v1/window/status") });
  const zones = (windowData?.windows ?? []).map((w: any) => ({ id: w.zoneId, name: w.zoneName }));
  let routes = data?.routes ?? [];
  if (search) routes = routes.filter((r: any) => r.name.toLowerCase().includes(search.toLowerCase()));

  const addMut = useMutation({ mutationFn: (b: any) => api.post("/api/v1/routes", b), onSuccess: () => { qc.invalidateQueries({ queryKey: ["routes"] }); setShowAdd(false); setAddForm({ name: "", code: "", zoneId: "" }); setAddStops([]); } });
  const editMut = useMutation({ mutationFn: (b: any) => api.patch(`/api/v1/routes/${showEdit.id}`, b), onSuccess: () => { qc.invalidateQueries({ queryKey: ["routes"] }); setShowEdit(null); } });

  const openEdit = (r: any) => { setEditForm({ name: r.name, code: r.code || "", active: r.active }); setEditStops(r.stop_details || []); setShowEdit(r); };

  return (
    <>
      <PageHeader icon="📍" title="Route Master" subtitle="Define and manage delivery routes across all zones"
        actions={<Button size="sm" onClick={() => setShowAdd(true)}><Plus className="h-3.5 w-3.5" /> Add Route</Button>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md"><Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search routes..." className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div></div>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {routes.map((r: any) => (
          <div key={r.id} className={`bg-card rounded-[10px] border border-border shadow-card p-4 ${!r.active?"opacity-60":""}`}>
            <div className="flex items-start justify-between mb-3"><div className="flex items-center gap-2.5"><div className="w-10 h-10 rounded-lg bg-brand-light flex items-center justify-center"><Truck className="h-4 w-4 text-brand" /></div><div><div className="text-[13px] font-bold text-fg">{r.name}</div><div className="text-[10px] text-muted-fg">{r.code}</div></div></div><Badge variant={r.active?"active":"inactive"}>{r.active?"active":"inactive"}</Badge></div>
            <div className="flex items-center gap-3 text-[10px] text-muted-fg font-medium mb-3"><span>{r.zone_icon} {r.zone_name}</span><span>{r.stops} stops</span><span>{r.distance_km} km</span></div>
            <div className="pt-3 border-t border-border flex justify-between"><button onClick={() => setViewRoute(r)} className="text-[10px] text-brand font-semibold hover:underline">View Stops →</button><button onClick={() => openEdit(r)} className="flex items-center gap-1 text-[10px] font-semibold text-muted-fg hover:text-fg"><Pencil className="h-3 w-3" /> Edit</button></div>
          </div>
        ))}
      </div>

      {/* View Stops */}
      <Modal open={!!viewRoute} onClose={() => setViewRoute(null)} title={viewRoute?.name || ""}>
        <div className="space-y-2">
          <p className="text-[10px] text-muted-fg mb-3">{viewRoute?.stops} stops · {viewRoute?.distance_km} km total</p>
          {(viewRoute?.stop_details ?? []).map((s: any, i: number) => (
            <div key={i} className="flex items-center gap-3 p-2.5 rounded-lg border border-border">
              <div className="w-6 h-6 rounded-full bg-brand-light flex items-center justify-center text-[10px] font-bold text-brand">{i+1}</div>
              <MapPin className="h-3.5 w-3.5 text-muted-fg" /><span className="text-[11px] font-semibold text-fg flex-1">{s.name}</span>
              <span className="text-[10px] text-muted-fg">{s.distanceFromPrev} km</span>
            </div>
          ))}
          {(!viewRoute?.stop_details || viewRoute.stop_details.length === 0) && <p className="text-[11px] text-muted-fg text-center py-4">No stops configured yet. Edit route to add stops.</p>}
        </div>
      </Modal>

      {/* Add Route */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add New Route" className="max-w-lg">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3"><FormField label="Route Name" required><FormInput value={addForm.name} onChange={e => setAddForm(f => ({...f, name: e.target.value}))} placeholder="e.g. Haveri Central" /></FormField>
            <FormField label="Code"><FormInput value={addForm.code} onChange={e => setAddForm(f => ({...f, code: e.target.value}))} placeholder="R1" /></FormField></div>
          <FormField label="Zone" required><FormSelect value={addForm.zoneId} onChange={e => setAddForm(f => ({...f, zoneId: e.target.value}))}><option value="">Select</option>{zones.map((z: any) => <option key={z.id} value={z.id}>{z.name}</option>)}</FormSelect></FormField>
          <StopsEditor stops={addStops} onChange={setAddStops} />
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button size="sm" disabled={addMut.isPending || !addForm.name || !addForm.zoneId} onClick={() => addMut.mutate({ ...addForm, stopDetails: addStops })}>{addMut.isPending ? "Adding..." : "Add Route"}</Button></div>
        </div>
      </Modal>

      {/* Edit Route */}
      <Modal open={!!showEdit} onClose={() => setShowEdit(null)} title={`Edit — ${showEdit?.name}`} className="max-w-lg">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3"><FormField label="Name"><FormInput value={editForm.name} onChange={e => setEditForm(f => ({...f, name: e.target.value}))} /></FormField>
            <FormField label="Active"><FormSelect value={editForm.active?"true":"false"} onChange={e => setEditForm(f => ({...f, active: e.target.value==="true"}))}><option value="true">Active</option><option value="false">Inactive</option></FormSelect></FormField></div>
          <StopsEditor stops={editStops} onChange={setEditStops} />
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setShowEdit(null)}>Cancel</Button>
            <Button size="sm" disabled={editMut.isPending} onClick={() => editMut.mutate({ name: editForm.name, active: editForm.active, stopDetails: editStops })}>{editMut.isPending ? "Saving..." : "Save"}</Button></div>
        </div>
      </Modal>
    </>
  );
}
