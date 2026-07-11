// ════════════════════════════════════════════════════════════════════
// render-invoice-pdf.ts
//
// SHARED, DB-AGNOSTIC invoice PDF renderer.
//
// This is the single source of truth for the MANMUL-format A4 GST tax
// invoice layout — the same one the admin panel shows in
// web/src/pages/sales/InvoiceDetailPage.tsx.
//
// It takes a plain data object and returns PDF bytes. It does NOT touch
// the database or R2. Callers (apps/api/src/lib/invoice-pdf.ts and
// apps/worker/src/jobs/pdf-invoices.ts) are each responsible for
// fetching their own data and persisting the result with their own
// DB client. That way the layout can never diverge between app- and
// worker-generated invoices again.
//
// Recommended location: a shared workspace package, e.g.
//   packages/invoicing/src/render-invoice-pdf.ts   (exported as @hmu/invoicing)
// If you are not ready to add a package yet, copy this file into BOTH
//   apps/api/src/lib/   and   apps/worker/src/lib/
// — but a shared package is strongly preferred.
// ════════════════════════════════════════════════════════════════════
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";

// ── Public input types ───────────────────────────────────────────────
export interface InvoiceRenderLine {
  productName: string;
  hsnNo: string;
  packSize: string;
  quantity: number;
  unitPrice: number;
  basic: number; // quantity * unitPrice, pre-GST
  cgstAmount: number;
  sgstAmount: number;
  lineTotal: number;
}

export interface InvoiceRenderData {
  invoiceNumber: string;
  issueDate: Date; // legal GST date of issue
  deliveryDate: Date; // date the indent is FOR
  orderId: string;
  paymentMode: string;
  dealer: {
    name: string;
    code?: string | null;
    address?: string | null;
    city?: string | null;
    state?: string | null;
    pin?: string | null;
    phone?: string | null;
    gst?: string | null;
  };
  route?: { name?: string | null; code?: string | null } | null;
  items: InvoiceRenderLine[];
  totals: {
    taxable: number;
    cgst: number;
    sgst: number;
    grand: number; // pre-rounding; the renderer rounds for display
  };
}

// ── Company info — mirrors COMPANY in admin InvoiceDetailPage.tsx ─────
const COMPANY = {
  name: "Haveri District Co-operative Milk Producers Societies Union Ltd",
  gstin: "29AADAH7841L1Z6",
  pan: "AADAH7841L",
  address: "Veterinary Hospital Compound, PB Road, Haveri - 581110",
  phone: "08375200650",
  email: "admin@haverimunion.coop",
  fssai: "10012043000208",
  stateName: "KARNATAKA",
  stateCode: "29",
};

// ── Page geometry (A4) ───────────────────────────────────────────────
const PAGE_W = 595;
const PAGE_H = 842;
const MARGIN = 40;
const CONTENT_W = PAGE_W - MARGIN * 2; // 515

// ── Colours ──────────────────────────────────────────────────────────
const BLACK = rgb(0, 0, 0);
const GRAY = rgb(0.4, 0.4, 0.4);
const LINE = rgb(0.2, 0.2, 0.2);
const HAIR = rgb(0.72, 0.72, 0.72);

// ── Format helpers ───────────────────────────────────────────────────
const fmt2 = (n: number | string | null | undefined): string => {
  const v = typeof n === "string" ? parseFloat(n) : n ?? 0;
  return Number.isFinite(v) ? (v as number).toFixed(2) : "0.00";
};
const fmtQty = (q: number): string => (q % 1 === 0 ? String(q) : q.toFixed(2));
const fmtDate = (d: Date): string =>
  d.toLocaleDateString("en-IN", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });

// ── Indian-system number to words (UPPERCASE, no currency suffix) ─────
function numToWordsIndian(num: number): string {
  const n = Math.round(num);
  if (n === 0) return "ZERO";

  const ones = [
    "", "ONE", "TWO", "THREE", "FOUR", "FIVE", "SIX", "SEVEN", "EIGHT", "NINE",
    "TEN", "ELEVEN", "TWELVE", "THIRTEEN", "FOURTEEN", "FIFTEEN", "SIXTEEN",
    "SEVENTEEN", "EIGHTEEN", "NINETEEN",
  ];
  const tens = [
    "", "", "TWENTY", "THIRTY", "FORTY", "FIFTY", "SIXTY", "SEVENTY", "EIGHTY",
    "NINETY",
  ];

  const two = (x: number): string => {
    if (x < 20) return ones[x]!;
    const t = Math.floor(x / 10);
    const o = x % 10;
    return o ? `${tens[t]}-${ones[o]}` : tens[t]!;
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
  const lakh = Math.floor((n % 10000000) / 100000);
  const thou = Math.floor((n % 100000) / 1000);
  const rest = n % 1000;

  const parts: string[] = [];
  if (crore) parts.push(`${two(crore)} CRORE`);
  if (lakh) parts.push(`${two(lakh)} LAKH`);
  if (thou) parts.push(`${two(thou)} THOUSAND`);
  if (rest) parts.push(three(rest));
  return parts.join(" ");
}

// ── Low-level drawing helpers ────────────────────────────────────────
function clip(text: string, font: PDFFont, size: number, maxW: number): string {
  let s = String(text ?? "");
  if (font.widthOfTextAtSize(s, size) <= maxW) return s;
  while (s.length > 1 && font.widthOfTextAtSize(s + "…", size) > maxW) {
    s = s.slice(0, -1);
  }
  return s + "…";
}

function drawRight(
  page: PDFPage,
  text: string,
  xRight: number,
  y: number,
  font: PDFFont,
  size: number,
  color = BLACK
): void {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, { x: xRight - w, y, size, font, color });
}

function drawCenter(
  page: PDFPage,
  text: string,
  xLeft: number,
  xRight: number,
  y: number,
  font: PDFFont,
  size: number,
  color = BLACK
): void {
  const w = font.widthOfTextAtSize(text, size);
  page.drawText(text, {
    x: xLeft + (xRight - xLeft - w) / 2,
    y,
    size,
    font,
    color,
  });
}

// ════════════════════════════════════════════════════════════════════
// MAIN — render the invoice and return PDF bytes
// ════════════════════════════════════════════════════════════════════
export async function renderInvoicePdf(
  data: InvoiceRenderData
): Promise<Uint8Array> {
  const { dealer } = data;

  const taxable = data.totals.taxable;
  const cgst = data.totals.cgst;
  const sgst = data.totals.sgst;
  const grand = data.totals.grand;
  const netAmount = Math.round(grand);
  const roundingAdj = +(netAmount - grand).toFixed(2);

  const doc = await PDFDocument.create();
  const page = doc.addPage([PAGE_W, PAGE_H]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let y = PAGE_H - MARGIN;

  // ── LETTERHEAD ─────────────────────────────────────────────────────
  drawCenter(page, COMPANY.name, MARGIN, PAGE_W - MARGIN, y, bold, 12);
  y -= 14;
  drawCenter(
    page,
    `GST No.: ${COMPANY.gstin}   |   ${COMPANY.address}`,
    MARGIN,
    PAGE_W - MARGIN,
    y,
    font,
    7.5,
    GRAY
  );
  y -= 11;
  drawCenter(
    page,
    `Phone: ${COMPANY.phone}   |   Email: ${COMPANY.email}`,
    MARGIN,
    PAGE_W - MARGIN,
    y,
    font,
    7.5,
    GRAY
  );
  y -= 18;
  drawCenter(page, "TAX INVOICE", MARGIN, PAGE_W - MARGIN, y, bold, 13);
  y -= 8;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: PAGE_W - MARGIN, y },
    thickness: 1,
    color: LINE,
  });
  y -= 16;

  // ── INVOICE META (two columns) — shows BOTH dates ──────────────────
  const colL = MARGIN;
  const colR = MARGIN + CONTENT_W / 2;
  const metaRow = (
    lLabel: string,
    lValue: string,
    rLabel: string,
    rValue: string
  ) => {
    page.drawText(lLabel, { x: colL, y, size: 8, font, color: GRAY });
    page.drawText(lValue, { x: colL + 78, y, size: 8, font: bold, color: BLACK });
    if (rLabel) {
      page.drawText(rLabel, { x: colR, y, size: 8, font, color: GRAY });
      page.drawText(rValue, {
        x: colR + 78,
        y,
        size: 8,
        font: bold,
        color: BLACK,
      });
    }
    y -= 13;
  };

  const routeDisplay = data.route?.name
    ? `${data.route.name}${data.route.code ? ` [${data.route.code}]` : ""}`
    : "-";

  metaRow(
    "Invoice No :",
    data.invoiceNumber,
    "Invoice Date :",
    fmtDate(data.issueDate)
  );
  metaRow(
    "GSTIN :",
    COMPANY.gstin,
    "Delivery Date :",
    fmtDate(data.deliveryDate)
  );
  metaRow("PAN No :", COMPANY.pan, "State :", COMPANY.stateName);
  metaRow("Route Name :", routeDisplay, "State Code :", COMPANY.stateCode);
  metaRow(
    "FSSAI Licence :",
    COMPANY.fssai,
    "Order ID :",
    data.orderId.slice(0, 16)
  );
  y -= 4;

  // ── RECEIVER / BILL TO ─────────────────────────────────────────────
  page.drawRectangle({
    x: MARGIN,
    y: y - 12,
    width: CONTENT_W,
    height: 14,
    color: rgb(0.94, 0.94, 0.94),
  });
  drawCenter(
    page,
    "DETAILS OF RECEIVER / BILL TO",
    MARGIN,
    PAGE_W - MARGIN,
    y - 8,
    bold,
    8.5
  );
  y -= 26;

  page.drawText(dealer.name ?? "-", {
    x: colL,
    y,
    size: 10,
    font: bold,
    color: BLACK,
  });
  if (dealer.code) {
    page.drawText(`Code: ${dealer.code}`, {
      x: colR,
      y,
      size: 8,
      font,
      color: GRAY,
    });
  }
  y -= 13;

  const addressLine = [dealer.address, dealer.city, dealer.state, dealer.pin]
    .filter(Boolean)
    .join(", ");
  if (addressLine) {
    page.drawText(clip(addressLine, font, 8, CONTENT_W), {
      x: colL,
      y,
      size: 8,
      font,
      color: BLACK,
    });
    y -= 13;
  }
  page.drawText(`Phone: ${dealer.phone ?? "-"}`, {
    x: colL,
    y,
    size: 8,
    font,
    color: BLACK,
  });
  page.drawText(`GSTIN: ${dealer.gst ?? "Unregistered"}`, {
    x: colR,
    y,
    size: 8,
    font,
    color: BLACK,
  });
  y -= 20;

  // ── ITEMS TABLE ────────────────────────────────────────────────────
  //  Sr | Description | HSN | Qty | Rate | Taxable | CGST | SGST | Total
  const cx = {
    sr: MARGIN,
    desc: MARGIN + 24,
    hsn: MARGIN + 168,
    qty: MARGIN + 214,
    rate: MARGIN + 250,
    basic: MARGIN + 304,
    cgst: MARGIN + 366,
    sgst: MARGIN + 422,
    total: MARGIN + 478,
    end: MARGIN + CONTENT_W,
  };

  const headerY = y;
  page.drawLine({
    start: { x: MARGIN, y: headerY + 11 },
    end: { x: cx.end, y: headerY + 11 },
    thickness: 1,
    color: LINE,
  });
  page.drawText("Sr", { x: cx.sr, y, size: 7.5, font: bold, color: BLACK });
  page.drawText("Description", {
    x: cx.desc,
    y,
    size: 7.5,
    font: bold,
    color: BLACK,
  });
  page.drawText("HSN", { x: cx.hsn, y, size: 7.5, font: bold, color: BLACK });
  drawRight(page, "Qty", cx.rate - 4, y, bold, 7.5);
  drawRight(page, "Rate", cx.basic - 4, y, bold, 7.5);
  drawRight(page, "Taxable", cx.cgst - 4, y, bold, 7.5);
  drawRight(page, "CGST", cx.sgst - 4, y, bold, 7.5);
  drawRight(page, "SGST", cx.total - 4, y, bold, 7.5);
  drawRight(page, "Total", cx.end, y, bold, 7.5);
  y -= 4;
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: cx.end, y },
    thickness: 1,
    color: LINE,
  });
  y -= 13;

  let sr = 0;
  for (const it of data.items) {
    sr += 1;
    const qty = Number(it.quantity ?? 0);
    const name = it.packSize
      ? `${it.productName} (${it.packSize})`
      : String(it.productName ?? "");

    page.drawText(String(sr), { x: cx.sr, y, size: 7.5, font, color: BLACK });
    page.drawText(clip(name, font, 7.5, cx.hsn - cx.desc - 4), {
      x: cx.desc,
      y,
      size: 7.5,
      font,
      color: BLACK,
    });
    page.drawText(clip(String(it.hsnNo ?? ""), font, 7.5, 40), {
      x: cx.hsn,
      y,
      size: 7.5,
      font,
      color: BLACK,
    });
    drawRight(page, fmtQty(qty), cx.rate - 4, y, font, 7.5);
    drawRight(page, fmt2(it.unitPrice), cx.basic - 4, y, font, 7.5);
    drawRight(page, fmt2(it.basic), cx.cgst - 4, y, font, 7.5);
    drawRight(page, fmt2(it.cgstAmount), cx.sgst - 4, y, font, 7.5);
    drawRight(page, fmt2(it.sgstAmount), cx.total - 4, y, font, 7.5);
    drawRight(page, fmt2(it.lineTotal), cx.end, y, bold, 7.5);
    y -= 6;
    page.drawLine({
      start: { x: MARGIN, y },
      end: { x: cx.end, y },
      thickness: 0.4,
      color: HAIR,
    });
    y -= 13;
  }

  // ── TOTALS BLOCK ───────────────────────────────────────────────────
  y -= 4;
  const totLabelX = cx.basic;
  const totalsRow = (label: string, value: string, isBold = false) => {
    page.drawText(label, {
      x: totLabelX,
      y,
      size: isBold ? 9 : 8,
      font: isBold ? bold : font,
      color: BLACK,
    });
    drawRight(page, value, cx.end, y, isBold ? bold : font, isBold ? 9 : 8);
    y -= 14;
  };

  totalsRow("Taxable Value", fmt2(taxable));
  totalsRow("CGST", fmt2(cgst));
  totalsRow("SGST", fmt2(sgst));
  if (roundingAdj !== 0) totalsRow("Rounding Adj.", fmt2(roundingAdj));
  page.drawLine({
    start: { x: totLabelX, y: y + 4 },
    end: { x: cx.end, y: y + 4 },
    thickness: 1,
    color: LINE,
  });
  y -= 4;
  totalsRow("GRAND TOTAL", fmt2(netAmount), true);
  page.drawLine({
    start: { x: totLabelX, y: y + 6 },
    end: { x: cx.end, y: y + 6 },
    thickness: 1,
    color: LINE,
  });
  y -= 8;

  // ── AMOUNT IN WORDS ────────────────────────────────────────────────
  page.drawText("Amount in words:", {
    x: MARGIN,
    y,
    size: 8,
    font: bold,
    color: BLACK,
  });
  y -= 12;
  page.drawText(
    clip(`RUPEES ${numToWordsIndian(netAmount)} ONLY`, font, 8.5, CONTENT_W),
    { x: MARGIN, y, size: 8.5, font, color: BLACK }
  );
  y -= 24;

  // ── FOOTER ─────────────────────────────────────────────────────────
  page.drawLine({
    start: { x: MARGIN, y },
    end: { x: cx.end, y },
    thickness: 0.5,
    color: HAIR,
  });
  y -= 14;
  page.drawText(`Payment Mode: ${data.paymentMode || "Wallet"}`, {
    x: MARGIN,
    y,
    size: 8,
    font,
    color: GRAY,
  });
  drawRight(page, `For ${COMPANY.name}`, cx.end, y, font, 8, GRAY);
  y -= 28;
  drawRight(page, "Authorised Signatory", cx.end, y, font, 8, GRAY);
  y -= 18;
  page.drawText(
    "This is a computer-generated invoice and does not require a signature.",
    { x: MARGIN, y, size: 7, font, color: GRAY }
  );

  return await doc.save();
}