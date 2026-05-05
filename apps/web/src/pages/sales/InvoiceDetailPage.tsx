// ════════════════════════════════════════════════════════════════════
// Invoice Detail — printable A4 invoice
// Route preserved: /sales/invoices/:id
// ════════════════════════════════════════════════════════════════════
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, {
  StatusPill, EmptyState, fmtINR, fmtDate,
} from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Printer, Send, Ban } from "lucide-react";
import { fetchInvoiceById as fetchInvoice, sendInvoice, cancelInvoice } from "@/services/api";

export default function InvoiceDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const qc = useQueryClient();
  const { data: invData, isLoading } = useQuery({
    queryKey: ["invoice", id],
    queryFn: () => fetchInvoice(id),
    enabled: !!id,
  });
  const inv = invData?.invoice as any;
  const invLines = invData?.items ?? [];

  const send = useMutation({
    mutationFn: () => sendInvoice(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoice", id] }); toast.success("Invoice sent"); },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });
  const cancel = useMutation({
    mutationFn: () => cancelInvoice(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["invoice", id] }); toast.success("Invoice cancelled"); },
    onError: (e: any) => toast.error(e?.message || "Failed"),
  });

  if (isLoading) return <div className="p-4 space-y-2">{Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}</div>;
  if (!invData) return <EmptyState title="Invoice not found." />;

  const subtotal = invLines.reduce((s: number, l: any) => s + (l.quantity || 0) * parseFloat(String(l.unitPrice || l.rate || 0)), 0);
  const cgst = parseFloat(String(inv?.cgst ?? 0)) || 0;
  const sgst = parseFloat(String(inv?.sgst ?? 0)) || 0;
  const total = parseFloat(String(inv?.totalAmount ?? 0)) || subtotal + cgst + sgst;
  const paid = parseFloat(String(inv?.paidAmount ?? 0)) || 0;
  const balance = total - paid;

  return (
    <div className="flex flex-col h-full">
      <PageHeader
        title={`Invoice ${inv?.invoiceNumber ?? inv?.number ?? inv?.code ?? id}`}
        subtitle={`Issued ${fmtDate(inv?.invoiceDate ?? inv?.date ?? inv?.issuedAt)}`}
        actions={
          <>
            <Button size="sm" variant="outline" className="h-8" onClick={() => window.print()}>
              <Printer className="h-3.5 w-3.5 mr-1" /> Print (Ctrl+P)
            </Button>
            {inv?.paymentStatus === "unpaid" && (
              <Button size="sm" className="h-8" onClick={() => send.mutate()} disabled={send.isPending}>
                <Send className="h-3.5 w-3.5 mr-1" /> Issue
              </Button>
            )}
            {inv?.paymentStatus !== "paid" && (
              <Button size="sm" variant="outline" className="h-8 text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => cancel.mutate()} disabled={cancel.isPending}>
                <Ban className="h-3.5 w-3.5 mr-1" /> Cancel
              </Button>
            )}
          </>
        }
      />

      <div className="flex-1 overflow-auto p-4">
        <div className="erp-panel p-6 max-w-[840px] mx-auto print:max-w-full print:p-0 print:border-0 print:shadow-none">
          <div className="print-document">
            <div className="flex justify-between items-start mb-6 pb-4 border-b border-border">
              <div>
                <p className="text-[11.5px] uppercase tracking-wide text-muted-foreground">Tax Invoice</p>
                <p className="text-[20px] font-semibold font-mono mt-1">{inv?.invoiceNumber ?? inv?.number ?? id}</p>
              </div>
              <div className="text-right text-[12.5px]">
                <p><span className="text-muted-foreground">Date</span> &nbsp; {fmtDate(inv?.invoiceDate ?? inv?.date)}</p>
                {inv?.dueDate && <p><span className="text-muted-foreground">Due</span> &nbsp; {fmtDate(inv.dueDate)}</p>}
                <p className="mt-1"><StatusPill status={inv?.paymentStatus ?? inv?.status} /></p>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-6 mb-6 text-[13px]">
              <div>
                <p className="erp-section-title mb-1">Bill To</p>
                <p className="font-semibold">{inv?.dealerName ?? inv?.currentDealerName ?? "—"}</p>
                <p className="text-muted-foreground whitespace-pre-line">{inv?.dealerAddress ?? inv?.dealerAddressSnapshot ?? ""}</p>
                {(inv?.dealerGstNumber ?? inv?.dealerCurrentGst) && <p className="font-mono text-[12px] mt-1">GSTIN: {inv?.dealerGstNumber ?? inv?.dealerCurrentGst}</p>}
              </div>
              <div className="text-right">
                <p className="erp-section-title mb-1">Reference</p>
                {inv?.orderId && <p>Order <span className="font-mono">{inv.orderId}</span></p>}
                {inv?.routeName && <p>Route <span className="font-medium">{inv.routeName}</span></p>}
                {inv?.routeCode && <p>Route Code <span className="font-medium">{inv.routeCode}</span></p>}
              </div>
            </div>

            <table className="erp-table mb-4">
              <thead>
                <tr>
                  <th style={{ width: 36 }}>#</th>
                  <th>Product</th>
                  <th style={{ width: 80 }}>HSN</th>
                  <th className="num" style={{ width: 100, textAlign: "right" }}>Qty</th>
                  <th className="num" style={{ width: 110, textAlign: "right" }}>Rate ₹</th>
                  <th className="num" style={{ width: 110, textAlign: "right" }}>Amount ₹</th>
                </tr>
              </thead>
              <tbody>
                {invLines.map((l: any, i: number) => (
                  <tr key={i}>
                    <td className="num text-muted-foreground" style={{ textAlign: "center" }}>{i + 1}</td>
                    <td>
                      <div className="font-medium">{l.productName}</div>
                      {l.packSize && <div className="text-[12px] text-muted-foreground">{l.packSize}</div>}
                    </td>
                    <td className="font-mono text-[12px]">{l.hsnNo ?? "—"}</td>
                    <td className="num" style={{ textAlign: "right" }}>{Number(l.quantity ?? 0).toFixed(2)}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(parseFloat(String(l.unitPrice ?? 0)))}</td>
                    <td className="num" style={{ textAlign: "right" }}>{fmtINR(parseFloat(String(l.lineTotal ?? 0)))}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex justify-end mb-4">
              <table className="text-[13px] w-72">
                <tbody>
                  <tr><td className="text-muted-foreground py-1">Subtotal</td><td className="num py-1" style={{ textAlign: "right" }}>{fmtINR(subtotal)}</td></tr>
                  {cgst > 0 && <tr><td className="text-muted-foreground py-1">CGST</td><td className="num py-1" style={{ textAlign: "right" }}>{fmtINR(cgst)}</td></tr>}
                  {sgst > 0 && <tr><td className="text-muted-foreground py-1">SGST</td><td className="num py-1" style={{ textAlign: "right" }}>{fmtINR(sgst)}</td></tr>}
                  <tr className="border-t border-border"><td className="font-semibold py-1.5">Total</td><td className="num font-bold py-1.5" style={{ textAlign: "right" }}>{fmtINR(total)}</td></tr>
                  {paid > 0 && <tr><td className="text-muted-foreground py-1">Paid</td><td className="num py-1" style={{ textAlign: "right" }}>{fmtINR(paid)}</td></tr>}
                  <tr><td className="font-semibold py-1">Balance Due</td><td className={`num font-semibold py-1 ${balance > 0 ? "text-warning" : "text-success"}`} style={{ textAlign: "right" }}>{fmtINR(balance)}</td></tr>
                </tbody>
              </table>
            </div>

            {inv?.notes && (
              <div className="text-[12.5px] text-muted-foreground border-t border-border pt-3">
                <p className="erp-section-title mb-1">Notes</p>
                <p>{inv.notes}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}