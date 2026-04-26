// apps/web/src/pages/finance/DealerLedgerPage.tsx
// ════════════════════════════════════════════════════════════════════
// Dealer Ledger / Wallet — /finance/ledger
//
// Layout (follows the ERP's standard PageShell pattern):
//   ├─ PageHeader: title + "Print Statement" CTA
//   └─ PageShell
//        ├─ FilterBar: Customer (F9, required) · From · To
//        ├─ Summary strip — 6 stat tiles:
//        │    Opening Balance · Total Debits · Total Credits ·
//        │    Closing Balance · Credit Limit · Available Credit
//        └─ ScrollableTableBody
//             Date | Voucher Type | Voucher No. | Particulars |
//             Debit | Credit | Running Balance
//
// Backend:
//   GET /api/v1/dealers/:id/ledger/summary?from=&to=
//     → { dealer, period, summary: { openingBalance, totalDebits,
//                                    totalCredits, closingBalance,
//                                    creditLimit, availableCredit } }
//   GET /api/v1/dealers/:id/ledger?from=&to=&page=&limit=
//     → { data: LedgerRow[], total, page, limit, totalPages }
//
//   Each LedgerRow carries a `running_delta` — the cumulative
//   credit − debit for the filtered range in chronological order.
//   Rows arrive in DESC order for display, so the running balance
//   shown against each row is:
//
//        runningBalance = openingBalance + Number(row.running_delta)
//
//   This matches the API's contract: openingBalance is
//   dealers.opening_balance + net of every ledger entry strictly
//   before `from`, and the window function in the API computes
//   running_delta so that the last (most recent) row lands on the
//   closing balance exactly.
//
// Print view:
//   Button in PageHeader → Dialog → <ReportViewer /> with A4 pages.
//   A separate unpaginated fetch (limit 1000) populates the print
//   pages, so the printed statement contains every row in the range
//   regardless of how the on-screen table is paged.
//
// Empty states:
//   • No customer selected → prompt tile.
//   • Customer selected, no rows → "No ledger activity in this range."
// ════════════════════════════════════════════════════════════════════

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import PageHeader from "@/components/PageHeader";
import { PageShell, FilterBar, ScrollableTableBody } from "@/components/PageShell";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { ReportViewer } from "@/components/ReportViewer";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Printer,
  Wallet,
  BookOpen,
  TrendingUp,
  TrendingDown,
  ShieldCheck,
  CircleDollarSign,
  Users,
  FileText,
} from "lucide-react";
import {
  fetchCustomers,
  fetchDealerLedger,
  fetchDealerLedgerSummary,
  type LedgerRow,
  type LedgerSummary,
} from "@/services/api";

// ── Formatters ────────────────────────────────────────────────
const fmtMoney = (n: number | string) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    minimumFractionDigits: 2,
  }).format(typeof n === "string" ? parseFloat(n) || 0 : n);

const fmtMoneyPlain = (n: number | string) =>
  new Intl.NumberFormat("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(typeof n === "string" ? parseFloat(n) || 0 : n);

const fmtDate = (iso: string | null) => {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-IN", {
    day:   "2-digit",
    month: "short",
    year:  "numeric",
  });
};

// ── Company info (matches InvoiceDetailPage + 0001 seed) ──────
const COMPANY = {
  name:    "Haveri District Co-operative Milk Producers' Union Ltd",
  gstin:   "29AABCH1234F1Z5",
  address: "Main Road, Haveri, Karnataka - 581110",
  phone:   "+91 8382 123456",
  email:   "admin@haverimunion.coop",
};

// ── Voucher type styling ──────────────────────────────────────
type VoucherType = NonNullable<LedgerRow["voucherType"]>;

const VOUCHER_LABELS: Record<VoucherType, string> = {
  Invoice:    "Invoice",
  Receipt:    "Receipt",
  Adjustment: "Adjustment",
  Opening:    "Opening",
  Refund:     "Refund",
};

const VOUCHER_STYLES: Record<VoucherType, string> = {
  Invoice:    "bg-blue-50 text-blue-700 border-blue-200",
  Receipt:    "bg-emerald-50 text-emerald-700 border-emerald-200",
  Adjustment: "bg-amber-50 text-amber-700 border-amber-200",
  Opening:    "bg-slate-100 text-slate-700 border-slate-300",
  Refund:     "bg-rose-50 text-rose-700 border-rose-200",
};

// ════════════════════════════════════════════════════════════════════
// PAGE
// ════════════════════════════════════════════════════════════════════
export default function DealerLedgerPage() {
  const [dealerId, setDealerId] = useState<string | null>(null);
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo,   setDateTo]   = useState("");
  const [page,     setPage]     = useState(1);
  const [printOpen, setPrintOpen] = useState(false);

  // Reset pagination whenever filters change.
  useEffect(() => {
    setPage(1);
  }, [dealerId, dateFrom, dateTo]);

  // ── Customers for F9 ─────────────────────────────────────────
  const { data: customers = [] } = useQuery({
    queryKey: ["customers"],
    queryFn: fetchCustomers,
  });

  const customerOptions: F9Option[] = useMemo(
    () =>
      customers.map((c: any) => ({
        value: c.id,
        label: c.name,
        sublabel: c.code,
        searchText: `${c.code ?? ""} ${c.name} ${c.phone ?? ""}`,
      })),
    [customers],
  );

  const selectedCustomer = useMemo(
    () => (dealerId ? (customers as any[]).find(c => c.id === dealerId) : null),
    [customers, dealerId],
  );

  // ── Summary (6 tiles) ────────────────────────────────────────
  const { data: summary, isLoading: summaryLoading, isFetching: summaryFetching } =
    useQuery({
      queryKey: ["dealer-ledger-summary", dealerId, dateFrom, dateTo],
      queryFn: () =>
        fetchDealerLedgerSummary(dealerId!, {
          from: dateFrom || undefined,
          to:   dateTo   || undefined,
        }),
      enabled: Boolean(dealerId),
    });

  // ── Paginated ledger rows for the on-screen table ────────────
  const { data: ledgerData, isLoading: rowsLoading } = useQuery({
    queryKey: ["dealer-ledger", dealerId, dateFrom, dateTo, page],
    queryFn: () =>
      fetchDealerLedger(dealerId!, {
        from:  dateFrom || undefined,
        to:    dateTo   || undefined,
        page,
        limit: 100,
      }),
    enabled: Boolean(dealerId),
  });

  const rows: LedgerRow[] = ledgerData?.data ?? [];
  const totalPages = ledgerData?.totalPages ?? 1;
  const totalRows  = ledgerData?.total ?? 0;

  const openingBalance = summary?.summary.openingBalance ?? 0;

  // Running balance = opening + cumulative delta from API window fn.
  const runningBalanceOf = (row: LedgerRow) =>
    openingBalance + Number(row.running_delta ?? 0);

  // ── Print fetch (unpaginated, lazy) ──────────────────────────
  const { data: printData, isLoading: printLoading } = useQuery({
    queryKey: ["dealer-ledger-print", dealerId, dateFrom, dateTo],
    queryFn: () =>
      fetchDealerLedger(dealerId!, {
        from:  dateFrom || undefined,
        to:    dateTo   || undefined,
        page:  1,
        limit: 1000,
      }),
    enabled: Boolean(dealerId && printOpen),
  });

  const canPrint = Boolean(dealerId) && !summaryLoading;

  return (
    <PageShell
      header={
        <>
          <PageHeader
            title="Dealer Ledger"
            description="Customer wallet, running balance, and statement view"
          >
            <Button
              variant="outline"
              size="sm"
              disabled={!canPrint}
              onClick={() => setPrintOpen(true)}
            >
              <Printer className="h-4 w-4 mr-1.5" />
              Print Statement
            </Button>
          </PageHeader>

          {/* ─ Filter bar ─ */}
          <FilterBar>
            <div className="min-w-[260px]">
              <label className="text-sm font-medium mb-1.5 block">
                Customer <span className="text-destructive">*</span>
              </label>
              <F9SearchSelect
                value={dealerId}
                onChange={setDealerId}
                options={customerOptions}
                placeholder="Search customer (F9)"
                allowClear
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">From</label>
              <input
                type="date"
                value={dateFrom}
                onChange={e => setDateFrom(e.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>

            <div>
              <label className="text-sm font-medium mb-1.5 block">To</label>
              <input
                type="date"
                value={dateTo}
                onChange={e => setDateTo(e.target.value)}
                className="h-9 w-44 rounded-md border border-input bg-background px-3 py-1 text-sm shadow-sm"
              />
            </div>

            {/* Opening balance display — lives inside the filter bar
                per spec so staff can sanity-check the range opening
                before scanning the table. */}
            <div className="ml-auto border-l pl-4">
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block">
                Opening Balance
              </label>
              <div className="text-base font-semibold font-mono">
                {dealerId
                  ? summaryLoading
                    ? <Skeleton className="h-6 w-28" />
                    : fmtMoney(openingBalance)
                  : <span className="text-muted-foreground">—</span>}
              </div>
            </div>

            {(summaryFetching || rowsLoading) && dealerId && (
              <div className="text-xs text-muted-foreground pb-2">
                Refreshing…
              </div>
            )}
          </FilterBar>

          {/* ─ Summary tiles ─ */}
          {dealerId && (
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
              <SummaryTile
                icon={<BookOpen className="h-4 w-4 text-slate-600" />}
                label="Opening Balance"
                value={summary}
                loading={summaryLoading}
                pick={s => s.summary.openingBalance}
              />
              <SummaryTile
                icon={<TrendingDown className="h-4 w-4 text-blue-600" />}
                label="Total Debits"
                value={summary}
                loading={summaryLoading}
                pick={s => s.summary.totalDebits}
                hint="Invoices in range"
              />
              <SummaryTile
                icon={<TrendingUp className="h-4 w-4 text-emerald-600" />}
                label="Total Credits"
                value={summary}
                loading={summaryLoading}
                pick={s => s.summary.totalCredits}
                hint="Payments in range"
              />
              <SummaryTile
                icon={<Wallet className="h-4 w-4 text-violet-600" />}
                label="Closing Balance"
                value={summary}
                loading={summaryLoading}
                pick={s => s.summary.closingBalance}
                emphasize
              />
              <SummaryTile
                icon={<ShieldCheck className="h-4 w-4 text-amber-600" />}
                label="Credit Limit"
                value={summary}
                loading={summaryLoading}
                pick={s => s.summary.creditLimit}
              />
              <SummaryTile
                icon={<CircleDollarSign className="h-4 w-4 text-indigo-600" />}
                label="Available Credit"
                value={summary}
                loading={summaryLoading}
                pick={s => s.summary.availableCredit}
              />
            </div>
          )}
        </>
      }
    >
      {/* ── Body ─────────────────────────────────────────────── */}
      {!dealerId ? (
        <EmptyHint
          icon={<Users className="h-10 w-10 mx-auto text-muted-foreground/50" />}
          title="Pick a customer"
          message="Choose a customer above to view their ledger, running balance, and statement."
        />
      ) : rowsLoading ? (
        <ScrollableTableBody className="p-4">
          <div className="space-y-2">
            {Array.from({ length: 10 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        </ScrollableTableBody>
      ) : rows.length === 0 ? (
        <EmptyHint
          icon={<FileText className="h-10 w-10 mx-auto text-muted-foreground/50" />}
          title="No ledger activity"
          message={
            dateFrom || dateTo
              ? "No entries in the selected date range. Try widening the range."
              : "This customer has no ledger entries yet."
          }
        />
      ) : (
        <div className="h-full flex flex-col">
          <ScrollableTableBody>
            <table className="w-full text-sm">
              <thead className="bg-muted/30 sticky top-0 z-10">
                <tr className="text-left">
                  <Th>Date</Th>
                  <Th>Voucher Type</Th>
                  <Th>Voucher No.</Th>
                  <Th>Particulars</Th>
                  <Th className="text-right">Debit</Th>
                  <Th className="text-right">Credit</Th>
                  <Th className="text-right">Running Balance</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map(row => {
                  const rb = runningBalanceOf(row);
                  return (
                    <tr
                      key={row.id}
                      className="border-t hover:bg-muted/20 transition-colors"
                    >
                      <Td className="whitespace-nowrap">
                        {fmtDate(row.voucherDate ?? row.createdAt)}
                      </Td>
                      <Td>
                        {row.voucherType ? (
                          <span
                            className={`inline-flex items-center rounded-md border px-2 py-0.5 text-[11px] font-medium ${VOUCHER_STYLES[row.voucherType]}`}
                          >
                            {VOUCHER_LABELS[row.voucherType]}
                          </span>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </Td>
                      <Td className="font-mono text-xs">
                        {row.voucherNo ?? "—"}
                      </Td>
                      <Td className="max-w-[320px] truncate">
                        {row.particulars ?? row.description ?? "—"}
                      </Td>
                      <Td className="text-right font-mono">
                        {row.type === "debit" ? fmtMoneyPlain(row.amount) : ""}
                      </Td>
                      <Td className="text-right font-mono">
                        {row.type === "credit" ? fmtMoneyPlain(row.amount) : ""}
                      </Td>
                      <Td
                        className={`text-right font-mono font-medium ${
                          rb < 0 ? "text-rose-700" : "text-foreground"
                        }`}
                      >
                        {fmtMoneyPlain(rb)}
                        {rb < 0 && (
                          <span className="text-[10px] ml-1 text-rose-700/80">
                            Dr
                          </span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollableTableBody>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex-shrink-0 border-t bg-card rounded-b-lg px-4 py-2 flex items-center justify-between text-sm">
              <span className="text-xs text-muted-foreground">
                Page {page} of {totalPages} · {totalRows} entries
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage(p => Math.max(1, p - 1))}
                >
                  Previous
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Print dialog ─────────────────────────────────────── */}
      <PrintStatementDialog
        open={printOpen}
        onClose={() => setPrintOpen(false)}
        customer={selectedCustomer}
        summary={summary}
        rows={printData?.data ?? []}
        loading={printLoading}
        dateFrom={dateFrom}
        dateTo={dateTo}
        openingBalance={openingBalance}
      />
    </PageShell>
  );
}

// ════════════════════════════════════════════════════════════════════
// Helpers — table cell primitives
// ════════════════════════════════════════════════════════════════════
function Th({
  children,
  className = "",
}: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={`text-xs font-semibold uppercase tracking-wide text-muted-foreground py-2 px-3 ${className}`}
    >
      {children}
    </th>
  );
}

function Td({
  children,
  className = "",
}: { children: React.ReactNode; className?: string }) {
  return <td className={`py-2 px-3 ${className}`}>{children}</td>;
}

// ════════════════════════════════════════════════════════════════════
// SummaryTile — one of the 6 cards
// ════════════════════════════════════════════════════════════════════
function SummaryTile({
  icon,
  label,
  value,
  loading,
  pick,
  hint,
  emphasize = false,
}: {
  icon:       React.ReactNode;
  label:      string;
  value:      LedgerSummary | undefined;
  loading:    boolean;
  pick:       (s: LedgerSummary) => number;
  hint?:      string;
  emphasize?: boolean;
}) {
  const num = value ? pick(value) : 0;
  const negative = num < 0;

  return (
    <Card className={emphasize ? "ring-1 ring-primary/20" : ""}>
      <CardContent className="p-3">
        <div className="flex items-center gap-2">
          {icon}
          <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
            {label}
          </span>
        </div>
        <div
          className={`mt-1.5 text-lg font-semibold font-mono ${
            negative ? "text-rose-700" : ""
          }`}
        >
          {loading ? <Skeleton className="h-6 w-24" /> : fmtMoney(num)}
        </div>
        {hint && !loading && (
          <div className="text-[10px] text-muted-foreground mt-0.5">{hint}</div>
        )}
      </CardContent>
    </Card>
  );
}

// ════════════════════════════════════════════════════════════════════
// EmptyHint — shared empty-state card
// ════════════════════════════════════════════════════════════════════
function EmptyHint({
  icon,
  title,
  message,
}: {
  icon: React.ReactNode;
  title: string;
  message: string;
}) {
  return (
    <div className="h-full flex items-center justify-center">
      <Card className="max-w-md">
        <CardContent className="p-10 text-center space-y-2">
          {icon}
          <h3 className="text-sm font-semibold">{title}</h3>
          <p className="text-xs text-muted-foreground">{message}</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ════════════════════════════════════════════════════════════════════
// PrintStatementDialog — opens a ReportViewer with A4 pages
// ════════════════════════════════════════════════════════════════════
function PrintStatementDialog({
  open,
  onClose,
  customer,
  summary,
  rows,
  loading,
  dateFrom,
  dateTo,
  openingBalance,
}: {
  open: boolean;
  onClose: () => void;
  customer: any;
  summary: LedgerSummary | undefined;
  rows: LedgerRow[];
  loading: boolean;
  dateFrom: string;
  dateTo: string;
  openingBalance: number;
}) {
  // Chunk rows into A4 pages. ~28 rows per page leaves room for the
  // header on page 1 and footer on the last page.
  const ROWS_PER_PAGE = 28;
  const pages = useMemo(() => {
    if (!customer || !summary) return [] as React.ReactNode[];

    const chunks: LedgerRow[][] = [];
    for (let i = 0; i < rows.length; i += ROWS_PER_PAGE) {
      chunks.push(rows.slice(i, i + ROWS_PER_PAGE));
    }
    // Always render at least one page, even if the range is empty.
    if (chunks.length === 0) chunks.push([]);

    return chunks.map((chunk, idx) =>
      renderStatementPage({
        customer,
        summary,
        chunk,
        isFirst: idx === 0,
        isLast:  idx === chunks.length - 1,
        pageNumber: idx + 1,
        totalPages: chunks.length,
        dateFrom,
        dateTo,
        openingBalance,
      }),
    );
  }, [customer, summary, rows, dateFrom, dateTo, openingBalance]);

  return (
    <Dialog open={open} onOpenChange={v => !v && onClose()}>
      <DialogContent className="max-w-5xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Dealer Ledger Statement</DialogTitle>
        </DialogHeader>

        {loading ? (
          <Skeleton className="h-[600px] w-full rounded-lg" />
        ) : pages.length === 0 ? (
          <Card>
            <CardContent className="p-10 text-center text-sm text-muted-foreground">
              Select a customer to preview the statement.
            </CardContent>
          </Card>
        ) : (
          <ReportViewer title="Ledger Statement" pages={pages} />
        )}
      </DialogContent>
    </Dialog>
  );
}

// ════════════════════════════════════════════════════════════════════
// A4 statement page renderer
// ════════════════════════════════════════════════════════════════════
function renderStatementPage({
  customer,
  summary,
  chunk,
  isFirst,
  isLast,
  pageNumber,
  totalPages,
  dateFrom,
  dateTo,
  openingBalance,
}: {
  customer: any;
  summary: LedgerSummary;
  chunk: LedgerRow[];
  isFirst: boolean;
  isLast: boolean;
  pageNumber: number;
  totalPages: number;
  dateFrom: string;
  dateTo: string;
  openingBalance: number;
}) {
  const dealerAddress = [
    customer.address,
    customer.city,
    customer.state,
    customer.zoneName,
  ]
    .filter(Boolean)
    .join(", ") || "—";

  const periodLabel = dateFrom || dateTo
    ? `${dateFrom ? fmtDate(dateFrom) : "Earliest"} → ${dateTo ? fmtDate(dateTo) : "Today"}`
    : "All transactions";

  const s = summary.summary;

  return (
    <div className="text-[11px] leading-relaxed text-black">
      {/* ── Page 1 header ── */}
      {isFirst && (
        <>
          <div className="border-b-2 border-black pb-2 mb-3">
            <div className="flex items-start justify-between gap-4">
              <div className="flex-1">
                <h1 className="text-base font-bold uppercase tracking-wide">
                  {COMPANY.name}
                </h1>
                <div className="text-[10px] mt-0.5">{COMPANY.address}</div>
                <div className="text-[10px] mt-0.5">
                  Phone: {COMPANY.phone} &nbsp;·&nbsp; Email: {COMPANY.email}
                </div>
                <div className="text-[10px] mt-0.5">
                  <strong>GSTIN:</strong> {COMPANY.gstin}
                </div>
              </div>
              <div className="text-right">
                <div className="text-sm font-bold uppercase tracking-widest">
                  Ledger Statement
                </div>
                <div className="text-[10px] mt-0.5 text-muted-foreground">
                  (CUSTOMER ACCOUNT)
                </div>
              </div>
            </div>
          </div>

          {/* ── Customer + Period block ── */}
          <div className="grid grid-cols-2 gap-4 mb-3">
            <div className="border rounded-sm p-2">
              <div className="text-[9px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                Customer
              </div>
              <div className="font-semibold text-[12px]">
                {customer.name}
                {customer.code && (
                  <span className="text-[10px] font-normal ml-1.5">
                    ({customer.code})
                  </span>
                )}
              </div>
              <div className="text-[10px] mt-1">{dealerAddress}</div>
              {customer.phone && (
                <div className="text-[10px] mt-0.5">
                  Phone: {customer.phone}
                </div>
              )}
              <div className="text-[10px] mt-0.5">
                <strong>Pay Mode:</strong> {customer.payMode ?? "—"}
                {" · "}
                <strong>Credit Limit:</strong> ₹{fmtMoneyPlain(s.creditLimit)}
              </div>
            </div>

            <div className="border rounded-sm p-2">
              <div className="text-[9px] uppercase tracking-wide text-muted-foreground font-semibold mb-1">
                Period
              </div>
              <div className="text-[12px] font-semibold">{periodLabel}</div>
              <div className="text-[10px] mt-2 grid grid-cols-2 gap-x-3 gap-y-0.5">
                <div>Opening Balance:</div>
                <div className="text-right font-mono">
                  ₹{fmtMoneyPlain(s.openingBalance)}
                </div>
                <div>Total Debits:</div>
                <div className="text-right font-mono">
                  ₹{fmtMoneyPlain(s.totalDebits)}
                </div>
                <div>Total Credits:</div>
                <div className="text-right font-mono">
                  ₹{fmtMoneyPlain(s.totalCredits)}
                </div>
                <div className="font-semibold">Closing Balance:</div>
                <div className="text-right font-mono font-semibold">
                  ₹{fmtMoneyPlain(s.closingBalance)}
                  {s.closingBalance < 0 && " Dr"}
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Ledger table ── */}
      <table className="w-full border-collapse text-[10px]">
        <thead>
          <tr className="bg-slate-100">
            <th className="border border-black py-1 px-2 text-left w-[70px]">
              Date
            </th>
            <th className="border border-black py-1 px-2 text-left w-[90px]">
              Voucher
            </th>
            <th className="border border-black py-1 px-2 text-left w-[110px]">
              Voucher No.
            </th>
            <th className="border border-black py-1 px-2 text-left">
              Particulars
            </th>
            <th className="border border-black py-1 px-2 text-right w-[75px]">
              Debit (₹)
            </th>
            <th className="border border-black py-1 px-2 text-right w-[75px]">
              Credit (₹)
            </th>
            <th className="border border-black py-1 px-2 text-right w-[85px]">
              Balance (₹)
            </th>
          </tr>
        </thead>
        <tbody>
          {chunk.length === 0 ? (
            <tr>
              <td
                colSpan={7}
                className="border border-black py-6 text-center text-muted-foreground"
              >
                No ledger activity in this range.
              </td>
            </tr>
          ) : (
            chunk.map(row => {
              const rb = openingBalance + Number(row.running_delta ?? 0);
              return (
                <tr key={row.id}>
                  <td className="border border-black py-1 px-2 whitespace-nowrap">
                    {fmtDate(row.voucherDate ?? row.createdAt)}
                  </td>
                  <td className="border border-black py-1 px-2">
                    {row.voucherType ? VOUCHER_LABELS[row.voucherType] : "—"}
                  </td>
                  <td className="border border-black py-1 px-2 font-mono text-[9px]">
                    {row.voucherNo ?? "—"}
                  </td>
                  <td className="border border-black py-1 px-2">
                    {row.particulars ?? row.description ?? "—"}
                  </td>
                  <td className="border border-black py-1 px-2 text-right font-mono">
                    {row.type === "debit" ? fmtMoneyPlain(row.amount) : ""}
                  </td>
                  <td className="border border-black py-1 px-2 text-right font-mono">
                    {row.type === "credit" ? fmtMoneyPlain(row.amount) : ""}
                  </td>
                  <td className="border border-black py-1 px-2 text-right font-mono">
                    {fmtMoneyPlain(rb)}
                    {rb < 0 && " Dr"}
                  </td>
                </tr>
              );
            })
          )}
        </tbody>
      </table>

      {/* ── Last-page totals + signature ── */}
      {isLast && (
        <>
          <table className="w-full border-collapse text-[10px] mt-3">
            <tbody>
              <tr>
                <td className="border border-black py-1 px-2 font-semibold bg-slate-50 w-[60%]">
                  Opening Balance
                </td>
                <td className="border border-black py-1 px-2 text-right font-mono">
                  ₹{fmtMoneyPlain(s.openingBalance)}
                </td>
              </tr>
              <tr>
                <td className="border border-black py-1 px-2">Total Debits (Invoices)</td>
                <td className="border border-black py-1 px-2 text-right font-mono">
                  ₹{fmtMoneyPlain(s.totalDebits)}
                </td>
              </tr>
              <tr>
                <td className="border border-black py-1 px-2">Total Credits (Receipts)</td>
                <td className="border border-black py-1 px-2 text-right font-mono">
                  ₹{fmtMoneyPlain(s.totalCredits)}
                </td>
              </tr>
              <tr>
                <td className="border border-black py-1 px-2 font-bold bg-slate-100">
                  Closing Balance
                </td>
                <td className="border border-black py-1 px-2 text-right font-mono font-bold">
                  ₹{fmtMoneyPlain(s.closingBalance)}
                  {s.closingBalance < 0 && " Dr"}
                </td>
              </tr>
              <tr>
                <td className="border border-black py-1 px-2">Credit Limit</td>
                <td className="border border-black py-1 px-2 text-right font-mono">
                  ₹{fmtMoneyPlain(s.creditLimit)}
                </td>
              </tr>
              <tr>
                <td className="border border-black py-1 px-2">Available Credit</td>
                <td className="border border-black py-1 px-2 text-right font-mono">
                  ₹{fmtMoneyPlain(s.availableCredit)}
                </td>
              </tr>
            </tbody>
          </table>

          <div className="mt-6 flex items-end justify-between">
            <div className="text-[9px] text-muted-foreground">
              This is a computer-generated statement. Please report any
              discrepancies within 7 days of receipt.
            </div>
            <div className="text-right">
              <div className="text-[10px] text-muted-foreground mb-8">
                For {COMPANY.name}
              </div>
              <div className="border-t border-black pt-1 inline-block min-w-[180px]">
                <div className="text-[10px]">Authorized Signatory</div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ── Page footer ── */}
      <div className="mt-4 pt-2 border-t text-center text-[9px] text-muted-foreground">
        Page {pageNumber} of {totalPages} &nbsp;·&nbsp; Subject to Haveri
        jurisdiction.
      </div>
    </div>
  );
}