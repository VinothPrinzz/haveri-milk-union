// ════════════════════════════════════════════════════════════════════
// Post Indents — bulk select pending indents and post (confirm) them
// Route preserved: /sales/post-indent
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  FilterBar, Field, EmptyState, StatusPill, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Checkbox } from "@/components/ui/checkbox";
import { Send, X } from "lucide-react";
import { fetchIndents, postIndents, fetchRoutes } from "@/services/api";

export default function PostIndentPage() {
  const qc = useQueryClient();
  const today = new Date().toISOString().slice(0, 10);

  const [date, setDate] = useState(today);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });

  const { data: indents = [], isLoading } = useQuery({
    queryKey: ["indents", { status: "pending", date, routeId }],
    queryFn: () => fetchIndents({ status: "pending", date, routeId: routeId ?? undefined }),
  });

  const routeOpts: F9Option[] = useMemo(
    () => routes.map((r: any) => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes]
  );

  const totalSelected = useMemo(() => {
    return indents
      .filter((i: any) => selected.has(i.id))
      .reduce((s: number, i: any) => s + (i.total ?? 0), 0);
  }, [indents, selected]);

  const toggleAll = () => {
    setSelected(prev => prev.size === indents.length
      ? new Set()
      : new Set(indents.map((i: any) => i.id))
    );
  };

  const toggleOne = (id: string) => {
    setSelected(prev => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  };

  const post = useMutation({
    mutationFn: (ids: string[]) => postIndents(ids),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["indents"] });
      qc.invalidateQueries({ queryKey: ["dashboard-summary"] });
      toast.success(`${selected.size} indent(s) posted`);
      setSelected(new Set());
    },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  return (
    <div className="flex flex-col h-full">
      <PageHeader 
        title="Post Indents" 
        subtitle="Confirm pending indents to dispatch them" 
      />

      <FilterBar>
        <Field label="Date">
          <input type="date" className="erp-input w-40" value={date} onChange={e => setDate(e.target.value)} />
        </Field>
        <Field label="Route">
          <F9SearchSelect value={routeId} onChange={setRouteId} options={routeOpts} allowAll className="w-64" />
        </Field>
        {(routeId || date !== today) && (
          <div className="flex items-end">
            <Button size="sm" variant="outline" className="h-8" onClick={() => { setDate(today); setRouteId(null); }}>
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          </div>
        )}
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : indents.length === 0 ? (
            <EmptyState title="No pending indents for this filter." hint="Try a different date or route." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>
                    <Checkbox checked={selected.size === indents.length && indents.length > 0} onCheckedChange={toggleAll} />
                  </th>
                  <th style={{ width: 110 }}>Indent #</th>
                  <th style={{ width: 110 }}>Date</th>
                  <th>Customer</th>
                  <th>Route</th>
                  <th className="num" style={{ width: 90, textAlign: "right" }}>Lines</th>
                  <th className="num" style={{ width: 130, textAlign: "right" }}>Total ₹</th>
                  <th style={{ width: 100 }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {indents.map((i: any) => (
                  <tr key={i.id} className={selected.has(i.id) ? "bg-accent/50" : ""}>
                    <td><Checkbox checked={selected.has(i.id)} onCheckedChange={() => toggleOne(i.id)} /></td>
                    <td className="font-mono">{i.code ?? i.id.slice(0, 8)}</td>
                    <td className="text-[12.5px]">{fmtDate(i.date)}</td>
                    <td className="font-medium">{i.customerName ?? i.customerId}</td>
                    <td>{i.routeName ?? i.routeId}</td>
                    <td className="num" style={{ textAlign: "right" }}>{i.lines?.length ?? i.lineCount ?? 0}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(i.total ?? 0)}</td>
                    <td><StatusPill status={i.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {selected.size > 0 && (
        <div className="border-t border-border bg-panel px-4 py-2 flex items-center gap-3">
          <span className="text-[13px] text-muted-foreground">
            {selected.size} selected · Total <span className="font-semibold tabular-nums text-foreground">{fmtINR(totalSelected)}</span>
          </span>
          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" variant="outline" className="h-8" onClick={() => setSelected(new Set())}>Clear</Button>
            <Button size="sm" className="h-8" onClick={() => post.mutate([...selected])} disabled={post.isPending}>
              <Send className="h-3.5 w-3.5 mr-1" />
              {post.isPending ? "Posting…" : `Post ${selected.size} Indent(s)`}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}