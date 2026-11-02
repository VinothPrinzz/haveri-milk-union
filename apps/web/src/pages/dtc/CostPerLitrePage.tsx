// apps/web/src/pages/dtc/CostPerLitrePage.tsx
// DTC Billing → Cost per Litre  (/dtc/reports/cost-per-litre)
// Transport cost per litre/kg of milk and products carried, route by route
// and month by month, from the prepared bills. The highest routes stand out.
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";
import { fetchCostPerLitre, type CostPerLitreReport } from "@/services/dtc";
import { BILLING_TYPE_LABEL, FilterLabel, MonthInput, addMonths, errMsg, monthLabel, prevMonth, qtyFmt, rs, rs2 } from "./shared";

const th = "border border-border py-1 px-1.5 font-bold";
const td = "border border-border py-0.5 px-1.5";

export default function CostPerLitrePage() {
  const last = prevMonth(todayIST());
  const [from, setFrom] = useState(addMonths(last, -5));
  const [to, setTo] = useState(last);
  const [generated, setGenerated] = useState(false);
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["dtc-cpl", from, to], queryFn: () => fetchCostPerLitre({ from, to }), enabled: false,
  });
  const report = data && data.from === from && data.to === to ? data : undefined;

  const onGenerate = async () => {
    if (from > to) { toast.error("'From' must be on or before 'To'"); return; }
    const r = await refetch();
    if (r.error) toast.error(errMsg(r.error));
    setGenerated(true);
  };

  const pages: ReactNode[] = report && report.routes.length ? [<Table key="t" report={report} />] : [];
  const exporters: Exporter[] = report ? [{
    label: "CSV", filename: `dtc-cost-per-litre_${from}_${to}.csv`, mimeType: "text/csv",
    build: () => toCsv([
      ["Route", "Contractor", "Type", ...report.months.map(m => `${monthLabel(m)} cost/L`), "Qty L/Kg", "Amount", "Cost/L"],
      ...report.routes.map(r => [
        r.routeName, r.contractorName ?? "", BILLING_TYPE_LABEL[r.billingType],
        ...report.months.map(m => r.months[m]?.costPerLitre ?? ""), r.qty, r.amount, r.costPerLitre,
      ]),
      ["All routes", "", "", ...report.months.map(m => report.monthTotals[m]?.costPerLitre ?? ""), report.totals.qty, report.totals.amount, report.totals.costPerLitre],
    ]),
  }] : [];

  return (
    <ReportShell
      title="Transport Cost per Litre"
      subtitle="DTC cost per litre/kg of milk and products carried, by route and month"
      printOrientation="landscape"
      filters={
        <>
          <div><FilterLabel>From month</FilterLabel><MonthInput value={from} onChange={v => { setFrom(v); setGenerated(false); }} className="w-40" /></div>
          <div><FilterLabel>To month</FilterLabel><MonthInput value={to} onChange={v => { setTo(v); setGenerated(false); }} className="w-40" /></div>
        </>
      }
      onGenerate={onGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Transport Cost per Litre"
          rows={[
            { label: "Period", value: `${monthLabel(from)} to ${monthLabel(to)}` },
            ...(report ? [{ label: "Basis", value: report.basis === "gross" ? "Gross payable ÷ litres" : "Total earnings ÷ litres" }] : []),
          ]}
        />
      }
      state={{ generated, loading: isFetching && !report, pages, emptyMessage: "No bills prepared in this period" }}
    />
  );
}

function Table({ report }: { report: CostPerLitreReport }) {
  // Flag the routes in the top fifth by cost per litre.
  const sorted = report.routes.map(r => r.costPerLitre).filter(x => x > 0).sort((a, b) => b - a);
  const high = sorted.length >= 5 ? sorted[Math.floor(sorted.length / 5) - 1] ?? Infinity : Infinity;
  return (
    <div>
      <table className="w-full text-[10.5px] border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className={`${th} text-left`}>Route</th>
            <th className={`${th} text-left`}>Contractor</th>
            <th className={th}>Type</th>
            {report.months.map(m => (
              <th key={m} className={`${th} text-right`}>{monthLabel(m)}{report.monthStatus[m] !== "approved" ? "*" : ""}</th>
            ))}
            <th className={`${th} text-right`}>Qty L/Kg</th>
            <th className={`${th} text-right`}>Amount</th>
            <th className={`${th} text-right`}>Cost / L</th>
          </tr>
        </thead>
        <tbody>
          {report.routes.map(r => (
            <tr key={r.routeId} className={r.costPerLitre >= high ? "bg-warning/10" : ""}>
              <td className={td}><span className="font-mono text-[9.5px] text-muted-foreground mr-1">{r.routeCode}</span>{r.routeName}</td>
              <td className={td}>{r.contractorName ?? ""}</td>
              <td className={`${td} text-center`}>{BILLING_TYPE_LABEL[r.billingType]}</td>
              {report.months.map(m => (
                <td key={m} className={`${td} text-right num`}>{r.months[m] ? rs2(r.months[m]!.costPerLitre) : ""}</td>
              ))}
              <td className={`${td} text-right num`}>{qtyFmt(r.qty)}</td>
              <td className={`${td} text-right num`}>{rs(r.amount)}</td>
              <td className={`${td} text-right num font-semibold`}>{rs2(r.costPerLitre)}</td>
            </tr>
          ))}
          <tr className="font-bold bg-muted/30">
            <td className={td} colSpan={3}>All routes</td>
            {report.months.map(m => (
              <td key={m} className={`${td} text-right num`}>{rs2(report.monthTotals[m]?.costPerLitre ?? 0)}</td>
            ))}
            <td className={`${td} text-right num`}>{qtyFmt(report.totals.qty)}</td>
            <td className={`${td} text-right num`}>{rs(report.totals.amount)}</td>
            <td className={`${td} text-right num`}>{rs2(report.totals.costPerLitre)}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-[9.5px] text-muted-foreground mt-1">
        Shaded: the most expensive fifth of routes per litre. * Month not yet approved: figures may still change.
      </p>
    </div>
  );
}
