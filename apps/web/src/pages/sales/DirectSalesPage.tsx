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
  FilterBar, FormSection, FormFooter, Field, fmtINR, fmtDate, StatusPill, Kbd,
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
  type Product,
} from "@/services/api";
import { get, patch } from "@/lib/apiClient";

interface Props { tab?: "gate-pass" | "cash-customer" | "modify"; }

// Shared line shape — productName cached so totals stay correct after
// the row's Product changes mid-edit (same approach as RecordIndents).
type Line = {
  id: string;
  productId: string;
  qty: number;
  rate: number;
  gstPercent: number;
};

const rid = () => Math.random().toString(36).slice(2, 9);
const newLine = (): Line => ({ id: rid(), productId: "", qty: 1, rate: 0, gstPercent: 0 });

export default function DirectSalesPage({ tab = "gate-pass" }: Props) {
  if (tab === "cash-customer") return <CashCustomerTab />;
  if (tab === "modify")        return <ModifyTab />;
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
        rate:        p ? (parseFloat(String(p.mrp ?? 0))         || l.rate)        : l.rate,
        gstPercent:  p ? (parseFloat(String(p.gstPercent ?? 0))  || l.gstPercent)  : l.gstPercent,
      };
    }));

  const setQty = (id: string, qty: number) =>
    setLines(prev => prev.map(l => l.id === id ? { ...l, qty: Math.max(0, qty || 0) } : l));
  const setRate = (id: string, rate: number) =>
    setLines(prev => prev.map(l => l.id === id ? { ...l, rate: Math.max(0, rate || 0) } : l));
  const setGstPct = (id: string, pct: number) =>
    setLines(prev => prev.map(l => l.id === id ? { ...l, gstPercent: Math.max(0, pct || 0) } : l));

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
                      value={l.qty}
                      onChange={e => setQty(l.id, parseFloat(e.target.value))}
                    />
                  </td>
                  <td>
                    <Input
                      className="erp-input num text-right"
                      type="number" min="0" step="0.01"
                      value={l.rate}
                      onChange={e => setRate(l.id, parseFloat(e.target.value))}
                    />
                  </td>
                  <td className="num">{c.sub ? fmtINR(c.sub) : "—"}</td>
                  <td>
                    <Input
                      className="erp-input num text-right"
                      type="number" min="0" max="100" step="0.01"
                      value={l.gstPercent}
                      onChange={e => setGstPct(l.id, parseFloat(e.target.value))}
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
  const [paymentMode, setPaymentMode] = useState<"cash" | "credit">("cash");
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
      notes,
      items: lines
        .filter(l => l.productId && l.qty > 0)
        .map(l => ({
          productId:  l.productId,
          quantity:   l.qty,
          unitPrice:  l.rate,
          gstPercent: l.gstPercent,
        })),
    } as any),
    onSuccess: () => {
      toast.success("Gate Pass issued");
      qc.invalidateQueries({ queryKey: ["direct-sales"] });
      qc.invalidateQueries({ queryKey: ["indents"] });
      navigate("/sales/direct-sales/recent");
      setLines([newLine()]); setCustomerId(null); setNotes("");
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
        if (!submit.isPending && customer && lines.some(l => l.productId && l.qty > 0)) {
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
            <Select value={paymentMode} onValueChange={(v: any) => setPaymentMode(v)}>
              <SelectTrigger className="erp-input"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">Cash</SelectItem>
                <SelectItem value="credit">Credit</SelectItem>
              </SelectContent>
            </Select>
          </Field>
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
          disabled={submit.isPending || !customer || !lines.some(l => l.productId && l.qty > 0)}
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
  const [notes, setNotes]             = useState("");
  const [lines, setLines]             = useState<Line[]>([newLine()]);

  const submit = useMutation({
    mutationFn: () => (createCashSale as any)({
      saleDate: today,
      customerName: name,
      customerPhone: phone,
      paymentMode,
      notes,
      items: lines
        .filter(l => l.productId && l.qty > 0)
        .map(l => ({
          productId:  l.productId,
          quantity:   l.qty,
          unitPrice:  l.rate,
          gstPercent: l.gstPercent,
        })),
    }),
    onSuccess: () => {
      toast.success("Cash Sale recorded");
      qc.invalidateQueries({ queryKey: ["direct-sales"] });
      navigate("/sales/direct-sales/recent");
      setName(""); setPhone(""); setLines([newLine()]); setNotes("");
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if (e.key === "F2") { e.preventDefault(); setLines(prev => [...prev, newLine()]); }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (!submit.isPending && name && lines.some(l => l.productId && l.qty > 0)) {
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
          disabled={submit.isPending || !name || !lines.some(l => l.productId && l.qty > 0)}
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
    [products],
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
        productId:  it.product_id,
        productName: it.product_name,
        quantity:   Number(it.quantity),
        unitPrice:  parseFloat(String(it.unit_price))  || 0,
        gstPercent: parseFloat(String(it.gst_percent)) || 0,
        lineTotal:  parseFloat(String(it.line_total))  || 0,
      })));
    },
    onError: (e: any) => toast.error(e?.message || "Indent not found"),
  });

  useEffect(() => {
    if (initialId && !loadedId) fetchIndent.mutate(initialId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
                    <th className="num" style={{ width: 90  }}>Qty</th>
                    <th className="num" style={{ width: 100 }}>Rate</th>
                    <th className="num" style={{ width: 70  }}>GST %</th>
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
                              unitPrice:  parseFloat(String(p?.mrp ?? row.unitPrice))         || 0,
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