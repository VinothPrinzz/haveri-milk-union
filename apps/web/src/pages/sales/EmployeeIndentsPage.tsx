// apps/web/src/pages/sales/EmployeeIndentsPage.tsx
// ═══════════════════════════════════════════════════════════════════════
// Employee Indents (admin) — view + edit ANY employee's standing-indent
// template and per-date draft orders, priced at the employee-subsidy rate.
//
// Employees have NO app login, so this admin screen (plus the nightly
// materializer + close-time auto-confirm worker) is the entire flow.
//
// Route:   /sales/employee-indents
// Perms:   reads need indents.view, writes need indents.manage
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
  fetchEmployees,
  fetchEmployeeStandingIndents,
  saveEmployeeStandingIndents,
  fetchEmployeeDraft,
  patchEmployeeDraft,
  confirmEmployeeDraft,
} from "@/services/api";

const todayIso = () => new Date().toISOString().slice(0, 10);

function QtyField({
  value,
  onChange,
  disabled,
}: {
  value: number | undefined;
  onChange: (n: number | undefined) => void;
  disabled?: boolean;
}) {
  return (
    <Input
      type="number"
      min={0}
      value={value ?? ""}
      disabled={disabled}
      onChange={(e) =>
        onChange(e.target.value === "" ? undefined : Math.max(0, parseInt(e.target.value) || 0))
      }
      className="erp-input num h-6 w-16 text-center px-1"
      placeholder="—"
    />
  );
}

export default function EmployeeIndentsPage() {
  const qc = useQueryClient();

  const [employeeId, setEmployeeId] = useState<string | null>(null);
  const [date, setDate] = useState<string>(todayIso());

  const [template, setTemplate] = useState<Record<string, { qty: number; active: boolean }>>({});
  const [draftQty, setDraftQty] = useState<Record<string, number>>({});

  // ── Employee picker ──
  const { data: employees = [] } = useQuery({
    queryKey: ["employees-all"],
    queryFn: () => fetchEmployees(),
  });
  const employeeOptions: F9Option[] = useMemo(
    () =>
      (employees as any[]).map((e) => ({
        value: String(e.id),
        label: e.name,
        sublabel: e.employee_code ?? "",
      })),
    [employees]
  );

  // ── Standing-indent template ──
  const templateQuery = useQuery({
    queryKey: ["admin-employee-standing-indents", employeeId],
    enabled: !!employeeId,
    queryFn: () => fetchEmployeeStandingIndents(employeeId!),
  });

  // ── Draft for the selected date ──
  const draftQuery = useQuery({
    queryKey: ["admin-employee-draft", employeeId, date],
    enabled: !!employeeId && !!date,
    queryFn: () => fetchEmployeeDraft(employeeId!, date),
  });

  useEffect(() => {
    const items = templateQuery.data?.items ?? [];
    const next: Record<string, { qty: number; active: boolean }> = {};
    for (const it of items) next[it.productId] = { qty: it.defaultQty, active: it.active };
    setTemplate(next);
  }, [templateQuery.data]);

  useEffect(() => {
    const items = draftQuery.data?.items ?? [];
    const next: Record<string, number> = {};
    for (const it of items) next[it.productId] = it.quantity;
    setDraftQty(next);
  }, [draftQuery.data]);

  const saveTemplate = useMutation({
    mutationFn: () =>
      saveEmployeeStandingIndents(employeeId!, {
        items: (templateQuery.data?.items ?? []).map((it: any) => ({
          productId: it.productId,
          defaultQty: template[it.productId]?.qty ?? 0,
          active: template[it.productId]?.active ?? false,
        })),
      }),
    onSuccess: () => {
      toast.success("Standing indent saved");
      qc.invalidateQueries({ queryKey: ["admin-employee-standing-indents", employeeId] });
      qc.invalidateQueries({ queryKey: ["admin-employee-draft", employeeId] });
    },
    onError: (e: any) => toast.error(e?.message || "Save failed"),
  });

  const saveDraft = useMutation({
    mutationFn: () =>
      patchEmployeeDraft(employeeId!, date, {
        items: Object.entries(draftQty)
          .filter(([, q]) => q > 0)
          .map(([productId, quantity]) => ({ productId, quantity })),
      }),
    onSuccess: () => {
      toast.success("Draft updated");
      qc.invalidateQueries({ queryKey: ["admin-employee-draft", employeeId, date] });
    },
    onError: (e: any) => toast.error(e?.message || "Update failed"),
  });

  const confirmDraft = useMutation({
    mutationFn: (force: boolean) => confirmEmployeeDraft(employeeId!, date, { force }),
    onSuccess: (res: any) => {
      toast.success(
        res?.forced
          ? "Draft confirmed (credit limit overridden)"
          : "Draft confirmed — indent placed & ledger posted"
      );
      qc.invalidateQueries({ queryKey: ["admin-employee-draft", employeeId, date] });
    },
    onError: (e: any) => {
      if (e?.status === 402) {
        if (
          window.confirm(
            `${e.message}\n\nPlace anyway (override credit limit)? Otherwise it stays held for finance to release.`
          )
        ) {
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
        title="Employee Indents"
        subtitle="Standing-indent templates & daily drafts at subsidy pricing — view and edit for any employee"
      />

      <FilterBar>
        <div className="min-w-[260px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
            Employee
          </label>
          <F9SearchSelect
            value={employeeId}
            onChange={setEmployeeId}
            options={employeeOptions}
            placeholder="Pick an employee…"
            modalTitle="Select Employee"
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
        {!employeeId ? (
          <EmptyState
            title="Select an employee"
            hint="Pick an employee above to view their standing indent and drafts."
          />
        ) : (
          <>
            {/* ── Finance / credit snapshot ── */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Credit Limit" value={fmtINR(credit?.creditLimit ?? 0)} />
              <StatCard label="Outstanding" value={fmtINR(credit?.outstanding ?? 0)} tone="warning" />
              <StatCard label="Available Credit" value={fmtINR(credit?.available ?? 0)} tone="success" />
              <StatCard
                label="This Draft"
                value={fmtINR(draftTotal.grand)}
                hint={
                  credit && draftTotal.grand > credit.available ? "Over available credit" : "Within credit"
                }
                tone={credit && draftTotal.grand > credit.available ? "danger" : "default"}
              />
            </div>

            {/* ── Standing indent template ── */}
            <div className="erp-panel overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 border-b border-border bg-muted/40">
                <div>
                  <h3 className="font-semibold text-[14px]">Standing Indent Template</h3>
                  <p className="text-[12px] text-muted-foreground">
                    Subsidy-eligible products only · priced at base × (1 − subsidy%)
                  </p>
                </div>
                <Button
                  size="sm"
                  className="h-7"
                  disabled={saveTemplate.isPending}
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
                <EmptyState
                  title="No subsidy-eligible products"
                  hint="Add active rules in employee subsidy settings to make products available here."
                />
              ) : (
                <table className="erp-table w-full text-[13px]">
                  <thead>
                    <tr>
                      <th className="text-left">Product</th>
                      <th className="text-right">MRP</th>
                      <th className="text-center">Subsidy</th>
                      <th className="text-right">Pays</th>
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
                              <span className="ml-2 text-[11px] text-destructive">unavailable</span>
                            )}
                          </td>
                          <td className="text-right text-muted-foreground">{fmtINR(it.basePrice)}</td>
                          <td className="text-center text-[12px]">{it.subsidyPercent}%</td>
                          <td className="text-right">{fmtINR(it.unitPrice)}</td>
                          <td>
                            <div className="flex justify-center">
                              <QtyField
                                value={row.qty}
                                onChange={(qty) =>
                                  setTemplate((p) => ({ ...p, [it.productId]: { ...row, qty: qty ?? 0 } }))
                                }
                              />
                            </div>
                          </td>
                          <td>
                            <div className="flex justify-center">
                              <Switch
                                checked={row.active}
                                onCheckedChange={(active) =>
                                  setTemplate((p) => ({ ...p, [it.productId]: { ...row, active } }))
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
                    <h3 className="font-semibold text-[14px]">Draft for {date}</h3>
                    <p className="text-[12px] text-muted-foreground">
                      {draft?.exists ? "Materialized draft indent" : "Preview synthesized from the standing indent"}
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
                    disabled={!editable || confirmDraft.isPending || draftTotal.grand <= 0}
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
              ) : (draft?.items ?? []).length === 0 ? (
                <EmptyState
                  title="Nothing in this draft"
                  hint="Add products to the standing indent, or enter quantities for this date."
                />
              ) : (
                <>
                  {!editable && (
                    <div className="px-4 py-2 text-[12px] text-muted-foreground bg-muted/30 border-b border-border">
                      {draft?.status === "payment_required"
                        ? "This indent is over the credit limit and held for finance to release."
                        : "This indent is already placed and is read-only."}
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
                                <QtyField
                                  value={q}
                                  disabled={!editable}
                                  onChange={(quantity) =>
                                    setDraftQty((p) => ({ ...p, [it.productId]: quantity ?? 0 }))
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
