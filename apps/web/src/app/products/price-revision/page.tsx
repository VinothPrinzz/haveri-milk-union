"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/utils";
import { PageHeader, Card, Button, TableCard, Th, Td } from "@/components/ui";
import { Save } from "lucide-react";
import { useState } from "react";

export default function PriceRevisionPage() {
  const { data } = useQuery({ queryKey: ["products-all"], queryFn: () => api.get("/api/v1/products/all", { page: 1, limit: 50 }) });
  const products = data?.data ?? [];
  const [prices, setPrices] = useState<Record<string, string>>({});

  return (
    <>
      <PageHeader icon="📈" title="Price Revision" subtitle="Update product pricing and manage revision history"
        actions={<Button size="sm"><Save className="h-3.5 w-3.5" /> Save All Changes</Button>} />
      <TableCard>
        <thead><tr><Th>Product</Th><Th>Unit</Th><Th className="text-right">Current Price</Th><Th>New Price</Th><Th className="text-right">GST %</Th><Th className="text-right">Effective Price</Th></tr></thead>
        <tbody>{products.map((p: any) => {
          const newPrice = prices[p.id] ?? p.basePrice;
          const gst = parseFloat(p.gstPercent);
          const effective = parseFloat(newPrice) * (1 + gst / 100);
          return (
            <tr key={p.id} className="hover:bg-muted/50">
              <Td className="font-semibold"><span className="mr-1.5">{p.icon||"📦"}</span>{p.name}</Td>
              <Td>{p.unit}</Td>
              <Td className="text-right">{formatCurrency(p.basePrice)}</Td>
              <Td><input type="number" value={newPrice} onChange={e => setPrices(prev => ({...prev, [p.id]: e.target.value}))}
                className="w-20 h-7 bg-background border border-border rounded-md px-2 text-[11px] font-semibold text-fg text-right outline-none focus:border-brand" /></Td>
              <Td className="text-right">{p.gstPercent}%</Td>
              <Td className="text-right font-bold text-brand">{formatCurrency(effective)}</Td>
            </tr>
          );
        })}</tbody>
      </TableCard>
    </>
  );
}
