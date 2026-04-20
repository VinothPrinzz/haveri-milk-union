import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fetchDispatchAssignments } from "@/services/api";
import { Send } from "lucide-react";
import { toast } from "sonner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { patch } from "@/lib/apiClient";

export default function DispatchSheetPage() {
  const today = new Date().toISOString().split("T")[0];

  const [selectedDate, setSelectedDate] = useState(today);

  const { data: assignments = [], isLoading } = useQuery({
    queryKey: ["dispatch-assignments", selectedDate],
    queryFn: () => fetchDispatchAssignments(selectedDate),
  });

  const qc = useQueryClient();

  const dispatchMutation = useMutation({
    mutationFn: (assignmentId: string) =>
      patch(`/dispatch/assignments/${assignmentId}`, { status: "dispatched" }),
    onSuccess: (_, assignmentId) => {
      toast.success("Route marked as dispatched");
      qc.invalidateQueries({ queryKey: ["dispatch-assignments"] });
    },
    onError: (err: any) => toast.error(err.message || "Failed to mark as dispatched"),
  });

  return (
    <div>
      <PageHeader 
        title="Dispatch Sheet" 
        description={`Daily dispatch overview — ${selectedDate}`} 
      />

      <Card className="mb-4">
        <CardContent className="p-5 flex items-end gap-4">
          <div>
            <label className="text-sm font-medium mb-1.5 block">Date</label>
            <input 
              type="date" 
              value={selectedDate} 
              onChange={e => setSelectedDate(e.target.value)}
              className="h-9 w-40 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring" 
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Dispatch Overview</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {isLoading ? (
            <div className="p-8 text-center text-muted-foreground">Loading dispatch data...</div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-muted/30 text-xs text-muted-foreground">
                  <th className="text-left py-2.5 px-3 font-medium">Route Name</th>
                  <th className="text-right py-2.5 px-3 font-medium">Indents</th>
                  <th className="text-right py-2.5 px-3 font-medium">Crates</th>
                  <th className="text-right py-2.5 px-3 font-medium">Amount</th>
                  <th className="text-left py-2.5 px-3 font-medium">Timing</th>
                  <th className="text-left py-2.5 px-3 font-medium">Status</th>
                  <th className="text-left py-2.5 px-3 font-medium">Action</th>
                </tr>
              </thead>
              <tbody>
                {assignments.map((row: any, index: number) => {
                  // Create a truly unique key: routeId + status + index as fallback
                  const uniqueKey = `${row.routeId || row.id || 'unknown'}-${row.status || 'unknown'}-${index}`;
                  
                  return (
                    <tr 
                      key={uniqueKey} 
                      className="border-b last:border-0 hover:bg-muted/30"
                    >
                      <td className="py-2.5 px-3 font-medium">{row.routeName}</td>
                      <td className="py-2.5 px-3 text-right font-mono">
                        {row.totalIndents || row.indentCount || 0}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono">
                        {row.totalCrates || Math.ceil((row.totalQty || 0) / 24)}
                      </td>
                      <td className="py-2.5 px-3 text-right font-mono">
                        ₹{(row.totalAmount || 0).toLocaleString()}
                      </td>
                      <td className="py-2.5 px-3">{row.dispatchTime || "—"}</td>
                      <td className="py-2.5 px-3">
                        <span className={`text-xs px-2 py-0.5 rounded font-medium 
                          ${row.status === "Dispatched" || row.status?.toLowerCase() === "delivered" 
                            ? "bg-success/10 text-success" 
                            : row.status === "Scheduled" || row.status?.toLowerCase() === "scheduled"
                            ? "bg-blue-100 text-blue-700" 
                            : "bg-warning/10 text-warning"}`}>
                          {row.status || "Pending"}
                        </span>
                      </td>
                      <td className="py-2.5 px-3">
                        {(() => {
                          const s = String(row.status ?? "").toLowerCase();
                          const hasIndents = (row.totalIndents ?? 0) > 0;

                          // dispatched or delivered → nothing more to do
                          if (s === "dispatched" || s === "delivered") {
                            return <span className="text-xs text-muted-foreground">Done</span>;
                          }
                          // pending / loading / scheduled with indents → show the dispatch button
                          if (hasIndents) {
                            return (
                              <Button
                                size="sm"
                                className="h-7"
                                disabled={dispatchMutation.isPending}
                                onClick={() => dispatchMutation.mutate(row.id)}
                              >
                                <Send className="h-3.5 w-3.5 mr-1" />
                                {dispatchMutation.isPending ? "…" : "Dispatch"}
                              </Button>
                            );
                          }
                          // no indents yet
                          return <span className="text-xs text-muted-foreground">No indents</span>;
                        })()}
                      </td>
                    </tr>
                  );
                })}

                {assignments.length === 0 && (
                  <tr>
                    <td colSpan={7} className="py-12 text-center text-muted-foreground">
                      No dispatch assignments found for this date
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}