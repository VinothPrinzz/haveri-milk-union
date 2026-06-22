// apps/web/src/pages/sales-reports/DailySalesReport.tsx
// ════════════════════════════════════════════════════════════════════
// Daily Sales Report — "MILK & CURD SALES REPORT"
//
// Single-day route × product cross-tab, split into Night / Afternoon
// sales groups (by the route's batch), with a previous-day total-milk
// comparison + diff, per-group sub-totals and a grand "HVR TOTAL".
// Replaces the sheet the union types by hand each day.
//
// The wide cross-tab itself (layout, totals, CSV + Excel export) lives in
// ./milkCurdSalesShared and is shared with the Monthly Sales Report — this
// file only wires up the date picker and the day-vs-previous-day headers.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import {
  fetchDailySalesReport,
  type DailySalesReportResponse,
} from "@/services/report";
import {
  buildMilkCurdPages,
  buildMilkCurdCsv,
  buildMilkCurdXlsx,
  fmtDDMM,
} from "./milkCurdSalesShared";

export default function DailySalesReport() {
  const today = new Date().toISOString().split("T")[0];
  const [date, setDate] = useState(today);
  const [generated, setGenerated] = useState(false);

  const { data, isLoading, refetch } = useQuery<DailySalesReportResponse>({
    queryKey: ["daily-sales-report", date],
    queryFn: () => fetchDailySalesReport({ date }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  // ── Two pages: Milk items, then Curd items ──
  const pages: ReactNode[] = useMemo(
    () => (data ? buildMilkCurdPages(data, fmtDDMM(data.prevDate), fmtDDMM(data.date)) : []),
    [data],
  );

  // ── Exporters ──
  const exporters: Exporter[] = useMemo(() => {
    if (!data) return [];
    const csvOpts = {
      title: `Milk & Curd Sales Report — ${fmtDDMM(data.date)}`,
      prevHeader: fmtDDMM(data.prevDate),
      curHeader: fmtDDMM(data.date),
    };
    return [
      {
        label: "CSV",
        filename: `daily-sales-report_${data.date}.csv`,
        mimeType: "text/csv",
        build: () => buildMilkCurdCsv(data, csvOpts),
      },
      {
        label: "Excel",
        filename: `daily-sales-report_${data.date}.xlsx`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        build: () =>
          buildMilkCurdXlsx(data, {
            sheetName: "Daily Sales Report",
            title: `HAVERI DISTRICT CO-OP MILK PRODUCERS UNION LTD., HAVERI  —  MILK & CURD SALES REPORT  ${fmtDDMM(data.date)}`,
            prevHeader: fmtDDMM(data.prevDate),
            curHeader: fmtDDMM(data.date),
          }),
      },
    ];
  }, [data]);

  return (
    <ReportShell
      title="Daily Sales Report"
      subtitle="Milk & Curd Sales Report — Night / Afternoon by route"
      printOrientation="landscape"
      filters={
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
            Date
          </label>
          <Input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            className="erp-input w-44"
          />
        </div>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Milk & Curd Sales Report"
          rows={data ? [{ label: "Date", value: fmtDDMM(data.date) }] : []}
        />
      }
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel: i => (i === 0 ? "Milk Items" : "Curd Items"),
        emptyMessage: "No sales found for this date",
      }}
    />
  );
}
