import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fetchStockEntries, fetchProducts } from "@/services/api";
import { AlertTriangle, CheckCircle, Package, TrendingDown } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useMemo } from "react";

// Fix 17: StockDashboard - category col, remove opening/closing → current stock, category + search filters
export default function StockDashboard() {
  const { data: stock = [], isLoading } = useQuery({
    queryKey: ["stock"],
    queryFn: () => fetchStockEntries(),        // ← wrap in arrow fn, don't pass context as date
  });
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });

  const [categoryFilter, setCategoryFilter] = useState("all");
  const [search, setSearch] = useState("");

  const categories = [...new Set(stock.map(s => s.category).filter(Boolean))];

  const filtered = useMemo(() => stock.filter(s => {
    const matchCat = categoryFilter === "all" || s.category === categoryFilter;
    const matchSearch = !search || s.productName.toLowerCase().includes(search.toLowerCase());
    return matchCat && matchSearch;
  }), [stock, categoryFilter, search]);

  const totalStock = stock.reduce((sum, s) => sum + s.closing, 0);
  const lowItems = stock.filter(s => s.closing > 0 && s.closing < 50);
  const outOfStock = stock.filter(s => s.closing === 0);
  const healthy = stock.filter(s => s.closing >= 50);

  return (
    <div>
      <PageHeader title="FGS — Stock Overview" description="Current stock levels and alerts" />
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <Card><CardContent className="pt-6"><div className="flex justify-between items-center"><div><p className="text-xs text-muted-foreground">Total Stock</p><p className="text-2xl font-bold">{totalStock}</p></div><Package className="h-8 w-8 text-primary opacity-60" /></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex justify-between items-center"><div><p className="text-xs text-muted-foreground">Products Tracked</p><p className="text-2xl font-bold">{stock.length}</p></div><CheckCircle className="h-8 w-8 text-success opacity-60" /></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex justify-between items-center"><div><p className="text-xs text-muted-foreground">Low Stock</p><p className="text-2xl font-bold">{lowItems.length}</p></div><TrendingDown className="h-8 w-8 text-warning opacity-60" /></div></CardContent></Card>
        <Card><CardContent className="pt-6"><div className="flex justify-between items-center"><div><p className="text-xs text-muted-foreground">Out of Stock</p><p className="text-2xl font-bold">{outOfStock.length}</p></div><AlertTriangle className="h-8 w-8 text-destructive opacity-60" /></div></CardContent></Card>
      </div>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Stock Position</CardTitle>
            {/* Fix 17: category + search filters */}
            <div className="flex items-center gap-2">
              <div className="relative">
                <Input placeholder="Search product..." value={search} onChange={e => setSearch(e.target.value)} className="w-44 pl-8" />
                <svg className="absolute left-2.5 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
              </div>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {categories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? <div className="p-5"><Skeleton className="h-48" /></div> : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <th className="text-left py-2.5 px-3 font-medium">Product</th>
                  {/* Fix 17: category column */}
                  <th className="text-left py-2.5 px-3 font-medium">Category</th>
                  <th className="text-right py-2.5 px-3 font-medium">Received</th>
                  <th className="text-right py-2.5 px-3 font-medium">Dispatched</th>
                  <th className="text-right py-2.5 px-3 font-medium">Wastage</th>
                  {/* Fix 17: "Current Stock" instead of opening/closing */}
                  <th className="text-right py-2.5 px-3 font-medium">Current Stock</th>
                  <th className="text-left py-2.5 px-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => (
                  <tr key={s.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-2 px-3 font-medium">{s.productName.replace("Nandini ", "")}</td>
                    <td className="py-2 px-3"><span className="text-xs px-1.5 py-0.5 rounded bg-secondary">{s.category}</span></td>
                    <td className="py-2 px-3 text-right font-mono text-success">{s.received}</td>
                    <td className="py-2 px-3 text-right font-mono text-destructive">{s.dispatched}</td>
                    <td className="py-2 px-3 text-right font-mono text-warning">{s.wastage}</td>
                    <td className="py-2 px-3 text-right font-mono font-semibold">{s.closing}</td>
                    <td className="py-2 px-3">
                      {s.closing <= 0
                        ? <span className="text-xs px-2 py-0.5 rounded bg-destructive/10 text-destructive">Out</span>
                        : s.closing < 50
                        ? <span className="text-xs px-2 py-0.5 rounded bg-warning/10 text-warning">Low</span>
                        : <span className="text-xs px-2 py-0.5 rounded bg-success/10 text-success">OK</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
