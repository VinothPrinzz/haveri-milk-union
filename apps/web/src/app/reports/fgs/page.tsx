"use client";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, TableCard, Th, Td, Button } from "@/components/ui";
import { Download } from "lucide-react";
import { exportCSV } from "@/lib/export";
export default function FGSMovementPage() {
  const [dateFrom, setDateFrom] = useState(""); const [dateTo, setDateTo] = useState("");
  const { data } = useQuery({ queryKey: ["report-fgs", dateFrom], queryFn: () => api.get("/api/v1/reports/fgs-movement", { dateFrom: dateFrom||undefined, dateTo: dateTo||undefined }) });
  const products = data?.data ?? [];
  const handleExport = () => exportCSV(products.map((p: any) => ({ Product: p.name, Category: p.category_name, Opening: p.opening, Received: p.received, Dispatched: p.dispatched, Wastage: p.wastage, Closing: p.closing })), "fgs_movement");
  return (
    <>
      <PageHeader icon="📦" title="FGS Movement" subtitle="Finished goods stock movement tracking"
        actions={<Button variant="outline" size="sm" onClick={handleExport}><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="flex items-center gap-2 mb-6"><span className="text-[11px] font-semibold text-muted-fg">Period:</span><input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /><span className="text-[10px] text-muted-fg">to</span><input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[10px] font-medium outline-none" /></div>
      <TableCard>
        <thead><tr><Th>Product</Th><Th>Category</Th><Th className="text-right">Opening</Th><Th className="text-right">Received</Th><Th className="text-right">Dispatched</Th><Th className="text-right">Wastage</Th><Th className="text-right">Closing</Th></tr></thead>
        <tbody>{products.map((p: any) => (<tr key={p.id} className="hover:bg-muted/50"><Td className="font-semibold"><span className="mr-1.5">{p.icon}</span>{p.name}</Td><Td>{p.category_name}</Td><Td className="text-right">{p.opening}</Td><Td className="text-right text-success font-semibold">{p.received>0?`+${p.received}`:"—"}</Td><Td className="text-right text-danger font-semibold">{p.dispatched>0?`-${p.dispatched}`:"—"}</Td><Td className="text-right text-muted-fg">{p.wastage>0?`-${p.wastage}`:"—"}</Td><Td className="text-right font-bold">{p.closing}</Td></tr>))}</tbody>
      </TableCard>
    </>
  );
}
