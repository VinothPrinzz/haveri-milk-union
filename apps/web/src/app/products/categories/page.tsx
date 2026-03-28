"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Button } from "@/components/ui";
import { Modal, FormField, FormInput } from "@/components/ui/modal";
import { Plus, Pencil } from "lucide-react";

export default function CategoriesPage() {
  const [showAdd, setShowAdd] = useState(false);
  const [editCat, setEditCat] = useState<any>(null);
  const [name, setName] = useState(""); const [icon, setIcon] = useState("");
  const [editName, setEditName] = useState(""); const [editIcon, setEditIcon] = useState("");
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["categories"], queryFn: () => api.get("/api/v1/categories") });
  const categories = data?.categories ?? [];

  const addMut = useMutation({ mutationFn: (b: any) => api.post("/api/v1/categories", b), onSuccess: () => { qc.invalidateQueries({ queryKey: ["categories"] }); setShowAdd(false); setName(""); setIcon(""); } });
  const editMut = useMutation({ mutationFn: (b: any) => api.patch(`/api/v1/categories/${editCat.id}`, b), onSuccess: () => { qc.invalidateQueries({ queryKey: ["categories"] }); setEditCat(null); } });

  const openEdit = (c: any) => { setEditName(c.name); setEditIcon(c.icon || ""); setEditCat(c); };

  return (
    <>
      <PageHeader icon="🏷️" title="Categories" subtitle="Manage product categories"
        actions={<Button size="sm" onClick={() => setShowAdd(true)}><Plus className="h-3.5 w-3.5" /> Add Category</Button>} />
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {categories.map((c: any) => (
          <div key={c.id} className="bg-card rounded-[10px] border border-border shadow-card p-4 flex items-center justify-between hover:border-brand/30 transition-colors">
            <div className="flex items-center gap-3"><span className="text-3xl">{c.icon || "📦"}</span><div><div className="text-[13px] font-bold text-fg">{c.name}</div><div className="text-[10px] text-muted-fg mt-0.5">Active</div></div></div>
            <button className="p-1.5 rounded-md border border-border hover:bg-muted" onClick={() => openEdit(c)}><Pencil className="h-3.5 w-3.5 text-muted-fg" /></button>
          </div>
        ))}
      </div>
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add Category">
        <div className="space-y-3">
          <FormField label="Name" required><FormInput value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Dairy" /></FormField>
          <FormField label="Icon (emoji)"><FormInput value={icon} onChange={e => setIcon(e.target.value)} placeholder="e.g. 🥛" /></FormField>
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button size="sm" disabled={addMut.isPending || !name} onClick={() => addMut.mutate({ name, icon })}>{addMut.isPending ? "Adding..." : "Add"}</Button></div>
        </div>
      </Modal>
      <Modal open={!!editCat} onClose={() => setEditCat(null)} title={`Edit — ${editCat?.name}`}>
        <div className="space-y-3">
          <FormField label="Name" required><FormInput value={editName} onChange={e => setEditName(e.target.value)} /></FormField>
          <FormField label="Icon (emoji)"><FormInput value={editIcon} onChange={e => setEditIcon(e.target.value)} /></FormField>
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setEditCat(null)}>Cancel</Button>
            <Button size="sm" disabled={editMut.isPending || !editName} onClick={() => editMut.mutate({ name: editName, icon: editIcon })}>{editMut.isPending ? "Saving..." : "Save"}</Button></div>
        </div>
      </Modal>
    </>
  );
}
