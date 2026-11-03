// apps/api/src/routes/subsidy-indents.ts
// ═══════════════════════════════════════════════════════════════════════
// Customer subsidy indents — HTM 1000ML (sub).
//
// A dedicated Call-Desk surface for recording indents of the subsidised
// HTM 1000ML pouch (the customer pays 50%). It behaves like the Record
// Indents flow — a real, confirmed order that posts a credit-ledger debit
// and mints a GST invoice — but is locked to a single product resolved
// server-side (products.code = 'PD0191S', seeded by migration 0056).
//
// Always a NEW order
// ──────────────────
// Each subsidy indent is its own 'confirmed' order (orders.is_subsidy =
// true, migration 0079), charged in full when placed. It used to be
// written onto the customer's draft or placed order for the day, which
// changed indents the desk never meant to touch. The regular indent is now
// left alone, and the "dealer's order for the day" lookups (dealer app,
// Record Indents, auto-confirm, nightly drafts) skip is_subsidy orders, so
// a subsidy order never stands in for the real indent. Both orders show
// on the route sheet; the subsidy line lands in its own column.
//
//   • reads  → requireRole("orders.view")
//   • writes → requireRole("orders.create")
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { checkDealerCredit } from "../lib/credit-check.js";
import { enqueuePDFInvoice, enqueuePushNotification } from "../lib/queue.js";
import { generateInvoicePdfSync } from "../lib/invoice-pdf.js";
import { cancelSupersededSiblings } from "../lib/supersede-orders.js";
import { refreshInvoiceSettlement } from "../lib/invoice-settlement.js";
import { assertOrderNoOversell } from "../lib/stock-check.js";

// The subsidy SKU seeded by migration 0056 (half-price HTM 1000ML).
const SUBSIDY_PRODUCT_CODE = "PD0191S";

/** Amounts settle in paise, so they carry two decimals - rates too. */
const round2 = (n: number) => Math.round(n * 100) / 100;
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

function adminUserId(request: FastifyRequest): string {
  const a = (request as unknown as { admin?: { userId: string } }).admin;
  if (!a?.userId) throw new Error("adminAuth middleware not set");
  return a.userId;
}

interface SubsidyProduct {
  id: string;
  name: string;
  base_price: string;
  gst_percent: string;
  available: boolean;
}

async function loadSubsidyProduct(): Promise<SubsidyProduct | undefined> {
  const [p] = await pgClient`
    SELECT id, name,
           base_price::numeric  AS base_price,
           gst_percent::numeric AS gst_percent,
           available
      FROM products
     WHERE code = ${SUBSIDY_PRODUCT_CODE} AND deleted_at IS NULL
     LIMIT 1
  `;
  return p as unknown as SubsidyProduct | undefined;
}

/** Ledger running balance for a dealer (same maths as orders.ts / admin-indents.ts). */
async function currentBalance(tx: typeof pgClient, dealerId: string): Promise<number> {
  const [bal] = await tx`
    SELECT
      COALESCE(d.opening_balance, 0)
      + COALESCE((SELECT SUM(CASE WHEN dl.type = 'credit'
                                   AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                  THEN dl.amount ELSE 0 END)
                    FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      - COALESCE((SELECT SUM(CASE WHEN dl.type = 'debit'
                                   AND COALESCE(dl.voucher_type,'') <> 'Opening'
                                  THEN dl.amount ELSE 0 END)
                    FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      AS bal
    FROM dealers d WHERE d.id = ${dealerId}
  `;
  return parseFloat(bal!.bal);
}

/** Identifies the receipt THIS route wrote, so a revision only touches its own. */
function subsidyReceiptNote(orderId: string): string {
  return `Counter receipt for subsidy indent ${orderId}`;
}

/**
 * Record counter money for a subsidy indent as a real receipt.
 *
 * A cash subsidy indent used to post nothing at all. The line was billed and
 * the invoice reissued at the new total, but invoice-settlement.ts derives
 * paid_amount purely from evidence — a gateway reference, a ledger debit, or a
 * receipt keyed to the invoice — and cash left none of the three. Two live
 * indents settled that way, A4's 446.60 on 2026-08-01 and M61's 44.66 on
 * 2026-08-05, so both aged in AR Aging as debt the customer did not owe while
 * their dealer_ledger balance stayed high by the very same amount. This is the
 * indent twin of recordCounterCashReceipt() on the gate-pass rail.
 *
 * SET, not add, mirroring how the subsidy LINE itself is written: our rows for
 * this order are cleared and one receipt for the line total replaces them, so a
 * revised quantity can never strand a stale part-receipt.
 *
 * `reference` carries a SUB- marker rather than a gateway id on purpose. That
 * is what keeps it clear of resolveOrderSettlement's rail-1 match on
 * payments.reference = a pay_* id, so one receipt can never be counted twice.
 *
 * invoice_id resolves to NULL on a fresh order, whose invoice is only minted
 * after this transaction commits; linkSubsidyReceipts() below attaches it once
 * the invoice exists.
 */
async function setSubsidyCounterReceipt(
  tx: typeof pgClient,
  args: {
    dealerId: string;
    orderId: string;
    /** The subsidy line total now standing on the order, not the delta. */
    amount: number;
    mode: "cash" | "upi";
    receivedDate: string;
    performedBy: string;
  },
): Promise<void> {
  await tx`
    DELETE FROM payments
     WHERE dealer_id = ${args.dealerId}::uuid
       AND notes = ${subsidyReceiptNote(args.orderId)}
  `;
  if (args.amount <= 0.001) return;
  await tx`
    INSERT INTO payments
      (dealer_id, received_date, amount, mode, reference, invoice_id, received_by, notes)
    VALUES
      (${args.dealerId}::uuid, ${args.receivedDate}::date,
       ${args.amount.toFixed(2)}::numeric, ${args.mode},
       ${"SUB-" + args.orderId.slice(0, 8).toUpperCase()},
       (SELECT i.id FROM invoices i WHERE i.order_id = ${args.orderId}::uuid LIMIT 1),
       ${args.performedBy}::uuid,
       ${subsidyReceiptNote(args.orderId)})
  `;
}

/**
 * Attach this order's invoice to any receipt written before it existed.
 *
 * Runs after the invoice is minted and is a no-op once linked, so a retry
 * cannot duplicate anything. Without it a fresh cash indent would hold a
 * receipt that rail 3 (payments joined to invoices) cannot see, which is the
 * same blind spot the receipt was added to close.
 */
async function linkSubsidyReceipts(orderId: string): Promise<void> {
  await pgClient`
    UPDATE payments p
       SET invoice_id = i.id, updated_at = now()
      FROM invoices i
     WHERE i.order_id = ${orderId}::uuid
       AND p.invoice_id IS NULL
       AND p.notes = ${subsidyReceiptNote(orderId)}
  `;
}

export async function subsidyIndentsRoutes(app: FastifyInstance) {
  // ┌───────────────────────────────────────────────────────────────────┐
  // │  GET /api/v1/orders/subsidy-product                                │
  // │  The single product this page places, for label + rate display.   │
  // └───────────────────────────────────────────────────────────────────┘
  app.get(
    "/api/v1/orders/subsidy-product",
    { preHandler: [adminAuth, requireRole("orders.view")] },
    async (_request, reply) => {
      const p = await loadSubsidyProduct();
      if (!p) {
        return reply.status(404).send({
          error: "Subsidy product not configured",
          message: "HTM 1000ML (sub) is missing. Run migration 0056.",
        });
      }
      return reply.send({
        product: {
          id: p.id,
          name: p.name,
          unitPrice: round2(parseFloat(p.base_price)),
          gstPercent: round2(parseFloat(p.gst_percent)),
          available: p.available,
        },
      });
    }
  );

  // ┌───────────────────────────────────────────────────────────────────┐
  // │  POST /api/v1/orders/subsidy-place                                 │
  // │  Record a subsidy indent as its own new confirmed order.          │
  // └───────────────────────────────────────────────────────────────────┘
  app.post(
    "/api/v1/orders/subsidy-place",
    { preHandler: [adminAuth, requireRole("orders.create")] },
    async (request, reply) => {
      const body = z
        .object({
          customerId: z.string().uuid(),
          routeId: z.string().uuid().nullable().optional(),
          paymentMode: z.enum(["upi", "credit", "cash"]).default("credit"),
          paymentReference: z.string().optional(),
          notes: z.string().optional(),
          quantity: z.number().int().min(1).max(100_000),
          deliveryDate: isoDate.optional(),
        })
        .parse(request.body);

      if (body.paymentMode === "upi" && !body.paymentReference?.trim()) {
        return reply.status(400).send({ error: "paymentReference is required for UPI" });
      }

      // ── Resolve customer + subsidy product ──
      const [dealer] = await pgClient`
        SELECT id, zone_id, route_id FROM dealers WHERE id = ${body.customerId} AND deleted_at IS NULL
      `;
      if (!dealer) return reply.status(404).send({ error: "Customer not found" });
      if (!dealer.zone_id) {
        return reply.status(409).send({
          error: "Customer has no zone",
          message: "Assign a zone to this customer before placing indents.",
        });
      }

      // ── Resolve the order's delivery route ──
      // Default to the dealer's primary route; an explicitly-picked route must
      // be one the dealer is assigned to. Snapshotted on the order so it
      // dispatches/reports under the route it was placed for.
      let orderRouteId: string | null = dealer.route_id ?? null;
      if (body.routeId) {
        const [assigned] = await pgClient`
          SELECT 1 FROM dealer_routes
           WHERE dealer_id = ${body.customerId} AND route_id = ${body.routeId}::uuid
           LIMIT 1
        `;
        const isPrimary = dealer.route_id && String(dealer.route_id) === body.routeId;
        if (!assigned && !isPrimary) {
          return reply.status(400).send({
            error: "Route not assigned",
            message: "The selected route is not assigned to this customer.",
          });
        }
        orderRouteId = body.routeId;
      }

      const product = await loadSubsidyProduct();
      if (!product) {
        return reply.status(404).send({ error: "Subsidy product not configured" });
      }
      if (!product.available) {
        return reply.status(400).send({ error: "HTM 1000ML (sub) is currently unavailable" });
      }

      // ── Delivery date (default: today, IST) ──
      // to_char keeps it a 'YYYY-MM-DD' string so the ::date casts below
      // don't have to round-trip a JS Date through the driver.
      const [d] = await pgClient`
        SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today
      `;
      const deliveryDate = body.deliveryDate ?? String(d!.today);

      // ── Line maths (priced at the subsidy base_price) ──
      const quantity = body.quantity;
      const price = parseFloat(product.base_price);
      const gstPct = parseFloat(product.gst_percent);
      const lineSub = round2(price * quantity);
      const lineGst = round2(lineSub * (gstPct / 100));
      const lineTotal = round2(lineSub + lineGst);

      // ── Credit gate: the whole order is charged now ──
      if (body.paymentMode === "credit") {
        const credit = await checkDealerCredit(body.customerId, lineTotal);
        if (!credit.sufficient) {
          return reply.status(402).send({
            error: "Insufficient balance",
            message: `Available balance ₹${credit.available.toFixed(2)} is short of this subsidy indent by ₹${credit.shortfall.toFixed(2)}.`,
            credit,
          });
        }
      }

      // ── Persist: always a NEW confirmed order, flagged is_subsidy ──
      // Never written onto the customer's draft or placed indent, and it does
      // not supersede them: the regular indent carries on untouched, and the
      // day's-order lookups skip is_subsidy orders (migration 0079).
      const orderId: string = await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        const [order] = await tx`
          INSERT INTO orders (
            dealer_id, zone_id, route_id, status, payment_mode, payment_reference,
            subtotal, total_gst, grand_total, item_count, notes, is_subsidy,
            delivery_date, placed_by, confirmed_at, cancel_window_ends_at, created_at, updated_at
          ) VALUES (
            ${body.customerId}, ${dealer.zone_id}, ${orderRouteId}::uuid, 'confirmed', ${body.paymentMode},
            ${body.paymentMode === "upi" ? body.paymentReference!.trim() : null},
            ${lineSub.toFixed(2)}::numeric, ${lineGst.toFixed(2)}::numeric,
            ${lineTotal.toFixed(2)}::numeric, 1, ${body.notes ?? null}, true,
            ${deliveryDate}::date, ${adminUserId(request)}, now(), now(), now(), now()
          )
          RETURNING id
        `;
        const id: string = order!.id;

        await tx`
          INSERT INTO order_items (
            order_id, product_id, product_name, quantity,
            unit_price, gst_percent, gst_amount, line_total
          ) VALUES (
            ${id}::uuid, ${product.id}::uuid, ${product.name}, ${quantity},
            ${price.toFixed(2)}::numeric, ${gstPct.toFixed(2)}::numeric,
            ${lineGst.toFixed(2)}::numeric, ${lineTotal.toFixed(2)}::numeric
          )
        `;

        // ── Stock: a confirmed order holds stock from now on ──
        // Latch it, then refuse if the subsidy line oversells its base SKU.
        await tx`UPDATE orders SET stock_deducted = true WHERE id = ${id}::uuid`;
        const [sp] = await tx`
          SELECT COALESCE(stock_source_product_id, id)::text AS id
            FROM products WHERE id = ${product.id}::uuid
        `;
        await assertOrderNoOversell(tx, id, [sp!.id as string]);

        // ── Money ──
        // Settlement evidence per mode (invoice-settlement.ts reads evidence,
        // not the payment mode): credit → ledger debit against the order;
        // cash → a counter receipt; UPI → the gateway reference stamped on
        // the order above.
        if (body.paymentMode === "credit") {
          const bal = await currentBalance(tx, body.customerId);
          await tx`
            INSERT INTO dealer_ledger
              (dealer_id, type, amount, reference_id, reference_type,
               voucher_type, voucher_date, description, balance_after, performed_by)
            VALUES
              (${body.customerId}, 'debit', ${lineTotal.toFixed(2)}::numeric,
               ${id}, 'order', 'Invoice', now()::date,
               ${"Subsidy indent " + id}, ${(bal - lineTotal).toFixed(2)}::numeric,
               ${adminUserId(request)})
          `;
        }
        if (body.paymentMode === "cash") {
          await setSubsidyCounterReceipt(tx, {
            dealerId: body.customerId,
            orderId: id,
            amount: lineTotal,
            mode: "cash",
            receivedDate: deliveryDate,
            performedBy: adminUserId(request),
          });
        }

        return id;
      });

      // ── Invoice + push (best-effort, outside the tx) ──
      let invoiceNumber: string | null = null;
      let invoicePdfUrl: string | null = null;
      try {
        await enqueuePushNotification({
          event: "order.confirmed",
          dealerId: body.customerId,
          orderId,
        });
      } catch (err) {
        console.warn("[subsidy] Push enqueue failed:", err);
      }
      try {
        const pdf = await generateInvoicePdfSync(orderId);
        invoicePdfUrl = pdf?.pdfUrl ?? null;
        const [inv] = await pgClient`
          SELECT invoice_number FROM invoices WHERE order_id = ${orderId} LIMIT 1
        `;
        invoiceNumber = inv?.invoice_number ?? null;
      } catch (err) {
        console.error("[subsidy] Invoice generation failed:", err);
        try { await enqueuePDFInvoice(orderId); } catch { /* worker retries */ }
      }

      // A cash receipt written above had no invoice to point at yet. Link it,
      // then re-derive paid_amount. Idempotent; never fails the request.
      try {
        await linkSubsidyReceipts(orderId);
        await refreshInvoiceSettlement(orderId);
      } catch (err) {
        console.warn("[subsidy] Receipt link / settlement refresh failed:", err);
      }

      return reply.status(201).send({
        message: "Subsidy indent placed as a new confirmed order",
        orderId,
        status: "confirmed",
        deliveryDate,
        appended: false,
        quantity,
        lineTotal: lineTotal.toFixed(2),
        invoiceNumber,
        invoicePdfUrl,
      });
    }
  );
}
