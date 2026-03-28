"use client";
import { useState, useMemo } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, cn } from "@/lib/utils";
import { PageHeader, Card, Button } from "@/components/ui";
import { Search, Minus, Plus, ShoppingCart } from "lucide-react";

export default function NewIndentPage() {
  const [selectedDealerId, setSelectedDealerId] = useState<string | null>(null);
  const [dealerSearch, setDealerSearch] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [paymentMode, setPaymentMode] = useState("wallet");
  const [resultMsg, setResultMsg] = useState("");
  const qc = useQueryClient();

  const { data: dealersData } = useQuery({ queryKey: ["dealers-indent", dealerSearch], queryFn: () => api.get("/api/v1/dealers", { page: 1, limit: 20, search: dealerSearch || undefined }) });
  const { data: productsData } = useQuery({ queryKey: ["products-active"], queryFn: () => api.get("/api/v1/products") });

  const dealers = dealersData?.data ?? [];
  const allProducts = productsData?.products ?? [];
  const products = productSearch ? allProducts.filter((p: any) => p.name.toLowerCase().includes(productSearch.toLowerCase())) : allProducts;
  const selectedDealer = dealers.find((d: any) => d.id === selectedDealerId);

  const setQty = (pid: string, val: number) => setQuantities(prev => ({ ...prev, [pid]: Math.max(0, val) }));

  const cartItems = useMemo(() => allProducts.filter((p: any) => (quantities[p.id] ?? 0) > 0).map((p: any) => {
    const qty = quantities[p.id]!; const price = parseFloat(p.basePrice); const gstPct = parseFloat(p.gstPercent);
    const lineSub = price * qty; const lineGst = lineSub * (gstPct / 100);
    return { ...p, qty, lineSub, lineGst, lineTotal: lineSub + lineGst };
  }), [quantities, allProducts]);

  const cart = useMemo(() => {
    const itemCount = cartItems.reduce((a, c) => a + c.qty, 0);
    const subtotal = cartItems.reduce((a, c) => a + c.lineSub, 0);
    const totalGst = cartItems.reduce((a, c) => a + c.lineGst, 0);
    return { itemCount, subtotal, totalGst, grandTotal: subtotal + totalGst };
  }, [cartItems]);

  const placeMut = useMutation({
    mutationFn: () => {
      const items = Object.entries(quantities).filter(([_, qty]) => qty > 0).map(([productId, quantity]) => ({ productId, quantity }));
      return api.post("/api/v1/orders/admin-place", { dealerId: selectedDealerId, items, paymentMode });
    },
    onSuccess: (res) => { setResultMsg(`✅ ${res.message} — Total: ${formatCurrency(res.order.grandTotal)}`); setQuantities({}); qc.invalidateQueries({ queryKey: ["orders"] }); },
    onError: (err: any) => setResultMsg(`❌ ${err?.data?.message || err?.data?.error || "Failed to place indent"}`),
  });

  return (
    <>
      <PageHeader icon="📞" title="New Indent (Call Desk)" subtitle="Create an indent on behalf of a dealer via phone call" />
      {resultMsg && <div className={cn("mb-4 px-4 py-3 rounded-lg text-[12px] font-semibold border", resultMsg.startsWith("✅") ? "bg-success/10 border-success/20 text-success" : "bg-danger/10 border-danger/20 text-danger")}>{resultMsg}</div>}
      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5">
        <Card title="Select Dealer"><div className="p-4">
          <div className="flex items-center gap-2 bg-background border border-border rounded-lg px-3 py-2 mb-3"><Search className="h-3.5 w-3.5 text-muted-fg" /><input type="text" value={dealerSearch} onChange={e => setDealerSearch(e.target.value)} placeholder="Search by name or phone..." className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div>
          <div className="space-y-2">{dealers.map((d: any) => {
            const sel = d.id === selectedDealerId; const bal = parseFloat(d.wallet_balance || "0");
            return (<div key={d.id} onClick={() => setSelectedDealerId(d.id)} className={cn("p-3 rounded-lg cursor-pointer transition-all", sel ? "border-[1.5px] border-brand bg-brand-light" : "border border-border bg-card hover:border-brand/30")}>
              <div className={cn("text-[11px] font-bold", sel ? "text-brand" : "text-fg")}>{d.name}</div>
              <div className="text-[9px] text-muted-fg font-medium mt-0.5">{d.phone} · {d.zone_name}</div>
              <div className={cn("text-[10px] font-bold mt-1", bal >= 5000 ? "text-success" : bal > 0 ? "text-warning" : "text-danger")}>Wallet: {formatCurrency(bal)}</div>
            </div>);
          })}</div>
        </div></Card>
        <div className="space-y-5">
          <Card title="Add Products"><div className="p-4">
            <div className="flex items-center gap-2 bg-background border border-border rounded-lg px-3 py-2 mb-3"><Search className="h-3.5 w-3.5 text-muted-fg" /><input type="text" value={productSearch} onChange={e => setProductSearch(e.target.value)} placeholder="Search products..." className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium" /></div>
            <div className="space-y-2.5">{products.map((p: any) => {
              const qty = quantities[p.id] ?? 0;
              return (<div key={p.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-border"><span className="text-lg shrink-0">{p.icon || "📦"}</span><div className="flex-1 min-w-0"><div className="text-[11px] font-semibold text-fg">{p.name}</div><div className="text-[9px] text-muted-fg">{p.unit} · {formatCurrency(p.basePrice)} · GST {p.gstPercent}%</div></div>
                <div className="flex items-center"><button onClick={() => setQty(p.id, qty - 1)} className="w-8 h-8 rounded-l-lg border border-border flex items-center justify-center text-muted-fg hover:bg-muted"><Minus className="h-3 w-3" /></button><input type="number" min={0} value={qty} onChange={e => setQty(p.id, parseInt(e.target.value) || 0)} className="w-12 h-8 border-y border-border text-center text-[12px] font-bold text-fg bg-card outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none" /><button onClick={() => setQty(p.id, qty + 1)} className="w-8 h-8 rounded-r-lg border border-border flex items-center justify-center text-muted-fg hover:bg-muted"><Plus className="h-3 w-3" /></button></div>
              </div>);
            })}</div>
          </div></Card>
          {cartItems.length > 0 && (<Card title="🛒 Cart Summary"><div className="p-4">
            <div className="space-y-2 mb-3">{cartItems.map(item => (<div key={item.id} className="flex items-center justify-between py-1.5 border-b border-border last:border-0"><div className="flex items-center gap-2"><span className="text-sm">{item.icon}</span><div><div className="text-[11px] font-semibold text-fg">{item.name} × {item.qty}</div><div className="text-[9px] text-muted-fg">{formatCurrency(item.basePrice)} + {item.gstPercent}% GST</div></div></div><div className="text-right"><div className="text-[11px] font-bold text-fg">{formatCurrency(item.lineTotal)}</div><div className="text-[9px] text-muted-fg">GST: {formatCurrency(item.lineGst)}</div></div></div>))}</div>
            <div className="pt-3 border-t border-border space-y-1"><div className="flex justify-between text-[11px]"><span className="text-muted-fg">Subtotal</span><span className="font-semibold">{formatCurrency(cart.subtotal)}</span></div><div className="flex justify-between text-[11px]"><span className="text-muted-fg">GST</span><span className="font-semibold">{formatCurrency(cart.totalGst)}</span></div><div className="flex justify-between text-[12px] font-bold pt-1 border-t border-border"><span className="text-brand">Grand Total ({cart.itemCount} items)</span><span className="text-brand">{formatCurrency(cart.grandTotal)}</span></div></div>
            {selectedDealer && <div className="text-[10px] text-muted-fg mt-2">For: {selectedDealer.name} · Wallet: <span className="text-success font-bold">{formatCurrency(selectedDealer.wallet_balance)}</span></div>}
            <div className="flex items-center gap-2 mt-3"><select value={paymentMode} onChange={e => setPaymentMode(e.target.value)} className="h-8 bg-card border border-border rounded-lg px-2 text-[11px] font-medium outline-none"><option value="wallet">Wallet</option><option value="upi">UPI</option><option value="credit">Credit</option></select><Button size="sm" className="flex-1" disabled={!selectedDealerId || cart.itemCount === 0 || placeMut.isPending} onClick={() => { setResultMsg(""); placeMut.mutate(); }}>{placeMut.isPending ? "Placing..." : "Place Indent"}</Button></div>
          </div></Card>)}
        </div>
      </div>
    </>
  );
}
