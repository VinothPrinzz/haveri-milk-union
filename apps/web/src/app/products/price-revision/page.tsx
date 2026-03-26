"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, Button, TableCard, Th, Td } from "@/components/ui";
import { Save, Search } from "lucide-react";
import { useState } from "react";

export default function PriceRevisionPage() {
  const { data } = useQuery({ queryKey: ["products-all"], queryFn: () => api.get("/api/v1/products/all", { page: 1, limit: 50 }) });
  const allProducts = data?.data ?? [];
  const [prices, setPrices] = useState<Record<string, string>>({});
  const [search, setSearch] = useState("");
  const products = search ? allProducts.filter((p: any) => p.name.toLowerCase().includes(search.toLowerCase())) : allProducts;

  return (
    <>
      <PageHeader icon="📈" title="Price Revision" subtitle="Update product pricing and manage revision history"
        actions={<Button size="sm"><Save className="h-3.5 w-3.5" /> Save All Changes</Button>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md"><Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products..." className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div></div>
      <TableCard>
        <thead><tr><Th>Product</Th><Th>Unit</Th><Th className="text-right">Current Price</Th><Th>New Price</Th><Th className="text-right">GST %</Th><Th className="text-right">Effective Price</Th></tr></thead>
        <tbody>{products.map((p: any) => {
          const newPrice = prices[p.id] ?? p.basePrice, gst = parseFloat(p.gstPercent), effective = parseFloat(newPrice) * (1 + gst / 100);
          return (<tr key={p.id} className="hover:bg-muted/50"><Td className="font-semibold"><span className="mr-1.5">{p.icon||"📦"}</span>{p.name}</Td><Td>{p.unit}</Td><Td className="text-right">{formatCurrency(p.basePrice)}</Td><Td><input type="number" value={newPrice} onChange={e => setPrices(prev => ({...prev, [p.id]: e.target.value}))} className="w-20 h-7 bg-background border border-border rounded-md px-2 text-[11px] font-semibold text-fg text-right outline-none focus:border-brand" /></Td><Td className="text-right">{p.gstPercent}%</Td><Td className="text-right font-bold text-brand">{formatCurrency(effective)}</Td></tr>);
        })}</tbody>
      </TableCard>
    </>
  );
}
