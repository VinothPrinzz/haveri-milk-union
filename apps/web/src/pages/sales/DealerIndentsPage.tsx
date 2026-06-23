// apps/web/src/pages/sales/DealerIndentsPage.tsx
// ═══════════════════════════════════════════════════════════════════════
// Dealer Indents (admin) — view + edit ANY dealer's standing-indent
// template and per-date draft orders, with the dealer's live credit
// standing shown alongside.
//
// Route:   /sales/dealer-indents
// Perms:   reads need dealers.view, writes need dealers.manage
// ═══════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save, CheckCircle2, CalendarClock } from "lucide-react";
import PageHeader, {
  FilterBar,
  StatCard,
  StatusPill,
  EmptyState,
  fmtINR,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import {
  fetchCustomers,
  fetchDealerStandingIndents,
  saveDealerStandingIndents,
  fetchDealerDraft,
  patchDealerDraft,
  confirmDealerDraft,
} from "@/services/api";
import { violatesMinQty, MIN_ORDER_QTY } from "@/lib/minOrderQty";

const todayIso = () => new Date().toISOString().slice(0, 10);

// ── Quantity field (no steppers — manual entry only) ────────────────────
function QtyStepper({
  value,
  onChange,
  disabled,
  invalid,
}: {
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  return (
    <Input
      type="number"
      min={0}
      value={value ?? ""}
      disabled={disabled}
      title={invalid ? `Milk & Curd require a minimum quantity of ${MIN_ORDER_QTY}` : undefined}
      onChange={(e) =>
        onChange(e.target.value === "" ? undefined : Math.max(0, parseInt(e.target.value) || 0))
      }
      className={`erp-input num h-6 w-16 text-center px-1 ${invalid ? "border-destructive text-destructive" : ""}`}
      placeholder="—"
    />
  );
}

export default function DealerIndentsPage() {
  const qc = useQueryClient();

  const [dealerId, setDealerId] = useState<string | null>(null);
  const [date, setDate] = useState<string>(todayIso());

  // Local edit buffers — initialised from server data, flushed on Save.
  const [template, setTemplate] = useState<Record<string, { qty: number; active: boolean }>>({});
  const [draftQty, setDraftQty] = useState<Record<string, number>>({});

  // ── Dealer picker ──
  const { data: customers = [] } = useQuery({
    queryKey: ["customers"],
    queryFn: fetchCustomers,
  });
  const dealerOptions: F9Option[] = useMemo(
    () =>
      (customers as any[]).map((c) => ({
        value: String(c.customerId ?? c.id),
        label: c.customerName ?? c.name,
        sublabel: c.code,
      })),
    [customers]
  );

  // ── Standing-indent template ──
  const templateQuery = useQuery({
    queryKey: ["admin-standing-indents", dealerId],
    enabled: !!dealerId,
    queryFn: () => fetchDealerStandingIndents(dealerId!),
  });

  // ── Draft for the selected date ──
  const draftQuery = useQuery({
    queryKey: ["admin-dealer-draft", dealerId, date],
    enabled: !!dealerId && !!date,
    queryFn: () => fetchDealerDraft(dealerId!, date),
  });

  // Seed local buffers whenever fresh server data arrives.
  useEffect(() => {
    const items = templateQuery.data?.items ?? [];
    const next: Record<string, { qty: number; active: boolean }> = {};
    for (const it of items) {
      next[it.productId] = { qty: it.defaultQty, active: it.active };
    }
    setTemplate(next);
  }, [templateQuery.data]);

  useEffect(() => {
    const items = draftQuery.data?.items ?? [];
    const next: Record<string, number> = {};
    for (const it of items) next[it.productId] = it.quantity;
    setDraftQty(next);
  }, [draftQuery.data]);

  // ── Mutations ──
  const saveTemplate = useMutation({
    mutationFn: () =>
      saveDealerStandingIndents(dealerId!, {
        items: (templateQuery.data?.items ?? []).map((it: any) => ({
          productId: it.productId,
          defaultQty: template[it.productId]?.qty ?? 0,
          active: template[it.productId]?.active ?? false,
        })),
      }),
    onSuccess: () => {
      toast.success("Standing indent saved");
      qc.invalidateQueries({ queryKey: ["admin-standing-indents", dealerId] });
      qc.invalidateQueries({ queryKey: ["admin-dealer-draft", dealerId] });
    },
    onError: (e: any) => toast.error(e?.message || "Save failed"),
  });

  const saveDraft = useMutation({
    mutationFn: () =>
      patchDealerDraft(dealerId!, date, {
        items: Object.entries(draftQty)
          .filter(([, q]) => q > 0)
          .map(([productId, quantity]) => ({ productId, quantity })),
      }),
    onSuccess: () => {
      toast.success("Draft updated");
      qc.invalidateQueries({ queryKey: ["admin-dealer-draft", dealerId, date] });
    },
    onError: (e: any) => toast.error(e?.message || "Update failed"),
  });

  const confirmDraft = useMutation({
    mutationFn: (force: boolean) => confirmDealerDraft(dealerId!, date, { force }),
    onSuccess: (res: any) => {
      toast.success(
        res?.forced
          ? "Draft confirmed (credit limit overridden)"
          : "Draft confirmed — order placed & ledger posted"
      );
      qc.invalidateQueries({ queryKey: ["admin-dealer-draft", dealerId, date] });
    },
    onError: (e: any) => {
      // 402 → over credit limit; offer an override.
      if (e?.status === 402) {
        if (window.confirm(`${e.message}\n\nPlace the order anyway (override)?`)) {
          confirmDraft.mutate(true);
        }
        return;
      }
      toast.error(e?.message || "Confirm failed");
    },
  });

  const draft = draftQuery.data;
  const credit = draft?.credit;
  const editable = draft?.editable ?? false;

  // ── Per-line Milk/Curd minimum (6) guards ──
  // Template: only ACTIVE lines auto-place, so only those are blocked.
  const templateHasMinQtyViolation = useMemo(
    () =>
      (templateQuery.data?.items ?? []).some((it: any) => {
        const row = template[it.productId];
        return !!row?.active && violatesMinQty(it.categoryName, row.qty);
      }),
    [templateQuery.data, template]
  );
  // Draft: a draft can be saved with any qty, but it can't be CONFIRMED
  // while a Milk/Curd line sits at 1–5.
  const draftHasMinQtyViolation = useMemo(
    () =>
      (draft?.items ?? []).some((it: any) =>
        violatesMinQty(it.categoryName, draftQty[it.productId] ?? 0)
      ),
    [draft, draftQty]
  );

  const draftTotal = useMemo(() => {
    const items = draft?.items ?? [];
    let subtotal = 0;
    let gst = 0;
    for (const it of items) {
      const q = draftQty[it.productId] ?? 0;
      const line = it.unitPrice * q;
      subtotal += line;
      gst += line * (it.gstPercent / 100);
    }
    return { subtotal, gst, grand: subtotal + gst };
  }, [draft, draftQty]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Dealer Indents"
        subtitle="Standing-indent templates & daily drafts — view and edit for any dealer"
      />

      <FilterBar>
        <div className="min-w-[260px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
            Dealer
          </label>
          <F9SearchSelect
            value={dealerId}
            onChange={setDealerId}
            options={dealerOptions}
            placeholder="Pick a dealer…"
            modalTitle="Select Dealer"
            allowClear
          />
        </div>
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
            Delivery date
          </label>
          <Input
            type="date"
            value={date}
            onChange={(e) => setDate(e.target.value)}
            className="erp-input w-44"
          />
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {!dealerId ? (
          <EmptyState
            title="Select a dealer"
            hint="Pick a dealer above to view their standing indent and drafts."
          />
        ) : (
          <>
            {/* ── Finance / credit snapshot ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Credit Limit" value={fmtINR(credit?.creditLimit ?? 0)} />
              <StatCard
                label="Outstanding"
                value={fmtINR(credit?.outstanding ?? 0)}
                tone="warning"
              />
              <StatCard
                label="Available Credit"
                value={fmtINR(credit?.available ?? 0)}
                tone="success"
              />
              <StatCard
                label="This Draft"
                value={fmtINR(draftTotal.grand)}
                hint={
                  credit && draftTotal.grand > credit.available
                    ? "Over available credit"
                    : "Within credit"
                }
                tone={
                  credit && draftTotal.grand > credit.available ? "danger" : "default"
                }
              />
            </div>

            {/* ── Standing indent template ── */}
            <div className="erp-panel overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/40">
                <div>
                  <h3 className="font-semibold text-[14px]">Standing Indent Template</h3>
                  <p className="text-[12px] text-muted-foreground">
                    Per-product default quantities the nightly worker materializes into drafts
                  </p>
                </div>
                <Button
                  size="sm"
                  className="h-7"
                  disabled={saveTemplate.isPending || templateHasMinQtyViolation}
                  title={
                    templateHasMinQtyViolation
                      ? `Milk & Curd require a minimum quantity of ${MIN_ORDER_QTY}`
                      : undefined
                  }
                  onClick={() => saveTemplate.mutate()}
                >
                  <Save className="h-3.5 w-3.5 mr-1.5" />
                  {saveTemplate.isPending ? "Saving…" : "Save Template"}
                </Button>
              </div>

              {templateQuery.isLoading ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 5 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : (templateQuery.data?.items ?? []).length === 0 ? (
                <EmptyState title="No eligible products" />
              ) : (
                <table className="erp-table w-full text-[13px]">
                  <thead>
                    <tr>
                      <th className="text-left">Product</th>
                      <th className="text-right">Base Price</th>
                      <th className="text-center">Default Qty</th>
                      <th className="text-center">Active</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(templateQuery.data?.items ?? []).map((it: any) => {
                      const row = template[it.productId] ?? { qty: 0, active: false };
                      return (
                        <tr key={it.productId}>
                          <td>
                            {it.productName}
                            <span className="text-muted-foreground"> / {it.unit}</span>
                            {!it.productAvailable && (
                              <span className="ml-2 text-[11px] text-destructive">
                                unavailable
                              </span>
                            )}
                          </td>
                          <td className="text-right">{fmtINR(it.basePrice)}</td>
                          <td>
                            <div className="flex justify-center">
                              <QtyStepper
                                value={row.qty}
                                invalid={!!row.active && violatesMinQty(it.categoryName, row.qty)}
                                onChange={(qty) =>
                                  setTemplate((p) => ({
                                    ...p,
                                    [it.productId]: { ...row, qty },
                                  }))
                                }
                              />
                            </div>
                          </td>
                          <td>
                            <div className="flex justify-center">
                              <Switch
                                checked={row.active}
                                onCheckedChange={(active) =>
                                  setTemplate((p) => ({
                                    ...p,
                                    [it.productId]: { ...row, active },
                                  }))
                                }
                              />
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>

            {/* ── Draft for the date ── */}
            <div className="erp-panel overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/40">
                <div className="flex items-center gap-2">
                  <CalendarClock className="h-4 w-4 text-muted-foreground" />
                  <div>
                    <h3 className="font-semibold text-[14px]">
                      Draft for {date}
                    </h3>
                    <p className="text-[12px] text-muted-foreground">
                      {draft?.exists
                        ? "Materialized draft order"
                        : "Preview synthesized from the standing indent"}
                    </p>
                  </div>
                  {draft?.status && <StatusPill status={draft.status} />}
                </div>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7"
                    disabled={!editable || saveDraft.isPending}
                    onClick={() => saveDraft.mutate()}
                  >
                    <Save className="h-3.5 w-3.5 mr-1.5" />
                    {saveDraft.isPending ? "Saving…" : "Save Draft"}
                  </Button>
                  <Button
                    size="sm"
                    className="h-7"
                    disabled={
                      !editable ||
                      confirmDraft.isPending ||
                      draftTotal.grand <= 0 ||
                      draftHasMinQtyViolation
                    }
                    title={
                      draftHasMinQtyViolation
                        ? `Milk & Curd require a minimum quantity of ${MIN_ORDER_QTY}`
                        : undefined
                    }
                    onClick={() => confirmDraft.mutate(false)}
                  >
                    <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
                    {confirmDraft.isPending ? "Placing…" : "Confirm & Place"}
                  </Button>
                </div>
              </div>

              {draftQuery.isLoading ? (
                <div className="p-4 space-y-2">
                  {Array.from({ length: 4 }).map((_, i) => (
                    <Skeleton key={i} className="h-8 w-full" />
                  ))}
                </div>
              ) : draft?.paused ? (
                <EmptyState
                  title="Indents paused for this date"
                  hint={draft.pausedReason || "A pause window covers this delivery date."}
                />
              ) : (draft?.items ?? []).length === 0 ? (
                <EmptyState
                  title="Nothing in this draft"
                  hint="Add products to the standing indent, or place an order for this date."
                />
              ) : (
                <>
                  {!editable && (
                    <div className="px-4 py-2 text-[12px] text-muted-foreground bg-muted/30 border-b border-border">
                      This indent is already placed and is read-only.
                    </div>
                  )}
                  <table className="erp-table w-full text-[13px]">
                    <thead>
                      <tr>
                        <th className="text-left">Product</th>
                        <th className="text-right">Unit Price</th>
                        <th className="text-center">Qty</th>
                        <th className="text-right">Line Total</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(draft?.items ?? []).map((it: any) => {
                        const q = draftQty[it.productId] ?? 0;
                        const line = it.unitPrice * q * (1 + it.gstPercent / 100);
                        return (
                          <tr key={it.productId}>
                            <td>
                              {it.productName}
                              <span className="text-muted-foreground"> / {it.unit}</span>
                            </td>
                            <td className="text-right">{fmtINR(it.unitPrice)}</td>
                            <td>
                              <div className="flex justify-center">
                                <QtyStepper
                                  value={q}
                                  disabled={!editable}
                                  invalid={violatesMinQty(it.categoryName, q)}
                                  onChange={(quantity) =>
                                    setDraftQty((p) => ({
                                      ...p,
                                      [it.productId]: quantity,
                                    }))
                                  }
                                />
                              </div>
                            </td>
                            <td className="text-right">{fmtINR(line)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="font-semibold border-t border-border">
                        <td colSpan={3} className="text-right">
                          Grand Total (incl. GST)
                        </td>
                        <td className="text-right">{fmtINR(draftTotal.grand)}</td>
                      </tr>
                    </tfoot>
                  </table>
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}