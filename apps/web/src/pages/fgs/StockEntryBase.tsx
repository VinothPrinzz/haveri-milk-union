// apps/web/src/pages/fgs/StockEntryBase.tsx
// ════════════════════════════════════════════════════════════════════
// Shared stock-entry table used by both bucketed pages
// (StockEntryMilkCurdPage and StockEntryOthersPage).
//
// Takes a `bucket` prop. Fetches that bucket's rows from the API and
// renders the opening/received/dispatched/wastage/closing table. Each page
// is its own route so it can be gated by role independently.
//
// Dispatched is NOT editable here — it is auto-derived by the API from the
// day's dispatched/delivered orders and shown read-only. Closing recomputes
// from it live (opening + received − dispatched − wastage).
//
// The Received column is no longer a bare number: clicking it opens a
// receipt (GRN) dialog where each incoming batch is attributed to a
// supplier with a unit cost. The received total is the sum of those
// lines. Supplier/cost may be left blank for own-plant production.
// ════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar,
  EmptyState,
  Kbd,
  fmtNum,
} from "@/components/PageHeader";
import { LiveSearchTable } from "@/components/LiveSearchTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Save, Plus, Trash2, Pencil } from "lucide-react";
import { fetchStockEntries, updateStockEntries, fetchSuppliers } from "@/services/api";
import {
  type StockBucket,
  BUCKET_LABELS,
  BUCKET_SUBTITLES,
  filterByBucket,
} from "@/lib/stock-buckets";

interface Props {
  bucket: StockBucket;
}

// One receipt line as edited in the dialog. supplierId/unitCost are
// nullable — a blank line is own-plant production with no purchase cost.
interface ReceiptLine {
  supplierId: string | null;
  quantity: number;
  unitCost: number | null;
}

export default function StockEntryBase({ bucket }: Props) {
  const qc = useQueryClient();
  const [filterDate, setFilterDate] = useState(new Date().toISOString().split("T")[0]);
  // dispatched / wastage edits keyed by productId (received now comes from receipts)
  const [edits, setEdits] = useState<Record<string, Record<string, number>>>({});
  // receipt-line edits keyed by productId; presence means "replace this day's
  // receipts for the product on save" and drives the derived received total.
  const [receiptEdits, setReceiptEdits] = useState<Record<string, ReceiptLine[]>>({});
  // the row whose receipt dialog is currently open
  const [dialogProduct, setDialogProduct] = useState<any | null>(null);

  // The query key includes the bucket so each page has its own cache
  // slot — switching between pages doesn't show stale data from the
  // other bucket, and React Query refetches per page independently.
  const { data: stockEntries = [], isLoading } = useQuery({
    queryKey: ["stock-entries", bucket, filterDate],
    queryFn: () => fetchStockEntries(filterDate, bucket),
  });

  const { data: suppliers = [] } = useQuery({ queryKey: ["suppliers"], queryFn: fetchSuppliers });
  const supplierOptions: F9Option[] = useMemo(
    () =>
      suppliers
        .filter(s => s.status === "Active")
        .map(s => ({ value: s.id, label: s.name, sublabel: s.code })),
    [suppliers]
  );

  // Defence in depth: even if the backend hasn't been deployed with
  // the bucket query param yet, the client-side filter still keeps
  // the page showing only its bucket. Once backend is rolled out this
  // is a near-no-op since the server already filtered.
  const visibleEntries = filterByBucket(stockEntries as any[], bucket);

  const setEdit = (productId: string, field: string, value: number) => {
    setEdits(prev => ({
      ...prev,
      [productId]: { ...prev[productId], [field]: value },
    }));
  };

  // Received for a row: the edited receipt lines' sum if the dialog was used,
  // else the value already stored on the row.
  const computeReceived = (s: any) => {
    const re = receiptEdits[s.productId];
    return re ? re.reduce((sum, l) => sum + (l.quantity || 0), 0) : Number(s.received ?? 0);
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const rowById = new Map((visibleEntries as any[]).map(s => [s.productId, s]));
      // A product is "edited" if its dispatched/wastage OR its receipts changed.
      const editedIds = new Set<string>([
        ...Object.keys(edits),
        ...Object.keys(receiptEdits),
      ]);
      const entriesToSave = [...editedIds].map(productId => {
        const s = rowById.get(productId) ?? {};
        const e = edits[productId] ?? {};
        const re = receiptEdits[productId];
        // Opening defaults to the previous day's closing but is editable
        // (single-route testing) — persist the typed value when present.
        const entry: any = {
          productId,
          opening:    Number(e.opening ?? s.opening ?? 0),
          received:   re ? re.reduce((sum, l) => sum + (l.quantity || 0), 0) : Number(s.received ?? 0),
          // Dispatched is auto-derived server-side; sent for shape only, ignored.
          dispatched: Number(s.dispatched ?? 0),
          wastage:    Number(e.wastage    ?? s.wastage    ?? 0),
        };
        // Only send receipts when they were edited, so untouched rows keep
        // their existing supplier/cost detail (the backend leaves them alone).
        if (re) {
          entry.receipts = re.map(l => ({
            supplierId: l.supplierId,
            quantity:   l.quantity,
            unitCost:   l.unitCost,
          }));
        }
        return entry;
      });
      return updateStockEntries(filterDate, entriesToSave);
    },
    onSuccess: () => {
      toast.success("Stock entries saved");
      // Invalidate ALL stock-entries queries so the other bucket page
      // (and Stock Overview / Reports) also pick up any cross-effect.
      qc.invalidateQueries({ queryKey: ["stock-entries"] });
      setEdits({});
      setReceiptEdits({});
    },
    onError: (err: any) => toast.error(err?.message || "Failed to save stock entries"),
  });

  const editsCount = new Set<string>([
    ...Object.keys(edits),
    ...Object.keys(receiptEdits),
  ]).size;

  const computeClosing = (s: any) => {
    const e = edits[s.productId] ?? {};
    // Opening is editable; default to the row value (previous day's closing).
    const opening    = e.opening    ?? s.opening    ?? 0;
    const received   = computeReceived(s);
    // Dispatched is auto (server-derived), never a local edit.
    const dispatched = s.dispatched ?? 0;
    const wastage    = e.wastage    ?? s.wastage    ?? 0;
    return Number(opening) + Number(received) - Number(dispatched) - Number(wastage);
  };

  // Seed the dialog: prefer in-progress edits, then the row's saved receipts,
  // then a single own-plant line carrying any legacy received total so the
  // dialog total matches the cell for historical rows.
  const initialLinesFor = (s: any): ReceiptLine[] => {
    if (receiptEdits[s.productId]) return receiptEdits[s.productId];
    const existing = ((s.receipts as any[]) ?? []).map(r => ({
      supplierId: (r.supplierId ?? null) as string | null,
      quantity:   Number(r.quantity ?? 0),
      unitCost:   r.unitCost != null ? Number(r.unitCost) : null,
    }));
    if (existing.length) return existing;
    const recv = Number(s.received ?? 0);
    return recv > 0 ? [{ supplierId: null, quantity: recv, unitCost: null }] : [];
  };

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={`Stock Entry — ${BUCKET_LABELS[bucket]}`}
        subtitle={BUCKET_SUBTITLES[bucket]}
        actions={
          <Button
            size="sm"
            className="h-8"
            onClick={() => saveMutation.mutate()}
            disabled={saveMutation.isPending || editsCount === 0}
          >
            <Save className="h-3.5 w-3.5 mr-1.5" />
            {saveMutation.isPending
              ? "Saving…"
              : editsCount > 0
              ? `Save ${editsCount} change${editsCount > 1 ? "s" : ""}`
              : "Save"}
            <Kbd className="ml-2">Ctrl+S</Kbd>
          </Button>
        }
      />

      <FilterBar>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Date</label>
          <Input
            type="date"
            value={filterDate}
            onChange={e => setFilterDate(e.target.value)}
            className="erp-input w-44"
          />
        </div>
        {editsCount > 0 && (
          <div className="ml-auto self-end pb-1 text-[12px]">
            <span className="text-warning font-medium">
              {editsCount} unsaved change{editsCount > 1 ? "s" : ""}
            </span>
          </div>
        )}
      </FilterBar>

      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="erp-panel p-4 space-y-2">
            {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-8 w-full" />)}
          </div>
        ) : visibleEntries.length === 0 ? (
          <div className="erp-panel p-8">
            <EmptyState title={`No ${BUCKET_LABELS[bucket].toLowerCase()} products`} />
          </div>
        ) : (
          <div className="erp-panel overflow-hidden">
            <LiveSearchTable
              items={visibleEntries}
              getSearchableText={(s: any) => `${s.productName} ${s.category ?? ""}`}
              placeholder="Type to filter products…"
            >
              {filtered => (
                <table className="erp-table">
                  <thead>
                    <tr>
                      <th>Product</th>
                      <th>Category</th>
                      <th className="num" style={{ textAlign: "right", width: 110 }}>Opening</th>
                      <th className="num" style={{ textAlign: "right", width: 140 }}>Received</th>
                      <th className="num" style={{ textAlign: "right", width: 110 }} title="Auto-updated from dispatched routes">Dispatched</th>
                      <th className="num" style={{ textAlign: "right", width: 110 }}>Wastage</th>
                      <th className="num" style={{ textAlign: "right", width: 100 }}>Closing</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.length === 0 && (
                      <tr><td colSpan={7}><EmptyState title="No products match your search" /></td></tr>
                    )}
                    {filtered.map((s: any) => {
                      const closing = computeClosing(s);
                      return (
                        <tr key={s.productId}>
                          <td className="font-medium">{s.productName}</td>
                          <td className="text-muted-foreground uppercase">{s.category ?? "—"}</td>
                          <td style={{ textAlign: "right" }}>
                            <StockInput
                              value={edits[s.productId]?.opening ?? s.opening ?? 0}
                              onChange={v => setEdit(s.productId, "opening", v)}
                            />
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <ReceivedButton
                              value={computeReceived(s)}
                              edited={!!receiptEdits[s.productId]}
                              onClick={() => setDialogProduct(s)}
                            />
                          </td>
                          <td
                            className="num text-muted-foreground"
                            style={{ textAlign: "right" }}
                            title="Auto-updated from dispatched routes"
                          >
                            {fmtNum(s.dispatched ?? 0)}
                          </td>
                          <td style={{ textAlign: "right" }}>
                            <StockInput
                              value={edits[s.productId]?.wastage ?? s.wastage ?? 0}
                              onChange={v => setEdit(s.productId, "wastage", v)}
                            />
                          </td>
                          <td className="num font-semibold" style={{ textAlign: "right" }}>
                            {closing < 0
                              ? <span className="text-destructive">{fmtNum(closing)}</span>
                              : fmtNum(closing)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </LiveSearchTable>
          </div>
        )}
      </div>

      {dialogProduct && (
        <ReceiptDialog
          row={dialogProduct}
          supplierOptions={supplierOptions}
          initialLines={initialLinesFor(dialogProduct)}
          onClose={() => setDialogProduct(null)}
          onSave={lines => {
            setReceiptEdits(prev => ({ ...prev, [dialogProduct.productId]: lines }));
            setDialogProduct(null);
          }}
        />
      )}
    </div>
  );
}

function StockInput({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <Input
      type="number"
      min="0"
      value={value || ""}
      onChange={e => onChange(parseInt(e.target.value) || 0)}
      className="erp-input h-8 w-24 text-right inline-block num"
    />
  );
}

// The Received cell — a button showing the rolled-up total that opens the
// receipt dialog. A dot marks rows with unsaved receipt edits.
function ReceivedButton({
  value, edited, onClick,
}: { value: number; edited: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Click to record supplier(s) & cost for received stock"
      className="erp-input h-8 w-28 inline-flex items-center justify-end gap-1.5 num hover:bg-accent/50 cursor-pointer"
    >
      {edited && <span className="h-1.5 w-1.5 rounded-full bg-warning shrink-0" />}
      <span className="flex-1 text-right">{fmtNum(value)}</span>
      <Pencil className="h-3 w-3 text-muted-foreground shrink-0" />
    </button>
  );
}

// Per-product receipt (GRN) editor. Each line attributes part of the day's
// received stock to a supplier with a unit cost; the received total is the
// sum of line quantities.
function ReceiptDialog({
  row, supplierOptions, initialLines, onClose, onSave,
}: {
  row: any;
  supplierOptions: F9Option[];
  initialLines: ReceiptLine[];
  onClose: () => void;
  onSave: (lines: ReceiptLine[]) => void;
}) {
  const [lines, setLines] = useState<ReceiptLine[]>(
    initialLines.length ? initialLines : [{ supplierId: null, quantity: 0, unitCost: null }]
  );

  const update = (i: number, patch: Partial<ReceiptLine>) =>
    setLines(prev => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)));
  const addLine = () => setLines(prev => [...prev, { supplierId: null, quantity: 0, unitCost: null }]);
  const removeLine = (i: number) => setLines(prev => prev.filter((_, idx) => idx !== i));

  const totalQty  = lines.reduce((s, l) => s + (l.quantity || 0), 0);
  const totalCost = lines.reduce((s, l) => s + (l.quantity || 0) * (l.unitCost || 0), 0);

  return (
    <Dialog open onOpenChange={o => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Received — {row.productName}</DialogTitle>
        </DialogHeader>
        <p className="text-[12px] text-muted-foreground -mt-2">
          Record who each batch was purchased from and its unit cost. Leave the
          supplier/cost blank for own-plant production. Received = sum of quantities.
        </p>

        <div className="erp-panel overflow-hidden">
          <table className="erp-table">
            <thead>
              <tr>
                <th>Supplier</th>
                <th className="num" style={{ width: 100, textAlign: "right" }}>Qty</th>
                <th className="num" style={{ width: 130, textAlign: "right" }}>Unit Cost (₹)</th>
                <th className="num" style={{ width: 120, textAlign: "right" }}>Line Total</th>
                <th style={{ width: 44 }} />
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td>
                    <F9SearchSelect
                      value={l.supplierId}
                      onChange={v => update(i, { supplierId: v })}
                      options={supplierOptions}
                      allowClear
                      placeholder="Own plant / select supplier"
                      className="w-full"
                    />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Input
                      type="number"
                      min="0"
                      value={l.quantity || ""}
                      onChange={e => update(i, { quantity: parseInt(e.target.value) || 0 })}
                      className="erp-input h-8 w-20 text-right inline-block num"
                    />
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Input
                      type="number"
                      min="0"
                      step="0.01"
                      value={l.unitCost ?? ""}
                      onChange={e =>
                        update(i, { unitCost: e.target.value === "" ? null : parseFloat(e.target.value) })
                      }
                      className="erp-input h-8 w-24 text-right inline-block num"
                    />
                  </td>
                  <td className="num text-muted-foreground" style={{ textAlign: "right" }}>
                    {l.unitCost != null ? `₹${fmtNum((l.quantity || 0) * (l.unitCost || 0))}` : "—"}
                  </td>
                  <td style={{ textAlign: "right" }}>
                    <Button
                      variant="ghost"
                      size="sm"
                      className="h-7 w-7 p-0 text-destructive"
                      onClick={() => removeLine(i)}
                      title="Remove line"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between pt-1">
          <Button variant="outline" size="sm" className="h-8" onClick={addLine}>
            <Plus className="h-3.5 w-3.5 mr-1" /> Add line
          </Button>
          <div className="flex gap-6 text-[13px]">
            <span>Total received: <b className="num">{fmtNum(totalQty)}</b></span>
            <span>Total cost: <b className="num">₹{fmtNum(totalCost)}</b></span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onClose}>Cancel</Button>
          <Button
            size="sm"
            onClick={() =>
              // Drop fully-empty rows before committing back to the table.
              onSave(lines.filter(l => l.quantity > 0 || l.supplierId != null || l.unitCost != null))
            }
          >
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
