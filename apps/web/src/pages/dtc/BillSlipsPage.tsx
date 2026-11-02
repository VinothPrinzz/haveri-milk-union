// apps/web/src/pages/dtc/BillSlipsPage.tsx
// DTC Billing → Contractor Bill Slips  (/dtc/reports/bill-slips?month=)
// One printable page per contractor for the month: all their routes, the
// earnings and deductions with remarks, and the net payable — what the
// contractor is given with the payment.
import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";
import { fetchRun, type Bill, type RunDetail } from "@/services/dtc";
import {
  BILLING_TYPE_LABEL, FilterLabel, HEAD_LABEL, MonthInput, RUN_STATUS_LABEL, errMsg, fmtDMY, monthLong, prevMonth, qtyFmt, rs, rs2,
} from "./shared";

const th = "border border-border py-1 px-1.5 font-bold text-left";
const td = "border border-border py-0.5 px-1.5";

interface Slip { key: string; name: string; bills: Bill[] }

export default function BillSlipsPage() {
  const [params, setParams] = useSearchParams();
  const [month, setMonth] = useState(params.get("month") ?? prevMonth(todayIST()));
  const [contractor, setContractor] = useState<string | null>(params.get("contractor"));
  const [generated, setGenerated] = useState(!!params.get("month"));
  const { data, isFetching, refetch } = useQuery({
    queryKey: ["dtc-run", month], queryFn: () => fetchRun(month), enabled: generated, retry: false,
  });
  const report = data && data.run.month === month ? data : undefined;

  const slips = useMemo<Slip[]>(() => {
    const m = new Map<string, Slip>();
    for (const b of report?.bills ?? []) {
      const key = b.contractorId ?? `none:${b.id}`;
      if (!m.has(key)) m.set(key, { key, name: b.contractorName ?? "No contractor", bills: [] });
      m.get(key)!.bills.push(b);
    }
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [report]);
  const options: F9Option[] = slips.filter(s => !s.key.startsWith("none:")).map(s => ({ value: s.key, label: s.name }));
  const shown = contractor ? slips.filter(s => s.key === contractor) : slips;

  const onGenerate = async () => {
    setParams({ month, ...(contractor ? { contractor } : {}) });
    setGenerated(true);
    const r = await refetch();
    if (r.error) toast.error(errMsg(r.error));
  };

  const pages: ReactNode[] = report ? shown.map(s => <SlipPage key={s.key} slip={s} report={report} />) : [];
  const exporters: Exporter[] = report ? [{
    label: "CSV", filename: `dtc-bill-slips_${month}.csv`, mimeType: "text/csv",
    build: () => toCsv([
      ["Contractor", "Route", "Type", "Days", "Gross", "Other earnings", "Total earnings", "Deductions", "Net payable", "Paid on", "Reference"],
      ...shown.flatMap(s => s.bills.map(b => [
        s.name, b.routeName, BILLING_TYPE_LABEL[b.billingType], b.days, b.gross, b.otherEarnings,
        b.totalEarnings, b.totalDeductions, b.net, b.paidOn ?? "", b.paymentReference ?? "",
      ])),
    ]),
  }] : [];

  return (
    <ReportShell
      title="Contractor Bill Slips"
      subtitle="One page per contractor: routes, earnings, deductions and net payable"
      printOrientation="portrait"
      filters={
        <>
          <div>
            <FilterLabel>Billing month</FilterLabel>
            <MonthInput value={month} onChange={m => { setMonth(m); setGenerated(false); setContractor(null); }} max={todayIST().slice(0, 7)} className="w-40" />
          </div>
          {report && options.length > 0 && (
            <div>
              <FilterLabel>Contractor</FilterLabel>
              <F9SearchSelect value={contractor} onChange={setContractor} options={options} allowAll allLabel="All contractors" placeholder="All contractors" />
            </div>
          )}
        </>
      }
      onGenerate={onGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="DTC Bill"
          rows={[
            { label: "Billing Month", value: monthLong(month) },
            ...(report && report.run.status !== "approved" ? [{ label: "Status", value: `${RUN_STATUS_LABEL[report.run.status]} (not final)` }] : []),
          ]}
        />
      }
      state={{
        generated: generated && !!report,
        loading: isFetching && !report,
        pages,
        pageLabel: i => shown[i]?.name ?? "",
        emptyMessage: "No bills prepared for this month",
      }}
    />
  );
}

function SlipPage({ slip, report }: { slip: Slip; report: RunDetail }) {
  const first = slip.bills[0]!;
  const sum = (f: (b: Bill) => number) => slip.bills.reduce((s, b) => s + f(b), 0);
  const lines = slip.bills.flatMap(b => b.lines.map(l => ({ b, l })));
  const earnings = lines.filter(x => x.l.kind === "earning");
  const deductions = lines.filter(x => x.l.kind === "deduction");
  const net = sum(b => b.net);
  const paid = slip.bills.filter(b => b.paidOn);
  return (
    <div className="text-[11px] space-y-3">
      <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 border border-border p-2">
        <div><b>Contractor:</b> {slip.name}{first.contractorCode ? ` (${first.contractorCode})` : ""}</div>
        <div><b>Phone:</b> {first.contractorPhone ?? ""}</div>
        <div><b>Bank:</b> {first.bankName ?? ""} {first.accountNo ?? ""}</div>
        <div><b>IFSC:</b> {first.ifscCode ?? ""}</div>
        <div><b>PAN:</b> {first.panNumber ?? "not on record"}</div>
        <div><b>Month:</b> {monthLong(report.run.month)}</div>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className={th}>Route</th><th className={th}>Vehicle</th><th className={th}>Type</th>
            <th className={`${th} text-right`}>Days</th><th className={`${th} text-right`}>Km/Day</th>
            <th className={`${th} text-right`}>Rate</th><th className={`${th} text-right`}>Qty L/Kg</th>
            <th className={`${th} text-right`}>Gross</th>
          </tr>
        </thead>
        <tbody>
          {slip.bills.map(b => (
            <tr key={b.id}>
              <td className={td}>{b.routeName}</td>
              <td className={td}>{b.vehicleNumber ?? ""}</td>
              <td className={td}>{BILLING_TYPE_LABEL[b.billingType]}</td>
              <td className={`${td} text-right num`}>{b.days}</td>
              <td className={`${td} text-right num`}>{b.billingType === "km" ? rs2(b.kmPerDay) : ""}</td>
              <td className={`${td} text-right num`}>{rs2(b.rate)}</td>
              <td className={`${td} text-right num`}>{qtyFmt(b.qtyLitres)}</td>
              <td className={`${td} text-right num`}>{rs(b.gross)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {[["Other earnings", earnings], ["Deductions", deductions]].map(([title, rows]) => (
        <table key={title as string} className="w-full border-collapse">
          <thead>
            <tr className="bg-muted/50">
              <th className={th}>{title as string}</th><th className={th}>Route</th>
              <th className={`${th} text-right`}>Qty × Rate</th><th className={`${th} text-right`}>Amount</th><th className={th}>Remarks</th>
            </tr>
          </thead>
          <tbody>
            {(rows as typeof lines).length === 0 && <tr><td className={`${td} text-muted-foreground`} colSpan={5}>None</td></tr>}
            {(rows as typeof lines).map(({ b, l }) => (
              <tr key={l.id}>
                <td className={td}>{HEAD_LABEL[l.head] ?? l.head}</td>
                <td className={td}>{b.routeName}</td>
                <td className={`${td} text-right num`}>{l.qty != null && l.rate != null && l.head !== "tds" ? `${rs2(l.qty)} × ${rs2(l.rate)}` : ""}</td>
                <td className={`${td} text-right num`}>{rs2(l.amount)}</td>
                <td className={td}>{l.remarks ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ))}

      <table className="w-72 ml-auto border-collapse">
        <tbody>
          <tr><td className={td}>Gross payable</td><td className={`${td} text-right num`}>{rs(sum(b => b.gross))}</td></tr>
          <tr><td className={td}>Other earnings</td><td className={`${td} text-right num`}>{rs2(sum(b => b.otherEarnings))}</td></tr>
          <tr><td className={td}>Total earnings</td><td className={`${td} text-right num`}>{rs(sum(b => b.totalEarnings))}</td></tr>
          <tr><td className={td}>Total deductions</td><td className={`${td} text-right num`}>{rs(sum(b => b.totalDeductions))}</td></tr>
          <tr className="font-bold"><td className={td}>Net payable</td><td className={`${td} text-right num`}>₹{rs(Math.max(net, 0))}</td></tr>
          {net < 0 && <tr><td className={td} colSpan={2}>₹{rs(-net)} to be recovered from next month's bill</td></tr>}
        </tbody>
      </table>
      {paid.length > 0 && (
        <p>Paid: {paid.map(b => `₹${rs(b.paidAmount ?? b.payable)} on ${fmtDMY(b.paidOn)} by ${(b.paymentMode ?? "").toUpperCase()} ${b.paymentReference ?? ""}`).join("; ")}</p>
      )}

      <div className="grid grid-cols-3 gap-6 pt-12 text-center text-[10px]">
        <div className="border-t border-foreground/60 pt-1">Contractor's signature</div>
        <div className="border-t border-foreground/60 pt-1">MO (Mktg)</div>
        <div className="border-t border-foreground/60 pt-1">Manager (Finance)</div>
      </div>
    </div>
  );
}
