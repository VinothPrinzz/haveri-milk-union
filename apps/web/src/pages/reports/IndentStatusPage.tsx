// ════════════════════════════════════════════════════════════════════
// Route Indent Status — /reports/indent-status
//
// For a date, every dealer assigned to each route and whether they have
// placed an indent. "Placed" follows the Route Sheet: an order for that
// delivery date that reached confirmed / dispatched / delivered. A dealer
// still sitting on a draft, a payment-pending or a cancelled order reads
// Not placed, with that state as the remark.
//
// The Placed / Not placed filter is applied here, not by the API, so each
// route's counts stay whole whatever the filter shows.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { fmtINR, fmtNum } from "@/components/PageHeader";
import { fetchRoutes } from "@/services/api";
import {
  fetchIndentStatus,
  type IndentStatusDealer,
  type IndentStatusResponse,
  type IndentStatusRoute,
} from "@/services/report";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";

type IndentFilter = "all" | "placed" | "not_placed";

const FILTER_OPTIONS: { value: IndentFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "placed", label: "Placed" },
  { value: "not_placed", label: "Not placed" },
];

// Remark for a Not placed dealer, by the state their order is stuck in.
const OPEN_STATUS_LABEL: Record<string, string> = {
  payment_required: "payment pending",
  draft: "draft not confirmed",
  cancelled: "cancelled",
};

const matchesFilter = (d: IndentStatusDealer, f: IndentFilter) =>
  f === "all" || (f === "placed" ? d.placed : !d.placed);

// A placed dealer who isn't on the route's roster placed here anyway (moved
// off it since, or a one-off); a Not placed one explains why.
function remarkFor(d: IndentStatusDealer): string {
  if (d.placed) return d.assigned ? "" : "not assigned";
  return d.openStatus ? OPEN_STATUS_LABEL[d.openStatus] : "";
}

// dd-mm-yyyy — the on-paper date format.
const fmtDMY = (iso: string) => {
  const [y, m, d] = (iso ?? "").split("-");
  return y && m && d ? `${d}-${m}-${y}` : (iso ?? "");
};

// "YYYY-MM-DD HH:MM" → just the time when it's the report date, else "dd-mm HH:MM".
function placedAtLabel(ts: string | null, reportDate: string): string {
  if (!ts) return "";
  const [day, time] = ts.split(" ");
  if (day === reportDate) return time;
  const [, m, d] = day.split("-");
  return `${d}-${m} ${time}`;
}

const routeLabel = (r: { name: string; code: string }) => `${r.name}${r.code ? ` (${r.code})` : ""}`;

export default function IndentStatusPage() {
  const today = todayIST();
  const [date, setDate] = useState(today);
  const [routeId, setRouteId] = useState<string | null>(null);
  const [filter, setFilter] = useState<IndentFilter>("all");
  const [generated, setGenerated] = useState(false);

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  // The Play Store demo route is never part of an operational report.
  const routeOptions: F9Option[] = useMemo(
    () => (routes as any[])
      .filter(r => r.code !== "DEMO")
      .map(r => ({ value: r.id, label: r.name, sublabel: r.code })),
    [routes],
  );
  const routeName = routeOptions.find(o => o.value === routeId)?.label ?? "All Routes";

  const { data, isLoading, refetch, dataUpdatedAt } = useQuery({
    queryKey: ["indent-status", date, routeId],
    queryFn: () => fetchIndentStatus({ date, routeId: routeId || undefined }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  // One page per route (plus a summary when there are several). A route
  // with no rows under the current filter is skipped on a multi-route run.
  const pages: ReactNode[] = [];
  const pageLabels: string[] = [];
  const shown: { route: IndentStatusRoute; rows: IndentStatusDealer[] }[] = [];
  if (data) {
    const multi = data.routes.length > 1;
    if (multi) {
      pages.push(<SummaryPage key="summary" data={data} />);
      pageLabels.push("Summary");
    }
    for (const route of data.routes) {
      const rows = route.dealers.filter(d => matchesFilter(d, filter));
      if (rows.length === 0 && multi) continue;
      shown.push({ route, rows });
      pages.push(<RoutePage key={route.id} route={route} rows={rows} date={data.date} filter={filter} />);
      pageLabels.push(route.name);
    }
  }

  // "As at" time, only meaningful for today's still-open picture.
  const asAt =
    data && data.date === today && dataUpdatedAt
      ? new Date(dataUpdatedAt).toLocaleTimeString("en-IN", {
          timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit", hour12: false,
        })
      : null;
  const filterLabel = FILTER_OPTIONS.find(o => o.value === filter)?.label ?? "All";

  const exporters: Exporter[] = data ? [{
    label: "CSV",
    filename: `indent-status_${data.date}${filter === "all" ? "" : `_${filter.replace("_", "-")}`}.csv`,
    mimeType: "text/csv",
    build: () => {
      const out: (string | number)[][] = [[
        "Route Code", "Route", "Sl", "Dealer Code", "Dealer", "Phone", "Indent", "Remarks",
        "Placed At", "Indents", "Qty (Pkts)", "Amount",
      ]];
      for (const { route, rows } of shown) {
        rows.forEach((d, i) => out.push([
          route.code, route.name, i + 1, d.code, d.name, d.phone,
          d.placed ? "Placed" : "Not placed",
          remarkFor(d),
          placedAtLabel(d.firstPlacedAt, data.date),
          d.placed ? d.indents : "",
          d.placed ? d.qty : "",
          d.placed ? d.amount : "",
        ]));
      }
      return toCsv(out);
    },
  }] : [];

  return (
    <ReportShell
      title="Route Indent Status"
      subtitle="Dealers assigned to each route: who has placed an indent for the day and who has not"
      printOrientation="portrait"
      filters={
        <>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Date</label>
            <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="erp-input w-40" />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Route</label>
            <F9SearchSelect
              value={routeId}
              onChange={v => setRouteId(v)}
              options={routeOptions}
              allowAll
              allLabel="All Routes"
              placeholder="All Routes (F9)"
              modalTitle="Select Route"
              className="w-52"
            />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Indent</label>
            <Select value={filter} onValueChange={v => setFilter(v as IndentFilter)}>
              <SelectTrigger className="erp-input w-36"><SelectValue /></SelectTrigger>
              <SelectContent>
                {FILTER_OPTIONS.map(o => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
        </>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Route Indent Status"
          rows={[
            { label: "Date", value: fmtDMY(data?.date ?? date) },
            { label: "Route", value: routeName },
            { label: "Indent", value: filterLabel },
            ...(asAt ? [{ label: "As at", value: `${asAt} IST` }] : []),
          ]}
        />
      }
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel: i => pageLabels[i] ?? "",
        emptyMessage: data
          ? routeId
            ? "No dealers are assigned to this route"
            : "No dealers are assigned to any route"
          : "Filters changed: click Generate to load the report",
      }}
    />
  );
}

// ─── Summary: one line per route ─────────────────────────────────────
function SummaryPage({ data }: { data: IndentStatusResponse }) {
  const t = data.totals;
  return (
    <div>
      <div className="col-paged-strip"><span>Summary by Route</span></div>
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr>
            <th className="num w-10">Sl</th>
            <th>Route</th>
            <th className="num">Assigned</th>
            <th className="num">Placed</th>
            <th className="num">Not Placed</th>
            <th className="num">Indents</th>
            <th className="num">Qty (Pkts)</th>
            <th className="num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {data.routes.map((r, i) => (
            <tr key={r.id}>
              <td className="num">{i + 1}</td>
              <td>{routeLabel(r)}</td>
              <td className="num">{fmtNum(r.counts.assigned)}</td>
              <td className="num">{fmtNum(r.counts.placed)}</td>
              <td className="num">{fmtNum(r.counts.notPlaced)}</td>
              <td className="num">{fmtNum(r.counts.indents)}</td>
              <td className="num">{fmtNum(r.counts.qty)}</td>
              <td className="num">{fmtINR(r.counts.amount)}</td>
            </tr>
          ))}
          <tr className="font-bold">
            <td colSpan={2} className="text-right">TOTAL</td>
            <td className="num">{fmtNum(t.assigned)}</td>
            <td className="num">{fmtNum(t.placed)}</td>
            <td className="num">{fmtNum(t.notPlaced)}</td>
            <td className="num">{fmtNum(t.indents)}</td>
            <td className="num">{fmtNum(t.qty)}</td>
            <td className="num">{fmtINR(t.amount)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── One route: its dealers under the current filter ─────────────────
function RoutePage({
  route, rows, date, filter,
}: {
  route: IndentStatusRoute;
  rows: IndentStatusDealer[];
  date: string;
  filter: IndentFilter;
}) {
  const c = route.counts;
  // Placed-order columns are meaningless on a Not placed list.
  const showOrderCols = filter !== "not_placed";
  const colCount = showOrderCols ? 9 : 5;
  const indents = rows.reduce((s, d) => s + d.indents, 0);
  const qty = rows.reduce((s, d) => s + d.qty, 0);
  const amount = rows.reduce((s, d) => s + d.amount, 0);
  const emptyText =
    filter === "not_placed"
      ? "Every assigned dealer on this route has placed an indent."
      : filter === "placed"
      ? "No dealer on this route has placed an indent."
      : "No dealers are assigned to this route.";

  return (
    <div>
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr>
            <th colSpan={colCount}>
              <span className="mr-4">{routeLabel(route)}</span>
              <span className="mr-4">Assigned: {fmtNum(c.assigned)}</span>
              <span className="mr-4">Placed: {fmtNum(c.placed)}</span>
              <span>Not placed: {fmtNum(c.notPlaced)}</span>
            </th>
          </tr>
          <tr>
            <th className="num w-10">Sl</th>
            <th>Code</th>
            <th>Dealer</th>
            <th>Phone</th>
            <th>Indent</th>
            {showOrderCols && (
              <>
                <th>Placed At</th>
                <th className="num">Indents</th>
                <th className="num">Qty (Pkts)</th>
                <th className="num">Amount</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr><td colSpan={colCount} className="text-center">{emptyText}</td></tr>
          ) : rows.map((d, i) => {
            const remark = remarkFor(d);
            return (
              <tr key={d.dealerId}>
                <td className="num">{i + 1}</td>
                <td className="font-mono">{d.code}</td>
                <td>{d.name}</td>
                <td className="font-mono">{d.phone}</td>
                <td>
                  <span className={d.placed ? "" : "font-bold"}>{d.placed ? "Placed" : "Not placed"}</span>
                  {remark && <span className="text-[10px]"> ({remark})</span>}
                </td>
                {showOrderCols && (
                  <>
                    <td>{placedAtLabel(d.firstPlacedAt, date)}</td>
                    <td className="num">{d.placed ? fmtNum(d.indents) : ""}</td>
                    <td className="num">{d.placed ? fmtNum(d.qty) : ""}</td>
                    <td className="num">{d.placed ? fmtINR(d.amount) : ""}</td>
                  </>
                )}
              </tr>
            );
          })}
          {rows.length > 0 && showOrderCols && (
            <tr className="font-bold">
              <td colSpan={6} className="text-right">TOTAL</td>
              <td className="num">{fmtNum(indents)}</td>
              <td className="num">{fmtNum(qty)}</td>
              <td className="num">{fmtINR(amount)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
