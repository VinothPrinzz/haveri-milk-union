// apps/api/src/routes/finance-leakage-incentive.ts
// ═══════════════════════════════════════════════════════════════════════
// Finance → Milk Leakage Incentive
//
//   GET  /api/v1/finance/leakage-incentive/settings      — rule + milk SKU picker
//   PUT  /api/v1/finance/leakage-incentive/settings      — save the rule
//   GET  /api/v1/finance/leakage-incentive/report        — taluk-wise statement
//   GET  /api/v1/finance/leakage-incentive/runs          — posted / reversed runs
//   POST /api/v1/finance/leakage-incentive/runs          — post credit notes
//   POST /api/v1/finance/leakage-incentive/runs/:id/reverse
//
// The rule, per agent, for the period:
//
//   milk litres       = Σ packets × litres per packet, over the milk SKUs
//   incentive litres  = milk litres × litresPer1000 / 1000      (1.5 / 1000)
//   incentive ₹       = incentive litres × ratePerLitre         (₹44.65)
//
// The ₹ amount is rounded once, at the end, from the unrounded litres —
// the same as the union's Excel sheet (1797 L → 2.6955 L → ₹120.35).
//
// Sales are counted exactly like Agent Wise Taluka Sales: confirmed /
// dispatched / delivered orders by delivery date plus agent gate passes,
// DEMO route excluded, taluk = the agent's CURRENT zone.
//
// Posting a run issues one Credit Note (reason 'leakage_incentive') per agent
// with a non-zero amount, all in one transaction. A posted run locks its
// period (EXCLUDE constraint, 0078); reversing the run reverses every credit
// note in it and frees the period for a corrected run.
//
// GETs require finance.view; mutations require finance.manage.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { adminAuth, requireRole } from "../middleware/admin-auth.js";
import { isoDate, istToday } from "../lib/ist-date.js";
import {
  postLedgerAdjustment, reverseLedgerAdjustment, nextVoucherSeq, formatVoucherNo,
} from "../lib/ledger-adjustments.js";
import { toKgLtr } from "./sales-reports.js";

type Sql = typeof pgClient;

function adminUserId(request: FastifyRequest): string {
  const a = (request as unknown as { admin?: { userId: string } }).admin;
  if (!a?.userId) throw new Error("adminAuth middleware not set");
  return a.userId;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
const fmtDMY = (iso: string) => iso.split("-").reverse().join("-");

// ── Rule (system_settings, category 'finance') ──────────────────────────
interface Rule {
  litresPer1000: number;
  ratePerLitre: number;
  productCodes: string[];
}
const KEY = {
  litresPer1000: "leakage_incentive_litres_per_1000",
  ratePerLitre:  "leakage_incentive_rate_per_litre",
  productCodes:  "leakage_incentive_product_codes",
} as const;

async function loadRule(sql: Sql): Promise<Rule> {
  const rows = await sql`
    SELECT key, value FROM system_settings
     WHERE category = 'finance' AND key LIKE 'leakage_incentive_%'
  `;
  const map = new Map((rows as any[]).map(r => [r.key, r.value]));
  let codes: string[] = [];
  try {
    const v = JSON.parse(map.get(KEY.productCodes) ?? "[]");
    if (Array.isArray(v)) codes = v.map(String);
  } catch { /* fall through to [] */ }
  return {
    litresPer1000: Number(map.get(KEY.litresPer1000) ?? 1.5) || 1.5,
    ratePerLitre:  Number(map.get(KEY.ratePerLitre) ?? 0) || 0,
    productCodes:  codes,
  };
}

// ── Computation ─────────────────────────────────────────────────────────
interface Line {
  dealerId: string;
  code: string;
  name: string;
  taluka: string;
  milkLitres: number;       // 3 dp
  incentiveLitres: number;  // 3 dp
  amount: number;           // ₹, 2 dp
}

async function computeLines(sql: Sql, from: string, to: string, rule: Rule) {
  // Comma-joined, not a bound JS array (see the Bind crashes fixed in orders).
  const codesCsv = rule.productCodes.join(",");
  const products = codesCsv
    ? await sql`
        SELECT id, code, name, COALESCE(report_alias, name) AS label,
               COALESCE(pack_size, 0)::numeric AS pack_size, unit
          FROM products
         WHERE code = ANY(string_to_array(${codesCsv}, ','))
      `
    : [];
  const litresPerPacket = new Map<string, number>(
    (products as any[]).map(p => [p.id, toKgLtr(1, parseFloat(p.pack_size) || 0, p.unit ?? "")]),
  );
  const idsCsv = (products as any[]).map(p => p.id).join(",");

  // One row per (agent, milk product), plus one row per agent with
  // product_id NULL for everything else — so agents who bought only curd
  // etc. still appear with 0 milk, as on the union's sheet.
  const rows = await sql`
    WITH combined AS (
      SELECT o.dealer_id, oi.product_id, oi.quantity::numeric AS qty
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.delivery_date >= ${from}::date
        AND o.delivery_date <= ${to}::date
        AND o.created_at >= ${from}::date - interval '31 days'
        AND o.created_at <  ${to}::date + interval '2 days'
        AND o.status IN ('confirmed', 'dispatched', 'delivered')
        AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO'
                         AND dr.id = COALESCE(o.route_id,
                               (SELECT dd.route_id FROM dealers dd WHERE dd.id = o.dealer_id)))
      UNION ALL
      SELECT ds.customer_id, dsi.product_id, dsi.quantity::numeric
      FROM direct_sales ds
      JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
      WHERE ds.customer_type = 'agent'
        AND ds.sale_date >= ${from}::date
        AND ds.sale_date <= ${to}::date
        AND ds.status = 'confirmed'
        AND NOT EXISTS (SELECT 1 FROM routes dr WHERE dr.code = 'DEMO' AND dr.id = ds.route_id)
    ),
    tagged AS (
      SELECT dealer_id,
             CASE WHEN product_id::text = ANY(string_to_array(${idsCsv}, ','))
                  THEN product_id END AS milk_product_id,
             qty
      FROM combined
    )
    SELECT d.id AS dealer_id, d.code, d.name, COALESCE(z.name, '') AS taluka,
           t.milk_product_id, SUM(t.qty)::numeric AS qty
    FROM tagged t
    JOIN dealers d ON d.id = t.dealer_id
    LEFT JOIN zones z ON z.id = d.zone_id
    GROUP BY d.id, d.code, d.name, z.name, t.milk_product_id
  `;

  const byDealer = new Map<string, { code: string; name: string; taluka: string; litres: number }>();
  for (const r of rows as any[]) {
    const cur = byDealer.get(r.dealer_id)
      ?? { code: r.code ?? "", name: r.name, taluka: r.taluka || "Unassigned", litres: 0 };
    if (r.milk_product_id) {
      cur.litres += (parseFloat(r.qty) || 0) * (litresPerPacket.get(r.milk_product_id) ?? 0);
    }
    byDealer.set(r.dealer_id, cur);
  }

  const lines: Line[] = Array.from(byDealer.entries()).map(([dealerId, d]) => {
    const incentive = d.litres * rule.litresPer1000 / 1000;
    return {
      dealerId,
      code: d.code,
      name: d.name,
      taluka: d.taluka,
      milkLitres: round3(d.litres),
      incentiveLitres: round3(incentive),
      amount: round2(incentive * rule.ratePerLitre),
    };
  });

  return {
    lines,
    products: (products as any[])
      .map(p => ({ code: p.code as string, name: p.label as string }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** Group into taluks (by name), agents by code within each — the sheet's layout. */
function groupByTaluka<T extends { taluka: string; code: string; name: string; milkLitres: number; incentiveLitres: number; amount: number }>(
  lines: T[], litresPer1000: number,
) {
  const map = new Map<string, T[]>();
  for (const l of lines) {
    if (!map.has(l.taluka)) map.set(l.taluka, []);
    map.get(l.taluka)!.push(l);
  }
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const talukas = Array.from(map.entries())
    .sort(([a], [b]) => cmp(a, b))
    .map(([name, rows]) => {
      rows.sort((a, b) => cmp(a.code, b.code) || cmp(a.name, b.name));
      const milk = rows.reduce((s, r) => s + r.milkLitres, 0);
      return {
        name,
        rows: rows.map((r, i) => ({ sl: i + 1, ...r })),
        totals: {
          milkLitres: round3(milk),
          incentiveLitres: round3(milk * litresPer1000 / 1000),
          amount: round2(rows.reduce((s, r) => s + r.amount, 0)),
        },
      };
    });
  const milk = lines.reduce((s, r) => s + r.milkLitres, 0);
  return {
    talukas,
    totals: {
      milkLitres: round3(milk),
      incentiveLitres: round3(milk * litresPer1000 / 1000),
      amount: round2(lines.reduce((s, r) => s + r.amount, 0)),
      dealerCount: lines.filter(l => l.amount > 0).length,
    },
  };
}

async function postedRunsOverlapping(sql: Sql, from: string, to: string) {
  return await sql`
    SELECT r.id, r.period_from::text AS "periodFrom", r.period_to::text AS "periodTo",
           r.voucher_date::text AS "voucherDate", r.status,
           r.litres_per_1000::float8 AS "litresPer1000",
           r.rate_per_litre::float8 AS "ratePerLitre",
           array_to_string(r.product_codes, ',') AS "productCodesCsv",
           r.dealer_count AS "dealerCount",
           r.total_amount::float8 AS "totalAmount",
           r.created_at AS "createdAt", u.name AS "createdByName"
      FROM leakage_incentive_runs r
      LEFT JOIN users u ON u.id = r.created_by
     WHERE r.status = 'posted'
       AND daterange(r.period_from, r.period_to, '[]')
           && daterange(${from}::date, ${to}::date, '[]')
     ORDER BY r.period_from
  `;
}

const rangeSchema = z.object({ from: isoDate, to: isoDate })
  .refine(q => q.from <= q.to, { message: "'from' must be on or before 'to'" });

export async function financeLeakageIncentiveRoutes(app: FastifyInstance) {
  // ── GET settings ──
  app.get(
    "/api/v1/finance/leakage-incentive/settings",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (_request, reply) => {
      const rule = await loadRule(pgClient);
      const codesCsv = rule.productCodes.join(",");
      // Picker: every live Milk-category product, plus anything already
      // selected (even if it has since moved category or been deleted).
      const products = await pgClient`
        SELECT p.code, p.name, COALESCE(p.pack_size, 0)::float8 AS "packSize", p.unit,
               (p.code = ANY(string_to_array(${codesCsv}, ','))) AS selected
          FROM products p
          LEFT JOIN categories c ON c.id = p.category_id
         WHERE p.code IS NOT NULL
           AND ((p.deleted_at IS NULL AND lower(c.name) = 'milk')
                OR p.code = ANY(string_to_array(${codesCsv}, ',')))
         ORDER BY selected DESC, p.name
      `;
      return reply.send({ ...rule, products });
    }
  );

  // ── PUT settings ──
  app.put(
    "/api/v1/finance/leakage-incentive/settings",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const body = z.object({
        litresPer1000: z.number().positive().max(1000),
        ratePerLitre:  z.number().positive().max(100000),
        productCodes:  z.array(z.string().min(1)).min(1, "Pick at least one milk product"),
      }).parse(request.body);
      const userId = adminUserId(request);
      const values: [string, string][] = [
        [KEY.litresPer1000, String(body.litresPer1000)],
        [KEY.ratePerLitre,  body.ratePerLitre.toFixed(2)],
        [KEY.productCodes,  JSON.stringify(Array.from(new Set(body.productCodes)))],
      ];
      await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as Sql;
        for (const [key, value] of values) {
          await tx`
            INSERT INTO system_settings (category, key, value, updated_by)
            VALUES ('finance', ${key}, ${value}, ${userId}::uuid)
            ON CONFLICT (category, key) DO UPDATE
              SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()
          `;
        }
      });
      return reply.send({ message: "Leakage incentive rule saved", ...(await loadRule(pgClient)) });
    }
  );

  // ── GET report ──
  // If a posted run covers EXACTLY this period, the statement is that run's
  // stored lines (what was actually credited, with voucher numbers) and
  // liveAmount shows whether today's figures have drifted since. Otherwise
  // it is computed live from the saved rule.
  app.get(
    "/api/v1/finance/leakage-incentive/report",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (request, reply) => {
      const q = rangeSchema.parse(request.query);
      const overlapping = await postedRunsOverlapping(pgClient, q.from, q.to) as any[];
      const exact = overlapping.find(r => r.periodFrom === q.from && r.periodTo === q.to) ?? null;

      if (exact) {
        const rule: Rule = {
          litresPer1000: exact.litresPer1000,
          ratePerLitre: exact.ratePerLitre,
          productCodes: exact.productCodesCsv ? String(exact.productCodesCsv).split(",") : [],
        };
        const stored = await pgClient`
          SELECT l.dealer_id AS "dealerId", COALESCE(d.code, '') AS code, d.name,
                 COALESCE(l.taluka, '') AS taluka,
                 l.milk_litres::float8 AS "milkLitres",
                 l.incentive_litres::float8 AS "incentiveLitres",
                 l.amount::float8 AS amount,
                 l.adjustment_id AS "adjustmentId",
                 dl.voucher_no AS "voucherNo",
                 EXISTS (SELECT 1 FROM ledger_adjustments ra
                          WHERE ra.reverses_ledger_entry_id = l.ledger_entry_id) AS reversed
            FROM leakage_incentive_lines l
            JOIN dealers d ON d.id = l.dealer_id
            LEFT JOIN dealer_ledger dl ON dl.id = l.ledger_entry_id
           WHERE l.run_id = ${exact.id}::uuid
        `;
        const live = await computeLines(pgClient, q.from, q.to, rule);
        const { products } = live;
        const grouped = groupByTaluka(
          (stored as any[]).map(s => ({ ...s, taluka: s.taluka || "Unassigned" })),
          rule.litresPer1000,
        );
        const { productCodesCsv: _drop, ...run } = exact;
        return reply.send({
          from: q.from, to: q.to,
          source: "posted",
          rule: { ...rule, products },
          ...grouped,
          run,
          overlappingRuns: [],
          liveAmount: round2(live.lines.reduce((s, l) => s + l.amount, 0)),
        });
      }

      const rule = await loadRule(pgClient);
      const { lines, products } = await computeLines(pgClient, q.from, q.to, rule);
      return reply.send({
        from: q.from, to: q.to,
        source: "live",
        rule: { ...rule, products },
        ...groupByTaluka(lines, rule.litresPer1000),
        run: null,
        overlappingRuns: overlapping.map(({ productCodesCsv: _drop, ...r }) => r),
        liveAmount: null,
      });
    }
  );

  // ── GET runs ──
  app.get(
    "/api/v1/finance/leakage-incentive/runs",
    { preHandler: [adminAuth, requireRole("finance.view")] },
    async (_request, reply) => {
      const runs = await pgClient`
        SELECT r.id, r.period_from::text AS "periodFrom", r.period_to::text AS "periodTo",
               r.voucher_date::text AS "voucherDate", r.status,
               r.litres_per_1000::float8 AS "litresPer1000",
               r.rate_per_litre::float8 AS "ratePerLitre",
               r.dealer_count AS "dealerCount",
               r.total_milk_litres::float8 AS "totalMilkLitres",
               r.total_amount::float8 AS "totalAmount",
               r.created_at AS "createdAt", cu.name AS "createdByName",
               r.reversed_at AS "reversedAt", ru.name AS "reversedByName",
               r.reverse_reason AS "reverseReason"
          FROM leakage_incentive_runs r
          LEFT JOIN users cu ON cu.id = r.created_by
          LEFT JOIN users ru ON ru.id = r.reversed_by
         ORDER BY r.created_at DESC
         LIMIT 100
      `;
      return reply.send({ data: runs });
    }
  );

  // ── POST runs — compute + issue one credit note per agent ──
  app.post(
    "/api/v1/finance/leakage-incentive/runs",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const body = z.object({
        from: isoDate,
        to: isoDate,
        voucherDate: isoDate.optional(),
        // The total the user saw on screen. If sales or the rule changed
        // since the preview, refuse rather than credit a different sum.
        expectedAmount: z.number().nonnegative(),
      }).refine(b => b.from <= b.to, { message: "'from' must be on or before 'to'" })
        .parse(request.body);

      const today = istToday();
      if (body.to > today) {
        return reply.status(400).send({
          error: "Period not finished",
          message: `The period runs to ${fmtDMY(body.to)}; credit notes can be posted once it is over.`,
        });
      }
      const voucherDate = body.voucherDate ?? today;
      const userId = adminUserId(request);

      try {
        const result = await pgClient.begin(async (_tx) => {
          const tx = _tx as unknown as Sql;
          // One run at a time — also serialises the CN number block below.
          await tx`SELECT pg_advisory_xact_lock(hashtext('leakage_incentive_run'))`;

          const clash = await postedRunsOverlapping(tx, body.from, body.to) as any[];
          if (clash.length) {
            const c = clash[0];
            throw Object.assign(new Error("overlap"), {
              status: 409,
              payload: {
                error: "Already credited",
                message: `Leakage incentive for ${fmtDMY(c.periodFrom)} to ${fmtDMY(c.periodTo)} is already posted. Reverse that run first to post this period again.`,
              },
            });
          }

          const rule = await loadRule(tx);
          if (!(rule.ratePerLitre > 0) || rule.productCodes.length === 0) {
            throw Object.assign(new Error("rule"), {
              status: 400,
              payload: { error: "Rule not set", message: "Set the rate per litre and the milk products first." },
            });
          }
          const { lines } = await computeLines(tx, body.from, body.to, rule);
          const payable = lines.filter(l => l.amount > 0);
          const total = round2(payable.reduce((s, l) => s + l.amount, 0));
          if (Math.abs(total - body.expectedAmount) > 0.005) {
            throw Object.assign(new Error("drift"), {
              status: 409,
              payload: {
                error: "Figures changed",
                message: `Sales or the rule changed since this statement was generated (now ₹${total.toFixed(2)}, was ₹${body.expectedAmount.toFixed(2)}). Generate it again and re-check before posting.`,
              },
            });
          }
          if (payable.length === 0) {
            throw Object.assign(new Error("empty"), {
              status: 400,
              payload: { error: "Nothing to credit", message: "No agent has a leakage incentive for this period." },
            });
          }

          const milkTotal = lines.reduce((s, l) => s + l.milkLitres, 0);
          const [run] = await tx`
            INSERT INTO leakage_incentive_runs (
              period_from, period_to, litres_per_1000, rate_per_litre, product_codes,
              voucher_date, dealer_count, total_milk_litres, total_incentive_litres,
              total_amount, created_by
            ) VALUES (
              ${body.from}::date, ${body.to}::date,
              ${String(rule.litresPer1000)}::numeric, ${rule.ratePerLitre.toFixed(2)}::numeric,
              string_to_array(${rule.productCodes.join(",")}, ','),
              ${voucherDate}::date, ${payable.length},
              ${round3(milkTotal).toFixed(3)}::numeric,
              ${round3(milkTotal * rule.litresPer1000 / 1000).toFixed(3)}::numeric,
              ${total.toFixed(2)}::numeric, ${userId}::uuid
            )
            RETURNING id
          `;
          const runId = (run as any).id as string;

          // Number the whole batch from one lookup: CN-<date>-NNN, NNN+1, …
          // in statement order (taluk, then agent code), so the printed
          // sheet and the voucher numbers run together.
          let seq = await nextVoucherSeq(tx, "Credit Note", voucherDate);
          const period = `${fmtDMY(body.from)} to ${fmtDMY(body.to)}`;
          const ordered = groupByTaluka(lines, rule.litresPer1000).talukas.flatMap(t => t.rows);
          for (const l of ordered) {
            let ledgerEntryId: string | null = null;
            let adjustmentId: string | null = null;
            if (l.amount > 0) {
              const r = await postLedgerAdjustment(tx, {
                dealerId: l.dealerId,
                voucherType: "Credit Note",
                reason: "leakage_incentive",
                reasonText:
                  `Milk leakage incentive ${period}: ${l.milkLitres.toFixed(2)} L milk @ ` +
                  `${rule.litresPer1000} L/1000 L = ${l.incentiveLitres.toFixed(2)} L × ₹${rule.ratePerLitre.toFixed(2)}`,
                amount: l.amount,
                voucherDate,
                voucherNo: formatVoucherNo("Credit Note", voucherDate, seq++),
                userId,
              });
              ledgerEntryId = r.ledgerEntryId;
              adjustmentId = r.adjustmentId;
            }
            await tx`
              INSERT INTO leakage_incentive_lines (
                run_id, dealer_id, taluka, milk_litres, incentive_litres, amount,
                ledger_entry_id, adjustment_id
              ) VALUES (
                ${runId}::uuid, ${l.dealerId}::uuid, ${l.taluka},
                ${l.milkLitres.toFixed(3)}::numeric, ${l.incentiveLitres.toFixed(3)}::numeric,
                ${l.amount.toFixed(2)}::numeric,
                ${ledgerEntryId}::uuid, ${adjustmentId}::uuid
              )
            `;
          }
          return { runId, dealerCount: payable.length, totalAmount: total };
        });

        return reply.status(201).send({
          message: `Posted ${result.dealerCount} credit notes for ₹${result.totalAmount.toFixed(2)}`,
          ...result,
        });
      } catch (e: any) {
        if (e?.payload) return reply.status(e.status).send(e.payload);
        if (e?.code === "23P01") {
          return reply.status(409).send({
            error: "Already credited",
            message: "Another run already covers part of this period.",
          });
        }
        throw e;
      }
    }
  );

  // ── POST runs/:id/reverse — reverse every credit note in the run ──
  app.post(
    "/api/v1/finance/leakage-incentive/runs/:id/reverse",
    { preHandler: [adminAuth, requireRole("finance.manage")] },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const body = z.object({ reasonText: z.string().min(5, "Reason text is required") }).parse(request.body);
      const userId = adminUserId(request);

      return await pgClient.begin(async (_tx) => {
        const tx = _tx as unknown as Sql;
        const [run] = await tx`
          SELECT id, status FROM leakage_incentive_runs WHERE id = ${id}::uuid FOR UPDATE
        `;
        if (!run) return reply.status(404).send({ error: "Run not found" });
        if ((run as any).status !== "posted") {
          return reply.status(400).send({ error: "Already reversed", message: "This run has already been reversed." });
        }

        // Skip credit notes someone already reversed one by one on
        // Finance → Credit/Debit Notes.
        const open = await tx`
          SELECT l.adjustment_id
            FROM leakage_incentive_lines l
           WHERE l.run_id = ${id}::uuid
             AND l.adjustment_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ledger_adjustments ra
                              WHERE ra.reverses_ledger_entry_id = l.ledger_entry_id)
        `;
        for (const o of open as any[]) {
          await reverseLedgerAdjustment(tx, {
            adjustmentId: o.adjustment_id,
            reasonText: `Leakage incentive run reversed: ${body.reasonText}`,
            userId,
          });
        }
        await tx`
          UPDATE leakage_incentive_runs
             SET status = 'reversed', reversed_by = ${userId}::uuid,
                 reversed_at = now(), reverse_reason = ${body.reasonText}
           WHERE id = ${id}::uuid
        `;
        return reply.send({ message: `Reversed ${open.length} credit notes`, reversedCount: open.length });
      });
    }
  );
}
