// apps/web/src/pages/sales/DirectSalesPage.tsx
// ════════════════════════════════════════════════════════════════════
// Direct Sales (Gate Pass / Cash Customer / Modify) — Marketing v1.4
//
// Changes vs v1.3:
//   • Gate Pass tab:     Agent → F9SearchSelect (code + name sublabel)
//   • Cash Customer tab: Customer → F9SearchSelect (from cash_customers)
//                        with inline "+ New Customer" if list is empty
//   • Both tabs:         product entry table wrapped in LiveSearchTable
//   • Modify tab:        preserved as-is (it has its own flow)
// ════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { LiveSearchTable } from "@/components/LiveSearchTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  fetchProducts,
  fetchCustomers,
  fetchCashCustomers,
  createCashCustomer,
  createGatePassSale,
  createCashSale,
  fetchIndents,
  modifyIndent,
} from "@/services/api";

interface Props {
  tab?: "gate-pass" | "cash-customer" | "modify";
}

// ══════════════════════════════════════════════════════════════════
// Shared product entry table (used by both tabs)
// ══════════════════════════════════════════════════════════════════
function ProductEntryTable({
  quantities,
  setQuantities,
  onSubmit,
  actionLabel,
  isLoading,
  rateCategory = "Retail-Dealer",
}: {
  quantities: Record<string, number>;
  setQuantities: React.Dispatch<React.SetStateAction<Record<string, number>>>;
  onSubmit: () => void;
  actionLabel: string;
  isLoading: boolean;
  rateCategory?: string;
}) {
  const { data: products = [] } = useQuery({
    queryKey: ["products"],
    queryFn: fetchProducts,
  });
  const activeProducts = products.filter((p: any) => !p.terminated);

  const orderItems = useMemo(() => {
    return activeProducts
      .filter((p: any) => (quantities[p.id] || 0) > 0)
      .map((p: any) => {
        const qty = quantities[p.id] || 0;
        const rate =
          p.rateCategories?.[rateCategory] ??
          p.rateCategories?.["Retail-Dealer"] ??
          p.mrp;
        const gst = qty * rate * ((p.gstPercent ?? 0) / 100);
        return { product: p, qty, rate, amount: qty * rate, gst };
      });
  }, [activeProducts, quantities, rateCategory]);

  const totalAmount = orderItems.reduce((s, i) => s + i.amount, 0);
  const totalGst = orderItems.reduce((s, i) => s + i.gst, 0);
  const grandTotal = totalAmount + totalGst;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Select Products</CardTitle>
          </CardHeader>
          <CardContent>
            <LiveSearchTable
              items={activeProducts}
              getSearchableText={(p: any) => `${p.code} ${p.name} ${p.reportAlias}`}
              placeholder="Search products by name, code, or alias..."
            >
              {filtered => (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                      <th className="text-left py-2 px-2 font-medium">Code</th>
                      <th className="text-left py-2 px-2 font-medium">Product</th>
                      <th className="text-right py-2 px-2 font-medium">Rate</th>
                      <th className="text-right py-2 px-2 font-medium">Qty</th>
                      <th className="text-right py-2 px-2 font-medium">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((p: any) => {
                      const rate =
                        p.rateCategories?.[rateCategory] ??
                        p.rateCategories?.["Retail-Dealer"] ??
                        p.mrp;
                      const qty = quantities[p.id] || 0;
                      return (
                        <tr key={p.id} className="border-b hover:bg-muted/20">
                          <td className="py-1.5 px-2 font-mono text-xs">{p.code}</td>
                          <td className="py-1.5 px-2 font-medium">{p.reportAlias || p.name}</td>
                          <td className="py-1.5 px-2 text-right font-mono">₹{rate}</td>
                          <td className="py-1.5 px-2 text-right">
                            <Input
                              type="number"
                              min="0"
                              value={qty || ""}
                              onChange={e =>
                                setQuantities(prev => ({
                                  ...prev,
                                  [p.id]: parseInt(e.target.value) || 0,
                                }))
                              }
                              className="h-8 w-20 text-right inline-block"
                            />
                          </td>
                          <td className="py-1.5 px-2 text-right font-mono">
                            {qty > 0 ? `₹${(qty * rate).toFixed(2)}` : "—"}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </LiveSearchTable>
          </CardContent>
        </Card>
      </div>

      <Card className="sticky top-4 h-fit">
        <CardHeader>
          <CardTitle className="text-base">Order Summary</CardTitle>
        </CardHeader>
        <CardContent>
          {orderItems.length === 0 ? (
            <p className="text-sm text-muted-foreground">No items added yet.</p>
          ) : (
            <div className="space-y-2">
              {orderItems.map(i => (
                <div key={i.product.id} className="flex justify-between text-sm">
                  <span className="text-muted-foreground">
                    {i.product.reportAlias || i.product.name} × {i.qty}
                  </span>
                  <span className="font-mono">₹{i.amount.toFixed(2)}</span>
                </div>
              ))}
              <div className="border-t pt-2 space-y-1 text-sm">
                <div className="flex justify-between text-muted-foreground">
                  <span>Subtotal</span>
                  <span className="font-mono">₹{totalAmount.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-muted-foreground">
                  <span>GST</span>
                  <span className="font-mono">₹{totalGst.toFixed(2)}</span>
                </div>
                <div className="flex justify-between font-semibold">
                  <span>Grand Total</span>
                  <span className="font-mono">₹{grandTotal.toFixed(2)}</span>
                </div>
              </div>
              <Button
                className="w-full mt-3"
                onClick={onSubmit}
                disabled={isLoading || orderItems.length === 0}
              >
                {isLoading ? "Saving..." : actionLabel}
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Modify tab — input-based lookup flow (reverted to v1.3 UX)
//
// Operator types an indent ID (or indent number like IND-2026-003)
// into the input, clicks Load, and the modifiable table appears
// below with the indent's items.
// ══════════════════════════════════════════════════════════════════
function ModifyIndentView() {
  const qc = useQueryClient();
  const [indentInput, setIndentInput] = useState("");
  const [loadedIndent, setLoadedIndent] = useState<any | null>(null);
  const [modifyQtys, setModifyQtys] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);

  const handleLoad = async () => {
    const query = indentInput.trim();
    if (!query) {
      toast.error("Enter an indent ID or number");
      return;
    }
    setLoading(true);
    try {
      // Fetch all pending indents, then try to match against either
      // `id` (UUID) or `indentNo` (IND-2026-003 etc.) — whichever the
      // operator typed. Case-insensitive match on indentNo.
      const all = await fetchIndents({ status: "Pending" });
      const match = (all as any[]).find(
        (i: any) =>
          i.id === query ||
          (i.indentNo ?? "").toLowerCase() === query.toLowerCase()
      );
      if (!match) {
        toast.error(`No pending indent found matching "${query}"`);
        setLoadedIndent(null);
        setModifyQtys({});
        return;
      }
      setLoadedIndent(match);
      setModifyQtys(
        Object.fromEntries((match.items ?? []).map((x: any) => [x.productId, x.qty]))
      );
    } catch (e: any) {
      toast.error(e?.message || "Failed to load indent");
    } finally {
      setLoading(false);
    }
  };

  const modifyMutation = useMutation({
    mutationFn: () => {
      if (!loadedIndent) throw new Error("No indent loaded");
      const items = Object.entries(modifyQtys).map(([productId, quantity]) => ({
        productId,
        quantity,
      }));
      return modifyIndent(loadedIndent.id, items);
    },
    onSuccess: () => {
      toast.success("Indent modified");
      qc.invalidateQueries({ queryKey: ["indents"] });
      setLoadedIndent(null);
      setModifyQtys({});
      setIndentInput("");
    },
    onError: (e: any) => toast.error(e?.message || "Failed to modify"),
  });

  return (
    <div>
      <PageHeader title="Modify Indent" description="Look up a pending indent by ID or number and modify its quantities" />

      <Card className="mb-4">
        <CardContent className="p-5">
          <div className="flex flex-wrap gap-3 items-end">
            <div className="flex-1 min-w-64 max-w-md">
              <label className="text-sm font-medium mb-1.5 block">Indent ID or Number</label>
              <Input
                placeholder="e.g. IND-2026-003 or full UUID"
                value={indentInput}
                onChange={e => setIndentInput(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") handleLoad(); }}
              />
            </div>
            <Button onClick={handleLoad} disabled={loading || !indentInput.trim()}>
              {loading ? "Loading..." : "Load"}
            </Button>
            {loadedIndent && (
              <Button
                variant="outline"
                onClick={() => {
                  setLoadedIndent(null);
                  setModifyQtys({});
                  setIndentInput("");
                }}
              >
                Clear
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {loadedIndent && (
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between">
              <CardTitle className="text-base">
                Modify — {loadedIndent.customerName}
              </CardTitle>
              <span className="text-xs text-muted-foreground">
                {loadedIndent.indentNo} · {loadedIndent.date} · ₹{(loadedIndent.total ?? 0).toLocaleString()}
              </span>
            </div>
          </CardHeader>
          <CardContent>
            <table className="w-full text-sm mb-4">
              <thead>
                <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <th className="text-left py-2 px-3 font-medium">Product</th>
                  <th className="text-right py-2 px-3 font-medium">Original</th>
                  <th className="text-right py-2 px-3 font-medium">New Qty</th>
                  <th className="text-right py-2 px-3 font-medium">Rate</th>
                  <th className="text-right py-2 px-3 font-medium">Amount</th>
                </tr>
              </thead>
              <tbody>
                {(loadedIndent.items ?? []).map((item: any, idx: number) => {
                  const newQty = modifyQtys[item.productId] ?? item.qty;
                  const amt = newQty * (item.rate ?? 0);
                  return (
                    <tr key={`${item.productId}-${idx}`} className="border-b">
                      <td className="py-2 px-3 font-medium">{item.productName}</td>
                      <td className="py-2 px-3 text-right font-mono text-muted-foreground">
                        {item.qty}
                      </td>
                      <td className="py-2 px-3 text-right">
                        <Input
                          type="number"
                          min={0}
                          value={newQty}
                          onChange={e =>
                            setModifyQtys(p => ({
                              ...p,
                              [item.productId]: +e.target.value,
                            }))
                          }
                          className="h-8 w-20 text-right font-mono ml-auto"
                        />
                      </td>
                      <td className="py-2 px-3 text-right font-mono">₹{item.rate}</td>
                      <td className="py-2 px-3 text-right font-mono">₹{amt.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Button onClick={() => modifyMutation.mutate()} disabled={modifyMutation.isPending}>
              {modifyMutation.isPending ? "Saving..." : "Save Changes"}
            </Button>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════
// Main — dispatches to the right tab
// ══════════════════════════════════════════════════════════════════
export default function DirectSalesPage({ tab = "gate-pass" }: Props) {
  if (tab === "modify") return <ModifyIndentView />;

  const queryClient = useQueryClient();
  const isGatePass = tab === "gate-pass";

  // Data sources
  const { data: customers = [] } = useQuery({
    queryKey: ["customers"],
    queryFn: fetchCustomers,
  });
  const { data: cashCustomers = [] } = useQuery({
    queryKey: ["cash-customers"],
    queryFn: fetchCashCustomers,
    enabled: !isGatePass, // only fetch on the cash tab
  });

  // State
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [selectedCashCustomer, setSelectedCashCustomer] = useState<string | null>(null);
  const [newCustomerName, setNewCustomerName] = useState("");
  const [indentDate, setIndentDate] = useState(new Date().toISOString().split("T")[0]);
  const [payMode, setPayMode] = useState<"Cash" | "Credit">("Cash");
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  // Active agents for Gate Pass F9
  const agentOptions: F9Option[] = useMemo(
    () =>
      customers
        .filter((c: any) => c.status === "Active")
        .map((c: any) => ({
          value: c.id,
          label: c.code,
          sublabel: c.name,
          searchText: `${c.code} ${c.name} ${c.phone ?? ""} ${c.city ?? ""}`,
        })),
    [customers]
  );

  // Cash customer F9 options
  const cashCustomerOptions: F9Option[] = useMemo(
    () =>
      cashCustomers.map((c: any) => ({
        value: c.id,
        label: c.name,
        sublabel: c.phone,
        searchText: `${c.name} ${c.phone ?? ""} ${c.address ?? ""}`,
      })),
    [cashCustomers]
  );

  // Mutations
  const gatePassMutation = useMutation({
    mutationFn: createGatePassSale,
    onSuccess: (sale: any) => {
      toast.success(
        `Gate Pass ${sale.gpNo} generated — ₹${sale.total?.toLocaleString()}`
      );
      queryClient.invalidateQueries({ queryKey: ["direct-sales"] });
      setSelectedAgent(null);
      setQuantities({});
    },
    onError: (err: any) => toast.error(err?.message || "Failed to generate gate pass"),
  });

  const cashSaleMutation = useMutation({
    mutationFn: createCashSale,
    onSuccess: (sale: any) => {
      toast.success(`Sale recorded — ₹${sale.total?.toLocaleString()}`);
      queryClient.invalidateQueries({ queryKey: ["direct-sales"] });
      setSelectedCashCustomer(null);
      setQuantities({});
    },
    onError: (err: any) => toast.error(err?.message || "Failed to record sale"),
  });

  const createCustomerMutation = useMutation({
    mutationFn: (name: string) => createCashCustomer({ name }),
    onSuccess: (customer: any) => {
      toast.success(`Added ${customer.name}`);
      queryClient.invalidateQueries({ queryKey: ["cash-customers"] });
      setSelectedCashCustomer(customer.id);
      setNewCustomerName("");
    },
    onError: (err: any) => toast.error(err?.message || "Failed to add customer"),
  });

  // Handlers
  const handleGatePassSubmit = () => {
    if (!selectedAgent) {
      toast.error("Please select an agent");
      return;
    }
    const agent = customers.find((a: any) => a.id === selectedAgent);
    if (!agent) return;
    const orderItems = Object.entries(quantities)
      .filter(([_, qty]) => qty > 0)
      .map(([productId, qty]) => ({ productId, quantity: qty }));
    if (orderItems.length === 0) {
      toast.error("Please add at least one product");
      return;
    }
    gatePassMutation.mutate({
      customerId: selectedAgent,
      routeId: agent.routeId,
      items: orderItems,
      paymentMode: "credit",
    });
  };

  const handleCashSaleSubmit = () => {
    if (!selectedCashCustomer) {
      toast.error("Please select a customer");
      return;
    }
    const orderItems = Object.entries(quantities)
      .filter(([_, qty]) => qty > 0)
      .map(([productId, qty]) => ({ productId, quantity: qty }));
    if (orderItems.length === 0) {
      toast.error("Please add at least one product");
      return;
    }
    cashSaleMutation.mutate({
      customerId: selectedCashCustomer,
      items: orderItems,
      paymentMode: payMode.toLowerCase() as "cash" | "upi",
    });
  };

  const selectedAgentData = customers.find((c: any) => c.id === selectedAgent);

  return (
    <div>
      <PageHeader
        title={isGatePass ? "Gate Pass — Agents" : "Cash Customer Sale"}
        description={
          isGatePass
            ? "Emergency/adhoc sales via gate pass"
            : "Advance-paid customer sales"
        }
      />

      <Card className="mb-6">
        <CardContent className="p-5">
          <div className="flex flex-wrap gap-4 items-end">
            {isGatePass ? (
              <F9SearchSelect
                label="Agent"
                value={selectedAgent}
                onChange={setSelectedAgent}
                options={agentOptions}
                className="w-72"
              />
            ) : (
              <>
                <F9SearchSelect
                  label="Customer"
                  value={selectedCashCustomer}
                  onChange={setSelectedCashCustomer}
                  options={cashCustomerOptions}
                  className="w-72"
                />
                <div className="flex items-end gap-2">
                  <div>
                    <label className="text-sm font-medium mb-1.5 block">
                      Or add new
                    </label>
                    <Input
                      placeholder="New customer name"
                      value={newCustomerName}
                      onChange={e => setNewCustomerName(e.target.value)}
                      className="w-52"
                    />
                  </div>
                  <Button
                    variant="outline"
                    onClick={() => createCustomerMutation.mutate(newCustomerName)}
                    disabled={!newCustomerName.trim() || createCustomerMutation.isPending}
                  >
                    + Add
                  </Button>
                </div>
              </>
            )}

            <div>
              <label className="text-sm font-medium mb-1.5 block">Date</label>
              <Input
                type="date"
                value={indentDate}
                onChange={e => setIndentDate(e.target.value)}
                className="w-44"
              />
            </div>

            {!isGatePass && (
              <div>
                <label className="text-sm font-medium mb-1.5 block">Pay Mode</label>
                <Select value={payMode} onValueChange={(v: any) => setPayMode(v)}>
                  <SelectTrigger className="w-36"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="Cash">Cash</SelectItem>
                    <SelectItem value="Credit">Credit (UPI)</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}

            {isGatePass && selectedAgentData && (
              <div className="text-xs text-muted-foreground pb-1.5">
                <div>{selectedAgentData.code} · {selectedAgentData.name}</div>
                <div>Rate: {selectedAgentData.rateCategory}</div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      <ProductEntryTable
        quantities={quantities}
        setQuantities={setQuantities}
        onSubmit={isGatePass ? handleGatePassSubmit : handleCashSaleSubmit}
        actionLabel={isGatePass ? "Generate Gate Pass" : "Record Sale"}
        isLoading={isGatePass ? gatePassMutation.isPending : cashSaleMutation.isPending}
        rateCategory={selectedAgentData?.rateCategory ?? "Retail-Dealer"}
      />
    </div>
  );
}