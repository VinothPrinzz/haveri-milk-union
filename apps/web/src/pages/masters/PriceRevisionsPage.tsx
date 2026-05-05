// ════════════════════════════════════════════════════════════════════
// Price Revisions — bulk rate updates with effective date
// Route preserved: /masters/price-revisions
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, Field, EmptyState, StatusPill, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Save, X } from "lucide-react";
import {
  fetchProducts, 
  getRateCategories,
  fetchPriceRevisions, 
  createPriceRevisions,
  type Product,
} from "@/services/api";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";

const fetchRateCategories = () => getRateCategories().map((name, i) => ({ id: String(i), name }));

interface Draft {
  productId: string;
  rateCategoryId: string;
  newRate: number;
}

export default function PriceRevisionsPage() {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });
  const { data: categories = [] } = useQuery({ queryKey: ["rate-categories"], queryFn: fetchRateCategories });
  const { data: revisionsRaw, isLoading: isLoadingHistory } = useQuery({
    queryKey: ["price-revisions"],
    queryFn: () => fetchPriceRevisions(),
  });
  const revisions = (revisionsRaw as any)?.data ?? [];

  const [effectiveFrom, setEffectiveFrom] = useState(today);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [productSel, setProductSel] = useState("");
  const [catSel, setCatSel] = useState("");
  const [rate, setRate] = useState("");

  // F9 Product Options
  const productOpts: F9Option[] = useMemo(
    () => products.map((p: any) => ({
      value: p.id,
      label: p.name,
      sublabel: p.code,
    })),
    [products]
  );

  const createMutation = useMutation({
    mutationFn: (payload: { effectiveFrom: string; lines: Draft[] }) => createPriceRevisions({
      revisions: payload.lines.map(l => ({
        productId: l.productId,
        newPrice: l.newRate,
        effectiveFrom: payload.effectiveFrom,
      })),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["price-revisions"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Revision saved");
      setDrafts([]);
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const productById = useMemo(() => {
    const m = new Map<string, Product>();
    products.forEach((p: Product) => m.set(p.id, p));
    return m;
  }, [products]);

  const addLine = () => {
    if (!productSel || !catSel || !rate) return;
    setDrafts(d => [...d, { productId: productSel, rateCategoryId: catSel, newRate: parseFloat(rate) }]);
    setProductSel(""); 
    setCatSel(""); 
    setRate("");
  };

  const removeLine = (i: number) => setDrafts(d => d.filter((_, idx) => idx !== i));

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Price Revisions" subtitle="Schedule bulk rate updates with an effective date" />

      <div className="p-3 space-y-3">
        <div className="erp-panel p-3">
          <h3 className="erp-section-title mb-2">New Revision</h3>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
            <Field label="Effective From" required>
              <Input 
                type="date" 
                className="erp-input" 
                value={effectiveFrom} 
                onChange={e => setEffectiveFrom(e.target.value)} 
              />
            </Field>

            {/* Updated: F9 Product Picker */}
            <Field label="Product" hint="F9" required>
              <F9SearchSelect
                value={productSel}
                onChange={v => setProductSel(v ?? "")}
                options={productOpts}
              />
            </Field>

            <Field label="Rate Category">
              <Select value={catSel} onValueChange={setCatSel}>
                <SelectTrigger className="erp-input"><SelectValue placeholder="Pick…" /></SelectTrigger>
                <SelectContent>
                  {categories.map((c: any) => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>

            <Field label="New Rate ₹">
              <Input 
                type="number" 
                step="0.01" 
                className="erp-input text-right tabular-nums" 
                value={rate} 
                onChange={e => setRate(e.target.value)} 
              />
            </Field>

            <div className="flex items-end">
              <Button 
                size="sm" 
                className="h-9" 
                onClick={addLine} 
                disabled={!productSel || !catSel || !rate}
              >
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Line
              </Button>
            </div>
          </div>

          {drafts.length > 0 && (
            <div className="mt-3 erp-panel overflow-hidden">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>Rate Category</th>
                    <th className="num" style={{ width: 140, textAlign: "right" }}>New Rate</th>
                    <th style={{ width: 70, textAlign: "center" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map((d, i) => (
                    <tr key={i}>
                      <td className="font-medium">
                        {productById.get(d.productId)?.name ?? d.productId}
                      </td>
                      <td>
                        {categories.find((c: any) => c.id === d.rateCategoryId)?.name ?? d.rateCategoryId}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(d.newRate)}</td>
                      <td style={{ textAlign: "center" }}>
                        <Button 
                          variant="ghost" 
                          size="icon" 
                          className="h-7 w-7 text-destructive" 
                          onClick={() => removeLine(i)}
                        >
                          <X className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-3 flex gap-2 justify-end">
            <Button 
              size="sm" 
              variant="outline" 
              className="h-8" 
              onClick={() => setDrafts([])} 
              disabled={drafts.length === 0}
            >
              Clear Lines
            </Button>
            <Button 
              size="sm" 
              className="h-8"
              disabled={drafts.length === 0 || createMutation.isPending}
              onClick={() => createMutation.mutate({ effectiveFrom, lines: drafts })}
            >
              <Save className="h-3.5 w-3.5 mr-1" />
              {createMutation.isPending ? "Saving…" : `Save Revision (${drafts.length})`}
            </Button>
          </div>
        </div>

        {/* Past Revisions - Updated History Table */}
        <div className="erp-panel overflow-hidden">
          <h3 className="erp-section-title px-3 pt-3">Past Revisions</h3>
          
          {isLoadingHistory ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : revisions.length === 0 ? (
            <EmptyState title="No price revisions recorded yet." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 110 }}>Effective</th>
                  <th>Code</th>
                  <th>Product</th>
                  <th>Unit</th>
                  <th className="num" style={{ width: 120, textAlign: "right" }}>Old Rate</th>
                  <th className="num" style={{ width: 120, textAlign: "right" }}>New Rate</th>
                  <th className="num" style={{ width: 80, textAlign: "right" }}>Δ</th>
                  <th className="num" style={{ width: 80, textAlign: "right" }}>Old GST</th>
                  <th className="num" style={{ width: 80, textAlign: "right" }}>New GST</th>
                  <th>Changed By</th>
                  <th>Reason</th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((r: any) => {
                  const oldPrice = parseFloat(r.oldPrice ?? "0") || 0;
                  const newPrice = parseFloat(r.newPrice ?? "0") || 0;
                  const diff = newPrice - oldPrice;
                  return (
                    <tr key={r.id}>
                      <td className="text-[12.5px]">{fmtDate(r.effectiveFrom)}</td>
                      <td className="font-mono text-[12px]">{r.productCode ?? "—"}</td>
                      <td className="font-medium">{r.productName ?? "—"}</td>
                      <td>{r.unit ?? "—"}</td>
                      <td className="num" style={{ textAlign: "right" }}>
                        <span className="text-muted-foreground">{fmtINR(oldPrice)}</span>
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        <span className={`font-semibold ${newPrice > oldPrice ? "text-success" : newPrice < oldPrice ? "text-destructive" : ""}`}>
                          {fmtINR(newPrice)}
                        </span>
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>
                        <span className="text-[12px]">
                          {diff > 0 ? `+${diff.toFixed(2)}` : diff.toFixed(2)}
                        </span>
                      </td>
                      <td className="num text-muted-foreground text-[12px]" style={{ textAlign: "right" }}>
                        {(parseFloat(r.oldGst ?? "0") || 0).toFixed(2)}%
                      </td>
                      <td className="num text-[12px]" style={{ textAlign: "right" }}>
                        {(parseFloat(r.newGst ?? "0") || 0).toFixed(2)}%
                      </td>
                      <td>{r.changedByName ?? "—"}</td>
                      <td>{r.reason || <span className="text-muted-foreground">—</span>}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}