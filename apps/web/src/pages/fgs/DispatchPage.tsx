import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchIndents, fetchRoutes } from "@/services/api";
import { Download } from "lucide-react";
import { toast } from "sonner";

export default function DispatchPage() {
  const { data: indents = [] } = useQuery({
    queryKey: ["indents"],
    queryFn: () => fetchIndents(),
  });
  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });

  const posted = indents.filter(i => i.status === "Posted" || i.status === "Dispatched");
  const byRoute = routes.map(r => ({ route: r, indents: posted.filter(i => i.routeId === r.id) })).filter(x => x.indents.length > 0);

  return (
    <div>
      <PageHeader title="FGS Dispatch" description="View and manage dispatch for today">
        <Button variant="outline" size="sm" onClick={() => toast.info("CSV export triggered")}><Download className="h-4 w-4 mr-2" />Export CSV</Button>
      </PageHeader>
      <div className="space-y-4">
        {byRoute.map(({ route, indents: routeIndents }) => (
          <Card key={route.id}>
            <CardContent className="p-5">
              <div className="flex items-center justify-between mb-3">
                <div>
                  <h3 className="font-semibold">{route.name}</h3>
                  <p className="text-xs text-muted-foreground">Dispatch: {route.dispatchTime} · {routeIndents.length} orders</p>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded font-medium ${route.status === "Active" ? "bg-green-100 text-green-700" : "bg-secondary"}`}>{route.status}</span>
              </div>
              <table className="w-full text-sm">
                <thead><tr className="border-b text-muted-foreground text-xs"><th className="text-left py-1.5 px-2 font-medium">Customer</th><th className="text-left py-1.5 px-2 font-medium">Items</th><th className="text-right py-1.5 px-2 font-medium">Total</th></tr></thead>
                <tbody>
                  {routeIndents.map(i => (
                    <tr key={i.id} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="py-1.5 px-2 font-medium">{i.customerName}</td>
                      <td className="py-1.5 px-2 text-muted-foreground text-xs">{i.items.map(x => `${x.productName}×${x.qty}`).join(", ")}</td>
                      <td className="py-1.5 px-2 text-right font-mono">₹{i.total.toLocaleString()}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        ))}
        {byRoute.length === 0 && (
          <Card><CardContent className="p-12 text-center text-muted-foreground">No dispatch data for today</CardContent></Card>
        )}
      </div>
    </div>
  );
}
