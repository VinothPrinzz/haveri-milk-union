import { PDFDocument, rgb, StandardFonts } from "pdf-lib";
import { pgClient } from "./db.js";

/**
 * Generate (or regenerate) a PDF for an existing invoice.
 * Called synchronously from POST /orders and the dealer's
 * "View Invoice" endpoint.
 *
 * Returns the PDF bytes directly so callers can stream them
 * without re-fetching from R2 or decoding base64.
 */
export interface InvoicePdfResult {
    pdfUrl: string | null;        // R2 URL if uploaded, otherwise null
    pdfBytes: Uint8Array;         // Always present — the freshly-built PDF
    invoiceNumber: string;
}

export async function generateInvoicePdfSync(orderId: string): Promise<InvoicePdfResult> {
  const [order] = await pgClient`
    SELECT o.*, d.name AS dealer_name, d.phone AS dealer_phone,
           d.gst_number AS dealer_gst, d.address AS dealer_address,
           d.city AS dealer_city, d.pin_code AS dealer_pin
    FROM orders o
    JOIN dealers d ON d.id = o.dealer_id
    WHERE o.id = ${orderId}
    LIMIT 1
  `;
  if (!order) throw new Error(`Order ${orderId} not found`);

  const items = await pgClient`
    SELECT product_name, quantity, unit_price, gst_percent, gst_amount, line_total
    FROM order_items WHERE order_id = ${orderId} ORDER BY product_name
  `;

  const invoiceNumber =
    `INV-HMU-${new Date(order.created_at).getFullYear()}-` +
    orderId.slice(0, 8).toUpperCase();

  // Build PDF
  const doc = await PDFDocument.create();
  const page = doc.addPage([595, 842]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);
  const black = rgb(0, 0, 0);
  const gray = rgb(0.4, 0.4, 0.4);
  const brand = rgb(0.08, 0.28, 0.8);

  let y = 792;

  page.drawText("HAVERI DISTRICT CO-OPERATIVE MILK PRODUCERS' UNION",
    { x: 50, y, size: 11, font: fontBold, color: brand });
  y -= 16;
  page.drawText("Main Road, Haveri, Karnataka 581110 | GSTIN: 29AABCH1234F1Z5",
    { x: 50, y, size: 8, font, color: gray });
  y -= 30;
  page.drawText("TAX INVOICE", { x: 50, y, size: 14, font: fontBold, color: black });
  y -= 18;
  page.drawText(`Invoice No: ${invoiceNumber}`, { x: 50, y, size: 9, font, color: black });
  page.drawText(`Date: ${new Date(order.created_at).toLocaleDateString("en-IN")}`,
    { x: 350, y, size: 9, font, color: black });
  y -= 14;
  page.drawText(`Order ID: ${orderId.slice(0, 16)}`,
    { x: 50, y, size: 9, font, color: gray });
  y -= 25;

  page.drawText("Bill To:", { x: 50, y, size: 9, font: fontBold, color: black });
  y -= 14;
  page.drawText(order.dealer_name, { x: 50, y, size: 10, font: fontBold, color: black });
  y -= 13;
  page.drawText(`Phone: ${order.dealer_phone}`, { x: 50, y, size: 8, font, color: gray });
  y -= 13;
  if (order.dealer_gst) {
    page.drawText(`GSTIN: ${order.dealer_gst}`, { x: 50, y, size: 8, font, color: gray });
    y -= 13;
  }
  if (order.dealer_address) {
    page.drawText(`${order.dealer_address}, ${order.dealer_city || ""} ${order.dealer_pin || ""}`,
      { x: 50, y, size: 8, font, color: gray });
    y -= 13;
  }

  y -= 12;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: brand });
  y -= 14;

  const cols = [50, 220, 280, 330, 390, 450];
  ["Item", "Qty", "Rate", "GST %", "GST Amt", "Total"].forEach((h, i) => {
    page.drawText(h, { x: cols[i]!, y, size: 8, font: fontBold, color: black });
  });
  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 0.5, color: gray });
  y -= 14;

  for (const item of items) {
    page.drawText(String(item.product_name).slice(0, 28),
      { x: 50, y, size: 8, font, color: black });
    page.drawText(String(item.quantity), { x: 220, y, size: 8, font, color: black });
    page.drawText(`Rs ${parseFloat(item.unit_price).toFixed(2)}`,
      { x: 280, y, size: 8, font, color: black });
    page.drawText(`${parseFloat(item.gst_percent)}%`,
      { x: 330, y, size: 8, font, color: black });
    page.drawText(`Rs ${parseFloat(item.gst_amount).toFixed(2)}`,
      { x: 390, y, size: 8, font, color: black });
    page.drawText(`Rs ${parseFloat(item.line_total).toFixed(2)}`,
      { x: 450, y, size: 8, font: fontBold, color: black });
    y -= 16;
  }

  y -= 6;
  page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: brand });
  y -= 20;

  const subtotal = parseFloat(order.subtotal);
  const totalGst = parseFloat(order.total_gst);
  const cgst = totalGst / 2;
  const sgst = totalGst / 2;
  const grand = parseFloat(order.grand_total);

  [
    ["Subtotal", `Rs ${subtotal.toFixed(2)}`],
    ["CGST", `Rs ${cgst.toFixed(2)}`],
    ["SGST", `Rs ${sgst.toFixed(2)}`],
    ["Grand Total", `Rs ${grand.toFixed(2)}`],
  ].forEach(([label, val], i) => {
    const isBold = i === 3;
    page.drawText(label!, { x: 380, y, size: isBold ? 10 : 9,
      font: isBold ? fontBold : font, color: black });
    page.drawText(val!, { x: 480, y, size: isBold ? 10 : 9,
      font: fontBold, color: isBold ? brand : black });
    y -= 16;
  });

  y -= 16;
  page.drawText(`Payment Mode: ${order.payment_mode || "Wallet"}`,
    { x: 50, y, size: 8, font, color: gray });
  y -= 14;
  page.drawText("This is a computer-generated invoice.",
    { x: 50, y, size: 7, font, color: gray });

  const pdfBytes = await doc.save();

  // Try R2 upload
  let pdfUrl: string | null = null;
  try {
    pdfUrl = await tryUploadR2(`invoices/${new Date().getFullYear()}/${invoiceNumber}.pdf`, pdfBytes);
  } catch (err) {
    console.warn("[invoice] R2 upload failed:", err);
  }

  // Persist invoice record
  await pgClient`
    INSERT INTO invoices (
        order_id, dealer_id, invoice_number, invoice_date,
        taxable_amount, cgst, sgst, total_tax, total_amount,
        dealer_name, dealer_gst_number, pdf_url, pdf_generated_at
    ) VALUES (
        ${orderId}, ${order.dealer_id}, ${invoiceNumber}, ${order.created_at},
        ${subtotal.toFixed(2)}::numeric, ${cgst.toFixed(2)}::numeric,
        ${sgst.toFixed(2)}::numeric, ${totalGst.toFixed(2)}::numeric,
        ${grand.toFixed(2)}::numeric,
        ${order.dealer_name}, ${order.dealer_gst || null}, ${pdfUrl}, now()
    )
    ON CONFLICT (order_id) DO UPDATE
        SET pdf_url          = EXCLUDED.pdf_url,
            pdf_generated_at = now()
  `;

  return { pdfUrl, pdfBytes, invoiceNumber };
}

/**
 * Optional R2 upload. If env vars aren't set, returns null.
 */
async function tryUploadR2(key: string, bytes: Uint8Array): Promise<string | null> {
  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKey = process.env.R2_ACCESS_KEY_ID;
  const secret = process.env.R2_SECRET_ACCESS_KEY;
  const bucket = process.env.R2_BUCKET_NAME;

  if (!accountId || !accessKey || !secret || !bucket) return null;

  // Lazy import so the API doesn't pay the cost when R2 isn't configured.
  const { S3Client, PutObjectCommand, GetObjectCommand } =
    await import("@aws-sdk/client-s3");
  const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");

  const s3 = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: accessKey, secretAccessKey: secret },
  });

  await s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: bytes, ContentType: "application/pdf",
  }));

  const publicBase = process.env.R2_PUBLIC_URL;
  if (publicBase) return `${publicBase}/${key}`;

  return await getSignedUrl(s3,
    new GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 7 * 24 * 60 * 60 });
}