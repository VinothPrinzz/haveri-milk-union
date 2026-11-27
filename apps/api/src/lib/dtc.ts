// apps/api/src/lib/dtc.ts
// ═══════════════════════════════════════════════════════════════════════
// DTC Billing — calculations and bill generation.
//
// A month's bill for a route:
//
//   gross            = Σ over the terms in force during the month:
//                        KM     days × km per day × rate per km
//                        Trip   days × rate per trip
//                        Litre  litres/kg carried × rate per litre
//   total earnings   = gross + other earnings (extra km, …)
//   total deductions = crate + packet + short supply + short km + dues + security deposit
//                      + GPS + penalty + advance + carry forward + TDS + others
//   net              = total earnings − total deductions
//   payable          = max(net, 0); a negative net is carried forward and
//                      recovered from the contractor's next bill
//   cost per litre   = total earnings (or gross, per setting) ÷ litres/kg
//
// Gross, total earnings and total deductions are rounded to the rupee, the
// line amounts keep paise — exactly as the union's Consolidated DTC Bill
// (Athani: 31 × 300 × 12.79 = 1,18,947; 247 km short × 12.79 = 3,159.13 →
// deduction 3,159; net 1,15,788).
//
// "Days" are the dates the route actually ran: a sale delivered on the route
// (orders, gate passes / direct sales, employee orders) or a dispatch marked
// dispatched / delivered. The clerk can override the count per segment.
//
// A rate revision in the middle of the month splits the bill into segments,
// one per terms version, each with its own days, litres and amount.
// ═══════════════════════════════════════════════════════════════════════

import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "./db.js";
import { entryLine, loadEntryLineRows } from "./dtc-officer-entries.js";

export type Sql = typeof pgClient;

/** The signed-in admin (set by adminAuth). */
export function requestAdmin(request: FastifyRequest): { userId: string; role: string } {
  const a = (request as unknown as { admin?: { userId: string; role: string } }).admin;
  if (!a?.userId) throw new Error("adminAuth middleware not set");
  return a;
}

/** 'YYYY-MM' */
export const monthParam = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "expected YYYY-MM");

/** Throw from inside a transaction to answer with an HTTP error. */
export class HttpError extends Error {
  constructor(public status: number, public title: string, message: string) { super(message); }
}
export type BillingType = "km" | "trip" | "litre";
export type CostBasis = "total_earnings" | "gross";

export const EARNING_HEADS = ["extra_km", "extra_trip", "extra_litre", "other_earning"] as const;
export const DEDUCTION_HEADS = [
  "crate", "packet", "short_supply", "km", "dues", "security_deposit", "gps",
  "penalty", "advance", "carry_forward", "tds", "other_deduction",
] as const;
export const HEAD_LABELS: Record<string, string> = {
  extra_km: "Extra km", extra_trip: "Extra trips", extra_litre: "Extra litres", other_earning: "Other earning",
  crate: "Crate shortage", packet: "Packet / product shortage", short_supply: "Short supply", km: "Short km", dues: "Dues",
  security_deposit: "Security deposit", gps: "GPS", penalty: "Penalty", advance: "Advance recovery",
  carry_forward: "Previous balance recovery", tds: "TDS", other_deduction: "Other deduction",
};
export type EarningHead = (typeof EARNING_HEADS)[number];
export type DeductionHead = (typeof DEDUCTION_HEADS)[number];
export type LineHead = EarningHead | DeductionHead;

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
export const round3 = (n: number) => Math.round((n + Number.EPSILON) * 1000) / 1000;
/** Nearest rupee, half up (amounts here are never negative before netting). */
export const roundRupee = (n: number) => Math.round(round2(n));

// ── Months ──────────────────────────────────────────────────────────────
/** 'YYYY-MM…' → [year, month]. */
function ym(iso: string): [number, number] {
  const [y = 0, m = 1] = iso.split("-").map(Number);
  return [y, m];
}
/** 'YYYY-MM' or 'YYYY-MM-DD' → first and last day of that month. */
export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = ym(month);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const mm = String(m).padStart(2, "0");
  return { start: `${y}-${mm}-01`, end: `${y}-${mm}-${String(last).padStart(2, "0")}` };
}
export function addDays(iso: string, n: number): string {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function previousMonthStart(monthStart: string): string {
  const [y, m] = ym(monthStart);
  return m === 1 ? `${y - 1}-12-01` : `${y}-${String(m - 1).padStart(2, "0")}-01`;
}
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function monthLabel(monthStart: string): string {
  const [y, m] = ym(monthStart);
  return `${MONTHS[m - 1]} ${y}`;
}
/** Indian financial year of a date, e.g. 2026-07-01 → '2026-27'. */
export function financialYear(iso: string): string {
  const [y, m] = ym(iso);
  const start = m >= 4 ? y : y - 1;
  return `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
}

// ── Segments and totals (pure) ──────────────────────────────────────────
export interface Segment {
  key: string;            // `${termsId}:${from}` — stable across regenerations
  termsId: string;
  from: string;
  to: string;
  billingType: BillingType;
  rate: number;
  kmPerDay: number;
  autoDays: number;
  daysOverride: number | null;
  qty: number;            // litres/kg carried in this segment
  amount: number;         // ₹, 2 dp
}

export const segmentDays = (s: Pick<Segment, "autoDays" | "daysOverride">) =>
  s.daysOverride ?? s.autoDays;

export function segmentAmount(s: Pick<Segment, "billingType" | "rate" | "kmPerDay" | "qty" | "autoDays" | "daysOverride">): number {
  const days = segmentDays(s);
  switch (s.billingType) {
    case "km":    return round2(days * s.kmPerDay * s.rate);
    case "trip":  return round2(days * s.rate);
    case "litre": return round2(s.qty * s.rate);
  }
}

export interface LineLike { kind: "earning" | "deduction"; head: string; amount: number }

export interface BillTotals {
  days: number;
  qty: number;
  gross: number;
  otherEarnings: number;
  totalEarnings: number;
  totalDeductions: number;
  net: number;
  payable: number;
  carryForward: number;
  costPerLitre: number;
}

export function billTotals(segments: Segment[], lines: LineLike[], costBasis: CostBasis): BillTotals {
  const gross = roundRupee(segments.reduce((s, x) => s + segmentAmount(x), 0));
  const otherEarnings = round2(lines.filter(l => l.kind === "earning").reduce((s, l) => s + l.amount, 0));
  const totalEarnings = roundRupee(gross + otherEarnings);
  const totalDeductions = roundRupee(lines.filter(l => l.kind === "deduction").reduce((s, l) => s + l.amount, 0));
  const net = totalEarnings - totalDeductions;
  const qty = round3(segments.reduce((s, x) => s + x.qty, 0));
  const basis = costBasis === "gross" ? gross : totalEarnings;
  return {
    days: segments.reduce((s, x) => s + segmentDays(x), 0),
    qty,
    gross,
    otherEarnings,
    totalEarnings,
    totalDeductions,
    net,
    payable: Math.max(net, 0),
    carryForward: Math.max(-net, 0),
    costPerLitre: qty > 0 ? round2(basis / qty) : 0,
  };
}

/**
 * TDS rate (%) under section 194C for a transport contractor, or 0.
 * No TDS when the contractor has a PAN and a "not more than 10 goods
 * carriages" declaration for the bill's financial year. Without a PAN, 20%.
 */
export function tdsPercent(c: { pan: string | null; entityType: string | null; declarationFy: string | null }, fy: string): number {
  const pan = (c.pan ?? "").trim();
  if (!pan) return 20;
  if ((c.declarationFy ?? "").trim() === fy) return 0;
  return c.entityType === "other" ? 2 : 1;
}

// ── Terms → segments ────────────────────────────────────────────────────
export interface TermsRow {
  id: string;
  route_id: string;
  effective_from: string;
  active: boolean;
  billing_type: BillingType;
  rate: number;
  km_per_day: number;
  vehicle_capacity_mt: number | null;
  vehicle_number: string | null;
  cash_collection: boolean;
}

/**
 * The terms versions in force during [start, end], as date ranges. `versions`
 * must be one route's rows with effective_from <= end, sorted ascending.
 * Inactive versions end the previous range and produce none of their own.
 */
export function termsRanges(versions: TermsRow[], start: string, end: string) {
  // The version in force on the 1st (if any), then every revision inside the month.
  const onFirst = versions.filter(v => v.effective_from <= start).pop();
  const chain = [
    ...(onFirst ? [onFirst] : []),
    ...versions.filter(v => v.effective_from > start && v.effective_from <= end),
  ];
  const ranges: { terms: TermsRow; from: string; to: string }[] = [];
  chain.forEach((v, i) => {
    const from = v.effective_from > start ? v.effective_from : start;
    const next = chain[i + 1];
    const to = next ? addDays(next.effective_from, -1) : end;
    if (v.active && from <= to) ranges.push({ terms: v, from, to });
  });
  return ranges;
}

// ── Data loaders ────────────────────────────────────────────────────────

/** Per route, per date: litres/kg carried. Same route attribution as Day/Route Wise Cash. */
export async function loadRouteDailyQty(sql: Sql, from: string, to: string) {
  // Litres per packet = pack_size, or pack_size / 1000 when the unit is ml / g
  // (the same rule as toKgLtr in routes/sales-reports.ts).
  const rows = await sql`
    WITH combined AS (
      SELECT o.delivery_date AS d, COALESCE(o.route_id, dl.route_id) AS route_id,
             oi.product_id, oi.quantity::numeric AS qty
        FROM orders o
        JOIN dealers dl ON dl.id = o.dealer_id
        JOIN order_items oi ON oi.order_id = o.id
       WHERE o.delivery_date >= ${from}::date AND o.delivery_date <= ${to}::date
         AND o.created_at >= ${from}::date - interval '31 days'
         AND o.created_at <  ${to}::date + interval '2 days'
         AND o.status IN ('confirmed', 'dispatched', 'delivered')
      UNION ALL
      SELECT ds.sale_date, ds.route_id, dsi.product_id, dsi.quantity::numeric
        FROM direct_sales ds
        JOIN direct_sale_items dsi ON dsi.direct_sale_id = ds.id
       WHERE ds.sale_date >= ${from}::date AND ds.sale_date <= ${to}::date
         AND ds.status = 'confirmed' AND ds.route_id IS NOT NULL
      UNION ALL
      SELECT eo.delivery_date, eo.route_id, eoi.product_id, eoi.quantity::numeric
        FROM employee_orders eo
        JOIN employee_order_items eoi ON eoi.employee_order_id = eo.id
       WHERE eo.delivery_date >= ${from}::date AND eo.delivery_date <= ${to}::date
         AND eo.status IN ('confirmed', 'dispatched', 'delivered') AND eo.route_id IS NOT NULL
    )
    SELECT c.route_id, to_char(c.d, 'YYYY-MM-DD') AS date,
           SUM(c.qty * CASE
                 WHEN lower(trim(COALESCE(p.unit, ''))) IN ('ml', 'g', 'gm', 'gram', 'grams')
                   THEN COALESCE(p.pack_size, 0) / 1000
                 ELSE COALESCE(p.pack_size, 0) END)::float8 AS litres
      FROM combined c
      JOIN products p ON p.id = c.product_id
     WHERE c.route_id IS NOT NULL
     GROUP BY c.route_id, c.d
  `;
  const map = new Map<string, Map<string, number>>();
  for (const r of rows as any[]) {
    if (!map.has(r.route_id)) map.set(r.route_id, new Map());
    map.get(r.route_id)!.set(r.date, Number(r.litres) || 0);
  }
  return map;
}

/** Per route: dates a dispatch run was marked dispatched / delivered. */
export async function loadDispatchDates(sql: Sql, from: string, to: string) {
  const rows = await sql`
    SELECT route_id, to_char(date, 'YYYY-MM-DD') AS date
      FROM route_assignments
     WHERE date >= ${from}::date AND date <= ${to}::date
       AND status IN ('dispatched', 'delivered')
  `;
  const map = new Map<string, Set<string>>();
  for (const r of rows as any[]) {
    if (!map.has(r.route_id)) map.set(r.route_id, new Set());
    map.get(r.route_id)!.add(r.date);
  }
  return map;
}

/** Dates in [from, to] the route ran: sold something or was dispatched. */
export function runDates(
  routeId: string, from: string, to: string,
  qty: Map<string, Map<string, number>>, dispatch: Map<string, Set<string>>,
): string[] {
  const out = new Set<string>();
  for (const [d, l] of qty.get(routeId) ?? []) if (d >= from && d <= to && l > 0) out.add(d);
  for (const d of dispatch.get(routeId) ?? []) if (d >= from && d <= to) out.add(d);
  return Array.from(out).sort();
}

export async function loadDtcSettings(sql: Sql) {
  const rows = await sql`SELECT key, value FROM system_settings WHERE category = 'dtc'`;
  const map = new Map((rows as any[]).map(r => [r.key as string, r.value as string]));
  let signatures: string[] = [];
  try {
    const v = JSON.parse(map.get("signatures") ?? "[]");
    if (Array.isArray(v)) signatures = v.map(String);
  } catch { /* keep [] */ }
  return {
    costPerLitreBasis: (map.get("cost_per_litre_basis") === "gross" ? "gross" : "total_earnings") as CostBasis,
    tdsEnabled: map.get("tds_enabled") === "true",
    signatures,
  };
}

/** Crate shortage rate in force on `date` (0 if none set). */
export async function crateRateOn(sql: Sql, date: string): Promise<number> {
  const [r] = await sql`
    SELECT rate::float8 AS rate FROM dtc_crate_rates
     WHERE effective_from <= ${date}::date ORDER BY effective_from DESC LIMIT 1
  `;
  return Number((r as any)?.rate ?? 0);
}

export async function logEvent(
  sql: Sql, e: { runId?: string | null; billId?: string | null; action: string; detail?: string | null; userId: string | null },
) {
  await sql`
    INSERT INTO dtc_events (run_id, bill_id, action, detail, user_id)
    VALUES (${e.runId ?? null}::uuid, ${e.billId ?? null}::uuid, ${e.action}, ${e.detail ?? null}, ${e.userId}::uuid)
  `;
}

// ── Recompute one bill (totals + TDS line) ──────────────────────────────
export async function recomputeBill(sql: Sql, billId: string) {
  const [bill] = await sql`
    SELECT b.id, b.segments, b.suppressed_auto, b.contractor_id, r.bill_month::text AS bill_month, r.cost_basis,
           c.pan_number, c.tds_entity_type, c.tds_declaration_fy
      FROM dtc_bills b
      JOIN dtc_bill_runs r ON r.id = b.run_id
      LEFT JOIN contractors c ON c.id = b.contractor_id
     WHERE b.id = ${billId}::uuid
  ` as any[];
  if (!bill) return;
  const segments = (bill.segments ?? []) as Segment[];
  for (const s of segments) s.amount = segmentAmount(s);
  const settings = await loadDtcSettings(sql);

  // TDS is re-derived from the earnings every time (it depends on them).
  await sql`DELETE FROM dtc_bill_lines WHERE bill_id = ${billId}::uuid AND head = 'tds' AND source = 'auto'`;
  let lines = (await sql`
    SELECT kind, head, amount::float8 AS amount FROM dtc_bill_lines WHERE bill_id = ${billId}::uuid
  `) as any[] as LineLike[];

  const suppressed = new Set<string>(bill.suppressed_auto ?? []);
  const hasManualTds = lines.some(l => l.head === "tds");
  if (settings.tdsEnabled && bill.contractor_id && !suppressed.has("tds:") && !hasManualTds) {
    const fy = financialYear(bill.bill_month);
    const pct = tdsPercent(
      { pan: bill.pan_number, entityType: bill.tds_entity_type, declarationFy: bill.tds_declaration_fy }, fy,
    );
    const earnings = billTotals(segments, lines, bill.cost_basis).totalEarnings;
    const amount = roundRupee(earnings * pct / 100);
    if (pct > 0 && amount > 0) {
      const why = (bill.pan_number ?? "").trim() ? `TDS u/s 194C @ ${pct}%` : `TDS @ ${pct}% (no PAN on record)`;
      await sql`
        INSERT INTO dtc_bill_lines (bill_id, kind, head, qty, rate, amount, remarks, source)
        VALUES (${billId}::uuid, 'deduction', 'tds', ${earnings}::numeric, ${pct}::numeric,
                ${amount.toFixed(2)}::numeric, ${why}, 'auto')
      `;
      lines = [...lines, { kind: "deduction", head: "tds", amount }];
    }
  }

  const t = billTotals(segments, lines, bill.cost_basis);
  await sql`
    UPDATE dtc_bills SET
      segments = ${JSON.stringify(segments)}::jsonb,
      days = ${t.days},
      qty_litres = ${t.qty.toFixed(3)}::numeric,
      gross_amount = ${t.gross.toFixed(2)}::numeric,
      other_earnings = ${t.otherEarnings.toFixed(2)}::numeric,
      total_earnings = ${t.totalEarnings.toFixed(2)}::numeric,
      total_deductions = ${t.totalDeductions.toFixed(2)}::numeric,
      net_amount = ${t.net.toFixed(2)}::numeric,
      payable_amount = ${t.payable.toFixed(2)}::numeric,
      carry_forward = ${t.carryForward.toFixed(2)}::numeric,
      cost_per_litre = ${t.costPerLitre.toFixed(2)}::numeric,
      updated_at = now()
    WHERE id = ${billId}::uuid
  `;
  return t;
}

// ── Who ran a route when (route_contractor_history, 0084) ───────────────
export interface ContractorSpell {
  contractorId: string | null;
  contractorName: string | null;
  contractorVehicle: string | null;
  from: string;
  to: string;
}

/**
 * Per route: the contractors who held it during [start, end], as date
 * ranges clipped to the window, adjacent same-contractor ranges merged.
 * Days before a route's first history row belong to its current
 * contractor (same rule as route_contractor_on in SQL).
 */
export async function loadContractorSpells(sql: Sql, start: string, end: string) {
  const rows = await sql`
    SELECT h.route_id, h.contractor_id,
           COALESCE(c.name, h.contractor_name) AS contractor_name, c.vehicle_number AS contractor_vehicle,
           GREATEST(h.from_date, ${start}::date)::text AS "from",
           LEAST(COALESCE(h.to_date, ${end}::date), ${end}::date)::text AS "to"
      FROM route_contractor_history h
      LEFT JOIN contractors c ON c.id = h.contractor_id
     WHERE h.from_date <= ${end}::date AND (h.to_date IS NULL OR h.to_date >= ${start}::date)
     ORDER BY h.route_id, h.from_date
  ` as any[];
  const map = new Map<string, ContractorSpell[]>();
  for (const r of rows) {
    const list = map.get(r.route_id) ?? [];
    const prev = list[list.length - 1];
    if (prev && prev.contractorId === r.contractor_id && addDays(prev.to, 1) >= r.from) {
      prev.to = r.to > prev.to ? r.to : prev.to;
    } else {
      list.push({
        contractorId: r.contractor_id ?? null, contractorName: r.contractor_name ?? null,
        contractorVehicle: r.contractor_vehicle ?? null, from: r.from, to: r.to,
      });
    }
    map.set(r.route_id, list);
  }
  return map;
}

/** A route's spells for the month, falling back to its current contractor where history is silent. */
function spellsFor(
  route: { id: string; contractor_id: string | null; contractor_name: string | null; contractor_vehicle: string | null },
  spells: Map<string, ContractorSpell[]>, start: string, end: string,
): ContractorSpell[] {
  const current = {
    contractorId: route.contractor_id ?? null, contractorName: route.contractor_name ?? null,
    contractorVehicle: route.contractor_vehicle ?? null,
  };
  const list = (spells.get(route.id) ?? []).map(s => ({ ...s }));
  if (list.length === 0) return [{ ...current, from: start, to: end }];
  if (list[0]!.from > start) {
    const head = { ...current, from: start, to: addDays(list[0]!.from, -1) };
    if (head.contractorId === list[0]!.contractorId) list[0]!.from = start;
    else list.unshift(head);
  }
  return list;
}

// ── Generate / refresh a month's run ────────────────────────────────────
/**
 * Creates or refreshes every bill of a draft run: terms, days, litres and
 * the automatic lines (recurring charges, security deposit instalment,
 * advances, carry-forward recoveries, route officer entries, TDS). Manual lines and the clerk's
 * day overrides are kept. Must run inside a transaction holding the run row.
 *
 * A route whose contractor changed during the month gets one bill per
 * contractor, each covering only that contractor's days (period_from /
 * period_to). A contractor spell with no run days and no litres gets no
 * bill of its own, unless it is the route's only spell.
 */
export async function generateRunBills(sql: Sql, runId: string, monthStart: string) {
  const { start, end } = monthBounds(monthStart);
  // Bills may trade periods during a refresh; check uniqueness at commit.
  await sql`SET CONSTRAINTS dtc_bills_run_route_period_key DEFERRED`;

  const routes = await sql`
    SELECT r.id, r.code, r.name, r.contractor_id,
           c.name AS contractor_name, c.vehicle_number AS contractor_vehicle
      FROM routes r
      LEFT JOIN contractors c ON c.id = r.contractor_id AND c.deleted_at IS NULL
     WHERE r.deleted_at IS NULL AND r.code <> 'DEMO'
  ` as any[];
  const spellsByRoute = await loadContractorSpells(sql, start, end);
  const termRows = await sql`
    SELECT t.id, t.route_id, t.effective_from::text AS effective_from, t.active, t.billing_type,
           t.rate::float8 AS rate, t.km_per_day::float8 AS km_per_day,
           t.vehicle_capacity_mt::float8 AS vehicle_capacity_mt, t.vehicle_number, t.cash_collection
      FROM dtc_route_terms t
     WHERE t.effective_from <= ${end}::date
     ORDER BY t.route_id, t.effective_from
  ` as any[] as TermsRow[];
  const termsByRoute = new Map<string, TermsRow[]>();
  for (const t of termRows) {
    if (!termsByRoute.has(t.route_id)) termsByRoute.set(t.route_id, []);
    termsByRoute.get(t.route_id)!.push(t);
  }

  const qty = await loadRouteDailyQty(sql, start, end);
  const dispatch = await loadDispatchDates(sql, start, end);

  const existing = await sql`
    SELECT id, route_id, contractor_id, period_from::text AS period_from, segments
      FROM dtc_bills WHERE run_id = ${runId}::uuid
  ` as any[];
  const existingByRoute = new Map<string, any[]>();
  for (const b of existing) {
    if (!existingByRoute.has(b.route_id)) existingByRoute.set(b.route_id, []);
    existingByRoute.get(b.route_id)!.push(b);
  }
  const keepBillIds = new Set<string>();

  for (const route of routes) {
    const versions = termsByRoute.get(route.id) ?? [];
    if (termsRanges(versions, start, end).length === 0) continue;

    // One candidate bill per contractor spell that has terms in force.
    const candidates = spellsFor(route, spellsByRoute, start, end).flatMap(spell => {
      const ranges = termsRanges(versions, spell.from, spell.to);
      if (ranges.length === 0) return [];
      const busy = ranges.some(({ from, to }) =>
        runDates(route.id, from, to, qty, dispatch).length > 0
        || Array.from(qty.get(route.id) ?? []).some(([d, l]) => d >= from && d <= to && l > 0));
      return [{ spell, ranges, busy }];
    });
    if (candidates.length === 0) continue;
    // Several contractors: bill only the ones who ran it (or the last, if none did).
    const billed = candidates.length === 1 ? candidates
      : candidates.some(c => c.busy) ? candidates.filter(c => c.busy)
      : [candidates[candidates.length - 1]!];

    // Match existing bills so manual lines and day overrides survive a
    // refresh: same period start, else same contractor, else a lone bill.
    const pool = [...(existingByRoute.get(route.id) ?? [])];
    const take = (pred: (b: any) => boolean) => {
      const i = pool.findIndex(pred);
      return i >= 0 ? pool.splice(i, 1)[0] : undefined;
    };
    const matched = billed.map(c => take(b => b.period_from === c.spell.from));
    billed.forEach((c, i) => { if (!matched[i]) matched[i] = take(b => b.contractor_id === c.spell.contractorId); });
    if (billed.length === 1 && !matched[0]) matched[0] = take(() => true);

    for (const [i, { spell, ranges }] of billed.entries()) {
      const prev = matched[i];
      const prevOverrides = new Map<string, number | null>(
        ((prev?.segments ?? []) as Segment[]).map(s => [s.key, s.daysOverride]),
      );
      const segments: Segment[] = ranges.map(({ terms, from, to }) => {
        const dates = runDates(route.id, from, to, qty, dispatch);
        const litres = Array.from(qty.get(route.id) ?? [])
          .filter(([d]) => d >= from && d <= to)
          .reduce((s, [, l]) => s + l, 0);
        const key = `${terms.id}:${from}`;
        const seg: Segment = {
          key, termsId: terms.id, from, to,
          billingType: terms.billing_type, rate: Number(terms.rate), kmPerDay: Number(terms.km_per_day),
          autoDays: dates.length, daysOverride: prevOverrides.get(key) ?? null,
          qty: round3(litres), amount: 0,
        };
        seg.amount = segmentAmount(seg);
        return seg;
      });
      const last = ranges[ranges.length - 1]!.terms;
      const vehicle = last.vehicle_number || spell.contractorVehicle || null;

      if (prev) {
        keepBillIds.add(prev.id);
        await sql`
          UPDATE dtc_bills SET
            route_code = ${route.code}, route_name = ${route.name},
            contractor_id = ${spell.contractorId}::uuid, contractor_name = ${spell.contractorName},
            period_from = ${spell.from}::date, period_to = ${spell.to}::date,
            vehicle_number = ${vehicle}, vehicle_capacity_mt = ${last.vehicle_capacity_mt}::numeric,
            billing_type = ${last.billing_type}, rate = ${String(last.rate)}::numeric,
            km_per_day = ${String(last.km_per_day)}::numeric, cash_collection = ${last.cash_collection},
            segments = ${JSON.stringify(segments)}::jsonb, updated_at = now()
          WHERE id = ${prev.id}::uuid
        `;
      } else {
        const [row] = await sql`
          INSERT INTO dtc_bills (
            run_id, route_id, route_code, route_name, contractor_id, contractor_name, period_from, period_to,
            vehicle_number, vehicle_capacity_mt, billing_type, rate, km_per_day, cash_collection, segments
          ) VALUES (
            ${runId}::uuid, ${route.id}::uuid, ${route.code}, ${route.name},
            ${spell.contractorId}::uuid, ${spell.contractorName}, ${spell.from}::date, ${spell.to}::date,
            ${vehicle}, ${last.vehicle_capacity_mt}::numeric, ${last.billing_type},
            ${String(last.rate)}::numeric, ${String(last.km_per_day)}::numeric, ${last.cash_collection},
            ${JSON.stringify(segments)}::jsonb
          ) RETURNING id
        ` as any[];
        keepBillIds.add(row.id);
      }
    }
  }

  // Bills no longer needed: terms removed / inactive, or a contractor
  // spell that went away.
  for (const b of existing) {
    if (!keepBillIds.has(b.id)) {
      await sql`DELETE FROM dtc_bills WHERE id = ${b.id}::uuid`;
    }
  }

  await refreshAutoLines(sql, runId, start);

  const ids = await sql`SELECT id FROM dtc_bills WHERE run_id = ${runId}::uuid` as any[];
  for (const b of ids) await recomputeBill(sql, b.id);
  await sql`UPDATE dtc_bill_runs SET updated_at = now() WHERE id = ${runId}::uuid`;
  return { billCount: ids.length };
}

interface AutoLine {
  billId: string;
  kind: "earning" | "deduction";
  head: LineHead;
  qty?: number | null;
  rate?: number | null;
  amount: number;
  remarks: string;
  sourceRef: string | null;
}

/** Rebuild the automatic lines of every bill in the run (TDS is done by recomputeBill). */
async function refreshAutoLines(sql: Sql, runId: string, start: string) {
  await sql`
    DELETE FROM dtc_bill_lines l USING dtc_bills b
     WHERE l.bill_id = b.id AND b.run_id = ${runId}::uuid AND l.source = 'auto'
  `;
  const bills = await sql`
    SELECT id, route_id, route_code, contractor_id, suppressed_auto,
           period_from::text AS period_from, period_to::text AS period_to
      FROM dtc_bills WHERE run_id = ${runId}::uuid ORDER BY route_code, period_from
  ` as any[];
  if (bills.length === 0) return;

  const lines: AutoLine[] = [];
  // A route has one bill per contractor spell in the month (usually one).
  const billsByRoute = new Map<string, any[]>();
  for (const b of bills) {
    if (!billsByRoute.has(b.route_id)) billsByRoute.set(b.route_id, []);
    billsByRoute.get(b.route_id)!.push(b);
  }
  /** The route's bill covering `date`. */
  const billOn = (routeId: string, date: string) =>
    (billsByRoute.get(routeId) ?? []).find(b => b.period_from <= date && date <= b.period_to);
  /** The route's month-end bill (whoever holds the route at the end of the month). */
  const lastBillOf = (routeId: string) => {
    const list = billsByRoute.get(routeId) ?? [];
    return list[list.length - 1];
  };
  // A contractor's contractor-level deductions go on their first bill (by route code).
  const firstBillOf = new Map<string, any>();
  for (const b of bills) if (b.contractor_id && !firstBillOf.has(b.contractor_id)) firstBillOf.set(b.contractor_id, b);

  // 1. Recurring monthly charges (GPS rent, …): on the month-end contractor's bill.
  const charges = await sql`
    SELECT id, route_id, head, description, monthly_amount::float8 AS amount
      FROM dtc_recurring_charges
     WHERE active AND from_month <= ${start}::date AND (to_month IS NULL OR to_month >= ${start}::date)
  ` as any[];
  for (const c of charges) {
    const b = lastBillOf(c.route_id);
    if (!b) continue;
    lines.push({ billId: b.id, kind: "deduction", head: c.head, amount: round2(c.amount), remarks: c.description, sourceRef: c.id });
  }

  // 2. Security deposit instalment, capped at what is still due — and at
  //    what the bill can cover, so a month with little or no work does not
  //    turn into a debt just to collect the deposit. Added last (below), once
  //    every other deduction on the bill is known.
  const deposits = await sql`
    SELECT d.id, d.contractor_id, d.target_amount::float8 AS target, d.monthly_instalment::float8 AS instalment,
           d.opening_collected::float8 + COALESCE((
             SELECT SUM(l.amount) FROM dtc_bill_lines l
               JOIN dtc_bills b ON b.id = l.bill_id
              WHERE l.head = 'security_deposit' AND b.contractor_id = d.contractor_id
                AND b.run_id <> ${runId}::uuid
           ), 0)::float8 AS collected
      FROM dtc_security_deposits d
     WHERE d.status = 'active'
  ` as any[];

  // 3. Advances to recover this month, not already recovered in another run.
  const advances = await sql`
    SELECT a.id, a.contractor_id, a.route_id, a.amount::float8 AS amount,
           to_char(a.paid_on, 'DD-MM-YYYY') AS paid_on, a.reference
      FROM dtc_advances a
     WHERE a.cancelled_at IS NULL AND a.recover_month = ${start}::date
       AND NOT EXISTS (
         SELECT 1 FROM dtc_bill_lines l JOIN dtc_bills b ON b.id = l.bill_id
          WHERE l.head = 'advance' AND l.source_ref = a.id AND b.run_id <> ${runId}::uuid)
  ` as any[];
  for (const a of advances) {
    const onRoute = a.route_id
      ? (billsByRoute.get(a.route_id) ?? []).find(x => x.contractor_id === a.contractor_id)
      : null;
    const b = onRoute ?? firstBillOf.get(a.contractor_id);
    if (!b) continue;
    lines.push({
      billId: b.id, kind: "deduction", head: "advance", amount: round2(a.amount),
      remarks: `Advance paid on ${a.paid_on}${a.reference ? ` (${a.reference})` : ""}`, sourceRef: a.id,
    });
  }

  // 4. Negative balances of earlier approved months, recovered once.
  const negatives = await sql`
    SELECT b.id, b.contractor_id, b.route_code, b.carry_forward::float8 AS amount, r.bill_month::text AS bill_month
      FROM dtc_bills b
      JOIN dtc_bill_runs r ON r.id = b.run_id
     WHERE r.status = 'approved' AND r.bill_month < ${start}::date
       AND b.carry_forward > 0 AND b.contractor_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM dtc_bill_lines l JOIN dtc_bills b2 ON b2.id = l.bill_id
          WHERE l.head = 'carry_forward' AND l.source_ref = b.id AND b2.run_id <> ${runId}::uuid)
  ` as any[];
  for (const n of negatives) {
    const b = firstBillOf.get(n.contractor_id);
    if (!b) continue;
    lines.push({
      billId: b.id, kind: "deduction", head: "carry_forward", amount: round2(n.amount),
      remarks: `Recovery of negative balance, ${monthLabel(n.bill_month)} (${n.route_code})`, sourceRef: n.id,
    });
  }

  // 5. Route officer entries dated in the month (short supply, crate /
  //    product shortage, short km, extra km / trips, penalties), one line
  //    each on the bill of the entry's route covering the entry's date.
  const { end } = monthBounds(start);
  for (const e of await loadEntryLineRows(sql, start, end)) {
    const b = billOn(e.route_id, e.entry_date);
    if (!b) continue;
    const l = entryLine(e);
    if (!(l.amount > 0)) continue;
    lines.push({
      billId: b.id, kind: l.kind, head: l.head as LineHead, qty: l.qty, rate: l.rate,
      amount: l.amount, remarks: l.remarks, sourceRef: e.id,
    });
  }

  const suppressedOf = new Map(bills.map(b => [b.id as string, new Set<string>(b.suppressed_auto ?? [])]));
  const isSuppressed = (l: AutoLine) => suppressedOf.get(l.billId)?.has(`${l.head}:${l.sourceRef ?? ""}`) ?? false;

  // Security deposits last: room on the bill = earnings − every other deduction (incl. TDS).
  if (deposits.length) {
    const settings = await loadDtcSettings(sql);
    const money = await sql`
      SELECT b.id, b.segments, r.bill_month::text AS bill_month, r.cost_basis,
             c.pan_number, c.tds_entity_type, c.tds_declaration_fy,
             COALESCE((SELECT json_agg(json_build_object('kind', l.kind, 'head', l.head, 'amount', l.amount::float8))
                         FROM dtc_bill_lines l WHERE l.bill_id = b.id), '[]'::json) AS lines
        FROM dtc_bills b JOIN dtc_bill_runs r ON r.id = b.run_id
        LEFT JOIN contractors c ON c.id = b.contractor_id
       WHERE b.run_id = ${runId}::uuid
    ` as any[];
    const roomOf = new Map<string, number>();
    for (const m of money) {
      const all: LineLike[] = [
        ...(m.lines as LineLike[]),
        ...lines.filter(l => l.billId === m.id && !isSuppressed(l)),
      ];
      const t = billTotals(m.segments as Segment[], all, m.cost_basis);
      const manualTds = all.some(l => l.head === "tds");
      const pct = settings.tdsEnabled && !manualTds && !suppressedOf.get(m.id)?.has("tds:")
        ? tdsPercent({ pan: m.pan_number, entityType: m.tds_entity_type, declarationFy: m.tds_declaration_fy },
                     financialYear(m.bill_month))
        : 0;
      roomOf.set(m.id, Math.max(0, t.net - roundRupee(t.totalEarnings * pct / 100)));
    }
    for (const d of deposits) {
      const b = firstBillOf.get(d.contractor_id);
      if (!b) continue;
      const due = round2(Math.max(0, d.target - d.collected));
      const room = roomOf.get(b.id) ?? 0;
      const amount = round2(Math.min(d.instalment, due, room));
      if (amount <= 0) continue;
      lines.push({
        billId: b.id, kind: "deduction", head: "security_deposit", amount,
        remarks: `Security deposit instalment${amount < Math.min(d.instalment, due) ? " (reduced to what the bill covers)" : ""}` +
          ` (collected ₹${round2(d.collected + amount).toFixed(2)} of ₹${round2(d.target).toFixed(2)})`,
        sourceRef: d.id,
      });
    }
  }

  for (const l of lines) {
    if (isSuppressed(l)) continue;
    await sql`
      INSERT INTO dtc_bill_lines (bill_id, kind, head, qty, rate, amount, remarks, source, source_ref)
      VALUES (${l.billId}::uuid, ${l.kind}, ${l.head}, ${l.qty ?? null}::numeric, ${l.rate ?? null}::numeric,
              ${l.amount.toFixed(2)}::numeric, ${l.remarks}, 'auto', ${l.sourceRef}::uuid)
    `;
  }
}
