// apps/web/src/pages/sales-reports/MonthlySalesReport.tsx
// ════════════════════════════════════════════════════════════════════
// Monthly Sales Report — "MILK & CURD SALES REPORT"
//
// Same route × product cross-tab as the Daily Sales Report (Night /
// Afternoon groups, per-group sub-totals and a grand "HVR TOTAL"), but the
// figures are summed across a whole calendar month and the two comparison
// columns hold the selected month vs the previous month.
//
// The cross-tab itself (layout, totals, CSV + Excel export) lives in
// ./milkCurdSalesShared and is shared with the Daily Sales Report — this
// file only wires up the month picker and the month-vs-previous-month headers.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import {
  fetchMonthlySalesReport,
  type MonthlySalesReportResponse,
} from "@/services/report";
import {
  buildMilkCurdPages,
  buildMilkCurdCsv,
  buildMilkCurdXlsx,
} from "./milkCurdSalesShared";

// "YYYY-MM" → "MMM-YYYY" (e.g. "2026-06" → "JUN-2026"), the comparison-column
// header label. Parsed as UTC midday so the month never drifts across zones.
const fmtMonth = (ym: string) => {
  if (!ym) return "";
  const d = new Date(`${ym}-01T12:00:00Z`);
  return d
    .toLocaleDateString("en-GB", { month: "short", year: "numeric", timeZone: "UTC" })
    .replace(" ", "-")
    .toUpperCase();
};

export default function MonthlySalesReport() {
  const thisMonth = new Date().toISOString().slice(0, 7); // "YYYY-MM"
  const [month, setMonth] = useState(thisMonth);
  const [generated, setGenerated] = useState(false);

  const { data, isLoading, refetch } = useQuery<MonthlySalesReportResponse>({
    queryKey: ["monthly-sales-report", month],
    queryFn: () => fetchMonthlySalesReport({ month }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  // ── Two pages: Milk items, then Curd items ──
  const pages: ReactNode[] = useMemo(
    () => (data ? buildMilkCurdPages(data, fmtMonth(data.prevMonth), fmtMonth(data.month)) : []),
    [data],
  );

  // ── Exporters ──
  const exporters: Exporter[] = useMemo(() => {
    if (!data) return [];
    const prevHeader = fmtMonth(data.prevMonth);
    const curHeader = fmtMonth(data.month);
    return [
      {
        label: "CSV",
        filename: `monthly-sales-report_${data.month}.csv`,
        mimeType: "text/csv",
        build: () =>
          buildMilkCurdCsv(data, {
            title: `Milk & Curd Sales Report — ${curHeader}`,
            prevHeader,
            curHeader,
          }),
      },
      {
        label: "Excel",
        filename: `monthly-sales-report_${data.month}.xlsx`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        build: () =>
          buildMilkCurdXlsx(data, {
            sheetName: "Monthly Sales Report",
            title: `HAVERI DISTRICT CO-OP MILK PRODUCERS UNION LTD., HAVERI  —  MILK & CURD SALES REPORT  ${curHeader}`,
            prevHeader,
            curHeader,
          }),
      },
    ];
  }, [data]);

  return (
    <ReportShell
      title="Monthly Sales Report"
      subtitle="Milk & Curd Sales Report — Night / Afternoon by route (whole month)"
      printOrientation="landscape"
      filters={
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
            Month
          </label>
          <Input
            type="month"
            value={month}
            onChange={e => setMonth(e.target.value)}
            className="erp-input w-44"
          />
        </div>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Milk & Curd Sales Report"
          rows={data ? [{ label: "Month", value: fmtMonth(data.month) }] : []}
        />
      }
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel: i => (i === 0 ? "Milk Items" : "Curd Items"),
        emptyMessage: "No sales found for this month",
      }}
    />
  );
}
