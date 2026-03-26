"use client";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { PageHeader, StatCard, TableCard, Th, Td, Badge, Button } from "@/components/ui";
import { Download } from "lucide-react";

export default function InventoryPage() {
  const { data, isLoading } = useQuery({
    queryKey: ["fgs-overview"],
    queryFn: () => api.get("/api/v1/fgs/overview"),
  });

  const summary = data?.summary;
  const products = data?.products ?? [];

  return (
    <>
      <PageHeader
        icon="🏭"
        title="FGS Stock Overview"
        subtitle="Current finished goods stock levels across all products"
        actions={<Button variant="outline" size="sm"><Download className="h-3.5 w-3.5" /> Export</Button>}
      />

      {/* Summary Cards */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-4 mb-6">
        <StatCard icon="📦" iconBg="bg-brand-light text-brand" value={summary?.totalProducts ?? 0} label="Total Products" />
        <StatCard icon="🚫" iconBg="bg-danger/10 text-danger" value={summary?.outOfStock ?? 0} label="Out of Stock" />
        <StatCard icon="🔴" iconBg="bg-danger/10 text-danger" value={summary?.critical ?? 0} label="Critical" />
        <StatCard icon="🟡" iconBg="bg-warning/10 text-warning" value={summary?.low ?? 0} label="Low Stock" />
        <StatCard icon="🟢" iconBg="bg-success/10 text-success" value={summary?.healthy ?? 0} label="Healthy Stock" />
      </div>

      {/* Stock Table */}
      <TableCard>
        <thead>
          <tr>
            <Th>Product</Th>
            <Th>Category</Th>
            <Th className="text-right">Current Stock</Th>
            <Th className="text-right">Low Threshold</Th>
            <Th className="text-right">Critical Threshold</Th>
            <Th>Status</Th>
          </tr>
        </thead>
        <tbody>
          {products.map((p: any) => (
            <tr key={p.id} className="hover:bg-muted/50 transition-colors">
              <Td className="font-semibold">
                <span className="mr-1.5">{p.icon}</span>{p.name}
              </Td>
              <Td>{p.category_name}</Td>
              <Td className={`text-right font-bold ${p.stock === 0 ? "text-danger" : p.stock <= p.critical_stock_threshold ? "text-danger" : p.stock <= p.low_stock_threshold ? "text-warning" : "text-fg"}`}>
                {p.stock}
              </Td>
              <Td className="text-right text-muted-fg">{p.low_stock_threshold}</Td>
              <Td className="text-right text-muted-fg">{p.critical_stock_threshold}</Td>
              <Td>
                <Badge variant={
                  p.stock_status === "out_of_stock" ? "cancelled" :
                  p.stock_status === "critical" ? "cancelled" :
                  p.stock_status === "low" ? "pending" : "active"
                }>
                  {p.stock_status === "out_of_stock" ? "Out" :
                   p.stock_status === "critical" ? "Critical" :
                   p.stock_status === "low" ? "Low" : "OK"}
                </Badge>
              </Td>
            </tr>
          ))}
        </tbody>
      </TableCard>
    </>
  );
}
