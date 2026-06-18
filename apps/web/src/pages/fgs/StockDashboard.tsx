// ════════════════════════════════════════════════════════════════════
// FGS — Stock Overview
// Route preserved: /fgs/stock
// ════════════════════════════════════════════════════════════════════
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader, {
  FilterBar,
  StatCard,
  EmptyState,
  fmtNum,
} from "@/components/PageHeader";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Package, TrendingDown, AlertCircle, CheckCircle, Search } from "lucide-react";
import { fetchStockEntries, fetchProducts } from "@/services/api";

const today = () => new Date().toISOString().split("T")[0];

export default function StockDashboard() {
  const [filterDate, setFilterDate] = useState(today());
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const { data: stock = [], isLoading } = useQuery({
    queryKey: ["stock-entries", filterDate],
    queryFn: () => fetchStockEntries(filterDate),
  });

  const { data: products = [] } = useQuery({
    queryKey: ["products"],
    queryFn: fetchProducts,
  });

  const categories = useMemo(() => {
    const set = new Set<string>();
    (stock as any[]).forEach((s: any) => s.category && set.add(s.category));
    return Array.from(set).sort();
  }, [stock]);

  const filtered = useMemo(() => {
    return (stock as any[]).filter((s: any) => {
      const matchCat = categoryFilter === "all" || s.category === categoryFilter;
      const matchSearch = !search || (s.productName || "").toLowerCase().includes(search.toLowerCase());
      return matchCat && matchSearch;
    });
  }, [stock, categoryFilter, search]);

  const totalStock = (stock as any[]).reduce((sum: number, s: any) => sum + (Number(s.closing) || 0), 0);
  const lowItems = (stock as any[]).filter((s: any) => s.closing > 0 && s.closing < 50);
  const outOfStock = (stock as any[]).filter((s: any) => s.closing === 0);
  const healthy = (stock as any[]).filter((s: any) => s.closing >= 50);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="FGS — Stock Overview"
        subtitle="Current stock levels and alerts"
      />

      <FilterBar>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Date</label>
          <Input
            type="date"
            value={filterDate}
            onChange={e => setFilterDate(e.target.value)}
            className="erp-input w-40"
          />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Category</label>
          <Select value={categoryFilter} onValueChange={setCategoryFilter}>
            <SelectTrigger className="erp-input w-40"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {categories.map(c => <SelectItem key={c} value={c}>{c}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="flex-1 min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Search</label>
          <div className="relative">
            <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
            <Input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search products…"
              className="erp-input pl-7 w-full"
            />
          </div>
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label="Total Stock" value={fmtNum(totalStock)} icon={<Package className="h-5 w-5" />} tone="default" />
          <StatCard label="Products Tracked" value={fmtNum((stock as any[]).length)} icon={<CheckCircle className="h-5 w-5" />} tone="success" />
          <StatCard label="Low Stock" value={fmtNum(lowItems.length)} icon={<TrendingDown className="h-5 w-5" />} tone="warning" />
          <StatCard label="Out of Stock" value={fmtNum(outOfStock.length)} icon={<AlertCircle className="h-5 w-5" />} tone="danger" />
        </div>

        <div className="erp-panel overflow-hidden">
          <div className="print-document">
            <div className="px-3 py-2 border-b border-border bg-muted/40 flex items-center justify-between">
              <h3 className="erp-section-title">Stock by Product</h3>
              <span className="text-[12px] text-muted-foreground">{filtered.length} of {(stock as any[]).length} items</span>
            </div>

            {isLoading ? (
              <div className="p-4 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState title="No stock entries match your filter" />
            ) : (
              <div className="overflow-auto">
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Category</th>
                      <th>Unit</th>
                      <th className="num" style={{ textAlign: "right" }}>Stock</th>
                      <th className="num" style={{ textAlign: "right" }}>Low ≤</th>
                      <th className="num" style={{ textAlign: "right" }}>Crit ≤</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((s: any) => (
                      <tr 
                        key={s.id ?? s.productId}
                        className={
                          s.stock_status === "out_of_stock" ? "border-l-2 border-l-destructive" :
                          s.stock_status === "critical" ? "border-l-2 border-l-destructive/60" :
                          s.stock_status === "low" ? "border-l-2 border-l-warning" : ""
                        }
                      >
                        <td className="font-medium">{s.productName}</td>
                        <td className="text-muted-foreground uppercase">{s.category ?? "—"}</td>
                        <td>{s.unit ?? "—"}</td>
                        <td className="num font-semibold" style={{ textAlign: "right" }}>{fmtNum(s.closing ?? s.stock ?? 0)}</td>
                        <td className="num text-muted-foreground" style={{ textAlign: "right" }}>{fmtNum(s.low_stock_threshold ?? "—")}</td>
                        <td className="num text-muted-foreground" style={{ textAlign: "right" }}>{fmtNum(s.critical_stock_threshold ?? "—")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}