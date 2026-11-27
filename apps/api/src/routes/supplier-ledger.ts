// apps/api/src/routes/supplier-ledger.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Supplier Ledger (purchase ledger per supplier, 0087)
//
//   GET  /api/v1/suppliers/:id/ledger        ?from&to   statement of account
//   POST /api/v1/suppliers/:id/ledger-entries           payment / opening /
//                                                        debit note / credit note
//   POST /api/v1/supplier-ledger-entries/:id/cancel     { reason }
//
// CREDIT (union owes more)   purchases (stock_receipts with a cost),
//                            opening balance, credit notes
// DEBIT  (union owes less)   payments, debit notes
// Balance > 0 = payable to the supplier (Cr); < 0 = advance with them (Dr).
//
// Purchases are read live from stock_receipts (one line per product per
// day), so a receipt corrected in Stock Entry shows corrected here. A
// receipt with no unit cost (own production, cost not known) is listed
// with its quantity and no amount.
//
// Reads: finance.view. Entries: finance.manage (Finance and super_admin).
// ═══════════════════════════════════════════════════════════════════════
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { isoDate, istToday } from "../lib/ist-date.js";

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const KIND_LABEL: Record<string, string> = {
  purchase: "Purchase", payment: "Payment", opening: "Opening balance",
  debit_note: "Debit note", credit_note: "Credit note",
};

type Row = {
  id: string; date: string; at: string;
  kind: "purchase" | "payment" | "opening" | "debit_note" | "credit_note";
  particulars: string;
  productName: string | null; qty: number | null; rate: number | null;
  debit: number; credit: number;
  mode: string | null; reference: string | null; notes: string | null; byName: string | null;
  entryId: string | null;
};

async function loadRows(supplierId: string, to: string): Promise<Row[]> {
  const rows = await pgClient`
    SELECT 'r:' || sr.id::text AS id, sr.date::text AS date, sr.created_at AS at, 'purchase' AS kind,
           COALESCE(NULLIF(trim(p.report_alias), ''), p.name) AS "productName",
           sr.quantity::float8 AS qty, sr.unit_cost::float8 AS rate,
           0::float8 AS debit, COALESCE(sr.total_cost, 0)::float8 AS credit,
           NULL::text AS mode, NULL::text AS reference, NULL::text AS notes,
           u.name AS "byName", NULL::uuid AS "entryId"
      FROM stock_receipts sr
      JOIN products p ON p.id = sr.product_id
      LEFT JOIN users u ON u.id = sr.entered_by
     WHERE sr.supplier_id = ${supplierId}::uuid AND sr.date <= ${to}::date AND sr.quantity > 0
    UNION ALL
    SELECT 'e:' || e.id::text, e.entry_date::text, e.created_at, e.kind,
           NULL, NULL, NULL,
           CASE WHEN e.kind IN ('payment', 'debit_note') THEN e.amount ELSE 0 END::float8,
           CASE WHEN e.kind IN ('opening', 'credit_note') THEN e.amount ELSE 0 END::float8,
           e.mode, e.reference, e.notes, u.name, e.id
      FROM supplier_ledger_entries e
      LEFT JOIN users u ON u.id = e.created_by
     WHERE e.supplier_id = ${supplierId}::uuid AND e.entry_date <= ${to}::date AND e.cancelled_at IS NULL
    ORDER BY date, at, id
  ` as any[];
  return rows.map(r => {
    let particulars: string;
    if (r.kind === "purchase") {
      particulars = `${r.productName}: ${Number(r.qty).toLocaleString("en-IN")}`
        + (r.rate != null ? ` × ₹${Number(r.rate).toFixed(2)}` : " (no cost recorded)");
    } else {
      particulars = [KIND_LABEL[r.kind], r.mode ? r.mode.toUpperCase() : null, r.reference, r.notes]
        .filter(Boolean).join(" · ");
    }
    return { ...r, particulars, debit: Number(r.debit) || 0, credit: Number(r.credit) || 0 } as Row;
  });
}

export async function supplierLedgerRoutes(app: FastifyInstance) {
  app.get(
    "/api/v1/suppliers/:id/ledger",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const today = istToday();
      const q = z.object({ from: isoDate.optional(), to: isoDate.optional() })
        .refine(x => !x.from || !x.to || x.from <= x.to, { message: "'from' must be on or before 'to'" })
        .parse(request.query);
      const from = q.from ?? today.slice(0, 8) + "01";
      const to = q.to ?? today;

      // A statement stays readable after the supplier is deleted.
      const [supplier] = await pgClient`
        SELECT id, code, name, phone, address, gst_no AS "gstNo", account_no AS "accountNo",
               (deleted_at IS NOT NULL) AS deleted
          FROM suppliers WHERE id = ${id}::uuid
      ` as any[];
      if (!supplier) return reply.status(404).send({ error: "Supplier not found" });

      const all = await loadRows(id, to);
      let balance = 0;
      let opening = 0;
      const rows: (Row & { balance: number })[] = [];
      for (const r of all) {
        balance = round2(balance + r.credit - r.debit);
        if (r.date < from) { opening = balance; continue; }
        rows.push({ ...r, balance });
      }
      const sum = (k: "debit" | "credit", kind?: Row["kind"]) =>
        round2(rows.filter(r => !kind || r.kind === kind).reduce((s, r) => s + r[k], 0));

      // Purchases in the period by product (qty and value).
      const byProduct = new Map<string, { productName: string; qty: number; amount: number; uncosted: number }>();
      for (const r of rows) {
        if (r.kind !== "purchase") continue;
        const k = r.productName ?? "";
        const cur = byProduct.get(k) ?? { productName: k, qty: 0, amount: 0, uncosted: 0 };
        cur.qty += r.qty ?? 0;
        cur.amount = round2(cur.amount + r.credit);
        if (r.rate == null) cur.uncosted += r.qty ?? 0;
        byProduct.set(k, cur);
      }

      return reply.send({
        supplier, from, to,
        openingBalance: opening,
        rows,
        purchasesByProduct: Array.from(byProduct.values()).sort((a, b) => b.amount - a.amount),
        totals: {
          purchases: sum("credit", "purchase"),
          creditNotes: round2(sum("credit") - sum("credit", "purchase")),
          payments: sum("debit", "payment"),
          debitNotes: sum("debit", "debit_note"),
          credits: sum("credit"),
          debits: sum("debit"),
          closingBalance: rows.length ? rows[rows.length - 1]!.balance : opening,
        },
      });
    }
  );

  app.post(
    "/api/v1/suppliers/:id/ledger-entries",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({
        entryDate: isoDate,
        kind: z.enum(["payment", "opening", "debit_note", "credit_note"]),
        amount: z.number().positive().max(1e9),
        mode: z.enum(["neft", "rtgs", "imps", "upi", "cheque", "cash"]).optional().nullable(),
        reference: z.string().trim().max(100).optional().nullable(),
        notes: z.string().trim().max(500).optional().nullable(),
      }).parse(request.body);
      if (body.entryDate > istToday()) {
        return reply.status(400).send({ error: "Validation Error", message: "The date can't be in the future." });
      }
      if (body.kind === "payment" && !body.mode) {
        return reply.status(400).send({ error: "Validation Error", message: "Pick how the payment was made." });
      }
      if ((body.kind === "debit_note" || body.kind === "credit_note") && !(body.notes && body.notes.length >= 3)) {
        return reply.status(400).send({ error: "Validation Error", message: "Say what the note is for." });
      }
      const [s] = await pgClient`SELECT id FROM suppliers WHERE id = ${id}::uuid AND deleted_at IS NULL` as any[];
      if (!s) return reply.status(404).send({ error: "Supplier not found" });

      const [row] = await pgClient`
        INSERT INTO supplier_ledger_entries (supplier_id, entry_date, kind, amount, mode, reference, notes, created_by)
        VALUES (${id}::uuid, ${body.entryDate}::date, ${body.kind}, ${body.amount.toFixed(2)}::numeric,
                ${body.kind === "payment" ? body.mode ?? null : null}, ${body.reference || null}, ${body.notes || null},
                ${request.admin!.userId}::uuid)
        RETURNING id
      ` as any[];
      return reply.status(201).send({ id: row.id, message: `${KIND_LABEL[body.kind]} of ₹${body.amount.toFixed(2)} saved` });
    }
  );

  app.post(
    "/api/v1/supplier-ledger-entries/:id/cancel",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const { reason } = z.object({ reason: z.string().trim().min(5, "Say why (at least 5 characters)").max(300) }).parse(request.body);
      const res = await pgClient`
        UPDATE supplier_ledger_entries
           SET cancelled_at = now(), cancelled_by = ${request.admin!.userId}::uuid, cancel_reason = ${reason}
         WHERE id = ${id}::uuid AND cancelled_at IS NULL
      `;
      if (res.count === 0) return reply.status(404).send({ error: "Entry not found or already cancelled" });
      return reply.send({ message: "Entry cancelled" });
    }
  );
}
