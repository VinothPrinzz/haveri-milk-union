// apps/web/src/pages/masters/PriceRevisionsPage.tsx
// ════════════════════════════════════════════════════════════════════
// Price Revisions — /masters/price-revisions
//
// Two-tab page:
//
//   Tab 1 — Edit Prices
//     • Grid of every product with editable basePrice + gstPercent.
//     • Client-side diff: only rows where the user actually changed
//       a value are sent to the API.
//     • Effective Date (default = today) + Reason applied to all
//       revisions in the batch.
//     • "Save Revisions" disabled until there's at least one change.
//     • After save: grid refetches, dirty state clears, toast shows
//       how many products were actually updated (idempotent — if the
//       user types "30" when the price is already "30", the backend
//       skips it, so the toast message can differ from the edit count).
//
//   Tab 2 — History
//     • Paginated audit-trail table with filters (product, date from/to).
//     • Shows old → new for both price and GST side-by-side.
//     • changedByName + reason columns for audit compliance.
//
// Server work:
//   • fetchProductsWithPricing()   GET  /products/with-pricing
//   • createPriceRevisions(body)   POST /price-revisions  (transactional batch)
//   • fetchPriceRevisions(filters) GET  /price-revisions  (paginated)
// ════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "@/components/ui/tabs";
import { Save, RotateCcw, TrendingUp } from "lucide-react";
import {
  fetchProductsWithPricing,
  fetchPriceRevisions,
  createPriceRevisions,
  type ProductWithPricing,
  type PriceRevisionRow,
} from "@/services/api";

// Money / number formatting — Indian locale.
const fmtMoney = (n: number | string) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(typeof n === "string" ? parseFloat(n) || 0 : n);

const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    day:   "2-digit",
    month: "short",
    year:  "numeric",
  });
};

interface Props {
  tab?: "edit" | "history";
}

export default function PriceRevisionsPage({ tab = "edit" }: Props) {
  const [active, setActive] = useState<"edit" | "history">(tab);

  // Keep the tab prop in sync if the parent changes it (e.g. new route mount).
  useEffect(() => setActive(tab), [tab]);

  return (
    <Tabs
      value={active}
      onValueChange={v => setActive(v as "edit" | "history")}
      className="h-full flex flex-col"
    >
      <div className="flex-shrink-0 mb-3">
        <TabsList>
          <TabsTrigger value="edit">Edit Prices</TabsTrigger>
          <TabsTrigger value="history">History</TabsTrigger>
        </TabsList>
      </div>

      <TabsContent value="edit" className="flex-1 mt-0 min-h-0">
        <EditPricesTab />
      </TabsContent>

      <TabsContent value="history" className="flex-1 mt-0 min-h-0">
        <HistoryTab />
      </TabsContent>
    </Tabs>
  );
}

// ══════════════════════════════════════════════════════════════════
// TAB 1 — Edit Prices
// ══════════════════════════════════════════════════════════════════

interface DraftEdit {
  basePrice?:  string;   // kept as string — user's raw input
  gstPercent?: string;
}

function EditPricesTab() {
  const qc = useQueryClient();

  const { data: products = [], isLoading } = useQuery({
    queryKey: ["products-with-pricing"],
    queryFn: fetchProductsWithPricing,
  });

  // Dirty state: productId → { basePrice?, gstPercent? }
  const [edits, setEdits] = useState<Record<string, DraftEdit>>({});

  // Effective date + reason apply to the whole batch.
  const [effectiveFrom, setEffectiveFrom] = useState(
    new Date().toISOString().slice(0, 10)
  );
  const [reason, setReason] = useState("");

  // Category filter — same UX as the existing ProductsPage/Rates tab.
  const [categoryFilter, setCategoryFilter] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  const categoryOptions: F9Option[] = useMemo(() => {
    const seen = new Map<string, string>();
    (products as ProductWithPricing[]).forEach(p => {
      if (p.categoryId && !seen.has(p.categoryId)) {
        seen.set(p.categoryId, p.categoryName);
      }
    });
    return Array.from(seen.entries()).map(([id, name]) => ({
      value: id,
      label: name,
    }));
  }, [products]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (products as ProductWithPricing[]).filter(p => {
      if (categoryFilter && p.categoryId !== categoryFilter) return false;
      if (q && !`${p.code ?? ""} ${p.name}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [products, categoryFilter, search]);

  // ── Dirty row helpers ────────────────────────────────────────
  const setCell = (productId: string, field: keyof DraftEdit, value: string) => {
    setEdits(prev => {
      const current = prev[productId] ?? {};
      const next = { ...current, [field]: value };

      // If this change brings the draft row back to the original
      // values, remove it from the edits map so the button
      // correctly disables.
      const product = (products as ProductWithPricing[]).find(
        p => p.id === productId
      );
      if (product) {
        const priceSame =
          next.basePrice === undefined
            ? true
            : Number(next.basePrice) === Number(product.basePrice);
        const gstSame =
          next.gstPercent === undefined
            ? true
            : Number(next.gstPercent) === Number(product.gstPercent);
        if (priceSame && gstSame) {
          const clone = { ...prev };
          delete clone[productId];
          return clone;
        }
      }

      return { ...prev, [productId]: next };
    });
  };

  const resetAll = () => setEdits({});

  // ── Save mutation ────────────────────────────────────────────
  const saveMutation = useMutation({
    mutationFn: async () => {
      const revisions = Object.entries(edits).flatMap(([productId, draft]) => {
        const p = (products as ProductWithPricing[]).find(x => x.id === productId);
        if (!p) return [];

        // Only include fields that actually changed vs. current value.
        const priceChanged =
          draft.basePrice !== undefined &&
          Number(draft.basePrice) !== Number(p.basePrice);
        const gstChanged =
          draft.gstPercent !== undefined &&
          Number(draft.gstPercent) !== Number(p.gstPercent);

        if (!priceChanged && !gstChanged) return [];

        return [{
          productId,
          newPrice:       priceChanged ? draft.basePrice! : p.basePrice,
          newGstPercent:  gstChanged   ? draft.gstPercent! : p.gstPercent,
          effectiveFrom,
        }];
      });

      if (revisions.length === 0) {
        throw new Error("No changes to save");
      }

      return createPriceRevisions({
        revisions,
        reason: reason.trim() || undefined,
      });
    },
    onSuccess: res => {
      toast.success(res.message);
      setEdits({});
      qc.invalidateQueries({ queryKey: ["products-with-pricing"] });
      qc.invalidateQueries({ queryKey: ["products"] });           // list page also refetches
      qc.invalidateQueries({ queryKey: ["price-revisions"] });    // history tab
    },
    onError: (err: any) =>
      toast.error(err?.message || "Failed to save revisions"),
  });

  const editCount = Object.keys(edits).length;
  const canSave = editCount > 0 && !saveMutation.isPending;

  // ──────────────────────────────────────────────────────────────
  return (
    <PageShell
      header={
        <>
          <PageHeader
            title="Price Revisions — Edit"
            description="Bulk-edit base price and GST for all products"
          >
            <div className="flex items-center gap-2">
              {editCount > 0 && (
                <Button variant="outline" size="sm" onClick={resetAll}>
                  <RotateCcw className="h-4 w-4 mr-1.5" />
                  Reset {editCount} change{editCount === 1 ? "" : "s"}
                </Button>
              )}
              <Button
                size="sm"
                onClick={() => saveMutation.mutate()}
                disabled={!canSave}
              >
                <Save className="h-4 w-4 mr-1.5" />
                {saveMutation.isPending
                  ? "Saving…"
                  : editCount > 0
                    ? `Save ${editCount} Revision${editCount === 1 ? "" : "s"}`
                    : "Save Revisions"}
              </Button>
            </div>
          </PageHeader>

          {/* Top controls: effective date / reason / filters */}
          <FilterBar>
            <div>
              <label className="text-sm font-medium mb-1.5 block">
                Effective From
              </label>
              <input
                type="date"
                value={effectiveFrom}
                onChange={e => setEffectiveFrom(e.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>

            <div className="min-w-[240px]">
              <label className="text-sm font-medium mb-1.5 block">Category</label>
              <F9SearchSelect
                value={categoryFilter}
                onChange={setCategoryFilter}
                options={categoryOptions}
                placeholder="All categories"
                allowClear
              />
            </div>

            <div className="min-w-[220px] flex-1">
              <label className="text-sm font-medium mb-1.5 block">Search</label>
              <Input
                type="search"
                value={search}
                onChange={e => setSearch(e.target.value)}
                placeholder="Product code or name"
                className="w-full"
              />
            </div>

            <div className="min-w-[260px] flex-1">
              <label className="text-sm font-medium mb-1.5 block">
                Reason (optional)
              </label>
              <Textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                placeholder="e.g., Monsoon fodder cost adjustment"
                rows={1}
                className="w-full resize-none"
              />
            </div>
          </FilterBar>

          {editCount > 0 && (
            <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-md px-3 py-2">
              You have <span className="font-semibold">{editCount}</span>{" "}
              unsaved change{editCount === 1 ? "" : "s"}. Click Save to apply.
            </div>
          )}
        </>
      }
    >
      {isLoading ? (
        <ScrollableTableBody className="p-4">
          <div className="space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </ScrollableTableBody>
      ) : filtered.length === 0 ? (
        <EmptyState message="No products match the current filters." />
      ) : (
        <ScrollableTableBody>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left py-2.5 px-3 font-medium">Code</th>
                <th className="text-left py-2.5 px-3 font-medium">Product</th>
                <th className="text-left py-2.5 px-3 font-medium">Category</th>
                <th className="text-left py-2.5 px-3 font-medium">Unit</th>
                <th className="text-right py-2.5 px-3 font-medium">
                  Base Price (₹)
                </th>
                <th className="text-right py-2.5 px-3 font-medium">GST %</th>
                <th className="text-left py-2.5 px-3 font-medium">Last Revised</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => {
                const draft = edits[p.id] ?? {};
                const priceValue =
                  draft.basePrice ?? p.basePrice;
                const gstValue =
                  draft.gstPercent ?? p.gstPercent;
                const isDirty = Boolean(edits[p.id]);
                return (
                  <tr
                    key={p.id}
                    className={`border-b ${
                      isDirty ? "bg-primary/5" : "hover:bg-muted/30"
                    }`}
                  >
                    <td className="py-2 px-3 font-mono text-xs">
                      {p.code ?? "—"}
                    </td>
                    <td className="py-2 px-3 font-medium">{p.name}</td>
                    <td className="py-2 px-3 text-muted-foreground text-xs">
                      {p.categoryName}
                    </td>
                    <td className="py-2 px-3 text-muted-foreground text-xs">
                      {p.unit}
                    </td>
                    <td className="py-2 px-3 text-right">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        value={priceValue}
                        onChange={e =>
                          setCell(p.id, "basePrice", e.target.value)
                        }
                        className="h-8 w-24 text-right font-mono ml-auto"
                      />
                    </td>
                    <td className="py-2 px-3 text-right">
                      <Input
                        type="number"
                        step="0.01"
                        min="0"
                        max="100"
                        value={gstValue}
                        onChange={e =>
                          setCell(p.id, "gstPercent", e.target.value)
                        }
                        className="h-8 w-20 text-right font-mono ml-auto"
                      />
                    </td>
                    <td className="py-2 px-3 text-muted-foreground text-xs">
                      {fmtDate(p.lastRevisedAt)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </ScrollableTableBody>
      )}
    </PageShell>
  );
}

// ══════════════════════════════════════════════════════════════════
// TAB 2 — History
// ══════════════════════════════════════════════════════════════════

function HistoryTab() {
  // Filters
  const [productId, setProductId] = useState<string | null>(null);
  const [dateFrom,  setDateFrom]  = useState("");
  const [dateTo,    setDateTo]    = useState("");
  const [page,      setPage]      = useState(1);

  // Reset to page 1 whenever filters change
  useEffect(() => {
    setPage(1);
  }, [productId, dateFrom, dateTo]);

  // Product list for the filter F9 (reuse the same endpoint).
  const { data: products = [] } = useQuery({
    queryKey: ["products-with-pricing"],
    queryFn: fetchProductsWithPricing,
  });

  const productOptions: F9Option[] = useMemo(
    () =>
      (products as ProductWithPricing[]).map(p => ({
        value:    p.id,
        label:    p.name,
        sublabel: p.code ?? "",
      })),
    [products]
  );

  const { data, isLoading, isFetching } = useQuery({
    queryKey: ["price-revisions", productId, dateFrom, dateTo, page],
    queryFn: () =>
      fetchPriceRevisions({
        productId: productId ?? undefined,
        dateFrom:  dateFrom || undefined,
        dateTo:    dateTo   || undefined,
        page,
        limit: 50,
      }),
  });

  const rows: PriceRevisionRow[] = data?.data ?? [];
  const totalPages = data?.totalPages ?? 1;

  return (
    <PageShell
      header={
        <>
          <PageHeader
            title="Price Revisions — History"
            description="Audit trail of every price/GST change"
          />

          <FilterBar>
            <div className="min-w-[260px]">
              <label className="text-sm font-medium mb-1.5 block">Product</label>
              <F9SearchSelect
                value={productId}
                onChange={setProductId}
                options={productOptions}
                placeholder="All products"
                allowClear
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>
            <div>
              <label className="text-sm font-medium mb-1.5 block">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>

            {isFetching && !isLoading && (
              <div className="text-xs text-muted-foreground pb-2">
                Refreshing…
              </div>
            )}
          </FilterBar>
        </>
      }
    >
      {isLoading ? (
        <ScrollableTableBody className="p-4">
          <div className="space-y-2">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </ScrollableTableBody>
      ) : rows.length === 0 ? (
        <EmptyState message="No price revisions match the filters." />
      ) : (
        <div className="h-full flex flex-col">
          <ScrollableTableBody className="flex-1">
            <table className="w-full text-sm">
              <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
                <tr className="text-xs text-muted-foreground">
                  <th className="text-left py-2.5 px-3 font-medium">
                    Effective
                  </th>
                  <th className="text-left py-2.5 px-3 font-medium">Code</th>
                  <th className="text-left py-2.5 px-3 font-medium">Product</th>
                  <th className="text-right py-2.5 px-3 font-medium">
                    Old Price
                  </th>
                  <th className="text-right py-2.5 px-3 font-medium">
                    New Price
                  </th>
                  <th className="text-right py-2.5 px-3 font-medium">Old GST</th>
                  <th className="text-right py-2.5 px-3 font-medium">New GST</th>
                  <th className="text-left py-2.5 px-3 font-medium">Reason</th>
                  <th className="text-left py-2.5 px-3 font-medium">
                    Changed By
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.id} className="border-b hover:bg-muted/30">
                    <td className="py-2 px-3 text-xs">
                      {fmtDate(r.effectiveFrom)}
                    </td>
                    <td className="py-2 px-3 font-mono text-xs">
                      {r.productCode}
                    </td>
                    <td className="py-2 px-3 font-medium">{r.productName}</td>
                    <td className="py-2 px-3 text-right font-mono text-muted-foreground">
                      {fmtMoney(r.oldPrice)}
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-semibold">
                      <Delta old={r.oldPrice} next={r.newPrice} isMoney />
                    </td>
                    <td className="py-2 px-3 text-right font-mono text-muted-foreground">
                      {r.oldGst}%
                    </td>
                    <td className="py-2 px-3 text-right font-mono font-semibold">
                      <Delta old={r.oldGst} next={r.newGst} />
                    </td>
                    <td className="py-2 px-3 text-xs text-muted-foreground max-w-[200px] truncate">
                      {r.reason ?? "—"}
                    </td>
                    <td className="py-2 px-3 text-xs">
                      {r.changedByName ?? "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </ScrollableTableBody>

          {/* Pagination footer */}
          {totalPages > 1 && (
            <div className="flex-shrink-0 border-t bg-card rounded-b-lg px-4 py-2 flex items-center justify-between text-sm">
              <span className="text-xs text-muted-foreground">
                Page {page} of {totalPages} · {data?.total ?? 0} revisions
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </PageShell>
  );
}

// ─── Small primitives ────────────────────────────────────────────

function Delta({
  old: o,
  next,
  isMoney = false,
}: {
  old: string | number;
  next: string | number;
  isMoney?: boolean;
}) {
  const oldN = Number(o);
  const newN = Number(next);
  const up   = newN > oldN;
  const down = newN < oldN;
  const formatted = isMoney ? fmtMoney(newN) : `${newN}%`;
  const cls = up
    ? "text-emerald-700"
    : down
      ? "text-rose-700"
      : "text-foreground";
  const arrow = up ? "↑" : down ? "↓" : "";
  return (
    <span className={cls}>
      {formatted} {arrow}
    </span>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <ScrollableTableBody>
      <div className="h-full flex items-center justify-center">
        <Card className="max-w-md">
          <CardContent className="p-10 text-center space-y-2">
            <TrendingUp className="h-10 w-10 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">{message}</p>
          </CardContent>
        </Card>
      </div>
    </ScrollableTableBody>
  );
}