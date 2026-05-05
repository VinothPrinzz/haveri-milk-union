// ════════════════════════════════════════════════════════════════════
// Price Chart — read-only matrix of products × rate-categories
// Route preserved: /masters/price-chart
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader, { FilterBar, Field, EmptyState, fmtINR } from "@/components/PageHeader";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Printer, Search } from "lucide-react";
import { fetchProducts, getRateCategories, type Product } from "@/services/api";

const fetchRateCategories = () => getRateCategories().map((name, i) => ({ id: String(i), name }));

export default function PriceChartPage() {
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });
  const { data: categories = [] } = useQuery({ queryKey: ["rate-categories"], queryFn: fetchRateCategories });
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return products;
    return products.filter((p: Product) =>
      p.name?.toLowerCase().includes(s) ||
      p.code?.toLowerCase().includes(s)
    );
  }, [products, q]);

  const rateOf = (p: Product, catName: string) =>
    (p.rateCategories ?? {})[catName] ?? p.mrp ?? 0;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Price Chart"
        subtitle="Effective prices per rate-category"
        actions={
          <Button size="sm" variant="outline" className="h-8" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5 mr-1" /> Print (Ctrl+P)
          </Button>
        }
      />
      <FilterBar>
        <Field label="Search">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="erp-input pl-7 w-72" placeholder="Search product…" value={q} onChange={e => setQ(e.target.value)} />
          </div>
        </Field>
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {filtered.length === 0 ? (
            <EmptyState title="No products found." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Code</th>
                  <th>Product</th>
                  <th style={{ width: 110 }}>Pack</th>
                  <th className="num" style={{ width: 110, textAlign: "right" }}>Base ₹</th>
                  {categories.map((c: any) => (
                    <th key={c.id} className="num" style={{ textAlign: "right" }}>{c.name} ₹</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((p: Product) => (
                  <tr key={p.id}>
                    <td className="font-mono">{p.code}</td>
                    <td className="font-medium">{p.name}</td>
                    <td className="text-[12.5px]">{p.packSize ?? "—"}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(p.mrp ?? 0)}</td>
                    {categories.map((c: any) => (
                      <td key={c.id} className="num" style={{ textAlign: "right" }}>{fmtINR(rateOf(p, c.name))}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}