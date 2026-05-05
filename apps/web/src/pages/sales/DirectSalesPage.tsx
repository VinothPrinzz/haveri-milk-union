// ════════════════════════════════════════════════════════════════════
// Direct Sales: Gate-Pass / Cash Customer / Modify — ERP refactor
// Routes: /sales/direct-sales/gate-pass | /cash-customer | /modify
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useNavigate, useSearchParams } from "react-router-dom";
import PageHeader, {
  FilterBar, FormSection, FormFooter, Field, EmptyState, fmtINR, fmtDate, StatusPill, Kbd,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Plus, Save, Trash2, Search } from "lucide-react";
import {
  fetchProducts, fetchCustomers, fetchRoutes, getRateCategories, fetchCashCustomers,
  createGatePassSale, createCashSale, fetchRecentDirectSales,
  type Product,
} from "@/services/api";
import { get, patch } from "@/lib/apiClient";

const fetchRateCategories = () => getRateCategories().map((name, i) => ({ id: String(i), name }));

interface Props { tab?: "gate-pass" | "cash-customer" | "modify"; }
type Line = { productId: string; qty: number; rate: number; gstPercent?: number };

export default function DirectSalesPage({ tab = "gate-pass" }: Props) {
  if (tab === "cash-customer") return <CashCustomerTab />;
  if (tab === "modify") return <ModifyTab />;
  return <GatePassTab />;
}

// ───────────────────────────────────────────────────────────── Gate Pass
function GatePassTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  // ── Added queries ────────────────────────────────────────────────
  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });

  // ── Added option memos ───────────────────────────────────────────
  const customerOpts: F9Option[] = useMemo(
    () => customers.map((c: any) => ({ value: c.id, label: c.name, sublabel: c.code })),
    [customers]
  );
  const routeOpts: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );

  const today = new Date().toISOString().slice(0, 10);
  const [date, setDate] = useState(today);
  const [customer, setCustomer] = useState<any>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [paymentMode, setPaymentMode] = useState<"cash" | "credit">("cash");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  const lineTotal = (l: Line) => (l.qty || 0) * (l.rate || 0);
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const gstTotal = lines.reduce((s, l) => s + lineTotal(l) * ((l.gstPercent || 0) / 100), 0);
  const grandTotal = subtotal + gstTotal;

  const addLine = () => setLines(prev => [...prev, { productId: "", qty: 0, rate: 0 }]);

  const updateLine = (idx: number, patch: Partial<Line>) => {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  };

  const removeLine = (idx: number) => {
    setLines(prev => prev.filter((_, i) => i !== idx));
  };

  const submit = useMutation({
    mutationFn: () => createGatePassSale({
      saleDate: date,
      customerId: customer?.id,
      routeId: routeId ?? undefined,
      paymentMode,
      notes,
      items: lines.filter(l => l.productId && l.qty > 0).map(l => ({ ...l, quantity: l.qty })),
    }),
    onSuccess: () => {
      toast.success("Gate Pass issued");
      qc.invalidateQueries({ queryKey: ["direct-sales"] });
      qc.invalidateQueries({ queryKey: ["indents"] });
      navigate("/sales/direct-sales/recent");
      setLines([]); setCustomer(null); setNotes("");
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F2") {
        e.preventDefault();
        addLine();
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!submit.isPending && customer && lines.length > 0) submit.mutate();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [submit, customer, lines]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Gate Pass"
        subtitle="Issue a gate-pass for an over-the-counter dealer pickup. F2 add line · Ctrl+S submit."
      />
      <div className="flex-1 overflow-auto p-3 space-y-4">
        <FormSection title="Sale Header" cols={4}>
          <Field label="Date" required>
            <Input type="date" className="erp-input" value={date} onChange={e => setDate(e.target.value)} />
          </Field>
          <Field label="Customer" required hint="F9">
            <F9SearchSelect
              value={customer?.id ?? null}
              onChange={(id) => setCustomer(customers.find((c: any) => c.id === id) ?? { id })}
              options={customerOpts}
            />
          </Field>
          <Field label="Route">
            <F9SearchSelect
              value={routeId}
              onChange={setRouteId}
              options={routeOpts}
              allowAll
            />
          </Field>
          <Field label="Payment Mode">
            <Select value={paymentMode} onValueChange={(v: any) => setPaymentMode(v)}>
              <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="credit">Credit</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </FormSection>

        <div className="erp-panel p-3">
          <div className="flex justify-between mb-3">
            <h3 className="erp-section-title m-0">Items</h3>
            <Button size="sm" onClick={addLine}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Line (F2)
            </Button>
          </div>

          <table className="erp-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Product</th>
                <th className="num" style={{ width: 100, textAlign: "right" }}>Qty</th>
                <th className="num" style={{ width: 110, textAlign: "right" }}>Rate</th>
                <th className="num" style={{ width: 110, textAlign: "right" }}>Subtotal</th>
                <th className="num" style={{ width: 80, textAlign: "right" }}>GST %</th>
                <th className="num" style={{ width: 130, textAlign: "right" }}>Line Total</th>
                <th style={{ width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="text-center text-muted-foreground">{i + 1}</td>
                  <td>
                    <Select value={l.productId} onValueChange={v => updateLine(i, { productId: v })}>
                      <SelectTrigger className="erp-input"><SelectValue placeholder="Select product" /></SelectTrigger>
                      <SelectContent>
                        {products.map((p: Product) => (
                          <SelectItem key={p.id} value={p.id}>{p.code} — {p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td>
                    <Input type="number" step="0.01" className="erp-input text-right" value={l.qty} 
                      onChange={e => updateLine(i, { qty: parseFloat(e.target.value) || 0 })} />
                  </td>
                  <td>
                    <Input type="number" step="0.01" className="erp-input text-right" value={l.rate} 
                      onChange={e => updateLine(i, { rate: parseFloat(e.target.value) || 0 })} />
                  </td>
                  <td className="num text-right">{fmtINR(lineTotal(l))}</td>
                  <td>
                    <Input type="number" step="0.01" className="erp-input text-right" value={l.gstPercent || 0} 
                      onChange={e => updateLine(i, { gstPercent: parseFloat(e.target.value) || 0 })} />
                  </td>
                  <td className="num font-medium text-right">
                    {fmtINR(lineTotal(l) * (1 + (l.gstPercent || 0) / 100))}
                  </td>
                  <td>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeLine(i)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 font-semibold">
                <td colSpan={4} className="text-right">Grand Total</td>
                <td className="num text-right">{fmtINR(subtotal)}</td>
                <td></td>
                <td className="num text-right text-lg">{fmtINR(grandTotal)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <FormFooter>
        <Button 
          size="sm" 
          className="h-8 bg-primary hover:bg-primary-hover" 
          disabled={submit.isPending || !customer || lines.length === 0}
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

// ───────────────────────────────────────────────────────────── Cash Customer
function CashCustomerTab() {
  const qc = useQueryClient();
  const navigate = useNavigate();

  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });

  const today = new Date().toISOString().slice(0, 10);
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [paymentMode, setPaymentMode] = useState<"cash" | "upi">("cash");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<Line[]>([]);

  const lineTotal = (l: Line) => (l.qty || 0) * (l.rate || 0);
  const subtotal = lines.reduce((s, l) => s + lineTotal(l), 0);
  const gstTotal = lines.reduce((s, l) => s + lineTotal(l) * ((l.gstPercent || 0) / 100), 0);
  const grandTotal = subtotal + gstTotal;

  const addLine = () => setLines(prev => [...prev, { productId: "", qty: 0, rate: 0 }]);

  const updateLine = (idx: number, patch: Partial<Line>) => {
    setLines(prev => prev.map((l, i) => i === idx ? { ...l, ...patch } : l));
  };

  const removeLine = (idx: number) => {
    setLines(prev => prev.filter((_, i) => i !== idx));
  };

  const submit = useMutation({
    mutationFn: () => (createCashSale as any)({
      saleDate: today,
      customerName: name,
      customerPhone: phone,
      paymentMode,
      notes,
      items: lines.filter(l => l.productId && l.qty > 0).map(l => ({ productId: l.productId, quantity: l.qty })),
    }),
    onSuccess: () => {
      toast.success("Cash Sale recorded");
      qc.invalidateQueries({ queryKey: ["direct-sales"] });
      navigate("/sales/direct-sales/recent");
      setName(""); setPhone(""); setLines([]); setNotes("");
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); addLine(); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!submit.isPending && name && lines.length > 0) submit.mutate();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
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
        </FormSection>

        <div className="erp-panel p-3">
          <div className="flex justify-between mb-3">
            <h3 className="erp-section-title m-0">Items</h3>
            <Button size="sm" onClick={addLine}>
              <Plus className="h-3.5 w-3.5 mr-1" /> Add Line (F2)
            </Button>
          </div>

          <table className="erp-table">
            <thead>
              <tr>
                <th style={{ width: 40 }}>#</th>
                <th>Product</th>
                <th className="num" style={{ width: 100, textAlign: "right" }}>Qty</th>
                <th className="num" style={{ width: 110, textAlign: "right" }}>Rate</th>
                <th className="num" style={{ width: 110, textAlign: "right" }}>Subtotal</th>
                <th className="num" style={{ width: 80, textAlign: "right" }}>GST %</th>
                <th className="num" style={{ width: 130, textAlign: "right" }}>Line Total</th>
                <th style={{ width: 50 }}></th>
              </tr>
            </thead>
            <tbody>
              {lines.map((l, i) => (
                <tr key={i}>
                  <td className="text-center text-muted-foreground">{i + 1}</td>
                  <td>
                    <Select value={l.productId} onValueChange={v => updateLine(i, { productId: v })}>
                      <SelectTrigger className="erp-input"><SelectValue placeholder="Select product" /></SelectTrigger>
                      <SelectContent>
                        {products.map((p: Product) => (
                          <SelectItem key={p.id} value={p.id}>{p.code} — {p.name}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </td>
                  <td>
                    <Input type="number" step="0.01" className="erp-input text-right" value={l.qty} 
                      onChange={e => updateLine(i, { qty: parseFloat(e.target.value) || 0 })} />
                  </td>
                  <td>
                    <Input type="number" step="0.01" className="erp-input text-right" value={l.rate} 
                      onChange={e => updateLine(i, { rate: parseFloat(e.target.value) || 0 })} />
                  </td>
                  <td className="num text-right">{fmtINR(lineTotal(l))}</td>
                  <td>
                    <Input type="number" step="0.01" className="erp-input text-right" value={l.gstPercent || 0} 
                      onChange={e => updateLine(i, { gstPercent: parseFloat(e.target.value) || 0 })} />
                  </td>
                  <td className="num font-medium text-right">
                    {fmtINR(lineTotal(l) * (1 + (l.gstPercent || 0) / 100))}
                  </td>
                  <td>
                    <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" onClick={() => removeLine(i)}>
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 font-semibold">
                <td colSpan={4} className="text-right">Grand Total</td>
                <td className="num text-right">{fmtINR(subtotal)}</td>
                <td></td>
                <td className="num text-right text-lg">{fmtINR(grandTotal)}</td>
                <td></td>
              </tr>
            </tfoot>
          </table>
        </div>
      </div>

      <FormFooter>
        <Button 
          size="sm" 
          className="h-8 bg-primary hover:bg-primary-hover" 
          disabled={submit.isPending || !name || lines.length === 0}
          onClick={() => submit.mutate()}
        >
          <Save className="h-3.5 w-3.5 mr-1" />
          Record Cash Sale <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd>
        </Button>
      </FormFooter>
    </div>
  );
}

// ───────────────────────────────────────────────────────────── Indent Modify
function ModifyTab() {
  const qc = useQueryClient();
  const [params] = useSearchParams();
  const initialId = params.get("indentId") ?? "";
  const [indentId, setIndentId] = useState(initialId);
  const [loadedId, setLoadedId] = useState<string | null>(null);
  const [items, setItems] = useState<Array<{
    productId: string; productName: string; quantity: number;
    unitPrice: number; gstPercent: number; lineTotal: number;
  }>>([]);
  const [meta, setMeta] = useState<{ dealerName?: string; status?: string; createdAt?: string } | null>(null);

  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });
  const productOpts: F9Option[] = useMemo(
    () => products.map((p: any) => ({ value: p.id, label: p.name, sublabel: p.code })),
    [products]
  );

  const fetchIndent = useMutation({
    mutationFn: async (id: string) => get<{ order: any; items: any[] }>(`/orders/${id}`),
    onSuccess: (resp) => {
      setLoadedId(resp.order.id);
      setMeta({
        dealerName: resp.order.dealer_name,
        status: resp.order.status,
        createdAt: resp.order.created_at,
      });
      setItems(resp.items.map((it: any) => ({
        productId: it.product_id,
        productName: it.product_name,
        quantity: Number(it.quantity),
        unitPrice: parseFloat(String(it.unit_price)) || 0,
        gstPercent: parseFloat(String(it.gst_percent)) || 0,
        lineTotal: parseFloat(String(it.line_total)) || 0,
      })));
    },
    onError: (e: any) => toast.error(e?.message || "Indent not found"),
  });

  useEffect(() => {
    if (initialId && !loadedId) fetchIndent.mutate(initialId);
  }, []);

  const save = useMutation({
    mutationFn: async () => {
      if (!loadedId) throw new Error("Load an indent first");
      const payload = items
        .filter(i => i.productId && i.quantity >= 0)
        .map(i => ({ productId: i.productId, quantity: i.quantity }));
      return patch(`/orders/${loadedId}/items`, { items: payload });
    },
    onSuccess: () => {
      toast.success("Indent updated");
      qc.invalidateQueries({ queryKey: ["indents"] });
      qc.invalidateQueries({ queryKey: ["recent-direct-sales"] });
    },
    onError: (e: any) => toast.error(e?.message || "Save failed"),
  });

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "s" || e.key === "S") && loadedId) {
        e.preventDefault();
        if (!save.isPending) save.mutate();
      } else if (e.key === "F2" && loadedId) {
        e.preventDefault();
        setItems(is => [...is, { productId: "", productName: "", quantity: 1, unitPrice: 0, gstPercent: 0, lineTotal: 0 }]);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [save, loadedId]);

  const totals = useMemo(() => {
    const sub = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0);
    const gst = items.reduce((s, i) => s + i.unitPrice * i.quantity * (i.gstPercent / 100), 0);
    return { sub, gst, total: sub + gst };
  }, [items]);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Indent Modify"
        subtitle="Modify any indent (regular, gate-pass, cash). Enter an Indent ID and press Enter."
      />

      <FilterBar>
        <Field label="Indent ID">
          <Input
            className="erp-input w-96 font-mono"
            value={indentId}
            onChange={e => setIndentId(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter" && indentId.trim()) fetchIndent.mutate(indentId.trim()); }}
            placeholder="paste full UUID or last-4"
            autoFocus
          />
        </Field>
        <div className="flex items-end">
          <Button size="sm" className="h-8" disabled={!indentId.trim() || fetchIndent.isPending} onClick={() => fetchIndent.mutate(indentId.trim())}>
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
            Enter an Indent ID above and press Enter to load its items.
            <div className="mt-2 text-[12px]">
              <Kbd>F2</Kbd> add line · <Kbd>Ctrl</Kbd>+<Kbd>S</Kbd> save
            </div>
          </div>
        </div>
      ) : (
        <>
          <div className="flex-1 overflow-auto p-3 pb-24">
            <div className="erp-panel">
              <table className="erp-table">
                <thead>
                  <tr>
                    <th style={{ width: 40 }}>#</th>
                    <th style={{ width: "35%" }}>Product</th>
                    <th className="num" style={{ width: 90 }}>Qty</th>
                    <th className="num" style={{ width: 100 }}>Rate</th>
                    <th className="num" style={{ width: 70 }}>GST %</th>
                    <th className="num" style={{ width: 130 }}>Line Total</th>
                    <th style={{ width: 40 }}></th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((it, i) => (
                    <tr key={i}>
                      <td className="num">{i + 1}</td>
                      <td>
                        <F9SearchSelect
                          value={it.productId || null}
                          onChange={v => {
                            const p = products.find((x: any) => x.id === v);
                            setItems(arr => arr.map((row, k) => k === i ? {
                              ...row,
                              productId: v ?? "",
                              productName: p?.name ?? "",
                              unitPrice: parseFloat(String(p?.mrp ?? row.unitPrice)) || 0,
                              gstPercent: parseFloat(String(p?.gstPercent ?? row.gstPercent)) || 0,
                            } : row));
                          }}
                          options={productOpts}
                          className="w-full"
                        />
                      </td>
                      <td>
                        <Input
                          className="erp-input num text-right"
                          type="number" min="0"
                          value={it.quantity}
                          onChange={e => setItems(arr => arr.map((row, k) => k === i ? { ...row, quantity: Math.max(0, parseInt(e.target.value) || 0) } : row))}
                        />
                      </td>
                      <td className="num">{it.unitPrice.toFixed(2)}</td>
                      <td className="num">{it.gstPercent.toFixed(2)}</td>
                      <td className="num font-semibold">{fmtINR(it.unitPrice * it.quantity * (1 + it.gstPercent / 100))}</td>
                      <td>
                        <Button
                          variant="ghost" size="icon" className="h-7 w-7 text-destructive"
                          onClick={() => setItems(arr => arr.filter((_, k) => k !== i))}
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
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
                    <td></td>
                  </tr>
                </tfoot>
              </table>
            </div>
          </div>

          <FormFooter>
            <Button variant="outline" size="sm" className="h-8" onClick={() => { setLoadedId(null); setItems([]); setMeta(null); setIndentId(""); }}>Reset</Button>
            <Button size="sm" className="h-8" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : <>Save Changes <Kbd className="ml-1">Ctrl</Kbd>+<Kbd>S</Kbd></>}
            </Button>
          </FormFooter>
        </>
      )}
    </div>
  );
}