// ════════════════════════════════════════════════════════════════════
// Record Indent — /sales/record-indents
// Backend: POST /api/v1/orders { items, paymentMode, ... }
// status defaults to 'pending' on the server (do not send 'submitted')
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, FormSection, Field, FormFooter, Kbd, fmtINR,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Trash2, Plus, Send } from "lucide-react";
import {
  fetchCustomers, fetchProducts, fetchRoutes, createIndent,
} from "@/services/api";

interface Line {
  id: string;
  productId: string;
  qty: number;
}

const rid = () => Math.random().toString(36).slice(2, 9);

export default function RecordIndentsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const { data: products = [] }  = useQuery({ queryKey: ["products"],  queryFn: fetchProducts });
  const { data: routes = [] }    = useQuery({ queryKey: ["routes"],    queryFn: fetchRoutes });

  const [customerId, setCustomerId] = useState<string | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<"upi" | "credit">("credit");   // ← Updated
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([{ id: rid(), productId: "", qty: 1 }]);

  const customer = customers.find((c: any) => c.id === customerId);
  const customerOpts: F9Option[] = useMemo(
    () => customers.map((c: any) => ({ value: c.id, label: c.name, sublabel: c.code })),
    [customers]
  );
  const routeOpts: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );
  const productOpts: F9Option[] = useMemo(
    () => products.map((p: any) => ({ value: p.id, label: p.name, sublabel: p.code })),
    [products]
  );

  // When a customer is chosen, default the route to their primary
  useEffect(() => {
    if (!customer) return;
    const primary = customer.routes?.find((r: any) => r.isPrimary)?.routeId
                   ?? customer.routeId
                   ?? null;
    setRouteId(prev => prev ?? primary);
  }, [customer]);

  // Default payment mode by customer.payMode
  useEffect(() => {
    if (!customer) return;
    setPaymentMode(customer.payMode === "Credit" ? "credit" : "upi");
  }, [customer]);

  // Per-line price = product.basePrice (server uses base_price; rate-category-aware
  // pricing is server-side. Price shown here is indicative only.)
  const lineCalc = (line: Line) => {
    const p = products.find((x: any) => x.id === line.productId);
    if (!p) return { unit: 0, gstPct: 0, sub: 0, gst: 0, total: 0 };
    // Prefer the rate matching the customer's rateCategory if surfaced.
    const rcKey = customer?.rateCategory as string | undefined;
    const rcPriceMap: Record<string, string> = {
      "Retail-Dealer":      "retailDealerPrice",
      "Credit Inst-MRP":    "creditInstMrpPrice",
      "Credit Inst-Dealer": "creditInstDealerPrice",
      "Parlour-Dealer":     "parlourDealerPrice",
    };
    const rcKeyApi = rcKey && rcPriceMap[rcKey];
    const unitRaw  = (rcKeyApi && (p as any)[rcKeyApi]) ?? p.mrp;
    const unit     = parseFloat(String(unitRaw)) || 0;
    const gstPct   = parseFloat(String(p.gstPercent ?? 0)) || 0;
    const sub      = unit * (line.qty || 0);
    const gst      = sub * (gstPct / 100);
    return { unit, gstPct, sub, gst, total: sub + gst };
  };

  const totals = useMemo(() => {
    let sub = 0, gst = 0;
    for (const l of lines) {
      const c = lineCalc(l);
      sub += c.sub; gst += c.gst;
    }
    return { sub, gst, total: sub + gst, count: lines.filter(l => l.productId && l.qty > 0).length };
  }, [lines, products, customer]);

  const addLine = () => setLines(ls => [...ls, { id: rid(), productId: "", qty: 1 }]);
  const removeLine = (id: string) => setLines(ls => ls.length === 1 ? ls : ls.filter(l => l.id !== id));
  const setLineProduct = (id: string, productId: string | null) =>
    setLines(ls => ls.map(l => l.id === id ? { ...l, productId: productId ?? "" } : l));
  const setLineQty = (id: string, qty: number) =>
    setLines(ls => ls.map(l => l.id === id ? { ...l, qty: Math.max(0, qty || 0) } : l));

  const submit = useMutation({
    mutationFn: async () => {
      if (!customer) throw new Error("Pick a customer");
      const items = lines
        .filter(l => l.productId && l.qty > 0)
        .map(l => ({ productId: l.productId, quantity: l.qty }));
      if (items.length === 0) throw new Error("Add at least one line");

      // Credit-limit guard — only for credit mode
      if (paymentMode === "credit") {
        const available = Number(
          (customer as any).creditAvailable
            ?? (customer.creditLimit != null
                  ? Number(customer.creditLimit) - Number((customer as any).outstanding ?? 0)
                  : Infinity)
        );
        if (Number.isFinite(available) && totals.total > available) {
          throw new Error(
            `Available credit ₹${available.toFixed(2)} is less than indent total ₹${totals.total.toFixed(2)}`
          );
        }
      }

      return createIndent({ 
        customerId: customer.id, 
        routeId, 
        paymentMode,     // now only "upi" | "credit"
        notes, 
        items 
      });
    },
    onSuccess: () => {
      toast.success("Indent submitted");
      qc.invalidateQueries({ queryKey: ["indents"] });
      qc.invalidateQueries({ queryKey: ["customers"] });
      navigate("/sales/all-indents");
    },
    onError: (e: any) => toast.error(e?.message || "Submit failed"),
  });

  // ── Keyboard: F2 add line, Ctrl+S submit ──
  const formRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        addLine();
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (!submit.isPending) submit.mutate();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [submit]);

  // Real credit-available comes from the backend now (ledger-derived).
  // Falls back to (limit - outstanding) if only those are present, then
  // to (limit - 0) if even outstanding is missing — same shape as
  // before, but the first branch is the truthful one.
  const creditAvailable = customer && paymentMode === "credit"
    ? (customer as any).creditAvailable != null
        ? Number((customer as any).creditAvailable)
        : customer.creditLimit != null
          ? Number(customer.creditLimit) - Number((customer as any).outstanding ?? 0)
          : null
    : null;

  return (
    <div className="flex flex-col h-full" ref={formRef}>
      <PageHeader
        title="Record Indent"
        subtitle={`Press ${(<Kbd>F2</Kbd> as any).type ? "F2" : "F2"} to add a line, Ctrl+S to submit.`}
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
            <Select value={paymentMode} onValueChange={v => setPaymentMode(v as "upi" | "credit")}>
              <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="upi">UPI</SelectItem>
                <SelectItem value="credit">Credit</SelectItem>
                {/* Wallet removed */}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Route" hint="F9">
            <F9SearchSelect value={routeId} onChange={setRouteId} options={routeOpts} className="w-full" />
          </Field>
          <Field label="Phone">
            <Input className="erp-input bg-muted" value={customer?.phone ?? ""} readOnly />
          </Field>
          <Field label="Credit Limit">
            <Input
              className="erp-input bg-muted num"
              value={customer?.creditLimit != null ? `₹ ${Number(customer.creditLimit).toLocaleString("en-IN")}` : ""}
              readOnly
            />
          </Field>
          <Field label="Outstanding">
            <Input
              className="erp-input bg-muted num"
              value={
                customer?.outstanding != null
                  ? `₹ ${Number((customer as any).outstanding).toLocaleString("en-IN", { minimumFractionDigits: 2 })}`
                  : "—"
              }
              readOnly
            />
          </Field>
          <Field label="Available Credit">
            <Input
              className={`erp-input bg-muted num ${creditAvailable != null && creditAvailable < totals.total ? "border-destructive text-destructive" : ""}`}
              value={creditAvailable != null ? `₹ ${creditAvailable.toLocaleString("en-IN", { minimumFractionDigits: 2 })}` : "—"}
              readOnly
            />
          </Field>
        </FormSection>

        <div className="erp-panel">
          <div className="px-3 py-2 erp-section-title !mb-0 !border-b !pb-2 flex items-center justify-between">
            <span>Items</span>
            <span className="text-[11px] normal-case font-normal text-muted-foreground">
              <Kbd>F2</Kbd> add line · <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> submit
            </span>
          </div>
          <div className="overflow-auto">
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 40 }}>#</th>
                  <th style={{ width: "32%" }}>Product</th>
                  <th style={{ width: 90 }} className="num">Qty</th>
                  <th style={{ width: 100 }} className="num">Rate</th>
                  <th style={{ width: 110 }} className="num">Subtotal</th>
                  <th style={{ width: 70  }} className="num">GST %</th>
                  <th style={{ width: 110 }} className="num">GST ₹</th>
                  <th style={{ width: 130 }} className="num">Line Total</th>
                  <th style={{ width: 40 }}></th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const c = lineCalc(l);
                  return (
                    <tr key={l.id}>
                      <td className="num">{i + 1}</td>
                      <td>
                        <F9SearchSelect
                          value={l.productId || null}
                          onChange={v => setLineProduct(l.id, v)}
                          options={productOpts}
                          className="w-full"
                        />
                      </td>
                      <td>
                        <Input
                          className="erp-input num text-right"
                          type="number" min="0" step="1"
                          value={l.qty}
                          onChange={e => setLineQty(l.id, parseFloat(e.target.value))}
                        />
                      </td>
                      <td className="num">{c.unit ? c.unit.toFixed(2) : "—"}</td>
                      <td className="num">{c.sub ? fmtINR(c.sub) : "—"}</td>
                      <td className="num">{c.gstPct ? c.gstPct.toFixed(2) : "—"}</td>
                      <td className="num">{c.gst ? fmtINR(c.gst) : "—"}</td>
                      <td className="num font-semibold">{c.total ? fmtINR(c.total) : "—"}</td>
                      <td>
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                          onClick={() => removeLine(l.id)}
                          disabled={lines.length === 1}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr>
                  <td colSpan={9} className="!border-t-2">
                    <Button variant="outline" size="sm" className="h-7" onClick={addLine}>
                      <Plus className="h-3.5 w-3.5 mr-1" /> Add Line  <Kbd className="ml-2">F2</Kbd>
                    </Button>
                  </td>
                </tr>
                <tr className="bg-muted/40">
                  <td colSpan={4} className="text-right uppercase text-[12px] font-semibold tracking-wide">Subtotal</td>
                  <td className="num">{fmtINR(totals.sub)}</td>
                  <td className="text-right uppercase text-[12px] font-semibold tracking-wide" colSpan={1}>GST</td>
                  <td className="num">{fmtINR(totals.gst)}</td>
                  <td className="num font-bold text-[14px]">{fmtINR(totals.total)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          </div>
        </div>

        <FormSection title="Notes" cols={1}>
          <Field label="Remarks">
            <Input className="erp-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />
          </Field>
        </FormSection>
      </div>

      <FormFooter>
        <Button variant="outline" size="sm" className="h-8" onClick={() => navigate(-1)}>Cancel</Button>
        <Button size="sm" className="h-8" disabled={submit.isPending} onClick={() => submit.mutate()}>
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