"use client";
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Button, TableCard, Th, Td } from "@/components/ui";
import { Save, Clock } from "lucide-react";

interface StockEntry {
  productId: string;
  opening: number;
  received: number;
  dispatched: number;
  wastage: number;
}

export default function StockUpdatePage() {
  const today = new Date().toISOString().split("T")[0]!;
  const [entries, setEntries] = useState<Record<string, StockEntry>>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const queryClient = useQueryClient();

  const { data } = useQuery({
    queryKey: ["fgs-overview"],
    queryFn: () => api.get("/api/v1/fgs/overview"),
  });

  const products = data?.products ?? [];

  const getEntry = (productId: string, currentStock: number): StockEntry => {
    return entries[productId] ?? {
      productId,
      opening: currentStock,
      received: 0,
      dispatched: 0,
      wastage: 0,
    };
  };

  const updateField = (productId: string, field: keyof StockEntry, value: number, currentStock: number) => {
    const current = getEntry(productId, currentStock);
    setEntries((prev) => ({
      ...prev,
      [productId]: { ...current, [field]: Math.max(0, value) },
    }));
    setSaved(false);
  };

  const getClosing = (entry: StockEntry) =>
    entry.opening + entry.received - entry.dispatched - entry.wastage;

  const handleSave = async () => {
    setSaving(true);
    try {
      const entryList = products.map((p: any) => {
        const entry = getEntry(p.id, p.stock);
        return {
          productId: p.id,
          opening: entry.opening,
          received: entry.received,
          dispatched: entry.dispatched,
          wastage: entry.wastage,
        };
      });

      await api.post("/api/v1/fgs/update", { date: today, entries: entryList });
      setSaved(true);
      queryClient.invalidateQueries({ queryKey: ["fgs-overview"] });
    } catch (err) {
      console.error(err);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <PageHeader
        icon="🔄"
        title="Stock Update"
        subtitle="Daily FGS stock entry and updates"
        actions={
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-muted-fg font-medium flex items-center gap-1">
              <Clock className="h-3.5 w-3.5" /> Last updated: Today, 6:30 AM
            </span>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              <Save className="h-3.5 w-3.5" /> {saving ? "Saving..." : saved ? "Saved ✓" : "Save Stock"}
            </Button>
          </div>
        }
      />

      <TableCard>
        <thead>
          <tr>
            <Th>Product</Th>
            <Th>Category</Th>
            <Th className="text-right">Opening Stock</Th>
            <Th className="text-right">Received</Th>
            <Th className="text-right">Dispatched</Th>
            <Th className="text-right">Wastage</Th>
            <Th className="text-right">Closing Stock</Th>
          </tr>
        </thead>
        <tbody>
          {products.map((p: any) => {
            const entry = getEntry(p.id, p.stock);
            const closing = getClosing(entry);
            return (
              <tr key={p.id} className="hover:bg-muted/50 transition-colors">
                <Td className="font-semibold">
                  <span className="mr-1.5">{p.icon}</span>{p.name}
                </Td>
                <Td>{p.category_name}</Td>
                <Td className="text-right">{entry.opening}</Td>
                <Td className="text-right">
                  <input
                    type="number"
                    min={0}
                    value={entry.received}
                    onChange={(e) => updateField(p.id, "received", parseInt(e.target.value) || 0, p.stock)}
                    className="w-16 h-7 bg-background border border-border rounded-md px-2 text-[11px] font-semibold text-fg text-right outline-none focus:border-brand"
                  />
                </Td>
                <Td className="text-right">
                  <input
                    type="number"
                    min={0}
                    value={entry.dispatched}
                    onChange={(e) => updateField(p.id, "dispatched", parseInt(e.target.value) || 0, p.stock)}
                    className="w-16 h-7 bg-background border border-border rounded-md px-2 text-[11px] font-semibold text-fg text-right outline-none focus:border-brand"
                  />
                </Td>
                <Td className="text-right">
                  <input
                    type="number"
                    min={0}
                    value={entry.wastage}
                    onChange={(e) => updateField(p.id, "wastage", parseInt(e.target.value) || 0, p.stock)}
                    className="w-16 h-7 bg-background border border-border rounded-md px-2 text-[11px] font-semibold text-fg text-right outline-none focus:border-brand"
                  />
                </Td>
                <Td className={`text-right font-bold ${closing <= 0 ? "text-danger" : "text-fg"}`}>
                  {closing}
                </Td>
              </tr>
            );
          })}
        </tbody>
      </TableCard>
    </>
  );
}
