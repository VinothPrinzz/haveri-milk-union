// apps/web/src/pages/masters/PriceChartPage.tsx
// ════════════════════════════════════════════════════════════════════
// Price Chart — three-tier pricing
// Columns: Basic Price · Dealer Price · GST (Dealer − Basic, auto) · MRP
//
// Fix B9: Print produced a blank page because the global print CSS
// (apps/web/src/index.css) hides everything by default and only shows
// elements inside `.print-document`. The table stays wrapped in that
// class with a `print-only` letterhead.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader, { FilterBar, Field, EmptyState, fmtINR } from "@/components/PageHeader";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Printer, Search } from "lucide-react";
import { fetchProducts, type Product } from "@/services/api";

export default function PriceChartPage() {
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return products;
    return products.filter((p: Product) =>
      p.name?.toLowerCase().includes(s) ||
      p.code?.toLowerCase().includes(s),
    );
  }, [products, q]);

  // GST amount in ₹ is auto-calculated: Dealer-Price − Basic Price
  // (Basic Price is the dealer price excluding GST). Never stored.
  const gstAmountOf = (p: Product) => (p.dealerPrice ?? 0) - (p.basePrice ?? 0);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Price Chart"
        subtitle="Basic Price · Dealer Price · GST · MRP"
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
            <Input
              className="erp-input pl-7 w-72"
              placeholder="Search product…"
              value={q}
              onChange={e => setQ(e.target.value)}
            />
          </div>
        </Field>
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        {/* B9: wrap in .print-document so global print CSS shows it */}
        <div className="erp-panel overflow-hidden print-document">
          {/* Letterhead — visible only when printing */}
          <div className="print-only print-header px-3 py-3 text-center">
            <div className="font-bold text-[15pt]">HAVERI MILK UNION</div>
            <div className="text-[11pt]">Price Chart</div>
            <div className="text-[10pt] text-muted-foreground">
              Generated {new Date().toLocaleDateString("en-IN")} {new Date().toLocaleTimeString("en-IN")}
            </div>
          </div>

          {filtered.length === 0 ? (
            <EmptyState title="No products found." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 90 }}>Code</th>
                  <th>Product</th>
                  <th style={{ width: 100 }}>Pack</th>
                  <th className="num" style={{ width: 120, textAlign: "right" }}>Basic Price ₹</th>
                  <th className="num" style={{ width: 110, textAlign: "right" }}>GST ₹</th>
                  <th className="num" style={{ width: 120, textAlign: "right" }}>Retail-Dealer ₹</th>
                  <th className="num" style={{ width: 110, textAlign: "right" }}>MRP ₹</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p: Product) => {
                  const gstAmount = gstAmountOf(p);
                  return (
                    <tr key={p.id}>
                      <td className="font-mono">{p.code}</td>
                      <td className="font-medium">{p.name}</td>
                      <td className="text-[12.5px]">{p.packSize != null ? `${p.packSize}${p.unit ? ` ${p.unit}` : ""}` : "—"}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(p.basePrice ?? 0)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(gstAmount)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(p.dealerPrice ?? 0)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(p.mrp ?? 0)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}

          {/* Footer for print */}
          <div className="print-only print-footer px-3 py-2 text-[9pt] text-muted-foreground border-t mt-2">
            {filtered.length} product(s) · Haveri Milk Union — System Generated
          </div>
        </div>
      </div>
    </div>
  );
}