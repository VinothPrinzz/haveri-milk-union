// ════════════════════════════════════════════════════════════════════
// Recent Sales — list view of recently posted sales
// Route preserved: /sales/direct-sales/recent
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, Link } from "react-router-dom";
import PageHeader, {
  FilterBar, Field, EmptyState, StatusPill, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Printer, Search, X } from "lucide-react";
import { fetchRecentDirectSales as fetchRecentSales } from "@/services/api";

const formatBillId = (s: any) =>
  s.bill_no ?? s.invoice_number ?? (s.id ? `#GP-${String(s.id).slice(-4).toUpperCase()}` : "—");

export default function RecentSalesPage() {
  const navigate = useNavigate();
  const today = new Date().toISOString().slice(0, 10);
  const sevenAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  const [from, setFrom] = useState(sevenAgo);
  const [to, setTo] = useState(today);
  const [q, setQ] = useState("");

  const { data: sales = [], isLoading } = useQuery({
    queryKey: ["recent-sales", { from, to }],
    queryFn: () => fetchRecentSales(),
  });

  // Filter to gate-pass + cash only
  const filtered = useMemo(() => {
    return (sales ?? []).filter((s: any) => {
      const t = (s.type ?? s.sale_type ?? "").toLowerCase();
      return t === "gate-pass" || t === "cash-customer" || t === "cash";
    });
  }, [sales]);

  const searchFiltered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return filtered;
    return filtered.filter((r: any) =>
      (r.code ?? "").toLowerCase().includes(term) ||
      (r.partyName ?? r.customerName ?? r.dealer_name ?? "").toLowerCase().includes(term)
    );
  }, [filtered, q]);

  const grand = searchFiltered.reduce((s: number, r: any) => s + (parseFloat(String(r.grand_total ?? r.total ?? 0)) || 0), 0);

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title="Recent Sales"
        subtitle="Gate-pass & cash sales"
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
        <Field label="Search">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input className="erp-input pl-7 w-72" placeholder="bill # / party" value={q} onChange={e => setQ(e.target.value)} />
          </div>
        </Field>
        {q && (
          <div className="flex items-end">
            <Button size="sm" variant="outline" className="h-8" onClick={() => setQ("")}>
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
                  <th style={{ width: 110 }}>Type</th>
                  <th>Customer</th>
                  <th style={{ width: "30%" }}>Items</th>
                  <th style={{ width: 80 }}>Pay</th>
                  <th className="num" style={{ width: 130, textAlign: "right" }}>Total ₹</th>
                  <th style={{ width: 90, textAlign: "center" }}>Update</th>
                </tr>
              </thead>
              <tbody>
                {searchFiltered.map((s: any) => (
                  <tr key={s.id}>
                    <td className="font-mono text-[12px]">
                      {s.invoice_id || s.invoiceId ? (
                        <Link
                          to={`/sales/invoices/${s.invoice_id ?? s.invoiceId}`}
                          className="text-blue-600 hover:text-blue-800 hover:underline"
                        >
                          {formatBillId(s)}
                        </Link>
                      ) : (
                        formatBillId(s)
                      )}
                    </td>
                    <td className="text-[12.5px]">{fmtDate(s.created_at ?? s.sale_date ?? s.date)}</td>
                    <td className="text-[12.5px]">
                      <StatusPill status={(s.type ?? s.sale_type) === "gate-pass" ? "confirmed" : "pending"} />
                    </td>
                    <td className="font-medium">
                      {s.dealer_name ?? s.customer_name ?? s.customerName ?? "Walk-in"}
                    </td>
                    <td>
                      {(s.items ?? s.lines ?? []).length === 0 ? (
                        <span className="text-muted-foreground">—</span>
                      ) : (
                        <div className="flex flex-col gap-0.5">
                          {(s.items ?? s.lines ?? []).map((it: any, k: number) => (
                            <span key={k} className="text-[12px]">
                              <span className="num font-medium">{it.quantity ?? it.qty}×</span>{" "}
                              {it.product_name ?? it.productName ?? it.name}
                            </span>
                          ))}
                        </div>
                      )}
                    </td>
                    <td className="uppercase text-[12px]">{(s.payment_mode ?? s.payMode ?? "—").toString()}</td>
                    <td className="num" style={{ textAlign: "right" }}>
                      {fmtINR(parseFloat(String(s.grand_total ?? s.total ?? 0)) || 0)}
                    </td>
                    <td style={{ textAlign: "center" }}>
                      <Button
                        size="sm"
                        className="h-7 px-2.5 text-[12px]"
                        onClick={() => navigate(`/sales/direct-sales/modify?indentId=${s.id}`)}
                      >
                        Update
                      </Button>
                    </td>
                  </tr>
                ))}
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