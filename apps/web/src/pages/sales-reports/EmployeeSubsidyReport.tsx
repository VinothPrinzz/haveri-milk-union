// apps/web/src/pages/sales-reports/EmployeeSubsidyReport.tsx
// ════════════════════════════════════════════════════════════════════
// Sales Reports → Employee Subsidy
//
// Three printable pages in one report, switchable from the pager:
//   1. Employee Subsidy — HTM 1000ML
//   2. Employee Subsidy — GHEE 500ML
//   3. Combined (both products side-by-side, per-employee totals)
//
// Columns (per-product pages, matches the client mockup):
//   sno · PF NO · Employee Name · Qty · Total Amount
//
// Columns (combined page):
//   sno · PF NO · Employee Name · HTM Qty · HTM ₹ · GHEE Qty · GHEE ₹ · Total ₹
//
// Letterhead: rendered via ReportPrintMeta (Haveri Milk Union) and now
// repeats on every printed page — see ReportShell.tsx.
// ════════════════════════════════════════════════════════════════════
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { fmtINR, fmtDate } from "@/components/PageHeader";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import {
  fetchEmployeeSubsidyReport,
  type EmployeeSubsidyReportResponse,
  type EmployeeSubsidyProductRow,
  type EmployeeSubsidyCombinedRow,
} from "@/services/report";

// Fixed product codes the report knows about. Anything else in the
// rules table is ignored on the per-product pages (still totalled in
// the combined page).
const PRODUCT_HTM  = "HTM-1000ML";
const PRODUCT_GHEE = "GHEE-500ML";

const fmtQty = (n: number | string) => String(Number(n || 0));

export default function EmployeeSubsidyReportPage() {
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = today.substring(0, 8) + "01";

  const [from, setFrom] = useState(monthStart);
  const [to, setTo] = useState(today);
  const [generated, setGenerated] = useState(false);

  const { data, isLoading, refetch } = useQuery<EmployeeSubsidyReportResponse>({
    queryKey: ["employee-subsidy-report", from, to],
    queryFn: () => fetchEmployeeSubsidyReport({ from, to }),
    enabled: false,
  });

  const handleGenerate = async () => {
    await refetch();
    setGenerated(true);
  };

  const htmProduct  = data?.products.find(p => p.label.toUpperCase() === PRODUCT_HTM)  ?? null;
  const gheeProduct = data?.products.find(p => p.label.toUpperCase() === PRODUCT_GHEE) ?? null;

  const htmRows  = htmProduct  ? (data?.perProduct[htmProduct.id]  ?? []) : [];
  const gheeRows = gheeProduct ? (data?.perProduct[gheeProduct.id] ?? []) : [];
  const combinedRows = data?.combined ?? [];

  const htmTotalQty  = htmRows.reduce((s, r) => s + r.qty, 0);
  const htmTotalAmt  = htmRows.reduce((s, r) => s + r.totalAmount, 0);
  const gheeTotalQty = gheeRows.reduce((s, r) => s + r.qty, 0);
  const gheeTotalAmt = gheeRows.reduce((s, r) => s + r.totalAmount, 0);
  const grandTotal   = data?.totals.grandTotal ?? 0;

  const pages: ReactNode[] = generated && data ? [
    <ProductPage
      key="htm"
      title="Statement of Subsidised HTM 1000ML Supplied to Employees"
      productLabel="HTM 1000ML"
      rows={htmRows}
      totalQty={htmTotalQty}
      totalAmount={htmTotalAmt}
      from={from}
      to={to}
    />,
    <ProductPage
      key="ghee"
      title="Statement of Subsidised GHEE 500ML Supplied to Employees"
      productLabel="GHEE 500ML"
      rows={gheeRows}
      totalQty={gheeTotalQty}
      totalAmount={gheeTotalAmt}
      from={from}
      to={to}
    />,
    <CombinedPage
      key="combined"
      title="Statement of Subsidised Goods Supplied to Employees (Combined)"
      rows={combinedRows}
      htmProductId={htmProduct?.id ?? null}
      gheeProductId={gheeProduct?.id ?? null}
      htmTotalQty={htmTotalQty}
      htmTotalAmt={htmTotalAmt}
      gheeTotalQty={gheeTotalQty}
      gheeTotalAmt={gheeTotalAmt}
      grandTotal={grandTotal}
      from={from}
      to={to}
    />,
  ] : [];

  const pageLabel = (idx: number) =>
    idx === 0 ? "HTM 1000ML" : idx === 1 ? "GHEE 500ML" : "Combined";

  // ── CSV export ───────────────────────────────────────────────────
  const exporters: Exporter[] = data ? [{
    label: "CSV",
    filename: `employee-subsidy_${from}_${to}.csv`,
    mimeType: "text/csv",
    build: () => {
      const out: (string | number)[][] = [];

      // Sheet 1 — HTM
      out.push([`Employee Subsidy — HTM 1000ML — ${from} to ${to}`]);
      out.push(["Sl", "PF NO", "Employee Name", "Qty", "Total Amount"]);
      htmRows.forEach((r, i) => out.push([
        i + 1, r.employeeCode ?? "", r.employeeName, r.qty, r.totalAmount,
      ]));
      out.push(["", "", "TOTAL", htmTotalQty, htmTotalAmt]);
      out.push([]);

      // Sheet 2 — GHEE
      out.push([`Employee Subsidy — GHEE 500ML — ${from} to ${to}`]);
      out.push(["Sl", "PF NO", "Employee Name", "Qty", "Total Amount"]);
      gheeRows.forEach((r, i) => out.push([
        i + 1, r.employeeCode ?? "", r.employeeName, r.qty, r.totalAmount,
      ]));
      out.push(["", "", "TOTAL", gheeTotalQty, gheeTotalAmt]);
      out.push([]);

      // Sheet 3 — Combined
      out.push([`Employee Subsidy — Combined — ${from} to ${to}`]);
      out.push(["Sl", "PF NO", "Employee Name",
                "HTM Qty", "HTM ₹", "GHEE Qty", "GHEE ₹", "Total ₹"]);
      combinedRows.forEach((r, i) => {
        const htmQty = htmProduct  ? (r.perProduct[htmProduct.id]?.qty    ?? 0) : 0;
        const htmAmt = htmProduct  ? (r.perProduct[htmProduct.id]?.amount ?? 0) : 0;
        const ghQty  = gheeProduct ? (r.perProduct[gheeProduct.id]?.qty    ?? 0) : 0;
        const ghAmt  = gheeProduct ? (r.perProduct[gheeProduct.id]?.amount ?? 0) : 0;
        out.push([
          i + 1, r.employeeCode ?? "", r.employeeName,
          htmQty, htmAmt, ghQty, ghAmt, r.totalAmount,
        ]);
      });
      out.push(["", "", "TOTAL",
                htmTotalQty, htmTotalAmt, gheeTotalQty, gheeTotalAmt, grandTotal]);

      return toCsv(out);
    },
  }] : [];

  return (
    <ReportShell
      title="Employee Subsidy Statement"
      subtitle="Subsidised goods supplied to employees · HTM 1000ML / GHEE 500ML / Combined"
      printOrientation="portrait"
      filters={
        <>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
              From
            </label>
            <Input
              type="date" value={from}
              onChange={e => setFrom(e.target.value)}
              className="erp-input w-40"
            />
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">
              To
            </label>
            <Input
              type="date" value={to}
              onChange={e => setTo(e.target.value)}
              className="erp-input w-40"
            />
          </div>
        </>
      }
      onGenerate={handleGenerate}
      exporters={exporters}
      printMeta={
        <ReportPrintMeta/>
      }
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel,
        emptyMessage: "No employee subsidy sales in this date range",
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Per-product page (HTM or GHEE)
// ─────────────────────────────────────────────────────────────────────
function ProductPage({
  title, productLabel, rows, totalQty, totalAmount, from, to,
}: {
  title: string;
  productLabel: string;
  rows: EmployeeSubsidyProductRow[];
  totalQty: number;
  totalAmount: number;
  from: string;
  to: string;
}) {
  return (
    <div>
      {/* Visible-on-screen banner (the global letterhead handles print) */}
      <div className="text-center mb-2">
        <p className="text-[12px] font-bold">{title}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Product: <span className="font-medium">{productLabel}</span>
          {"  ·  "}
          From {from} to {to}
        </p>
      </div>

      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className="border border-border py-1.5 px-2 text-right font-bold w-12">Sl</th>
            <th className="border border-border py-1.5 px-2 text-left  font-bold w-28">PF NO</th>
            <th className="border border-border py-1.5 px-2 text-left  font-bold">Employee Name</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold w-20 num">Qty</th>
            <th className="border border-border py-1.5 px-2 text-right font-bold w-32 num">Total Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className="border border-border py-3 px-2 text-center text-muted-foreground">
                No subsidised sales of {productLabel} in this period.
              </td>
            </tr>
          ) : rows.map((r, i) => (
            <tr key={r.employeeId}>
              <td className="border border-border py-1 px-2 text-right num">{i + 1}</td>
              <td className="border border-border py-1 px-2 font-mono">{r.employeeCode ?? "—"}</td>
              <td className="border border-border py-1 px-2">{r.employeeName}</td>
              <td className="border border-border py-1 px-2 text-right num">{fmtQty(r.qty)}</td>
              <td className="border border-border py-1 px-2 text-right num">{fmtINR(r.totalAmount)}</td>
            </tr>
          ))}
          {rows.length > 0 && (
            <tr className="font-bold bg-muted/40">
              <td colSpan={3} className="border border-border py-1.5 px-2 text-right">TOTAL</td>
              <td className="border border-border py-1.5 px-2 text-right num">{fmtQty(totalQty)}</td>
              <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(totalAmount)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────
// Combined page — per-employee row, both products side-by-side
// ─────────────────────────────────────────────────────────────────────
function CombinedPage({
  title, rows, htmProductId, gheeProductId,
  htmTotalQty, htmTotalAmt, gheeTotalQty, gheeTotalAmt, grandTotal,
  from, to,
}: {
  title: string;
  rows: EmployeeSubsidyCombinedRow[];
  htmProductId: string | null;
  gheeProductId: string | null;
  htmTotalQty: number;
  htmTotalAmt: number;
  gheeTotalQty: number;
  gheeTotalAmt: number;
  grandTotal: number;
  from: string;
  to: string;
}) {
  return (
    <div>
      <div className="text-center mb-2">
        <p className="text-[12px] font-bold">{title}</p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          From {from} to {to}
        </p>
      </div>

      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th rowSpan={2} className="border border-border py-1.5 px-2 text-right font-bold w-12">Sl</th>
            <th rowSpan={2} className="border border-border py-1.5 px-2 text-left  font-bold w-24">PF NO</th>
            <th rowSpan={2} className="border border-border py-1.5 px-2 text-left  font-bold">Employee Name</th>
            <th colSpan={2} className="border border-border py-1.5 px-2 text-center font-bold">HTM 1000ML</th>
            <th colSpan={2} className="border border-border py-1.5 px-2 text-center font-bold">GHEE 500ML</th>
            <th rowSpan={2} className="border border-border py-1.5 px-2 text-right font-bold w-32 num">Total ₹</th>
          </tr>
          <tr className="bg-muted/30">
            <th className="border border-border py-1 px-2 text-right font-bold w-16 num">Qty</th>
            <th className="border border-border py-1 px-2 text-right font-bold w-24 num">Amount</th>
            <th className="border border-border py-1 px-2 text-right font-bold w-16 num">Qty</th>
            <th className="border border-border py-1 px-2 text-right font-bold w-24 num">Amount</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={8} className="border border-border py-3 px-2 text-center text-muted-foreground">
                No employee subsidy sales in this period.
              </td>
            </tr>
          ) : rows.map((r, i) => {
            const htmQty = htmProductId  ? (r.perProduct[htmProductId]?.qty    ?? 0) : 0;
            const htmAmt = htmProductId  ? (r.perProduct[htmProductId]?.amount ?? 0) : 0;
            const ghQty  = gheeProductId ? (r.perProduct[gheeProductId]?.qty    ?? 0) : 0;
            const ghAmt  = gheeProductId ? (r.perProduct[gheeProductId]?.amount ?? 0) : 0;
            return (
              <tr key={r.employeeId}>
                <td className="border border-border py-1 px-2 text-right num">{i + 1}</td>
                <td className="border border-border py-1 px-2 font-mono">{r.employeeCode ?? "—"}</td>
                <td className="border border-border py-1 px-2">{r.employeeName}</td>
                <td className="border border-border py-1 px-2 text-right num">{fmtQty(htmQty)}</td>
                <td className="border border-border py-1 px-2 text-right num">{fmtINR(htmAmt)}</td>
                <td className="border border-border py-1 px-2 text-right num">{fmtQty(ghQty)}</td>
                <td className="border border-border py-1 px-2 text-right num">{fmtINR(ghAmt)}</td>
                <td className="border border-border py-1 px-2 text-right font-semibold num">{fmtINR(r.totalAmount)}</td>
              </tr>
            );
          })}
          {rows.length > 0 && (
            <tr className="font-bold bg-muted/40">
              <td colSpan={3} className="border border-border py-1.5 px-2 text-right">TOTAL</td>
              <td className="border border-border py-1.5 px-2 text-right num">{fmtQty(htmTotalQty)}</td>
              <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(htmTotalAmt)}</td>
              <td className="border border-border py-1.5 px-2 text-right num">{fmtQty(gheeTotalQty)}</td>
              <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(gheeTotalAmt)}</td>
              <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(grandTotal)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}