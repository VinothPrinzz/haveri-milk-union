// apps/web/src/pages/masters/ProductsPage.tsx
// ════════════════════════════════════════════════════════════════════
// Products: All Products / Add Product / Product Rates — ERP refactor
// Routes preserved: /masters/products /add /rates
//
// Three-tier pricing:
//   Basic Price  — pre-GST, auto-derived (read-only), shown for reference
//   Dealer-Price — gross price, entered by the client
//   MRP          — entered by the client
//   Margin       — MRP − Dealer-Price, auto-calculated, never stored
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import PageHeader, {
  FilterBar,
  FormSection,
  FormFooter,
  Field,
  EmptyState,
  fmtINR,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Form, FormField, FormItem, FormLabel, FormControl, FormMessage,
} from "@/components/ui/form";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Search } from "lucide-react";
import {
  fetchProducts,
  fetchProductCategories,
  getRateCategories,
  createProduct,
  updateProduct,
  deleteProduct,
  upsertProductRate,
  getProductImagePresignUrl,
  type Product,
} from "@/services/api";

const fetchRateCategories = () => getRateCategories().map((name, i) => ({ id: String(i), name }));

import { productSchema, type ProductFormData } from "@/lib/validations";
import { useSaveShortcut } from "@/lib/useKeyboardNav";

// Basic Price is derived from the (gross) Dealer-Price, excluding GST.
function deriveBasicPrice(dealerPrice: number, gstPercent: number): number {
  const safeGst = Math.max(0, gstPercent || 0);
  if (!dealerPrice) return 0;
  return Math.round((dealerPrice / (1 + safeGst / 100)) * 100) / 100;
}

interface Props { tab?: "list" | "add" | "rates"; }

export default function ProductsPage({ tab = "list" }: Props) {
  if (tab === "add") return <ProductAddTab />;
  return <ProductListTab />;
}

// ── List tab ─────────────────────────────────────────────────────
function ProductListTab() {
  const qc = useQueryClient();
  const { data: products = [], isLoading } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });

  const [search, setSearch] = useState("");
  const [editing, setEditing] = useState<Product | null>(null);
  const [deleting, setDeleting] = useState<Product | null>(null);

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: ProductFormData }) => updateProduct(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Product updated");
      setEditing(null);
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => deleteProduct(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Product deleted");
      setDeleting(null);
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter((p: Product) =>
      p.name?.toLowerCase().includes(q) || p.code?.toLowerCase().includes(q)
    );
  }, [products, search]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="All Products"
        subtitle="Catalogue of finished goods"
        actions={
          <>
            <Button asChild size="sm" variant="outline" className="h-8">
              <a href="/masters/products/rates">Manage Rates</a>
            </Button>
            <Button asChild size="sm" className="h-8">
              <a href="/masters/products/add"><Plus className="h-3.5 w-3.5 mr-1" /> Add Product</a>
            </Button>
          </>
        }
      />

      <FilterBar>
        <Field label="Search">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search by name / SKU / code"
              value={search}
              onChange={e => setSearch(e.target.value)}
              className="erp-input pl-7 w-72"
            />
          </div>
        </Field>
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 80 }}>Code</th>
                  <th>Name</th>
                  <th style={{ width: 130 }}>Category</th>
                  <th style={{ width: 80 }}>Unit</th>
                  <th className="num" style={{ width: 110, textAlign: "right" }}>Basic Price</th>
                  <th className="num" style={{ width: 110, textAlign: "right" }}>Dealer Price</th>
                  <th className="num" style={{ width: 100, textAlign: "right" }}>MRP</th>
                  <th className="num" style={{ width: 70, textAlign: "right" }}>GST %</th>
                  <th className="num" style={{ width: 80, textAlign: "right" }}>Stock</th>
                  <th style={{ width: 90, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p: Product) => (
                  <tr key={p.id}>
                    <td className="font-mono text-[12px]">{p.code}</td>
                    <td className="font-medium">{p.name}</td>
                    <td>{p.category ?? "—"}</td>
                    <td>{p.unit ?? "—"}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(p.basePrice ?? 0)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(p.dealerPrice ?? 0)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(p.mrp ?? 0)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{Number(p.gstPercent ?? 0).toFixed(2)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{p.stock ?? 0}</td>
                    <td style={{ textAlign: "right" }}>
                      <Button
                        size="sm"
                        className="h-7 px-2.5 text-[12px]"
                        onClick={() => setEditing(p)}
                      >
                        Update
                      </Button>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={10} className="py-8 text-center text-muted-foreground">No products found.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="max-w-3xl rounded-sm flex flex-col max-h-[90vh] overflow-hidden p-0">
          <DialogHeader className="px-6 pt-5 pb-3 border-b border-border shrink-0">
            <DialogTitle className="text-[15px] font-semibold">
              Edit Product — <span className="font-mono">{editing?.code}</span>
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <div className="flex-1 overflow-y-auto min-h-0">
              <div className="p-4">
                <ProductFormBody
                  embedded
                  initialData={editing}
                  onCancel={() => setEditing(null)}
                  isSubmitting={updateMutation.isPending}
                  onSubmit={async data => updateMutation.mutateAsync({ id: editing.id, data })}
                />
              </div>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Delete confirm */}
      <Dialog open={!!deleting} onOpenChange={open => !open && setDeleting(null)}>
        <DialogContent className="max-w-md rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">
              Delete <span className="font-mono">{deleting?.code}</span>?
            </DialogTitle>
          </DialogHeader>
          <p className="text-[13px] text-muted-foreground">
            This will soft-delete <span className="font-medium text-foreground">{deleting?.name}</span>.
            Existing indents and invoices retain the historical product reference.
          </p>
          <DialogFooter className="gap-2">
            <Button variant="outline" size="sm" className="h-8" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="destructive"
              size="sm"
              className="h-8"
              onClick={() => deleting && deleteMutation.mutate(deleting.id)}
              disabled={deleteMutation.isPending}
            >
              {deleteMutation.isPending ? "Deleting…" : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ── Add tab ──────────────────────────────────────────────────────
function ProductAddTab() {
  const qc = useQueryClient();

  const createMutation = useMutation({
    mutationFn: (d: ProductFormData) => createProduct({
      name: d.name,
      reportAlias: d.reportAlias,
      category: d.category,
      packSize: d.packSize,
      unit: d.unit,
      dealerPrice: d.dealerPrice,
      mrp: d.mrp,
      gstPercent: d.gstPercent,
      hsnNo: d.hsnNo,
      packetsCrate: d.packetsCrate,
      printDirection: d.printDirection,
      sortOrder: d.sortPosition,
      subsidy: d.subsidy,
      makeZeroInIndents: d.makeZeroInIndents,
      terminated: d.terminated,
      imageUrl: d.imageUrl || null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Product created");
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  return (
    <div>
      <PageHeader title="Add Product" subtitle="Create a new product master entry" />
      <div className="p-4">
        <ProductFormBody
          isSubmitting={createMutation.isPending}
          onSubmit={async (data) => { await createMutation.mutateAsync(data); }}
        />
      </div>
    </div>
  );
}

// ── Shared Product Form Body ─────────────────────────────────────
function ProductFormBody({
  initialData,
  onSubmit,
  onCancel,
  isSubmitting,
  embedded,
}: {
  initialData?: Product;
  onSubmit: (data: ProductFormData) => Promise<any> | void;
  onCancel?: () => void;
  isSubmitting?: boolean;
  embedded?: boolean;
}) {
  const { data: categoriesRaw = [] } = useQuery({
    queryKey: ["product-categories"],
    queryFn: fetchProductCategories,
  });

  const categoryOpts: F9Option[] = categoriesRaw.map(c => ({ value: c.id, label: c.name }));

  // ── Image upload state ──────────────────────────────────────────
  const [uploading, setUploading]   = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string>(
    (initialData as any)?.imageUrl ?? "",
  );

  async function handleImageFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const allowed = ["image/jpeg", "image/png", "image/webp"] as const;
    if (!allowed.includes(file.type as any)) {
      toast.error("Only JPEG, PNG, or WebP images are supported");
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      toast.error("Image must be under 2 MB");
      return;
    }

    setUploading(true);
    try {
      const { uploadUrl, publicUrl } = await getProductImagePresignUrl(
        file.name,
        file.type as "image/jpeg" | "image/png" | "image/webp",
      );
      // Upload directly to R2 — no API server bandwidth used
      const r2Res = await fetch(uploadUrl, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type },
      });
      if (!r2Res.ok) throw new Error("Upload to storage failed");
      setPreviewUrl(publicUrl);
      form.setValue("imageUrl", publicUrl);
      toast.success("Image uploaded");
    } catch (err: any) {
      toast.error(err?.message ?? "Image upload failed");
    } finally {
      setUploading(false);
      // Reset input so the same file can be re-selected after removal
      e.target.value = "";
    }
  }

  const form = useForm<ProductFormData>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: initialData?.name ?? "",
      reportAlias: initialData?.reportAlias ?? "",
      category: initialData?.categoryId ?? "",
      packSize:      initialData?.packSize      ?? undefined,
      unit: initialData?.unit ?? "L",
      dealerPrice:   initialData?.dealerPrice   ?? undefined,
      mrp:           initialData?.mrp           ?? undefined,
      gstPercent:    initialData?.gstPercent    ?? undefined,
      hsnNo: initialData?.hsnNo ?? "",
      packetsCrate:  initialData?.packetsCrate  ?? undefined,
      printDirection: (initialData?.printDirection as "Across" | "Down") ?? "Across",
      sortPosition:  (initialData as any)?.sortPosition ?? initialData?.sortOrder ?? undefined,
      subsidy: (initialData as any)?.subsidy ?? false,
      makeZeroInIndents: (initialData as any)?.makeZeroInIndents ?? false,
      terminated: initialData?.terminated ?? false,
      imageUrl: (initialData as any)?.imageUrl ?? "",
    },
  });

  const printDirection = form.watch("printDirection") ?? "Across";
  const aliasMax       = printDirection === "Down" ? 22 : 14;

  // ── Three-tier pricing — live derived values ──────────────────
  const dealerPriceW = Number(form.watch("dealerPrice") ?? 0);
  const mrpW         = Number(form.watch("mrp") ?? 0);
  const gstW         = Number(form.watch("gstPercent") ?? 0);
  const basicPrice   = deriveBasicPrice(dealerPriceW, gstW);
  const margin       = mrpW - dealerPriceW;

  const submitProduct = form.handleSubmit(async d => { await onSubmit(d); if (!embedded) form.reset(); });
  useSaveShortcut(() => submitProduct(), !isSubmitting);

  return (
    <Form {...form}>
      <form onSubmit={submitProduct}>
        <FormSection title="Identification" cols={3}>
          <FormField control={form.control} name="name" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">Name</FormLabel>
              <FormControl><Input placeholder="Toned Milk 500 ml" {...field} /></FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
          <FormField control={form.control} name="reportAlias" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">
                Report Alias{" "}
                <span className="text-muted-foreground/70 normal-case font-normal">
                  (max {aliasMax})
                </span>
              </FormLabel>
              <FormControl>
                <Input
                  placeholder={printDirection === "Down" ? "Toned Milk 500ml Pouch" : "Milk500ml"}
                  maxLength={aliasMax}
                  {...field}
                  onChange={e => field.onChange(e.target.value.slice(0, aliasMax))}
                />
              </FormControl>
              <div className="text-[10.5px] text-muted-foreground tabular-nums">
                {(field.value ?? "").length}/{aliasMax}
              </div>
            </FormItem>
          )}/>
          <FormField control={form.control} name="category" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">Category</FormLabel>
              <FormControl>
                <F9SearchSelect
                  value={field.value || null}
                  onChange={v => field.onChange(v ?? "")}
                  options={categoryOpts}
                  placeholder="Select category…"
                  modalTitle="Select Category"
                  className="w-full"
                />
              </FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
        </FormSection>

        <FormSection title="Pack & Unit" cols={3}>
          <FormField control={form.control} name="packSize" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">Pack Size</FormLabel>
              <FormControl>
                <Input 
                  type="number" 
                  step="0.01" 
                  {...field} 
                  onChange={e => field.onChange(e.target.value === "" ? undefined : parseFloat(e.target.value))} 
                />
              </FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
          <FormField control={form.control} name="unit" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">Unit</FormLabel>
              <FormControl>
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="L">L (litre)</SelectItem>
                    <SelectItem value="ml">ml</SelectItem>
                    <SelectItem value="kg">kg</SelectItem>
                    <SelectItem value="g">g</SelectItem>
                    <SelectItem value="pc">pc</SelectItem>
                  </SelectContent>
                </Select>
              </FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
          <FormField control={form.control} name="packetsCrate" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">Packets/Crate</FormLabel>
              <FormControl>
                <Input 
                  type="number" 
                  step="1" 
                  {...field} 
                  onChange={e => field.onChange(e.target.value === "" ? undefined : parseFloat(e.target.value))} 
                />
              </FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
        </FormSection>

        <FormSection title="Tax" cols={3}>
          <FormField control={form.control} name="hsnNo" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">HSN</FormLabel>
              <FormControl>
                <Input 
                  type="number" 
                  step="0.01" 
                  {...field} 
                  onChange={e => field.onChange(e.target.value === "" ? undefined : parseFloat(e.target.value))} 
                />
              </FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
          <FormField control={form.control} name="gstPercent" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">GST %</FormLabel>
              <FormControl>
                <Input type="number" step="0.01" {...field} onChange={e => field.onChange(parseFloat(e.target.value))} />
              </FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
          <div /> {/* spacer */}
        </FormSection>

        {/* ── Pricing — three tiers ─────────────────────────────── */}
        <FormSection title="Pricing" cols={3}>
          <FormField control={form.control} name="dealerPrice" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">
                Dealer-Price ₹
              </FormLabel>
              <FormControl>
                <Input
                  type="number"
                  step="0.01"
                  {...field}
                  onChange={e => field.onChange(e.target.value === "" ? undefined : parseFloat(e.target.value))}
                />
              </FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
          <FormField control={form.control} name="mrp" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">
                MRP ₹
              </FormLabel>
              <FormControl>
                <Input
                  type="number"
                  step="0.01"
                  {...field}
                  onChange={e => field.onChange(e.target.value === "" ? undefined : parseFloat(e.target.value))}
                />
              </FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
          <Field label="Basic Price ₹ (auto)">
            <Input
              className="erp-input num bg-muted/40"
              value={basicPrice.toFixed(2)}
              readOnly
              tabIndex={-1}
            />
            <div className="text-[10.5px] text-muted-foreground mt-0.5">
              Dealer-Price excluding {gstW || 0}% GST
            </div>
          </Field>

          <Field label="Margin ₹ (auto)">
            <Input
              className="erp-input num bg-muted/40"
              value={margin.toFixed(2)}
              readOnly
              tabIndex={-1}
              style={{ color: margin < 0 ? "var(--destructive, #dc2626)" : undefined }}
            />
            <div className="text-[10.5px] text-muted-foreground mt-0.5">
              MRP − Dealer-Price
            </div>
          </Field>
        </FormSection>

        {/* ── Product Image ──────────────────────────────────────── */}
        <FormSection title="App Image" cols={1}>
          <Field label="Product image" hint="PNG / JPEG / WebP · max 2 MB · shown in dealer app">
            <div className="flex items-center gap-4">
              {/* Preview thumbnail */}
              {previewUrl ? (
                <div className="relative shrink-0">
                  <img
                    src={previewUrl}
                    alt="Product preview"
                    className="h-20 w-20 rounded border object-contain bg-muted/40"
                  />
                  <button
                    type="button"
                    onClick={() => { setPreviewUrl(""); form.setValue("imageUrl", ""); }}
                    className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-destructive text-white text-[11px] font-bold leading-none flex items-center justify-center hover:bg-destructive/80"
                    title="Remove image"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <div className="h-20 w-20 rounded border border-dashed bg-muted/40 flex items-center justify-center text-muted-foreground text-2xl shrink-0">
                  📦
                </div>
              )}

              {/* Upload button + hidden file input */}
              <div className="flex flex-col gap-1.5">
                <label className="cursor-pointer">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="h-8 pointer-events-none"
                    disabled={uploading}
                    asChild
                  >
                    <span>
                      {uploading
                        ? "Uploading…"
                        : previewUrl
                        ? "Change image"
                        : "Upload image"}
                    </span>
                  </Button>
                  <input
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    className="sr-only"
                    onChange={handleImageFile}
                    disabled={uploading}
                  />
                </label>
                <p className="text-[11px] text-muted-foreground">
                  Displays at the top of the product tile in the dealer app.
                </p>
              </div>
            </div>
          </Field>
        </FormSection>

        {/* Behaviour Section */}
        <FormSection title="Behaviour" cols={3}>
        <Field label="Sort Position">
          <Input
            className="erp-input num"
            type="number"
            min="0"
            {...form.register("sortPosition", {
              setValueAs: v => v === "" || v == null ? undefined : Number(v),
            })}
          />
        </Field>
          <Field label="Print Direction">
            <Select
              value={form.watch("printDirection") || "Across"}
              onValueChange={v => form.setValue("printDirection", v as any)}
            >
              <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="Across">Across</SelectItem>
                <SelectItem value="Down">Down</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <div /> {/* spacer */}

          <Field label="Subsidy">
            <div className="flex items-center gap-2 h-10">
              <Switch
                checked={!!form.watch("subsidy")}
                onCheckedChange={v => form.setValue("subsidy", v)}
              />
              <span className="text-[13px]">{form.watch("subsidy") ? "On" : "Off"}</span>
            </div>
          </Field>
          <Field label="Make Zero in Indents">
            <div className="flex items-center gap-2 h-10">
              <Switch
                checked={!!form.watch("makeZeroInIndents")}
                onCheckedChange={v => form.setValue("makeZeroInIndents", v)}
              />
              <span className="text-[13px]">{form.watch("makeZeroInIndents") ? "On" : "Off"}</span>
            </div>
          </Field>
          <Field label="Terminated">
            <div className="flex items-center gap-2 h-10">
              <Switch
                checked={!!form.watch("terminated")}
                onCheckedChange={v => form.setValue("terminated", v)}
                className="data-[state=checked]:bg-destructive"
              />
              <span className={`text-[13px] ${form.watch("terminated") ? "text-destructive font-semibold" : ""}`}>
                {form.watch("terminated") ? "Terminated" : "Active"}
              </span>
            </div>
          </Field>
        </FormSection>

        <FormFooter>
          {onCancel && <Button type="button" variant="outline" size="sm" className="h-8" onClick={onCancel}>Cancel</Button>}
          <Button type="submit" size="sm" className="h-8" disabled={isSubmitting}>
            {isSubmitting ? "Saving…" : (initialData ? "Save Changes" : "Save Product")}
          </Button>
        </FormFooter>
      </form>
    </Form>
  );
}

// ── Rates tab ───────────────────────────────────────────────────
function ProductRatesTab() {
  const qc = useQueryClient();
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });
  const { data: categories = [] } = useQuery({ queryKey: ["rate-categories"], queryFn: fetchRateCategories });

  const [productId, setProductId] = useState<string>("");
  const [draft, setDraft] = useState<Record<string, number>>({});

  const product = products.find((p: Product) => p.id === productId);

  const upsert = useMutation({
    mutationFn: (args: { productId: string; categoryId: string; rate: number }) =>
      upsertProductRate(args.productId, args.categoryId, args.rate),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["products"] }); toast.success("Rate saved"); },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Product Rates" subtitle="Per rate-category prices for each product" />
      <FilterBar>
        <Field label="Product">
          <Select value={productId} onValueChange={setProductId}>
            <SelectTrigger className="erp-input w-72"><SelectValue placeholder="Pick a product…" /></SelectTrigger>
            <SelectContent>
              {products.map((p: Product) => (
                <SelectItem key={p.id} value={p.id}>{p.code} — {p.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {!product ? (
            <EmptyState title="Select a product to manage rate-category prices." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th>Rate Category</th>
                  <th className="num" style={{ width: 160, textAlign: "right" }}>Basic Price</th>
                  <th className="num" style={{ width: 200, textAlign: "right" }}>Effective Rate ₹</th>
                  <th style={{ width: 130, textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c: any) => {
                  const existing = (product.rateCategories ?? {})[c.name] ?? product.basePrice ?? 0;
                  const value = draft[c.id] ?? existing;
                  return (
                    <tr key={c.id}>
                      <td className="font-medium">{c.name}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(product.basePrice ?? 0)}</td>
                      <td style={{ textAlign: "right" }}>
                        <Input
                          type="number"
                          step="0.01"
                          className="erp-input ml-auto w-32 text-right tabular-nums"
                          value={value}
                          onChange={e => setDraft(d => ({ ...d, [c.id]: parseFloat(e.target.value) }))}
                        />
                      </td>
                      <td style={{ textAlign: "right" }}>
                        <Button
                          size="sm"
                          className="h-7"
                          disabled={upsert.isPending || draft[c.id] === undefined || draft[c.id] === existing}
                          onClick={() => upsert.mutate({
                            productId: product.id,
                            categoryId: c.id,
                            rate: draft[c.id]
                          })}
                        >
                          Save
                        </Button>
                      </td>
                    </tr>
                  );
                })}
                {categories.length === 0 && (
                  <tr><td colSpan={4} className="py-8 text-center text-muted-foreground">No rate categories defined yet.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}