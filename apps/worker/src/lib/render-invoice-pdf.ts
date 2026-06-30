// ════════════════════════════════════════════════════════════════════
// apps/worker/src/lib/render-invoice-pdf.ts
//
// Shared PDF renderer for HMU dealer tax invoices (worker copy).
// Identical logic to apps/api/src/lib/render-invoice-pdf.ts — keep
// both in sync or extract to a shared workspace package later.
//
// NOTE: Standard fonts (Helvetica) are WinAnsiEncoding — do NOT use
// the ₹ symbol or any character outside Latin-1 in drawn text.
// ════════════════════════════════════════════════════════════════════
import { PDFDocument, StandardFonts, rgb, type PDFPage, type PDFFont } from "pdf-lib";

// ── Types ─────────────────────────────────────────────────────────────

export interface InvoiceRenderLine {
  productName: string;
  hsnNo:       string;
  packSize:    string;
  quantity:    number;
  unitPrice:   number;
  basic:       number;
  cgstAmount:  number;
  sgstAmount:  number;
  lineTotal:   number;
}

export interface InvoiceRenderParams {
  invoiceNumber: string;
  issueDate:     Date;
  deliveryDate:  Date;
  orderId:       string;
  paymentMode:   string;
  /** True when the order is placed/settled — draws a green "PAID" mark. */
  paid?:         boolean;
  dealer: {
    name:    string;
    code:    string | null;
    address: string | null;
    city:    string | null;
    state:   string | null;
    pin:     string | null;
    phone:   string | null;
    gst:     string | null;
  };
  route: { name: string | null; code: string | null };
  items:  InvoiceRenderLine[];
  totals: { taxable: number; cgst: number; sgst: number; grand: number };
}

// ── Helpers ───────────────────────────────────────────────────────────

function fmt(n: number): string {
  return n.toFixed(2);
}

function fmtDate(d: Date): string {
  const dd   = String(d.getDate()).padStart(2, "0");
  const mm   = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = d.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

// ── Colours ───────────────────────────────────────────────────────────
const C_WHITE  = rgb(1,    1,    1);
const C_BLACK  = rgb(0,    0,    0);
const C_DARK   = rgb(0.15, 0.15, 0.15);
const C_GRAY   = rgb(0.5,  0.5,  0.5);
const C_LGRAY  = rgb(0.85, 0.85, 0.85);
const C_STRIPE = rgb(0.96, 0.96, 0.96);
const C_BLUE   = rgb(0.08, 0.28, 0.58);
const C_GREEN  = rgb(0.13, 0.55, 0.27);

// ── Column layout (total width = 515 pt = A4 - 2×40 margins) ─────────
const COLS = [
  { header: "#",       w: 20,  align: "center" as const },
  { header: "Product", w: 175, align: "left"   as const },
  { header: "HSN",     w: 40,  align: "center" as const },
  { header: "Pack",    w: 35,  align: "center" as const },
  { header: "Qty",     w: 28,  align: "right"  as const },
  { header: "Rate",    w: 42,  align: "right"  as const },
  { header: "Basic",   w: 45,  align: "right"  as const },
  { header: "CGST",    w: 40,  align: "right"  as const },
  { header: "SGST",    w: 40,  align: "right"  as const },
  { header: "Total",   w: 50,  align: "right"  as const },
] as const;

// ── Main export ───────────────────────────────────────────────────────

export async function renderInvoicePdf(p: InvoiceRenderParams): Promise<Uint8Array> {
  const doc     = await PDFDocument.create();
  const fontReg = await doc.embedFont(StandardFonts.Helvetica);
  const fontBld = await doc.embedFont(StandardFonts.HelveticaBold);

  const PAGE_W  = 595.28;
  const PAGE_H  = 841.89;
  const MARGIN  = 40;
  const CW      = PAGE_W - MARGIN * 2;  // 515.28 pt
  const ROW_H   = 14;
  const HDR_H   = 16;
  const BOTTOM_THRESHOLD = MARGIN + 80;  // leave room for totals / footer

  // ── Page helpers ────────────────────────────────────────────────────
  let page!: PDFPage;
  let y!: number;

  function newPage() {
    page = doc.addPage([PAGE_W, PAGE_H]);
    y    = PAGE_H - MARGIN;
  }

  function drawText(
    t: string,
    x: number,
    ty: number,
    opts: {
      size?:     number;
      bold?:     boolean;
      color?:    ReturnType<typeof rgb>;
      align?:    "left" | "right" | "center";
      maxWidth?: number;
    } = {},
  ) {
    const f   = opts.bold ? fontBld : fontReg;
    const sz  = opts.size ?? 8.5;
    const col = opts.color ?? C_DARK;
    let   tx  = x;
    if (opts.align === "right" && opts.maxWidth != null) {
      tx = x + opts.maxWidth - f.widthOfTextAtSize(t, sz);
    } else if (opts.align === "center" && opts.maxWidth != null) {
      tx = x + (opts.maxWidth - f.widthOfTextAtSize(t, sz)) / 2;
    }
    page.drawText(t, { x: tx, y: ty, size: sz, font: f, color: col });
  }

  function hLine(
    ty:     number,
    x1     = MARGIN,
    x2     = PAGE_W - MARGIN,
    thick  = 0.5,
    color  = C_LGRAY,
  ) {
    page.drawLine({ start: { x: x1, y: ty }, end: { x: x2, y: ty }, thickness: thick, color });
  }

  function fillRect(
    rx: number, ry: number, rw: number, rh: number,
    fill?:   ReturnType<typeof rgb>,
    border?: ReturnType<typeof rgb>,
  ) {
    page.drawRectangle({
      x: rx, y: ry, width: rw, height: rh,
      color:       fill,
      borderColor: border,
      borderWidth: border ? 0.5 : 0,
    });
  }

  // ── First page ───────────────────────────────────────────────────────
  newPage();

  // ── Company header band ─────────────────────────────────────────────
  fillRect(MARGIN, y - 54, CW, 54, C_BLUE);

  // left text: company name, address, GSTIN
  drawText("HAVERI MILK UNION", MARGIN + 8, y - 17,
    { size: 15, bold: true, color: C_WHITE });
  drawText("Karnataka Co-operative Milk Producers Federation Ltd.", MARGIN + 8, y - 29,
    { size: 7.5, color: C_WHITE });
  drawText("GSTIN: 29AABCK1234F1Z0   |   FSSAI: 10019042000441", MARGIN + 8, y - 41,
    { size: 7.5, color: C_WHITE });

  // right badge: TAX INVOICE
  const BADGE_W = 108;
  fillRect(PAGE_W - MARGIN - BADGE_W, y - 44, BADGE_W, 30, C_WHITE);
  drawText("TAX INVOICE", PAGE_W - MARGIN - BADGE_W + 6, y - 25,
    { size: 12, bold: true, color: C_BLUE });
  drawText("ORIGINAL", PAGE_W - MARGIN - BADGE_W + 28, y - 38,
    { size: 7, color: C_BLUE });

  y -= 60;

  // ── Two-column info box ─────────────────────────────────────────────
  const HALF    = CW / 2 - 4;
  const BOX_H   = 72;
  const COL_R   = MARGIN + HALF + 8;
  fillRect(MARGIN,  y - BOX_H, HALF,  BOX_H, undefined, C_LGRAY);
  fillRect(COL_R,   y - BOX_H, HALF,  BOX_H, undefined, C_LGRAY);

  // Left: Invoice meta
  let ly = y - 11;
  const LBL_W = 78;
  drawText("Invoice No :", MARGIN + 6, ly, { size: 8, bold: true });
  drawText(p.invoiceNumber, MARGIN + LBL_W, ly, { size: 8 });
  ly -= 13;
  drawText("Invoice Date :", MARGIN + 6, ly, { size: 8, bold: true });
  drawText(fmtDate(p.issueDate), MARGIN + LBL_W, ly, { size: 8 });
  ly -= 13;
  drawText("Delivery Date :", MARGIN + 6, ly, { size: 8, bold: true });
  drawText(fmtDate(p.deliveryDate), MARGIN + LBL_W, ly, { size: 8 });
  ly -= 13;
  drawText("Order ID :", MARGIN + 6, ly, { size: 8, bold: true });
  drawText(p.orderId.slice(0, 16).toUpperCase(), MARGIN + LBL_W, ly, { size: 8 });
  ly -= 13;
  drawText("Payment :", MARGIN + 6, ly, { size: 8, bold: true });
  const payLabel = p.paymentMode.charAt(0).toUpperCase() + p.paymentMode.slice(1);
  drawText(payLabel, MARGIN + LBL_W, ly, { size: 8 });
  if (p.paid) {
    const lw = fontReg.widthOfTextAtSize(payLabel, 8);
    drawText("PAID", MARGIN + LBL_W + lw + 10, ly, { size: 8, bold: true, color: C_GREEN });
  }

  // Right: Bill To
  let ry = y - 11;
  drawText("Bill To", COL_R + 6, ry, { size: 8, bold: true, color: C_BLUE });
  ry -= 13;
  drawText(p.dealer.name ?? "", COL_R + 6, ry, { size: 9, bold: true });
  ry -= 13;
  if (p.dealer.code) {
    drawText(`Agency: ${p.dealer.code}`, COL_R + 6, ry, { size: 8, color: C_GRAY });
    ry -= 12;
  }
  if (p.dealer.phone) {
    drawText(`Phone: ${p.dealer.phone}`, COL_R + 6, ry, { size: 8 });
    ry -= 12;
  }
  if (p.dealer.gst) {
    drawText(`GSTIN: ${p.dealer.gst}`, COL_R + 6, ry, { size: 8 });
    ry -= 12;
  }
  const addrParts = [p.dealer.address, p.dealer.city, p.dealer.state, p.dealer.pin].filter(Boolean);
  if (addrParts.length) {
    const addrLine = addrParts.join(", ");
    drawText(addrLine.slice(0, 52), COL_R + 6, ry, { size: 7.5, color: C_GRAY });
  }

  y -= BOX_H + 6;

  // Route strip
  const routeStr = [p.route.code, p.route.name].filter(Boolean).join(" - ");
  if (routeStr) {
    drawText(`Route: ${routeStr}`, MARGIN, y, { size: 8, color: C_GRAY });
    y -= 14;
  } else {
    y -= 4;
  }

  // ── Table header ──────────────────────────────────────────────────
  function drawTableHeader() {
    fillRect(MARGIN, y - HDR_H, CW, HDR_H, C_BLUE);
    let cx = MARGIN;
    for (const col of COLS) {
      drawText(col.header, cx + 3, y - 11,
        { size: 7.5, bold: true, color: C_WHITE, align: col.align, maxWidth: col.w - 6 });
      cx += col.w;
    }
    y -= HDR_H;
  }

  drawTableHeader();

  // ── Item rows ──────────────────────────────────────────────────────
  for (let i = 0; i < p.items.length; i++) {
    // Check if we need a new page
    if (y - ROW_H < BOTTOM_THRESHOLD) {
      newPage();
      drawTableHeader();
    }

    const item = p.items[i]!;
    if (i % 2 === 1) fillRect(MARGIN, y - ROW_H, CW, ROW_H, C_STRIPE);

    const productDisplay =
      item.productName.length > 30
        ? item.productName.slice(0, 28) + ".."
        : item.productName;

    const vals: string[] = [
      String(i + 1),
      productDisplay,
      item.hsnNo   || "-",
      item.packSize || "-",
      String(item.quantity),
      fmt(item.unitPrice),
      fmt(item.basic),
      fmt(item.cgstAmount),
      fmt(item.sgstAmount),
      fmt(item.lineTotal),
    ];

    let cx = MARGIN;
    for (let c = 0; c < COLS.length; c++) {
      const col = COLS[c]!;
      drawText(vals[c] ?? "", cx + 3, y - 10,
        { size: 7.5, align: col.align, maxWidth: col.w - 6 });
      cx += col.w;
    }

    hLine(y - ROW_H, MARGIN, MARGIN + CW, 0.3, rgb(0.88, 0.88, 0.88));
    y -= ROW_H;
  }

  // ── Totals ────────────────────────────────────────────────────────
  // Make sure totals fit on current page; if not, new page
  const TOTALS_H = 4 + 14 * 4 + 10 + 30;
  if (y - TOTALS_H < MARGIN) {
    newPage();
  }

  y -= 6;
  hLine(y, MARGIN, MARGIN + CW, 1, C_BLUE);
  y -= 16;

  const TOT_X   = MARGIN + CW - 200;
  const LAB_W   = 130;
  const VAL_W   = 68;

  function totRow(label: string, value: string, highlight = false) {
    if (highlight) {
      fillRect(TOT_X, y - 14, LAB_W + VAL_W, 14, C_BLUE);
    }
    const col = highlight ? C_WHITE : C_DARK;
    drawText(label, TOT_X + 5, y - 10,  { size: 8.5, bold: highlight, color: col });
    drawText(value, TOT_X + LAB_W, y - 10,
      { size: 8.5, bold: highlight, color: col, align: "right", maxWidth: VAL_W - 5 });
    if (!highlight) hLine(y - 14, TOT_X, TOT_X + LAB_W + VAL_W, 0.3, C_LGRAY);
    y -= 14;
  }

  totRow("Taxable Amount", `Rs. ${fmt(p.totals.taxable)}`);
  totRow("CGST",           `Rs. ${fmt(p.totals.cgst)}`);
  totRow("SGST",           `Rs. ${fmt(p.totals.sgst)}`);
  totRow("GRAND TOTAL",    `Rs. ${fmt(p.totals.grand)}`, true);

  y -= 12;

  // ── Footer ────────────────────────────────────────────────────────
  hLine(y, MARGIN, MARGIN + CW, 0.5, C_LGRAY);
  y -= 12;
  drawText(
    "This is a computer-generated invoice and does not require a signature.",
    MARGIN, y, { size: 7, color: C_GRAY }
  );
  y -= 10;
  drawText(
    "Goods once sold cannot be returned. Subject to Haveri jurisdiction.",
    MARGIN, y, { size: 7, color: C_GRAY }
  );

  return doc.save();
}
