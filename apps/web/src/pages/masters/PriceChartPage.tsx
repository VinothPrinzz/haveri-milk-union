import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchProducts, getRateCategories } from "@/services/api";
import { ChevronLeft, ChevronRight, Printer } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";

export default function PriceChartPage() {
  const { data: products = [], isLoading } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });
  const rateCategories = getRateCategories();
  const [catIdx, setCatIdx] = useState(0);
  const cat = rateCategories[catIdx];

  return (
    <div>
      <PageHeader title="Price Chart" description="View price charts by rate category" />
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Price Chart — {cat}</CardTitle>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => setCatIdx(Math.max(0, catIdx - 1))} disabled={catIdx === 0}>
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <span className="text-sm text-muted-foreground">{catIdx + 1} / {rateCategories.length}</span>
              <Button variant="outline" size="sm" onClick={() => setCatIdx(Math.min(rateCategories.length - 1, catIdx + 1))} disabled={catIdx === rateCategories.length - 1}>
                <ChevronRight className="h-4 w-4" />
              </Button>
              <Button variant="outline" size="sm" onClick={() => window.print()}><Printer className="h-4 w-4" /></Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading ? <Skeleton className="h-48" /> : (
            <div className="overflow-auto rounded-md border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/30">
                    <th className="text-left py-2.5 px-3 font-medium text-muted-foreground">Code</th>
                    <th className="text-left py-2.5 px-3 font-medium text-muted-foreground">Product</th>
                    <th className="text-left py-2.5 px-3 font-medium text-muted-foreground">Pack</th>
                    <th className="text-right py-2.5 px-3 font-medium text-muted-foreground">MRP</th>
                    <th className="text-right py-2.5 px-3 font-medium text-muted-foreground">Rate ({cat})</th>
                    <th className="text-right py-2.5 px-3 font-medium text-muted-foreground">GST%</th>
                  </tr>
                </thead>
                <tbody>
                  {products.filter(p => !p.terminated).map(p => (
                    <tr key={p.id} className="border-b last:border-0 hover:bg-muted/30">
                      <td className="py-2 px-3 font-mono text-xs">{p.code}</td>
                      <td className="py-2 px-3 font-medium">{p.name}</td>
                      <td className="py-2 px-3">{p.packSize} {p.unit}</td>
                      <td className="py-2 px-3 text-right font-mono">₹{p.mrp}</td>
                      <td className="py-2 px-3 text-right font-mono font-semibold">₹{p.rateCategories[cat] ?? "—"}</td>
                      <td className="py-2 px-3 text-right">{p.gstPercent}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
