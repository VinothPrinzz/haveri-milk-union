// apps/web/src/pages/dtc/ContractorLedgerPage.tsx
// DTC Billing → Contractor Ledger  (/dtc/reports/ledger?contractor=)
// One contractor over a period: every month's bills with deductions by head,
// what was paid and when, advances, and the security deposit position.
import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";
import { fetchDtcLookups, fetchLedger, type LedgerReport } from "@/services/dtc";
import {
  BILLING_TYPE_LABEL, FilterLabel, HEAD_LABEL, MonthInput, RUN_STATUS_LABEL, addMonths, errMsg, fmtDMY, monthLabel, rs, rs2,
} from "./shared";

const th = "border border-border py-1 px-1.5 font-bold";
const td = "border border-border py-0.5 px-1.5";

export default function ContractorLedgerPage() {
  const [params, setParams] = useSearchParams();
  const thisMonth = todayIST().slice(0, 7);
  const [contractorId, setContractorId] = useState<string | null>(params.get("contractor"));
  const [from, setFrom] = useState(addMonths(thisMonth, -11));
  const [to, setTo] = useState(thisMonth);
  const [generated, setGenerated] = useState(false);
  const { data: lookups } = useQuery({ queryKey: ["dtc-lookups"], queryFn: fetchDtcLookups });
  const options: F9Option[] = useMemo(
    () => (lookups?.contractors ?? []).map(c => ({ value: c.id, label: c.name, sublabel: c.code ?? c.phone })), [lookups]);
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["dtc-ledger", contractorId, from, to],
    queryFn: () => fetchLedger({ contractorId: contractorId!, from, to }),
    enabled: false,
  });
  const report = data && data.contractor.id === contractorId && data.from === from && data.to === to ? data : undefined;

  const onGenerate = async () => {
    if (!contractorId) { toast.error("Pick a contractor"); return; }
    if (from > to) { toast.error("'From' must be on or before 'To'"); return; }
    setParams({ contractor: contractorId });
    const r = await refetch();
    if (r.error) toast.error(errMsg(r.error));
    setGenerated(true);
  };

  const pages: ReactNode[] = report ? [<Ledger key="l" report={report} />] : [];
  const exporters: Exporter[] = report ? [{
    label: "CSV", filename: `dtc-ledger_${report.contractor.code ?? report.contractor.name}_${from}_${to}.csv`, mimeType: "text/csv",
    build: () => toCsv([
      [report.contractor.name, `${monthLabel(from)} to ${monthLabel(to)}`],
      ["Month", "Route", "Type", "Days", "Gross", "Other earnings", "Total earnings", "Deductions", "Net", "Payable", "Paid on", "Reference", "Status"],
      ...report.bills.map(b => [
        monthLabel(b.month), b.routeName, BILLING_TYPE_LABEL[b.billingType], b.days, b.gross, b.otherEarnings,
        b.totalEarnings, b.totalDeductions, b.net, b.payable, b.paidOn ?? "", b.paymentReference ?? "", RUN_STATUS_LABEL[b.runStatus],
      ]),
    ]),
  }] : [];

  return (
    <ReportShell
      title="Contractor Ledger"
      subtitle="A contractor's DTC bills, deductions, payments, advances and security deposit"
      printOrientation="portrait"
      filters={
        <>
          <div className="min-w-[240px]">
            <FilterLabel>Contractor</FilterLabel>
            <F9SearchSelect value={contractorId} onChange={v => { setContractorId(v); setGenerated(false); }} options={options} placeholder="Select contractor" />
          </div>
          <div><FilterLabel>From month</FilterLabel><MonthInput value={from} onChange={v => { setFrom(v); setGenerated(false); }} className="w-40" /></div>
          <div><FilterLabel>To month</FilterLabel><MonthInput value={to} onChange={v => { setTo(v); setGenerated(false); }} className="w-40" /></div>
        </>
      }
      onGenerate={onGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Contractor Ledger (DTC)"
          rows={[
            ...(report ? [{ label: "Contractor", value: `${report.contractor.name}${report.contractor.code ? ` (${report.contractor.code})` : ""}` }] : []),
            { label: "Period", value: `${monthLabel(from)} to ${monthLabel(to)}` },
          ]}
        />
      }
      state={{ generated, loading: isFetching && !report, pages, emptyMessage: "No bills for this contractor in the period" }}
    />
  );
}

function Ledger({ report }: { report: LedgerReport }) {
  const { contractor: c, bills, totals, deposit, advances } = report;
  const heads = Array.from(new Set(bills.flatMap(b => Object.keys(b.deductions))));
  return (
    <div className="text-[10.5px] space-y-3">
      <div className="grid grid-cols-2 gap-x-6 border border-border p-2">
        <div><b>Bank:</b> {c.bankName ?? ""} {c.accountNo ?? ""} {c.ifscCode ? `· ${c.ifscCode}` : ""}</div>
        <div><b>PAN:</b> {c.panNumber ?? "not on record"}{c.tdsDeclarationFy ? ` · 194C declaration ${c.tdsDeclarationFy}` : ""}</div>
      </div>
      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className={`${th} text-left`}>Month</th><th className={`${th} text-left`}>Route</th>
            <th className={`${th} text-right`}>Days</th><th className={`${th} text-right`}>Total earning</th>
            {heads.map(h => <th key={h} className={`${th} text-right`}>{HEAD_LABEL[h] ?? h}</th>)}
            <th className={`${th} text-right`}>Net</th><th className={`${th} text-left`}>Paid</th>
          </tr>
        </thead>
        <tbody>
          {bills.length === 0 && <tr><td className={`${td} text-center text-muted-foreground`} colSpan={6 + heads.length}>No bills in this period</td></tr>}
          {bills.map(b => (
            <tr key={b.id}>
              <td className={td}>{monthLabel(b.month)}{b.runStatus !== "approved" && <span className="text-muted-foreground">*</span>}</td>
              <td className={td}>{b.routeName}</td>
              <td className={`${td} text-right num`}>{b.days}</td>
              <td className={`${td} text-right num`}>{rs(b.totalEarnings)}</td>
              {heads.map(h => <td key={h} className={`${td} text-right num`}>{b.deductions[h] ? rs2(b.deductions[h]) : ""}</td>)}
              <td className={`${td} text-right num font-semibold ${b.net < 0 ? "text-destructive" : ""}`}>{rs(b.net)}</td>
              <td className={td}>
                {b.paidOn ? `${fmtDMY(b.paidOn)} ${b.paymentReference ?? ""}` : b.onHold ? "On hold" : b.runStatus === "approved" ? (b.payable > 0 ? "Unpaid" : "Nothing payable") : ""}
              </td>
            </tr>
          ))}
          <tr className="font-bold bg-muted/30">
            <td className={td} colSpan={3}>Total</td>
            <td className={`${td} text-right num`}>{rs(totals.totalEarnings)}</td>
            {heads.map(h => <td key={h} className={`${td} text-right num`}>{rs2(bills.reduce((s, b) => s + (b.deductions[h] ?? 0), 0))}</td>)}
            <td className={`${td} text-right num`}>{rs(bills.reduce((s, b) => s + b.net, 0))}</td>
            <td className={td}>Paid ₹{rs(totals.paid)} · due ₹{rs(totals.outstanding)}</td>
          </tr>
        </tbody>
      </table>
      <p className="text-muted-foreground">* Month not yet approved.</p>

      <div className="grid grid-cols-2 gap-3">
        <div className="border border-border p-2">
          <b>Security deposit</b>
          {deposit ? (
            <div className="mt-1 space-y-0.5">
              <div>Target ₹{rs2(deposit.targetAmount)}, ₹{rs2(deposit.monthlyInstalment)} a month ({deposit.status})</div>
              <div>Collected ₹{rs2(deposit.collected)}{deposit.openingCollected ? ` (incl. ₹${rs2(deposit.openingCollected)} before)` : ""}</div>
              {deposit.refundedAmount > 0 && <div>Refunded ₹{rs2(deposit.refundedAmount)} on {fmtDMY(deposit.refundedOn)}</div>}
            </div>
          ) : <div className="mt-1 text-muted-foreground">No deposit plan</div>}
        </div>
        <div className="border border-border p-2">
          <b>Advances</b>
          {advances.length === 0 ? <div className="mt-1 text-muted-foreground">None in this period</div> : (
            <ul className="mt-1 space-y-0.5">
              {advances.map(a => (
                <li key={a.id} className={a.cancelledAt ? "line-through text-muted-foreground" : ""}>
                  ₹{rs2(a.amount)} paid {fmtDMY(a.paidOn)}, recovered in {monthLabel(a.recoverMonth)}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
