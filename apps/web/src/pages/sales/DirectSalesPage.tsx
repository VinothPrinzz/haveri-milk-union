// ════════════════════════════════════════════════════════════════════
// FULL REPLACEMENT for: apps/web/src/pages/sales/DirectSalesPage.tsx
//
// Fix B12: The Items card on Gate-Pass and Cash-Customer tabs now
// matches the look & functionality of the Record-Indents card:
//   • Product picker is F9SearchSelect (was a plain Select that doesn't
//     scale beyond a handful of products)
//   • Picking a product auto-fills Rate + GST% from product master
//   • Columns: # | Product | Qty | Rate | Subtotal | GST % | GST ₹ |
//              Line Total | (delete)
//   • Footer row: Subtotal · GST · Grand Total (matches indent layout)
//   • Add-line button moved INTO the table footer (like indents)
//   • Modify tab is unchanged.
// ════════════════════════════════════════════════════════════════════
import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useNavigate, useSearchParams } from "react-router-dom";
import PageHeader, {
  FilterBar, FormSection, FormFooter, Field, fmtINR, fmtDate, StatusPill, Kbd, StatCard,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Plus, Save, Trash2 } from "lucide-react";
import {
  fetchProducts, fetchCustomers, fetchRoutes,
  createGatePassSale, createCashSale,
  fetchVipContacts, createVipContact, createVipSampleSale,
  fetchEmployees, fetchEmployeeSubsidyRules, createEmployeeSubsidySale,
  fetchEmployeeCredit,
  type Product,
} from "@/services/api";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { get, patch } from "@/lib/apiClient";

interface Props { tab?: "gate-pass" | "cash-customer" | "modify"| "vip-sample" | "employee-subsidy"; }

// Shared line shape — productName cached so totals stay correct after
// the row's Product changes mid-edit (same approach as RecordIndents).
type Line = {
  id: string;
  productId: string;
  qty?: number;
  rate?: number;
  gstPercent?: number;
};

const rid = () => Math.random().toString(36).slice(2, 9);
const newLine = (): Line => ({ id: rid(), productId: "", qty: undefined, rate: undefined, gstPercent: undefined });

export default function DirectSalesPage({ tab = "gate-pass" }: Props) {
  if (tab === "cash-customer") return <CashCustomerTab />;
  if (tab === "modify")        return <ModifyTab />;
  if (tab === "vip-sample")        return <VipSampleTab />;
  if (tab === "employee-subsidy")  return <EmployeeSubsidyTab />;
  return <GatePassTab />;
}

// ════════════════════════════════════════════════════════════════════
// Shared Items table (mirrors Record-Indents) — used by both
// Gate-Pass and Cash-Customer tabs.
// ════════════════════════════════════════════════════════════════════
function ItemsCard({
  lines, setLines, products,
}: {
  lines: Line[];
  setLines: React.Dispatch<React.SetStateAction<Line[]>>;
  products: Product[];
}) {
  const productOpts: F9Option[] = useMemo(
    () => products.map(p => ({ value: p.id, label: p.name, sublabel: p.code })),
    [products],
  );

  const lineCalc = (l: Line) => {
    const sub   = (l.qty || 0) * (l.rate || 0);
    const gstRs = sub * ((l.gstPercent || 0) / 100);
    return { sub, gstRs, total: sub + gstRs };
  };

  const totals = useMemo(() => {
    let sub = 0, gst = 0;
    for (const l of lines) {
      const c = lineCalc(l);
      sub += c.sub; gst += c.gstRs;
    }
    return { sub, gst, total: sub + gst };
  }, [lines]);

  const addLine = () => setLines(prev => [...prev, newLine()]);
  const removeLine = (id: string) =>
    setLines(prev => prev.length === 1 ? prev : prev.filter(l => l.id !== id));

  const setLineProduct = (id: string, productId: string | null) =>
    setLines(prev => prev.map(l => {
      if (l.id !== id) return l;
      const p = products.find(x => x.id === productId);
      // Auto-fill rate + GST from master, like RecordIndents does.
      return {
        ...l,
        productId: productId ?? "",
        rate: p ? (parseFloat(String(p.basePrice ?? 0)) || l.rate) : l.rate,
        gstPercent:  p ? (parseFloat(String(p.gstPercent ?? 0))  || l.gstPercent)  : l.gstPercent,
      };
    }));

  const setQty = (id: string, qty: number | undefined) =>
    setLines(prev => prev.map(l => l.id === id ? { ...l, qty } : l));
  const setRate = (id: string, rate: number | undefined) =>
    setLines(prev => prev.map(l => l.id === id ? { ...l, rate } : l));
  const setGstPct = (id: string, pct: number | undefined) =>
    setLines(prev => prev.map(l => l.id === id ? { ...l, gstPercent: pct } : l));

  return (
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
              <th style={{ width: 90 }}  className="num">Qty</th>
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
                      value={l.qty ?? ""}
                      onChange={e => setQty(l.id, e.target.value === "" ? undefined : parseFloat(e.target.value))}
                    />
                  </td>
                  <td>
                    <Input
                      className="erp-input num text-right"
                      type="number" min="0" step="0.01"
                      value={l.rate ?? ""}
                      onChange={e => setRate(l.id, e.target.value === "" ? undefined : parseFloat(e.target.value))}
                    />
                  </td>
                  <td className="num">{c.sub ? fmtINR(c.sub) : "—"}</td>
                  <td>
                    <Input
                      className="erp-input num text-right"
                      type="number" min="0" max="100" step="0.01"
                      value={l.gstPercent ?? ""}
                      onChange={e => setGstPct(l.id, e.target.value === "" ? undefined : parseFloat(e.target.value))}
                    />
                  </td>
                  <td className="num">{c.gstRs ? fmtINR(c.gstRs) : "—"}</td>
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
              <td className="text-right uppercase text-[12px] font-semibold tracking-wide">GST</td>
              <td className="num">{fmtINR(totals.gst)}</td>
              <td className="num font-bold text-[14px]">{fmtINR(totals.total)}</td>
              <td></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Gate Pass tab
// ════════════════════════════════════════════════════════════════════
function GatePassTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const { data: routes = [] }    = useQuery({ queryKey: ["routes"],    queryFn: fetchRoutes });
  const { data: products = [] }  = useQuery({ queryKey: ["products"],  queryFn: fetchProducts });

  const customerOpts: F9Option[] = useMemo(
    () => customers.map((c: any) => ({ value: c.id, label: c.name, sublabel: c.code })),
    [customers],
  );
  const routeOpts: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes],
  );

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate]               = useState(today);
  const [customerId, setCustomerId]   = useState<string | null>(null);
  const [routeId, setRouteId]         = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi" | "credit">("cash");
  const [paymentRef,  setPaymentRef]  = useState("");     // UPI txn ID / receipt no.
  const [notes, setNotes]             = useState("");
  const [lines, setLines]             = useState<Line[]>([newLine()]);

  const customer = customers.find((c: any) => c.id === customerId);

  // Auto-default route to customer's primary, like RecordIndents
  useEffect(() => {
    if (!customer) return;
    const primary = customer.routes?.find((r: any) => r.isPrimary)?.routeId
                 ?? customer.routeId ?? null;
    setRouteId(prev => prev ?? primary);
  }, [customer]);

  const submit = useMutation({
    mutationFn: () => createGatePassSale({
      saleDate: date,
      customerId: customer?.id,
      routeId: routeId ?? undefined,
      paymentMode,
      paymentRef: paymentRef.trim() || undefined,   // ← ADD
      notes,
      items: lines
        .filter(l => l.productId && (l.qty ?? 0) > 0)
        .map(l => ({
          productId:  l.productId,
          quantity:   l.qty ?? 0,
          unitPrice:  l.rate,
          gstPercent: l.gstPercent,
        })),
    } as any),
    onSuccess: () => {
      toast.success("Gate Pass issued");
      qc.invalidateQueries({ queryKey: ["direct-sales"] });
      qc.invalidateQueries({ queryKey: ["indents"] });
      navigate("/sales/direct-sales/recent");
      setLines([newLine()]); setCustomerId(null); setNotes(""); setPaymentRef("");
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  // Keyboard: F2 add line, Ctrl+S submit
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        setLines(prev => [...prev, newLine()]);
      } else if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S")) {
        e.preventDefault();
        if (!submit.isPending && customer && lines.some(l => l.productId && (l.qty ?? 0) > 0)) {
          submit.mutate();
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [submit, customer, lines]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Gate Pass"
        subtitle="Issue a gate-pass for an over-the-counter dealer pickup. F2 add line · Ctrl+S submit."
      />
      <div className="flex-1 overflow-auto p-3 space-y-3 pb-24">
      <FormSection title="Sale Header" cols={4}>
        <Field label="Date" required>
          <Input type="date" className="erp-input" value={date} onChange={e => setDate(e.target.value)} />
        </Field>
        <Field label="Customer" required hint="F9">
          <F9SearchSelect
            value={customerId}
            onChange={setCustomerId}
            options={customerOpts}
            className="w-full"
          />
        </Field>
        <Field label="Route" hint="F9">
          <F9SearchSelect
            value={routeId}
            onChange={setRouteId}
            options={routeOpts}
            allowAll
            className="w-full"
          />
        </Field>
        <Field label="Payment Mode">
          <Select
            value={paymentMode}
            onValueChange={(v: any) => { setPaymentMode(v); setPaymentRef(""); }}
          >
            <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="cash">Cash</SelectItem>
              <SelectItem value="upi">UPI</SelectItem>
              <SelectItem value="credit">Credit</SelectItem>
            </SelectContent>
          </Select>
        </Field>
    
        {/* UPI Reference — shown only when UPI is selected */}
        {paymentMode === "upi" && (
          <Field label="UPI Reference / Txn ID" required>
            <Input
              className="erp-input"
              value={paymentRef}
              onChange={e => setPaymentRef(e.target.value)}
              placeholder="e.g. 406812345678"
              autoFocus
            />
          </Field>
        )}
      </FormSection>

        {/* Items card — same layout as Record-Indents */}
        <ItemsCard lines={lines} setLines={setLines} products={products as Product[]} />

        <FormSection title="Notes" cols={1}>
          <Field label="Remarks">
            <Input className="erp-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />
          </Field>
        </FormSection>
      </div>

      <FormFooter>
        <Button
          size="sm"
          className="h-8 bg-primary hover:bg-primary-hover"
          disabled={
            submit.isPending ||
            !customer ||
            !lines.some(l => l.productId && (l.qty ?? 0) > 0) ||
            (paymentMode === "upi" && !paymentRef.trim())
          }
          onClick={() => submit.mutate()}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {submit.isPending ? "Saving…" : (
            <span className="inline-flex items-center gap-1.5">
              Issue Gate Pass <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd>
            </span>
          )}
        </Button>
      </FormFooter>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Cash Customer tab
// ════════════════════════════════════════════════════════════════════
function CashCustomerTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });

  const today = new Date().toISOString().slice(0, 10);
  const [name, setName]               = useState("");
  const [phone, setPhone]             = useState("");
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi">("cash");
  const [paymentRef,  setPaymentRef]  = useState("");
  const [notes, setNotes]             = useState("");
  const [lines, setLines]             = useState<Line[]>([newLine()]);

  const submit = useMutation({
    mutationFn: () => (createCashSale as any)({
      saleDate: today,
      customerName: name,
      customerPhone: phone,
      paymentMode,
      paymentRef: paymentRef.trim() || undefined,
      notes,
      items: lines
        .filter(l => l.productId && (l.qty ?? 0) > 0)
        .map(l => ({
          productId:  l.productId,
          quantity:   l.qty ?? 0,
          unitPrice:  l.rate,
          gstPercent: l.gstPercent,
        })),
    }),
    onSuccess: () => {
      toast.success("Cash Sale recorded");
      qc.invalidateQueries({ queryKey: ["direct-sales"] });
      navigate("/sales/direct-sales/recent");
      setName(""); setPhone(""); setLines([newLine()]); setNotes(""); setPaymentRef("");
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); setLines(prev => [...prev, newLine()]); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!submit.isPending && name && lines.some(l => l.productId && (l.qty ?? 0) > 0)) {
          submit.mutate();
        }
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [submit, name, lines]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Cash Sale" subtitle="Walk-in customer. F2 add line · Ctrl+S submit." />

      <div className="flex-1 overflow-auto p-3 space-y-3 pb-24">
        <FormSection title="Walk-in Customer" cols={3}>
          <Field label="Name" required>
            <Input className="erp-input" value={name} onChange={e => setName(e.target.value)} />
          </Field>
          <Field label="Phone">
            <Input className="erp-input" value={phone} onChange={e => setPhone(e.target.value)} maxLength={10} />
          </Field>
          <Field label="Payment">
            <Select value={paymentMode} onValueChange={v => setPaymentMode(v as any)}>
              <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="upi">UPI</SelectItem>
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
                autoFocus
              />
            </Field>
          )}
        </FormSection>

        {/* Items card — identical to Gate-Pass + Record-Indents */}
        <ItemsCard lines={lines} setLines={setLines} products={products as Product[]} />

        <FormSection title="Notes" cols={1}>
          <Field label="Remarks">
            <Input className="erp-input" value={notes} onChange={e => setNotes(e.target.value)} placeholder="Optional" />
          </Field>
        </FormSection>
      </div>

      <FormFooter>
        <Button
          size="sm"
          className="h-8 bg-primary hover:bg-primary-hover"
          disabled={
            submit.isPending ||
            !name.trim() ||
            !lines.some(l => l.productId && (l.qty ?? 0) > 0) ||
            (paymentMode === "upi" && !paymentRef.trim())
          }
          onClick={() => submit.mutate()}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {submit.isPending ? "Saving…" : (
            <span className="inline-flex items-center gap-1.5">
              Record Cash Sale <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd>
            </span>
          )}
        </Button>
      </FormFooter>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Modify tab — UNCHANGED behaviour. Paste the existing ModifyTab()
// implementation from your current DirectSalesPage.tsx (the long
// function that loads an indent by id and PATCHes /orders/:id/items).
// Nothing in ModifyTab needed editing for this fix.
// ════════════════════════════════════════════════════════════════════
function ModifyTab() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const initialId = params.get("indentId") ?? "";
  // "order" (default) for indents; "direct-sale" for gate-pass / cash / vip / employee
  const sourceType = (params.get("type") === "direct-sale" ? "direct-sale" : "order") as
    "order" | "direct-sale";

  const [indentId, setIndentId] = useState(initialId);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  // `uid` is a stable client key so rows don't remount when a new line's
  // product is picked; `isNew` flags a line the admin added in this edit
  // (indents only) so it renders a product picker instead of static text.
  const [items, setItems] = useState<Array<{
    uid: string;
    productId: string; productName: string; quantity: number;
    unitPrice: number; gstPercent: number;
    isNew?: boolean;
  }>>([]);
  const [meta, setMeta] = useState<{
    dealerName?: string; status?: string; createdAt?: string;
  } | null>(null);
  // Finance context (indent/credit orders only). `originalTotal` is the total
  // as last saved; `credit.available` already reflects THIS order's debit, so
  // the difference below is the incremental debit/refund an edit will post.
  const [originalTotal, setOriginalTotal] = useState(0);
  const [paymentMode, setPaymentMode] = useState<string | null>(null);
  const [credit, setCredit] = useState<{ available: number; outstanding: number } | null>(null);
  // Refundable online (Razorpay) payment on this order, if any — drives the
  // "refund to bank vs available balance" choice on a downward edit.
  const [onlinePayment, setOnlinePayment] = useState<{ refundable: number } | null>(null);
  // When a downward edit can go to bank OR balance, we ask the admin first.
  const [refundPrompt, setRefundPrompt] = useState(false);

  // Product master — powers the picker for NEW lines. Indents only: the
  // /orders/:id/items endpoint reprices every line from the product master,
  // accepts arbitrary products, AND rebuilds the whole line set — so a line
  // dropped from the payload is deleted. Direct sales reject add/swap and
  // leave omitted lines untouched, so add/remove is gated to indents.
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });
  const canEditItems = sourceType === "order";

  // ── Endpoint helpers ───────────────────────────────────────────────
  const getPath   = (id: string) =>
    sourceType === "direct-sale" ? `/direct-sales/${id}` : `/orders/${id}`;
  const patchPath = (id: string) =>
    sourceType === "direct-sale" ? `/direct-sales/${id}/items` : `/orders/${id}/items`;

  const fetchIndent = useMutation({
    mutationFn: async (id: string) => get<any>(getPath(id)),
    onSuccess: (resp) => {
      if (sourceType === "direct-sale") {
        // GET /direct-sales/:id → { sale, items, customer, gatePassItems }
        const sale = resp.sale ?? {};
        setLoadedId(sale.id);
        setMeta({
          dealerName: resp.customer?.name ?? sale.customer_name ?? "—",
          status:     "confirmed",                                     // direct sales are always posted
          createdAt:  sale.sale_date ?? sale.created_at,
        });
        // Direct sales carry no dealer-credit context here.
        setOriginalTotal(parseFloat(String(sale.grand_total ?? sale.total ?? 0)) || 0);
        setPaymentMode(null);
        setCredit(null);
        setOnlinePayment(null);
        // direct_sale_items query uses raw pgClient → snake_case keys
        setItems((resp.items ?? []).map((it: any) => ({
          uid:         rid(),
          productId:   String(it.product_id),
          productName: String(it.product_name ?? ""),
          quantity:    Number(it.quantity),
          unitPrice:   parseFloat(String(it.unit_price))  || 0,
          gstPercent:  parseFloat(String(it.gst_percent)) || 0,
        })));
      } else {
        // GET /orders/:id → { order, items }
        // items come from Drizzle → CAMEL CASE keys (this was the bug)
        setLoadedId(resp.order.id);
        setMeta({
          dealerName: resp.order.dealer_name,
          status:     resp.order.status,
          createdAt:  resp.order.created_at,
        });
        setOriginalTotal(parseFloat(String(resp.order.grand_total)) || 0);
        setPaymentMode(resp.order.payment_mode ?? null);
        setCredit(resp.credit ?? null);
        setOnlinePayment(resp.onlinePayment ?? null);
        setItems((resp.items ?? []).map((it: any) => ({
          uid:         rid(),
          productId:   String(it.productId),
          productName: String(it.productName ?? ""),
          quantity:    Number(it.quantity),
          unitPrice:   parseFloat(String(it.unitPrice))   || 0,
          gstPercent:  parseFloat(String(it.gstPercent))  || 0,
        })));
      }
    },
    onError: (e: any) => toast.error(e?.message || "Indent not found"),
  });

  useEffect(() => {
    if (initialId && !loadedId) fetchIndent.mutate(initialId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = useMutation({
    mutationFn: async (refundMethod?: "balance" | "razorpay") => {
      if (!loadedId) throw new Error("Load an indent first");
      // Only qty is editable, so we send the same productIds back with new qty.
      const payload = items
        .filter(i => i.productId)            // safety
        .map(i => ({ productId: i.productId, quantity: i.quantity }));
      if (payload.length === 0) throw new Error("Nothing to save");
      return patch<any>(patchPath(loadedId), refundMethod ? { items: payload, refundMethod } : { items: payload });
    },
    onSuccess: (resp: any) => {
      const r = resp?.refund;
      if (r?.method === "razorpay") toast.success(`Saved — ${fmtINR(r.amount)} refunded to the dealer's bank`);
      else if (r?.method === "balance") toast.success(`Saved — ${fmtINR(r.amount)} credited to available balance`);
      else if (r?.method === "wallet") toast.success(`Saved — ${fmtINR(r.amount)} refunded to wallet`);
      else toast.success("Saved");
      qc.invalidateQueries({ queryKey: ["indents"] });
      qc.invalidateQueries({ queryKey: ["recent-sales"] });
      qc.invalidateQueries({ queryKey: ["recent-direct-sales"] });
      // Reload the authoritative totals + dealer balance so the summary and
      // difference reset to the newly-saved baseline.
      if (loadedId) fetchIndent.mutate(loadedId);
    },
    onError: (e: any) => toast.error(e?.message || "Save failed"),
  });

  const totals = useMemo(() => {
    const sub = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
    const gst = items.reduce((s, i) => s + i.unitPrice * i.quantity * (i.gstPercent / 100), 0);
    return { sub, gst, total: sub + gst };
  }, [items]);

  // ── Add-product support (indents only) ─────────────────────────────────
  // A new line starts empty; picking a product fills rate + GST from the
  // master (matching what /orders/:id/items will charge). We block picking a
  // product already on the order — the endpoint replaces the whole item set,
  // so a duplicate line would double-count stock and totals.
  const selectedIds = useMemo(
    () => new Set(items.map(i => i.productId).filter(Boolean)),
    [items],
  );
  const productOptsFor = (ownId: string): F9Option[] =>
    products
      .filter(p => p.id === ownId || !selectedIds.has(p.id))
      .map(p => ({ value: p.id, label: p.name, sublabel: p.code }));
  const addProductRow = () =>
    setItems(arr => [
      ...arr,
      { uid: rid(), productId: "", productName: "", quantity: 0, unitPrice: 0, gstPercent: 0, isNew: true },
    ]);
  const removeRow = (uid: string) =>
    setItems(arr => {
      const next = arr.filter(r => r.uid !== uid);
      // An indent must keep at least one product line.
      if (!next.some(r => r.productId)) {
        toast.error("An indent must have at least one product");
        return arr;
      }
      return next;
    });
  const pickProduct = (uid: string, productId: string | null) =>
    setItems(arr => arr.map(row => {
      if (row.uid !== uid) return row;
      const p = products.find(x => x.id === productId);
      return {
        ...row,
        productId:   productId ?? "",
        productName: p?.name ?? "",
        unitPrice:   p ? (parseFloat(String(p.basePrice ?? 0)) || 0) : 0,
        gstPercent:  p ? (parseFloat(String(p.gstPercent ?? 0)) || 0) : 0,
      };
    }));

  // ── Finance impact (credit indents only) ──────────────────────────────
  // difference > 0 → extra amount to DEBIT; < 0 → amount to CREDIT back.
  const difference       = totals.total - originalTotal;
  const isCredit         = sourceType === "order" && paymentMode === "credit";
  const availableBalance = credit?.available ?? null;
  // Show the dealer's live balance for ANY indent (informational); the
  // ledger-impact bits below stay specific to credit-mode indents.
  const showBalance      = sourceType === "order" && availableBalance != null;
  // available already excludes the original order's debit, so what's left
  // after this edit is available − difference.
  const projectedBalance = availableBalance != null ? availableBalance - difference : null;
  // Non-wallet indents (credit + upi) settle against the available balance.
  const nonWallet = sourceType === "order" && paymentMode != null && paymentMode !== "wallet";
  // Hard block: an upward change may not exceed the dealer's available
  // balance. Small epsilon absorbs GST rounding between UI and server.
  const overBalance = nonWallet && availableBalance != null && difference - availableBalance > 0.01;

  // A downward edit on an online-paid indent can be refunded to the bank OR
  // the available balance — ask the admin which. Everything else (wallet,
  // credit, no online payment, or an increase) saves straight through.
  const isRefund = difference < -0.01;
  const canChooseRefund =
    sourceType === "order" && paymentMode === "upi" && isRefund &&
    (onlinePayment?.refundable ?? 0) > 0.01;

  function commitSave() {
    if (!loadedId || save.isPending || overBalance) return;
    // A new line with a quantity but no product would be silently dropped —
    // flag it so the admin either picks a product or removes the row.
    if (items.some(i => i.isNew && i.quantity > 0 && !i.productId)) {
      toast.error("Select a product for the new line, or remove it");
      return;
    }
    if (canChooseRefund) { setRefundPrompt(true); return; }
    save.mutate(undefined);
  }

  // Ctrl+S only; F2 (add-line) removed — only qty is editable now.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S") && loadedId) {
        e.preventDefault();
        commitSave();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [save, loadedId, overBalance, canChooseRefund]);

  const titleSubtitle = sourceType === "direct-sale"
    ? "Modify a sale (gate-pass, cash, VIP, employee). Only quantities can be updated."
    : "Modify an indent — edit quantities, add or remove products.";

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Indent Modify" subtitle={titleSubtitle} />

      <FilterBar>
        <Field label={sourceType === "direct-sale" ? "Sale ID" : "Indent ID"}>
          <Input
            className="erp-input w-96 font-mono"
            value={indentId}
            onChange={e => setIndentId(e.target.value)}
            placeholder="paste full UUID"
            autoFocus
          />
        </Field>
        <div className="flex items-end">
          <Button
            size="sm" className="h-8"
            disabled={!indentId.trim() || fetchIndent.isPending}
            onClick={() => fetchIndent.mutate(indentId.trim())}
          >
            {fetchIndent.isPending ? "Loading…" : "Load"}
          </Button>
        </div>
        {meta && (
          <div className="ml-auto self-center text-[12px] text-muted-foreground">
            <span className="font-medium text-foreground">{meta.dealerName}</span>
            <span className="mx-2">·</span>
            <StatusPill status={meta.status ?? "pending"} />
            <span className="mx-2">·</span>
            <span>{fmtDate(meta.createdAt)}</span>
          </div>
        )}
      </FilterBar>

      {!loadedId ? (
        <div className="flex-1 flex items-center justify-center">
          <div className="erp-panel py-12 px-6 text-center text-muted-foreground text-[13px] max-w-md">
            Enter an ID above and press Enter to load its items.
            <div className="mt-2 text-[12px]">
              <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> save
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Finance summary — dealer balance + the debit/credit impact of
              this edit. Shown for indents only; the balance/Balance-After
              cards appear only for credit indents. */}
          {sourceType === "order" && (
            <div className="px-3 pt-3">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {showBalance && (
                  <StatCard
                    label="Available Balance"
                    value={fmtINR(availableBalance ?? 0)}
                    tone={(availableBalance ?? 0) <= 0 ? "danger" : "success"}
                  />
                )}
                <StatCard label="Original Total" value={fmtINR(originalTotal)} />
                <StatCard
                  label="New Total"
                  value={fmtINR(totals.total)}
                  tone={overBalance ? "danger" : "default"}
                />
                <StatCard
                  label="Difference"
                  value={`${difference > 0 ? "+" : ""}${fmtINR(difference)}`}
                  hint={
                    Math.abs(difference) < 0.01
                      ? "No change"
                      : difference > 0
                      ? (isCredit ? "Debited from balance" : "Extra charge")
                      : (isCredit ? "Credited to balance" : "Refund")
                  }
                  tone={
                    overBalance ? "danger" : Math.abs(difference) < 0.01 ? "default" : "warning"
                  }
                />
                {isCredit && (
                  <StatCard
                    label="Balance After"
                    value={fmtINR(projectedBalance ?? 0)}
                    tone={(projectedBalance ?? 0) < 0 ? "danger" : "default"}
                  />
                )}
              </div>
              {overBalance && (
                <div className="mt-2 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
                  This change exceeds the dealer's available balance by{" "}
                  <span className="font-semibold">
                    {fmtINR(difference - (availableBalance ?? 0))}
                  </span>
                  . Reduce quantities or top up the dealer's balance before saving.
                </div>
              )}
            </div>
          )}

          <div className="flex-1 overflow-auto p-3 pb-24">
            <div className="erp-panel">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>#</th>
                    <th>Product</th>
                    <th className="num" style={{ width: 100 }}>Qty</th>
                    <th className="num" style={{ width: 100 }}>Rate</th>
                    <th className="num" style={{ width: 80  }}>GST %</th>
                    <th className="num" style={{ width: 140 }}>Line Total</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={it.uid}>
                      <td className="num">{i + 1}</td>
                      <td className="font-medium">
                        {it.isNew ? (
                          <div className="flex items-center gap-1.5">
                            <F9SearchSelect
                              className="flex-1"
                              value={it.productId || null}
                              onChange={(v) => pickProduct(it.uid, v)}
                              options={productOptsFor(it.productId)}
                              placeholder="Select product…"
                              modalTitle="Add product"
                            />
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={() => removeRow(it.uid)}
                              title="Remove line"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : canEditItems ? (
                          <div className="flex items-center justify-between gap-2">
                            <span>{it.productName || "—"}</span>
                            <Button
                              variant="ghost" size="icon"
                              className="h-7 w-7 shrink-0 text-muted-foreground hover:text-destructive"
                              onClick={() => removeRow(it.uid)}
                              title="Remove product from indent"
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        ) : (
                          it.productName || "—"
                        )}
                      </td>
                      <td>
                        <Input
                          className="erp-input num text-right"
                          type="number" min="0" step="1"
                          value={it.quantity ?? ""}
                          onChange={e =>
                            setItems(arr => arr.map((row, k) =>
                              k === i ? { ...row, quantity: Math.max(0, parseInt(e.target.value) || 0) } : row
                            ))
                          }
                        />
                      </td>
                      <td className="num">{it.unitPrice.toFixed(2)}</td>
                      <td className="num">{it.gstPercent.toFixed(2)}</td>
                      <td className="num font-semibold">
                        {fmtINR(it.unitPrice * it.quantity * (1 + it.gstPercent / 100))}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/40">
                    <td colSpan={3} className="text-right uppercase text-[12px] font-semibold tracking-wide">Subtotal</td>
                    <td className="num">{fmtINR(totals.sub)}</td>
                    <td className="num">GST: {fmtINR(totals.gst)}</td>
                    <td className="num font-bold text-[14px]">{fmtINR(totals.total)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
            {canEditItems && (
              <div className="mt-2">
                <Button variant="outline" size="sm" className="h-8" onClick={addProductRow}>
                  <Plus className="h-3.5 w-3.5 mr-1" /> Add product
                </Button>
              </div>
            )}
          </div>

          <FormFooter>
            <Button
              variant="outline" size="sm" className="h-8"
              onClick={() => {
                setLoadedId(null); setItems([]); setMeta(null); setIndentId("");
                setOriginalTotal(0); setPaymentMode(null); setCredit(null); setOnlinePayment(null);
              }}
            >
              Reset
            </Button>
            <Button
              size="sm"
              className="h-8"
              disabled={save.isPending || overBalance}
              title={overBalance ? "This change exceeds the dealer's available balance" : undefined}
              onClick={commitSave}
            >
              {save.isPending ? "Saving…" : <>Save Changes <Kbd className="ml-1">Ctrl</Kbd>+<Kbd>S</Kbd></>}
            </Button>
          </FormFooter>

          {/* Downward edit on an online-paid indent: choose where the refund goes. */}
          <Dialog open={refundPrompt} onOpenChange={setRefundPrompt}>
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Refund {fmtINR(Math.abs(difference))}</DialogTitle>
              </DialogHeader>
              <p className="text-[13px] text-muted-foreground">
                This edit reduces the indent by <span className="font-semibold">{fmtINR(Math.abs(difference))}</span>.
                Where should the difference go?
              </p>
              <DialogFooter className="gap-2 sm:justify-start">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={save.isPending}
                  onClick={() => { setRefundPrompt(false); save.mutate("balance"); }}
                >
                  Available balance
                </Button>
                <Button
                  size="sm"
                  disabled={save.isPending}
                  onClick={() => { setRefundPrompt(false); save.mutate("razorpay"); }}
                >
                  Dealer's bank (Razorpay)
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </>
      )}
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// VIP Free Sample tab
// ════════════════════════════════════════════════════════════════════
function VipSampleTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: products = [] } = useQuery({ queryKey: ["products"],     queryFn: fetchProducts });
  const { data: vips     = [] } = useQuery({ queryKey: ["vip-contacts"], queryFn: () => fetchVipContacts() });

  const today = new Date().toISOString().slice(0, 10);
  const [vipId, setVipId]   = useState<string | null>(null);
  const [notes, setNotes]   = useState("");
  const [lines, setLines]   = useState<Line[]>([newLine()]);
  const [addOpen, setAddOpen] = useState(false);
  const [newName, setNewName]   = useState("");
  const [newPhone, setNewPhone] = useState("");
  const [newDesig, setNewDesig] = useState("");

  // Force all lines to ₹0 / 0% — staff can't override prices in this flow
  const forceZero = (ls: Line[]) =>
    ls.map(l => ({ ...l, rate: 0, gstPercent: 0 }));
  useEffect(() => { setLines(prev => forceZero(prev)); /* eslint-disable-next-line */ }, []);

  const vipOpts: F9Option[] = useMemo(
    () => (vips as any[]).map(v => ({
      value: v.id, label: v.name,
      sublabel: [v.designation, v.phone].filter(Boolean).join(" · "),
    })),
    [vips],
  );

  const addVip = useMutation({
    mutationFn: () => createVipContact({
      name: newName.trim(),
      phone: newPhone.trim() || undefined,
      designation: newDesig.trim() || undefined,
    }),
    onSuccess: async (c: any) => {
      toast.success("VIP added");
      await qc.invalidateQueries({ queryKey: ["vip-contacts"] });
      setVipId(c.id);
      setAddOpen(false);
      setNewName(""); setNewPhone(""); setNewDesig("");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to add VIP"),
  });

  const submit = useMutation({
    mutationFn: () => createVipSampleSale({
      saleDate:   today,
      customerId: vipId!,
      notes,
      items: lines
        .filter(l => l.productId && (l.qty ?? 0) > 0)
        .map(l => ({ productId: l.productId, quantity: l.qty ?? 0 })),
    }),
    onSuccess: () => {
      toast.success("VIP sample issued");
      qc.invalidateQueries({ queryKey: ["direct-sales"] });
      navigate("/sales/direct-sales/recent");
      setVipId(null); setLines([newLine()]); setNotes("");
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const canSubmit = !!vipId && lines.some(l => l.productId && (l.qty ?? 0) > 0) && !submit.isPending;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="VIP Free Sample"
        subtitle="Complimentary issue. Grand total = ₹0. F2 add line · Ctrl+S submit."
      />

      <div className="flex-1 overflow-auto p-3 space-y-3 pb-24">
        <FormSection title="Recipient" cols={3}>
          <Field label="VIP Contact" required hint="F9">
            <F9SearchSelect
              value={vipId}
              onChange={setVipId}
              options={vipOpts}
              placeholder="Search by name or phone"
            />
          </Field>
          <Field label="Not in list?">
            <Button size="sm" variant="outline" className="h-8" onClick={() => setAddOpen(true)}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add new VIP
            </Button>
          </Field>
        </FormSection>

        {/* Items — but ItemsCard rate/GST inputs are visual-only here; backend forces 0 */}
        <ItemsCard lines={lines} setLines={setLines} products={products as Product[]} />

        <FormSection title="Notes" cols={1}>
          <Field label="Remarks">
            <Input
              className="erp-input"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="e.g. for AGM hospitality"
            />
          </Field>
        </FormSection>

        <p className="text-[11px] text-muted-foreground px-1">
          ℹ Prices are forced to ₹0 server-side. No payment will be collected or recorded.
        </p>
      </div>

      <FormFooter>
        <Button
          size="sm"
          className="h-8 bg-primary hover:bg-primary-hover"
          disabled={!canSubmit}
          onClick={() => submit.mutate()}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {submit.isPending ? "Saving…" : (
            <span className="inline-flex items-center gap-1.5">
              Issue Free Sample <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd>
            </span>
          )}
        </Button>
      </FormFooter>

      {/* Inline Add-VIP dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader><DialogTitle>Add VIP Contact</DialogTitle></DialogHeader>
          <div className="grid grid-cols-1 gap-3 p-1">
            <Field label="Name" required>
              <Input className="erp-input" value={newName} onChange={e => setNewName(e.target.value)} autoFocus />
            </Field>
            <Field label="Phone">
              <Input className="erp-input" value={newPhone} onChange={e => setNewPhone(e.target.value)} maxLength={10} />
            </Field>
            <Field label="Designation">
              <Input className="erp-input" value={newDesig} onChange={e => setNewDesig(e.target.value)} placeholder="e.g. MLA, Minister" />
            </Field>
          </div>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setAddOpen(false)}>Cancel</Button>
            <Button
              size="sm"
              disabled={!newName.trim() || addVip.isPending}
              onClick={() => addVip.mutate()}
            >
              {addVip.isPending ? "Adding…" : "Add"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// Employee Subsidy tab — locked to eligible products + fixed subsidy %
// ════════════════════════════════════════════════════════════════════
function EmployeeSubsidyTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: employees = [] } = useQuery({
    queryKey: ["employees"],
    queryFn: () => fetchEmployees({ activeOnly: true }),
  });
  const { data: rules = [], isLoading: rulesLoading } = useQuery({
    queryKey: ["emp-subsidy-rules"],
    queryFn: fetchEmployeeSubsidyRules,
  });
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });

  const today = new Date().toISOString().slice(0, 10);
  const [empId, setEmpId]             = useState<string | null>(null);
  const [routeId, setRouteId]         = useState<string | null>(null);

  // Selected employee's live credit position (limit / available / outstanding)
  const { data: credit } = useQuery({
    queryKey: ["employee-credit", empId],
    queryFn: () => fetchEmployeeCredit(empId!),
    enabled: !!empId,
  });

  const [productId, setProductId]     = useState<string | null>(null);
  const [qty, setQty] = useState<number | undefined>(undefined);
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi" | "credit">("cash");
  const [paymentRef, setPaymentRef]   = useState("");
  const [notes, setNotes]             = useState("");

  const empOpts: F9Option[] = useMemo(
    () => (employees as any[]).map(e => ({
      value: e.id,
      label: e.name,
      sublabel: [e.employee_code, e.department].filter(Boolean).join(" · "),
    })),
    [employees],
  );

  const routeOpts: F9Option[] = useMemo(
    () => (routes as any[]).map(r => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes],
  );

  const productOpts: F9Option[] = useMemo(
    () => rules.map(r => ({
      value: r.productId,
      label: `${r.productName}${r.unit ? ` (${r.unit})` : ""}`,
      sublabel: `Employee price ₹${r.subsidyPrice.toFixed(2)} (incl. GST) · MRP ₹${r.basePrice.toFixed(2)}`,
    })),
    [rules],
  );

  // Auto-select if only one eligible product (today: just HTM-1000ml)
  useEffect(() => {
    if (!productId && rules.length === 1) setProductId(rules[0].productId);
  }, [rules, productId]);

  const rule = rules.find(r => r.productId === productId);

  const pricing = useMemo(() => {
    if (!rule || !qty) return null;
    const mrp        = rule.basePrice;
    const empPrice   = rule.subsidyPrice;                          // GST-inclusive unit price
    const unitPrice  = +(empPrice / (1 + rule.gstPercent / 100)).toFixed(2);  // taxable
    const total      = +(empPrice * qty).toFixed(2);
    const lineSub    = +(unitPrice * qty).toFixed(2);
    const gstAmount  = +(total - lineSub).toFixed(2);
    const youSave    = +(mrp * qty - lineSub).toFixed(2);
    return { mrp, empPrice, unitPrice, lineSub, gstAmount, total, youSave };
  }, [rule, qty]);

  const submit = useMutation({
    mutationFn: () => createEmployeeSubsidySale({
      saleDate: today,
      customerId: empId!,
      routeId: routeId!,
      paymentMode,
      paymentRef: paymentRef.trim() || undefined,
      notes,
      items: [{ productId: productId!, quantity: qty ?? 0 }],
    }),
    onSuccess: (res) => {
      // It's an indent now, not a counter sale — say so, and name the invoice
      // it raised so the operator can hand it over.
      toast.success(
        res.invoiceNumber
          ? `Employee subsidy indent placed · invoice ${res.invoiceNumber}`
          : "Employee subsidy indent placed",
      );
      qc.invalidateQueries({ queryKey: ["direct-sales"] });
      qc.invalidateQueries({ queryKey: ["employee-credit"] });
      qc.invalidateQueries({ queryKey: ["indents"] });
      navigate("/sales/all-indents");
      setEmpId(null); setRouteId(null); setProductId(null); setQty(1);
      setPaymentMode("cash"); setPaymentRef(""); setNotes("");
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  const canSubmit =
    !!empId && !!routeId && !!productId && (qty ?? 0) > 0 && !submit.isPending &&
    (paymentMode !== "upi" || paymentRef.trim().length > 0);

  // Keyboard: Ctrl+S to submit
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (canSubmit) submit.mutate();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [canSubmit, submit]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Employee Subsidy Sale"
        subtitle="Subsidy auto-applied from the rule book. Ctrl+S submit."
      />

      <div className="flex-1 overflow-auto p-3 space-y-3 pb-24">
        {/* Combined: Employee + Payment */}
        <FormSection title="Employee" cols={3}>
          <Field label="Employee" required hint="F9">
            <F9SearchSelect
              value={empId}
              onChange={setEmpId}
              options={empOpts}
              placeholder="Search by name or code"
            />
          </Field>
          {/* Required: this is a real indent, and the dispatch sheet is keyed
              by route. Deliberately has no default — employees carry no
              standing route, so the operator states where it loads. */}
          <Field label="Route" required hint="F9">
            <F9SearchSelect
              value={routeId}
              onChange={setRouteId}
              options={routeOpts}
              placeholder="Select delivery route"
            />
          </Field>
          <Field label="Payment Mode" required>
            <Select value={paymentMode} onValueChange={v => setPaymentMode(v as any)}>
              <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="upi">UPI</SelectItem>
                <SelectItem value="credit">Credit</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          {empId && (
            <Field label="Available Credit">
              <div className="flex items-baseline gap-2 h-8 px-2 rounded-sm border bg-muted/30">
                {credit ? (
                  <>
                    <span className={`num text-[14px] font-semibold ${credit.availableCredit <= 0 ? "text-destructive" : ""}`}>
                      {fmtINR(credit.availableCredit)}
                    </span>
                    <span className="text-[10.5px] text-muted-foreground whitespace-nowrap">
                      of {fmtINR(credit.creditLimit)} limit
                    </span>
                  </>
                ) : (
                  <span className="text-muted-foreground text-[12px] self-center">Loading…</span>
                )}
              </div>
            </Field>
          )}
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
        </FormSection>

        {/* Product + qty + live pricing */}
        <FormSection title="Product (eligible only)" cols={3}>
          {rulesLoading ? (
            <Field label="Product" required>
              <div className="text-[12px] text-muted-foreground">Loading eligible products…</div>
            </Field>
          ) : rules.length === 0 ? (
            <div className="col-span-3 p-3 rounded-sm border border-dashed bg-amber-50 dark:bg-amber-950/30 text-[12.5px]">
              <strong>No eligible products configured.</strong>{" "}
              An admin must add a row to <code>employee_subsidy_rules</code> (e.g. HTM-1000ml at 50%).
              Until then this flow can't be used.
            </div>
          ) : (
            <>
              <Field label="Product" required hint="F9">
                <F9SearchSelect
                  value={productId}
                  onChange={setProductId}
                  options={productOpts}
                  placeholder="Select eligible product"
                />
              </Field>
              <Field label="Quantity" required>
              <Input
                className="erp-input num"
                type="number" min={1}
                value={qty ?? ""}
                onChange={e => setQty(e.target.value === "" ? 
                  undefined : Math.max(1, parseInt(e.target.value, 10)))}
              />
              </Field>
            </>
          )}
        </FormSection>

        {pricing && rule && (
          <div className="erp-panel p-3">
            <div className="grid grid-cols-2 md:grid-cols-5 gap-3 text-[12.5px]">
              <Cell label="MRP / unit"                         value={fmtINR(pricing.mrp)} />
              <Cell label="Employee price / unit (incl. GST)"  value={fmtINR(pricing.empPrice)} strong />
              <Cell label="Taxable subtotal"                   value={fmtINR(pricing.lineSub)} />
              <Cell label={`GST (${rule.gstPercent}%)`}        value={fmtINR(pricing.gstAmount)} />
              <Cell label="Total payable"                      value={fmtINR(pricing.total)} strong />
            </div>
            <div className="mt-2 text-[11px] text-muted-foreground">
              Employee saves <span className="num font-medium">{fmtINR(pricing.youSave)}</span> vs MRP on this purchase.
            </div>
          </div>
        )}

        <FormSection title="Notes" cols={1}>
          <Field label="Remarks">
            <Input
              className="erp-input"
              value={notes}
              onChange={e => setNotes(e.target.value)}
              placeholder="Optional"
            />
          </Field>
        </FormSection>
      </div>

      <FormFooter>
        <Button
          size="sm"
          className="h-8 bg-primary hover:bg-primary-hover"
          disabled={!canSubmit}
          onClick={() => submit.mutate()}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          {submit.isPending ? "Saving…" : (
            <span className="inline-flex items-center gap-1.5">
              Record Subsidy Sale <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd>
            </span>
          )}
        </Button>
      </FormFooter>
    </div>
  );
}

// Small helper used only in this tab
function Cell({ label, value, strong = false }: { label: string; value: string; strong?: boolean }) {
  return (
    <div>
      <div className="text-[10.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`num ${strong ? "font-bold text-[14px]" : "text-[13px]"}`}>{value}</div>
    </div>
  );
}