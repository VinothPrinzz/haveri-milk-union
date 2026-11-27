// apps/web/src/pages/finance/SupplierLedgerPage.tsx
// ════════════════════════════════════════════════════════════════════
// Finance → Supplier Ledger  (/finance/supplier-ledger?supplierId=)
//
// Purchase ledger of one supplier for a period: opening balance, every
// purchase (from Stock Entry's received lines, at the cost recorded there),
// payments made and debit / credit notes, with a running balance.
// Cr = the union owes the supplier; Dr = advance with the supplier.
//
// Finance (and super_admin) record payments, an opening balance and notes,
// and cancel a mistaken entry with a reason.
// ════════════════════════════════════════════════════════════════════
import { useMemo, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Plus, X } from "lucide-react";
import { Field, fmtINR } from "@/components/PageHeader";
import { F9SearchSelect, type F9Option } from "@/components/F9SearchSelect";
import ReportShell, { ReportPrintMeta, type Exporter } from "@/components/ReportShell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { get, post } from "@/lib/apiClient";
import { toCsv } from "@/lib/exporters";
import { todayIST } from "@/lib/istDate";
import { useCanEditFinance } from "@/lib/financeAccess";
import { fetchSuppliers } from "@/services/api";

type Kind = "purchase" | "payment" | "opening" | "debit_note" | "credit_note";
interface LedgerRow {
  id: string; date: string; kind: Kind; particulars: string;
  productName: string | null; qty: number | null; rate: number | null;
  debit: number; credit: number; balance: number;
  mode: string | null; reference: string | null; notes: string | null; byName: string | null;
  entryId: string | null;
}
interface LedgerResponse {
  supplier: { id: string; code: string | null; name: string; phone: string | null; gstNo: string | null; deleted: boolean };
  from: string; to: string;
  openingBalance: number;
  rows: LedgerRow[];
  purchasesByProduct: { productName: string; qty: number; amount: number; uncosted: number }[];
  totals: { purchases: number; creditNotes: number; payments: number; debitNotes: number; credits: number; debits: number; closingBalance: number };
}

const KIND_LABEL: Record<Kind, string> = {
  purchase: "Purchase", payment: "Payment", opening: "Opening", debit_note: "Debit note", credit_note: "Credit note",
};
const dmy = (iso: string) => iso.split("-").reverse().join("-");
/** Cr = payable to the supplier; Dr = advance with them. */
const crdr = (n: number) => `${fmtINR(Math.abs(n))} ${n < 0 ? "Dr" : "Cr"}`;
const money = (n: number) => (n ? fmtINR(n) : "");
const ROWS_PER_PAGE = 32;

const th = "border border-border py-1.5 px-2 font-bold";
const td = "border border-border py-1 px-2";

export default function SupplierLedgerPage() {
  const [params, setParams] = useSearchParams();
  const canEdit = useCanEditFinance();
  const qc = useQueryClient();
  const today = todayIST();
  const [supplierId, setSupplierIdState] = useState(params.get("supplierId") ?? "");
  const [from, setFrom] = useState(today.slice(0, 8) + "01");
  const [to, setTo] = useState(today);
  const [generated, setGenerated] = useState(false);
  const [entryOpen, setEntryOpen] = useState(false);
  const [cancelRow, setCancelRow] = useState<LedgerRow | null>(null);

  const setSupplierId = (v: string) => {
    setSupplierIdState(v);
    setGenerated(false);
    setParams(v ? { supplierId: v } : {}, { replace: true });
  };

  const { data: suppliers = [] } = useQuery({ queryKey: ["suppliers"], queryFn: fetchSuppliers });
  const supplierOptions: F9Option[] = useMemo(
    () => suppliers.map(s => ({ value: s.id, label: s.name, sublabel: s.code ?? "" })),
    [suppliers],
  );

  const { data, isFetching, refetch } = useQuery<LedgerResponse>({
    queryKey: ["supplier-ledger", supplierId, from, to],
    queryFn: () => get<LedgerResponse>(`/suppliers/${supplierId}/ledger`, { from, to }),
    enabled: false,
  });
  const report = data && data.supplier.id === supplierId && data.from === from && data.to === to ? data : undefined;

  const handleGenerate = async () => {
    if (!supplierId) { toast.error("Pick a supplier"); return; }
    if (from > to) { toast.error("'From' must be on or before 'To'"); return; }
    await refetch();
    setGenerated(true);
  };
  const afterChange = () => {
    qc.invalidateQueries({ queryKey: ["supplier-ledger", supplierId] });
    if (generated) refetch();
  };

  const supplierLabel = report
    ? `${report.supplier.code ? report.supplier.code + ": " : ""}${report.supplier.name}${report.supplier.deleted ? " (deleted)" : ""}`
    : supplierOptions.find(o => o.value === supplierId)?.label ?? "";

  const pages: ReactNode[] = useMemo(() => {
    if (!report) return [];
    const chunks: LedgerRow[][] = [];
    for (let i = 0; i < Math.max(report.rows.length, 1); i += ROWS_PER_PAGE) chunks.push(report.rows.slice(i, i + ROWS_PER_PAGE));
    return chunks.map((chunk, i) => (
      <LedgerPage key={i} report={report} rows={chunk} first={i === 0} last={i === chunks.length - 1}
        canEdit={canEdit} onCancel={setCancelRow} />
    ));
  }, [report, canEdit]);

  const exporters: Exporter[] = report ? [{
    label: "CSV",
    filename: `supplier-ledger_${report.supplier.code ?? "supplier"}_${from}_${to}.csv`,
    mimeType: "text/csv",
    build: () => {
      const out: (string | number)[][] = [
        [`Supplier Ledger: ${supplierLabel}`], ["Period", from, "to", to], [],
        ["Date", "Type", "Particulars", "Debit", "Credit", "Balance"],
        ["", "", "Opening Balance", "", "", report.openingBalance],
      ];
      for (const r of report.rows) out.push([r.date, KIND_LABEL[r.kind], r.particulars, r.debit || "", r.credit || "", r.balance]);
      out.push([], ["", "", "Period totals", report.totals.debits, report.totals.credits, report.totals.closingBalance]);
      out.push([], ["Purchases by product"], ["Product", "Qty", "Amount"]);
      for (const p of report.purchasesByProduct) out.push([p.productName, p.qty, p.amount]);
      return toCsv(out);
    },
  }] : [];

  return (
    <>
      <ReportShell
        title="Supplier Ledger"
        subtitle="Purchase ledger per supplier: purchases, payments and notes, with the balance owed"
        printOrientation="portrait"
        filters={
          <>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">Supplier</label>
              <div className="w-64">
                <F9SearchSelect value={supplierId} onChange={v => setSupplierId(v ?? "")} options={supplierOptions} placeholder="Select supplier" />
              </div>
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">From</label>
              <Input type="date" value={from} onChange={e => setFrom(e.target.value)} className="erp-input w-40" />
            </div>
            <div>
              <label className="text-[11px] uppercase tracking-wide text-muted-foreground block mb-1">To</label>
              <Input type="date" value={to} onChange={e => setTo(e.target.value)} className="erp-input w-40" />
            </div>
            {canEdit && supplierId && (
              <Button size="sm" variant="outline" className="h-8 self-end" onClick={() => setEntryOpen(true)}>
                <Plus className="h-3.5 w-3.5 mr-1.5" /> Payment / Note
              </Button>
            )}
          </>
        }
        onGenerate={handleGenerate}
        exporters={exporters}
        printMeta={
          <ReportPrintMeta
            title="Supplier Ledger"
            rows={[
              { label: "Supplier", value: supplierLabel },
              { label: "Period", value: `${dmy(from)} to ${dmy(to)}` },
              ...(report?.supplier.gstNo ? [{ label: "GSTIN", value: report.supplier.gstNo }] : []),
            ]}
          />
        }
        state={{
          generated,
          loading: isFetching && !report,
          pages,
          pageLabel: i => `Page ${i + 1}`,
          emptyMessage: supplierId ? "Nothing for this supplier in the period" : "Select a supplier, choose a period and press Generate",
        }}
      />
      {entryOpen && supplierId && (
        <EntryDialog supplierId={supplierId} supplierLabel={supplierLabel} today={today}
          onClose={() => setEntryOpen(false)} onDone={afterChange} />
      )}
      {cancelRow && (
        <CancelDialog row={cancelRow} onClose={() => setCancelRow(null)} onDone={afterChange} />
      )}
    </>
  );
}

function LedgerPage({ report, rows, first, last, canEdit, onCancel }: {
  report: LedgerResponse; rows: LedgerRow[]; first: boolean; last: boolean;
  canEdit: boolean; onCancel: (r: LedgerRow) => void;
}) {
  const t = report.totals;
  return (
    <div>
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-muted/50">
            <th className={`${th} text-left w-24`}>Date</th>
            <th className={`${th} text-left w-24`}>Type</th>
            <th className={`${th} text-left`}>Particulars</th>
            <th className={`${th} text-right w-28`}>Debit</th>
            <th className={`${th} text-right w-28`}>Credit</th>
            <th className={`${th} text-right w-32`}>Balance</th>
            {canEdit && <th className={`${th} w-8 no-print`} />}
          </tr>
        </thead>
        <tbody>
          {first && (
            <tr className="font-bold bg-muted/30">
              <td className={td} colSpan={5}>Opening Balance (brought forward)</td>
              <td className={`${td} text-right num`}>{crdr(report.openingBalance)}</td>
              {canEdit && <td className={`${td} no-print`} />}
            </tr>
          )}
          {rows.map(r => (
            <tr key={r.id}>
              <td className={td}>{dmy(r.date)}</td>
              <td className={td}>{KIND_LABEL[r.kind]}</td>
              <td className={td}>{r.particulars}</td>
              <td className={`${td} text-right num`}>{money(r.debit)}</td>
              <td className={`${td} text-right num`}>{money(r.credit)}</td>
              <td className={`${td} text-right num`}>{crdr(r.balance)}</td>
              {canEdit && (
                <td className={`${td} no-print text-center`}>
                  {r.entryId && (
                    <button title="Cancel this entry" className="text-muted-foreground hover:text-destructive" onClick={() => onCancel(r)}>
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                </td>
              )}
            </tr>
          ))}
          {last && (
            <tr className="font-bold bg-muted/40">
              <td className={`${td} text-right`} colSpan={3}>PERIOD TOTALS</td>
              <td className={`${td} text-right num`}>{fmtINR(t.debits)}</td>
              <td className={`${td} text-right num`}>{fmtINR(t.credits)}</td>
              <td className={`${td} text-right num`}>{crdr(t.closingBalance)}</td>
              {canEdit && <td className={`${td} no-print`} />}
            </tr>
          )}
        </tbody>
      </table>

      {last && (
        <>
          <table className="w-full text-[11px] border-collapse mt-3">
            <tbody>
              <tr>
                <Cell label="Opening" value={crdr(report.openingBalance)} />
                <Cell label="Purchases (Cr)" value={fmtINR(t.purchases)} />
                <Cell label="Credit notes / opening (Cr)" value={fmtINR(t.creditNotes)} />
                <Cell label="Payments (Dr)" value={fmtINR(t.payments)} />
                <Cell label="Debit notes (Dr)" value={fmtINR(t.debitNotes)} />
                <Cell label="Closing" value={crdr(t.closingBalance)} strong />
              </tr>
            </tbody>
          </table>
          {report.purchasesByProduct.length > 0 && (
            <>
              <p className="text-[11.5px] font-bold mt-3 mb-1">Purchases by product</p>
              <table className="w-full text-[11px] border-collapse">
                <thead>
                  <tr className="bg-muted/50">
                    <th className={`${th} text-left`}>Product</th>
                    <th className={`${th} text-right w-28`}>Qty</th>
                    <th className={`${th} text-right w-32`}>Amount</th>
                  </tr>
                </thead>
                <tbody>
                  {report.purchasesByProduct.map(p => (
                    <tr key={p.productName}>
                      <td className={td}>{p.productName}{p.uncosted > 0 ? ` (${p.uncosted.toLocaleString("en-IN")} with no cost)` : ""}</td>
                      <td className={`${td} text-right num`}>{p.qty.toLocaleString("en-IN")}</td>
                      <td className={`${td} text-right num`}>{fmtINR(p.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
          <p className="text-[10px] mt-2">
            Cr = the union owes the supplier · Dr = advance with the supplier. Purchases are the received lines in
            Stock Entry at the cost recorded there.
          </p>
        </>
      )}
    </div>
  );
}

function Cell({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <td className="border border-border py-1.5 px-2">
      <div className="text-[9.5px] uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className={`num ${strong ? "font-bold text-[12px]" : "font-medium"}`}>{value}</div>
    </td>
  );
}

function EntryDialog({ supplierId, supplierLabel, today, onClose, onDone }: {
  supplierId: string; supplierLabel: string; today: string; onClose: () => void; onDone: () => void;
}) {
  const [kind, setKind] = useState<"payment" | "opening" | "debit_note" | "credit_note">("payment");
  const [entryDate, setEntryDate] = useState(today);
  const [amount, setAmount] = useState("");
  const [mode, setMode] = useState("neft");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  const mut = useMutation({
    mutationFn: () => post<{ message: string }>(`/suppliers/${supplierId}/ledger-entries`, {
      entryDate, kind, amount: Number(amount),
      mode: kind === "payment" ? mode : null,
      reference: reference.trim() || null, notes: notes.trim() || null,
    }),
    onSuccess: (r) => { toast.success(r.message); onDone(); onClose(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  const needsNotes = kind === "debit_note" || kind === "credit_note";
  const valid = Number(amount) > 0 && !!entryDate && entryDate <= today && (!needsNotes || notes.trim().length >= 3);
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Supplier entry: {supplierLabel}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <Field label="Type" required>
            <select value={kind} onChange={e => setKind(e.target.value as typeof kind)} className="erp-input w-full h-8">
              <option value="payment">Payment made to supplier (Dr)</option>
              <option value="debit_note">Debit note: returns / short / damaged (Dr)</option>
              <option value="credit_note">Credit note: extra charges owed (Cr)</option>
              <option value="opening">Opening balance owed (Cr)</option>
            </select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Date" required>
              <Input type="date" value={entryDate} max={today} onChange={e => setEntryDate(e.target.value)} className="erp-input" />
            </Field>
            <Field label="Amount (₹)" required>
              <Input type="number" min="0" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="erp-input num" />
            </Field>
          </div>
          {kind === "payment" && (
            <div className="grid grid-cols-2 gap-3">
              <Field label="Mode" required>
                <select value={mode} onChange={e => setMode(e.target.value)} className="erp-input w-full h-8">
                  {["neft", "rtgs", "imps", "upi", "cheque", "cash"].map(m => <option key={m} value={m}>{m.toUpperCase()}</option>)}
                </select>
              </Field>
              <Field label="Reference / UTR / Cheque no.">
                <Input value={reference} onChange={e => setReference(e.target.value)} className="erp-input" />
              </Field>
            </div>
          )}
          <Field label={needsNotes ? "What it is for" : "Notes"} required={needsNotes}>
            <Textarea value={notes} onChange={e => setNotes(e.target.value)} className="erp-input min-h-[56px]" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Cancel</Button>
          <Button size="sm" className="h-8" disabled={!valid || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CancelDialog({ row, onClose, onDone }: { row: LedgerRow; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState("");
  const mut = useMutation({
    mutationFn: () => post<{ message: string }>(`/supplier-ledger-entries/${row.entryId}/cancel`, { reason }),
    onSuccess: (r) => { toast.success(r.message); onDone(); onClose(); },
    onError: (e: any) => toast.error(e?.message ?? "Failed"),
  });
  return (
    <Dialog open onOpenChange={v => { if (!v) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader><DialogTitle>Cancel {KIND_LABEL[row.kind].toLowerCase()}</DialogTitle></DialogHeader>
        <div className="space-y-3 text-[13px]">
          <p className="text-muted-foreground">{dmy(row.date)} · {row.particulars} · {fmtINR(row.debit || row.credit)}</p>
          <Field label="Reason" required hint="min 5 chars">
            <Textarea value={reason} onChange={e => setReason(e.target.value)} className="erp-input min-h-[56px]" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" className="h-8" onClick={onClose}>Back</Button>
          <Button size="sm" variant="destructive" className="h-8" disabled={reason.trim().length < 5 || mut.isPending} onClick={() => mut.mutate()}>
            {mut.isPending ? "Cancelling…" : "Cancel entry"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
