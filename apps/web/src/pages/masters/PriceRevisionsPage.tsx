// ════════════════════════════════════════════════════════════════════
// Price Revisions — change a product's Dealer Price and MRP
// Route preserved: /masters/price-revisions
//
// A revision is effective the moment it is saved. The server re-derives the
// basic (net) price from the new Dealer Price, exactly as an edit on All
// Products does, so the Price Chart, the dealer app and billing move
// together. Orders already placed keep the price they were placed at.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  Field, EmptyState, fmtPrice, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus, Save, X } from "lucide-react";
import {
  fetchProducts,
  fetchPriceRevisions,
  createPriceRevisions,
  type Product,
} from "@/services/api";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { todayIST } from "@/lib/istDate";

interface Draft {
  productId: string;
  newDealerPrice: number;
  newMrp: number;
}

/** Basic (net) price the server will derive from a GST-inclusive Dealer Price. */
function basicFromDealer(dealerPrice: number, gstPercent: number): number {
  const gst = Math.max(0, gstPercent || 0);
  return Math.round((dealerPrice / (1 + gst / 100)) * 100) / 100;
}

// Compare money in paise so 12.3 and 12.30 are the same price.
const paise = (n: number) => Math.round(n * 100);

function toNum(v: string | null | undefined): number | null {
  const n = parseFloat(v ?? "");
  return Number.isFinite(n) ? n : null;
}

// Green for a rise, red for a cut.
function changeTone(oldV: number | null, newV: number | null): string {
  if (oldV == null || newV == null) return "";
  return newV > oldV ? "text-success" : newV < oldV ? "text-destructive" : "";
}

export default function PriceRevisionsPage() {
  const qc = useQueryClient();
  const today = todayIST();

  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });
  const { data: revisionsRaw, isLoading: isLoadingHistory, error: historyError } = useQuery({
    queryKey: ["price-revisions"],
    queryFn: () => fetchPriceRevisions(),
  });
  const revisions = revisionsRaw?.data ?? [];

  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [productSel, setProductSel] = useState("");
  const [dealerPriceInput, setDealerPriceInput] = useState("");
  const [mrpInput, setMrpInput] = useState("");
  const [reason, setReason] = useState("");

  const productMap = useMemo(() => {
    const m = new Map<string, Product>();
    products.forEach(p => m.set(p.id, p));
    return m;
  }, [products]);

  // F9 Product Options
  const productOpts: F9Option[] = useMemo(
    () => products.map(p => ({ value: p.id, label: p.name, sublabel: p.code })),
    [products],
  );

  const selected = productSel ? productMap.get(productSel) : undefined;

  // Picking a product pre-fills its current prices (or the line already
  // queued for it, so re-picking edits that line).
  const pickProduct = (id: string) => {
    setProductSel(id);
    const p = productMap.get(id);
    const queued = drafts.find(d => d.productId === id);
    setDealerPriceInput(queued ? String(queued.newDealerPrice) : p ? String(p.dealerPrice) : "");
    setMrpInput(queued ? String(queued.newMrp) : p ? String(p.mrp) : "");
  };

  const newDealerPrice = toNum(dealerPriceInput);
  const newMrp = toNum(mrpInput);

  const lineError = selected
    ? newDealerPrice == null || newDealerPrice <= 0
      ? "Enter a Dealer Price."
      : newMrp == null || newMrp <= 0
      ? "Enter an MRP."
      : paise(newMrp) < paise(newDealerPrice)
      ? "MRP cannot be below the Dealer Price."
      : paise(newDealerPrice) === paise(selected.dealerPrice) && paise(newMrp) === paise(selected.mrp)
      ? "Same as the current prices. Change the Dealer Price or the MRP."
      : null
    : null;

  const addLine = () => {
    if (!selected || lineError || newDealerPrice == null || newMrp == null) return;
    const line: Draft = {
      productId: selected.id,
      newDealerPrice: paise(newDealerPrice) / 100,
      newMrp: paise(newMrp) / 100,
    };
    // One line per product: a re-added product replaces its earlier line.
    setDrafts(prev => [...prev.filter(d => d.productId !== line.productId), line]);
    setProductSel("");
    setDealerPriceInput("");
    setMrpInput("");
  };

  const removeLine = (productId: string) => setDrafts(prev => prev.filter(d => d.productId !== productId));

  const save = useMutation({
    mutationFn: () =>
      createPriceRevisions({
        revisions: drafts.map(d => ({
          productId: d.productId,
          newDealerPrice: d.newDealerPrice,
          newMrp: d.newMrp,
        })),
        reason: reason.trim() || undefined,
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: ["price-revisions"] });
      qc.invalidateQueries({ queryKey: ["products"] });
      if (res.results.length === 0) toast.info(res.message);
      else toast.success(res.message);
      setDrafts([]);
      setReason("");
    },
    onError: (e: any) => toast.error(e?.message || "Could not save the revision"),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Price Revisions"
        subtitle="Change Dealer Price and MRP. Takes effect as soon as it is saved."
      />

      <div className="p-3 space-y-3">
        <div className="erp-panel p-3">
          <h3 className="erp-section-title mb-2">New Revision</h3>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-2">
            <Field label="Product" hint="F9" required className="md:col-span-2">
              <F9SearchSelect
                value={productSel}
                onChange={v => (v ? pickProduct(v) : setProductSel(""))}
                options={productOpts}
                modalTitle="Select product"
              />
            </Field>
            <Field label="New Dealer Price ₹ (incl. GST)" required>
              <Input
                type="number"
                step="0.01"
                min="0"
                className="erp-input text-right tabular-nums"
                value={dealerPriceInput}
                disabled={!selected}
                onChange={e => setDealerPriceInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") { e.preventDefault(); addLine(); }
                }}
              />
            </Field>
            <Field label="New MRP ₹" required>
              <Input
                type="number"
                step="0.01"
                min="0"
                className="erp-input text-right tabular-nums"
                value={mrpInput}
                disabled={!selected}
                onChange={e => setMrpInput(e.target.value)}
                onKeyDown={e => {
                  if (e.key === "Enter") { e.preventDefault(); addLine(); }
                }}
              />
            </Field>
            <div className="flex items-end">
              <Button size="sm" className="h-9" onClick={addLine} disabled={!selected || !!lineError}>
                <Plus className="h-3.5 w-3.5 mr-1" /> Add Line
              </Button>
            </div>
          </div>

          {selected && (
            <div className="mt-2 text-[12.5px] text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
              <span>Current Dealer Price: <b className="text-foreground tabular-nums">{fmtPrice(selected.dealerPrice)}</b></span>
              <span>Current MRP: <b className="text-foreground tabular-nums">{fmtPrice(selected.mrp)}</b></span>
              <span>GST: <b className="text-foreground tabular-nums">{Number(selected.gstPercent).toFixed(2)}%</b></span>
              <span>Current Basic Price: <b className="text-foreground tabular-nums">{fmtPrice(selected.basePrice)}</b></span>
              {newDealerPrice != null && newDealerPrice > 0 && (
                <span>
                  New Basic Price: <b className="text-foreground tabular-nums">{fmtPrice(basicFromDealer(newDealerPrice, selected.gstPercent))}</b>
                </span>
              )}
              {lineError && <span className="text-destructive">{lineError}</span>}
            </div>
          )}

          {drafts.length > 0 && (
            <div className="mt-3 erp-panel overflow-x-auto">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th style={{ width: 90 }}>Code</th>
                    <th>Product</th>
                    <th className="num" style={{ width: 120, textAlign: "right" }}>Dealer Price</th>
                    <th className="num" style={{ width: 130, textAlign: "right" }}>New Dealer Price</th>
                    <th className="num" style={{ width: 110, textAlign: "right" }}>MRP</th>
                    <th className="num" style={{ width: 110, textAlign: "right" }}>New MRP</th>
                    <th className="num" style={{ width: 130, textAlign: "right" }}>New Basic Price</th>
                    <th style={{ width: 50, textAlign: "center" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {drafts.map(d => {
                    const p = productMap.get(d.productId);
                    return (
                      <tr key={d.productId}>
                        <td className="font-mono text-[12px]">{p?.code ?? ""}</td>
                        <td className="font-medium">{p?.name ?? d.productId}</td>
                        <td className="num text-muted-foreground" style={{ textAlign: "right" }}>
                          {p ? fmtPrice(p.dealerPrice) : ""}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          <span className={`font-semibold ${changeTone(p?.dealerPrice ?? null, d.newDealerPrice)}`}>
                            {fmtPrice(d.newDealerPrice)}
                          </span>
                        </td>
                        <td className="num text-muted-foreground" style={{ textAlign: "right" }}>
                          {p ? fmtPrice(p.mrp) : ""}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          <span className={`font-semibold ${changeTone(p?.mrp ?? null, d.newMrp)}`}>
                            {fmtPrice(d.newMrp)}
                          </span>
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          {p ? fmtPrice(basicFromDealer(d.newDealerPrice, p.gstPercent)) : ""}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-7 w-7 text-destructive"
                            onClick={() => removeLine(d.productId)}
                            aria-label="Remove line"
                          >
                            <X className="h-3.5 w-3.5" />
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <div className="mt-3 flex flex-col md:flex-row md:items-end gap-2">
            <Field label="Reason (optional)" className="flex-1">
              <Input
                className="erp-input"
                value={reason}
                maxLength={500}
                placeholder="e.g. Milk procurement price revision"
                onChange={e => setReason(e.target.value)}
              />
            </Field>
            <div className="flex gap-2 justify-end">
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                onClick={() => setDrafts([])}
                disabled={drafts.length === 0 || save.isPending}
              >
                Clear Lines
              </Button>
              <Button
                size="sm"
                className="h-9"
                disabled={drafts.length === 0 || save.isPending}
                onClick={() => save.mutate()}
              >
                <Save className="h-3.5 w-3.5 mr-1" />
                {save.isPending ? "Saving…" : `Save Revision (${drafts.length})`}
              </Button>
            </div>
          </div>
          <p className="mt-2 text-[12px] text-muted-foreground">
            Effective today ({fmtDate(today)}), as soon as you save. Orders already placed keep the price they were placed at.
          </p>
        </div>

        <div className="erp-panel overflow-hidden">
          <h3 className="erp-section-title px-3 pt-3">Past Revisions</h3>
          {isLoadingHistory ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 6 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : historyError ? (
            <EmptyState title="Could not load the price history." hint={(historyError as Error).message} />
          ) : revisions.length === 0 ? (
            <EmptyState title="No price revisions recorded yet." />
          ) : (
            <div className="overflow-x-auto">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th style={{ width: 110 }}>Effective</th>
                    <th style={{ width: 90 }}>Code</th>
                    <th>Product</th>
                    <th className="num" style={{ width: 115, textAlign: "right" }}>Old Dealer Price</th>
                    <th className="num" style={{ width: 115, textAlign: "right" }}>New Dealer Price</th>
                    <th className="num" style={{ width: 80, textAlign: "right" }}>Change</th>
                    <th className="num" style={{ width: 100, textAlign: "right" }}>Old MRP</th>
                    <th className="num" style={{ width: 100, textAlign: "right" }}>New MRP</th>
                    <th className="num" style={{ width: 110, textAlign: "right" }}>GST %</th>
                    <th>Changed By</th>
                    <th>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {revisions.map(r => {
                    const oldDp = toNum(r.oldDealerPrice);
                    const newDp = toNum(r.newDealerPrice);
                    const oldMrp = toNum(r.oldMrp);
                    const newMrp = toNum(r.newMrp);
                    const change = oldDp != null && newDp != null ? newDp - oldDp : null;
                    const oldGst = toNum(r.oldGst) ?? 0;
                    const newGst = toNum(r.newGst) ?? 0;
                    return (
                      <tr key={r.id}>
                        <td className="text-[12.5px]">{fmtDate(r.effectiveFrom)}</td>
                        <td className="font-mono text-[12px]">{r.productCode ?? ""}</td>
                        <td className="font-medium">{r.productName ?? ""}</td>
                        <td className="num text-muted-foreground" style={{ textAlign: "right" }}>
                          {oldDp != null ? fmtPrice(oldDp) : ""}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          <span className={`font-semibold ${changeTone(oldDp, newDp)}`}>
                            {newDp != null ? fmtPrice(newDp) : ""}
                          </span>
                        </td>
                        <td className="num text-[12px]" style={{ textAlign: "right" }}>
                          {change == null || paise(change) === 0
                            ? ""
                            : change > 0 ? `+${change.toFixed(2)}` : change.toFixed(2)}
                        </td>
                        <td className="num text-muted-foreground" style={{ textAlign: "right" }}>
                          {oldMrp != null ? fmtPrice(oldMrp) : ""}
                        </td>
                        <td className="num" style={{ textAlign: "right" }}>
                          <span className={`font-semibold ${changeTone(oldMrp, newMrp)}`}>
                            {newMrp != null ? fmtPrice(newMrp) : ""}
                          </span>
                        </td>
                        <td className="num text-[12px]" style={{ textAlign: "right" }}>
                          {oldGst === newGst ? newGst.toFixed(2) : `${oldGst.toFixed(2)} → ${newGst.toFixed(2)}`}
                        </td>
                        <td>{r.changedByName ?? ""}</td>
                        <td>
                          {r.reason ||
                            (r.source === "product_edit"
                              ? <span className="text-muted-foreground">Edited in All Products</span>
                              : "")}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
