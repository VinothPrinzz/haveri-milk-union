"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, TableCard, Th, Td, Button } from "@/components/ui";
import { Download } from "lucide-react";
import { useState } from "react";
export default function FGSMovementPage() {
  const { data } = useQuery({ queryKey: ["fgs-overview"], queryFn: () => api.get("/api/v1/fgs/overview") });
  const products = data?.products ?? [];
  const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState("");
  return (
    <>
      <PageHeader icon="📦" title="FGS Movement" subtitle="Finished goods stock movement tracking"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="flex items-center gap-2 mb-6"><span className="text-[11px] font-semibold text-muted-fg">Period:</span><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      <TableCard>
        <thead><tr><Th>Product</Th><Th>Category</Th><Th className="text-right">Opening</Th><Th className="text-right">Received</Th><Th className="text-right">Dispatched</Th><Th className="text-right">Wastage</Th><Th className="text-right">Closing</Th></tr></thead>
        <tbody>{products.map((p: any) => (
          <tr key={p.id} className="hover:bg-muted/50"><Td className="font-semibold"><span className="mr-1.5">{p.icon}</span>{p.name}</Td><Td>{p.category_name}</Td><Td className="text-right">{p.stock}</Td><Td className="text-right text-success font-semibold">—</Td><Td className="text-right text-danger font-semibold">—</Td><Td className="text-right text-muted-fg">—</Td><Td className="text-right font-bold">{p.stock}</Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
