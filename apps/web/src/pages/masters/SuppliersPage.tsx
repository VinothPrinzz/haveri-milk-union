// ════════════════════════════════════════════════════════════════════
// All Suppliers / New Supplier — stock vendors master.
// Routes: /masters/suppliers + /masters/suppliers/new
// Mirrors ContractorsPage conventions, trimmed to supplier fields.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar,
  Field,
  StatusPill,
  EmptyState,
} from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { X, Plus } from "lucide-react";
import {
  fetchSuppliers,
  createSupplier,
  updateSupplier,
  deleteSupplier,
  fetchSupplierCosts,
  saveSupplierCosts,
  type Supplier,
  type SupplierCostRow,
} from "@/services/api";
import { SupplierForm } from "@/components/suppliers/SupplierForm";
import { LiveSearchTable } from "@/components/LiveSearchTable";
import type { SupplierFormData } from "@/lib/validations";

// ─────────────────────────────────────────────────────────────────
// Purchase rate card — one current unit cost per product for a supplier.
// Stock Entry pre-fills a received line's cost from it when this supplier
// is picked. Only edited lines are sent; a cleared box removes the rate.
// ─────────────────────────────────────────────────────────────────
function SupplierRatesDialog({ supplier, onClose }: { supplier: Supplier; onClose: () => void }) {
  const qc = useQueryClient();
  // productId → the box's text, for lines the operator has touched.
  const [edits, setEdits] = useState<Record<string, string>>({});

  const { data: rows = [], isLoading } = useQuery({
    queryKey: ["supplier-costs", supplier.id],
    queryFn: () => fetchSupplierCosts(supplier.id),
  });

  const valueOf = (r: SupplierCostRow) =>
    edits[r.productId] ?? (r.unitCost != null ? String(r.unitCost) : "");

  const dirty = useMemo(
    () =>
      rows.filter((r) => {
        const e = edits[r.productId];
        if (e === undefined) return false;
        const saved = r.unitCost != null ? String(r.unitCost) : "";
        return e.trim() !== saved;
      }),
    [rows, edits],
  );

  const save = useMutation({
    mutationFn: () =>
      saveSupplierCosts(
        supplier.id,
        dirty.map((r) => {
          const v = (edits[r.productId] ?? "").trim();
          return { productId: r.productId, unitCost: v === "" ? null : Number(v) };
        }),
      ),
    onSuccess: (res: any) => {
      toast.success(res?.message || "Rates saved");
      qc.invalidateQueries({ queryKey: ["supplier-costs"] });
      qc.invalidateQueries({ queryKey: ["supplier-cost-map"] });
      setEdits({});
    },
    onError: (e: any) => toast.error(e?.message || "Failed to save rates"),
  });

  const pricedCount = rows.filter((r) => valueOf(r).trim() !== "").length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Purchase Rates: {supplier.code} {supplier.name}</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground -mt-2">
          Set what this supplier charges per unit, product by product. Stock Entry fills the cost in
          automatically when this supplier is chosen on a received-stock line. Leave a box blank for
          products you don't buy from them.
        </p>

        <div className="flex-1 overflow-auto erp-panel">
          {isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : (
            <LiveSearchTable
              items={rows}
              getSearchableText={(r) => `${r.productName} ${r.productCode} ${r.categoryName}`}
              placeholder="Type to filter products…"
            >
              {(filtered) => (
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th style={{ width: 100 }}>Code</th>
                      <th>Product</th>
                      <th style={{ width: 140 }}>Category</th>
                      <th className="num" style={{ width: 150, textAlign: "right" }}>Unit Cost (₹)</th>
                      <th style={{ width: 120 }}>Last Updated</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={5}><EmptyState title="No products match your search" /></td></tr>
                    )}
                    {filtered.map((r) => (
                      <tr key={r.productId}>
                        <td className="font-mono text-[12.5px]">{r.productCode || ""}</td>
                        <td className="font-medium">{r.productName}</td>
                        <td className="text-muted-foreground uppercase text-[12px]">{r.categoryName}</td>
                        <td style={{ textAlign: "right" }}>
                          <Input
                            type="number"
                            min="0"
                            step="0.001"
                            placeholder=""
                            value={valueOf(r)}
                            onChange={(e) => setEdits((prev) => ({ ...prev, [r.productId]: e.target.value }))}
                            className="erp-input h-8 w-28 text-right inline-block num"
                          />
                        </td>
                        <td className="text-[12px] text-muted-foreground">
                          {r.updatedAt ? new Date(r.updatedAt).toLocaleDateString("en-IN") : ""}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </LiveSearchTable>
          )}
        </div>

        <DialogFooter className="!justify-between items-center">
          <span className="text-[12px] text-muted-foreground">
            {pricedCount} of {rows.length} products priced
            {dirty.length > 0 && (
              <span className="text-warning font-medium ml-2">
                · {dirty.length} unsaved change{dirty.length > 1 ? "s" : ""}
              </span>
            )}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={onClose}>Close</Button>
            <Button size="sm" disabled={save.isPending || dirty.length === 0} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save Rates"}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface Props {
  tab?: "list" | "new";
}

const STATUS_OPTIONS: F9Option[] = [
  { value: "Active", label: "Active" },
  { value: "Inactive", label: "Inactive" },
];

export default function SuppliersPage({ tab = "list" }: Props) {
  const qc = useQueryClient();
  const { data: suppliers = [], isLoading } = useQuery({
    queryKey: ["suppliers"],
    queryFn: fetchSuppliers,
  });

  const createMutation = useMutation({
    mutationFn: createSupplier,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      toast.success("Supplier created");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to create supplier"),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, data }: { id: string; data: SupplierFormData }) =>
      updateSupplier(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      toast.success("Supplier updated");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to update supplier"),
  });

  if (tab === "new") {
    return (
      <div>
        <PageHeader title="New Supplier" subtitle="Add a new stock supplier" />
        <div className="p-4">
          <div className="erp-panel p-4">
            <SupplierForm
              onSubmit={async data => {
                await createMutation.mutateAsync(data as any);
              }}
              isSubmitting={createMutation.isPending}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <SupplierListTab
      suppliers={suppliers}
      isLoading={isLoading}
      updateMutation={updateMutation}
      qc={qc}
    />
  );
}

function SupplierListTab({
  suppliers,
  isLoading,
  updateMutation,
  qc,
}: {
  suppliers: Supplier[];
  isLoading: boolean;
  updateMutation: any;
  qc: ReturnType<typeof useQueryClient>;
}) {
  const [nameFilter, setNameFilter] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<string | null>(null);
  const [generated, setGenerated] = useState(false);
  const [editing, setEditing] = useState<Supplier | null>(null);
  const [viewing, setViewing] = useState<Supplier | null>(null);
  const [ratesFor, setRatesFor] = useState<Supplier | null>(null);

  const nameOptions: F9Option[] = useMemo(
    () => suppliers.map(s => ({ value: s.id, label: s.name, sublabel: s.code })),
    [suppliers]
  );

  const filtered = useMemo(() => {
    if (!generated) return [];
    return suppliers.filter(s => {
      if (nameFilter && s.id !== nameFilter) return false;
      if (statusFilter && s.status !== statusFilter) return false;
      return true;
    });
  }, [suppliers, nameFilter, statusFilter, generated]);

  const clearFilters = () => {
    setNameFilter(null);
    setStatusFilter(null);
    setGenerated(false);
  };

  const deleteMutation = useMutation({
    mutationFn: deleteSupplier,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["suppliers"] });
      toast.success("Supplier deleted");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to delete supplier"),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="All Suppliers"
        subtitle="View and manage stock suppliers"
        actions={
          <Button asChild size="sm" className="h-8">
            <a href="/masters/suppliers/new"><Plus className="h-3.5 w-3.5 mr-1" /> New</a>
          </Button>
        }
      />

      <FilterBar>
        <Field label="Name">
          <F9SearchSelect value={nameFilter} onChange={setNameFilter} options={nameOptions} allowAll className="w-64" />
        </Field>
        <Field label="Status">
          <F9SearchSelect value={statusFilter} onChange={setStatusFilter} options={STATUS_OPTIONS} allowAll className="w-40" />
        </Field>
        <div className="flex items-end gap-2">
          <Button size="sm" className="h-8" onClick={() => setGenerated(true)}>Generate</Button>
          {generated && (
            <Button size="sm" variant="outline" className="h-8" onClick={clearFilters}>
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          )}
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {!generated ? (
            <EmptyState
              title="Set filters and click Generate"
              hint="Or leave all filters as ‘All’ to list every supplier."
            />
          ) : isLoading ? (
            <div className="p-4 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 100 }}>Code</th>
                  <th>Name</th>
                  <th style={{ width: 130 }}>Phone</th>
                  <th style={{ width: 160 }}>GST No.</th>
                  <th>Address</th>
                  <th style={{ width: 90 }}>Status</th>
                  <th style={{ width: 290, textAlign: "right" }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => (
                  <tr key={s.id}>
                    <td className="font-mono">{s.code}</td>
                    <td className="font-medium">{s.name}</td>
                    <td className="font-mono text-[12.5px]">{s.phone || ""}</td>
                    <td className="font-mono text-[12.5px]">{s.gstNo || ""}</td>
                    <td className="text-[12.5px]">{s.address || ""}</td>
                    <td><StatusPill status={s.status === "Active" ? "active" : "draft"} /></td>
                    <td style={{ textAlign: "right" }}>
                      <div className="flex items-center justify-end gap-1.5">
                        <Button variant="outline" size="sm" className="h-7 px-2.5 text-[12px]" onClick={() => setViewing(s)}>
                          View
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2.5 text-[12px]"
                          title="Product-wise purchase rates, auto-filled in Stock Entry"
                          onClick={() => setRatesFor(s)}
                        >
                          Rates
                        </Button>
                        <Button size="sm" className="h-7 px-2.5 text-[12px]" onClick={() => setEditing(s)}>
                          Update
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-7 px-2.5 text-[12px] text-destructive"
                          onClick={() => {
                            if (confirm(`Delete supplier "${s.name}"?`)) deleteMutation.mutate(s.id);
                          }}
                        >
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={7} className="py-8 text-center text-muted-foreground">No suppliers match the selected filters.</td></tr>
                )}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Edit Dialog */}
      {editing && (
        <Dialog open onOpenChange={o => !o && setEditing(null)}>
          <DialogContent className="max-w-3xl max-h-[90vh] overflow-auto">
            <DialogHeader>
              <DialogTitle>Edit Supplier: {editing.code}</DialogTitle>
            </DialogHeader>
            <SupplierForm
              initialData={editing}
              isSubmitting={updateMutation.isPending}
              onSubmit={async data => {
                await updateMutation.mutateAsync({ id: editing.id, data });
                setEditing(null);
              }}
            />
          </DialogContent>
        </Dialog>
      )}

      {ratesFor && <SupplierRatesDialog supplier={ratesFor} onClose={() => setRatesFor(null)} />}

      {/* View Dialog */}
      <Dialog open={!!viewing} onOpenChange={o => !o && setViewing(null)}>
        <DialogContent className="max-w-xl">
          <DialogHeader><DialogTitle>{viewing?.code}: {viewing?.name}</DialogTitle></DialogHeader>
          {viewing && (() => {
            const Row = ({ label, value }: { label: string; value: any }) => (
              <div className="flex items-baseline gap-2 py-1 border-b border-border/60 last:border-0">
                <span className="text-[11px] uppercase tracking-wide text-muted-foreground w-32 shrink-0">{label}</span>
                <span className="text-[13px] font-medium">{value}</span>
              </div>
            );
            return (
              <div className="grid grid-cols-2 gap-x-6">
                <Row label="Code" value={<span className="font-mono">{viewing.code}</span>} />
                <Row label="Status" value={<StatusPill status={viewing.status === "Active" ? "active" : "draft"} />} />
                <Row label="Name" value={viewing.name} />
                <Row label="Phone" value={viewing.phone} />
                <Row label="GST No." value={viewing.gstNo} />
                <Row label="Account" value={viewing.accountNo} />
                <Row label="Address" value={viewing.address} />
              </div>
            );
          })()}
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setViewing(null)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
