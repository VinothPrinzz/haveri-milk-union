// ════════════════════════════════════════════════════════════════════
// Recent Sales — list view of recently posted sales
// Route preserved: /sales/direct-sales/recent
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, Link } from "react-router-dom";
import PageHeader, {
  FilterBar, Field, EmptyState, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import { Printer, Search, X } from "lucide-react";
import { fetchRecentDirectSales as fetchRecentSales } from "@/services/api";

// What the UI exposes as a filter, → what customer_type to match
const SALE_TYPE_OPTS: F9Option[] = [
  { value: "agent",             label: "Gate Pass" },
  { value: "cash",              label: "Cash" },
  { value: "vip_sample",        label: "VIP Sample" },
  { value: "employee_subsidy",  label: "Employee Subsidy" },
];

const TYPE_LABEL: Record<string, string> = {
  agent: "Gate Pass",
  cash: "Cash",
  vip_sample: "VIP Sample",
  employee_subsidy: "Employee Subsidy",
};

const formatBillId = (s: any) =>
  s.bill_no ?? s.invoice_number ?? s.gpNo ?? (s.id ? `#GP-${String(s.id).slice(-4).toUpperCase()}` : "—");

export default function RecentSalesPage() {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const sevenAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(sevenAgo);
  const [to, setTo] = useState(today);
  const [saleType, setSaleType] = useState<string | null>(null);  // ← NEW
  const [q, setQ] = useState("");

  const { data: sales = [], isLoading } = useQuery({
    queryKey: ["recent-sales", { from, to }],
    queryFn: () => fetchRecentSales(),
  });

  // Date range + sale-type filter (date is normalized to YYYY-MM-DD)
  const filtered = useMemo(() => {
    return (sales ?? []).filter((s: any) => {
      const dateOk = (!from || s.date >= from) && (!to || s.date <= to);
      const typeOk = !saleType || s.customerType === saleType;
      return dateOk && typeOk;
    });
  }, [sales, from, to, saleType]);

  const searchFiltered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return filtered;
    return filtered.filter((r: any) =>
      (formatBillId(r) ?? "").toLowerCase().includes(term) ||
      (r.customerName ?? "").toLowerCase().includes(term)
    );
  }, [filtered, q]);

  const grand = searchFiltered.reduce(
    (s: number, r: any) => s + (parseFloat(String(r.total ?? 0)) || 0), 0
  );

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Recent Sales"
        subtitle="Gate pass, cash, VIP sample & employee subsidy"
        actions={
          <Button size="sm" variant="outline" className="h-8" onClick={() => window.print()}>
            <Printer className="h-3.5 w-3.5 mr-1" /> Print
          </Button>
        }
      />

      <FilterBar>
        <Field label="From">
          <Input type="date" className="erp-input w-36" value={from} onChange={e => setFrom(e.target.value)} />
        </Field>
        <Field label="To">
          <Input type="date" className="erp-input w-36" value={to} onChange={e => setTo(e.target.value)} />
        </Field>
        <Field label="Sale Type">
          <F9SearchSelect
            value={saleType} onChange={setSaleType}
            options={SALE_TYPE_OPTS} allowAll className="w-48"
          />
        </Field>
        <Field label="Search">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="erp-input pl-7 w-72" placeholder="bill # / party"
                   value={q} onChange={e => setQ(e.target.value)} />
          </div>
        </Field>
        {(q || saleType) && (
          <div className="flex items-end">
            <Button size="sm" variant="outline" className="h-8"
                    onClick={() => { setQ(""); setSaleType(null); }}>
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
          ) : searchFiltered.length === 0 ? (
            <EmptyState title="No sales found in this range." />
          ) : (
            <table className="erp-table">
              <thead>
                <tr>
                  <th style={{ width: 130 }}>Bill #</th>
                  <th style={{ width: 110 }}>Date</th>
                  <th style={{ width: 130 }}>Type</th>
                  <th>Customer</th>
                  <th style={{ width: "30%" }}>Items</th>
                  <th style={{ width: 80 }}>Pay</th>
                  <th className="num" style={{ width: 130, textAlign: "right" }}>Total ₹</th>
                  <th style={{ width: 90, textAlign: "center" }}>Update</th>
                </tr>
              </thead>
              <tbody>
                {searchFiltered.map((s: any) => {
                  // Bill # is always a link. If we have an invoice, go there;
                  // otherwise fall back to the modify view for the sale.
                  const target = s.invoiceId
                    ? `/sales/invoices/${s.invoiceId}`
                    : `/sales/direct-sales/modify?indentId=${s.id}&type=direct-sale`;
                  return (
                    <tr key={s.id}>
                      <td>
                        <Link
                          to={target}
                          className="font-mono text-[12.5px] text-primary hover:underline"
                        >
                          {formatBillId(s)}
                        </Link>
                      </td>
                      <td className="text-[12.5px]">{fmtDate(s.date)}</td>
                      <td className="text-[12px]">{TYPE_LABEL[s.customerType] ?? "—"}</td>
                      <td className="font-medium">{s.customerName ?? "Walk-in"}</td>
                      <td>
                        {(s.items ?? []).length === 0 ? (
                          <span className="text-muted-foreground">—</span>
                        ) : (
                          <div className="flex flex-col gap-0.5">
                            {s.items.map((it: any, k: number) => (
                              <span key={k} className="text-[12px]">
                                <span className="num font-medium">{it.qty}×</span>{" "}
                                {it.productName}
                              </span>
                            ))}
                          </div>
                        )}
                      </td>
                      <td className="uppercase text-[12px]">{s.payMode}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtINR(s.total)}</td>
                      <td style={{ textAlign: "center" }}>
                        <Button
                          size="sm" className="h-7 px-2.5 text-[12px]"
                          onClick={() => navigate(`/sales/direct-sales/modify?indentId=${s.id}&type=direct-sale`)}
                        >
                          Update
                        </Button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="bg-muted/40">
                  <td colSpan={6} className="text-right uppercase text-[12.5px] font-semibold tracking-wide">Grand Total</td>
                  <td className="num font-bold text-[14px]" style={{ textAlign: "right" }}>{fmtINR(grand)}</td>
                  <td></td>
                </tr>
              </tfoot>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}