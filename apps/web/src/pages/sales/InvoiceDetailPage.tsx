// ════════════════════════════════════════════════════════════════════
// Invoice Detail — printable A4 GST tax invoice
// Route preserved: /sales/invoices/:id
//
// Layout reference: client-provided MANMUL retailer GST invoice.
// Letterhead style reference: RouteSheetPage's <RouteLetterhead/>
// (same centered company name + GST/Admin Office/Phone meta block,
// so every printed document carries the same masthead).
// ════════════════════════════════════════════════════════════════════
import { useParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import PageHeader, { EmptyState, fmtDate } from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Printer, Send, Ban } from "lucide-react";
import {
  fetchInvoiceById as fetchInvoice,
  sendInvoice,
  cancelInvoice,
} from "@/services/api";

// ── Company info — mirrors RouteLetterhead in RouteSheetPage.tsx ────
const COMPANY = {
  name:      "Haveri District Co-operative Milk Producers Societies Union Ltd",
  gstin:     "29AADAH7841L1Z6",
  pan:       "AADAH7841L",              // derived from GSTIN[2..11]
  address:   "Veterinary Hospital Compound, PB Road, Haveri - 581110",
  phone:     "08375200650",
  email:     "admin@haverimunion.coop",
  fssai:     "10012043000208",
  stateName: "KARNATAKA",
  stateCode: "29",
};

// ── Tiny format helper: 2-decimal plain number (no ₹ symbol) ────────
const fmt2 = (n: number | string | null | undefined): string => {
  const v = typeof n === "string" ? parseFloat(n) : (n ?? 0);
  if (!Number.isFinite(v)) return "0.00";
  return v.toFixed(2);
};

// ── Indian-system number to words, returns UPPERCASE without suffix ─
function numToWordsIndian(num: number): string {
  const n = Math.round(num);
  if (n === 0) return "ZERO";

  const ones = [
    "", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
    "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN",
    "SEVENTEEN", "EIGHTEEN", "NINETEEN",
  ];
  const tens = [
    "", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY", "NINETY",
  ];

  const two = (x: number): string => {
    if (x < 20) return ones[x];
    const t = Math.floor(x / 10);
    const o = x % 10;
    return o ? `${tens[t]}-${ones[o]}` : tens[t];
  };
  const three = (x: number): string => {
    const h = Math.floor(x / 100);
    const r = x % 100;
    const parts: string[] = [];
    if (h) parts.push(`${ones[h]} HUNDRED`);
    if (r) parts.push(two(r));
    return parts.join(" ");
  };

  const crore = Math.floor(n / 10000000);
  const lakh  = Math.floor((n % 10000000) / 100000);
  const thou  = Math.floor((n % 100000) / 1000);
  const rest  = n % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${two(crore)} CRORE`);
  if (lakh)  parts.push(`${two(lakh)} LAKH`);
  if (thou)  parts.push(`${two(thou)} THOUSAND`);
  if (rest)  parts.push(three(rest));
  return parts.join(" ");
}

// ── Qty: show as integer if whole, else 2-decimal ───────────────────
const fmtQty = (q: number): string =>
  q % 1 === 0 ? String(q) : q.toFixed(2);

// ── Payment mode → human label (matches PaymentMode union in api.ts) ─
const MODE_LABELS: Record<string, string> = {
  cash: "Cash", upi: "UPI", cheque: "Cheque", neft: "NEFT",
  rtgs: "RTGS", credit: "Credit", wallet: "Wallet",
};
const modeLabel = (m: string | null | undefined): string => {
  if (!m) return "—";
  return MODE_LABELS[m.toLowerCase()] ?? m;
};

// ════════════════════════════════════════════════════════════════════
// PAGE
// ════════════════════════════════════════════════════════════════════
export default function InvoiceDetailPage() {
  const { id = "" } = useParams<{ id: string }>();
  const qc = useQueryClient();

  const { data: invData, isLoading } = useQuery({
    queryKey: ["invoice", id],
    queryFn:  () => fetchInvoice(id),
    enabled:  !!id,
  });
  const inv = invData?.invoice as any;
  const invLines = (invData?.items ?? []) as any[];
  const invPayments = (invData?.payments ?? []) as any[];

  const send = useMutation({
    mutationFn: () => sendInvoice(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ["invoice", id] }); toast.success("Invoice sent"); },
    onError:    (e: any) => toast.error(e?.message || "Failed"),
  });
  const cancel = useMutation({
    mutationFn: () => cancelInvoice(id),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ["invoice", id] }); toast.success("Invoice cancelled"); },
    onError:    (e: any) => toast.error(e?.message || "Failed"),
  });

  if (isLoading) {
    return (
      <div className="p-4 space-y-2">
        {Array.from({ length: 10 }).map((_, i) => <Skeleton key={i} className="h-7 w-full" />)}
      </div>
    );
  }
  if (!invData) return <EmptyState title="Invoice not found." />;

  // ── Aggregate calculations ─────────────────────────────────────────
  const taxable = invLines.reduce((s, l) => {
    const basic = parseFloat(String(l.basic ?? ""));
    if (Number.isFinite(basic) && basic > 0) return s + basic;
    const qty  = Number(l.quantity ?? 0);
    const rate = parseFloat(String(l.unitPrice ?? 0)) || 0;
    return s + qty * rate;
  }, 0);
  const cgst       = parseFloat(String(inv?.cgst ?? 0)) || 0;
  const sgst       = parseFloat(String(inv?.sgst ?? 0)) || 0;
  const totalTax   = cgst + sgst;
  // Grand total = taxable + GST, computed live so the paise are preserved.
  // (invoices.total_amount is stored pre-rounded, which zeroed the decimals.)
  const grandTotal = taxable + totalTax;
  // Amount in words — include paise since rounding is no longer applied.
  const rupeesPart = Math.floor(grandTotal);
  const paisePart  = Math.round((grandTotal - rupeesPart) * 100);
  const amountWords = paisePart > 0
    ? `${numToWordsIndian(rupeesPart)} RUPEES AND ${numToWordsIndian(paisePart)} PAISE`
    : `${numToWordsIndian(rupeesPart)} RUPEES`;

  // ── Receiver fields ────────────────────────────────────────────────
  const dealerName    = inv?.dealerName ?? inv?.currentDealerName ?? "—";
  const dealerAddress = inv?.dealerAddressSnapshot ?? inv?.dealerAddress ?? "—";
  const dealerCity    = inv?.dealerCity ?? "—";
  const dealerState   = inv?.dealerState ?? COMPANY.stateName;
  const dealerPhone   = inv?.dealerPhone ?? "—";
  const dealerGst     = inv?.dealerGstNumber ?? inv?.dealerCurrentGst ?? "—";
  const dealerCode    = inv?.dealerCode ?? "—";
  const dealerEmail   = inv?.dealerEmail ?? "";
  const poNumber      = inv?.poNumber ?? inv?.orderId ?? "—";
  const routeDisplay  = inv?.routeName
    ? `${inv.routeName}${inv.routeCode ? `[${inv.routeCode}]` : ""}`
    : "—";
  // const vehicleNo     = inv?.vehicleNumber ?? inv?.contractor?.vehicleNumber ?? "—";

  // ── Payment fields ─────────────────────────────────────────────────
  // invoices.payment_status defaults to "unpaid" and is never flipped when a
  // placed order settles, so it wrongly read NOT PAID on every invoice. Mirror
  // the dealer-facing PDF: a placed order (confirmed/dispatched/delivered) is
  // settled — whether up front or on the credit ledger — so it counts as PAID.
  // An explicit "paid"/"partial" on the invoice still takes precedence.
  const orderStatus   = String(inv?.orderStatus ?? "").toLowerCase();
  const rawStatus     = String(inv?.paymentStatus ?? "").toLowerCase();
  const paymentStatus =
    rawStatus === "paid" || rawStatus === "partial"
      ? rawStatus
      : ["confirmed", "dispatched", "delivered"].includes(orderStatus)
      ? "paid"
      : "unpaid";
  const paidLabel     =
    paymentStatus === "paid"    ? "PAID"
    : paymentStatus === "partial" ? "PARTIALLY PAID"
    : "NOT PAID";
  const paymentMode   = modeLabel(inv?.paymentMode);

  return (
    <div className="flex flex-col h-full">
      {/* ── Screen-only action bar ────────────────────────────────── */}
      <PageHeader
        title={`Invoice ${inv?.invoiceNumber ?? id}`}
        subtitle={`Issued ${fmtDate(inv?.invoiceDate)}`}
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
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-destructive border-destructive/40 hover:bg-destructive/10"
                onClick={() => cancel.mutate()}
                disabled={cancel.isPending}
              >
                <Ban className="h-3.5 w-3.5 mr-1" /> Cancel
              </Button>
            )}
          </>
        }
      />

      <div className="flex-1 overflow-auto p-4">
        <div className="erp-panel p-6 max-w-[900px] mx-auto print:max-w-full print:p-0 print:border-0 print:shadow-none">
          {/* Scoped print overrides — strip the global heavy grid border
              the index.css print rules add to every td/th inside
              .print-document. We restore only the subtle screen look
              so print and screen render identically. */}
          <style>{`
            @media print {
              .print-document.inv-doc table,
              .print-document.inv-doc table th,
              .print-document.inv-doc table td {
                border: 0 !important;
                background: transparent !important;
                padding: 2px 6px !important;
                color: #000 !important;
              }
              .print-document.inv-doc .erp-table thead th {
                border-top: 1px solid #000 !important;
                border-bottom: 1px solid #000 !important;
                background: transparent !important;
                font-weight: 700 !important;
              }
              .print-document.inv-doc .erp-table tbody td {
                border-bottom: 1px dotted #bbb !important;
              }
              .print-document.inv-doc .inv-total-row td {
                border-top: 1px solid #000 !important;
                border-bottom: 1px solid #000 !important;
                font-weight: 700 !important;
              }
              .print-document.inv-doc .inv-net-row td {
                border-top: 1px solid #000 !important;
                font-weight: 700 !important;
              }
              .print-document.inv-doc .inv-section-bar {
                border-top: 1px solid #000 !important;
                border-bottom: 1px solid #000 !important;
              }
              .print-document.inv-doc .inv-footer-divider {
                border-top: 1px solid #000 !important;
              }
            }
          `}</style>
          <div className="print-document inv-doc">

            {/* ── LETTERHEAD — same style as Route Sheet ──────────── */}
            <div className="rs-letterhead">
              <div className="rs-lh-co">{COMPANY.name}</div>
              <div className="rs-lh-meta">
                <span><strong>GST No.:</strong> {COMPANY.gstin}</span>
                <span><strong>Admin Office:</strong> {COMPANY.address}</span>
                <span><strong>Phone:</strong> {COMPANY.phone}</span>
              </div>
              <div className="rs-lh-title">TAX INVOICE</div>
            </div>

            {/* ── Invoice meta (two columns) ──────────────────────── */}
            <table className="w-full text-[12px] border-collapse mb-2">
              <tbody>
                <tr>
                  <td className="py-[2px] pr-3 align-top w-1/2">
                    <span className="text-muted-foreground">Invoice No :</span>{" "}
                    <span className="font-mono font-medium">{inv?.invoiceNumber ?? id}</span>
                  </td>
                  <td className="py-[2px] pr-3 align-top w-1/2">
                    <span className="text-muted-foreground">Invoice Date :</span>{" "}
                    <span className="font-medium">{fmtDate(inv?.invoiceDate)}</span>
                  </td>
                </tr>
                <tr>
                  <td className="py-[2px] pr-3 align-top">
                    <span className="text-muted-foreground">GSTIN :</span>{" "}
                    <span className="font-mono">{COMPANY.gstin}</span>
                  </td>
                  <td className="py-[2px] pr-3 align-top">
                    <span className="text-muted-foreground">State :</span> {COMPANY.stateName}
                  </td>
                </tr>
                <tr>
                  <td className="py-[2px] pr-3 align-top">
                    <span className="text-muted-foreground">PAN No :</span>{" "}
                    <span className="font-mono">{COMPANY.pan}</span>
                  </td>
                  <td className="py-[2px] pr-3 align-top">
                    <span className="text-muted-foreground">State Code :</span> {COMPANY.stateCode}
                  </td>
                </tr>
                <tr>
                  <td className="py-[2px] pr-3 align-top">
                    <span className="text-muted-foreground">Route Name :</span> {routeDisplay}
                  </td>
                  <td className="py-[2px] pr-3 align-top">
                    <span className="text-muted-foreground">Delivery Date :</span>{" "}
                    <span className="font-medium">{fmtDate(inv?.deliveryDate)}</span>
                  </td>
                  {/* <td className="py-[2px] pr-3 align-top">
                    <span className="text-muted-foreground">Vehicle No :</span>{" "}
                    <span className="font-mono">{vehicleNo}</span>
                  </td> */}
                </tr>
                <tr>
                  <td className="py-[2px] pr-3 align-top">
                    <span className="text-muted-foreground">Payment Mode :</span>{" "}
                    <span className="font-medium">{paymentMode}</span>
                  </td>
                  <td className="py-[2px] pr-3 align-top">
                    <span className="text-muted-foreground">Payment Status :</span>{" "}
                    <span
                      className={
                        "font-semibold " +
                        (paymentStatus === "paid"
                          ? "text-emerald-600"
                          : paymentStatus === "partial"
                          ? "text-amber-600"
                          : "text-destructive")
                      }
                    >
                      {paidLabel}
                    </span>
                  </td>
                </tr>
                <tr>
                  <td className="py-[2px] pr-3 align-top" colSpan={2}>
                    <span className="text-muted-foreground">Fssai Licence Number :</span>{" "}
                    <span className="font-mono">{COMPANY.fssai}</span>
                  </td>
                </tr>
              </tbody>
            </table>

            {/* ── Details of Receiver / Bill to ───────────────────── */}
            <div className="inv-section-bar border-y border-black text-center text-[12px] font-semibold uppercase tracking-wide py-1 mb-2">
              Details of Receiver / Bill to
            </div>

            <div className="grid grid-cols-2 gap-x-6 mb-3 text-[12px] leading-[1.45]">
              {/* Billing side */}
              <div>
                <p><span className="text-muted-foreground">Name :</span> <span className="font-semibold">{dealerName}</span></p>
                <p className="whitespace-pre-line"><span className="text-muted-foreground">Billing Address :</span> {dealerAddress}</p>
                <p><span className="text-muted-foreground">City :</span> {dealerCity}</p>
                <p><span className="text-muted-foreground">District :</span> {dealerCity}</p>
                <p><span className="text-muted-foreground">GST No :</span> <span className="font-mono">{dealerGst}</span></p>
                <p><span className="text-muted-foreground">Dealer Id :</span> <span className="font-mono">{dealerCode}</span></p>
                <p><span className="text-muted-foreground">PO Number :</span> <span className="font-mono">{poNumber}</span></p>
              </div>
              {/* Shipping side */}
              <div>
                {/* <p><span className="text-muted-foreground">Name :</span> <span className="font-semibold">{dealerName}</span></p> */}
                <p className="whitespace-pre-line"><span className="text-muted-foreground">Ship/Deliver Address :</span> {dealerAddress}</p>
                <p><span className="text-muted-foreground">State :</span> {dealerState}</p>
                <p><span className="text-muted-foreground">Phone No :</span> {dealerPhone}</p>
                <p><span className="text-muted-foreground">Email :</span> {dealerEmail}</p>
              </div>
            </div>

            {/* ── Line items table ────────────────────────────────── */}
            <table className="erp-table mb-3 text-[10.5px]">
              <thead>
                <tr>
                  <th style={{ width: 32 }}>Sl No</th>
                  <th>Description of Goods</th>
                  <th style={{ width: 68 }}>HSN CODE</th>
                  <th className="num" style={{ width: 48, textAlign: "right" }}>Qty</th>
                  <th className="num" style={{ width: 58, textAlign: "right" }}>Rate</th>
                  <th className="num" style={{ width: 78, textAlign: "right" }}>Taxable Value</th>
                  <th className="num" style={{ width: 42, textAlign: "right" }}>GST %</th>
                  <th className="num" style={{ width: 64, textAlign: "right" }}>CGST Value</th>
                  <th className="num" style={{ width: 64, textAlign: "right" }}>SGST Value</th>
                  <th className="num" style={{ width: 78, textAlign: "right" }}>Net Amount</th>
                </tr>
              </thead>
              <tbody>
                {invLines.map((l, i) => {
                  const qty     = Number(l.quantity ?? 0);
                  const rate    = parseFloat(String(l.unitPrice ?? 0)) || 0;
                  const basicV  = parseFloat(String(l.basic ?? "")) || qty * rate;
                  const gstPct  = parseFloat(String(l.gstPercent ?? 0)) || 0;
                  const cgstAmt = parseFloat(String(l.cgstAmount ?? 0)) || 0;
                  const sgstAmt = parseFloat(String(l.sgstAmount ?? 0)) || 0;
                  const lineTot = parseFloat(String(l.lineTotal ?? "")) || (basicV + cgstAmt + sgstAmt);
                  return (
                    <tr key={i}>
                      <td className="num" style={{ textAlign: "center" }}>{i + 1}</td>
                      {/* Product name only — the numeric pack_size (e.g. "0.50")
                          was previously appended and is intentionally dropped. */}
                      <td>{l.productName}</td>
                      <td className="font-mono">{l.hsnNo ?? "—"}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmtQty(qty)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmt2(rate)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmt2(basicV)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{gstPct === 0 ? "0" : fmt2(gstPct)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmt2(cgstAmt)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmt2(sgstAmt)}</td>
                      <td className="num" style={{ textAlign: "right" }}>{fmt2(lineTot)}</td>
                    </tr>
                  );
                })}

                {/* Total row */}
                <tr className="inv-total-row font-semibold" style={{ borderTop: "1px solid #000", borderBottom: "1px solid #000" }}>
                  <td colSpan={5} style={{ textAlign: "right" }}>Total</td>
                  <td className="num" style={{ textAlign: "right" }}>{fmt2(taxable)}</td>
                  <td></td>
                  <td className="num" style={{ textAlign: "right" }}>{fmt2(cgst)}</td>
                  <td className="num" style={{ textAlign: "right" }}>{fmt2(sgst)}</td>
                  <td className="num" style={{ textAlign: "right" }}>{fmt2(grandTotal)}</td>
                </tr>
              </tbody>
            </table>

            {/* ── Invoice Value in Words + Remarks ────────────────── */}
            <div className="grid grid-cols-[1fr_auto] gap-x-6 mb-4 text-[12px]">
              <div>
                <p className="font-semibold">Invoice Value (In Words) :</p>
                <p className="italic">(Rs : {amountWords} )</p>

                {/* ── Payment details ─────────────────────────────── */}
                <p className="font-semibold mt-3">PAYMENT DETAILS</p>
                <p>
                  <span className="text-muted-foreground">Mode :</span> {paymentMode}
                  {"  ·  "}
                  <span className="text-muted-foreground">Status :</span>{" "}
                  <span className="font-semibold">{paidLabel}</span>
                </p>
                {invPayments.length > 0 ? (
                  <table className="text-[11px] mt-1 border-collapse">
                    <tbody>
                      {invPayments.map((p, i) => (
                        <tr key={i}>
                          <td className="py-[1px] pr-3 align-top text-muted-foreground">
                            {fmtDate(p.receivedDate)}
                          </td>
                          <td className="py-[1px] pr-3 align-top">{modeLabel(p.mode)}</td>
                          <td className="py-[1px] pr-3 align-top font-mono">
                            {p.reference ? `Ref ${p.reference}` : ""}
                          </td>
                          <td className="py-[1px] align-top num" style={{ textAlign: "right" }}>
                            {fmt2(p.amount)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ) : (
                  <p className="text-[11px] text-muted-foreground italic">
                    {paymentStatus === "paid"
                      ? "Settled — no separate receipt recorded."
                      : "No payment recorded against this invoice yet."}
                  </p>
                )}

                <p className="font-semibold mt-3">REMARKS</p>
              </div>

              <table className="text-[12px] min-w-[260px] border-collapse">
                <tbody>
                  <tr>
                    <td className="text-muted-foreground py-[2px] pr-4">Total Taxable Value</td>
                    <td className="num py-[2px]" style={{ textAlign: "right" }}>{fmt2(taxable)}</td>
                  </tr>
                  {cgst > 0 && (
                    <tr>
                      <td className="text-muted-foreground py-[2px] pr-4">CGST</td>
                      <td className="num py-[2px]" style={{ textAlign: "right" }}>{fmt2(cgst)}</td>
                    </tr>
                  )}
                  {sgst > 0 && (
                    <tr>
                      <td className="text-muted-foreground py-[2px] pr-4">SGST</td>
                      <td className="num py-[2px]" style={{ textAlign: "right" }}>{fmt2(sgst)}</td>
                    </tr>
                  )}
                  {totalTax > 0 && (
                    <tr>
                      <td className="text-muted-foreground py-[2px] pr-4">Total GST</td>
                      <td className="num py-[2px]" style={{ textAlign: "right" }}>{fmt2(totalTax)}</td>
                    </tr>
                  )}
                  <tr>
                    <td className="font-semibold py-[2px] pr-4">Grand Total</td>
                    <td className="num font-semibold py-[2px]" style={{ textAlign: "right" }}>{fmt2(grandTotal)}</td>
                  </tr>
                  <tr className="inv-net-row" style={{ borderTop: "1px solid #000" }}>
                    <td className="font-bold py-1 pr-4">NET AMOUNT</td>
                    <td className="num font-bold py-1" style={{ textAlign: "right" }}>{fmt2(grandTotal)}</td>
                  </tr>
                </tbody>
              </table>
            </div>

            {/* ── Footer: certification + signatures ──────────────── */}
            <div className="inv-footer-divider border-t border-black pt-3 grid grid-cols-2 gap-6 text-[11.5px]">
              <div>
                <p className="mt-12">Goods Receiver Signature</p>
              </div>
              <div className="text-right">
                <p>Certified that the Particulars given above</p>
                <p>are true and correct</p>
                <p className="mt-1">for {COMPANY.name}.,</p>
                <p className="mt-10">Authorised Signatory</p>
              </div>
            </div>

            <p className="text-center text-[10.5px] italic text-muted-foreground mt-4">
              NOTE: Electronically generated details do not require any signature.
            </p>

          </div>
        </div>
      </div>
    </div>
  );
}