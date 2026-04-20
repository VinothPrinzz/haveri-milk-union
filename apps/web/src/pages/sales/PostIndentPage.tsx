// apps/web/src/pages/sales/PostIndentPage.tsx
// ════════════════════════════════════════════════════════════════════
// Post Indent — Marketing v1.4
//
// Changes vs v1.3:
//   • Route selector → F9SearchSelect (required)
//   • Batch selector → F9SearchSelect with "All" option (default = All)
//   • Table is now gated behind explicit "Load Pending Indents" button
//     (not on first route+batch selection — staff often adjust filters
//     before committing to the query)
// ════════════════════════════════════════════════════════════════════

import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle, Download } from "lucide-react";
import { fetchIndents, fetchRoutes, fetchBatches } from "@/services/api";
import { post } from "@/lib/apiClient";

export default function PostIndentPage() {
  const qc = useQueryClient();

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  const [selectedRoute, setSelectedRoute] = useState<string | null>(null);
  const [selectedBatch, setSelectedBatch] = useState<string | null>(null); // null = All
  const [selectedDate, setSelectedDate] = useState(
    new Date().toISOString().split("T")[0]
  );
  const [loaded, setLoaded] = useState(false);

  const routeOptions: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );
  const batchOptions: F9Option[] = useMemo(
    () =>
      batches.map((b: any) => ({
        value: b.id,
        label: b.whichBatch || b.batchCode,
        sublabel: b.timing,
      })),
    [batches]
  );

  // Fetch is gated by `loaded` flag — user must click the button
  const { data: pending = [], isLoading, refetch } = useQuery({
    queryKey: ["indents", "pending", selectedDate, selectedRoute, selectedBatch],
    queryFn: () =>
      fetchIndents({
        status: "pending",
        date: selectedDate,
        routeId: selectedRoute ?? undefined,
        batchId: selectedBatch ?? undefined,
      }),
    enabled: false,
  });

  const handleLoad = async () => {
    if (!selectedRoute) {
      toast.error("Please select a route");
      return;
    }
    await refetch();
    setLoaded(true);
  };

  const handlePost = async () => {
    try {
      await post("/route-sheets/generate", {
        routeId: selectedRoute,
        batchId: selectedBatch,
        date: selectedDate,
      });
      toast.success(`${pending.length} indent(s) posted successfully`);
      qc.invalidateQueries({ queryKey: ["indents"] });
      setLoaded(false);
    } catch (err: any) {
      toast.error(err?.message || "Failed to post indents");
    }
  };

  const routeName = routes.find((r: any) => r.id === selectedRoute)?.name;
  const batchName = selectedBatch
    ? batches.find((b: any) => b.id === selectedBatch)?.whichBatch
    : "All batches";

  return (
    <PageShell
      header={
        <>
          <PageHeader
            title="Post Indent"
            description="Review and post pending indents for dispatch"
          />
          <FilterBar>
            <div>
              <label className="text-sm font-medium mb-1.5 block">Date</label>
              <input
                type="date"
                value={selectedDate}
                onChange={e => {
                  setSelectedDate(e.target.value);
                  setLoaded(false);
                }}
                className="h-9 rounded-md border border-input bg-background px-3 py-1 text-sm"
              />
            </div>

            <F9SearchSelect
              label="Route"
              value={selectedRoute}
              onChange={v => {
                setSelectedRoute(v);
                setLoaded(false);
              }}
              options={routeOptions}
              className="w-60"
            />

            <F9SearchSelect
              label="Batch"
              value={selectedBatch}
              onChange={v => {
                setSelectedBatch(v);
                setLoaded(false);
              }}
              options={batchOptions}
              allowAll
              className="w-48"
            />

            <Button onClick={handleLoad} disabled={isLoading}>
              <Download className="h-4 w-4 mr-2" />
              {isLoading ? "Loading..." : "Load Pending Indents"}
            </Button>

            {loaded && pending.length > 0 && (
              <Button variant="default" onClick={handlePost} className="ml-auto">
                <CheckCircle className="h-4 w-4 mr-2" />
                Post {pending.length} Indent(s)
              </Button>
            )}
          </FilterBar>
        </>
      }
    >
      {!loaded ? (
        <EmptyHint message="Select date + route (+ optional batch), then click Load Pending Indents." />
      ) : (
        <ScrollableTableBody>
          <div className="p-4 border-b">
            <h3 className="font-medium text-sm">
              Pending Indents — {routeName} / {batchName}
              <span className="text-muted-foreground ml-2">({pending.length})</span>
            </h3>
          </div>
          <table className="w-full text-sm">
            <thead className="sticky top-0 z-10 bg-muted/50 backdrop-blur border-b">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left py-2.5 px-3 font-medium">Indent No.</th>
                <th className="text-left py-2.5 px-3 font-medium">Customer</th>
                <th className="text-left py-2.5 px-3 font-medium">Items</th>
                <th className="text-right py-2.5 px-3 font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {pending.map((i: any) => (
                <tr key={i.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 px-3 font-mono text-xs">{i.indentNo}</td>
                  <td className="py-2 px-3 font-medium">{i.customerName}</td>
                  <td className="py-2 px-3 text-muted-foreground text-xs">
                    {i.items.map((x: any) => `${x.productName}×${x.qty}`).join(", ")}
                  </td>
                  <td className="py-2 px-3 text-right font-mono">
                    ₹{(i.total ?? 0).toLocaleString()}
                  </td>
                </tr>
              ))}
              {pending.length === 0 && (
                <tr>
                  <td colSpan={4} className="py-10 text-center text-muted-foreground text-sm">
                    No pending indents for this filter combination.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </ScrollableTableBody>
      )}
    </PageShell>
  );
}

function EmptyHint({ message }: { message: string }) {
  return (
    <div className="h-full flex items-center justify-center">
      <Card className="max-w-md">
        <CardContent className="p-8 text-center">
          <p className="text-sm text-muted-foreground">{message}</p>
        </CardContent>
      </Card>
    </div>
  );
}