// apps/web/src/pages/masters/ProductsPage.tsx
// ════════════════════════════════════════════════════════════════════
// All Products / Add Packet / Rate Categories — Marketing v1.4
//
// tab=list   → PageShell + Category filter above table
// tab=add    → Add-packet form with Category F9
// tab=rates  → Price chart with Category filter (replaces pagination)
// ════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  Form,
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormMessage,
} from "@/components/ui/form";
import { Skeleton } from "@/components/ui/skeleton";
import { Plus } from "lucide-react";
import { fetchProducts, createProduct, getRateCategories } from "@/services/api";
import { get } from "@/lib/apiClient";
import { productSchema, type ProductFormData } from "@/lib/validations";

interface Props {
  tab?: "list" | "add" | "rates";
}

export default function ProductsPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: products = [], isLoading } = useQuery({
    queryKey: ["products"],
    queryFn: fetchProducts,
  });
  const { data: categories = [] } = useQuery({
    queryKey: ["categories"],
    queryFn: async () => {
      const data = await get<{ categories: { id: string; name: string }[] }>("/categories");
      return data.categories ?? [];
    },
  });

  const categoryOptions: F9Option[] = useMemo(
    () => categories.map(c => ({ value: c.id, label: c.name })),
    [categories]
  );

  // ── Add Packet tab ────────────────────────────────────────────
  const createMutation = useMutation({
    mutationFn: createProduct,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["products"] });
      toast.success("Product created");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to create product"),
  });

  if (tab === "add") {
    return <AddPacketTab categoryOptions={categoryOptions} createMutation={createMutation} />;
  }

  if (tab === "rates") {
    return <RateCategoriesTab products={products} categories={categories} />;
  }

  // Default: list
  return <ProductListTab products={products} categories={categories} isLoading={isLoading} />;
}

// ══════════════════════════════════════════════════════════════════
// List tab — Category filter above table
// ══════════════════════════════════════════════════════════════════
function ProductListTab({
  products,
  categories,
  isLoading,
}: {
  products: any[];
  categories: { id: string; name: string }[];
  isLoading: boolean;
}) {
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [search, setSearch] = useState("");

  const categoryNameById = useMemo(() => {
    const m = new Map<string, string>();
    categories.forEach(c => m.set(c.id, c.name));
    return m;
  }, [categories]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return products.filter(p => {
      if (categoryFilter !== "all") {
        // p.category is the category name (resolved by backend), also check id
        const catName = categoryNameById.get(categoryFilter);
        if (p.category !== catName && p.categoryId !== categoryFilter) return false;
      }
      if (q && !`${p.code} ${p.name} ${p.reportAlias}`.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [products, categoryFilter, categoryNameById, search]);

  return (
    <PageShell
      header={
        <>
          <PageHeader title="All Products" description="View all products and packets" />
          <FilterBar>
            <div className="w-60">
              <label className="text-sm font-medium mb-1.5 block">Category</label>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {categories.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex-1 min-w-60">
              <label className="text-sm font-medium mb-1.5 block">Search</label>
              <Input
                placeholder="Search by name, code, or alias"
                value={search}
                onChange={e => setSearch(e.target.value)}
              />
            </div>
          </FilterBar>
        </>
      }
    >
      {isLoading ? (
        <ScrollableTableBody>
          <div className="p-6 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        </ScrollableTableBody>
      ) : (
        <ScrollableTableBody>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left py-2.5 px-3 font-medium">Code</th>
                <th className="text-left py-2.5 px-3 font-medium">Product</th>
                <th className="text-left py-2.5 px-3 font-medium">Alias</th>
                <th className="text-left py-2.5 px-3 font-medium">Category</th>
                <th className="text-left py-2.5 px-3 font-medium">Pack</th>
                <th className="text-right py-2.5 px-3 font-medium">MRP</th>
                <th className="text-right py-2.5 px-3 font-medium">GST%</th>
                <th className="text-left py-2.5 px-3 font-medium">HSN</th>
                <th className="text-right py-2.5 px-3 font-medium">Stock</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(p => (
                <tr key={p.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono text-xs">{p.code}</td>
                  <td className="py-2 px-3 font-medium">{p.name}</td>
                  <td className="py-2 px-3 text-xs text-muted-foreground">{p.reportAlias || "—"}</td>
                  <td className="py-2 px-3 text-xs">{p.category}</td>
                  <td className="py-2 px-3 text-xs">{p.packSize} {p.unit}</td>
                  <td className="py-2 px-3 text-right font-mono">₹{p.mrp}</td>
                  <td className="py-2 px-3 text-right">{p.gstPercent}%</td>
                  <td className="py-2 px-3 font-mono text-xs">{p.hsnNo || "—"}</td>
                  <td className="py-2 px-3 text-right font-mono">{p.stock}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={9} className="py-10 text-center text-muted-foreground text-sm">
                    No products match the filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollableTableBody>
      )}
    </PageShell>
  );
}

// ══════════════════════════════════════════════════════════════════
// Add Packet tab — Category as F9
// ══════════════════════════════════════════════════════════════════
function AddPacketTab({
  categoryOptions,
  createMutation,
}: {
  categoryOptions: F9Option[];
  createMutation: any;
}) {
  const form = useForm<ProductFormData>({
    resolver: zodResolver(productSchema),
    defaultValues: {
      name: "",
      reportAlias: "",
      category: "",
      packSize: 1,
      unit: "",
      mrp: 0,
      gstPercent: 0,
      hsnNo: "",
      subsidy: false,
      subRate: 0,
      indentInBox: false,
      boxQty: 0,
      sortPosition: 0,
      packetsCrate: 0,
      printDirection: "Across",
      makeZeroInIndents: false,
    },
  });

  return (
    <div>
      <PageHeader title="Add Packet" description="Add a new product / packet" />
      <Card>
        <CardContent className="pt-6">
          <Form {...form}>
            <form
              onSubmit={form.handleSubmit(data => {
                createMutation.mutate(data, { onSuccess: () => form.reset() });
              })}
              className="space-y-4"
            >
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <FormField control={form.control} name="name" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Product Name</FormLabel>
                    <FormControl><Input placeholder="Nandini Toned Milk 500ml" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="reportAlias" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Report Alias</FormLabel>
                    <FormControl><Input placeholder="TM 500" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="category" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Category</FormLabel>
                    <FormControl>
                      <F9SearchSelect
                        value={field.value || null}
                        onChange={v => field.onChange(v ?? "")}
                        options={categoryOptions}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="packSize" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Pack Size</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field}
                        onChange={e => field.onChange(parseFloat(e.target.value) || 0)} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="unit" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Unit</FormLabel>
                    <FormControl><Input placeholder="ltr / kg / pcs" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="mrp" render={({ field }) => (
                  <FormItem>
                    <FormLabel>MRP (₹)</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field}
                        onChange={e => field.onChange(parseFloat(e.target.value) || 0)} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="gstPercent" render={({ field }) => (
                  <FormItem>
                    <FormLabel>GST %</FormLabel>
                    <FormControl>
                      <Input type="number" step="0.01" {...field}
                        onChange={e => field.onChange(parseFloat(e.target.value) || 0)} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="hsnNo" render={({ field }) => (
                  <FormItem>
                    <FormLabel>HSN Code</FormLabel>
                    <FormControl><Input placeholder="0401" {...field} /></FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="packetsCrate" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Packets per Crate</FormLabel>
                    <FormControl>
                      <Input type="number" {...field}
                        onChange={e => field.onChange(parseInt(e.target.value) || 0)} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="printDirection" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Print Direction</FormLabel>
                    <FormControl>
                      <Select value={field.value} onValueChange={field.onChange}>
                        <SelectTrigger><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="Across">Across</SelectItem>
                          <SelectItem value="Down">Down</SelectItem>
                        </SelectContent>
                      </Select>
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />

                <FormField control={form.control} name="sortPosition" render={({ field }) => (
                  <FormItem>
                    <FormLabel>Sort Position</FormLabel>
                    <FormControl>
                      <Input type="number" {...field}
                        onChange={e => field.onChange(parseInt(e.target.value) || 0)} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )} />
              </div>

              <div className="flex gap-6 pt-2">
                <FormField control={form.control} name="subsidy" render={({ field }) => (
                  <FormItem className="flex items-center gap-2">
                    <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                    <FormLabel className="!mt-0">Subsidy</FormLabel>
                  </FormItem>
                )} />
                <FormField control={form.control} name="indentInBox" render={({ field }) => (
                  <FormItem className="flex items-center gap-2">
                    <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                    <FormLabel className="!mt-0">Indent in Box</FormLabel>
                  </FormItem>
                )} />
                <FormField control={form.control} name="makeZeroInIndents" render={({ field }) => (
                  <FormItem className="flex items-center gap-2">
                    <FormControl><Switch checked={field.value} onCheckedChange={field.onChange} /></FormControl>
                    <FormLabel className="!mt-0">Make Zero in Indents</FormLabel>
                  </FormItem>
                )} />
              </div>

              <Button type="submit" disabled={createMutation.isPending}>
                <Plus className="h-4 w-4 mr-1" />
                {createMutation.isPending ? "Saving..." : "Save Product"}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Rate Categories tab — price chart with Category filter
// ══════════════════════════════════════════════════════════════════
function RateCategoriesTab({
  products,
  categories,
}: {
  products: any[];
  categories: { id: string; name: string }[];
}) {
  const rateCategories = getRateCategories(); // ["Retail-Dealer","Credit Inst-MRP",...]
  const [rateCat, setRateCat] = useState<string>(rateCategories[0]);
  const [categoryFilter, setCategoryFilter] = useState<string>("all");

  const categoryNameById = useMemo(() => {
    const m = new Map<string, string>();
    categories.forEach(c => m.set(c.id, c.name));
    return m;
  }, [categories]);

  const filtered = useMemo(() => {
    return products.filter((p: any) => {
      if (p.terminated) return false;
      if (categoryFilter !== "all") {
        const catName = categoryNameById.get(categoryFilter);
        if (p.category !== catName && p.categoryId !== categoryFilter) return false;
      }
      return true;
    });
  }, [products, categoryFilter, categoryNameById]);

  return (
    <PageShell
      header={
        <>
          <PageHeader title="Rate Categories" description="Per-rate-category pricing" />
          <FilterBar>
            <div className="w-64">
              <label className="text-sm font-medium mb-1.5 block">Rate Category</label>
              <Select value={rateCat} onValueChange={setRateCat}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {rateCategories.map((r: string) => (
                    <SelectItem key={r} value={r}>{r}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="w-60">
              <label className="text-sm font-medium mb-1.5 block">Product Category</label>
              <Select value={categoryFilter} onValueChange={setCategoryFilter}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All Categories</SelectItem>
                  {categories.map(c => (
                    <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </FilterBar>
        </>
      }
    >
      <ScrollableTableBody>
        <table className="w-full text-sm">
          <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
            <tr className="text-xs text-muted-foreground">
              <th className="text-left py-2.5 px-3 font-medium">Code</th>
              <th className="text-left py-2.5 px-3 font-medium">Product</th>
              <th className="text-left py-2.5 px-3 font-medium">Category</th>
              <th className="text-left py-2.5 px-3 font-medium">Pack</th>
              <th className="text-right py-2.5 px-3 font-medium">MRP</th>
              <th className="text-right py-2.5 px-3 font-medium">Rate ({rateCat})</th>
              <th className="text-right py-2.5 px-3 font-medium">GST%</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((p: any) => (
              <tr key={p.id} className="border-b hover:bg-muted/30">
                <td className="py-2 px-3 font-mono text-xs">{p.code}</td>
                <td className="py-2 px-3 font-medium">{p.name}</td>
                <td className="py-2 px-3 text-xs">{p.category}</td>
                <td className="py-2 px-3 text-xs">{p.packSize} {p.unit}</td>
                <td className="py-2 px-3 text-right font-mono">₹{p.mrp}</td>
                <td className="py-2 px-3 text-right font-mono font-semibold">
                  ₹{p.rateCategories?.[rateCat] ?? p.mrp}
                </td>
                <td className="py-2 px-3 text-right">{p.gstPercent}%</td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={7} className="py-10 text-center text-muted-foreground text-sm">
                  No products match the filter.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollableTableBody>
    </PageShell>
  );
}