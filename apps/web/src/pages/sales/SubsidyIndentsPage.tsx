// ════════════════════════════════════════════════════════════════════
// Subsidy Indents — /sales/subsidy-indents
// Record customer indents for the subsidised HTM 1000ML pouch (customer
// pays 50%). Locked to one product; behaves like Record Indents (real
// confirmed order + credit ledger + invoice) and shows on the route sheet
// as its own "HTM 1000ML (sub)" across column.
// Backend: POST /api/v1/orders/subsidy-place
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import PageHeader, {
  FormSection, Field, FormFooter, Kbd, fmtINR,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Send } from "lucide-react";
import {
  fetchCustomers, fetchRoutes, fetchSubsidyProduct, placeSubsidyIndent,
} from "@/services/api";

export default function SubsidyIndentsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: product } = useQuery({ queryKey: ["subsidy-product"], queryFn: fetchSubsidyProduct });

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<"upi" | "credit" | "cash">("credit");
  const [paymentRef, setPaymentRef] = useState("");
  const [qty, setQty] = useState<number | undefined>(undefined);
  const [notes, setNotes] = useState("");

  const customer = customers.find((c: any) => c.id === customerId);

  const customerOpts: F9Option[] = useMemo(
    () => customers.map((c: any) => ({ value: c.id, label: c.name, sublabel: c.code })),
    [customers]
  );

  const routeOpts: F9Option[] = useMemo(() => {
    if (!customer) return [];
    const assigned = (customer.routes ?? []) as Array<{
      routeId: string; routeCode: string; routeName: string; isPrimary: boolean;
    }>;
    if (assigned.length === 0 && customer.routeId) {
      return [{
        value: customer.routeId,
        label: customer.routeName || customer.routeCode || "Primary route",
        sublabel: customer.routeCode || "",
      }];
    }
    return assigned.map(r => ({
      value: r.routeId,
      label: `${r.routeName ?? ""}${r.isPrimary ? " ★" : ""}`.trim(),
      sublabel: r.routeCode,
    }));
  }, [customer]);

  // Default route to the customer's primary, and reset when customer changes.
  useEffect(() => {
    if (!customer) { setRouteId(null); return; }
    const valid = new Set([
      ...(customer.routes ?? []).map((r: any) => r.routeId),
      customer.routeId,
    ].filter(Boolean));
    setRouteId(prev => (prev && valid.has(prev)) ? prev
      : customer.routes?.find((r: any) => r.isPrimary)?.routeId
        ?? customer.routeId
        ?? null);
  }, [customer]);

  // Default payment mode by the customer's pay mode (Cash customers → cash).
  useEffect(() => {
    if (!customer) return;
    setPaymentMode(customer.payMode === "Credit" ? "credit" : "cash");
  }, [customer]);

  useEffect(() => {
    if (paymentMode !== "upi") setPaymentRef("");
  }, [paymentMode]);

  // ── Line maths (single product) ──
  const unit = product?.unitPrice ?? 0;
  const gstPct = product?.gstPercent ?? 0;
  const q = qty ?? 0;
  const sub = unit * q;
  const gst = sub * (gstPct / 100);
  const total = sub + gst;

  const creditAvailable = customer && paymentMode === "credit"
    ? (customer as any).creditAvailable != null
        ? Number((customer as any).creditAvailable)
        : customer.creditLimit != null
          ? Number(customer.creditLimit) - Number((customer as any).outstanding ?? 0)
          : null
    : null;

  const submit = useMutation({
    mutationFn: async () => {
      if (!customer) throw new Error("Pick a customer");
      if (!product) throw new Error("Subsidy product is not configured");
      if ((qty ?? 0) <= 0) throw new Error("Enter a quantity");
      if (paymentMode === "upi" && !paymentRef.trim()) {
        throw new Error("UPI reference is required");
      }
      if (paymentMode === "credit" && creditAvailable != null && total > creditAvailable) {
        throw new Error(
          `Available balance ₹${creditAvailable.toFixed(2)} is less than indent total ₹${total.toFixed(2)}`
        );
      }
      return placeSubsidyIndent({
        customerId: customer.id,
        routeId,
        paymentMode,
        paymentReference: paymentMode === "upi" ? paymentRef.trim() : undefined,
        notes,
        quantity: qty ?? 0,
      });
    },
    onSuccess: (res) => {
      toast.success(res.appended
        ? "Subsidy added to the customer's indent for today"
        : "Subsidy indent submitted");
      qc.invalidateQueries({ queryKey: ["indents"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      navigate("/sales/all-indents");
    },
    onError: (e: any) => toast.error(e?.message || "Submit failed"),
  });

  // Ctrl+S submits.
  const formRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (!submit.isPending) submit.mutate();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [submit]);

  return (
    <div className="flex flex-col h-full" ref={formRef}>
      <PageHeader
        title="Subsidy Indents"
        subtitle="Record HTM 1000ML (sub) indents — customer pays 50%. Ctrl+S to submit."
      />
      <div className="flex-1 overflow-auto p-3 space-y-3 pb-24">
        <FormSection title="Customer" cols={4}>
          <Field label="Customer" hint="F9" required>
            <F9SearchSelect
              value={customerId} onChange={setCustomerId} options={customerOpts} className="w-full"
            />
          </Field>
          <Field label="Type">
            <Input className="erp-input bg-muted" value={customer?.type ?? ""} readOnly />
          </Field>
          <Field label="Rate Category">
            <Input className="erp-input bg-muted" value={customer?.rateCategory ?? ""} readOnly />
          </Field>
          <Field label="Pay Mode">
            <Select value={paymentMode} onValueChange={v => setPaymentMode(v as "upi" | "credit" | "cash")}>
              <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="upi">UPI</SelectItem>
                <SelectItem value="credit">Credit</SelectItem>
              </SelectContent>
            </Select>
          </Field>

          {paymentMode === "upi" && (
            <Field label="UPI Reference / Txn ID" required>
              <Input
                className="erp-input"
                value={paymentRef}
                onChange={e => setPaymentRef(e.target.value)}
                placeholder="e.g. 406812345678"
              />
            </Field>
          )}

          <Field label="Route" hint="F9">
            <F9SearchSelect value={routeId} onChange={setRouteId} options={routeOpts} className="w-full" />
          </Field>
          <Field label="Phone">
            <Input className="erp-input bg-muted" value={customer?.phone ?? ""} readOnly />
          </Field>
          <Field label="Available Balance">
            <Input
              className={`erp-input bg-muted num ${creditAvailable != null && creditAvailable < total ? "border-destructive text-destructive" : ""}`}
              value={creditAvailable != null ? `₹ ${creditAvailable.toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "—"}
              readOnly
            />
          </Field>
        </FormSection>

        <FormSection title="Subsidy Item" cols={4}>
          <Field label="Product">
            <Input className="erp-input bg-muted" value={product?.name ?? "HTM 1000ML (sub)"} readOnly />
          </Field>
          <Field label="Quantity (packets)" required>
            <Input
              className="erp-input num text-right"
              type="number" min="0" step="1"
              value={qty ?? ""}
              onChange={e => setQty(e.target.value === "" ? undefined : Math.max(0, parseInt(e.target.value) || 0))}
              autoFocus
            />
          </Field>
          <Field label="Rate (subsidised)">
            <Input className="erp-input bg-muted num" value={unit ? `₹ ${unit.toFixed(2)}` : "—"} readOnly />
          </Field>
          <Field label="GST %">
            <Input className="erp-input bg-muted num" value={`${gstPct.toFixed(2)}`} readOnly />
          </Field>
        </FormSection>

        <div className="erp-panel">
          <div className="px-3 py-2 flex items-center justify-end gap-6 text-[13px]">
            <span className="text-muted-foreground uppercase tracking-wide">Subtotal</span>
            <span className="num w-28 text-right">{fmtINR(sub)}</span>
            <span className="text-muted-foreground uppercase tracking-wide">GST</span>
            <span className="num w-28 text-right">{fmtINR(gst)}</span>
            <span className="uppercase tracking-wide font-semibold">Total</span>
            <span className="num w-32 text-right font-bold text-[14px]">{fmtINR(total)}</span>
          </div>
        </div>

        <FormSection title="Notes" cols={1}>
          <Field label="Remarks">
            <Input className="erp-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />
          </Field>
        </FormSection>
      </div>

      <FormFooter>
        <span className="text-[11px] text-muted-foreground mr-auto">
          Records an HTM 1000ML (sub) line on the customer's indent for today.
        </span>
        <Button variant="outline" size="sm" className="h-8" onClick={() => navigate(-1)}>Cancel</Button>
        <Button size="sm" className="h-8" disabled={submit.isPending || (qty ?? 0) <= 0} onClick={() => submit.mutate()}>
          {submit.isPending ? "Saving…" : (
            <span className="inline-flex items-center gap-1.5">
              <Send className="h-3.5 w-3.5" />
              Submit Indent <Kbd className="ml-1">Ctrl</Kbd>+<Kbd>S</Kbd>
            </span>
          )}
        </Button>
      </FormFooter>
    </div>
  );
}
