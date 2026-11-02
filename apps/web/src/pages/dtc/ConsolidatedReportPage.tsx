// apps/web/src/pages/dtc/ConsolidatedReportPage.tsx
// ════════════════════════════════════════════════════════════════════
// DTC Billing → Consolidated DTC Bill  (/dtc/reports/consolidated?month=)
//
// The union's three-page monthly bill (landscape):
//   1. Consolidated DTC Bill — one row per route: type, capacity, days,
//      km per day, rate, litres, gross, other earnings, deductions by
//      head, total deduction, net payable, cost per litre; signature boxes
//   2. Transporter Earnings Sheet — every other earning with its remarks
//   3. Transporter Deductions Sheet — every deduction with its remarks
// ════════════════════════════════════════════════════════════════════
import { useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";
import { fetchRun, type Bill, type BillLine, type RunDetail } from "@/services/dtc";
import {
  BILLING_TYPE_LABEL, FilterLabel, HEAD_LABEL, MonthInput, RUN_STATUS_LABEL, SHEET_DEDUCTION_COLUMNS,
  errMsg, fmtStamp, monthLong, prevMonth, qtyFmt, rs, rs2,
} from "./shared";

// The 23-column sheet opts out of the report-canvas ledger styling
// ("no-ledger": 11.5px text, 10px cell padding) so it fits a landscape A4,
// and draws a full grid like the union's printed bill.
const th = "border border-neutral-500 py-[3px] px-[3px] font-bold align-bottom text-center leading-tight";
const td = "border border-neutral-400 py-[2px] px-[3px] leading-tight";

const dedFor = (b: Bill, heads: string[]) =>
  b.lines.filter(l => l.kind === "deduction" && heads.includes(l.head)).reduce((s, l) => s + l.amount, 0);
const otherQty = (b: Bill) => b.lines.filter(l => l.kind === "earning" && l.qty != null).reduce((s, l) => s + (l.qty ?? 0), 0);
const lineQty = (l: BillLine) => (l.qty != null && l.rate != null && l.head !== "tds" ? `${rs2(l.qty)} × ${rs2(l.rate)}` : "");

export default function ConsolidatedReportPage() {
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(params.get("month") ?? prevMonth(todayIST()));
  const [generated, setGenerated] = useState(!!params.get("month"));
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["dtc-run", month],
    queryFn: () => fetchRun(month),
    enabled: generated,
    retry: false,
  });
  const report = data && data.run.month === month ? data : undefined;

  const onGenerate = async () => {
    setParams({ month });
    setGenerated(true);
    const r = await refetch();
    if (r.error) toast.error(errMsg(r.error));
  };

  const pages: ReactNode[] = report ? [
    <SheetPage key="sheet" report={report} />,
    <LinesPage key="earn" report={report} kind="earning" />,
    <LinesPage key="ded" report={report} kind="deduction" />,
  ] : [];
  const labels = ["Consolidated DTC Bill", "Transporter Earnings Sheet", "Transporter Deductions Sheet"];
  const draft = report && report.run.status !== "approved";

  const exporters: Exporter[] = report ? [
    { label: "Excel", filename: `consolidated-dtc-bill_${month}.xlsx`, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", build: () => buildXlsx(report) },
    { label: "CSV", filename: `consolidated-dtc-bill_${month}.csv`, mimeType: "text/csv", build: () => toCsv(sheetRows(report)) },
  ] : [];

  return (
    <ReportShell
      title="Consolidated DTC Bill"
      subtitle="Monthly transport contractor bill with earnings and deductions sheets"
      printOrientation="landscape"
      filters={
        <div>
          <FilterLabel>Billing month</FilterLabel>
          <MonthInput value={month} onChange={m => { setMonth(m); setGenerated(false); }} max={todayIST().slice(0, 7)} className="w-40" />
        </div>
      }
      onGenerate={onGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Consolidated DTC Bill"
          rows={[
            { label: "Billing Month", value: monthLong(month) },
            ...(report ? [{ label: "Status", value: draft ? `${RUN_STATUS_LABEL[report.run.status]} (not final)` : "Approved" }] : []),
          ]}
        />
      }
      state={{
        generated: generated && !!report,
        loading: isFetching && !report,
        pages,
        pageLabel: i => labels[i] ?? "",
        emptyMessage: "No bills prepared for this month",
      }}
    />
  );
}

function SheetPage({ report }: { report: RunDetail }) {
  const { bills, run } = report;
  const sum = (f: (b: Bill) => number) => bills.reduce((s, b) => s + f(b), 0);
  return (
    <div>
      <table className="no-ledger w-full text-[8.5px] border-collapse text-black">
        <thead>
          <tr className="bg-neutral-100">
            <th className={th} rowSpan={2}>Sl<br />No</th>
            <th className={`${th} text-left`} rowSpan={2}>Route Name</th>
            <th className={`${th} text-left`} rowSpan={2}>Contractor Name</th>
            <th className={th} rowSpan={2}>Type</th>
            <th className={th} rowSpan={2}>Veh<br />Cap<br />(MT)</th>
            <th className={th} rowSpan={2}>No. of<br />Days</th>
            <th className={th} rowSpan={2}>Per<br />Day<br />KM</th>
            <th className={th} rowSpan={2}>Rate<br />per<br />KM-Ltr</th>
            <th className={th} rowSpan={2}>Qty<br />Milk &amp;<br />Prod</th>
            <th className={th} rowSpan={2}>Gross<br />Payable</th>
            <th className={th} rowSpan={2}>Other<br />Earnings<br />(Qty)</th>
            <th className={th} rowSpan={2}>Other<br />Earnings<br />(Amt)</th>
            <th className={th} rowSpan={2}>Total<br />Earning</th>
            <th className={th} colSpan={SHEET_DEDUCTION_COLUMNS.length}>Deduction</th>
            <th className={th} rowSpan={2}>Total<br />Deduction</th>
            <th className={th} rowSpan={2}>Net<br />Payable</th>
            <th className={th} rowSpan={2}>Cost<br />per<br />Ltr</th>
          </tr>
          <tr className="bg-neutral-100">
            {SHEET_DEDUCTION_COLUMNS.map(c => <th key={c.key} className={th}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {bills.map((b, i) => (
            <tr key={b.id}>
              <td className={`${td} text-right num`}>{i + 1}</td>
              <td className={td}>{b.routeName}</td>
              <td className={td}>{b.contractorName ?? ""}</td>
              <td className={`${td} text-center whitespace-nowrap`}>{BILLING_TYPE_LABEL[b.billingType]}</td>
              <td className={`${td} text-right num`}>{b.vehicleCapacityMt != null ? rs2(b.vehicleCapacityMt) : ""}</td>
              <td className={`${td} text-right num`}>{b.days}</td>
              <td className={`${td} text-right num`}>{rs2(b.billingType === "km" ? b.kmPerDay : 0)}</td>
              <td className={`${td} text-right num`}>{rs2(b.rate)}{b.segments.length > 1 ? "*" : ""}</td>
              <td className={`${td} text-right num`}>{qtyFmt(b.qtyLitres)}</td>
              <td className={`${td} text-right num`}>{rs(b.gross)}</td>
              <td className={`${td} text-right num`}>{otherQty(b) ? rs2(otherQty(b)) : "0"}</td>
              <td className={`${td} text-right num`}>{b.otherEarnings ? rs2(b.otherEarnings) : "0"}</td>
              <td className={`${td} text-right num`}>{rs(b.totalEarnings)}</td>
              {SHEET_DEDUCTION_COLUMNS.map(c => (
                <td key={c.key} className={`${td} text-right num`}>{rs(dedFor(b, c.heads))}</td>
              ))}
              <td className={`${td} text-right num`}>{rs(b.totalDeductions)}</td>
              <td className={`${td} text-right num font-semibold`}>{rs(b.net)}</td>
              <td className={`${td} text-right num`}>{rs2(b.costPerLitre)}</td>
            </tr>
          ))}
          <tr className="font-bold bg-neutral-100">
            <td className={td} colSpan={8}>TOTALS</td>
            <td className={`${td} text-right num`}>{qtyFmt(sum(b => b.qtyLitres))}</td>
            <td className={`${td} text-right num`}>{rs(sum(b => b.gross))}</td>
            <td className={`${td} text-right num`}>{rs2(sum(otherQty))}</td>
            <td className={`${td} text-right num`}>{rs2(sum(b => b.otherEarnings))}</td>
            <td className={`${td} text-right num`}>{rs(sum(b => b.totalEarnings))}</td>
            {SHEET_DEDUCTION_COLUMNS.map(c => (
              <td key={c.key} className={`${td} text-right num`}>{rs(sum(b => dedFor(b, c.heads)))}</td>
            ))}
            <td className={`${td} text-right num`}>{rs(sum(b => b.totalDeductions))}</td>
            <td className={`${td} text-right num`}>{rs(sum(b => b.net))}</td>
            <td className={td} />
          </tr>
        </tbody>
      </table>
      {bills.some(b => b.segments.length > 1) && (
        <p className="text-[9px] text-muted-foreground mt-1">* Rate revised during the month; the rate shown is the latest, the gross covers each part at its own rate.</p>
      )}
      <Signatures report={report} />
      <p className="text-[9px] text-muted-foreground mt-2">
        Cost per litre = {run.costBasis === "gross" ? "gross payable" : "total earning"} ÷ quantity of milk and products carried on the route.
        {" "}System record: {[
          run.submittedAt && `prepared by ${run.submittedByName ?? ""} on ${fmtStamp(run.submittedAt)}`,
          run.preAuditedAt && `pre-audited by ${run.preAuditedByName ?? ""} on ${fmtStamp(run.preAuditedAt)}`,
          run.mktgApprovedAt && `Marketing approved by ${run.mktgApprovedByName ?? ""} on ${fmtStamp(run.mktgApprovedAt)}`,
          run.approvedAt && `Finance approved by ${run.approvedByName ?? ""} on ${fmtStamp(run.approvedAt)}`,
        ].filter(Boolean).join("; ") || "not yet submitted"}.
      </p>
    </div>
  );
}

function Signatures({ report }: { report: RunDetail }) {
  return (
    <div className="grid mt-10 gap-4 text-[10px] text-center" style={{ gridTemplateColumns: `repeat(${report.signatures.length}, minmax(0, 1fr))` }}>
      {report.signatures.map(s => (
        <div key={s} className="border-t border-foreground/60 pt-1">{s}</div>
      ))}
    </div>
  );
}

function LinesPage({ report, kind }: { report: RunDetail; kind: "earning" | "deduction" }) {
  const rows = report.bills.flatMap(b => b.lines.filter(l => l.kind === kind).map(l => ({ b, l })));
  const total = rows.reduce((s, r) => s + r.l.amount, 0);
  const title = kind === "earning" ? "Transporter Earnings Sheet" : "Transporter Deductions Sheet";
  return (
    <div>
      <p className="text-center text-[12px] font-bold mb-2">{title}: {monthLong(report.run.month)}</p>
      <table className="w-full text-[10.5px] border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className={`${th} text-right`}>Sl No</th>
            <th className={`${th} text-left`}>Route Name</th>
            <th className={`${th} text-left`}>Contractor</th>
            <th className={`${th} text-left`}>{kind === "earning" ? "Earning" : "Deduction"}</th>
            <th className={`${th} text-right`}>Qty × Rate</th>
            <th className={`${th} text-right`}>{kind === "earning" ? "Other Earning" : "Other Deduction"} Amount (Rs.)</th>
            <th className={`${th} text-left`}>Remarks</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 && <tr><td className={`${td} text-center text-muted-foreground`} colSpan={7}>None this month</td></tr>}
          {rows.map(({ b, l }, i) => (
            <tr key={l.id}>
              <td className={`${td} text-right num`}>{i + 1}</td>
              <td className={td}>{b.routeName}</td>
              <td className={td}>{b.contractorName ?? ""}</td>
              <td className={td}>{HEAD_LABEL[l.head] ?? l.head}</td>
              <td className={`${td} text-right num`}>{lineQty(l)}</td>
              <td className={`${td} text-right num`}>{rs2(l.amount)}</td>
              <td className={td}>{l.remarks ?? ""}</td>
            </tr>
          ))}
          <tr className="font-bold bg-muted/30">
            <td className={td} colSpan={5}>TOTAL ADDITIONAL {kind === "earning" ? "EARNINGS" : "DEDUCTIONS"}</td>
            <td className={`${td} text-right num`}>{rs2(total)}</td>
            <td className={td} />
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// ─── Exports ────────────────────────────────────────────────────────
function sheetHeader() {
  return [
    "Sl No", "Route Name", "Contractor Name", "Type", "Veh Cap (MT)", "No. of Days", "Per Day KM",
    "Rate per KM-Ltr", "Qty Milk & Prod", "Gross Payable", "Other Earnings (Qty)", "Other Earnings (Amt)",
    "Total Earning", ...SHEET_DEDUCTION_COLUMNS.map(c => `Deduction: ${c.key === "sd" ? "Sec. Dep" : c.key === "km" ? "KM Ded." : c.key.charAt(0).toUpperCase() + c.key.slice(1)}`),
    "Total Deduction", "Net Payable", "Cost per Ltr",
  ];
}
function sheetRow(b: Bill, i: number): (string | number)[] {
  return [
    i + 1, b.routeName, b.contractorName ?? "", BILLING_TYPE_LABEL[b.billingType], b.vehicleCapacityMt ?? "",
    b.days, b.billingType === "km" ? b.kmPerDay : 0, b.rate, Math.round(b.qtyLitres), b.gross,
    Math.round(otherQty(b) * 100) / 100, b.otherEarnings, b.totalEarnings,
    ...SHEET_DEDUCTION_COLUMNS.map(c => Math.round(dedFor(b, c.heads))),
    b.totalDeductions, b.net, b.costPerLitre,
  ];
}
function lineRows(report: RunDetail, kind: "earning" | "deduction"): (string | number)[][] {
  return report.bills.flatMap(b => b.lines.filter(l => l.kind === kind).map(l => [
    b.routeName, b.contractorName ?? "", HEAD_LABEL[l.head] ?? l.head, l.qty ?? "", l.rate ?? "", l.amount, l.remarks ?? "",
  ]));
}
function sheetRows(report: RunDetail): (string | number)[][] {
  const linesHeader = ["Route Name", "Contractor", "Head", "Qty", "Rate", "Amount (Rs.)", "Remarks"];
  return [
    ["Consolidated DTC Bill", monthLong(report.run.month), RUN_STATUS_LABEL[report.run.status]],
    sheetHeader(),
    ...report.bills.map(sheetRow),
    [],
    ["Transporter Earnings Sheet"], linesHeader, ...lineRows(report, "earning"),
    [],
    ["Transporter Deductions Sheet"], linesHeader, ...lineRows(report, "deduction"),
  ];
}
async function buildXlsx(report: RunDetail): Promise<Blob> {
  const ExcelJS = (await import("exceljs")).default;
  const wb = new ExcelJS.Workbook();
  const title = `Consolidated DTC Bill: ${monthLong(report.run.month)} (${RUN_STATUS_LABEL[report.run.status]})`;
  const s1 = wb.addWorksheet("Consolidated DTC Bill");
  s1.addRow([title]).font = { bold: true, size: 12 };
  const h = s1.addRow(sheetHeader());
  h.font = { bold: true };
  h.alignment = { wrapText: true, vertical: "bottom" };
  report.bills.forEach((b, i) => s1.addRow(sheetRow(b, i)));
  const sum = (f: (b: Bill) => number) => report.bills.reduce((s, b) => s + f(b), 0);
  const t = s1.addRow([
    "", "TOTALS", "", "", "", "", "", "", Math.round(sum(b => b.qtyLitres)), sum(b => b.gross),
    sum(otherQty), sum(b => b.otherEarnings), sum(b => b.totalEarnings),
    ...SHEET_DEDUCTION_COLUMNS.map(c => Math.round(sum(b => dedFor(b, c.heads)))),
    sum(b => b.totalDeductions), sum(b => b.net), "",
  ]);
  t.font = { bold: true };
  s1.columns.forEach((c, i) => { c.width = i === 1 || i === 2 ? 26 : 11; });

  for (const kind of ["earning", "deduction"] as const) {
    const ws = wb.addWorksheet(kind === "earning" ? "Earnings Sheet" : "Deductions Sheet");
    ws.addRow([`${kind === "earning" ? "Transporter Earnings Sheet" : "Transporter Deductions Sheet"}: ${monthLong(report.run.month)}`]).font = { bold: true };
    ws.addRow(["Route Name", "Contractor", "Head", "Qty", "Rate", "Amount (Rs.)", "Remarks"]).font = { bold: true };
    lineRows(report, kind).forEach(r => ws.addRow(r));
    ws.columns.forEach((c, i) => { c.width = [24, 26, 22, 10, 10, 14, 48][i] ?? 12; });
  }
  const buf = await wb.xlsx.writeBuffer();
  return new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}
