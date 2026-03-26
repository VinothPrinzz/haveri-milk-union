"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, StatCard, TableCard, Th, Td, Badge } from "@/components/ui";
import { Search } from "lucide-react";
import { useState } from "react";
import { cn } from "@/lib/utils";

const STATUS_FILTERS = ["All", "Out of Stock", "Critical", "Low", "Healthy"];
const statusMap: Record<string, string> = { "Out of Stock": "out_of_stock", "Critical": "critical", "Low": "low", "Healthy": "healthy" };

export default function InventoryPage() {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("All");
  const { data } = useQuery({ queryKey: ["fgs-overview"], queryFn: () => api.get("/api/v1/fgs/overview") });
  const summary = data?.summary;
  let products = data?.products ?? [];
  if (search) products = products.filter((p: any) => p.name.toLowerCase().includes(search.toLowerCase()));
  if (statusFilter !== "All") products = products.filter((p: any) => p.stock_status === statusMap[statusFilter]);

  return (
    <>
      <PageHeader icon="🏭" title="FGS Stock Overview" subtitle="Current finished goods stock levels across all products" />
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <StatCard icon="📦" iconBg="bg-brand-light text-brand" value={summary?.totalProducts ?? 0} label="Total Products" />
        <StatCard icon="🚫" iconBg="bg-danger/10 text-danger" value={summary?.outOfStock ?? 0} label="Out of Stock" />
        <StatCard icon="🔴" iconBg="bg-danger/10 text-danger" value={summary?.critical ?? 0} label="Critical" />
        <StatCard icon="🟡" iconBg="bg-warning/10 text-warning" value={summary?.low ?? 0} label="Low Stock" />
        <StatCard icon="🟢" iconBg="bg-success/10 text-success" value={summary?.healthy ?? 0} label="Healthy Stock" />
      </div>
      <div className="flex flex-wrap items-center gap-3 mb-5">
        <div className="flex items-center gap-2 bg-card border border-border rounded-lg px-3 py-2 w-56"><Search className="h-3.5 w-3.5 text-muted-fg" /><input type="text" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search products..." className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div>
        <div className="flex gap-2">{STATUS_FILTERS.map(f => (
          <button key={f} onClick={() => setStatusFilter(f)} className={cn("px-3 py-1.5 rounded-full text-[10px] font-bold border transition-colors", statusFilter === f ? "bg-brand border-brand text-white" : "bg-card border-border text-muted-fg hover:border-brand/30")}>{f}</button>
        ))}</div>
      </div>
      <TableCard>
        <thead><tr><Th>Product</Th><Th>Category</Th><Th className="text-right">Current Stock</Th><Th className="text-right">Low Threshold</Th><Th className="text-right">Critical Threshold</Th><Th>Status</Th></tr></thead>
        <tbody>{products.map((p: any) => (
          <tr key={p.id} className="hover:bg-muted/50"><Td className="font-semibold"><span className="mr-1.5">{p.icon}</span>{p.name}</Td><Td>{p.category_name}</Td>
            <Td className={`text-right font-bold ${p.stock===0?"text-danger":p.stock<=p.critical_stock_threshold?"text-danger":p.stock<=p.low_stock_threshold?"text-warning":"text-fg"}`}>{p.stock}</Td>
            <Td className="text-right text-muted-fg">{p.low_stock_threshold}</Td><Td className="text-right text-muted-fg">{p.critical_stock_threshold}</Td>
            <Td><Badge variant={p.stock_status==="out_of_stock"?"cancelled":p.stock_status==="critical"?"cancelled":p.stock_status==="low"?"pending":"active"}>{p.stock_status==="out_of_stock"?"Out":p.stock_status==="critical"?"Critical":p.stock_status==="low"?"Low":"OK"}</Badge></Td></tr>
        ))}</tbody>
      </TableCard>
    </>
  );
}
