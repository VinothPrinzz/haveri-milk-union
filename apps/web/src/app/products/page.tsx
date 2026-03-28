"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, Badge, Button, TableCard, Th, Td } from "@/components/ui";
import { Modal, FormField, FormInput, FormSelect } from "@/components/ui/modal";
import { Plus, Search } from "lucide-react";

export default function ProductListPage() {
  const [search, setSearch] = useState("");
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: "", categoryId: "", icon: "", unit: "", basePrice: "", gstPercent: "5" });
  const qc = useQueryClient();

  const { data } = useQuery({ queryKey: ["products-all"], queryFn: () => api.get("/api/v1/products/all", { page: 1, limit: 50 }) });
  const { data: catsData } = useQuery({ queryKey: ["categories"], queryFn: () => api.get("/api/v1/categories") });
  const categories = catsData?.categories ?? [];
  const products = (data?.data ?? []).filter((p: any) => search ? p.name.toLowerCase().includes(search.toLowerCase()) : true);

  const addMutation = useMutation({
    mutationFn: (body: any) => api.post("/api/v1/products", body),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["products-all"] }); setShowAdd(false); setForm({ name: "", categoryId: "", icon: "", unit: "", basePrice: "", gstPercent: "5" }); },
  });

  return (
    <>
      <PageHeader icon="📦" title="Product List" subtitle="Manage all dairy products and their details"
        actions={<Button size="sm" onClick={() => setShowAdd(true)}><Plus className="h-3.5 w-3.5" /> Add Product</Button>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md"><Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products..." className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div></div>
      <TableCard>
        <thead><tr><Th>Product</Th><Th>Category</Th><Th>Unit</Th><Th className="text-right">Base Price</Th><Th className="text-right">GST</Th><Th className="text-right">Final Price</Th><Th className="text-right">Stock</Th><Th>Status</Th></tr></thead>
        <tbody>{products.map((p: any) => {
          const base = parseFloat(p.basePrice), gst = parseFloat(p.gstPercent), final_ = base * (1 + gst / 100);
          return (<tr key={p.id} className="hover:bg-muted/50"><Td className="font-semibold"><span className="mr-1.5">{p.icon||"📦"}</span>{p.name}</Td><Td>{p.categoryName}</Td><Td>{p.unit}</Td><Td className="text-right">{formatCurrency(base)}</Td><Td className="text-right">{gst}%</Td><Td className="text-right font-bold text-brand">{formatCurrency(final_)}</Td><Td className={`text-right font-semibold ${p.stock===0?"text-danger":p.stock<50?"text-warning":""}`}>{p.stock}</Td><Td><Badge variant={p.available?"active":"inactive"}>{p.available?"Active":"Inactive"}</Badge></Td></tr>);
        })}</tbody>
      </TableCard>

      <Modal open={showAdd} onClose={() => setShowAdd(false)} title="Add New Product">
        <div className="space-y-3">
          <FormField label="Product Name" required><FormInput value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Full Cream Milk" /></FormField>
          <FormField label="Category" required><FormSelect value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}><option value="">Select category</option>{categories.map((c: any) => <option key={c.id} value={c.id}>{c.name}</option>)}</FormSelect></FormField>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Unit" required><FormInput value={form.unit} onChange={e => setForm(f => ({ ...f, unit: e.target.value }))} placeholder="e.g. 500ml Pouch" /></FormField>
            <FormField label="Icon"><FormInput value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))} placeholder="e.g. 🥛" /></FormField>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <FormField label="Base Price (₹)" required><FormInput type="number" value={form.basePrice} onChange={e => setForm(f => ({ ...f, basePrice: e.target.value }))} placeholder="28.00" /></FormField>
            <FormField label="GST %" required><FormSelect value={form.gstPercent} onChange={e => setForm(f => ({ ...f, gstPercent: e.target.value }))}><option value="5">5%</option><option value="12">12%</option><option value="18">18%</option></FormSelect></FormField>
          </div>
          <div className="flex justify-end gap-2 pt-3 border-t border-border">
            <Button variant="outline" size="sm" onClick={() => setShowAdd(false)}>Cancel</Button>
            <Button size="sm" disabled={addMutation.isPending || !form.name || !form.categoryId || !form.unit || !form.basePrice}
              onClick={() => addMutation.mutate({ ...form, basePrice: form.basePrice, gstPercent: form.gstPercent, stock: 0, available: true })}>
              {addMutation.isPending ? "Adding..." : "Add Product"}
            </Button>
          </div>
          {addMutation.isError && <p className="text-[11px] text-danger font-semibold">Failed to add product</p>}
        </div>
      </Modal>
    </>
  );
}
