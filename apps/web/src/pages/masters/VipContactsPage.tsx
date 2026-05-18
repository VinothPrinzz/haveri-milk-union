import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { FilterBar, Field, EmptyState, fmtDate } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Pencil, Trash2, Search } from "lucide-react";
import {
  fetchVipContacts, createVipContact, updateVipContact, deleteVipContact,
} from "@/services/api";

type Vip = {
  id: string; name: string;
  phone?: string | null; designation?: string | null; notes?: string | null;
  created_at?: string;
};

const empty = { name: "", phone: "", designation: "", notes: "" };

export default function VipContactsPage() {
  const qc = useQueryClient();
  const [search, setSearch] = useState("");
  const { data: vips = [], isLoading } = useQuery({
    queryKey: ["vip-contacts", search],
    queryFn: () => fetchVipContacts(search || undefined),
  });

  const [editing, setEditing] = useState<Vip | null>(null);
  const [openNew, setOpenNew] = useState(false);
  const [form, setForm] = useState(empty);

  const createMut = useMutation({
    mutationFn: () => createVipContact({
      name: form.name.trim(),
      phone: form.phone.trim() || undefined,
      designation: form.designation.trim() || undefined,
      notes: form.notes.trim() || undefined,
    }),
    onSuccess: () => {
      toast.success("VIP added");
      qc.invalidateQueries({ queryKey: ["vip-contacts"] });
      setOpenNew(false); setForm(empty);
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const updateMut = useMutation({
    mutationFn: () => updateVipContact(editing!.id, {
      name: editing!.name, phone: editing!.phone,
      designation: editing!.designation, notes: editing!.notes,
    }),
    onSuccess: () => {
      toast.success("VIP updated");
      qc.invalidateQueries({ queryKey: ["vip-contacts"] });
      setEditing(null);
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteVipContact(id),
    onSuccess: () => {
      toast.success("VIP deleted");
      qc.invalidateQueries({ queryKey: ["vip-contacts"] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="VIP Contacts"
        subtitle={`${(vips as Vip[]).length} contact(s)`}
        actions={
          <Button size="sm" className="h-8" onClick={() => setOpenNew(true)}>
            <Plus className="h-3.5 w-3.5 mr-1" /> New VIP
          </Button>
        }
      />

      <FilterBar>
        <Field label="Search">
          <div className="relative">
            <Search className="absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Name or phone…"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="erp-input pl-8 w-64"
            />
          </div>
        </Field>
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
            </div>
          ) : (vips as Vip[]).length === 0 ? (
            <EmptyState title="No VIPs yet" hint="Add the first VIP with the button above." />
          ) : (
            <table className="erp-table w-full">
              <thead>
                <tr>
                  <th>Name</th><th>Phone</th><th>Designation</th><th>Notes</th><th>Added</th>
                  <th style={{ textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {(vips as Vip[]).map(v => (
                  <tr key={v.id}>
                    <td className="font-medium">{v.name}</td>
                    <td>{v.phone || "—"}</td>
                    <td>{v.designation || "—"}</td>
                    <td className="text-muted-foreground">{v.notes || "—"}</td>
                    <td>{v.created_at ? fmtDate(v.created_at) : "—"}</td>
                    <td style={{ textAlign: "right" }}>
                      <Button variant="outline" size="sm" className="h-7 px-2" onClick={() => setEditing(v)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-7 px-2 ml-1 text-destructive"
                        onClick={() => {
                          if (confirm(`Delete VIP "${v.name}"?`)) deleteMut.mutate(v.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* New */}
      <Dialog open={openNew} onOpenChange={setOpenNew}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>New VIP Contact</DialogTitle></DialogHeader>
          <div className="space-y-3 p-1">
            <Field label="Name" required>
              <Input className="erp-input" value={form.name}
                     onChange={e => setForm(f => ({ ...f, name: e.target.value }))} autoFocus />
            </Field>
            <Field label="Phone">
              <Input className="erp-input" value={form.phone} maxLength={10}
                     onChange={e => setForm(f => ({ ...f, phone: e.target.value }))} />
            </Field>
            <Field label="Designation">
              <Input className="erp-input" value={form.designation}
                     onChange={e => setForm(f => ({ ...f, designation: e.target.value }))} />
            </Field>
            <Field label="Notes">
              <Input className="erp-input" value={form.notes}
                     onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpenNew(false)}>Cancel</Button>
            <Button size="sm" disabled={!form.name.trim() || createMut.isPending} onClick={() => createMut.mutate()}>
              {createMut.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit */}
      <Dialog open={!!editing} onOpenChange={o => !o && setEditing(null)}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Edit VIP Contact</DialogTitle></DialogHeader>
          {editing && (
            <div className="space-y-3 p-1">
              <Field label="Name" required>
                <Input className="erp-input" value={editing.name}
                       onChange={e => setEditing({ ...editing, name: e.target.value })} />
              </Field>
              <Field label="Phone">
                <Input className="erp-input" value={editing.phone ?? ""} maxLength={10}
                       onChange={e => setEditing({ ...editing, phone: e.target.value })} />
              </Field>
              <Field label="Designation">
                <Input className="erp-input" value={editing.designation ?? ""}
                       onChange={e => setEditing({ ...editing, designation: e.target.value })} />
              </Field>
              <Field label="Notes">
                <Input className="erp-input" value={editing.notes ?? ""}
                       onChange={e => setEditing({ ...editing, notes: e.target.value })} />
              </Field>
            </div>
          )}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
            <Button size="sm" disabled={!editing?.name.trim() || updateMut.isPending} onClick={() => updateMut.mutate()}>
              {updateMut.isPending ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}