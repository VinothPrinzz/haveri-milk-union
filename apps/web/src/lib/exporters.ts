// apps/web/src/lib/exporters.ts
// ════════════════════════════════════════════════════════════════════
// Shared export helpers for report pages.
// Currently supports:
//   • CSV               — RFC 4180-ish, Excel-friendly
//   • Tally CSV         — Tally's flat voucher-import CSV layout
//   • Tally XML         — Tally's "Import Data" envelope (Sales voucher)
//
// The Tally generators use generic ledger names ("Sales A/c", "Cash",
// "CGST", "SGST", "IGST") because actual ledger names vary per
// installation. Adjust LEDGER_MAP below if your Tally chart uses
// different names.
// ════════════════════════════════════════════════════════════════════

// ── CSV ─────────────────────────────────────────────────────────────
type Cell = string | number | null | undefined;

export function toCsv(rows: Cell[][]): string {
  const escape = (v: Cell) => {
    if (v == null) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map(r => r.map(escape).join(",")).join("\r\n");
}

// ── Tally Ledger Map (edit per installation) ────────────────────────
export const LEDGER_MAP = {
  cashLedger:  "Cash",
  salesLedger: "Sales A/c",
  cgstLedger:  "CGST",
  sgstLedger:  "SGST",
  igstLedger:  "IGST",
  company:     "Haveri Milk Union",
};

// ── Tally CSV (flat voucher format) ─────────────────────────────────
// Header columns recognised by Tally's CSV importer (Tally Prime &
// recent ERP9). Tweak header order if your importer template differs.
const TALLY_CSV_HEADER = [
  "Date", "Voucher Type", "Voucher Number", "Reference",
  "Party Ledger", "Debit Ledger", "Credit Ledger",
  "Debit Amount", "Credit Amount", "Narration",
];

export type TallyVoucher = {
  date: string;          // YYYY-MM-DD
  vchType: "Sales" | "Receipt" | "Payment" | "Journal";
  vchNo: string;
  reference?: string;
  partyLedger?: string;
  debitLedger: string;
  creditLedger: string;
  amount: number;
  narration?: string;
};

export function toTallyCsv(vouchers: TallyVoucher[]): string {
  const rows: Cell[][] = [TALLY_CSV_HEADER];
  for (const v of vouchers) {
    rows.push([
      v.date,
      v.vchType,
      v.vchNo,
      v.reference ?? "",
      v.partyLedger ?? "",
      v.debitLedger,
      v.creditLedger,
      v.amount.toFixed(2),
      v.amount.toFixed(2),
      v.narration ?? "",
    ]);
  }
  return toCsv(rows);
}

// ── Tally XML (Import Data envelope) ────────────────────────────────
// Each voucher writes a balanced pair of ledger entries.
// For sales: party (or cash) DR, sales A/c CR (+ optional GST CR).

export type TallySalesVoucher = {
  date: string;          // YYYY-MM-DD
  vchNo: string;
  partyLedger: string;
  amountInclGst: number; // total to debit the party
  baseAmount: number;    // sales A/c credit (excl GST)
  cgst?: number;
  sgst?: number;
  igst?: number;
  narration?: string;
};

const xmlEscape = (s: string | number) =>
  String(s).replace(/[<>&"']/g, c =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" }[c]!)
  );

const ymd = (iso: string) => iso.replace(/-/g, ""); // 2026-05-04 → 20260504

function entry(ledger: string, amount: number, deemedPositive: boolean) {
  // In Tally XML, party-debited entries are DEEMED POSITIVE; credits negative.
  const sign = deemedPositive ? "" : "-";
  return `
            <ALLLEDGERENTRIES.LIST>
              <LEDGERNAME>${xmlEscape(ledger)}</LEDGERNAME>
              <ISDEEMEDPOSITIVE>${deemedPositive ? "Yes" : "No"}</ISDEEMEDPOSITIVE>
              <AMOUNT>${sign}${amount.toFixed(2)}</AMOUNT>
            </ALLLEDGERENTRIES.LIST>`;
}

export function toTallyXml(vouchers: TallySalesVoucher[], company = LEDGER_MAP.company): string {
  const messages = vouchers.map(v => {
    const entries = [
      // Party DR (deemed positive, but signed negative in <AMOUNT>)
      entry(v.partyLedger, v.amountInclGst, true).replace(/<AMOUNT>(-?)/, "<AMOUNT>-"),
      // Sales A/c CR
      entry(LEDGER_MAP.salesLedger, v.baseAmount, false),
      v.cgst ? entry(LEDGER_MAP.cgstLedger, v.cgst, false) : "",
      v.sgst ? entry(LEDGER_MAP.sgstLedger, v.sgst, false) : "",
      v.igst ? entry(LEDGER_MAP.igstLedger, v.igst, false) : "",
    ].join("");

    return `
        <TALLYMESSAGE xmlns:UDF="TallyUDF">
          <VOUCHER VCHTYPE="Sales" ACTION="Create" OBJVIEW="Invoice Voucher View">
            <DATE>${ymd(v.date)}</DATE>
            <NARRATION>${xmlEscape(v.narration ?? "")}</NARRATION>
            <VOUCHERTYPENAME>Sales</VOUCHERTYPENAME>
            <VOUCHERNUMBER>${xmlEscape(v.vchNo)}</VOUCHERNUMBER>
            <PARTYLEDGERNAME>${xmlEscape(v.partyLedger)}</PARTYLEDGERNAME>
            <REFERENCE>${xmlEscape(v.vchNo)}</REFERENCE>${entries}
          </VOUCHER>
        </TALLYMESSAGE>`;
  }).join("");

  return `<?xml version="1.0" encoding="UTF-8"?>
<ENVELOPE>
  <HEADER>
    <TALLYREQUEST>Import Data</TALLYREQUEST>
  </HEADER>
  <BODY>
    <IMPORTDATA>
      <REQUESTDESC>
        <REPORTNAME>Vouchers</REPORTNAME>
        <STATICVARIABLES>
          <SVCURRENTCOMPANY>${xmlEscape(company)}</SVCURRENTCOMPANY>
        </STATICVARIABLES>
      </REQUESTDESC>
      <REQUESTDATA>${messages}
      </REQUESTDATA>
    </IMPORTDATA>
  </BODY>
</ENVELOPE>
`;
}