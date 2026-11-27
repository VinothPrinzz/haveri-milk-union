// apps/web/src/pages/sales/ProductDemandPage.tsx
// ════════════════════════════════════════════════════════════════════
// Sales Operations → Product Demand  (/sales/product-demand)
//
// Dealers tap "Notify" on a product that is out of stock in their app.
// Each tap is one request per dealer, product and day (a repeat tap that
// day bumps "Taps"). This page lists them per product, most-asked first,
// with the dealers who asked, so stock can be planned. "Mark done" closes
// requests once they have been dealt with.
// ════════════════════════════════════════════════════════════════════
import { Fragment, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { CheckCheck } from "lucide-react";
import PageHeader, { EmptyState, FilterBar, Field } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useAuth } from "@/lib/auth";
import { todayIST } from "@/lib/istDate";
import { fetchProductDemand, resolveProductDemand, type DemandProduct } from "@/services/notifications";

// Mirrors demand.manage in apps/api/src/middleware/admin-auth.ts.
const CAN_RESOLVE = new Set(["super_admin", "manager", "call_desk", "dispatch_officer", "fgs_milk_curd", "fgs_others"]);

const dmy = (iso: string) => iso.split("-").reverse().join("-");
const time = (ts: string) =>
  new Date(ts).toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: true });

export default function ProductDemandPage() {
  const { user } = useAuth();
  const canResolve = CAN_RESOLVE.has(user?.role ?? "");
  const qc = useQueryClient();
  const today = todayIST();
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<"open" | "all">("open");

  const { data, isLoading } = useQuery({
    queryKey: ["product-demand", from, to, status],
    queryFn: () => fetchProductDemand({ from, to, status }),
    refetchInterval: 60_000,
  });
  const products: DemandProduct[] = data?.products ?? [];
  const totals = useMemo(() => ({
    products: products.length,
    requests: products.reduce((s, p) => s + p.dealerCount, 0),
    open: products.reduce((s, p) => s + p.open, 0),
  }), [products]);

  const resolve = useMutation({
    mutationFn: (ids: string[]) => resolveProductDemand(ids),
    onSuccess: (r) => {
      toast.success(`${r.resolved} request${r.resolved === 1 ? "" : "s"} marked done`);
      qc.invalidateQueries({ queryKey: ["product-demand"] });
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Product Demand"
        subtitle="Products dealers asked for from the app while they were out of stock"
      />
      <FilterBar>
        <Field label="From">
          <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="erp-input w-40" />
        </Field>
        <Field label="To">
          <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="erp-input w-40" />
        </Field>
        <Field label="Show">
          <select value={status} onChange={e => setStatus(e.target.value as "open" | "all")} className="erp-input w-36 h-8">
            <option value="open">Open only</option>
            <option value="all">Open and done</option>
          </select>
        </Field>
        <div className="self-end pb-1.5 text-[12px] text-muted-foreground">
          {totals.products} product{totals.products === 1 ? "" : "s"} · {totals.requests} request{totals.requests === 1 ? "" : "s"}
          {status === "all" ? ` · ${totals.open} open` : ""}
        </div>
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        {isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : products.length === 0 ? (
          <EmptyState
            title="No product demand"
            hint="When a dealer taps Notify on an out-of-stock product in the app, it shows up here."
          />
        ) : (
          <table className="erp-table w-full text-[12.5px]">
            <thead>
              <tr>
                <th>Product / Dealer</th>
                <th>Taluka</th>
                <th>Route</th>
                <th>Phone</th>
                <th>Asked</th>
                <th className="num" style={{ textAlign: "right" }}>Taps</th>
                <th>Status</th>
                {canResolve && <th />}
              </tr>
            </thead>
            <tbody>
              {products.map(p => {
                const openIds = p.requests.filter(r => !r.resolvedAt).map(r => r.id);
                return (
                  <Fragment key={p.productId}>
                    <tr className="bg-muted/40 font-semibold">
                      <td colSpan={5}>
                        {p.productName}
                        {p.productCode && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">{p.productCode}</span>}
                        <span className="ml-2 font-normal text-muted-foreground">
                          {p.dealerCount} dealer request{p.dealerCount === 1 ? "" : "s"}{p.categoryName ? ` · ${p.categoryName}` : ""}
                        </span>
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>{p.taps}</td>
                      <td>{p.open ? `${p.open} open` : "Done"}</td>
                      {canResolve && (
                        <td style={{ textAlign: "right" }}>
                          {openIds.length > 0 && (
                            <Button size="sm" variant="outline" className="h-6 text-[11px]"
                              disabled={resolve.isPending} onClick={() => resolve.mutate(openIds)}>
                              <CheckCheck className="h-3 w-3 mr-1" /> Mark all done
                            </Button>
                          )}
                        </td>
                      )}
                    </tr>
                    {p.requests.map(r => (
                      <tr key={r.id} className={r.resolvedAt ? "text-muted-foreground" : ""}>
                        <td className="pl-6">
                          {r.dealerCode && <span className="font-mono text-[11.5px] mr-1.5">{r.dealerCode}</span>}
                          {r.dealerName}
                        </td>
                        <td>{r.taluka}</td>
                        <td className="font-mono">{r.routeCode ?? ""}</td>
                        <td className="num">{r.dealerPhone ?? ""}</td>
                        <td className="whitespace-nowrap">{from === to ? "" : `${dmy(r.requestDate)} `}{time(r.createdAt)}</td>
                        <td className="num" style={{ textAlign: "right" }}>{r.taps}</td>
                        <td>{r.resolvedAt ? `Done${r.resolvedByName ? ` (${r.resolvedByName})` : ""}` : "Open"}</td>
                        {canResolve && (
                          <td style={{ textAlign: "right" }}>
                            {!r.resolvedAt && (
                              <Button size="sm" variant="ghost" className="h-6 text-[11px]"
                                disabled={resolve.isPending} onClick={() => resolve.mutate([r.id])}>
                                Mark done
                              </Button>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
