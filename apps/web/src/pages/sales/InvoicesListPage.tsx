// ════════════════════════════════════════════════════════════════════
// Invoices List — searchable list with status & date filters
// Route preserved: /sales/invoices
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import PageHeader, {
  FilterBar, Field, EmptyState, StatusPill, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Printer, X } from "lucide-react";
import { fetchInvoicesList as fetchInvoices } from "@/services/api";

const STATUS_OPTS: F9Option[] = [
  { value: "draft", label: "Draft" },
  { value: "issued", label: "Issued" },
  { value: "paid", label: "Paid" },
  { value: "partial", label: "Partial" },
  { value: "cancelled", label: "Cancelled" },
];

export default function InvoicesListPage() {
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(monthAgo);
  const [to, setTo] = useState(today);
  const [status, setStatus] = useState<string | null>(null);
  const [q, setQ] = useState("");

  const { data: invoicesData, isLoading } = useQuery({
    queryKey: ["invoices", { from, to, status }],
    queryFn: () => fetchInvoices({ dateFrom: from, dateTo: to, paymentStatus: (status ?? undefined) as any }),
  });
  const invoices = invoicesData?.data ?? [];

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return invoices;
    return invoices.filter((i: any) =>
      (i.invoiceNumber ?? i.number ?? i.code ?? "").toLowerCase().includes(s) ||
      (i.dealerName ?? i.customerName ?? "").toLowerCase().includes(s)
    );
  }, [invoices, q]);

  const grand = filtered.reduce((s: number, i: any) => s + parseFloat(String(i.totalAmount ?? i.total ?? 0)), 0);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Invoices"
        subtitle="All invoices issued to dealers and customers"
        actions={
          <Button size="sm" variant="outline" className="h-8" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5 mr-1" /> Print List
          </Button>
        }
      />

      <FilterBar>
        <Field label="From"><Input type="date" className="erp-input w-36" value={from} onChange={e => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" className="erp-input w-36" value={to} onChange={e => setTo(e.target.value)} /></Field>
        <Field label="Status"><F9SearchSelect value={status} onChange={setStatus} options={STATUS_OPTS} allowAll className="w-44" /></Field>
        <Field label="Search"><Input className="erp-input w-72" placeholder="invoice # / customer" value={q} onChange={e => setQ(e.target.value)} /></Field>
        {(status || q) && (
          <div className="flex items-end">
            <Button size="sm" variant="outline" className="h-8" onClick={() => { setStatus(null); setQ(""); }}>
              <X className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          </div>
        )}
      </FilterBar>

      <div className="flex-1 overflow-auto p-3">
        <div className="erp-panel overflow-hidden">
          {isLoading ? (
            <div className="p-3 space-y-2">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
            </div>
          ) : filtered.length === 0 ? (
            <EmptyState title="No invoices match this filter." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 140 }}>Invoice #</th>
                  <th style={{ width: 110 }}>Date</th>
                  <th>Customer</th>
                  <th style={{ width: 160 }}>GSTIN</th>
                  <th className="num" style={{ width: 130, textAlign: "right" }}>Taxable ₹</th>
                  <th className="num" style={{ width: 110, textAlign: "right" }}>Tax ₹</th>
                  <th className="num" style={{ width: 130, textAlign: "right" }}>Total ₹</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((i: any) => (
                  <tr key={i.id}>
                    <td>
                      <Link
                        to={`/sales/invoices/${i.id}`}
                        className="font-mono text-[12.5px] text-primary hover:underline"
                      >
                        {i.invoiceNumber ?? i.number ?? `#INV-${String(i.id).slice(-4).toUpperCase()}`}
                      </Link>
                    </td>
                    <td className="text-[12.5px]">{fmtDate(i.invoiceDate ?? i.date ?? i.issuedAt)}</td>
                    <td className="font-medium">{i.dealerName ?? i.customerName ?? "—"}</td>
                    <td className="font-mono text-[12px]">{i.dealerGstNumber ?? i.gstin ?? "—"}</td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {fmtINR(parseFloat(String(i.taxableAmount ?? i.subtotal ?? 0)) || 0)}
                    </td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {fmtINR(parseFloat(String(i.totalTax ?? 0)) || 0)}
                    </td>
                    <td className="num font-semibold" style={{ textAlign: "right" }}>
                      {fmtINR(parseFloat(String(i.totalAmount ?? i.total ?? 0)) || 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-muted/40">
                  <td colSpan={6} className="text-right uppercase text-[12.5px] font-semibold tracking-wide">Grand Total</td>
                  <td className="num font-bold text-[14px]" style={{ textAlign: "right" }}>{fmtINR(grand)}</td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}