// apps/web/src/pages/sales-reports/DailySalesReport.tsx
// ════════════════════════════════════════════════════════════════════
// Daily Sales Report — "MILK & CURD SALES REPORT"
//
// Single-day route × product cross-tab, split into Night / Afternoon
// sales groups (by the route's batch), with a previous-day total-milk
// comparison + diff, per-group sub-totals and a grand "HVR TOTAL".
// Replaces the sheet the union types by hand each day.
//
// Print: A4 landscape (23 columns). Export: CSV + Excel (.xlsx, merged
// group headers) via exceljs (dynamically imported in the exporter).
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import {
  fetchDailySalesReport,
  type DailySalesReportColumn,
  type DailySalesReportResponse,
  type DailySalesReportRow,
} from "@/services/report";
import { toCsv } from "@/lib/exporters";

// ── Column slots (fixed layout — matches the paper report) ──────────
// `total` flags the red computed totals (already in Ltr / Kg / qty, read via
// `get`); every other slot is a raw product column (`col`) stored as a packet
// count that we convert to Ltr (milk) / Kg (curd) using the column's qtyToUnit.
type Slot = {
  header: string;
  group: string; // "" → standalone column (spans both header rows)
  total?: boolean;
  col?: string;  // raw product column key (packets → Ltr/Kg via qtyToUnit)
  get?: (r: DailySalesReportRow) => number; // value for total columns
};

const SLOTS: Slot[] = [
  { header: "HTM 1000ml",           group: "HTM MILK", col: "htm1000" },
  { header: "HTM 500ML",            group: "HTM MILK", col: "htm500" },
  { header: "HCM 160ML",            group: "HCM MILK", col: "hcm160" },
  { header: "HCM 500ML",            group: "HCM MILK", col: "hcm500" },
  { header: "SBM 1000ML",           group: "SBM MILK", col: "sbm1000" },
  { header: "SBM 500ML",            group: "SBM MILK", col: "sbm500" },
  { header: "SBM 200ML",            group: "SBM MILK", col: "sbm200" },
  { header: "SAMRUDHI 500ML",       group: "SAMRUDHI", col: "samrudhi500" },
  { header: "TOTAL MILK (IN LTRS)", group: "", total: true, get: r => r.totalMilk },
  { header: "CURD 140GM",           group: "CURD", col: "curd140" },
  { header: "CURD 200GM",           group: "CURD", col: "curd200" },
  { header: "CURD 500GM",           group: "CURD", col: "curd500" },
  { header: "CURD 10KG (B)",        group: "CURD", col: "curd10kg" },
  { header: "CURD 05KG (B)",        group: "CURD", col: "curd5kg" },
  { header: "TOTAL CURD (IN KGS)",  group: "", total: true, get: r => r.totalCurd },
  { header: "SL 200 ML",            group: "", col: "sl200" },
  { header: "MASAL MAJJIGE 200ML",  group: "", col: "majjige" },
  { header: "TOTAL G/L",            group: "", total: true, get: r => r.totalGL },
];

// Build a column-key → Ltr/Kg-per-packet map from the API column metadata.
const unitMap = (cols: DailySalesReportColumn[]): Record<string, number> =>
  Object.fromEntries(cols.map(c => [c.key, c.qtyToUnit ?? 1]));

// A slot's display value: totals are pre-computed (Ltr/Kg/qty); product
// columns convert their packet count to Ltr (milk) / Kg (curd).
const cellValue = (s: Slot, r: DailySalesReportRow, unit: Record<string, number>) =>
  s.total ? (s.get?.(r) ?? 0) : (r.cols[s.col!] ?? 0) * (unit[s.col!] ?? 1);

// The report is split across two landscape pages so the columns stay
// readable: a Milk page (HTM…SAMRUDHI + TOTAL MILK) and a Curd page
// (CURD…TOTAL G/L). Both pages repeat the fixed left columns. Exports
// keep everything on one combined sheet (full SLOTS).
const MILK_SPLIT = SLOTS.findIndex(s => s.header.startsWith("TOTAL MILK")) + 1;
const MILK_SLOTS = SLOTS.slice(0, MILK_SPLIT);
const CURD_SLOTS = SLOTS.slice(MILK_SPLIT);

// Group consecutive slots that share a (non-empty) group label.
type Run = { group: string; slots: Slot[] };
const buildRuns = (slots: Slot[]): Run[] => {
  const runs: Run[] = [];
  for (const s of slots) {
    const last = runs[runs.length - 1];
    if (s.group && last && last.group === s.group) last.slots.push(s);
    else runs.push({ group: s.group, slots: [s] });
  }
  return runs;
};

const FIXED_HEADERS = (prev: string, today: string) =>
  ["SL NO", "Route Name", prev, today, "Diff"];

// ── Formatters ──────────────────────────────────────────────────────
const fmtDDMM = (iso: string) => {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
};
// integer if whole, else 1 decimal
const fmtNum = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
// packet cells go blank when 0 (like the manual sheet); totals always show
const fmtCell = (n: number, total?: boolean) => (!total && !n ? "" : fmtNum(n));

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
  const pages: ReactNode[] = useMemo(() => {
    if (!data) return [];
    return [
      <DailySalesTable key="milk" data={data} slots={MILK_SLOTS} />,
      <DailySalesTable key="curd" data={data} slots={CURD_SLOTS} />,
    ];
  }, [data]);

  // ── Exporters ──
  const exporters: Exporter[] = useMemo(() => {
    if (!data) return [];
    return [
      {
        label: "CSV",
        filename: `daily-sales-report_${data.date}.csv`,
        mimeType: "text/csv",
        build: () => toCsv(buildCsvRows(data)),
      },
      {
        label: "Excel",
        filename: `daily-sales-report_${data.date}.xlsx`,
        mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        build: () => buildXlsx(data),
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

// ════════════════════════════════════════════════════════════════════
// The wide cross-tab table
// ════════════════════════════════════════════════════════════════════
function DailySalesTable({ data, slots }: { data: DailySalesReportResponse; slots: Slot[] }) {
  const night = data.groups.find(g => g.key === "night");
  const afternoon = data.groups.find(g => g.key === "afternoon");
  const runs = buildRuns(slots);
  const unit = unitMap(data.columns);

  // Continuous SL across both groups, skipping sub-total rows.
  let sl = 0;

  // Solid black borders on every cell → crisp vertical + horizontal lines.
  // whitespace-normal lets headers wrap inside their capped columns.
  const th = "border border-black px-0.5 py-0.5 text-center font-bold align-middle whitespace-normal break-words";
  const tdNum = "border border-black px-0.5 py-0.5 text-center num whitespace-normal";
  const tdName = "border border-black px-1 py-0.5 text-left whitespace-normal break-words";

  // Fixed left columns take ~31.5%; remaining width is split evenly across
  // this page's product columns (≤ 9 per page → comfortably wide headers).
  const slotW = `${(68.5 / slots.length).toFixed(2)}%`;

  const dataRow = (row: DailySalesReportRow) => {
    sl += 1;
    return (
      <tr key={row.id ?? row.name}>
        <td className={tdNum}>{sl}</td>
        <td className={tdName}>{row.name}</td>
        <td className={tdNum}>{fmtNum(row.prevQty)}</td>
        <td className={tdNum}>{fmtNum(row.todayQty)}</td>
        <td className={`${tdNum} text-red-600`}>{fmtNum(row.diff)}</td>
        {slots.map((s, i) => (
          <td key={i} className={`${tdNum} ${s.total ? "text-red-600 font-semibold" : ""}`}>
            {fmtCell(cellValue(s, row, unit), s.total)}
          </td>
        ))}
      </tr>
    );
  };

  const totalRow = (row: DailySalesReportRow, strong?: boolean) => (
    <tr key={row.name} className={strong ? "bg-emerald-200 font-bold" : "bg-emerald-100 font-bold"}>
      <td className={tdNum} />
      <td className={tdName}>{row.name}</td>
      <td className={tdNum}>{fmtNum(row.prevQty)}</td>
      <td className={tdNum}>{fmtNum(row.todayQty)}</td>
      <td className={`${tdNum} text-red-700`}>{fmtNum(row.diff)}</td>
      {slots.map((s, i) => (
        <td key={i} className={`${tdNum} ${s.total ? "text-red-700" : ""}`}>
          {fmtCell(cellValue(s, row, unit), true)}
        </td>
      ))}
    </tr>
  );

  return (
    <table
      className="no-ledger border-collapse text-[8px] leading-[1.1]"
      style={{ width: "100%", tableLayout: "fixed" }}
    >
      {/* Capped column widths so this page fits an A4 landscape sheet.
          `no-ledger` opts out of the global report-table normalisation
          (which forces nowrap headers and strips cell borders). */}
      <colgroup>
        <col style={{ width: "3%" }} />     {/* SL */}
        <col style={{ width: "15%" }} />    {/* Route Name */}
        <col style={{ width: "4.5%" }} />   {/* prev date */}
        <col style={{ width: "4.5%" }} />   {/* selected date */}
        <col style={{ width: "4.5%" }} />   {/* Diff */}
        {slots.map((_, i) => (
          <col key={i} style={{ width: slotW }} />
        ))}
      </colgroup>
      <thead>
        {/* Row 1: fixed columns + group labels */}
        <tr className="bg-sky-100">
          {FIXED_HEADERS(fmtDDMM(data.prevDate), fmtDDMM(data.date)).map((h, i) => (
            <th key={i} className={th} rowSpan={2}>{h}</th>
          ))}
          {runs.map((run, i) =>
            run.group === "" ? (
              <th key={i} className={`${th} ${run.slots[0].total ? "text-red-700" : ""}`} rowSpan={2}>
                {run.slots[0].header}
              </th>
            ) : (
              <th key={i} className={th} colSpan={run.slots.length}>{run.group}</th>
            )
          )}
        </tr>
        {/* Row 2: sub-headers for grouped columns only */}
        <tr className="bg-sky-50">
          {runs.filter(run => run.group !== "").flatMap((run, ri) =>
            run.slots.map((s, si) => (
              <th key={`${ri}-${si}`} className={th}>{s.header}</th>
            ))
          )}
        </tr>
      </thead>
      <tbody>
        {night?.rows.map(dataRow)}
        {night && totalRow(night.subtotal)}
        {afternoon?.rows.map(dataRow)}
        {afternoon && totalRow(afternoon.subtotal)}
        {totalRow(data.total, true)}
      </tbody>
    </table>
  );
}

// ════════════════════════════════════════════════════════════════════
// CSV — single header row + all data/sub-total/total rows
// ════════════════════════════════════════════════════════════════════
function buildCsvRows(data: DailySalesReportResponse): (string | number)[][] {
  const out: (string | number)[][] = [];
  out.push([`Milk & Curd Sales Report — ${fmtDDMM(data.date)}`]);
  out.push([
    "SL", "Route Name", fmtDDMM(data.prevDate), fmtDDMM(data.date), "Diff",
    ...SLOTS.map(s => s.header.replace(/\s+/g, " ")),
  ]);

  const unit = unitMap(data.columns);
  let sl = 0;
  const dataRow = (r: DailySalesReportRow) =>
    [++sl, r.name, r.prevQty, r.todayQty, r.diff, ...SLOTS.map(s => cellValue(s, r, unit))];
  const totalRow = (r: DailySalesReportRow) =>
    ["", r.name, r.prevQty, r.todayQty, r.diff, ...SLOTS.map(s => cellValue(s, r, unit))];

  const night = data.groups.find(g => g.key === "night");
  const afternoon = data.groups.find(g => g.key === "afternoon");
  night?.rows.forEach(r => out.push(dataRow(r)));
  if (night) out.push(totalRow(night.subtotal));
  afternoon?.rows.forEach(r => out.push(dataRow(r)));
  if (afternoon) out.push(totalRow(afternoon.subtotal));
  out.push(totalRow(data.total));
  return out;
}

// ════════════════════════════════════════════════════════════════════
// Excel (.xlsx) — merged group headers, bold totals, landscape
// ════════════════════════════════════════════════════════════════════
async function buildXlsx(data: DailySalesReportResponse): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Daily Sales Report", {
    pageSetup: { orientation: "landscape", fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const FIXED = 5;
  const totalCols = FIXED + SLOTS.length;

  const thin = { style: "thin" as const, color: { argb: "FF000000" } };
  const border = { top: thin, left: thin, bottom: thin, right: thin };
  const headerFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFD6EAF8" } };
  const totalFill = { type: "pattern" as const, pattern: "solid" as const, fgColor: { argb: "FFABEBC6" } };

  const styleHeader = (c: any) => {
    c.font = { bold: true, size: 8 };
    c.alignment = { horizontal: "center", vertical: "middle", wrapText: true };
    c.fill = headerFill;
    c.border = border;
  };

  // Title
  ws.mergeCells(1, 1, 1, totalCols);
  const title = ws.getCell(1, 1);
  title.value = `HAVERI DISTRICT CO-OP MILK PRODUCERS UNION LTD., HAVERI  —  MILK & CURD SALES REPORT  ${fmtDDMM(data.date)}`;
  title.font = { bold: true, size: 12 };
  title.alignment = { horizontal: "center" };

  // Header rows (2 & 3)
  FIXED_HEADERS(fmtDDMM(data.prevDate), fmtDDMM(data.date)).forEach((h, i) => {
    ws.mergeCells(2, i + 1, 3, i + 1);
    const c = ws.getCell(2, i + 1);
    c.value = h;
    styleHeader(c);
  });

  let col = FIXED + 1;
  for (const run of buildRuns(SLOTS)) {
    if (run.group === "") {
      ws.mergeCells(2, col, 3, col);
      const c = ws.getCell(2, col);
      c.value = run.slots[0].header;
      styleHeader(c);
      col += 1;
    } else {
      const span = run.slots.length;
      ws.mergeCells(2, col, 2, col + span - 1);
      const gc = ws.getCell(2, col);
      gc.value = run.group;
      styleHeader(gc);
      run.slots.forEach((s, j) => {
        const c = ws.getCell(3, col + j);
        c.value = s.header;
        styleHeader(c);
      });
      col += span;
    }
  }

  // Data
  const unit = unitMap(data.columns);
  let r = 4;
  let sl = 0;
  const writeRow = (row: DailySalesReportRow, kind: "data" | "subtotal" | "total") => {
    const vals: (string | number)[] = [
      kind === "data" ? ++sl : "",
      row.name, row.prevQty, row.todayQty, row.diff,
      ...SLOTS.map(s => cellValue(s, row, unit)),
    ];
    vals.forEach((v, i) => {
      const c = ws.getCell(r, i + 1);
      c.value = v;
      c.border = border;
      c.alignment = { horizontal: i === 1 ? "left" : "center" };
      if (kind !== "data") {
        c.font = { bold: true, size: 8 };
        c.fill = totalFill;
      } else {
        c.font = { size: 8 };
      }
    });
    r += 1;
  };

  const night = data.groups.find(g => g.key === "night");
  const afternoon = data.groups.find(g => g.key === "afternoon");
  night?.rows.forEach(row => writeRow(row, "data"));
  if (night) writeRow(night.subtotal, "subtotal");
  afternoon?.rows.forEach(row => writeRow(row, "data"));
  if (afternoon) writeRow(afternoon.subtotal, "subtotal");
  writeRow(data.total, "total");

  // Column widths
  ws.getColumn(1).width = 5;
  ws.getColumn(2).width = 22;
  for (let i = 3; i <= totalCols; i++) ws.getColumn(i).width = 8.5;

  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}
