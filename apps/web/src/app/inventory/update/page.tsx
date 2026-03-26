"use client";
import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Button, TableCard, Th, Td } from "@/components/ui";
import { Save, Clock, Search } from "lucide-react";

interface StockEntry { productId: string; opening: number; received: number; dispatched: number; wastage: number; }

export default function StockUpdatePage() {
  const today = new Date().toISOString().split("T")[0]!;
  const [entries, setEntries] = useState<Record<string, StockEntry>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [search, setSearch] = useState("");
  const queryClient = useQueryClient();
  const { data } = useQuery({ queryKey: ["fgs-overview"], queryFn: () => api.get("/api/v1/fgs/overview") });
  let products = data?.products ?? [];
  if (search) products = products.filter((p: any) => p.name.toLowerCase().includes(search.toLowerCase()));

  const getEntry = (pid: string, stock: number): StockEntry => entries[pid] ?? { productId: pid, opening: stock, received: 0, dispatched: 0, wastage: 0 };
  const updateField = (pid: string, field: keyof StockEntry, value: number, stock: number) => { const cur = getEntry(pid, stock); setEntries(prev => ({ ...prev, [pid]: { ...cur, [field]: Math.max(0, value) } })); setSaved(false); };
  const getClosing = (e: StockEntry) => e.opening + e.received - e.dispatched - e.wastage;

  const handleSave = async () => { setSaving(true); try { const el = (data?.products ?? []).map((p: any) => { const e = getEntry(p.id, p.stock); return { productId: p.id, opening: e.opening, received: e.received, dispatched: e.dispatched, wastage: e.wastage }; }); await api.post("/api/v1/fgs/update", { date: today, entries: el }); setSaved(true); queryClient.invalidateQueries({ queryKey: ["fgs-overview"] }); } catch {} finally { setSaving(false); } };

  return (
    <>
      <PageHeader icon="🔄" title="Stock Update" subtitle="Daily FGS stock entry and updates"
        actions={<div className="flex items-center gap-3"><span className="text-[11px] text-muted-fg font-medium flex items-center gap-1"><Clock className="h-3.5 w-3.5" /> Last updated: Today, 6:30 AM</span><Button size="sm" onClick={handleSave} disabled={saving}><Save className="h-3.5 w-3.5" /> {saving?"Saving...":saved?"Saved ✓":"Save Stock"}</Button></div>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md"><Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products..." className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div></div>
      <TableCard>
        <thead><tr><Th>Product</Th><Th>Category</Th><Th className="text-right">Opening Stock</Th><Th className="text-right">Received</Th><Th className="text-right">Dispatched</Th><Th className="text-right">Wastage</Th><Th className="text-right">Closing Stock</Th></tr></thead>
        <tbody>{products.map((p: any) => { const entry = getEntry(p.id, p.stock); const closing = getClosing(entry); return (
          <tr key={p.id} className="hover:bg-muted/50"><Td className="font-semibold"><span className="mr-1.5">{p.icon}</span>{p.name}</Td><Td>{p.category_name}</Td><Td className="text-right">{entry.opening}</Td>
            <Td className="text-right"><input type="number" min={0} value={entry.received} onChange={e => updateField(p.id,"received",parseInt(e.target.value)||0,p.stock)} className="w-16 h-7 bg-background border border-border rounded-md px-2 text-[11px] font-semibold text-fg text-right outline-none focus:border-brand" /></Td>
            <Td className="text-right"><input type="number" min={0} value={entry.dispatched} onChange={e => updateField(p.id,"dispatched",parseInt(e.target.value)||0,p.stock)} className="w-16 h-7 bg-background border border-border rounded-md px-2 text-[11px] font-semibold text-fg text-right outline-none focus:border-brand" /></Td>
            <Td className="text-right"><input type="number" min={0} value={entry.wastage} onChange={e => updateField(p.id,"wastage",parseInt(e.target.value)||0,p.stock)} className="w-16 h-7 bg-background border border-border rounded-md px-2 text-[11px] font-semibold text-fg text-right outline-none focus:border-brand" /></Td>
            <Td className={`text-right font-bold ${closing<=0?"text-danger":"text-fg"}`}>{closing}</Td></tr>); })}</tbody>
      </TableCard>
    </>
  );
}
