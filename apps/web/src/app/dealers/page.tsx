"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, Badge, Button, TableCard, Th, Td, EmptyState } from "@/components/ui";
import { Modal, FormField, FormInput, FormSelect } from "@/components/ui/modal";
import { Plus, Search, Eye, Wallet } from "lucide-react";

export default function DealersPage() {
  const [search, setSearch] = useState(""); const [page, setPage] = useState(1);
  const [showAdd, setShowAdd] = useState(false); const [showTopup, setShowTopup] = useState<any>(null);
  const [addForm, setAddForm] = useState({ name: "", phone: "", email: "", gstNumber: "", zoneId: "", address: "", city: "", pinCode: "" });
  const [topupAmt, setTopupAmt] = useState(""); const [topupDesc, setTopupDesc] = useState("");
  const qc = useQueryClient();

  const { data, isLoading } = useQuery({ queryKey: ["dealers", search, page], queryFn: () => api.get("/api/v1/dealers", { page, limit: 25, search: search || undefined }) });
  const { data: windowData } = useQuery({ queryKey: ["window-status"], queryFn: () => api.get("/api/v1/window/status") });
  const zones = (windowData?.windows ?? []).map((w: any) => ({ id: w.zoneId, name: w.zoneName }));
  const dealers = data?.data ?? []; const total = data?.total ?? 0; const totalPages = data?.totalPages ?? 1;

  const addMut = useMutation({ mutationFn: (b: any) => api.post("/api/v1/dealers", b), onSuccess: () => { qc.invalidateQueries({ queryKey: ["dealers"] }); setShowAdd(false); setAddForm({ name: "", phone: "", email: "", gstNumber: "", zoneId: "", address: "", city: "", pinCode: "" }); } });
  const topupMut = useMutation({ mutationFn: () => api.post("/api/v1/wallet/topup", { dealerId: showTopup!.id, amount: parseFloat(topupAmt), description: topupDesc || undefined }), onSuccess: () => { qc.invalidateQueries({ queryKey: ["dealers"] }); setShowTopup(null); setTopupAmt(""); setTopupDesc(""); } });

  return (
    <>
      <PageHeader icon="👥" title="All Dealers" subtitle="Manage dealer accounts and wallet balances"
        actions={<Button size="sm" onClick={() => setShowAdd(true)}><Plus className="h-3.5 w-3.5" /> Add Dealer</Button>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md"><Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => { setSearch(e.target.value); setPage(1); }} placeholder="Search dealers..." className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div></div>
      <TableCard>
        <thead><tr><Th>Dealer</Th><Th>Phone</Th><Th>Location</Th><Th className="text-right">Wallet Balance</Th><Th>Status</Th><Th>Actions</Th></tr></thead>
        <tbody>{dealers.map((d: any) => (<tr key={d.id} className="hover:bg-muted/50"><Td className="font-semibold">{d.name}</Td><Td>{d.phone}</Td><Td className="text-[10px]">{d.zone_name}</Td>
          <Td className="text-right"><span className={`font-bold ${parseFloat(d.wallet_balance)===0?"text-danger":parseFloat(d.wallet_balance)<5000?"text-warning":"text-success"}`}>{formatCurrency(d.wallet_balance)}</span></Td>
          <Td><Badge variant={d.active?"active":"inactive"}>{d.active?"active":"inactive"}</Badge></Td>
          <Td><div className="flex gap-1"><button className="p-1.5 rounded-md border border-border hover:bg-muted"><Eye className="h-3.5 w-3.5 text-muted-fg" /></button><button className="p-1.5 rounded-md border border-success/30 hover:bg-success/10" onClick={() => setShowTopup({ id: d.id, name: d.name })}><Wallet className="h-3.5 w-3.5 text-success" /></button></div></Td>
        </tr>))}{!isLoading&&dealers.length===0&&<tr><td colSpan={6}><EmptyState message="No dealers found" /></td></tr>}</tbody>
      </TableCard>
      {totalPages>1&&<div className="flex items-center justify-between mt-4"><p className="text-[11px] text-muted-fg">Page {page} of {totalPages}</p><div className="flex gap-1.5"><Button variant="outline" size="sm" disabled={page<=1} onClick={()=>setPage(page-1)}>Previous</Button><Button variant="outline" size="sm" disabled={page>=totalPages} onClick={()=>setPage(page+1)}>Next</Button></div></div>}

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add New Dealer" className="max-w-lg">
        <div className="space-y-3">
          <div className="grid grid-cols-2 gap-3"><FormField label="Name" required><FormInput value={addForm.name} onChange={e => setAddForm(f => ({...f, name: e.target.value}))} /></FormField><FormField label="Phone" required><FormInput value={addForm.phone} onChange={e => setAddForm(f => ({...f, phone: e.target.value}))} placeholder="9876543210" /></FormField></div>
          <div className="grid grid-cols-2 gap-3"><FormField label="Email"><FormInput value={addForm.email} onChange={e => setAddForm(f => ({...f, email: e.target.value}))} /></FormField><FormField label="GST Number"><FormInput value={addForm.gstNumber} onChange={e => setAddForm(f => ({...f, gstNumber: e.target.value}))} /></FormField></div>
          <FormField label="Zone" required><FormSelect value={addForm.zoneId} onChange={e => setAddForm(f => ({...f, zoneId: e.target.value}))}><option value="">Select zone</option>{zones.map((z: any) => <option key={z.id} value={z.id}>{z.name}</option>)}</FormSelect></FormField>
          <FormField label="Address"><FormInput value={addForm.address} onChange={e => setAddForm(f => ({...f, address: e.target.value}))} /></FormField>
          <div className="grid grid-cols-2 gap-3"><FormField label="City"><FormInput value={addForm.city} onChange={e => setAddForm(f => ({...f, city: e.target.value}))} /></FormField><FormField label="PIN"><FormInput value={addForm.pinCode} onChange={e => setAddForm(f => ({...f, pinCode: e.target.value}))} /></FormField></div>
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button><Button size="sm" disabled={addMut.isPending||!addForm.name||!addForm.phone||!addForm.zoneId} onClick={() => addMut.mutate(addForm)}>{addMut.isPending?"Adding...":"Add Dealer"}</Button></div>
          {addMut.isError&&<p className="text-[11px] text-danger">{(addMut.error as any)?.data?.message||"Failed"}</p>}
        </div>
      </Modal>

      <Modal open={!!showTopup} onClose={() => setShowTopup(null)} title={`Top-up — ${showTopup?.name}`}>
        <div className="space-y-3">
          <FormField label="Amount (₹)" required><FormInput type="number" min={1} value={topupAmt} onChange={e => setTopupAmt(e.target.value)} placeholder="5000" /></FormField>
          <FormField label="Description"><FormInput value={topupDesc} onChange={e => setTopupDesc(e.target.value)} placeholder="e.g. UPI received" /></FormField>
          <div className="flex justify-end gap-2 pt-3 border-t border-border"><Button variant="outline" size="sm" onClick={() => setShowTopup(null)}>Cancel</Button><Button size="sm" disabled={topupMut.isPending||!topupAmt} onClick={() => topupMut.mutate()}>{topupMut.isPending?"Processing...":"Top-up"}</Button></div>
        </div>
      </Modal>
    </>
  );
}
