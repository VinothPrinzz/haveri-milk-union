// ════════════════════════════════════════════════════════════════════
// Products: All Products / Add Product / Product Rates — ERP refactor
// Routes preserved: /masters/products /add /rates
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Plus, Search } from "lucide-react";
import {
  fetchProducts, 
  getRateCategories, 
  createProduct, 
  updateProduct, 
  deleteProduct,
  upsertProductRate, 
  type Product,
} from "@/services/api";

const fetchRateCategories = () => getRateCategories().map((name, i) => ({ id: String(i), name }));

import { productSchema, type ProductFormData } from "@/lib/validations";

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
                  <th style={{ width: 140 }}>Category</th>
                  <th style={{ width: 90 }}>Unit</th>
                  <th className="num" style={{ width: 120, textAlign: "right" }}>Base Price</th>
                  <th className="num" style={{ width: 80, textAlign: "right" }}>GST %</th>
                  <th className="num" style={{ width: 90, textAlign: "right" }}>Stock</th>
                  <th style={{ width: 100, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((p: Product) => (
                  <tr key={p.id}>
                    <td className="font-mono text-[12px]">{p.code}</td>
                    <td className="font-medium">{p.name}</td>
                    <td>{p.category ?? "—"}</td>
                    <td>{p.unit ?? "—"}</td>
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
                  <tr><td colSpan={8} className="py-8 text-center text-muted-foreground">No products found.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Edit dialog */}
      <Dialog open={!!editing} onOpenChange={open => !open && setEditing(null)}>
        <DialogContent className="max-w-3xl rounded-sm">
          <DialogHeader>
            <DialogTitle className="text-[15px] font-semibold">
              Edit Product — <span className="font-mono">{editing?.code}</span>
            </DialogTitle>
          </DialogHeader>
          {editing && (
            <ProductFormBody
              embedded
              initialData={editing}
              onCancel={() => setEditing(null)}
              isSubmitting={updateMutation.isPending}
              onSubmit={async data => updateMutation.mutateAsync({ id: editing.id, data })}
            />
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
      mrp: d.mrp,
      gstPercent: d.gstPercent,
      hsnNo: d.hsnNo,
      packetsCrate: d.packetsCrate,
      printDirection: d.printDirection,
      sortOrder: d.sortPosition,
      subsidy: d.subsidy,
      makeZeroInIndents: d.makeZeroInIndents,
      terminated: d.terminated,
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
  const form = useForm<ProductFormData>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: initialData?.name ?? "",
      reportAlias: initialData?.reportAlias ?? "",
      category: initialData?.category ?? "Milk",
      packSize: initialData?.packSize ?? 1,
      unit: initialData?.unit ?? "L",
      mrp: initialData?.mrp ?? 0,
      gstPercent: initialData?.gstPercent ?? 0,
      hsnNo: initialData?.hsnNo ?? "",
      packetsCrate: initialData?.packetsCrate ?? 0,
      printDirection: (initialData?.printDirection as "Across" | "Down") ?? "Across",
      sortPosition: (initialData as any)?.sortPosition ?? initialData?.sortOrder ?? 0,
      subsidy: (initialData as any)?.subsidy ?? false,
      makeZeroInIndents: (initialData as any)?.makeZeroInIndents ?? false,
      terminated: initialData?.terminated ?? false,
    },
  });

  const printDirection = form.watch("printDirection") ?? "Across";
  const aliasMax       = printDirection === "Down" ? 22 : 14;

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(async d => { await onSubmit(d); if (!embedded) form.reset(); })}>
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
                <Select onValueChange={field.onChange} value={field.value}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Milk">Milk</SelectItem>
                    <SelectItem value="Curd">Curd</SelectItem>
                    <SelectItem value="Ghee">Ghee</SelectItem>
                    <SelectItem value="Butter">Butter</SelectItem>
                    <SelectItem value="Sweets">Sweets</SelectItem>
                    <SelectItem value="Other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
        </FormSection>

        <FormSection title="Pack & Unit" cols={3}>
          {/* Existing fields - unchanged */}
          <FormField control={form.control} name="packSize" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">Pack Size</FormLabel>
              <FormControl><Input type="number" step="0.01" {...field} onChange={e => field.onChange(parseFloat(e.target.value))} /></FormControl>
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
              <FormControl><Input type="number" step="1" {...field} onChange={e => field.onChange(parseInt(e.target.value))} /></FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
        </FormSection>

        <FormSection title="Tax & Rate" cols={3}>
          {/* Existing fields - unchanged */}
          <FormField control={form.control} name="hsnNo" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">HSN</FormLabel>
              <FormControl><Input placeholder="0401" {...field} /></FormControl>
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
          <FormField control={form.control} name="mrp" render={({ field }) => (
            <FormItem>
              <FormLabel className="text-[11.5px] uppercase tracking-wide font-medium text-muted-foreground">MRP ₹</FormLabel>
              <FormControl>
                <Input type="number" step="0.01" {...field} onChange={e => field.onChange(parseFloat(e.target.value))} />
              </FormControl>
              <FormMessage className="text-[11.5px]" />
            </FormItem>
          )}/>
        </FormSection>

        {/* New Behaviour Section */}
        <FormSection title="Behaviour" cols={3}>
          <Field label="Sort Position">
            <Input 
              className="erp-input num" 
              type="number" 
              min="0" 
              {...form.register("sortPosition", { valueAsNumber: true })} 
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
                  <th className="num" style={{ width: 160, textAlign: "right" }}>Base Rate</th>
                  <th className="num" style={{ width: 200, textAlign: "right" }}>Effective Rate ₹</th>
                  <th style={{ width: 130, textAlign: "right" }}>Action</th>
                </tr>
              </thead>
              <tbody>
                {categories.map((c: any) => {
                  const existing = (product.rateCategories ?? {})[c.name] ?? product.mrp ?? 0;
                  const value = draft[c.id] ?? existing;
                  return (
                    <tr key={c.id}>
                      <td className="font-medium">{c.name}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(product.mrp ?? 0)}</td>
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