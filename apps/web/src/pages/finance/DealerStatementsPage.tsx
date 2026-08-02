// apps/web/src/pages/finance/DealerStatementsPage.tsx
// ════════════════════════════════════════════════════════════════════
// Finance → Dealer Statements  (/finance/dealer-statements, finance.view)
//
// Statement of Account, built on the standard ReportShell: pick a dealer
// and a date range, hit Generate, get a printable ledger.
//
// ONE view, day-grouped — invoices on the debit side, receipts (payments
// and wallet top-ups) on the credit side, with a subtotal line closing
// every day so the daily debit/credit reads off the same sheet as the
// voucher detail. The running Balance column IS the dealer's position:
// Cr = the union holds their money, Dr = they owe the union.
//
// Page 1 opens with the brought-forward balance; the final page carries
// period totals, the closing balance and the summary strip.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { fmtINR } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import {
  fetchCustomers, fetchDealerStatement,
  type StatementResponse, type StatementRow, type StatementKind,
} from "@/services/api";

// IST-local calendar date (toISOString would flip to UTC's date overnight).
const todayStr = () => new Date().toLocaleDateString("en-CA");
const monthStart = () => todayStr().slice(0, 8) + "01";

/** Cr = the union holds the dealer's money; Dr = the dealer owes us. */
const drcr = (n: number) => `${fmtINR(Math.abs(n))} ${n < 0 ? "Dr" : "Cr"}`;
/** A ledger column shows movement, not a wall of zeros. */
const money = (n: number) => (n ? fmtINR(n) : "");
/** dd-mm-yyyy — what the rest of the printed reports use. */
const shortDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return `${d}-${m}-${y}`;
};

const KIND_LABEL: Record<StatementKind, string> = {
  invoice: "Invoice",
  payment: "Receipt",
  topup: "Top-up",
  refund: "Refund",
  adjustment: "Adjustment",
};

// A4 portrait fits ~34 ledger lines under the letterhead + banner; leave
// headroom for the totals block that lands on the final page.
const ROWS_PER_PAGE = 30;

// A printed line is either the brought-forward balance, a voucher, or the
// subtotal that closes a day. Building one flat list lets the day grouping
// survive being chunked across pages.
type Line =
  | { t: "opening"; balance: number }
  | { t: "txn"; row: StatementRow }
  | { t: "day"; date: string; dr: number; cr: number; closing: number };

function buildLines(stmt: StatementResponse): Line[] {
  // rows arrive sorted by voucherDate, so one pass closes each day as the
  // date changes — no need to rescan the list per day.
  const totals = new Map(stmt.daily.map((d) => [d.date, d]));
  const lines: Line[] = [{ t: "opening", balance: stmt.openingBalance }];
  const closeDay = (date: string) => {
    const d = totals.get(date);
    if (d) lines.push({ t: "day", date, dr: d.totalDr, cr: d.totalCr, closing: d.closing });
  };

  let current: string | null = null;
  for (const row of stmt.rows) {
    if (current !== null && row.voucherDate !== current) closeDay(current);
    current = row.voucherDate;
    lines.push({ t: "txn", row });
  }
  if (current !== null) closeDay(current);
  return lines;
}

export default function DealerStatementsPage() {
  const [dealerId, setDealerId] = useState("");
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(todayStr());
  const [generated, setGenerated] = useState(false);

  const { data: customers = [] } = useQuery({
    queryKey: ["customers"], queryFn: fetchCustomers,
  });
  const dealerOptions: F9Option[] = useMemo(
    () => (customers as any[]).map((c) => ({
      value: String(c.id), label: String(c.name), sublabel: String(c.code ?? ""),
    })),
    [customers]
  );

  const { data, isLoading, refetch } = useQuery<StatementResponse>({
    queryKey: ["statement", dealerId, from, to],
    queryFn: () => fetchDealerStatement(dealerId, from, to),
    enabled: false,
  });

  const handleGenerate = async () => {
    if (!dealerId) return;
    await refetch();
    setGenerated(true);
  };

  const lines = useMemo(() => (data ? buildLines(data) : []), [data]);

  const pages: ReactNode[] = useMemo(() => {
    if (!generated || !data || data.rows.length === 0) return [];
    const chunks: Line[][] = [];
    for (let i = 0; i < lines.length; i += ROWS_PER_PAGE) {
      chunks.push(lines.slice(i, i + ROWS_PER_PAGE));
    }
    return chunks.map((chunk, i) => (
      <StatementPage
        key={i}
        stmt={data}
        lines={chunk}
        from={from}
        to={to}
        isLast={i === chunks.length - 1}
      />
    ));
  }, [generated, data, lines, from, to]);

  const dealerLabel = data
    ? `${data.dealer.code} — ${data.dealer.name}`
    : dealerOptions.find((o) => o.value === dealerId)?.label ?? "";

  // ── CSV export ───────────────────────────────────────────────────
  const exporters: Exporter[] = data ? [{
    label: "CSV",
    filename: `statement_${data.dealer.code}_${from}_${to}.csv`,
    mimeType: "text/csv",
    build: () => {
      const out: (string | number)[][] = [];
      out.push([`Statement of Account — ${dealerLabel}`]);
      out.push([`Period`, from, `to`, to]);
      out.push([]);
      out.push(["Date", "Type", "Voucher No", "Particulars", "Debit", "Credit", "Balance"]);
      out.push(["", "", "", "Opening Balance", "", "", data.openingBalance]);
      for (const l of lines) {
        if (l.t === "txn") {
          const r = l.row;
          out.push([
            r.voucherDate, KIND_LABEL[r.kind], r.voucherNo ?? "", r.particulars ?? "",
            r.type === "debit" ? r.amount : "",
            r.type === "credit" ? r.amount : "",
            r.balanceAfter,
          ]);
        } else if (l.t === "day") {
          out.push([l.date, "", "", `Total for ${l.date}`, l.dr, l.cr, l.closing]);
        }
      }
      out.push([]);
      out.push(["", "", "", "Period Totals", data.totals.debits, data.totals.credits, data.totals.closingBalance]);
      out.push([]);
      out.push(["Invoiced (Dr)", data.totals.invoices]);
      out.push(["Payments (Cr)", data.totals.payments]);
      out.push(["Top-ups (Cr)", data.totals.topups]);
      out.push(["Adjustments Dr / Cr", data.totals.adjustmentsDr, data.totals.adjustmentsCr]);
      out.push(["Refunds (Dr)", data.totals.refunds]);
      out.push(["Closing Balance", data.totals.closingBalance]);
      out.push(["Wallet Balance", data.wallet.balance]);
      return toCsv(out);
    },
  }] : [];

  return (
    <ReportShell
      title="Dealer Statement of Account"
      subtitle="Invoices on debit, receipts on credit — day-wise, for any period"
      printOrientation="portrait"
      filters={
        <>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
              Dealer
            </label>
            <div className="w-64">
              <F9SearchSelect
                value={dealerId}
                onChange={(v) => setDealerId(v ?? "")}
                options={dealerOptions}
                placeholder="Select dealer"
              />
            </div>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
              From
            </label>
            <Input type="date" value={from} onChange={e => setFrom(e.target.value)}
              className="erp-input w-40" />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
              To
            </label>
            <Input type="date" value={to} onChange={e => setTo(e.target.value)}
              className="erp-input w-40" />
          </div>
        </>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta
          title="Statement of Account"
          rows={[
            { label: "Dealer", value: dealerLabel || "—" },
            { label: "Route", value: data?.dealer.routeName ?? "—" },
            { label: "Period", value: `${shortDate(from)} to ${shortDate(to)}` },
          ]}
        />
      }
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel: (idx) => `Page ${idx + 1}`,
        emptyMessage: !dealerId
          ? "Select a dealer, then choose a period and press Generate"
          : "No transactions for this dealer in the selected period",
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// One printed page of the statement
// ─────────────────────────────────────────────────────────────────────
function StatementPage({
  stmt, lines, from, to, isLast,
}: {
  stmt: StatementResponse;
  lines: Line[];
  from: string;
  to: string;
  isLast: boolean;
}) {
  const t = stmt.totals;
  const d = stmt.dealer;

  return (
    <div>
      {/* Visible-on-screen banner (the global letterhead handles print) */}
      <div className="text-center mb-2">
        <p className="text-[12px] font-bold">Statement of Account</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          <span className="font-medium">{d.code} — {d.name}</span>
          {"  ·  "}Route: {d.routeName ?? "—"}
          {"  ·  "}From {shortDate(from)} to {shortDate(to)}
        </p>
      </div>

      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className="border border-border py-1.5 px-2 text-left  font-bold w-24">Date</th>
            <th className="border border-border py-1.5 px-2 text-left  font-bold w-24">Type</th>
            <th className="border border-border py-1.5 px-2 text-left  font-bold w-40">Voucher No</th>
            <th className="border border-border py-1.5 px-2 text-left  font-bold">Particulars</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold w-28 num">Debit</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold w-28 num">Credit</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold w-32 num">Balance</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => {
            if (l.t === "opening") {
              return (
                <tr key={`o${i}`} className="font-bold bg-muted/30">
                  <td className="border border-border py-1 px-2" colSpan={4}>
                    Opening Balance (brought forward)
                  </td>
                  <td className="border border-border py-1 px-2 num" />
                  <td className="border border-border py-1 px-2 num" />
                  <td className="border border-border py-1 px-2 text-right num">
                    {drcr(l.balance)}
                  </td>
                </tr>
              );
            }
            if (l.t === "day") {
              return (
                <tr key={`d${i}`} className="font-bold bg-muted/20">
                  <td className="border border-border py-1 px-2" colSpan={4}>
                    Total for {shortDate(l.date)}
                  </td>
                  <td className="border border-border py-1 px-2 text-right num">{money(l.dr)}</td>
                  <td className="border border-border py-1 px-2 text-right num">{money(l.cr)}</td>
                  <td className="border border-border py-1 px-2 text-right num">{drcr(l.closing)}</td>
                </tr>
              );
            }
            const r = l.row;
            return (
              <tr key={r.id}>
                <td className="border border-border py-1 px-2">{shortDate(r.voucherDate)}</td>
                <td className="border border-border py-1 px-2">{KIND_LABEL[r.kind]}</td>
                <td className="border border-border py-1 px-2 font-mono">{r.voucherNo ?? "—"}</td>
                <td className="border border-border py-1 px-2">{r.particulars ?? "—"}</td>
                <td className="border border-border py-1 px-2 text-right num">
                  {r.type === "debit" ? fmtINR(r.amount) : ""}
                </td>
                <td className="border border-border py-1 px-2 text-right num">
                  {r.type === "credit" ? fmtINR(r.amount) : ""}
                </td>
                <td className="border border-border py-1 px-2 text-right num">
                  {drcr(r.balanceAfter)}
                </td>
              </tr>
            );
          })}

          {isLast && (
            <tr className="font-bold bg-muted/40">
              <td className="border border-border py-1.5 px-2 text-right" colSpan={4}>
                PERIOD TOTALS
              </td>
              <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(t.debits)}</td>
              <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(t.credits)}</td>
              <td className="border border-border py-1.5 px-2 text-right num">{drcr(t.closingBalance)}</td>
            </tr>
          )}
        </tbody>
      </table>

      {isLast && (
        <>
          <table className="w-full text-[11px] border-collapse mt-3 no-ledger">
            <tbody>
              <tr>
                <SummaryCell label="Opening Balance" value={drcr(stmt.openingBalance)} />
                <SummaryCell label="Invoiced (Dr)" value={fmtINR(t.invoices)} />
                <SummaryCell label="Payments (Cr)" value={fmtINR(t.payments)} />
                <SummaryCell label="Top-ups (Cr)" value={fmtINR(t.topups)} />
              </tr>
              <tr>
                <SummaryCell label="Adjustments (Dr)" value={fmtINR(t.adjustmentsDr)} />
                <SummaryCell label="Adjustments (Cr)" value={fmtINR(t.adjustmentsCr)} />
                <SummaryCell label="Refunds (Dr)" value={fmtINR(t.refunds)} />
                <SummaryCell label="Closing Balance" value={drcr(t.closingBalance)} strong />
              </tr>
            </tbody>
          </table>

          <p className="text-[10px] mt-2 leading-relaxed">
            Dr = dealer owes the union · Cr = the union holds the dealer's money.
            Invoices are booked on their delivery date; receipts on the day the money arrived.
            Order modifications and cancellations are already reflected in the invoice amount,
            so they do not appear as separate adjustments.
          </p>
        </>
      )}
    </div>
  );
}

function SummaryCell({
  label, value, strong,
}: { label: string; value: string; strong?: boolean }) {
  return (
    <td className="border border-border py-1.5 px-2 w-1/4">
      <div className="text-[9.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`num ${strong ? "font-bold text-[12px]" : "font-medium"}`}>{value}</div>
    </td>
  );
}
