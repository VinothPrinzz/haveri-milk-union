"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, Badge, TableCard, Th, Td, Button } from "@/components/ui";
import { Bell, Download } from "lucide-react";

export default function StockAlertsPage() {
  const { data } = useQuery({ queryKey: ["fgs-alerts"], queryFn: () => api.get("/api/v1/fgs/alerts") });
  const alerts = data?.alerts ?? [];
  return (
    <>
      <PageHeader icon="⚠️" title="Stock Alerts" subtitle="Products below threshold levels"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>} />
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-card rounded-[10px] border-2 border-danger/20 shadow-card p-4 text-center" style={{background:"rgba(220,38,38,.05)"}}>
          <div className="font-display text-[28px] font-black text-danger">{alerts.filter((a:any)=>a.alert_level==="out_of_stock").length}</div><div className="text-[11px] font-semibold text-muted-fg">Out of Stock</div></div>
        <div className="bg-card rounded-[10px] border-2 border-warning/20 shadow-card p-4 text-center" style={{background:"rgba(217,119,6,.05)"}}>
          <div className="font-display text-[28px] font-black text-warning">{alerts.filter((a:any)=>a.alert_level==="low").length}</div><div className="text-[11px] font-semibold text-muted-fg">Low Stock</div></div>
        <div className="bg-card rounded-[10px] border-2 border-danger/20 shadow-card p-4 text-center" style={{background:"rgba(220,38,38,.05)"}}>
          <div className="font-display text-[28px] font-black text-danger">{alerts.filter((a:any)=>a.alert_level==="critical").length}</div><div className="text-[11px] font-semibold text-muted-fg">Critical</div></div>
      </div>
      <TableCard>
        <thead><tr><Th>Product</Th><Th>Category</Th><Th className="text-right">Current Stock</Th><Th className="text-right">Low Threshold</Th><Th className="text-right">Critical Threshold</Th><Th>Alert</Th><Th>Notify</Th></tr></thead>
        <tbody>{alerts.map((a: any) => (
          <tr key={a.id} className="hover:bg-muted/50"><Td className="font-semibold"><span className="mr-1.5">{a.icon}</span>{a.name}</Td><Td>{a.category_name}</Td>
            <Td className={`text-right font-bold ${a.stock===0?"text-danger":"text-warning"}`}>{a.stock}</Td>
            <Td className="text-right text-muted-fg">{a.low_stock_threshold}</Td><Td className="text-right text-muted-fg">{a.critical_stock_threshold}</Td>
            <Td><Badge variant={a.alert_level==="out_of_stock"?"cancelled":a.alert_level==="critical"?"cancelled":"pending"}>{a.alert_level==="out_of_stock"?"Out":a.alert_level==="critical"?"Critical":"Low"}</Badge></Td>
            <Td><button className="p-1.5 rounded-md border border-border hover:bg-muted"><Bell className="h-3.5 w-3.5 text-brand" /></button></Td>
          </tr>
        ))}{alerts.length===0&&<tr><Td colSpan={7} className="text-center py-8 text-muted-fg">No stock alerts — all products are above threshold</Td></tr>}</tbody>
      </TableCard>
    </>
  );
}
