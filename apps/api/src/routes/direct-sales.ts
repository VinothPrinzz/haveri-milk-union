import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { paginationSchema, paginationMeta, offsetFromPage } from "../lib/pagination.js";
import {
  generateEmployeeInvoicePdfSync,
  generateDirectSaleInvoicePdfSync,
  reissueDirectSaleInvoiceIfExists,
} from "../lib/invoice-pdf.js";
import {
  isRazorpayConfigured,
  createRazorpayQrCode,
  closeRazorpayQrCode,
  fetchRazorpayQrCode,
  fetchRazorpayQrCodePayments,
  QR_CLOSE_AFTER_SECONDS,
} from "../lib/razorpay-client.js";
import { applyPaidGatePassPayment } from "./dealer-payments.js";
import {
  cancelDirectSale,
  loadDirectSaleMoney,
  initiateGatePassBankRefunds,
  creditDealerBalance,
  debitDealerBalance,
  recordCounterCashReceipt,
  reverseGatePassLedgerPosting,
  reverseCounterCashReceipt,
  ledgerPostedForSale,
  LEDGER_SETTLED_MODES,
  DirectSaleCancelError,
} from "../lib/direct-sale-money.js";
import { checkDealerCredit } from "../lib/credit-check.js";
import {
  assertNoOversell,
  describeShortfalls,
  getDemandShortfalls,
  StockConflictError,
  type StockDemandLine,
} from "../lib/stock-check.js";
import { recordBankRefund } from "../lib/order-refund.js";
import { calcLine, round2 } from "../lib/line-totals.js";
import { RefundError } from "../lib/cancel-order.js";
import { istToday } from "../lib/ist-date.js";

const saleItemSchema = z.object({
  productId: z.string().uuid(),
  quantity: z.number().int().min(1),
});

/**
 * Mint the tax invoice for a freshly created direct sale.
 *
 * Every rail below (gate pass, cash counter sale, VIP sample) calls this the
 * moment the sale is committed, so the bill # on Recent Sales opens a real
 * document without a round trip to generate it — the same thing the indent
 * rail does at confirm time. GET /direct-sales/:id/invoice stays as the
 * safety net for anything raised before this, and for a mint that failed.
 *
 * Best-effort by design and never throws: the sale, its stock movement and
 * its money postings are already committed by the time this runs, so a PDF
 * render or an R2 hiccup must not fail the request or suggest the sale itself
 * did not happen.
 */
async function mintDirectSaleInvoice(
  app: FastifyInstance,
  saleId: string
): Promise<{ invoiceNumber: string | null; invoicePdfUrl: string | null }> {
  try {
    const pdf = await generateDirectSaleInvoicePdfSync(saleId);
    return { invoiceNumber: pdf.invoiceNumber, invoicePdfUrl: pdf.pdfUrl };
  } catch (err) {
    app.log.error({ err, saleId }, "[invoice] direct-sale mint-on-create failed");
    return { invoiceNumber: null, invoicePdfUrl: null };
  }
}

/**
 * Turn the FGS oversell guard's throw into the response every direct-sale rail
 * gives back. 409 (not 400) because nothing about the request is malformed —
 * the goods simply are not on the floor right now, and the same request may
 * well succeed after the morning's Stock Entry.
 */
function insufficientStock(reply: any, err: StockConflictError) {
  return reply.status(409).send({
    error: "Insufficient stock",
    message: `Not enough stock for: ${describeShortfalls(err.shortfalls)}`,
    shortfalls: err.shortfalls,
  });
}

export async function directSalesRoutes(app: FastifyInstance) {
  // ═══ CASH CUSTOMERS ═══
  // GET /api/v1/cash-customers — list for dropdown / autocomplete
  app.get(
    "/api/v1/cash-customers",
    { preHandler: [adminAuth, requireRole("cash_customers.view")] },
    async (request, reply) => {
      const querySchema = z.object({
        search: z.string().optional(),
      });
      const query = querySchema.parse(request.query);
      const searchTerm = query.search ? `%${query.search}%` : null;

      const rows = await pgClient`
        SELECT id, name, phone, address FROM cash_customers
        WHERE deleted_at IS NULL
          AND (${searchTerm}::text IS NULL OR name ILIKE ${searchTerm ?? ''} OR phone ILIKE ${searchTerm ?? ''})
        ORDER BY name
        LIMIT 50
      `;
      return reply.send({ data: rows });
    }
  );

  // POST /api/v1/cash-customers — create cash customer (inline from direct sale form)
  app.post(
    "/api/v1/cash-customers",
    { preHandler: [adminAuth, requireRole("cash_customers.manage")] },
    async (request, reply) => {
      const schema = z.object({
        name: z.string().min(1),
        phone: z.string().optional(),
        address: z.string().optional(),
      });
      const body = schema.parse(request.body);
      const [customer] = await pgClient`
        INSERT INTO cash_customers (name, phone, address)
        VALUES (${body.name}, ${body.phone ?? null}, ${body.address ?? null})
        RETURNING *
      `;
      return reply.status(201).send({ customer });
    }
  );

  // ═══ DIRECT SALES ═══
  // GET /api/v1/direct-sales — paginated list with filters
  app.get(
    "/api/v1/direct-sales",
    { preHandler: [adminAuth, requireRole("direct_sales.view")] },
    async (request, reply) => {
      const querySchema = paginationSchema.extend({
        customerType: z.enum(["agent", "cash"]).optional(),
        routeId: z.string().uuid().optional(),
        dateFrom: z.string().optional(),
        dateTo: z.string().optional(),
        officerId: z.string().uuid().optional(),
      });
      const query = querySchema.parse(request.query);

      const customerType = query.customerType
        ? query.customerType.toLowerCase() as 'agent' | 'cash'
        : null;

      const offset = offsetFromPage(query.page, query.limit);
      
      const routeId = query.routeId ?? null;
      const dateFrom = query.dateFrom ?? null;
      const dateTo = query.dateTo ?? null;
      const officerId = query.officerId ?? null;

      // Employee subsidy is placed as an indent (employee_orders) rather than
      // a direct sale, but it still belongs on this list — so the two are
      // unioned here. The employee branch is skipped whenever the caller
      // filters on a customerType (only 'agent'/'cash' are selectable) or on
      // an officer, neither of which an employee indent carries.
      const rows = await pgClient`
        WITH sales AS (
        SELECT
          ds.id, ds.gp_no, ds.customer_type::text AS customer_type, ds.customer_id,
          ds.route_id, ds.sale_date, ds.payment_mode,
          ds.status::text AS status, ds.cancelled_at, ds.cancellation_reason,
          -- Gateway money taken for this sale, net of refunds. Drives the
          -- "refund to bank" option on cancel and the amount-due figure on
          -- modify; a cash or credit pass collects none of it.
          COALESCE((
            SELECT SUM(rp.amount - rp.amount_refunded)::float8
              FROM razorpay_payments rp
             WHERE rp.direct_sale_id = ds.id
               AND rp.kind = 'gate_pass'
               AND rp.status IN ('paid', 'refunded')
          ), 0) AS collected,
          ds.subtotal, ds.total_gst, ds.grand_total, ds.notes, ds.created_at,
          r.code AS route_code, r.name AS route_name,
          u.name AS officer_name,
          b.name AS batch_name,
          i.id AS invoice_id,                    -- ← ADDED for B.7
          CASE
            WHEN ds.customer_type = 'agent' THEN d.name
            WHEN ds.customer_type = 'cash'  THEN cc.name
            ELSE ds.recipient_name          -- covers vip_sample + employee_subsidy
          END AS customer_name,
          CASE
            WHEN ds.customer_type = 'agent' THEN d.phone
            WHEN ds.customer_type = 'cash'  THEN cc.phone
          END AS customer_phone,
          COALESCE(
            (SELECT json_agg(json_build_object(
                'product_name', dsi.product_name,
                'quantity',     dsi.quantity,
                'unit_price',   dsi.unit_price,
                'line_total',   dsi.line_total
              ) ORDER BY dsi.product_name)
              FROM direct_sale_items dsi WHERE dsi.direct_sale_id = ds.id),
            '[]'::json
          ) AS items,
          (SELECT count(*)::int FROM direct_sale_items dsi WHERE dsi.direct_sale_id = ds.id) AS item_count
        FROM direct_sales ds
        LEFT JOIN routes r ON r.id = ds.route_id
        LEFT JOIN users u  ON u.id = ds.officer_id
        LEFT JOIN batches b ON b.id = ds.batch_id
        LEFT JOIN dealers d ON ds.customer_type = 'agent' AND d.id = ds.customer_id
        LEFT JOIN cash_customers cc ON ds.customer_type = 'cash' AND cc.id = ds.customer_id
        LEFT JOIN invoices i ON i.order_id = ds.id          -- ← ADDED for B.7
        WHERE (${customerType}::text IS NULL OR ds.customer_type = ${customerType ?? 'agent'}::direct_sale_customer_type)
          AND (${routeId}::uuid IS NULL OR ds.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${dateFrom}::date IS NULL OR ds.sale_date >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date IS NULL OR ds.sale_date <= ${dateTo ?? '9999-12-31'}::date)
          AND (${officerId}::uuid IS NULL OR ds.officer_id = ${officerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
        UNION ALL
        SELECT
          eo.id, NULL::text AS gp_no, 'employee_subsidy'::text AS customer_type,
          eo.employee_id AS customer_id,
          eo.route_id, eo.delivery_date AS sale_date, eo.payment_mode,
          eo.status::text AS status, eo.cancelled_at, eo.cancellation_reason,
          -- Employee indents never carry a counter QR.
          0::float8 AS collected,
          eo.subtotal, eo.total_gst, eo.grand_total, eo.notes, eo.created_at,
          r.code AS route_code, r.name AS route_name,
          u.name AS officer_name,
          NULL::text AS batch_name,
          i.id AS invoice_id,
          e.name  AS customer_name,
          e.phone AS customer_phone,
          COALESCE(
            (SELECT json_agg(json_build_object(
                'product_name', eoi.product_name,
                'quantity',     eoi.quantity,
                'unit_price',   eoi.unit_price,
                'line_total',   eoi.line_total
              ) ORDER BY eoi.product_name)
              FROM employee_order_items eoi WHERE eoi.employee_order_id = eo.id),
            '[]'::json
          ) AS items,
          (SELECT count(*)::int FROM employee_order_items eoi WHERE eoi.employee_order_id = eo.id) AS item_count
        FROM employee_orders eo
        JOIN employees e   ON e.id = eo.employee_id
        LEFT JOIN routes r ON r.id = eo.route_id
        LEFT JOIN users u  ON u.id = eo.placed_by
        LEFT JOIN invoices i ON i.order_id = eo.id
        WHERE ${customerType}::text IS NULL
          AND ${officerId}::uuid IS NULL
          AND (${routeId}::uuid IS NULL OR eo.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${dateFrom}::date IS NULL OR eo.delivery_date >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date IS NULL OR eo.delivery_date <= ${dateTo ?? '9999-12-31'}::date)
        )
        SELECT * FROM sales
        ORDER BY created_at DESC
        LIMIT ${query.limit} OFFSET ${offset}
      `;

      // Counts both rails, with predicates identical to the union above.
      const [countRow] = await pgClient`
        SELECT (
          SELECT count(*)::int FROM direct_sales ds
        WHERE (${customerType}::text IS NULL OR ds.customer_type = ${customerType ?? 'agent'}::direct_sale_customer_type)
          AND (${routeId}::uuid IS NULL OR ds.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
          AND (${dateFrom}::date IS NULL OR ds.sale_date >= ${dateFrom ?? '1970-01-01'}::date)
          AND (${dateTo}::date IS NULL OR ds.sale_date <= ${dateTo ?? '9999-12-31'}::date)
          AND (${officerId}::uuid IS NULL OR ds.officer_id = ${officerId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
        ) + (
          SELECT count(*)::int FROM employee_orders eo
           WHERE ${customerType}::text IS NULL
             AND ${officerId}::uuid IS NULL
             AND (${routeId}::uuid IS NULL OR eo.route_id = ${routeId ?? '00000000-0000-0000-0000-000000000000'}::uuid)
             AND (${dateFrom}::date IS NULL OR eo.delivery_date >= ${dateFrom ?? '1970-01-01'}::date)
             AND (${dateTo}::date IS NULL OR eo.delivery_date <= ${dateTo ?? '9999-12-31'}::date)
        ) AS count
      `;

      return reply.send({
        data: rows,
        ...paginationMeta(countRow?.count ?? 0, query.page, query.limit),
      });
    }
  );

  // GET /api/v1/direct-sales/:id — single sale with items
  app.get(
    "/api/v1/direct-sales/:id",
    { preHandler: [adminAuth, requireRole("direct_sales.view")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const [sale] = await pgClient`
        SELECT ds.*,
               r.code AS route_code, r.name AS route_name,
               u.name AS officer_name,
               b.name AS batch_name
        FROM direct_sales ds
        LEFT JOIN routes r ON r.id = ds.route_id
        LEFT JOIN users u ON u.id = ds.officer_id
        LEFT JOIN batches b ON b.id = ds.batch_id
        WHERE ds.id = ${id}
      `;
      if (!sale) return reply.status(404).send({ error: "Direct sale not found" });

      const items = await pgClient`
        SELECT dsi.*, p.icon, p.unit
        FROM direct_sale_items dsi
        JOIN products p ON p.id = dsi.product_id
        WHERE dsi.direct_sale_id = ${id}
        ORDER BY dsi.product_name
      `;

      // If gate pass, also get gate pass items with return info
      let gatePassItems: any[] = [];
      if (sale.customer_type === "agent") {
        gatePassItems = await pgClient`
          SELECT gpi.*, p.name AS product_name, p.icon, p.unit
          FROM gate_pass_items gpi
          JOIN products p ON p.id = gpi.product_id
          WHERE gpi.direct_sale_id = ${id}
          ORDER BY p.name
        `;
      }

      // Replace the existing customer-resolution if/else with:
      let customer: any = null;
      if (sale.customer_type === "agent") {
        [customer] = await pgClient`SELECT id, name, phone, gst_number FROM dealers WHERE id = ${sale.customer_id}`;
      } else if (sale.customer_type === "cash") {
        [customer] = await pgClient`SELECT id, name, phone FROM cash_customers WHERE id = ${sale.customer_id}`;
      } else if (sale.customer_type === "vip_sample") {
        [customer] = await pgClient`SELECT id, name, phone, designation FROM vip_contacts WHERE id = ${sale.customer_id}`;
      } else if (sale.customer_type === "employee_subsidy") {
        [customer] = await pgClient`SELECT id, employee_code, name, phone, department, designation FROM employees WHERE id = ${sale.customer_id}`;
      }

      // Money context for the modify screen: what the counter has actually
      // collected through the gateway, and therefore what an edit leaves to
      // collect (outstanding) or to give back (overpaid). A cash or credit
      // sale collects none of it — see lib/direct-sale-money.ts.
      const money = await loadDirectSaleMoney(pgClient, id);

      // Balance context for an agent pass, so the modify screen can project
      // an edit against it exactly as it does for an indent. A wallet pass
      // spends prepaid funds, and raising one has to fit what is left.
      // `available` already accounts for THIS pass's own debit (it reads the
      // ledger, which the pass posted to at issue), so the screen compares it
      // against the DIFFERENCE an edit makes, not the new total.
      const credit =
        sale.customer_type === "agent" && sale.customer_id
          ? await checkDealerCredit(sale.customer_id, 0).catch(() => null)
          : null;

      const [invoice] = await pgClient`
        SELECT id::text AS id, invoice_number AS "invoiceNumber"
          FROM invoices WHERE order_id = ${id} LIMIT 1
      `;

      return reply.send({
        sale,
        items,
        gatePassItems,
        customer,
        money,
        credit: credit
          ? { available: credit.available, outstanding: credit.outstanding }
          : null,
        invoice: invoice ?? null,
      });
    }
  );

  // POST /api/v1/direct-sales/gate-pass — create agent gate pass sale
  //
  // Payment modes carry the same meaning they do on the indent rail, and
  // post the same money (see lib/direct-sale-money.ts):
  //   credit — billed to the agent, ages as a receivable in AR. Open to
  //            EVERY agent here, not only credit institutions: a pass is
  //            goods handed over at the plant against a later bill.
  //   wallet — spends the agent's prepaid balance, gated on it
  //   upi    — collected through the counter QR (or a typed reference)
  //
  // Counter CASH is no longer offered on this rail. Passes issued before
  // that change still hold payment_mode='cash' and keep their receipt
  // handling in the modify and cancel paths, so nothing historical moves.
  app.post(
    "/api/v1/direct-sales/gate-pass",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const schema = z.object({
        customerId: z.string().uuid(), // dealer ID (agent)
        routeId: z.string().uuid().optional(),
        batchId: z.string().uuid().optional(),
        saleDate: z.string().optional(), // ISO date, defaults to today
        paymentMode: z.enum(["wallet", "upi", "credit"]).default("credit"),
        paymentRef: z.string().optional(),
        notes: z.string().optional(),
        items: z.array(saleItemSchema).min(1),
      });
      const body = schema.parse(request.body);
      const saleDate = body.saleDate ?? istToday();

      // Fetch product prices
      const productIds = body.items.map(i => i.productId);
      const productRows = await pgClient`
        SELECT id, name, base_price, gst_percent FROM products
        WHERE id = ANY(${productIds}::uuid[]) AND deleted_at IS NULL
      `;
      const productMap = new Map(productRows.map((p: any) => [p.id, p]));

      // Calculate totals
      let subtotal = 0;
      let totalGst = 0;
      const lineItems: any[] = [];

      for (const item of body.items) {
        const product = productMap.get(item.productId);
        if (!product) return reply.status(400).send({ error: `Product ${item.productId} not found` });

        // Paise. The master column still allows a third decimal; a counter
        // sale must bill the same rate a dealer order does.
        const unitPrice = Math.round(parseFloat(product.base_price) * 100) / 100;
        const gstPercent = parseFloat(product.gst_percent);
        const lineSubtotal = unitPrice * item.quantity;
        const gstAmount = Math.round(lineSubtotal * gstPercent) / 100;
        const lineTotal = lineSubtotal + gstAmount;

        subtotal += lineSubtotal;
        totalGst += gstAmount;

        lineItems.push({
          productId: item.productId,
          productName: product.name,
          quantity: item.quantity,
          unitPrice,
          gstPercent,
          gstAmount,
          lineTotal,
        });
      }

      const grandTotal = subtotal + totalGst;

      // ── Which settlement this agent is allowed, and can afford ──
      //
      // CREDIT is open to every agent on the gate-pass rail. Unlike an
      // indent, a pass is a counter pickup the union bills rather than
      // collects for, so the credit-institution-only rule the indent rail
      // draws (paymentOptionsFor in the dealer app's IndentCart) does not
      // apply here. It posts the same dealer_ledger debit as wallet, is
      // never balance-gated and never counts as payment, so it ages in AR.
      //
      // WALLET stays closed to a credit institution: it buys on a monthly
      // account and holds no prepaid balance to spend.
      const credit = await checkDealerCredit(body.customerId, grandTotal);

      if (body.paymentMode === "wallet" && credit.creditInstitution) {
        return reply.status(400).send({
          error: "Wallet not available",
          message:
            "A credit institution buys on a monthly account and holds no prepaid " +
            "balance. Use credit, or collect on UPI.",
        });
      }
      // A wallet pass spends funds the agent topped up, so it cannot exceed
      // them. Credit is deliberately ungated: taking goods against a later
      // bill is the whole point, and it drives the balance negative, which IS
      // the outstanding.
      if (body.paymentMode === "wallet" && !credit.sufficient) {
        return reply.status(400).send({
          error: "Insufficient balance",
          message:
            `Available balance ₹${credit.available.toFixed(2)} is less than the ` +
            `gate pass total ₹${grandTotal.toFixed(2)} (short by ₹${credit.shortfall.toFixed(2)}). ` +
            `Top up the balance, or take this pass on credit or UPI.`,
          available: credit.available,
          shortfall: credit.shortfall,
        });
      }

      // Everything below is one transaction: before this, a failure partway
      // could leave a sale with some of its lines, stock deducted and no
      // money posted. The money postings in particular must stand or fall
      // with the sale that justifies them.
      let sale: any;
      try {
      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        [sale] = await tx`
          INSERT INTO direct_sales (customer_type, customer_id, route_id, officer_id, batch_id,
                                     sale_date, payment_mode, payment_ref, subtotal, total_gst, grand_total, notes)
          VALUES ('agent', ${body.customerId}, ${body.routeId ?? null}, ${request.admin!.userId},
                  ${body.batchId ?? null}, ${saleDate}::date, ${body.paymentMode}::payment_mode,
                  ${body.paymentRef ?? null}, ${subtotal}, ${totalGst}, ${grandTotal}, ${body.notes ?? null})
          RETURNING *
        `;
        if (!sale) throw new Error("Failed to create sale");

        // Insert line items and gate pass items
        for (const item of lineItems) {
          await tx`
            INSERT INTO direct_sale_items (direct_sale_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total)
            VALUES (${sale.id}, ${item.productId}, ${item.productName}, ${item.quantity},
                    ${item.unitPrice}, ${item.gstPercent}, ${item.gstAmount}, ${item.lineTotal})
          `;
          // Gate pass tracking row
          await tx`
            INSERT INTO gate_pass_items (direct_sale_id, product_id, quantity, returned_quantity)
            VALUES (${sale.id}, ${item.productId}, ${item.quantity}, 0)
          `;
        }

        // ── Stock ──
        // The pass is already written, so fgs_available now counts it: a
        // negative remainder means these goods are not on the floor, and the
        // throw rolls the whole pass back. Gating here is what stopped a
        // counter pickup of a zero-stock SKU driving the day negative.
        await assertNoOversell(
          tx,
          lineItems.map((i): StockDemandLine => ({
            productId: i.productId,
            productName: i.productName,
            quantity: i.quantity,
          })),
          saleDate,
        );

        // Legacy bookkeeping only — products.stock is vestigial (see
        // lib/stock-check.ts); the FGS guard above is the authority.
        for (const item of lineItems) {
          await tx`
            UPDATE products SET stock = GREATEST(stock - ${item.quantity}, 0), updated_at = now()
            WHERE id = ${item.productId}
          `;
        }

        // ── Post the money ──
        // A gate pass used to post nothing whatever mode was picked, so a
        // wallet pass never drew the balance down. Both ledger-settled modes
        // debit here. UPI posts nothing at this point: the counter QR writes
        // razorpay_payments when it is actually scanned, which may be minutes
        // later or never.
        if (grandTotal > 0.001 && LEDGER_SETTLED_MODES.has(body.paymentMode)) {
          await debitDealerBalance(
            tx,
            body.customerId,
            grandTotal,
            sale.id,
            `Gate pass ${sale.gp_no ?? sale.id}`,
            request.admin!.userId,
          );
        }
      });
      } catch (err) {
        if (err instanceof StockConflictError) return insufficientStock(reply, err);
        throw err;
      }

      // ── Invoice (best-effort, outside the tx) ──
      const invoice = await mintDirectSaleInvoice(app, sale.id);

      return reply.status(201).send({ sale, items: lineItems, ...invoice });
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // Gate-pass counter QR payments (migrations 0067 + 0068)
  //
  // The operator issues the pass, a per-sale UPI QR appears on the
  // counter screen with the amount already pinned, the customer scans,
  // and the qr_code.credited webhook stamps direct_sales.payment_ref —
  // replacing the UPI reference that used to be typed in by hand.
  //
  //   POST /direct-sales/:id/qr            — mint (or re-issue) the QR
  //   GET  /direct-sales/:id/payment-status — what the screen polls
  //   POST /direct-sales/:id/qr/close      — operator abandons the sale
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Razorpay verification throttle for the polling endpoint, keyed by QR
   * id. The screen polls every few seconds; the DB answers almost all of
   * those. This bounds how often a still-unpaid QR is checked against
   * Razorpay itself — the backstop for a webhook that never lands, which
   * is not hypothetical here (the webhook was dead for two days in July).
   */
  const lastQrVerifiedAt = new Map<string, number>();
  const QR_VERIFY_EVERY_MS = 10_000;

  function qrUnavailable(reply: any) {
    return reply.status(503).send({
      error: "Service unavailable",
      message: "Razorpay is not configured on this server.",
    });
  }

  /**
   * Load the gate-pass sale and reject everything a QR cannot be minted
   * for. Shared by the mint and close endpoints.
   */
  async function loadGatePassForQr(saleId: string) {
    const [sale] = await pgClient`
      SELECT ds.id,
             ds.gp_no                AS "gpNo",
             ds.customer_type::text  AS "customerType",
             ds.customer_id::text    AS "customerId",
             ds.sale_date::text      AS "saleDate",
             ds.grand_total::float8  AS "grandTotal",
             ds.payment_ref          AS "paymentRef",
             ds.status::text         AS "status",
             d.name                  AS "dealerName",
             d.code                  AS "dealerCode"
        FROM direct_sales ds
        LEFT JOIN dealers d
               ON ds.customer_type = 'agent' AND d.id = ds.customer_id
       WHERE ds.id = ${saleId}::uuid
       LIMIT 1
    `;
    return sale as any;
  }

  // ── POST /api/v1/direct-sales/:id/qr ───────────────────────────────
  app.post(
    "/api/v1/direct-sales/:id/qr",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      if (!isRazorpayConfigured()) return qrUnavailable(reply);

      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const sale = await loadGatePassForQr(id);

      if (!sale) return reply.status(404).send({ error: "Sale not found" });
      if (sale.customerType !== "agent") {
        return reply.status(400).send({
          error: "Not a gate pass",
          message: "Counter QR payment is only available on agent gate-pass sales.",
        });
      }
      if (sale.status === "cancelled") {
        return reply.status(409).send({
          error: "Sale cancelled",
          message: "This gate pass has been cancelled, so there is nothing to collect.",
        });
      }
      // razorpay_payments carries a CHECK (amount > 0), and a zero-value
      // pass has nothing to collect anyway. Real ones exist on file.
      if (!(sale.grandTotal > 0)) {
        return reply.status(400).send({
          error: "Nothing to collect",
          message: "This gate pass totals Rs.0, so there is no payment to take.",
        });
      }

      // ── What is still owed ──
      // A settled sale used to be judged by payment_ref alone. That is no
      // longer enough: raising an already-paid sale on the modify screen
      // leaves a genuine balance to collect, and the top-up QR is minted for
      // exactly that difference. So the amount is driven by outstanding
      // (grand_total − collected), not by the sale total, and only a sale
      // with nothing left owing is refused.
      const money = await loadDirectSaleMoney(pgClient, id);
      if (money.outstanding <= 0.001) {
        return reply.status(409).send({
          error: "Already settled",
          message: sale.paymentRef
            ? `This gate pass is already paid in full (reference ${sale.paymentRef}).`
            : "This gate pass has nothing left to collect.",
        });
      }
      const amountToCollect = money.outstanding;
      const isTopUp = money.collected > 0.001;

      // Re-issue is normal: the first QR expired while the customer went
      // to fetch their phone. Hand back a QR that is still live rather
      // than minting a second one for the same sale.
      const [live] = await pgClient`
        SELECT id::text, razorpay_qr_code_id AS "qrId", status::text AS status,
               amount::float8 AS amount
          FROM razorpay_payments
         WHERE direct_sale_id = ${id}::uuid
           AND kind = 'gate_pass'
           AND status IN ('created', 'attempted')
         ORDER BY created_at DESC
         LIMIT 1
      `;

      if (live) {
        // A live QR is only reusable if it is pinned to the amount still
        // owed. QRs are fixed_amount, so an edit that changed the total
        // leaves the old code collecting the wrong sum — retire it and mint
        // a fresh one rather than take the wrong money.
        const amountStillRight =
          Math.abs(Number((live as any).amount) - amountToCollect) < 0.001;
        let stillActive = false;
        let liveImageUrl: string | null = null;
        if (amountStillRight) {
          try {
            const remote = await fetchRazorpayQrCode(live.qrId);
            stillActive = remote.status === "active";
            liveImageUrl = remote.imageUrl;
          } catch (err) {
            request.log.warn({ err, qrId: live.qrId }, "[gate-pass-qr] could not re-check QR, minting a fresh one");
          }
        } else {
          request.log.info(
            { qrId: live.qrId, was: (live as any).amount, now: amountToCollect },
            "[gate-pass-qr] sale total changed since mint — retiring the stale QR"
          );
          try {
            await closeRazorpayQrCode(live.qrId);
          } catch {
            /* best effort — it is retired below either way, and expires at close_by */
          }
        }
        if (stillActive && liveImageUrl) {
          return reply.send({
            qrId: live.qrId,
            imageUrl: liveImageUrl,
            amount: amountToCollect,
            reused: true,
          });
        }
        // Expired or closed — retire the row so it stops looking live.
        await pgClient`
          UPDATE razorpay_payments
             SET status = 'failed',
                 error_description = 'QR expired or closed before payment',
                 updated_at = now()
           WHERE id = ${live.id}::uuid
             AND status IN ('created', 'attempted')
        `;
      }

      let qr;
      try {
        qr = await createRazorpayQrCode({
          amountInRupees: amountToCollect,
          name: (sale.dealerName ?? "Gate pass").slice(0, 60),
          description: isTopUp
            ? `Gate pass ${sale.gpNo ?? sale.id.slice(0, 8)} (balance)`
            : `Gate pass ${sale.gpNo ?? sale.id.slice(0, 8)}`,
          notes: {
            directSaleId: sale.id,
            gatePassNo: String(sale.gpNo ?? ""),
            dealerCode: String(sale.dealerCode ?? ""),
            saleDate: String(sale.saleDate ?? ""),
            kind: isTopUp ? "balance" : "full",
          },
        });
      } catch (err: any) {
        request.log.error(err, "[gate-pass-qr] Razorpay QR create failed");
        return reply.status(502).send({
          error: "Gateway error",
          message: err?.message ?? "Razorpay rejected the QR request.",
        });
      }

      // Record it BEFORE showing the QR. If this insert failed after the
      // customer had already scanned, the webhook would arrive with no row
      // to attribute the money to.
      try {
        await pgClient`
          INSERT INTO razorpay_payments
            (dealer_id, kind, amount, razorpay_qr_code_id, direct_sale_id, notes)
          VALUES (
            ${sale.customerId}::uuid, 'gate_pass', ${amountToCollect},
            ${qr.id}, ${id}::uuid,
            ${JSON.stringify({
              gatePassNo: sale.gpNo,
              dealerCode: sale.dealerCode,
              // A balance QR collects the difference an upward edit created,
              // not the sale total — recorded so reconciliation can tell the
              // two apart.
              kind: isTopUp ? "balance" : "full",
              // Persisted because the rzp.io short code is NOT derivable
              // from the QR id: without this the polling endpoint cannot
              // hand the screen a working image after a refresh.
              imageUrl: qr.imageUrl,
            })}::jsonb
          )
        `;
      } catch (err) {
        request.log.error({ err, qrId: qr.id }, "[gate-pass-qr] failed to record QR row — closing the QR so it cannot be paid");
        try {
          await closeRazorpayQrCode(qr.id);
        } catch {
          /* best effort — the QR expires at close_by regardless */
        }
        return reply.status(500).send({
          error: "Could not record the QR",
          message: "The QR was cancelled rather than left payable. Try again.",
        });
      }

      return reply.status(201).send({
        qrId: qr.id,
        imageUrl: qr.imageUrl,
        amount: amountToCollect,
        saleTotal: sale.grandTotal,
        isBalance: isTopUp,
        closeBy: qr.closeBy,
        expiresInSeconds: QR_CLOSE_AFTER_SECONDS,
        reused: false,
      });
    }
  );

  // ── GET /api/v1/direct-sales/:id/payment-status ────────────────────
  app.get(
    "/api/v1/direct-sales/:id/payment-status",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const [sale] = await pgClient`
        SELECT id, payment_ref AS "paymentRef", payment_mode::text AS "paymentMode",
               grand_total::float8 AS "grandTotal"
          FROM direct_sales
         WHERE id = ${id}::uuid
         LIMIT 1
      `;
      if (!sale) return reply.status(404).send({ error: "Sale not found" });

      const [row] = await pgClient`
        SELECT id::text,
               razorpay_qr_code_id AS "qrId",
               razorpay_payment_id AS "paymentId",
               status::text        AS status,
               amount::float8      AS amount,
               paid_at             AS "paidAt",
               created_at          AS "createdAt",
               notes->>'imageUrl'  AS "imageUrl"
          FROM razorpay_payments
         WHERE direct_sale_id = ${id}::uuid
           AND kind = 'gate_pass'
         ORDER BY created_at DESC
         LIMIT 1
      `;

      // Settled means the money is all in, not merely that a reference was
      // stamped: a sale raised on the modify screen after its first payment
      // carries a reference AND a balance still to collect, and the counter
      // screen must keep showing a QR for that balance.
      const money = await loadDirectSaleMoney(pgClient, id);
      if ((sale as any).paymentRef && money.outstanding <= 0.001) {
        return reply.send({
          state: "paid",
          paymentRef: (sale as any).paymentRef,
          amount: (row as any)?.amount ?? (sale as any).grandTotal,
          paidAt: (row as any)?.paidAt ?? null,
          collected: money.collected,
          outstanding: 0,
        });
      }

      if (!row) return reply.send({ state: "none" });

      const r = row as any;
      if (r.status === "paid") {
        // Paid at the gateway but the sale is unstamped — the apply must
        // have failed after the webhook. Retry it here.
        try {
          await applyPaidGatePassPayment(r.id);
          const [restamped] = await pgClient`
            SELECT payment_ref AS "paymentRef" FROM direct_sales WHERE id = ${id}::uuid
          `;
          // Re-read the money AFTER applying: this payment may have been a
          // balance top-up that still leaves something owing.
          const after = await loadDirectSaleMoney(pgClient, id);
          if ((restamped as any)?.paymentRef && after.outstanding <= 0.001) {
            return reply.send({
              state: "paid",
              paymentRef: (restamped as any).paymentRef,
              amount: r.amount,
              paidAt: r.paidAt,
              collected: after.collected,
              outstanding: 0,
            });
          }
          if ((restamped as any)?.paymentRef) {
            return reply.send({
              state: "partial",
              paymentRef: (restamped as any).paymentRef,
              amount: r.amount,
              paidAt: r.paidAt,
              collected: after.collected,
              outstanding: after.outstanding,
            });
          }
        } catch (err) {
          request.log.error({ err, rzpRowId: r.id }, "[gate-pass-qr] re-apply from poll failed");
        }
      }

      if (r.status === "failed") {
        return reply.send({ state: "expired", qrId: r.qrId });
      }

      // Still pending. Ask Razorpay directly now and then, so a missed
      // webhook cannot leave the counter staring at a spinner while the
      // customer has already paid.
      const now = Date.now();
      const last = lastQrVerifiedAt.get(r.qrId) ?? 0;
      if (isRazorpayConfigured() && now - last > QR_VERIFY_EVERY_MS) {
        lastQrVerifiedAt.set(r.qrId, now);
        try {
          const remote = await fetchRazorpayQrCode(r.qrId);
          if (remote.paymentsCountReceived > 0) {
            const payments = await fetchRazorpayQrCodePayments(r.qrId);
            const captured = payments.find((p) => p.status === "captured");
            if (captured) {
              request.log.warn(
                { qrId: r.qrId, paymentId: captured.id },
                "[gate-pass-qr] payment found by polling that the webhook had not delivered"
              );
              await pgClient`
                UPDATE razorpay_payments
                   SET status = 'paid',
                       razorpay_payment_id = ${captured.id},
                       paid_at = COALESCE(paid_at, now()),
                       updated_at = now()
                 WHERE id = ${r.id}::uuid
                   AND status IN ('created', 'attempted', 'failed')
              `;
              await applyPaidGatePassPayment(r.id);
              const [stamped] = await pgClient`
                SELECT payment_ref AS "paymentRef" FROM direct_sales WHERE id = ${id}::uuid
              `;
              const afterPoll = await loadDirectSaleMoney(pgClient, id);
              return reply.send({
                state: afterPoll.outstanding <= 0.001 ? "paid" : "partial",
                paymentRef: (stamped as any)?.paymentRef ?? captured.id,
                amount: r.amount,
                paidAt: null,
                collected: afterPoll.collected,
                outstanding: afterPoll.outstanding,
                viaPolling: true,
              });
            }
          }
          if (remote.status === "closed") {
            await pgClient`
              UPDATE razorpay_payments
                 SET status = 'failed',
                     error_description = 'QR closed at Razorpay before payment',
                     updated_at = now()
               WHERE id = ${r.id}::uuid
                 AND status IN ('created', 'attempted')
            `;
            return reply.send({ state: "expired", qrId: r.qrId });
          }
        } catch (err) {
          // A gateway hiccup must not break the counter screen — the next
          // poll tries again.
          request.log.warn({ err, qrId: r.qrId }, "[gate-pass-qr] QR verify call failed");
        }
      }

      return reply.send({
        state: "pending",
        qrId: r.qrId,
        imageUrl: r.imageUrl,   // stored at mint; not derivable from the id
        amount: r.amount,
        collected: money.collected,
        outstanding: money.outstanding,
      });
    }
  );

  // ── POST /api/v1/direct-sales/:id/qr/close ─────────────────────────
  app.post(
    "/api/v1/direct-sales/:id/qr/close",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      if (!isRazorpayConfigured()) return qrUnavailable(reply);

      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const [row] = await pgClient`
        SELECT id::text, razorpay_qr_code_id AS "qrId", status::text AS status
          FROM razorpay_payments
         WHERE direct_sale_id = ${id}::uuid
           AND kind = 'gate_pass'
           AND status IN ('created', 'attempted')
         ORDER BY created_at DESC
         LIMIT 1
      `;
      if (!row) return reply.send({ ok: true, nothingToClose: true });

      // Close at Razorpay FIRST. Marking our row dead while the QR stayed
      // scannable is the one ordering that could take money we then have
      // no live row to attribute.
      try {
        await closeRazorpayQrCode((row as any).qrId);
      } catch (err: any) {
        request.log.error(err, "[gate-pass-qr] close failed at Razorpay");
        return reply.status(502).send({
          error: "Gateway error",
          message: "Could not cancel the QR at Razorpay. It expires on its own shortly.",
        });
      }

      await pgClient`
        UPDATE razorpay_payments
           SET status = 'failed',
               error_description = 'Cancelled at the counter',
               updated_at = now()
         WHERE id = ${(row as any).id}::uuid
           AND status IN ('created', 'attempted')
      `;
      return reply.send({ ok: true, qrId: (row as any).qrId });
    }
  );

  // ═══════════════════════════════════════════════════════════════════
  // Cancellation + invoice — parity with the indent rail
  //
  //   POST /direct-sales/:id/cancel   — mirrors /orders/:id/admin-cancel
  //   GET  /direct-sales/:id/invoice  — mirrors /orders/:id/invoice
  // ═══════════════════════════════════════════════════════════════════

  // ── POST /api/v1/direct-sales/:id/cancel ───────────────────────────
  // Cancels a counter sale or gate pass: it stops counting as a sale
  // everywhere, its stock goes back, any live counter QR is closed, and
  // whatever the gateway collected is returned.
  //
  // `refundMethod` only bites when gateway money was actually taken:
  //   • "razorpay" → bank refund of the collected amount (default)
  //   • "balance"  → store credit on the agent's available balance
  // A cash, credit or complimentary pass posts nothing at creation, so there
  // is nothing to reverse — the sale still cancels and the response says what
  // the counter must hand back. See lib/direct-sale-money.ts.
  app.post(
    "/api/v1/direct-sales/:id/cancel",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z
        .object({
          reason: z.string().min(1, "A cancellation reason is required"),
          refundMethod: z.enum(["razorpay", "balance"]).optional(),
        })
        .parse(request.body);

      try {
        const summary = await cancelDirectSale(
          id,
          body.reason,
          request.admin!.userId,
          body.refundMethod,
        );
        return reply.send({ message: "Sale cancelled", saleId: id, ...summary });
      } catch (err) {
        if (err instanceof DirectSaleCancelError)
          return reply.status(err.statusCode).send({ error: err.message });
        if (err instanceof RefundError)
          return reply.status(err.statusCode).send({ error: err.message });
        throw err;
      }
    }
  );

  // ── GET /api/v1/direct-sales/:id/invoice ───────────────────────────
  // Resolve a sale to its tax invoice, generating it on demand. Backs the
  // clickable bill # on Recent Sales, exactly as /orders/:id/invoice backs
  // the indent # on All Indents. Generation is idempotent (the invoices
  // upsert keys on order_id), so repeated clicks are safe.
  //
  // EVERY direct sale resolves to a document, VIP samples and zero-value
  // passes included — the counter still hands the recipient a record of what
  // left the gate, so the bill # must open something on every row. An invoice
  // already minted is still returned for a since-cancelled sale, so the
  // record of what was issued stays reachable.
  app.get(
    "/api/v1/direct-sales/:id/invoice",
    { preHandler: [adminAuth, requireRole("direct_sales.view")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);

      const [sale] = await pgClient`
        SELECT id FROM direct_sales WHERE id = ${id}::uuid LIMIT 1
      `;
      if (!sale) return reply.status(404).send({ error: "Sale not found" });

      let [inv] = await pgClient`
        SELECT id, invoice_number FROM invoices WHERE order_id = ${id} LIMIT 1
      `;

      if (!inv) {
        try {
          await generateDirectSaleInvoicePdfSync(id);
          [inv] = await pgClient`
            SELECT id, invoice_number FROM invoices WHERE order_id = ${id} LIMIT 1
          `;
        } catch (err) {
          request.log.error({ err, saleId: id }, "[invoice] direct-sale generate-on-demand failed");
          return reply.status(500).send({ error: "Could not generate invoice" });
        }
      }

      if (!inv) return reply.status(500).send({ error: "Could not generate invoice" });
      return reply.send({
        invoiceId: inv.id,
        invoiceNumber: inv.invoice_number ?? null,
      });
    }
  );

  // POST /api/v1/direct-sales/cash — create cash customer sale
  app.post(
    "/api/v1/direct-sales/cash",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const schema = z.object({
        // A walk-in is typed straight onto the sale screen, so the counter
        // form sends a NAME, not an id — it has no cash_customers row to
        // point at yet. Either is accepted: an id when one was picked from
        // the master, otherwise the name (+ phone) we find-or-create below.
        // Requiring the id is what made this endpoint reject every sale the
        // Cash tab sent.
        customerId: z.string().uuid().optional(),
        customerName: z.string().trim().min(1).optional(),
        customerPhone: z.string().trim().optional(),
        routeId: z.string().uuid().optional(),
        batchId: z.string().uuid().optional(),
        saleDate: z.string().optional(),
        paymentMode: z.enum(["cash", "upi"]).default("cash"),
        paymentRef: z.string().optional(),
        notes: z.string().optional(),
        items: z.array(saleItemSchema).min(1),
      });
      const body = schema.parse(request.body);
      const saleDate = body.saleDate ?? istToday();

      // ── Resolve the walk-in to a cash_customers row ──
      let customerId = body.customerId ?? null;
      if (!customerId) {
        if (!body.customerName) {
          return reply.status(400).send({
            error: "Customer required",
            message: "Give either customerId or customerName for a cash sale.",
          });
        }
        const phone = body.customerPhone?.trim() || null;
        // Re-use the same walk-in rather than minting a duplicate every
        // visit, so Recent Sales and the day book keep one row per person.
        const [found] = await pgClient`
          SELECT id FROM cash_customers
           WHERE deleted_at IS NULL
             AND lower(name) = lower(${body.customerName})
             AND COALESCE(phone, '') = COALESCE(${phone}, '')
           LIMIT 1
        `;
        if (found) {
          customerId = String((found as any).id);
        } else {
          const [created] = await pgClient`
            INSERT INTO cash_customers (name, phone)
            VALUES (${body.customerName}, ${phone})
            RETURNING id
          `;
          customerId = String((created as any)!.id);
        }
      }

      // Fetch product prices
      const productIds = body.items.map(i => i.productId);
      const productRows = await pgClient`
        SELECT id, name, base_price, gst_percent FROM products
        WHERE id = ANY(${productIds}::uuid[]) AND deleted_at IS NULL
      `;
      const productMap = new Map(productRows.map((p: any) => [p.id, p]));

      let subtotal = 0;
      let totalGst = 0;
      const lineItems: any[] = [];

      for (const item of body.items) {
        const product = productMap.get(item.productId);
        if (!product) return reply.status(400).send({ error: `Product ${item.productId} not found` });

        // Paise. The master column still allows a third decimal; a counter
        // sale must bill the same rate a dealer order does.
        const unitPrice = Math.round(parseFloat(product.base_price) * 100) / 100;
        const gstPercent = parseFloat(product.gst_percent);
        const lineSubtotal = unitPrice * item.quantity;
        const gstAmount = Math.round(lineSubtotal * gstPercent) / 100;
        const lineTotal = lineSubtotal + gstAmount;

        subtotal += lineSubtotal;
        totalGst += gstAmount;

        lineItems.push({ productId: item.productId, productName: product.name, quantity: item.quantity, unitPrice, gstPercent, gstAmount, lineTotal });
      }

      const grandTotal = subtotal + totalGst;

      // One transaction, so the stock guard's throw takes the whole sale with
      // it — previously the header, its lines and the deduction were three
      // independent statements that could each land on their own.
      let sale: any;
      try {
        await pgClient.begin(async (_tx) => {
          const tx = _tx as unknown as typeof pgClient;

          [sale] = await tx`
            INSERT INTO direct_sales (customer_type, customer_id, route_id, officer_id, batch_id,
                                       sale_date, payment_mode, payment_ref, subtotal, total_gst, grand_total, notes)
            VALUES ('cash', ${customerId}, ${body.routeId ?? null}, ${request.admin!.userId},
                    ${body.batchId ?? null}, ${saleDate}::date, ${body.paymentMode}::payment_mode,
                    ${body.paymentRef ?? null}, ${subtotal}, ${totalGst}, ${grandTotal}, ${body.notes ?? null})
            RETURNING *
          `;
          if (!sale) throw new Error("Failed to create sale");

          for (const item of lineItems) {
            await tx`
              INSERT INTO direct_sale_items (direct_sale_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total)
              VALUES (${sale.id}, ${item.productId}, ${item.productName}, ${item.quantity},
                      ${item.unitPrice}, ${item.gstPercent}, ${item.gstAmount}, ${item.lineTotal})
            `;
          }

          // ── Stock ── the sale is written, so fgs_available counts it; a
          // negative remainder is this sale overselling the day.
          await assertNoOversell(
            tx,
            lineItems.map((i): StockDemandLine => ({
              productId: i.productId,
              productName: i.productName,
              quantity: i.quantity,
            })),
            saleDate,
          );

          // Legacy bookkeeping only (products.stock is vestigial).
          for (const item of lineItems) {
            await tx`
              UPDATE products SET stock = GREATEST(stock - ${item.quantity}, 0), updated_at = now()
              WHERE id = ${item.productId}
            `;
          }
        });
      } catch (err) {
        if (err instanceof StockConflictError) return insufficientStock(reply, err);
        throw err;
      }

      // ── Invoice (best-effort) ──
      const invoice = await mintDirectSaleInvoice(app, sale.id);

      return reply.status(201).send({ sale, items: lineItems, ...invoice });
    }
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/direct-sales/vip-sample
  // Free issue to a VIP. Forces all prices and GST to 0.
  // ────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/direct-sales/vip-sample",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const body = z.object({
        customerId: z.string().uuid(),   // vip_contacts.id
        routeId:    z.string().uuid().optional(),
        batchId:    z.string().uuid().optional(),
        saleDate:   z.string().optional(),
        notes:      z.string().optional(),
        items:      z.array(saleItemSchema).min(1),
      }).parse(request.body);

      const saleDate = body.saleDate ?? istToday();

      // Resolve VIP for recipient_name snapshot
      const [vip] = await pgClient`
        SELECT id, name FROM vip_contacts
        WHERE id = ${body.customerId} AND deleted_at IS NULL
      `;
      if (!vip) return reply.status(400).send({ error: "VIP contact not found" });

      // Fetch product names for snapshots
      const productIds = body.items.map(i => i.productId);
      const productRows = await pgClient`
        SELECT id, name FROM products
        WHERE id = ANY(${productIds}::uuid[]) AND deleted_at IS NULL
      `;
      const productMap = new Map(productRows.map((p: any) => [p.id, p]));

      const lineItems = body.items.map((it) => {
        const product = productMap.get(it.productId);
        if (!product) throw new Error(`Product ${it.productId} not found`);
        return {
          productId:   it.productId,
          productName: product.name,
          quantity:    it.quantity,
          unitPrice:   0,
          gstPercent:  0,
          gstAmount:   0,
          lineTotal:   0,
        };
      });

      // One transaction, so the stock guard's throw takes the sample with it.
      let sale: any;
      try {
        await pgClient.begin(async (_tx) => {
          const tx = _tx as unknown as typeof pgClient;

          [sale] = await tx`
            INSERT INTO direct_sales (
              customer_type, customer_id, recipient_name, route_id, officer_id, batch_id,
              sale_date, payment_mode, payment_ref,
              subtotal, total_gst, grand_total, notes
            )
            VALUES (
              'vip_sample', ${body.customerId}, ${vip.name},
              ${body.routeId ?? null}, ${request.admin!.userId}, ${body.batchId ?? null},
              ${saleDate}::date, 'complimentary'::payment_mode, NULL,
              0, 0, 0, ${body.notes ?? null}
            )
            RETURNING *
          `;
          if (!sale) throw new Error("Failed to create sale");

          for (const item of lineItems) {
            await tx`
              INSERT INTO direct_sale_items (
                direct_sale_id, product_id, product_name, quantity,
                unit_price, gst_percent, gst_amount, line_total
              ) VALUES (
                ${sale.id}, ${item.productId}, ${item.productName}, ${item.quantity},
                0, 0, 0, 0
              )
            `;
          }

          // ── Stock ──
          // A sample is free, not weightless: the goods physically left the
          // warehouse, so it is gated exactly like a paid sale. Issuing a
          // sample of a SKU sitting at zero is what drove availability
          // negative with nothing to show for it on any money report.
          await assertNoOversell(
            tx,
            lineItems.map((i): StockDemandLine => ({
              productId: i.productId,
              productName: i.productName,
              quantity: i.quantity,
            })),
            saleDate,
          );

          // Legacy bookkeeping only (products.stock is vestigial).
          for (const item of lineItems) {
            await tx`
              UPDATE products SET stock = GREATEST(stock - ${item.quantity}, 0), updated_at = now()
              WHERE id = ${item.productId}
            `;
          }
        });
      } catch (err) {
        if (err instanceof StockConflictError) return insufficientStock(reply, err);
        throw err;
      }

      // ── Invoice (best-effort) ──
      // A sample is a zero-value issue, so this document foots at Rs. 0.00 and
      // is settled on sight. It exists so the VIP leaves with a priced record
      // of the goods, and so Recent Sales can open the row like any other.
      const invoice = await mintDirectSaleInvoice(app, sale.id);

      return reply.status(201).send({ sale, items: lineItems, ...invoice });
    }
  );

  // ────────────────────────────────────────────────────────────────────
  // POST /api/v1/direct-sales/employee-subsidy
  // Employee buys at MRP × (1 − subsidy%). Server applies discount, staff cannot override.
  // Only products with an active row in employee_subsidy_rules are accepted.
  //
  // This places a real INDENT (employee_orders + employee_order_items), not
  // a direct_sales row. It used to write direct_sales — but neither All
  // Indents (GET /orders) nor the Dispatch Sheet (GET /dispatch-sheet) reads
  // that table, so the subsidy goods were invisible to the office and to the
  // loading staff, and no tax invoice was ever raised. Both screens now union
  // employee_orders in, so an employee indent behaves like any other:
  // it dispatches on a route, it appears in All Indents, and it is invoiced.
  //
  // routeId is OPTIONAL and normally absent: the subsidy is collected at the
  // plant counter, so there is no delivery route to state. It is still
  // accepted for the rare case where the goods do ride a vehicle. A route-less
  // indent is NOT invisible — the Dispatch Sheet and the Gate Pass Report both
  // collect route-less goods under their ADHOC bucket.
  //
  // Create-or-append, like the customer subsidy flow (subsidy-indents.ts):
  // uq_employee_orders_emp_delivery_active (migration 0062) allows at most
  // one non-cancelled employee order per (employee, delivery_date), so a
  // second subsidy sale on the same day SETS its lines on that day's order
  // rather than opening a second one.
  // ────────────────────────────────────────────────────────────────────
  app.post(
    "/api/v1/direct-sales/employee-subsidy",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const body = z.object({
        customerId:  z.string().uuid(),   // employees.id
        routeId:     z.string().uuid().optional(),   // optional — see header
        saleDate:    z.string().optional(),
        paymentMode: z.enum(["cash", "upi", "credit"]).default("cash"),
        paymentRef:  z.string().optional(),
        notes:       z.string().optional(),
        items:       z.array(saleItemSchema).min(1),
      }).parse(request.body);

      if (body.paymentMode === "upi" && !body.paymentRef?.trim()) {
        return reply.status(400).send({ error: "paymentRef is required for UPI" });
      }

      // Delivery date defaults to today in IST — resolved in Postgres so the
      // ::date casts below never round-trip a JS Date through the driver.
      const [d] = await pgClient`
        SELECT to_char((now() AT TIME ZONE 'Asia/Kolkata')::date, 'YYYY-MM-DD') AS today
      `;
      const deliveryDate = body.saleDate ?? String(d!.today);

      // Resolve employee
      const [employee] = await pgClient`
        SELECT id, name, active FROM employees
        WHERE id = ${body.customerId} AND deleted_at IS NULL
      `;
      if (!employee)         return reply.status(400).send({ error: "Employee not found" });
      if (!employee.active)  return reply.status(400).send({ error: "Employee is inactive" });

      // Only validated when one was actually named — see header.
      if (body.routeId) {
        const [route] = await pgClient`
          SELECT id FROM routes WHERE id = ${body.routeId}::uuid AND deleted_at IS NULL
        `;
        if (!route) return reply.status(400).send({ error: "Route not found" });
      }

      // Validate every line is in the eligible product list, and resolve the
      // fixed (GST-inclusive) employee price.
      const productIds = body.items.map(i => i.productId);
      const eligible = await pgClient`
        SELECT r.product_id, r.subsidy_price, r.subsidy_percent,
              p.name, p.base_price, p.gst_percent
        FROM employee_subsidy_rules r
        JOIN products p ON p.id = r.product_id
        WHERE r.active = true
          AND p.deleted_at IS NULL
          AND r.product_id = ANY(${productIds}::uuid[])
      `;
      const ruleMap = new Map(eligible.map((r: any) => [r.product_id, r]));
      for (const it of body.items) {
        if (!ruleMap.has(it.productId)) {
          return reply.status(400).send({
            error: `Product ${it.productId} is not eligible for employee subsidy`,
          });
        }
      }

      const lineItems: any[] = [];

      for (const it of body.items) {
        const rule = ruleMap.get(it.productId)!;
        const mrp        = parseFloat(rule.base_price);
        const empPrice   = parseFloat(rule.subsidy_price);  // GST-inclusive unit price
        const gstPct     = parseFloat(rule.gst_percent);

        // Back out the pre-GST unit price so the GST split is recorded, while
        // the line total stays exactly the fixed price × qty.
        const unitPrice  = +(empPrice / (1 + gstPct / 100)).toFixed(2);
        const lineTotal  = +(empPrice * it.quantity).toFixed(2);
        const lineSub    = +(unitPrice * it.quantity).toFixed(2);
        const gstAmount  = +(lineTotal - lineSub).toFixed(2);

        lineItems.push({
          productId:   it.productId,
          productName: rule.name,
          quantity:    it.quantity,
          unitPrice,
          gstPercent:  gstPct,
          gstAmount,
          lineTotal,
          empPrice,
          subsidyPercent: parseFloat(rule.subsidy_percent ?? "0"),
          mrpReference:   mrp,
        });
      }

      const subsidyNote = lineItems
        .map(li => `${li.productName}: employee price ₹${li.empPrice} (incl. GST) × ${li.quantity}`)
        .join("; ");

      const performedBy = request.admin!.userId;

      // ── The day's existing non-cancelled indent, if any ──
      const [existing] = await pgClient`
        SELECT id, status::text AS status, grand_total::numeric AS grand_total
          FROM employee_orders
         WHERE employee_id = ${body.customerId}
           AND delivery_date = ${deliveryDate}::date
           AND status <> 'cancelled'
         ORDER BY created_at DESC
         LIMIT 1
      `;
      if (existing?.status === "delivered") {
        return reply.status(409).send({
          error: "Indent already delivered",
          message: `This employee's indent for ${deliveryDate} is already delivered and can no longer be changed.`,
        });
      }

      const oldTotal = existing ? parseFloat(existing.grand_total) : 0;

      let orderId: string = "";
      let grandTotal = 0;
      try {
      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        if (existing) {
          orderId = existing.id;
          await tx`
            UPDATE employee_orders
               -- COALESCE, not overwrite: appending a route-less subsidy line
               -- to the day's indent must not erase a route already set on it.
               SET route_id     = COALESCE(${body.routeId ?? null}::uuid, route_id),
                   payment_mode = ${body.paymentMode}::payment_mode,
                   notes        = COALESCE(${body.notes ?? null}, notes),
                   updated_at   = now()
             WHERE id = ${orderId}::uuid
          `;
        } else {
          const [order] = await tx`
            INSERT INTO employee_orders (
              employee_id, route_id, status, payment_mode,
              subtotal, total_gst, grand_total, item_count,
              delivery_date, notes, placed_by, confirmed_at, created_at, updated_at
            ) VALUES (
              ${body.customerId}, ${body.routeId ?? null}::uuid, 'confirmed',
              ${body.paymentMode}::payment_mode,
              0, 0, 0, 0,
              ${deliveryDate}::date,
              ${body.notes ? `${body.notes} | ${subsidyNote}` : subsidyNote},
              ${performedBy}, now(), now(), now()
            )
            RETURNING id
          `;
          orderId = order!.id;
        }

        // What the day's indent already holds per SKU. The lines are about to
        // be REPLACED (set-not-add, below), so only the increase over this is
        // new demand on the floor — which is what the stock guard is given.
        // Without it, trimming a line on an already-oversold SKU would be
        // refused for an oversell the operator is in the middle of undoing.
        const priorQty = new Map<string, number>();
        if (existing) {
          const priorRows = await tx`
            SELECT product_id::text AS "productId", quantity
              FROM employee_order_items
             WHERE employee_order_id = ${orderId}::uuid
          `;
          for (const r of priorRows as any[]) {
            priorQty.set(String(r.productId), Number(r.quantity));
          }
        }

        // Set-not-add per product, mirroring the customer subsidy flow: a
        // repeat sale of the same SKU on the same day REPLACES the line
        // rather than stacking a duplicate onto the indent.
        for (const it of lineItems) {
          await tx`
            DELETE FROM employee_order_items
             WHERE employee_order_id = ${orderId}::uuid
               AND product_id = ${it.productId}::uuid
          `;
          await tx`
            INSERT INTO employee_order_items (
              employee_order_id, product_id, product_name, quantity,
              unit_price, gst_percent, gst_amount, line_total,
              subsidy_percent, mrp_reference
            ) VALUES (
              ${orderId}::uuid, ${it.productId}::uuid, ${it.productName}, ${it.quantity},
              ${it.unitPrice}, ${it.gstPercent}, ${it.gstAmount}, ${it.lineTotal},
              ${it.subsidyPercent}, ${it.mrpReference}
            )
          `;
          await tx`
            UPDATE products SET stock = GREATEST(stock - ${it.quantity}, 0), updated_at = now()
            WHERE id = ${it.productId}
          `;
        }

        // ── Stock ──
        // The lines are written and the indent is non-draft, so fgs_available
        // (migration 0072) already counts them; a negative remainder means the
        // subsidy goods are not on the floor. Set-not-add above means the old
        // line for a repeat SKU is gone by now, so this measures the indent as
        // it will stand, not the pair.
        await assertNoOversell(
          tx,
          lineItems.map((i): StockDemandLine => ({
            productId: i.productId,
            productName: i.productName,
            quantity: i.quantity - (priorQty.get(i.productId) ?? 0),
          })),
          deliveryDate,
        );

        // Re-total from ALL the indent's lines so an append leaves the
        // pre-existing ones exactly as they were.
        const [tot] = await tx`
          SELECT
            COALESCE(SUM(line_total), 0)::numeric                   AS grand_total,
            COALESCE(SUM(gst_amount), 0)::numeric                   AS total_gst,
            COALESCE(SUM(line_total) - SUM(gst_amount), 0)::numeric AS subtotal,
            COUNT(*)::int                                           AS item_count
          FROM employee_order_items WHERE employee_order_id = ${orderId}::uuid
        `;
        grandTotal = parseFloat(tot!.grand_total);
        await tx`
          UPDATE employee_orders SET
            subtotal    = ${tot!.subtotal}::numeric,
            total_gst   = ${tot!.total_gst}::numeric,
            grand_total = ${tot!.grand_total}::numeric,
            item_count  = ${tot!.item_count},
            updated_at  = now()
          WHERE id = ${orderId}::uuid
        `;

        // Credit sale → debit the employee_ledger so the balance is reflected
        // in Finance → Employee Credit. Only the DELTA over what this indent
        // already carried is charged, so appending a line to the day's indent
        // never re-bills the lines already on it.
        const chargeDelta = +(grandTotal - oldTotal).toFixed(2);
        if (body.paymentMode === "credit" && chargeDelta !== 0) {
          const [bal] = await tx`
            SELECT
              COALESCE(e.opening_balance, 0)
              + COALESCE((SELECT SUM(CASE WHEN el.type = 'credit'
                                           AND COALESCE(el.voucher_type,'') <> 'Opening'
                                          THEN el.amount ELSE 0 END)
                            FROM employee_ledger el WHERE el.employee_id = e.id), 0)
              - COALESCE((SELECT SUM(CASE WHEN el.type = 'debit'
                                           AND COALESCE(el.voucher_type,'') <> 'Opening'
                                          THEN el.amount ELSE 0 END)
                            FROM employee_ledger el WHERE el.employee_id = e.id), 0)
              AS bal
            FROM employees e WHERE e.id = ${body.customerId}
          `;
          const balance = parseFloat(bal!.bal);

          if (chargeDelta > 0) {
            await tx`
              INSERT INTO employee_ledger
                (employee_id, type, amount, reference_id, reference_type,
                 voucher_type, voucher_date, description, balance_after, performed_by)
              VALUES
                (${body.customerId}, 'debit', ${chargeDelta.toFixed(2)}::numeric,
                 ${orderId}, 'order', 'Invoice', ${deliveryDate}::date,
                 ${"Employee subsidy indent " + orderId},
                 ${(balance - chargeDelta).toFixed(2)}::numeric, ${performedBy})
            `;
          } else {
            const refund = Math.abs(chargeDelta);
            await tx`
              INSERT INTO employee_ledger
                (employee_id, type, amount, reference_id, reference_type,
                 voucher_type, voucher_date, description, balance_after, performed_by)
              VALUES
                (${body.customerId}, 'credit', ${refund.toFixed(2)}::numeric,
                 ${orderId}, 'adjustment', 'Adjustment', ${deliveryDate}::date,
                 ${"Employee subsidy indent revised " + orderId},
                 ${(balance + refund).toFixed(2)}::numeric, ${performedBy})
            `;
          }
        }
      });
      } catch (err) {
        if (err instanceof StockConflictError) return insufficientStock(reply, err);
        throw err;
      }

      // ── Invoice (best-effort, outside the tx) ──
      // The money and the goods are already committed; a PDF render or an R2
      // hiccup must not fail the request or suggest the sale itself failed.
      let invoiceNumber: string | null = null;
      let invoicePdfUrl: string | null = null;
      try {
        const pdf = await generateEmployeeInvoicePdfSync(orderId);
        invoicePdfUrl = pdf.pdfUrl;
        invoiceNumber = pdf.invoiceNumber;
      } catch (err) {
        console.error("[employee-subsidy] Invoice generation failed:", err);
      }

      return reply.status(201).send({
        orderId,
        deliveryDate,
        status: existing?.status ?? "confirmed",
        appended: !!existing,
        grandTotal: grandTotal.toFixed(2),
        invoiceNumber,
        invoicePdfUrl,
        items: lineItems,
      });
    }
  );

  // PATCH /api/v1/direct-sales/:id/items — qty-only modification of a direct sale
  app.patch(
    "/api/v1/direct-sales/:id/items",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        items: z.array(z.object({
          productId: z.string().uuid(),
          quantity:  z.number().int().min(0),
        })).min(1),
        // Where the money goes when an edit shrinks a sale that the counter
        // QR had already collected on: "razorpay" refunds to the payer's
        // bank, "balance" credits an agent's available balance. Ignored when
        // nothing was collected (cash / credit passes post nothing) or when
        // the edit raises the total. Defaults to "razorpay" — the money came
        // in through the gateway, so that is where it goes back by default.
        refundMethod: z.enum(["balance", "razorpay"]).optional(),
      });
      const body = schema.parse(request.body);

      const [sale] = await pgClient`
        SELECT id, customer_type, subtotal, total_gst, grand_total,
               status::text AS status, customer_id::text AS customer_id,
               payment_mode::text AS payment_mode, gp_no, sale_date::text AS sale_date
        FROM direct_sales WHERE id = ${id} FOR UPDATE
      `;
      if (!sale) return reply.status(404).send({ error: "Direct sale not found" });
      if (sale.status === "cancelled") {
        return reply.status(409).send({
          error: "Sale cancelled",
          message: "A cancelled sale cannot be modified.",
        });
      }

      // Existing rows — we keep the price/gst snapshot and only adjust qty.
      const existingItems = await pgClient`
        SELECT id, product_id, quantity, unit_price, gst_percent
        FROM direct_sale_items WHERE direct_sale_id = ${id}
      `;
      const byProduct = new Map(existingItems.map((r: any) => [r.product_id, r]));

      // Validate every productId in the payload exists on this sale.
      for (const i of body.items) {
        if (!byProduct.has(i.productId)) {
          return reply.status(400).send({
            error: `Product ${i.productId} is not part of this sale; cannot add/swap products here`,
          });
        }
      }

      // Recompute totals + per-line deltas
      let newSubtotal = 0, newGst = 0;
      const stockDeltas: Array<{ productId: string; delta: number }> = [];
      const updates: Array<{
        lineId: string; productId: string; quantity: number;
        unitPrice: string; gstPercent: string;
        gstAmount: string; lineTotal: string;
      }> = [];

      for (const i of body.items) {
        const existing: any = byProduct.get(i.productId);
        const unitPrice = parseFloat(existing.unit_price);
        const gstPct    = parseFloat(existing.gst_percent);
        const line      = calcLine(unitPrice, gstPct, i.quantity);
        const lineSub   = line.subtotal;
        const lineGst   = line.gst;
        newSubtotal = round2(newSubtotal + lineSub);
        newGst      = round2(newGst + lineGst);
        // delta = new − old. Positive means more stock leaves the warehouse.
        stockDeltas.push({ productId: i.productId, delta: i.quantity - Number(existing.quantity) });
        updates.push({
          lineId: existing.id,
          productId: i.productId,
          quantity: i.quantity,
          unitPrice:  unitPrice.toFixed(2),
          gstPercent: gstPct.toFixed(2),
          gstAmount:  lineGst.toFixed(2),
          lineTotal:  line.total.toFixed(2),
        });
      }

      const newGrandTotal = newSubtotal + newGst;
      const oldGrandTotal = parseFloat(sale.grand_total);
      const delta = newGrandTotal - oldGrandTotal;

      // ── Money impact ─────────────────────────────────────────────────
      // A direct sale posts nothing at creation, so an edit has nothing to
      // reverse UNLESS the counter QR actually collected. What matters is
      // therefore not the delta but how the newly-collected total compares
      // with what is now owed:
      //   • collected > new total → the difference must go back
      //   • collected < new total → a balance is outstanding, and the counter
      //     screen mints a top-up QR for it (see the QR mint endpoint)
      // Cash and credit passes collect nothing here, so both figures stay
      // zero and the operator settles the difference across the counter.
      const money = await loadDirectSaleMoney(pgClient, id);
      const refundDue = Math.max(0, money.collected - newGrandTotal);
      const isAgent = sale.customer_type === "agent";

      // A wallet or credit pass DID post at creation, so an edit has to move
      // the ledger with it. Measured against what is actually posted rather
      // than against the old grand total, so an edit after a partial
      // reversal still lands on the right number.
      const ledgerSettled = isAgent && LEDGER_SETTLED_MODES.has(sale.payment_mode);
      const alreadyPosted = ledgerSettled ? await ledgerPostedForSale(pgClient, id) : 0;
      const ledgerDelta = ledgerSettled ? +(newGrandTotal - alreadyPosted).toFixed(2) : 0;

      // Raising a wallet pass spends more prepaid balance, so it faces the
      // same gate the original did. Lowering one never needs headroom.
      if (ledgerDelta > 0.001 && sale.payment_mode === "wallet") {
        const credit = await checkDealerCredit(sale.customer_id, ledgerDelta);
        if (!credit.sufficient) {
          return reply.status(400).send({
            error: "Insufficient balance",
            message:
              `This change adds ₹${ledgerDelta.toFixed(2)} to the pass, but the agent's ` +
              `available balance is ₹${credit.available.toFixed(2)}.`,
            available: credit.available,
            shortfall: credit.shortfall,
          });
        }
      }

      // The stock guard runs BEFORE the gateway too, and for the same reason:
      // an edit that cuts one line and raises another can owe a refund AND
      // oversell, and money must not leave the bank for a change the
      // transaction below is about to roll back. Advisory only (no lock) —
      // assertNoOversell inside the transaction stays the authority.
      const raisedLines = stockDeltas.map((d): StockDemandLine => ({
        productId: d.productId,
        quantity: d.delta,
      }));
      const preShortfalls = await getDemandShortfalls(
        pgClient,
        raisedLines,
        String(sale.sale_date),
      );
      if (preShortfalls.length > 0) {
        return insufficientStock(reply, new StockConflictError(preShortfalls));
      }

      // Gateway work runs BEFORE the transaction, as on the order rail, so a
      // refusal aborts with nothing half-written (RefundError → 409).
      let refundPlan: Awaited<ReturnType<typeof initiateGatePassBankRefunds>> | null = null;
      const refundToBalance =
        refundDue > 0.001 && body.refundMethod === "balance" && isAgent;

      if (refundDue > 0.001 && !refundToBalance) {
        try {
          refundPlan = await initiateGatePassBankRefunds(
            id,
            refundDue,
            `Modify sale ${id}`,
          );
        } catch (err) {
          if (err instanceof RefundError)
            return reply.status(err.statusCode).send({ error: err.message });
          throw err;
        }
      }

      try {
      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as typeof pgClient;

        for (const u of updates) {
          if (u.quantity === 0) {
            await tx`DELETE FROM direct_sale_items WHERE id = ${u.lineId}`;
          } else {
            await tx`
              UPDATE direct_sale_items
                SET quantity   = ${u.quantity},
                    gst_amount = ${u.gstAmount}::numeric,
                    line_total = ${u.lineTotal}::numeric
              WHERE id = ${u.lineId}
            `;
          }
        }

        // ── Stock ──
        // Only the RAISED lines are new demand on the floor; a line being cut
        // frees stock and must never be refused. The rows above are already
        // written, so fgs_available reflects the edited sale and a negative
        // remainder is this edit overselling the day.
        await assertNoOversell(
          tx,
          stockDeltas.map((d): StockDemandLine => ({
            productId: d.productId,
            quantity: d.delta,
          })),
          String(sale.sale_date),
        );

        // Legacy bookkeeping only (products.stock is vestigial): refund old
        // qty, then subtract new qty, as one signed update. Floored, because
        // the counter has drifted below the real figure often enough that an
        // unfloored subtraction was pushing it negative on its own.
        for (const s of stockDeltas) {
          if (s.delta !== 0) {
            await tx`
              UPDATE products
                SET stock = GREATEST(stock - ${s.delta}, 0),
                    updated_at = now()
              WHERE id = ${s.productId}
            `;
          }
        }

        // For agent gate-passes, keep gate_pass_items.quantity in sync.
        if (sale.customer_type === "agent") {
          for (const u of updates) {
            await tx`
              UPDATE gate_pass_items
                SET quantity = ${u.quantity}, updated_at = now()
              WHERE direct_sale_id = ${id} AND product_id = ${u.productId}
            `;
          }
        }

        await tx`
          UPDATE direct_sales
            SET subtotal    = ${newSubtotal.toFixed(2)}::numeric,
                total_gst   = ${newGst.toFixed(2)}::numeric,
                grand_total = ${newGrandTotal.toFixed(2)}::numeric,
                updated_at  = now()
          WHERE id = ${id}
        `;

        if (refundPlan) {
          for (const intent of refundPlan.intents) {
            await recordBankRefund(tx, intent, `Modify sale ${id}`, request.admin!.userId);
          }
        } else if (refundToBalance) {
          await creditDealerBalance(
            tx,
            sale.customer_id,
            refundDue,
            id,
            `Modify credit for gate pass ${id}`,
            request.admin!.userId,
          );
        }

        // Move the ledger to match the new total. Only the DELTA, so the
        // lines that did not change are never re-billed.
        if (ledgerDelta > 0.001) {
          await debitDealerBalance(
            tx, sale.customer_id, ledgerDelta, id,
            `Gate pass ${sale.gp_no ?? id} revised up`,
            request.admin!.userId,
          );
        } else if (ledgerDelta < -0.001) {
          await creditDealerBalance(
            tx, sale.customer_id, Math.abs(ledgerDelta), id,
            `Gate pass ${sale.gp_no ?? id} revised down`,
            request.admin!.userId,
          );
        }

        // A cash pass's receipt has to equal what was actually taken. Replace
        // rather than adjust: `payments` has a CHECK (amount > 0), so an edit
        // down to zero has to remove the row outright.
        if (isAgent && sale.payment_mode === "cash") {
          await reverseCounterCashReceipt(tx, id);
          if (newGrandTotal > 0.001) {
            await recordCounterCashReceipt(tx, {
              dealerId: sale.customer_id,
              amount: newGrandTotal,
              saleId: id,
              gpNo: sale.gp_no ?? null,
              saleDate: sale.sale_date,
              performedBy: request.admin!.userId,
            });
          }
        }
      });
      } catch (err) {
        if (err instanceof StockConflictError) return insufficientStock(reply, err);
        throw err;
      }

      // The invoice minted for this sale kept the ORIGINAL figures, so refresh
      // it — same reason the indent rail reissues after a modify. No-op when
      // the sale was never invoiced; never throws.
      const reissue = await reissueDirectSaleInvoiceIfExists(id);

      const after = await loadDirectSaleMoney(pgClient, id);
      const refund = refundPlan
        ? {
            method: "razorpay" as const,
            amount: refundPlan.refunded,
            razorpayRefundIds: refundPlan.intents.map((i) => i.rzpRefund.id),
          }
        : refundToBalance
          ? { method: "balance" as const, amount: refundDue }
          : { method: "none" as const, amount: 0 };

      return reply.send({
        ok: true,
        id,
        grandTotal: newGrandTotal.toFixed(2),
        previousTotal: oldGrandTotal.toFixed(2),
        delta: Number(delta.toFixed(2)),
        money: after,
        refund,
        invoiceReissued: reissue.status === "reissued",
      });
    }
  );

  // PATCH /api/v1/direct-sales/:id/returns — record gate pass returns
  app.patch(
    "/api/v1/direct-sales/:id/returns",
    { preHandler: [adminAuth, requireRole("direct_sales.manage")] },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const schema = z.object({
        returns: z.array(z.object({
          productId: z.string().uuid(),
          returnedQuantity: z.number().int().min(0),
        })).min(1),
      });
      const body = schema.parse(request.body);

      // Verify this is an agent gate pass
      const [sale] = await pgClient`SELECT id, customer_type, status::text AS status FROM direct_sales WHERE id = ${id}`;
      if (!sale) return reply.status(404).send({ error: "Sale not found" });
      if (sale.customer_type !== "agent") return reply.status(400).send({ error: "Returns only apply to gate pass (agent) sales" });
      if (sale.status === "cancelled") {
        return reply.status(409).send({
          error: "Sale cancelled",
          message: "This gate pass has been cancelled, so returns cannot be recorded against it.",
        });
      }

      for (const ret of body.returns) {
        // Update gate pass item
        const [gpi] = await pgClient`
          UPDATE gate_pass_items SET
            returned_quantity = ${ret.returnedQuantity},
            updated_at = now()
          WHERE direct_sale_id = ${id} AND product_id = ${ret.productId}
          RETURNING quantity, returned_quantity
        `;

        if (gpi && ret.returnedQuantity > 0) {
          // Restore stock for returned items
          await pgClient`
            UPDATE products SET stock = stock + ${ret.returnedQuantity}, updated_at = now()
            WHERE id = ${ret.productId}
          `;
        }
      }

      // Recalculate sale totals based on net quantities (issued - returned)
      const netItems = await pgClient`
        SELECT gpi.product_id, (gpi.quantity - gpi.returned_quantity) AS net_qty,
               dsi.unit_price, dsi.gst_percent
        FROM gate_pass_items gpi
        JOIN direct_sale_items dsi ON dsi.direct_sale_id = gpi.direct_sale_id AND dsi.product_id = gpi.product_id
        WHERE gpi.direct_sale_id = ${id}
      `;

      let newSubtotal = 0;
      let newGst = 0;
      for (const item of netItems) {
        const lineSubtotal = parseFloat(item.unit_price) * item.net_qty;
        const gstAmount = Math.round(lineSubtotal * parseFloat(item.gst_percent)) / 100;
        newSubtotal += lineSubtotal;
        newGst += gstAmount;
      }

      await pgClient`
        UPDATE direct_sales SET subtotal = ${newSubtotal}, total_gst = ${newGst},
               grand_total = ${newSubtotal + newGst}, updated_at = now()
        WHERE id = ${id}
      `;

      // The pass is invoiced when it is raised, so recording a return leaves
      // the document standing at the pre-return total unless it is refreshed.
      // Reissue keeps the invoice_number and the legal issue date; it never
      // throws and no-ops when the sale was never invoiced.
      const reissue = await reissueDirectSaleInvoiceIfExists(id);

      return reply.send({
        message: "Returns recorded and totals updated",
        invoiceReissued: reissue.status === "reissued",
      });
    }
  );
}