// apps/web/src/pages/reports/GatePassReportPage.tsx
// ════════════════════════════════════════════════════════════════════
// Gate Pass Report — ledger style, CSV + Tally exports.
// ════════════════════════════════════════════════════════════════════
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { fmtINR, fmtDate } from "@/components/PageHeader";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { fetchGatePassReport, type GatePassResponse } from "@/services/report";
import { toCsv, toTallyCsv, toTallyXml,
         type TallyVoucher, type TallySalesVoucher, LEDGER_MAP } from "@/lib/exporters";

const ROWS_PER_PAGE = 35;   // dense ledger rows fit more per page

export default function GatePassReportPage() {
  const today = new Date().toISOString().split("T")[0];
  const monthStart = today.substring(0, 8) + "01";

  const [fromDate, setFromDate] = useState(monthStart);
  const [toDate, setToDate]     = useState(today);
  const [generated, setGenerated] = useState(false);

  const { data, isLoading, refetch } = useQuery<GatePassResponse>({
    queryKey: ["gate-pass-report", fromDate, toDate],
    queryFn: () => fetchGatePassReport({ from: fromDate, to: toDate, limit: 500 }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  const rows = data?.rows ?? [];
  const totalAmount = data?.totalAmount ?? 0;

  const pageCount = Math.max(1, Math.ceil(rows.length / ROWS_PER_PAGE));
  const pages = Array.from({ length: pageCount }).map((_, idx) => {
    const slice = rows.slice(idx * ROWS_PER_PAGE, (idx + 1) * ROWS_PER_PAGE);
    const isLast = idx === pageCount - 1;
    return (
      <table key={idx} className="report-ledger">
        <thead>
          <tr>
            <th style={{ width: 80 }}>GP No.</th>
            <th style={{ width: 90 }}>Date</th>
            <th>Agent</th>
            <th>Route</th>
            <th>Items</th>
            <th className="num" style={{ width: 110 }}>Amount ₹</th>
          </tr>
        </thead>
        <tbody>
          {slice.map(r => (
            <tr key={r.gpNo}>
              <td className="font-mono">{r.gpNo}</td>
              <td>{fmtDate(r.date)}</td>
              <td>{r.agentName}</td>
              <td>{r.routeName}</td>
              <td className="text-[10.5px]">{r.itemsText}</td>
              <td className="num">{fmtINR(r.amount)}</td>
            </tr>
          ))}
          {isLast && (
            <tr className="total-row">
              <td colSpan={5} className="num">TOTAL</td>
              <td className="num">{fmtINR(totalAmount)}</td>
            </tr>
          )}
        </tbody>
      </table>
    );
  });

  // ── Exports ─────────────────────────────────────────────────────
  const fileBase = `gate-pass_${fromDate}_${toDate}`;

  const exporters: Exporter[] = data ? [
    {
      label: "CSV",
      filename: `${fileBase}.csv`,
      mimeType: "text/csv",
      build: () => {
        const out: (string | number)[][] = [
          ["GP No.", "Date", "Agent", "Route", "Items", "Amount"]
        ];
        for (const r of rows) {
          out.push([r.gpNo, r.date, r.agentName, r.routeName, r.itemsText, r.amount]);
        }
        out.push(["", "", "", "", "TOTAL", totalAmount]);
        return toCsv(out);
      },
    },
    {
      label: "Tally CSV",
      filename: `${fileBase}_tally.csv`,
      mimeType: "text/csv",
      build: () => {
        const vchs: TallyVoucher[] = rows.map(r => ({
          date: r.date,
          vchType: "Sales",
          vchNo: r.gpNo,
          reference: r.gpNo,
          partyLedger: r.agentName,
          debitLedger: LEDGER_MAP.cashLedger,
          creditLedger: LEDGER_MAP.salesLedger,
          amount: Number(r.amount),
          narration: `Gate Pass ${r.gpNo} · ${r.routeName}`,
        }));
        return toTallyCsv(vchs);
      },
    },
    {
      label: "Tally XML",
      filename: `${fileBase}_tally.xml`,
      mimeType: "application/xml",
      build: () => {
        const vchs: TallySalesVoucher[] = rows.map(r => ({
          date: r.date,
          vchNo: r.gpNo,
          partyLedger: LEDGER_MAP.cashLedger,   // gate-pass = cash sale by default
          amountInclGst: Number(r.amount),
          baseAmount: Number(r.amount),         // GST not split in this report
          narration: `Gate Pass ${r.gpNo} · ${r.routeName} · ${r.agentName}`,
        }));
        return toTallyXml(vchs);
      },
    },
  ] : [];

  return (
    <ReportShell
      title="Gate Pass Report"
      subtitle="Agent-wise direct sale gate-pass register"
      printOrientation="portrait"
      filters={
        <>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
            <Input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="erp-input w-40" />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
            <Input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="erp-input w-40" />
          </div>
        </>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Gate Pass Sales Report"
          rows={[
            { label: "From", value: fmtDate(fromDate) },
            { label: "To", value: fmtDate(toDate) },
            { label: "Rows", value: rows.length },
            { label: "Total", value: fmtINR(totalAmount) },
          ]}
        />
      }
      state={{
        generated,
        loading: isLoading,
        pages: rows.length === 0 ? [] : pages,
        emptyMessage: "No gate-pass entries in this range",
      }}
    />
  );
}