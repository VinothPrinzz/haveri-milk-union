"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, TableCard, Th, Td, Button } from "@/components/ui";
import { Modal, FormField, FormInput, FormSelect } from "@/components/ui/modal";
import { Plus, Pencil, Lock, Search } from "lucide-react";

const ROLES = ["super_admin", "manager", "dispatch_officer", "accountant", "call_desk"];
const ROLE_LABELS: Record<string, string> = { super_admin: "Super Admin", manager: "Manager", dispatch_officer: "Dispatch Officer", accountant: "Accountant", call_desk: "Call Desk" };

export default function UserManagementPage() {
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [showEdit, setShowEdit] = useState<any>(null);
  const [showReset, setShowReset] = useState<any>(null);
  const [addForm, setAddForm] = useState({ name: "", email: "", password: "", role: "manager", phone: "" });
  const [editForm, setEditForm] = useState({ name: "", email: "", role: "", phone: "", active: true });
  const [newPass, setNewPass] = useState("");
  const qc = useQueryClient();

  const { data } = useQuery({ queryKey: ["users"], queryFn: () => api.get("/api/v1/users", { page: 1, limit: 50 }) });
  const users = (data?.data ?? []).filter((u: any) => search ? u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase()) : true);

  const addMut = useMutation({ mutationFn: (body: any) => api.post("/api/v1/users", body), onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); setShowAdd(false); setAddForm({ name: "", email: "", password: "", role: "manager", phone: "" }); } });
  const editMut = useMutation({ mutationFn: (body: any) => api.patch(`/api/v1/users/${showEdit.id}`, body), onSuccess: () => { qc.invalidateQueries({ queryKey: ["users"] }); setShowEdit(null); } });
  const resetMut = useMutation({ mutationFn: () => api.patch(`/api/v1/users/${showReset.id}/reset-password`, { password: newPass }), onSuccess: () => { setShowReset(null); setNewPass(""); } });

  const openEdit = (u: any) => { setEditForm({ name: u.name, email: u.email, role: u.role, phone: u.phone || "", active: u.active }); setShowEdit(u); };

  return (
    <>
      <PageHeader icon="👤" title="User Management" subtitle="Manage admin users and their access credentials"
        actions={<Button size="sm" onClick={() => setShowAdd(true)}><Plus className="h-3.5 w-3.5" /> Add User</Button>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md"><Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search users..." className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div></div>
      <TableCard>
        <thead><tr><Th>Name</Th><Th>Email</Th><Th>Role</Th><Th>Last Login</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
        <tbody>{users.map((u: any) => (
          <tr key={u.id} className="hover:bg-muted/50"><Td className="font-semibold">{u.name}</Td><Td>{u.email}</Td><Td><Badge variant="active">{ROLE_LABELS[u.role] || u.role}</Badge></Td><Td className="text-muted-fg">{u.lastLoginAt ? new Date(u.lastLoginAt).toLocaleString("en-IN") : "Never"}</Td><Td><Badge variant={u.active ? "active" : "inactive"}>{u.active ? "active" : "inactive"}</Badge></Td>
            <Td><div className="flex gap-1"><button className="p-1.5 rounded-md border border-border hover:bg-muted" onClick={() => openEdit(u)}><Pencil className="h-3.5 w-3.5 text-muted-fg" /></button><button className="p-1.5 rounded-md border border-border hover:bg-muted" onClick={() => setShowReset(u)}><Lock className="h-3.5 w-3.5 text-muted-fg" /></button></div></Td></tr>
        ))}</tbody>
      </TableCard>

      {/* Add User */}
      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add New User">
        <div className="space-y-3">
          <FormField label="Full Name" required><FormInput value={addForm.name} onChange={e => setAddForm(f => ({...f, name: e.target.value}))} /></FormField>
          <FormField label="Email" required><FormInput type="email" value={addForm.email} onChange={e => setAddForm(f => ({...f, email: e.target.value}))} /></FormField>
          <FormField label="Password" required><FormInput type="password" value={addForm.password} onChange={e => setAddForm(f => ({...f, password: e.target.value}))} placeholder="Min 6 characters" /></FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Role" required><FormSelect value={addForm.role} onChange={e => setAddForm(f => ({...f, role: e.target.value}))}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</FormSelect></FormField>
            <FormField label="Phone"><FormInput value={addForm.phone} onChange={e => setAddForm(f => ({...f, phone: e.target.value}))} /></FormField>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button size="sm" disabled={addMut.isPending || !addForm.name || !addForm.email || !addForm.password} onClick={() => addMut.mutate(addForm)}>{addMut.isPending ? "Adding..." : "Add User"}</Button></div>
          {addMut.isError && <p className="text-[11px] text-danger">{(addMut.error as any)?.data?.message || "Failed"}</p>}
        </div>
      </Modal>

      {/* Edit User */}
      <Modal open={!!showEdit} onClose={() => setShowEdit(null)} title={`Edit — ${showEdit?.name}`}>
        <div className="space-y-3">
          <FormField label="Name"><FormInput value={editForm.name} onChange={e => setEditForm(f => ({...f, name: e.target.value}))} /></FormField>
          <FormField label="Email"><FormInput type="email" value={editForm.email} onChange={e => setEditForm(f => ({...f, email: e.target.value}))} /></FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Role"><FormSelect value={editForm.role} onChange={e => setEditForm(f => ({...f, role: e.target.value}))}>{ROLES.map(r => <option key={r} value={r}>{ROLE_LABELS[r]}</option>)}</FormSelect></FormField>
            <FormField label="Status"><FormSelect value={editForm.active ? "true" : "false"} onChange={e => setEditForm(f => ({...f, active: e.target.value === "true"}))}><option value="true">Active</option><option value="false">Inactive</option></FormSelect></FormField>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setShowEdit(null)}>Cancel</Button>
            <Button size="sm" disabled={editMut.isPending} onClick={() => editMut.mutate(editForm)}>{editMut.isPending ? "Saving..." : "Save"}</Button></div>
        </div>
      </Modal>

      {/* Reset Password */}
      <Modal open={!!showReset} onClose={() => setShowReset(null)} title={`Reset Password — ${showReset?.name}`}>
        <div className="space-y-3">
          <FormField label="New Password" required><FormInput type="password" value={newPass} onChange={e => setNewPass(e.target.value)} placeholder="Min 6 characters" /></FormField>
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setShowReset(null)}>Cancel</Button>
            <Button size="sm" disabled={resetMut.isPending || newPass.length < 6} onClick={() => resetMut.mutate()}>{resetMut.isPending ? "Resetting..." : "Reset Password"}</Button></div>
          {resetMut.isSuccess && <p className="text-[11px] text-success font-semibold">Password reset successfully</p>}
        </div>
      </Modal>
    </>
  );
}
