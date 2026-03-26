"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, Badge, Button, TableCard, Th, Td } from "@/components/ui";
import { Plus, Search } from "lucide-react";
import { useState } from "react";

export default function ProductListPage() {
  const [search, setSearch] = useState("");
  const { data } = useQuery({ queryKey: ["products-all"], queryFn: () => api.get("/api/v1/products/all", { page: 1, limit: 50 }) });
  const products = (data?.data ?? []).filter((p: any) => search ? p.name.toLowerCase().includes(search.toLowerCase()) : true);
  return (
    <>
      <PageHeader icon="📦" title="Product List" subtitle="Manage all dairy products and their details"
        actions={<Button size="sm"><Plus className="h-3.5 w-3.5" /> Add Product</Button>} />
      <div className="mb-5"><div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 max-w-md"><Search className="h-4 w-4 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products..." className="bg-transparent text-[12px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div></div>
      <TableCard>
        <thead><tr><Th>Product</Th><Th>Category</Th><Th>Unit</Th><Th className="text-right">Base Price</Th><Th className="text-right">GST</Th><Th className="text-right">Final Price</Th><Th className="text-right">Stock</Th><Th>Status</Th></tr></thead>
        <tbody>{products.map((p: any) => {
          const base = parseFloat(p.basePrice), gst = parseFloat(p.gstPercent), final_ = base * (1 + gst / 100);
          return (<tr key={p.id} className="hover:bg-muted/50"><Td className="font-semibold"><span className="mr-1.5">{p.icon||"📦"}</span>{p.name}</Td><Td>{p.categoryName}</Td><Td>{p.unit}</Td><Td className="text-right">{formatCurrency(base)}</Td><Td className="text-right">{gst}%</Td><Td className="text-right font-bold text-brand">{formatCurrency(final_)}</Td><Td className={`text-right font-semibold ${p.stock===0?"text-danger":p.stock<50?"text-warning":""}`}>{p.stock}</Td><Td><Badge variant={p.available?"active":"inactive"}>{p.available?"Active":"Inactive"}</Badge></Td></tr>);
        })}</tbody>
      </TableCard>
    </>
  );
}
