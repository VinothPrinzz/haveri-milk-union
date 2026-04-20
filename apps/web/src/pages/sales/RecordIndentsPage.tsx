// apps/web/src/pages/sales/RecordIndentsPage.tsx
// ════════════════════════════════════════════════════════════════════
// Record Indents — Marketing v1.4
//
// Changes vs v1.3:
//   • Batch selector → F9SearchSelect
//   • Agent Code selector → F9SearchSelect (code + name sublabel)
//   • Product table wrapped in LiveSearchTable
// ════════════════════════════════════════════════════════════════════

import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useState, useMemo } from "react";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { LiveSearchTable } from "@/components/LiveSearchTable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  fetchProducts,
  fetchCustomers,
  fetchBatches,
  createIndent,
} from "@/services/api";

export default function RecordIndentsPage() {
  const qc = useQueryClient();
  const { data: products = [] } = useQuery({ queryKey: ["products"], queryFn: fetchProducts });
  const { data: customers = [] } = useQuery({ queryKey: ["customers"], queryFn: fetchCustomers });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  // ── Selections ──
  const [selectedBatchId, setSelectedBatchId] = useState<string | null>(null);
  const [indentDate, setIndentDate] = useState(new Date().toISOString().split("T")[0]);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [showIndent, setShowIndent] = useState(false);
  const [quantities, setQuantities] = useState<Record<string, number>>({});

  const agent = customers.find((c: any) => c.id === agentId);
  const activeProducts = products.filter((p: any) => !p.terminated);

  const batchOptions: F9Option[] = useMemo(
    () =>
      batches.map((b: any) => ({
        value: b.id,
        label: b.whichBatch || b.batchCode,
        sublabel: b.timing,
      })),
    [batches]
  );

  const agentOptions: F9Option[] = useMemo(
    () =>
      customers.map((c: any) => ({
        value: c.id,
        label: c.code,
        sublabel: c.name,
        searchText: `${c.code} ${c.name} ${c.phone ?? ""}`,
      })),
    [customers]
  );

  const updateQty = (pid: string, qty: number) =>
    setQuantities(prev => ({ ...prev, [pid]: qty }));

  const orderItems = useMemo(
    () =>
      activeProducts
        .filter((p: any) => (quantities[p.id] || 0) > 0)
        .map((p: any) => {
          const qty = quantities[p.id] || 0;
          const rateCategory = agent?.rateCategory ?? "Retail-Dealer";
          const rate = p.rateCategories?.[rateCategory] ?? p.rateCategories?.["Retail-Dealer"] ?? p.mrp;
          const gst = qty * rate * ((p.gstPercent ?? 0) / 100);
          return { product: p, qty, rate, amount: qty * rate, gst };
        }),
    [activeProducts, quantities, agent]
  );

  const totalAmount = orderItems.reduce((s, i) => s + i.amount, 0);
  const totalGst = orderItems.reduce((s, i) => s + i.gst, 0);
  const grandTotal = totalAmount + totalGst;

  const handleGo = () => {
    if (!selectedBatchId || !agentId) {
      toast.error("Please select both batch and agent");
      return;
    }
    setShowIndent(true);
    setQuantities({});
  };

  const createMutation = useMutation({
    mutationFn: () => {
      if (!agent) throw new Error("Agent not loaded");
      if (agent.creditLimit && grandTotal > (agent.creditLimit ?? 0) + (agent.creditBalance ?? 0)) {
        throw new Error(
          `Order total ₹${grandTotal.toFixed(2)} exceeds available credit ₹${(
            (agent.creditLimit ?? 0) + (agent.creditBalance ?? 0)
          ).toLocaleString()}`
        );
      }
      const items = orderItems.map(i => ({
        productId: i.product.id,
        productName: i.product.reportAlias,
        qty: i.qty,
        rate: i.rate,
        quantity: i.qty,
      }));
      return createIndent({
        customerId: agent.id,
        customerName: agent.name,
        routeId: agent.routeId || "",
        batchId: selectedBatchId,
        date: indentDate,
        agentCode: agent.code,
        payMode: agent.payMode ?? "Credit",
        items,
        total: grandTotal,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["indents"] });
      toast.success(`Indent recorded — ₹${grandTotal.toFixed(2)}`);
      setQuantities({});
      setShowIndent(false);
      setAgentId(null);
    },
    onError: (err: Error) => toast.error(err.message || "Failed to record indent"),
  });

  return (
    <div>
      <PageHeader title="Record Indents" description="Record daily indents from agents">
        <Button variant="destructive" size="sm" onClick={() => toast.info("Indents reset")}>
          Reset Indents
        </Button>
      </PageHeader>

      <Card className="mb-4">
        <CardHeader>
          <CardTitle className="text-base">Select Batch & Agent</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-4 items-end">
            <F9SearchSelect
              label="Batch"
              value={selectedBatchId}
              onChange={setSelectedBatchId}
              options={batchOptions}
              className="w-56"
            />
            <div>
              <label className="text-sm font-medium mb-1.5 block">Indent Date</label>
              <Input
                type="date"
                value={indentDate}
                onChange={e => setIndentDate(e.target.value)}
                className="w-44"
              />
            </div>
            <F9SearchSelect
              label="Agent Code"
              value={agentId}
              onChange={setAgentId}
              options={agentOptions}
              className="w-72"
            />
            <Button onClick={handleGo}>GO</Button>
          </div>
        </CardContent>
      </Card>

      {showIndent && agent && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <div className="lg:col-span-2">
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Indent Entry — {agent.name}</CardTitle>
                  <span className="text-xs text-muted-foreground">
                    {agent.code} · Rate: {agent.rateCategory} · {agent.payMode}
                  </span>
                </div>
              </CardHeader>
              <CardContent>
                <LiveSearchTable
                  items={activeProducts}
                  getSearchableText={p => `${p.code} ${p.name} ${p.reportAlias}`}
                  placeholder="Search by name, code, or alias..."
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
                          const rate = p.rateCategories?.[agent.rateCategory] ?? p.rateCategories?.["Retail-Dealer"] ?? p.mrp;
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
                                  onChange={e => updateQty(p.id, parseInt(e.target.value) || 0)}
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
                        {i.product.reportAlias} × {i.qty}
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
                    onClick={() => createMutation.mutate()}
                    disabled={createMutation.isPending}
                  >
                    {createMutation.isPending ? "Saving..." : "Save Indent"}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}