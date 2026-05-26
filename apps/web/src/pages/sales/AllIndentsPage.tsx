// ════════════════════════════════════════════════════════════════════
// All Indents — list with status / route / date filters
// Route preserved: /sales/all-indents
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import PageHeader, {
  FilterBar, Field, EmptyState, StatusPill, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Printer, X } from "lucide-react";
import { fetchIndents, fetchRoutes } from "@/services/api";

const STATUS_OPTS: F9Option[] = [
  { value: "confirmed",  label: "Confirmed" },
  { value: "dispatched", label: "Dispatched" },
  { value: "delivered",  label: "Delivered" },
  { value: "cancelled",  label: "Cancelled" },
];

const formatIndentId = (id: string) => id ? `#HMU-${String(id).slice(-4).toUpperCase()}` : "—";

export default function AllIndentsPage() {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);

  const [from, setFrom] = useState(today);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<string | null>(null);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });

  const { data: indents = [], isLoading } = useQuery({
    queryKey: ["indents", { from, to, status, routeId }],
    queryFn: () => fetchIndents({
      from, to,
      status: (status ?? undefined) as any,
      routeId: routeId ?? undefined,
    }),
  });

  const routeOpts: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return indents;
    return indents.filter((i: any) =>
      (i.code ?? "").toLowerCase().includes(s) ||
      (i.customerName ?? "").toLowerCase().includes(s)
    );
  }, [indents, q]);

  const grand = filtered.reduce(
    (s: number, i: any) => s + (parseFloat(String(i.grand_total ?? i.total ?? 0)) || 0),
    0
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="All Indents"
        subtitle="Search and review every indent across statuses"
        actions={
          <Button size="sm" variant="outline" className="h-8" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5 mr-1" /> Print
          </Button>
        }
      />

      <FilterBar>
        <Field label="From"><Input type="date" className="erp-input w-36" value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" className="erp-input w-36" value={to} onChange={e => setTo(e.target.value)} /></Field>
        <Field label="Status"><F9SearchSelect value={status} onChange={setStatus} options={STATUS_OPTS} allowAll className="w-44" /></Field>
        <Field label="Route"><F9SearchSelect value={routeId} onChange={setRouteId} options={routeOpts} allowAll className="w-56" /></Field>
        <Field label="Search"><Input className="erp-input w-56" placeholder="indent # / customer" value={q} onChange={e => setQ(e.target.value)} /></Field>
        {(status || routeId || q) && (
          <div className="flex items-end">
            <Button size="sm" variant="outline" className="h-8" onClick={() => { setStatus(null); setRouteId(null); setQ(""); }}>
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          </div>
        )}
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          <div className="print-document">
            {isLoading ? (
              <div className="p-3 space-y-2">
                {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
              </div>
            ) : filtered.length === 0 ? (
              <EmptyState title="No indents match this filter." />
            ) : (
              <table className="erp-table">
                <thead>
                  <tr>
                    <th style={{ width: 130 }}>Indent #</th>
                    <th style={{ width: 110 }}>Date</th>
                    <th>Customer</th>
                    <th>Route</th>
                    <th style={{ width: "30%" }}>Items</th>
                    <th className="num" style={{ width: 130, textAlign: "right" }}>Total ₹</th>
                    <th style={{ width: 110 }}>Status</th>
                    <th style={{ width: 90, textAlign: "center" }}>Update</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((i: any) => (
                    <tr key={i.id}>
                      <td className="font-mono text-[12px]">{formatIndentId(i.id)}</td>
                      <td className="text-[12.5px]">{fmtDate(i.rawDate ?? i.date)}</td>
                      <td className="font-medium">{i.dealer_name ?? i.customerName ?? i.customerId}</td>
                      <td>{i.route_code ?? i.route_name ?? i.routeName ?? i.routeId ?? "—"}</td>
                      <td>
                        {(i.items ?? i.lines ?? []).length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {(i.items ?? i.lines ?? []).map((it: any, k: number) => (
                              <span key={k} className="text-[12px]">
                                <span className="num font-medium">{it.quantity ?? it.qty}×</span>{" "}
                                {it.product_name ?? it.productName ?? it.name}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(parseFloat(String(i.grand_total ?? i.total ?? 0)) || 0)}</td>
                      <td><StatusPill status={i.status} /></td>
                      <td style={{ textAlign: "center" }}>
                        <Button
                          size="sm" 
                          className="h-7 px-2.5 text-[12px]"
                          onClick={() => navigate(`/sales/direct-sales/modify?indentId=${i.id}&type=order`)}
                        >
                          Update
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-muted/40">
                    <td colSpan={5} className="text-right uppercase text-[12.5px] font-semibold tracking-wide">Grand Total</td>
                    <td className="num font-bold text-[14px]" style={{ textAlign: "right" }}>{fmtINR(grand)}</td>
                    <td colSpan={2}></td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}