// apps/web/src/pages/reports/RouteSheetPage.tsx
// ════════════════════════════════════════════════════════════════════
// Route Sheet — ledger-style layout, adaptive canvas, CSV export.
// (No Tally export — this is operational, not accounting.)
// ════════════════════════════════════════════════════════════════════
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { fmtNum, fmtINR, fmtDate } from "@/components/PageHeader";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { fetchBatches } from "@/services/api";
import { fetchRouteSheet, type RouteSheetResponse } from "@/services/report";
import { toCsv } from "@/lib/exporters";

export default function RouteSheetPage() {
  const today = new Date().toISOString().split("T")[0];
  const [batch, setBatch] = useState<string>("");
  const [date, setDate] = useState<string>(today);
  const [generated, setGenerated] = useState(false);

  const { data: batches = [] } = useQuery({ queryKey: ["batches"], queryFn: fetchBatches });

  const { data, isLoading, refetch } = useQuery<RouteSheetResponse>({
    queryKey: ["route-sheet", date, batch],
    queryFn: () => fetchRouteSheet({ date, batchId: batch || undefined }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  // Filter to customers with at least one item; renumber.
  const routesWithData = (data?.routes ?? [])
    .map(r => {
      const active = r.customers.filter(c =>
        Object.values(c.acrossQty).some(q => q > 0) || c.othersQty > 0
      );
      return { ...r, customers: active.map((c, i) => ({ ...c, sl: i + 1 })) };
    })
    .filter(r => r.customers.length > 0);

  // Only product columns actually used.
  const usedIds = new Set<string>();
  routesWithData.forEach(r => r.customers.forEach(c => {
    Object.entries(c.acrossQty).forEach(([pid, q]) => { if (q > 0) usedIds.add(pid); });
  }));
  const acrossProducts = (data?.acrossProducts ?? []).filter(p => usedIds.has(p.id));

  const pages = routesWithData.map(route => (
    <RoutePage key={route.id} data={data!} acrossProducts={acrossProducts} route={route} />
  ));

  // ── CSV export (one combined file, one row per customer + Route col)
  const exporters: Exporter[] = data ? [{
    label: "CSV",
    filename: `route-sheet_${data.date}.csv`,
    mimeType: "text/csv",
    build: () => {
      const header = [
        "Route Code", "Route", "Sl", "Customer Code", "Customer",
        ...acrossProducts.map(p => p.reportAlias),
        "Others", "Net Amount", "Crates",
      ];
      const rows: (string | number)[][] = [header];
      for (const r of routesWithData) {
        for (const c of r.customers) {
          rows.push([
            r.code, r.name, c.sl, c.code, c.name,
            ...acrossProducts.map(p => c.acrossQty[p.id] ?? 0),
            c.othersText, c.netAmount, c.crates,
          ]);
        }
        // Route total row
        rows.push([
          r.code, `${r.name} TOTAL`, "", "", "",
          ...acrossProducts.map(p => r.totals.acrossQty[p.id] ?? 0),
          r.totals.othersQty, r.totals.netAmount, r.totals.crates,
        ]);
      }
      return toCsv(rows);
    },
  }] : [];

  return (
    <ReportShell
      title="Route Sheet"
      subtitle="Per-route loading sheets — one page per active route"
      printOrientation="landscape"
      filters={
        <>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Date</label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="erp-input w-40" />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Batch</label>
            <Select value={batch || "all"} onValueChange={v => setBatch(v === "all" ? "" : v)}>
              <SelectTrigger className="erp-input w-44"><SelectValue placeholder="All batches" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All batches</SelectItem>
                {(batches as any[]).map((b: any) => (
                  <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Route Sheet"
          rows={[
            { label: "Date", value: data ? fmtDate(data.date) : "—" },
            { label: "Batch", value: data?.batch?.name ?? "All" },
          ]}
        />
      }
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel: idx => routesWithData[idx]?.name ?? "",
        emptyMessage: "No customer indents for any route on this date",
      }}
    />
  );
}

function RoutePage({
  data, acrossProducts, route,
}: {
  data: RouteSheetResponse;
  acrossProducts: RouteSheetResponse["acrossProducts"];
  route: RouteSheetResponse["routes"][number];
}) {
  return (
    <div>
      {/* Per-route header strip — visible on screen and print */}
      <div className="text-[11px] mb-2 flex flex-wrap justify-between gap-x-4 gap-y-0.5">
        <span><strong>Route:</strong> {route.name} ({route.code})</span>
        <span><strong>Date:</strong> {fmtDate(data.date)}</span>
        <span><strong>Contractor:</strong> {route.contractor.name ?? "—"}</span>
        <span><strong>Vehicle:</strong> {route.contractor.vehicleNumber ?? "—"}</span>
        <span><strong>Dispatch:</strong> {route.dispatchTime ?? "—"}</span>
        <span><strong>Batch:</strong> {data.batch?.name ?? "—"}</span>
      </div>

      <table className="report-ledger compact">
        <thead>
          <tr>
            <th style={{ width: 28 }}>Sl</th>
            <th style={{ width: 56 }}>Code</th>
            <th>Customer</th>
            {acrossProducts.map(p => (
              <th key={p.id} className="vert-text" title={p.reportAlias}>
                <VerticalText text={p.reportAlias} />
              </th>
            ))}
            <th>Others</th>
            <th className="num">Net ₹</th>
            <th className="num">Crates</th>
          </tr>
        </thead>
        <tbody>
          {route.customers.map(c => (
            <tr key={c.id}>
              <td className="num">{c.sl}</td>
              <td className="font-mono">{c.code}</td>
              <td>{c.name}</td>
              {acrossProducts.map(p => (
                <td key={p.id} className="center num">
                  {c.acrossQty[p.id] ? c.acrossQty[p.id] : ""}
                </td>
              ))}
              <td className="others-cell">
                {(c.othersText ?? "").split(",").map(s => s.trim()).filter(Boolean).join("\n")}
              </td>
              <td className="num">{fmtINR(c.netAmount)}</td>
              <td className="num">{fmtNum(c.crates)}</td>
            </tr>
          ))}

          <tr className="total-row">
            <td colSpan={3} className="num">TOTAL</td>
            {acrossProducts.map(p => (
              <td key={p.id} className="center num">
                {fmtNum(route.totals.acrossQty[p.id] ?? 0)}
              </td>
            ))}
            <td className="num">{fmtNum(route.totals.othersQty)}</td>
            <td className="num">{fmtINR(route.totals.netAmount)}</td>
            <td className="num">{fmtNum(route.totals.crates)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function VerticalText({ text }: { text: string }) {
  return (
    <span aria-label={text}>
      {Array.from(text).map((ch, i) => (
        <span key={i} className="vert-letter">{ch}</span>
      ))}
    </span>
  );
}