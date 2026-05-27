// apps/web/src/pages/sales-reports/EmployeeSubsidyReport.tsx
// ════════════════════════════════════════════════════════════════════
// Sales Reports → Employee Subsidy   (product-agnostic rewrite)
//
// One printable page per product configured in employee_subsidy_rules,
// followed by a Combined page (every product side-by-side, per-employee
// totals). Switchable from the pager.
//
// Previous version hardcoded exactly two products (HTM-1000ML /
// GHEE-500ML) and matched them by label — so any alias mismatch, or the
// (commonly missing) GHEE rule, left the report blank. This version
// renders whatever products the endpoint returns from the rules table.
//
// Per-product page columns:  Sl · PF NO · Employee Name · Qty · Total Amount
// Combined page columns:     Sl · PF NO · Employee Name ·
//                            [Qty · Amount] per product · Total ₹
// ════════════════════════════════════════════════════════════════════
import { useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Input } from "@/components/ui/input";
import { fmtINR } from "@/components/PageHeader";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { toCsv } from "@/lib/exporters";
import {
  fetchEmployeeSubsidyReport,
  type EmployeeSubsidyReportResponse,
  type EmployeeSubsidyProductRow,
  type EmployeeSubsidyCombinedRow,
} from "@/services/report";

// Product shape, derived from the response so we don't depend on a
// separately-exported type name.
type SubsidyProduct = EmployeeSubsidyReportResponse["products"][number];

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

  // Every product configured in employee_subsidy_rules, in endpoint order.
  const products: SubsidyProduct[] = data?.products ?? [];

  // Per-product rows + totals, computed from whatever came back.
  const perProductData = products.map(p => {
    const rows = data?.perProduct[p.id] ?? [];
    return {
      product: p,
      rows,
      totalQty:    rows.reduce((s, r) => s + r.qty, 0),
      totalAmount: rows.reduce((s, r) => s + r.totalAmount, 0),
    };
  });
  const combinedRows = data?.combined ?? [];
  const grandTotal   = data?.totals.grandTotal ?? 0;

  const pages: ReactNode[] = generated && data && products.length > 0
    ? [
        ...perProductData.map(pd => (
          <ProductPage
            key={pd.product.id}
            product={pd.product}
            rows={pd.rows}
            totalQty={pd.totalQty}
            totalAmount={pd.totalAmount}
            from={from}
            to={to}
          />
        )),
        <CombinedPage
          key="combined"
          products={products}
          rows={combinedRows}
          perProductTotals={perProductData.map(pd => ({
            id: pd.product.id,
            totalQty: pd.totalQty,
            totalAmount: pd.totalAmount,
          }))}
          grandTotal={grandTotal}
          from={from}
          to={to}
        />,
      ]
    : [];

  const pageLabel = (idx: number) =>
    idx < products.length ? products[idx].label : "Combined";

  // ── CSV export ───────────────────────────────────────────────────
  const exporters: Exporter[] = data ? [{
    label: "CSV",
    filename: `employee-subsidy_${from}_${to}.csv`,
    mimeType: "text/csv",
    build: () => {
      const out: (string | number)[][] = [];

      // One sheet per product.
      for (const pd of perProductData) {
        out.push([`Employee Subsidy — ${pd.product.label} — ${from} to ${to}`]);
        out.push(["Sl", "PF NO", "Employee Name", "Qty", "Total Amount"]);
        pd.rows.forEach((r, i) => out.push([
          i + 1, r.employeeCode ?? "", r.employeeName, r.qty, r.totalAmount,
        ]));
        out.push(["", "", "TOTAL", pd.totalQty, pd.totalAmount]);
        out.push([]);
      }

      // Combined sheet — dynamic columns.
      out.push([`Employee Subsidy — Combined — ${from} to ${to}`]);
      const header: (string | number)[] = ["Sl", "PF NO", "Employee Name"];
      for (const p of products) header.push(`${p.label} Qty`, `${p.label} ₹`);
      header.push("Total ₹");
      out.push(header);

      combinedRows.forEach((r, i) => {
        const row: (string | number)[] = [i + 1, r.employeeCode ?? "", r.employeeName];
        for (const p of products) {
          row.push(r.perProduct[p.id]?.qty ?? 0, r.perProduct[p.id]?.amount ?? 0);
        }
        row.push(r.totalAmount);
        out.push(row);
      });

      const totalRow: (string | number)[] = ["", "", "TOTAL"];
      for (const pd of perProductData) totalRow.push(pd.totalQty, pd.totalAmount);
      totalRow.push(grandTotal);
      out.push(totalRow);

      return toCsv(out);
    },
  }] : [];

  return (
    <ReportShell
      title="Employee Subsidy Statement"
      subtitle="Subsidised goods supplied to employees — one page per product, plus a combined view"
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
      printMeta={<ReportPrintMeta />}
      state={{
        generated,
        loading: isLoading,
        pages,
        pageLabel,
        emptyMessage:
          generated && data && products.length === 0
            ? "No subsidy products configured — add rows to employee_subsidy_rules first"
            : "No employee subsidy sales in this date range",
      }}
    />
  );
}

// ─────────────────────────────────────────────────────────────────────
// Per-product page
// ─────────────────────────────────────────────────────────────────────
function ProductPage({
  product, rows, totalQty, totalAmount, from, to,
}: {
  product: SubsidyProduct;
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
        <p className="text-[12px] font-bold">
          Statement of Subsidised {product.label} Supplied to Employees
        </p>
        <p className="text-[11px] text-muted-foreground mt-0.5">
          Product: <span className="font-medium">{product.label}</span>
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
                No subsidised sales of {product.label} in this period.
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
// Combined page — per-employee row, every product side-by-side
// ─────────────────────────────────────────────────────────────────────
function CombinedPage({
  products, rows, perProductTotals, grandTotal, from, to,
}: {
  products: SubsidyProduct[];
  rows: EmployeeSubsidyCombinedRow[];
  perProductTotals: Array<{ id: string; totalQty: number; totalAmount: number }>;
  grandTotal: number;
  from: string;
  to: string;
}) {
  // Sl + PF NO + Name + (Qty,Amount per product) + Total
  const colCount = 3 + products.length * 2 + 1;

  return (
    <div>
      <div className="text-center mb-2">
        <p className="text-[12px] font-bold">
          Statement of Subsidised Goods Supplied to Employees (Combined)
        </p>
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
            {products.map(p => (
              <th key={p.id} colSpan={2}
                  className="border border-border py-1.5 px-2 text-center font-bold">
                {p.label}
              </th>
            ))}
            <th rowSpan={2} className="border border-border py-1.5 px-2 text-right font-bold w-32 num">Total ₹</th>
          </tr>
          <tr className="bg-muted/30">
            {products.map(p => (
              <FragmentCols key={p.id} />
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={colCount} className="border border-border py-3 px-2 text-center text-muted-foreground">
                No employee subsidy sales in this period.
              </td>
            </tr>
          ) : rows.map((r, i) => (
            <tr key={r.employeeId}>
              <td className="border border-border py-1 px-2 text-right num">{i + 1}</td>
              <td className="border border-border py-1 px-2 font-mono">{r.employeeCode ?? "—"}</td>
              <td className="border border-border py-1 px-2">{r.employeeName}</td>
              {products.map(p => (
                <FragmentCells
                  key={p.id}
                  qty={r.perProduct[p.id]?.qty ?? 0}
                  amount={r.perProduct[p.id]?.amount ?? 0}
                />
              ))}
              <td className="border border-border py-1 px-2 text-right font-semibold num">
                {fmtINR(r.totalAmount)}
              </td>
            </tr>
          ))}
          {rows.length > 0 && (
            <tr className="font-bold bg-muted/40">
              <td colSpan={3} className="border border-border py-1.5 px-2 text-right">TOTAL</td>
              {perProductTotals.map(t => (
                <FragmentCells key={t.id} qty={t.totalQty} amount={t.totalAmount} />
              ))}
              <td className="border border-border py-1.5 px-2 text-right num">{fmtINR(grandTotal)}</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

// Two sub-header cells (Qty / Amount) for one product.
function FragmentCols() {
  return (
    <>
      <th className="border border-border py-1 px-2 text-right font-bold w-16 num">Qty</th>
      <th className="border border-border py-1 px-2 text-right font-bold w-24 num">Amount</th>
    </>
  );
}

// Two body cells (qty / amount) for one product.
function FragmentCells({ qty, amount }: { qty: number; amount: number }) {
  return (
    <>
      <td className="border border-border py-1 px-2 text-right num">{fmtQty(qty)}</td>
      <td className="border border-border py-1 px-2 text-right num">{fmtINR(amount)}</td>
    </>
  );
}