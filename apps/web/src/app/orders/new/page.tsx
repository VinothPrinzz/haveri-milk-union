"use client";
import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { formatCurrency, cn } from "@/lib/utils";
import { PageHeader, Card, Button } from "@/components/ui";
import { Search, Minus, Plus, ShoppingCart } from "lucide-react";

export default function NewIndentPage() {
  const [selectedDealerId, setSelectedDealerId] = useState<string | null>(null);
  const [dealerSearch, setDealerSearch] = useState("");
  const [quantities, setQuantities] = useState<Record<string, number>>({});
  const [paymentMode, setPaymentMode] = useState("wallet");
  const [placing, setPlacing] = useState(false);
  const [resultMsg, setResultMsg] = useState("");

  const { data: dealersData } = useQuery({
    queryKey: ["dealers-for-indent", dealerSearch],
    queryFn: () => api.get("/api/v1/dealers", { page: 1, limit: 20, search: dealerSearch || undefined }),
  });

  const { data: productsData } = useQuery({
    queryKey: ["products-active"],
    queryFn: () => api.get("/api/v1/products"),
  });

  const dealers = dealersData?.data ?? [];
  const products = productsData?.products ?? [];
  const selectedDealer = dealers.find((d: any) => d.id === selectedDealerId);

  const setQty = (productId: string, delta: number) => {
    setQuantities((prev) => ({
      ...prev,
      [productId]: Math.max(0, (prev[productId] ?? 0) + delta),
    }));
  };

  const cart = useMemo(() => {
    let itemCount = 0, subtotal = 0, totalGst = 0;
    for (const p of products) {
      const qty = quantities[p.id] ?? 0;
      if (qty > 0) {
        const price = parseFloat(p.basePrice);
        const gst = price * qty * (parseFloat(p.gstPercent) / 100);
        subtotal += price * qty;
        totalGst += gst;
        itemCount += qty;
      }
    }
    return { itemCount, subtotal, totalGst, grandTotal: subtotal + totalGst };
  }, [quantities, products]);

  const handlePlace = async () => {
    if (!selectedDealerId || cart.itemCount === 0) return;
    setPlacing(true);
    setResultMsg("");
    try {
      setResultMsg(`✅ Indent placed! ${cart.itemCount} items, ${formatCurrency(cart.grandTotal)}`);
      setQuantities({});
    } catch (err: any) {
      setResultMsg(`❌ ${err?.data?.message || "Failed to place indent"}`);
    } finally { setPlacing(false); }
  };

  return (
    <>
      <PageHeader icon="📞" title="New Indent (Call Desk)" subtitle="Create an indent on behalf of a dealer via phone call" />

      {resultMsg && (
        <div className={cn("mb-4 px-4 py-3 rounded-lg text-[12px] font-semibold border",
          resultMsg.startsWith("✅") ? "bg-success/10 border-success/20 text-success" : "bg-danger/10 border-danger/20 text-danger"
        )}>{resultMsg}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-5">
        {/* Left — Select Dealer */}
        <Card title="Select Dealer">
          <div className="p-4">
            <div className="flex items-center gap-2 bg-background border border-border rounded-lg px-3 py-2 mb-3">
              <Search className="h-3.5 w-3.5 text-muted-fg" />
              <input type="text" value={dealerSearch} onChange={(e) => setDealerSearch(e.target.value)}
                placeholder="Search by name or phone..."
                className="bg-transparent text-[11px] text-fg placeholder-muted-fg outline-none w-full font-medium" />
            </div>
            <div className="space-y-2">
              {dealers.map((d: any) => {
                const sel = d.id === selectedDealerId;
                const bal = parseFloat(d.wallet_balance || "0");
                return (
                  <div key={d.id} onClick={() => setSelectedDealerId(d.id)}
                    className={cn("p-3 rounded-lg cursor-pointer transition-all",
                      sel ? "border-[1.5px] border-brand bg-brand-light" : "border border-border bg-card hover:border-brand/30")}>
                    <div className={cn("text-[11px] font-bold", sel ? "text-brand" : "text-fg")}>{d.name}</div>
                    <div className="text-[9px] text-muted-fg font-medium mt-0.5">{d.phone} · {d.zone_name}</div>
                    <div className={cn("text-[10px] font-bold mt-1", bal >= 5000 ? "text-success" : bal > 0 ? "text-warning" : "text-danger")}>
                      Wallet: {formatCurrency(bal)}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </Card>

        {/* Right — Add Products */}
        <Card title="Add Products">
          <div className="p-4">
            <div className="space-y-2.5 mb-4">
              {products.map((p: any) => {
                const qty = quantities[p.id] ?? 0;
                return (
                  <div key={p.id} className="flex items-center gap-3 p-2.5 rounded-lg border border-border">
                    <span className="text-lg shrink-0">{p.icon || "📦"}</span>
                    <div className="flex-1 min-w-0">
                      <div className="text-[11px] font-semibold text-fg">{p.name}</div>
                      <div className="text-[9px] text-muted-fg">{p.unit} · {formatCurrency(p.basePrice)} · GST {p.gstPercent}%</div>
                    </div>
                    <div className="flex items-center">
                      <button onClick={() => setQty(p.id, -1)}
                        className="w-8 h-8 rounded-l-lg border border-border flex items-center justify-center text-muted-fg hover:bg-muted">
                        <Minus className="h-3 w-3" />
                      </button>
                      <div className="w-10 h-8 border-y border-border flex items-center justify-center text-[12px] font-bold text-fg bg-card">{qty}</div>
                      <button onClick={() => setQty(p.id, 1)}
                        className="w-8 h-8 rounded-r-lg border border-border flex items-center justify-center text-muted-fg hover:bg-muted">
                        <Plus className="h-3 w-3" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Cart Summary Bar */}
            <div className="p-3 rounded-lg border border-brand-light2 bg-brand-light">
              <div className="flex items-center justify-between flex-wrap gap-2">
                <div>
                  <div className="text-[12px] font-bold text-brand">
                    <ShoppingCart className="h-3.5 w-3.5 inline mr-1" />
                    {cart.itemCount} items · {formatCurrency(cart.subtotal)} + {formatCurrency(cart.totalGst)} GST = <strong>{formatCurrency(cart.grandTotal)}</strong>
                  </div>
                  {selectedDealer && (
                    <div className="text-[10px] text-muted-fg mt-0.5">
                      For: {selectedDealer.name} · Wallet: <span className="text-success font-bold">{formatCurrency(selectedDealer.wallet_balance)}</span>
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2">
                  <select value={paymentMode} onChange={(e) => setPaymentMode(e.target.value)}
                    className="h-8 bg-card border border-border rounded-lg px-2 text-[11px] font-medium outline-none">
                    <option value="wallet">Wallet</option>
                    <option value="upi">UPI</option>
                    <option value="credit">Credit</option>
                  </select>
                  <Button size="sm" disabled={!selectedDealerId || cart.itemCount === 0 || placing} onClick={handlePlace}>
                    {placing ? "Placing..." : "Place Indent"}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
