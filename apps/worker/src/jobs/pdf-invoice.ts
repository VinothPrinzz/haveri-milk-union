import { Job } from "bullmq";
import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { sql } from "../lib/db.js";
import { uploadPDF } from "../lib/r2.js";

export interface PDFInvoiceJobData {
  orderId: string;
}

export async function processPDFInvoice(job: Job<PDFInvoiceJobData>) {
  const { orderId } = job.data;

  // Fetch order + items + dealer
  const [order] = await sql`
    SELECT o.*, d.name AS dealer_name, d.phone AS dealer_phone,
           d.gst_number AS dealer_gst, d.address AS dealer_address,
           d.city AS dealer_city, d.pin_code AS dealer_pin,
           z.name AS zone_name
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    JOIN zones z ON z.id = o.zone_id
    WHERE o.id = ${orderId}
  `;

  if (!order) throw new Error(`Order ${orderId} not found`);

  const items = await sql`
    SELECT product_name, quantity, unit_price, gst_percent, gst_amount, line_total
    FROM order_items WHERE order_id = ${orderId} ORDER BY product_name
  `;

  // Generate invoice number
  const invoiceNumber = `INV-HMU-${new Date().getFullYear()}-${orderId.slice(0, 4).toUpperCase()}`;

  // ── Build PDF ──
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]); // A4
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const { width, height } = page.getSize();

  const black = rgb(0, 0, 0);
  const gray = rgb(0.4, 0.4, 0.4);
  const brand = rgb(0.08, 0.28, 0.8);

  let y = height - 50;

  // Header
  page.drawText("HAVERI DISTRICT CO-OPERATIVE MILK PRODUCERS' UNION", { x: 50, y, size: 11, font: fontBold, color: brand });
  y -= 16;
  page.drawText("Main Road, Haveri, Karnataka 581110 | GSTIN: 29AABCH1234F1Z5", { x: 50, y, size: 8, font, color: gray });
  y -= 30;

  // Invoice title
  page.drawText("TAX INVOICE", { x: 50, y, size: 14, font: fontBold, color: black });
  y -= 18;
  page.drawText(`Invoice No: ${invoiceNumber}`, { x: 50, y, size: 9, font, color: black });
  page.drawText(`Date: ${new Date(order.created_at).toLocaleDateString("en-IN")}`, { x: 350, y, size: 9, font, color: black });
  y -= 14;
  page.drawText(`Order ID: ${orderId.slice(0, 16)}`, { x: 50, y, size: 9, font, color: gray });
  y -= 25;

  // Bill To
  page.drawText("Bill To:", { x: 50, y, size: 9, font: fontBold, color: black });
  y -= 14;
  page.drawText(order.dealer_name, { x: 50, y, size: 10, font: fontBold, color: black });
  y -= 13;
  page.drawText(`Phone: ${order.dealer_phone}`, { x: 50, y, size: 8, font, color: gray });
  y -= 13;
  if (order.dealer_gst) page.drawText(`GSTIN: ${order.dealer_gst}`, { x: 50, y, size: 8, font, color: gray });
  y -= 13;
  if (order.dealer_address) page.drawText(`${order.dealer_address}, ${order.dealer_city || ""} ${order.dealer_pin || ""}`, { x: 50, y, size: 8, font, color: gray });
  y -= 25;

  // Table header
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: brand });
  y -= 14;
  const cols = [50, 220, 280, 330, 390, 450, 505];
  ["Item", "Qty", "Rate", "GST %", "GST Amt", "Total"].forEach((h, i) => {
    page.drawText(h, { x: cols[i]!, y, size: 8, font: fontBold, color: black });
  });
  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: gray });
  y -= 14;

  // Table rows
  for (const item of items) {
    page.drawText(item.product_name, { x: 50, y, size: 8, font, color: black });
    page.drawText(String(item.quantity), { x: 220, y, size: 8, font, color: black });
    page.drawText(`₹${parseFloat(item.unit_price).toFixed(2)}`, { x: 280, y, size: 8, font, color: black });
    page.drawText(`${parseFloat(item.gst_percent)}%`, { x: 330, y, size: 8, font, color: black });
    page.drawText(`₹${parseFloat(item.gst_amount).toFixed(2)}`, { x: 390, y, size: 8, font, color: black });
    page.drawText(`₹${parseFloat(item.line_total).toFixed(2)}`, { x: 450, y, size: 8, font: fontBold, color: black });
    y -= 16;
  }

  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: brand });
  y -= 20;

  // Totals
  const subtotal = parseFloat(order.subtotal);
  const totalGst = parseFloat(order.total_gst);
  const cgst = totalGst / 2;
  const sgst = totalGst / 2;
  const grand = parseFloat(order.grand_total);

  [
    ["Subtotal", `₹${subtotal.toFixed(2)}`],
    ["CGST", `₹${cgst.toFixed(2)}`],
    ["SGST", `₹${sgst.toFixed(2)}`],
    ["Grand Total", `₹${grand.toFixed(2)}`],
  ].forEach(([label, val], i) => {
    const isBold = i === 3;
    page.drawText(label!, { x: 380, y, size: isBold ? 10 : 9, font: isBold ? fontBold : font, color: black });
    page.drawText(val!, { x: 480, y, size: isBold ? 10 : 9, font: fontBold, color: isBold ? brand : black });
    y -= 16;
  });

  y -= 20;
  page.drawText("Payment Mode: " + (order.payment_mode || "Wallet"), { x: 50, y, size: 8, font, color: gray });
  y -= 14;
  page.drawText("This is a computer-generated invoice and does not require a signature.", { x: 50, y, size: 7, font, color: gray });

  // Save PDF
  const pdfBytes = await doc.save();
  const key = `invoices/${new Date().getFullYear()}/${invoiceNumber}.pdf`;

  // Upload to R2
  const pdfUrl = await uploadPDF(key, pdfBytes);

  // Save invoice record to DB
  await sql`
    INSERT INTO invoices (order_id, dealer_id, invoice_number, invoice_date,
      taxable_amount, cgst, sgst, total_tax, total_amount,
      dealer_name, dealer_gst_number, pdf_url)
    VALUES (${orderId}, ${order.dealer_id}, ${invoiceNumber}, ${order.created_at},
      ${subtotal}::numeric, ${cgst}::numeric, ${sgst}::numeric, ${totalGst}::numeric, ${grand}::numeric,
      ${order.dealer_name}, ${order.dealer_gst || null}, ${pdfUrl})
    ON CONFLICT (order_id) DO UPDATE SET pdf_url = ${pdfUrl}, updated_at = now()
  `;

  console.log(`[PDF] Generated ${invoiceNumber} for order ${orderId.slice(0, 8)} → ${pdfUrl || "local only"}`);

  return { invoiceNumber, pdfUrl, orderId };
}
