import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  EmptyState,
  StatusPill,
  fmtINR,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Download, Truck, Package } from "lucide-react";
import { fetchIndents, fetchRoutes } from "@/services/api";

export default function DispatchPage() {
  const { data: indents = [], isLoading: lInd } = useQuery({ queryKey: ["indents"], queryFn: () => fetchIndents() });
  const { data: routes = [], isLoading: lRt } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });

  const posted = (indents as any[]).filter((i: any) => i.status === "Posted" || i.status === "Dispatched");
  const byRoute = (routes as any[])
    .map((r: any) => ({ route: r, indents: posted.filter((i: any) => i.routeId === r.id) }))
    .filter((x: any) => x.indents.length > 0);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="FGS Dispatch"
        subtitle="View and manage dispatch for today"
        actions={
          <Button size="sm" variant="outline" className="h-8" onClick={() => toast.info("CSV export triggered")}>
            <Download className="h-3.5 w-3.5 mr-1.5" /> Export CSV
          </Button>
        }
      />

      <div className="flex-1 overflow-auto p-4 space-y-3">
        {(lInd || lRt) ? (
          <div className="erp-panel p-8 text-center text-muted-foreground text-[13px]">Loading dispatch…</div>
        ) : byRoute.length === 0 ? (
          <EmptyState title="No posted indents to dispatch right now" />
        ) : byRoute.map(({ route, indents: routeIndents }: any) => (
          <div key={route.id} className="erp-panel">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border">
              <div className="flex items-center gap-3">
                <Truck className="h-5 w-5 text-primary" />
                <div>
                  <h3 className="font-semibold text-[14px]">{route.name}</h3>
                  <p className="text-[11.5px] text-muted-foreground">
                    Dispatch: {route.dispatchTime ?? "—"} · {routeIndents.length} order{routeIndents.length !== 1 ? "s" : ""}
                  </p>
                </div>
              </div>
              <StatusPill status={route.status === "Active" ? "active" : "inactive"} />
            </div>
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 48 }}>#</th>
                  <th>Indent</th>
                  <th>Dealer</th>
                  <th className="num" style={{ textAlign: "right", width: 100 }}>Items</th>
                  <th className="num" style={{ textAlign: "right", width: 130 }}>Amount ₹</th>
                  <th style={{ width: 110 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {routeIndents.map((i: any, idx: number) => (
                  <tr key={i.id}>
                    <td className="num text-muted-foreground" style={{ textAlign: "center" }}>{idx + 1}</td>
                    <td className="font-mono text-[12.5px]">{i.code ?? i.id}</td>
                    <td>{i.dealerName}</td>
                    <td className="num" style={{ textAlign: "right" }}>{i.itemCount ?? 0}</td>
                    <td className="num font-medium" style={{ textAlign: "right" }}>{fmtINR(i.totalAmount ?? 0)}</td>
                    <td><StatusPill status={i.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </div>
    </div>
  );
}