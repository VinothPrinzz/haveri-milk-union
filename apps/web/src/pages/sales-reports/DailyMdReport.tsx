// apps/web/src/pages/sales-reports/DailyMdReport.tsx
// ════════════════════════════════════════════════════════════════════
// Daily Sales Report MD: "HAVEMUL Sales Report of dd-mm-yyyy"
//
// The one-page summary the MD reads every morning: nine fixed lines
// (total milk, UHT, curd, paneer, butter, ghee, khova, Dharwad peda,
// white peda) with the day's volume in Ltr / Kg. Replaces the Word
// sheet the union typed by hand; the layout mirrors it (see .md-sheet
// in index.css).
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import { fetchDailyMd, type DailyMdResponse } from "@/services/report";
import { todayIST } from "@/lib/istDate";

// ISO → dd-mm-yyyy, the way the sheet prints its date.
const fmtDMY = (iso: string) => {
  const [y, m, d] = (iso ?? "").split("-");
  return y && m && d ? `${d}-${m}-${y}` : (iso ?? "");
};

// The sheet prints whole units.
const fmtQty = (n: number) => Math.round(Number(n) || 0).toLocaleString("en-IN");

export default function DailyMdReport() {
  const today = todayIST();
  const [date, setDate] = useState(today);
  const [generated, setGenerated] = useState(false);

  const { data, isLoading, refetch } = useQuery<DailyMdResponse>({
    queryKey: ["daily-md", date],
    queryFn: () => fetchDailyMd({ date }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  const pages: ReactNode[] = useMemo(
    () =>
      data
        ? [
            <div key="p1" className="md-sheet-wrap">
              <table className="md-sheet no-ledger">
                <tbody>
                  <tr>
                    <td className="md-title" colSpan={3}>
                      HAVEMUL Sales Report of {fmtDMY(data.date)}
                    </td>
                  </tr>
                  {data.lines.map(l => (
                    <tr key={l.key}>
                      <td className="md-label">{l.label}</td>
                      <td className="md-value">{fmtQty(l.qty)}</td>
                      <td className="md-unit">{l.unit}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>,
          ]
        : [],
    [data],
  );

  const exporters: Exporter[] = useMemo(
    () =>
      data
        ? [
            {
              label: "CSV",
              filename: `havemul-sales-report_${data.date}.csv`,
              mimeType: "text/csv",
              build: () =>
                toCsv([
                  [`HAVEMUL Sales Report of ${fmtDMY(data.date)}`],
                  ...data.lines.map(l => [l.label, l.qty, l.unit]),
                ]),
            },
          ]
        : [],
    [data],
  );

  return (
    <ReportShell
      title="Daily Sales Report MD"
      subtitle="Day totals by production line: milk, UHT, curd, paneer, butter, ghee, khova, peda"
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
          title="Daily Sales Report"
          rows={data ? [{ label: "Date", value: fmtDMY(data.date) }] : []}
        />
      }
      state={{
        generated,
        loading: isLoading,
        pages,
        emptyMessage: "No sales found for this date",
      }}
    />
  );
}
