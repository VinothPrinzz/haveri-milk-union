"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, Button } from "@/components/ui";
import { Modal, FormField, FormInput, FormSelect } from "@/components/ui/modal";
import { Pencil, Search, X, Plus } from "lucide-react";

export default function AssignmentsPage() {
  const [search, setSearch] = useState(""); const [selected, setSelected] = useState<any>(null);
  const [showEdit, setShowEdit] = useState<any>(null); const [showReassign, setShowReassign] = useState(false);
  const [editForm, setEditForm] = useState({ vehicleNumber: "", driverName: "", departureTime: "" });
  const [reassignForm, setReassignForm] = useState({ routeId: "", vehicleNumber: "", driverName: "", date: new Date().toISOString().split("T")[0] });
  const qc = useQueryClient();

  const { data } = useQuery({ queryKey: ["assignments"], queryFn: () => api.get("/api/v1/dispatch/assignments") });
  const { data: routesData } = useQuery({ queryKey: ["routes"], queryFn: () => api.get("/api/v1/routes") });
  const assignments = data?.data ?? [];
  const routes = routesData?.routes ?? [];
  const filtered = search ? assignments.filter((a: any) => a.route_name?.toLowerCase().includes(search.toLowerCase())) : assignments;

  const editMut = useMutation({ mutationFn: (b: any) => api.patch(`/api/v1/dispatch/assignments/${showEdit.id}`, b), onSuccess: () => { qc.invalidateQueries({ queryKey: ["assignments"] }); setShowEdit(null); } });
  const reassignMut = useMutation({ mutationFn: (b: any) => api.post("/api/v1/dispatch/assign", b), onSuccess: () => { qc.invalidateQueries({ queryKey: ["assignments"] }); setShowReassign(false); setReassignForm({ routeId: "", vehicleNumber: "", driverName: "", date: new Date().toISOString().split("T")[0] }); } });

  const openEdit = (a: any) => { setEditForm({ vehicleNumber: a.vehicle_number || "", driverName: a.driver_name || "", departureTime: a.departure_time || "" }); setShowEdit(a); };

  return (
    <>
      <PageHeader icon="🔀" title="Route Assignments" subtitle="Assign dealers and products to delivery routes"
        actions={<Button size="sm" onClick={() => setShowReassign(true)}><Plus className="h-3.5 w-3.5" /> Create Assignment</Button>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md"><Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search routes..." className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div></div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {filtered.map((a: any) => (
          <div key={a.id} className="bg-card rounded-[10px] border border-border shadow-card p-4 cursor-pointer hover:border-brand/30" onClick={() => setSelected(a)}>
            <div className="flex items-start justify-between mb-2"><div><div className="text-[13px] font-bold text-fg">{a.route_name}</div><div className="text-[10px] text-muted-fg">Departure: {a.departure_time || "—"} · {a.zone_name}</div></div>
              <button className="p-1.5 rounded-md border border-border hover:bg-muted" onClick={e => { e.stopPropagation(); openEdit(a); }}><Pencil className="h-3.5 w-3.5 text-muted-fg" /></button></div>
            <div className="flex gap-4 text-[10px] text-muted-fg font-medium"><span>🚛 {a.vehicle_number || "—"}</span><span>👥 {a.dealer_count} dealers</span><span>📦 {a.item_count} items</span></div>
            <div className="text-[10px] text-muted-fg mt-1">Driver: {a.driver_name || "—"}</div>
            <div className="mt-2 pt-2 border-t border-border"><span className="text-[10px] text-brand font-semibold">View Details →</span></div>
          </div>
        ))}
        {filtered.length === 0 && <div className="col-span-2 text-center py-12 text-muted-fg text-sm">No assignments for today. Click "Create Assignment" to add one.</div>}
      </div>

      {/* View Details — shows dealers with items */}
      <Modal open={!!selected} onClose={() => setSelected(null)} title={selected?.route_name || ""} className="max-w-lg">
        <div><p className="text-[10px] text-muted-fg mb-3">🚛 {selected?.vehicle_number || "—"} · {selected?.driver_name || "—"} · {selected?.departure_time || "—"}</p>
          <div className="text-[11px] font-bold text-fg mb-2">Dealers & Orders</div>
          <div className="space-y-2">{(selected?.dealers ?? []).map((d: any, i: number) => (
            <div key={i} className="p-2.5 rounded-lg border border-border cursor-pointer hover:bg-muted/50" onClick={() => window.open(`/finance/invoices?search=${d.order_id?.slice(0,8)}`, "_blank")}>
              <div className="flex items-center justify-between"><span className="text-[11px] font-semibold text-fg">{d.dealer_name}</span><span className="text-[10px] font-bold text-brand">₹{parseFloat(d.grand_total).toLocaleString()}</span></div>
              <div className="text-[9px] text-muted-fg mt-0.5">{d.item_count} items · {d.order_status} · Click for invoice</div>
            </div>
          ))}{(!selected?.dealers || selected.dealers.length === 0) && <p className="text-[11px] text-muted-fg text-center py-4">No dealer orders for this route today</p>}</div>
        </div>
      </Modal>

      {/* Edit Assignment */}
      <Modal open={!!showEdit} onClose={() => setShowEdit(null)} title={`Edit — ${showEdit?.route_name}`}>
        <div className="space-y-3">
          <FormField label="Vehicle Number"><FormInput value={editForm.vehicleNumber} onChange={e => setEditForm(f => ({...f, vehicleNumber: e.target.value}))} placeholder="KA-25-AB-1234" /></FormField>
          <FormField label="Driver Name"><FormInput value={editForm.driverName} onChange={e => setEditForm(f => ({...f, driverName: e.target.value}))} /></FormField>
          <FormField label="Departure Time"><FormInput type="time" value={editForm.departureTime} onChange={e => setEditForm(f => ({...f, departureTime: e.target.value}))} /></FormField>
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setShowEdit(null)}>Cancel</Button>
            <Button size="sm" disabled={editMut.isPending} onClick={() => editMut.mutate(editForm)}>{editMut.isPending ? "Saving..." : "Save"}</Button></div>
        </div>
      </Modal>

      {/* Create/Reassign */}
      <Modal open={showReassign} onClose={() => setShowReassign(false)} title="Create Route Assignment">
        <div className="space-y-3">
          <FormField label="Route" required><FormSelect value={reassignForm.routeId} onChange={e => setReassignForm(f => ({...f, routeId: e.target.value}))}><option value="">Select route</option>{routes.map((r: any) => <option key={r.id} value={r.id}>{r.name} ({r.zone_name})</option>)}</FormSelect></FormField>
          <FormField label="Date"><FormInput type="date" value={reassignForm.date} onChange={e => setReassignForm(f => ({...f, date: e.target.value}))} /></FormField>
          <FormField label="Vehicle Number"><FormInput value={reassignForm.vehicleNumber} onChange={e => setReassignForm(f => ({...f, vehicleNumber: e.target.value}))} placeholder="KA-25-AB-1234" /></FormField>
          <FormField label="Driver Name"><FormInput value={reassignForm.driverName} onChange={e => setReassignForm(f => ({...f, driverName: e.target.value}))} /></FormField>
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setShowReassign(false)}>Cancel</Button>
            <Button size="sm" disabled={reassignMut.isPending || !reassignForm.routeId} onClick={() => reassignMut.mutate(reassignForm)}>{reassignMut.isPending ? "Creating..." : "Create"}</Button></div>
        </div>
      </Modal>
    </>
  );
}
