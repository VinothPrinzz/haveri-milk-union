// apps/web/src/pages/finance/DayBookPage.tsx
// Finance → Day Book  (/finance/day-book, finance.view)
import { Fragment, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader, { StatCard, EmptyState, fmtINR, fmtDate, PrintButton } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { fetchDayBook, fetchRoutes, type DayBookKind, type DayBookLine } from "@/services/api";

// IST-local calendar date (toISOString would flip to UTC's date overnight).
const todayStr = () => new Date().toLocaleDateString("en-CA");

const TYPE_LABEL: Record<string, string> = {
  topup: "Top-up",
  topup_ledger: "Top-up (no receipt)",
  order_payment: "Order Payment",
  invoice_payment: "Invoice Payment",
  on_account: "On-account",
  order_sale: "Sale — Order",
  counter_sale: "Sale — Counter",
  refund: "Refund (Bank)",
  modify_refund: "Modify — Refund to Balance",
  modify_debit: "Modify — Debit from Balance",
  cancel_refund: "Cancel — Refund to Balance",
  cheque_bounce: "Cheque Bounced — Reversal",
  cheque_charges: "Cheque Return Charges",
  cheque_cancel: "Cheque Cancelled — Reversal",
  adjustment_credit: "Adjustment (Cr)",
  adjustment_debit: "Adjustment (Dr)",
};
const TYPE_TONE: Record<string, string> = {
  topup: "bg-success/15 text-success",
  topup_ledger: "bg-warning/20 text-warning",
  order_payment: "bg-success/15 text-success",
  invoice_payment: "bg-success/15 text-success",
  on_account: "bg-success/10 text-success",
  order_sale: "bg-info/15 text-info",
  counter_sale: "bg-info/10 text-info",
  refund: "bg-destructive/15 text-destructive",
  // Wallet movements are not cash out — keep them off the destructive tone
  // that signals money leaving the union.
  modify_refund: "bg-muted text-muted-foreground",
  modify_debit: "bg-muted text-muted-foreground",
  cancel_refund: "bg-muted text-muted-foreground",
  // A bounced cheque reverses money the union thought it had — still not a
  // cash outflow today, but finance needs it to stand out.
  cheque_bounce: "bg-warning/20 text-warning",
  cheque_charges: "bg-warning/10 text-warning",
  cheque_cancel: "bg-warning/20 text-warning",
  adjustment_credit: "bg-warning/10 text-warning",
  adjustment_debit: "bg-warning/10 text-warning",
};
// Online (gateway) settlement methods a dealer order can carry. Anything in
// s.sales.byMode that is neither of these two is treated as an online method
// and gets its own line — so a method only ever shows when it was used.
const WALLET_BUCKET = "wallet";
const CREDIT_BUCKET = "credit";
const ONLINE_METHOD_LABEL: Record<string, string> = {
  upi: "UPI",
  card: "Card",
  netbanking: "Net Banking",
};
const onlineMethodLabel = (k: string) =>
  ONLINE_METHOD_LABEL[k] ?? k.replace(/_/g, " ").toUpperCase();

const KIND_TABS: Array<{ key: DayBookKind | "all"; label: string }> = [
  { key: "all", label: "All" },
  { key: "receipt", label: "Receipts" },
  { key: "sale", label: "Sales" },
  { key: "refund", label: "Refunds" },
  { key: "adjustment", label: "Adjustments" },
];

const fmtTime = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });

export default function DayBookPage() {
  const [date, setDate] = useState(todayStr());
  const [routeId, setRouteId] = useState<string | null>(null);
  const [kind, setKind] = useState<DayBookKind | "all">("all");
  const [physicalCount, setPhysicalCount] = useState("");

  const { data: routes = [] } = useQuery({ queryKey: ["routes"], queryFn: fetchRoutes });
  const routeOptions: F9Option[] = useMemo(
    () => [
      ...(routes as any[]).map((r) => ({ value: String(r.id), label: r.name, sublabel: r.code })),
      { value: "unassigned", label: "— Unassigned —" },
    ],
    [routes]
  );

  const { data, isLoading } = useQuery({
    queryKey: ["day-book", date, routeId],
    queryFn: () => fetchDayBook(date, routeId),
  });

  const cashCollected = data?.summary.cashCollected ?? 0;
  const variance = useMemo(() => {
    if (physicalCount === "") return null;
    return Number(physicalCount) - cashCollected;
  }, [physicalCount, cashCollected]);

  const visible: DayBookLine[] = useMemo(
    () => (data?.lines ?? []).filter((l) => kind === "all" || l.kind === kind),
    [data, kind]
  );
  // "Out" is cash that actually left the union — gateway refunds to a bank
  // account, nothing else. Credits back to a dealer's balance (modify down,
  // cancellation) and debits taken from it (modify up) only move the wallet
  // liability, and the sale line already carries the modified total, so they
  // get their own tally instead of being netted against the day's money.
  const visibleTotals = useMemo(() => {
    const t = { in: 0, sales: 0, out: 0, toBalance: 0, fromBalance: 0 };
    for (const l of visible) {
      if (l.cashImpact === "out") t.out += l.amount;
      else if (l.cashImpact === "in") t.in += l.amount;
      else if (l.kind === "sale") t.sales += l.amount;
      // Everything left is a balance movement. Credits (refunds back, journal
      // credits, receipt-less top-ups) raise the dealer's balance; the rest
      // (modify-up debits, cheque reversals, debit notes) lower it.
      else if (l.kind === "refund" || l.type === "adjustment_credit" || l.type === "topup_ledger")
        t.toBalance += l.amount;
      else t.fromBalance += l.amount;
    }
    return t;
  }, [visible]);

  const s = data?.summary;

  return (
    <div className="flex flex-col h-full">
      <PageHeader title="Day Book" subtitle="Daily cash book — receipts, sales, refunds & adjustments; close the day & tally physical cash"
        actions={<PrintButton label="Print Day Book" />} />

      <div className="flex items-end gap-3 px-4 py-2.5 bg-panel border-b border-border no-print">
        <div>
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Date</label>
          <Input type="date" value={date} onChange={e => setDate(e.target.value)} className="erp-input w-40" />
        </div>
        <div className="min-w-[200px]">
          <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Route</label>
          <F9SearchSelect value={routeId} onChange={setRouteId} options={routeOptions} placeholder="All routes" />
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4 space-y-4">
        {isLoading ? (
          <div className="space-y-3">{Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-16 w-full" />)}</div>
        ) : data && s ? (<>
          {/* Summary strip */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
            <StatCard label="Total Receipts (money in)" value={fmtINR(s.totalReceipts)} />
            <StatCard label="Total Sales" tone="info" value={fmtINR(s.sales.total)} />
            <StatCard label="Cash" tone="success" value={fmtINR(s.byMode["cash"] ?? 0)} />
            <StatCard label="UPI" value={fmtINR(s.byMode["upi"] ?? 0)} />
            <StatCard label="Refunds Out (bank)" tone="warning" value={fmtINR(s.refundsOut)}
              hint={s.orderChanges.refundsToBalance > 0
                ? `+ ${fmtINR(s.orderChanges.refundsToBalance)} credited back to dealer balances — no cash out`
                : undefined} />
            <StatCard label="Net Receipts" value={fmtINR(s.net)} />
          </div>

          {/* Receipts vs sales composition — why receipts ≠ sales */}
          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-3">
            <div className="erp-panel p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Receipts by purpose</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
                <span className="text-muted-foreground">Wallet top-ups</span><span className="num text-right">{fmtINR(s.byType["topup"] ?? 0)}</span>
                <span className="text-muted-foreground">Order payments</span><span className="num text-right">{fmtINR(s.byType["order_payment"] ?? 0)}</span>
                <span className="text-muted-foreground">Invoice payments</span><span className="num text-right">{fmtINR(s.byType["invoice_payment"] ?? 0)}</span>
                <span className="text-muted-foreground">On-account</span><span className="num text-right">{fmtINR(s.byType["on_account"] ?? 0)}</span>
              </div>
              {s.ledgerTopups.count > 0 && (
                <div className="mt-2 text-[11px] rounded bg-warning/10 text-warning px-2 py-1">
                  {s.ledgerTopups.count} wallet credit{s.ledgerTopups.count > 1 ? "s" : ""} of {fmtINR(s.ledgerTopups.total)} recorded without a receipt — not counted in Total Receipts.
                </div>
              )}
            </div>
            <div className="erp-panel p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Sales composition</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
                <span className="text-muted-foreground">Dealer orders ({s.sales.ordersCount})</span><span className="num text-right">{fmtINR(s.sales.ordersTotal)}</span>
                <span className="text-muted-foreground pl-3">· paid from wallet</span><span className="num text-right">{fmtINR(s.sales.byMode[WALLET_BUCKET] ?? 0)}</span>
                {Object.entries(s.sales.byMode)
                  .filter(([k, v]) => k !== WALLET_BUCKET && k !== CREDIT_BUCKET && v > 0)
                  .sort((a, b) => b[1] - a[1])
                  .map(([k, v]) => (
                    <Fragment key={k}>
                      <span className="text-muted-foreground pl-3">· paid online — {onlineMethodLabel(k)}</span><span className="num text-right">{fmtINR(v)}</span>
                    </Fragment>
                  ))}
                <span className="text-muted-foreground pl-3">· on credit</span><span className="num text-right">{fmtINR(s.sales.byMode[CREDIT_BUCKET] ?? 0)}</span>
                <span className="text-muted-foreground">Counter sales ({s.sales.counterCount})</span><span className="num text-right">{fmtINR(s.sales.counterTotal)}</span>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                Wallet covers orders settled from available balance or top-ups; pay-now orders show under their online method (UPI/card). Receipts and sales differ when a top-up is bigger than the order — the balance stays in the dealer&apos;s wallet — or when orders go on credit.
              </div>
            </div>
            <div className="erp-panel p-3">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Refunds &amp; order changes</div>
              <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-[12px]">
                <span className="text-muted-foreground">Bank refunds ({s.refundsCount}) — cash out</span><span className="num text-right text-destructive">{fmtINR(s.refundsOut)}</span>
                <span className="text-muted-foreground pt-1 col-span-2 text-[11px] uppercase tracking-wide">Dealer balance — no cash movement</span>
                <span className="text-muted-foreground pl-3">· refunds to balance ({s.orderChanges.refundsCount})</span><span className="num text-right">{fmtINR(s.orderChanges.refundsToBalance)}</span>
                <span className="text-muted-foreground pl-3">· extra debits — modify ({s.orderChanges.debitsCount})</span><span className="num text-right">{fmtINR(s.orderChanges.extraDebits)}</span>
                <span className="text-muted-foreground pl-3">· net to dealer balances</span><span className="num text-right">{fmtINR(s.orderChanges.netToWallet)}</span>
              </div>
              <div className="mt-2 text-[11px] text-muted-foreground">
                Only bank refunds take money out of the union. Indent modifications and cancellations just move the dealer&apos;s own balance — his wallet is money the union already holds, so crediting it back is not an outflow, and the sale above is already shown net of the change. Counting it twice would understate the day.
              </div>
            </div>
          </div>

          {/* Cash card */}
          <div className="erp-panel p-4">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground mb-2">Cash position (informational — deposit tracking not persisted in v1)</div>
            <div className="flex items-end gap-6 flex-wrap">
              <div>
                <div className="text-[11px] text-muted-foreground">Cash collected today</div>
                <div className="text-[18px] font-semibold num">{fmtINR(cashCollected)}</div>
              </div>
              <div className="no-print">
                <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Physical count</label>
                <Input type="number" min="0" step="0.01" value={physicalCount} onChange={e => setPhysicalCount(e.target.value)} placeholder="Enter counted cash" className="erp-input num w-40" />
              </div>
              {variance !== null && (
                <div>
                  <div className="text-[11px] text-muted-foreground">Variance</div>
                  <div className={`text-[18px] font-semibold num ${Math.abs(variance) < 0.01 ? "text-success" : "text-destructive"}`}>{fmtINR(variance)}</div>
                </div>
              )}
            </div>
          </div>

          {/* Route-wise breakdown */}
          <div className="erp-panel overflow-hidden">
            <div className="px-4 py-2 text-[11px] uppercase tracking-wide text-muted-foreground border-b border-border">Route-wise receipts &amp; sales</div>
            {data.routeWise.length === 0 ? <div className="p-3 text-[12px] text-muted-foreground">No transactions today.</div> : (
              <table className="erp-table">
                <thead><tr>
                  <th>Route</th>
                  <th className="num" style={{ textAlign: "right" }}>Receipts</th>
                  <th className="num" style={{ textAlign: "right" }}>Collected</th>
                  <th className="num" style={{ textAlign: "right" }}>of which Cash</th>
                  <th className="num" style={{ textAlign: "right" }}>Orders</th>
                  <th className="num" style={{ textAlign: "right" }}>Sales</th>
                </tr></thead>
                <tbody>
                  {data.routeWise.map((r, i) => (
                    <tr key={i}>
                      <td>{r.name ?? "— Unassigned —"}</td>
                      <td className="num" style={{ textAlign: "right" }}>{r.receipts}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(r.collected)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(r.cash)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{r.orders}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(r.sales)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          {/* Day-book lines */}
          <div className="erp-panel overflow-hidden">
            <div className="px-4 py-2 flex items-center justify-between border-b border-border">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">Transactions — {fmtDate(date)}</span>
              <div className="flex gap-1 no-print">
                {KIND_TABS.map(t => (
                  <button key={t.key} onClick={() => setKind(t.key)}
                    className={`px-2 py-0.5 rounded text-[11px] border ${kind === t.key ? "bg-primary text-primary-foreground border-primary" : "border-border text-muted-foreground hover:bg-panel"}`}>
                    {t.label}
                  </button>
                ))}
              </div>
            </div>
            {visible.length === 0 ? <EmptyState title="No transactions on this day" /> : (
              <table className="erp-table">
                <thead>
                  <tr>
                    <th>Time</th><th>Type</th><th>Dealer / Customer</th><th>Route</th><th>Mode</th>
                    <th>Reference</th><th>Doc / Invoice</th><th>By</th>
                    <th className="num" style={{ textAlign: "right" }}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((l) => {
                    // Only true cash out is signed and painted red; balance
                    // movements are shown plain so they don't read as an
                    // outflow the union never made.
                    const out = l.cashImpact === "out";
                    const balanceMove = l.cashImpact === "none" && l.kind !== "sale";
                    return (
                      <tr key={`${l.kind}-${l.id}`}>
                        <td className="text-[12px] num">{fmtTime(l.at)}</td>
                        <td><span className={`inline-block px-1.5 py-0.5 rounded text-[11px] font-medium ${TYPE_TONE[l.type] ?? "bg-muted text-muted-foreground"}`}>{TYPE_LABEL[l.type] ?? l.type}</span></td>
                        <td className="font-medium">{l.dealerName ?? "—"} {l.dealerCode && <span className="text-muted-foreground font-mono text-[11px]">{l.dealerCode}</span>}</td>
                        <td className="text-[12px]">{l.routeName ?? "—"}</td>
                        <td className="capitalize text-[12px]">{l.mode ?? "—"}</td>
                        <td className="text-[12px] font-mono max-w-[220px] truncate" title={l.reference ?? undefined}>{l.reference ?? "—"}</td>
                        <td className="text-[12px] font-mono">{l.docNo ?? "—"}</td>
                        <td className="text-[12px]">{l.byName ?? "—"}</td>
                        <td className={`num font-medium ${out ? "text-destructive" : balanceMove ? "text-muted-foreground" : l.kind === "sale" ? "text-info" : "text-success"}`} style={{ textAlign: "right" }}>
                          {out ? "−" : ""}{fmtINR(l.amount)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr className="font-medium border-t border-border">
                    <td colSpan={8} className="text-[12px] text-muted-foreground">
                      Totals (shown rows) — Receipts in: <span className="text-success num">{fmtINR(visibleTotals.in)}</span>
                      {" · "}Sales: <span className="text-info num">{fmtINR(visibleTotals.sales)}</span>
                      {" · "}Cash out: <span className="text-destructive num">{fmtINR(visibleTotals.out)}</span>
                      {(visibleTotals.toBalance > 0 || visibleTotals.fromBalance > 0) && (<>
                        {" · "}To dealer balances: <span className="num">{fmtINR(visibleTotals.toBalance)}</span>
                        {" · "}From dealer balances: <span className="num">{fmtINR(visibleTotals.fromBalance)}</span>
                        {" "}<span className="text-[11px]">(no cash movement)</span>
                      </>)}
                    </td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            )}
          </div>
        </>) : null}
      </div>
    </div>
  );
}
