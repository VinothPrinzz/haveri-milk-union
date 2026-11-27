// apps/api/src/routes/officer-entries.ts
// ═══════════════════════════════════════════════════════════════════════
// Contractor entries — recorded by route officers against their routes
//
//   GET    /api/v1/officer-entries                 ?month=YYYY-MM&routeId&type&q
//                                                  entries + the month's totals
//   GET    /api/v1/officer-entries/lookups         ?date= routes (contractor,
//                                                  vehicle, terms), crate rate,
//                                                  products with price that day
//   GET    /api/v1/officer-entries/lookups/dealers ?routeId= customers on a route
//   POST   /api/v1/officer-entries/photo-presign   upload URL for a photo (R2)
//   GET    /api/v1/officer-entries/:id
//   POST   /api/v1/officer-entries
//   PATCH  /api/v1/officer-entries/:id
//   DELETE /api/v1/officer-entries/:id             soft delete
//
// Each entry is one automatic line on its route's DTC bill for the entry's
// month (see lib/dtc-officer-entries.ts). Amounts are worked out here from
// the dealer price, the crate rate and the route terms in force on the
// entry date; the browser's figures are only a preview.
//
// A route officer (role 'officer') sees and records entries only on their
// routes: routes with a customer in the officer's taluka (users.zone_id).
// An officer with no taluka set covers every route, the same as a user with
// no zone elsewhere. Other roles read every route.
//
// Once a month's bills are sent for approval (run past draft) that month's
// entries are locked: they can't be added, changed or removed until the
// bills are sent back.
// ═══════════════════════════════════════════════════════════════════════
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { pgClient } from "../lib/db.js";
import { isoDate, istToday } from "../lib/ist-date.js";
import {
  HEAD_LABELS, HttpError, crateRateOn, logEvent, monthBounds, monthLabel, monthParam,
  recomputeBill, requestAdmin, round2, round3, type Sql,
} from "../lib/dtc.js";
import {
  ENTRY_TYPES, entryLine, loadEntryLineRows,
  type EntryItem, type EntryLineRow, type EntryType,
} from "../lib/dtc-officer-entries.js";
import { dtcRoute, parseWith } from "../lib/dtc-http.js";
import { NOTIFY_ROLES, notifyStaffSafe } from "../lib/admin-notifications.js";

// Entries that are shortages: staff are notified when one is saved or changed.
const SHORTAGE_TYPES = new Set<EntryType>(["short_supply", "crate_shortage", "product_shortage", "km_short"]);

/** "Shortage recorded: R12 · Ramesh Transport · Product shortage ₹432.00 (by Route Officer 3)" */
async function notifyShortage(
  request: FastifyRequest,
  entry: Awaited<ReturnType<typeof loadEntries>>[number] | undefined,
  verb: "recorded" | "changed",
) {
  if (!entry || !SHORTAGE_TYPES.has(entry.type)) return;
  const by = request.admin?.name;
  const [, m, d] = entry.entryDate.split("-");
  await notifyStaffSafe(request.log, {
    kind: "officer_shortage",
    title: `Shortage ${verb}: ${entry.routeCode}${entry.contractorName ? ` · ${entry.contractorName}` : ""}`,
    body: `${entry.headLabel} ${inr(entry.amount)} on ${d}-${m}: ${entry.detail}${by ? ` (by ${by})` : ""}`,
    link: `/contractor-entries/${entry.id}`,
    roles: [...NOTIFY_ROLES.officerShortage],
    refId: entry.id,
  });
}

const uuidParam = z.object({ id: z.string().uuid() });
const inr = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// ── Who sees which routes ───────────────────────────────────────────────
/** The taluka an officer is limited to, or null for every route. */
function scopeZone(request: FastifyRequest): string | null {
  const a = request.admin;
  return a?.role === "officer" ? a.zoneId ?? null : null;
}

/** SQL condition: route `col` is one of the officer's routes (or no limit). */
const routeInScope = (sql: Sql, col: string, zoneId: string | null) => sql`
  (${zoneId}::uuid IS NULL OR EXISTS (
     SELECT 1 FROM dealers dz
      WHERE dz.route_id = ${sql.unsafe(col)} AND dz.deleted_at IS NULL AND dz.zone_id = ${zoneId}::uuid))
`;

/**
 * Throws unless the route is one of the officer's. `onDate` picks whose
 * contractor_id comes back: the contractor on that date (0084), else today's.
 */
async function assertRouteInScope(sql: Sql, routeId: string, zoneId: string | null, onDate?: string) {
  const [r] = await sql`
    SELECT r.id,
           CASE WHEN ${onDate ?? null}::date IS NULL THEN r.contractor_id
                ELSE route_contractor_on(r.id, ${onDate ?? null}::date) END AS contractor_id
      FROM routes r
     WHERE r.id = ${routeId}::uuid AND r.deleted_at IS NULL AND r.code <> 'DEMO'
       AND ${routeInScope(sql, "r.id", zoneId)}
  ` as any[];
  if (!r) throw new HttpError(403, "Not your route", "That route is not one of your routes.");
  return r as { id: string; contractor_id: string | null };
}

// ── Prices, rates and terms on a date ───────────────────────────────────
/**
 * Dealer price (GST inclusive) of products on `date`. The price on a date is
 * the "old" price of the first revision after it; with no later revision, the
 * product's current dealer price. Revisions logged before migration 0075
 * carry only the net price, which is grossed up with its GST.
 */
async function productPricesOn(sql: Sql, date: string, ids: string[] | null) {
  return await sql`
    SELECT p.id, p.code, COALESCE(NULLIF(trim(p.report_alias), ''), p.name) AS name, p.name AS full_name, p.unit,
           COALESCE(
             (SELECT COALESCE(pr.old_dealer_price, round(pr.old_price * (1 + pr.old_gst_percent / 100), 2))
                FROM price_revisions pr
               WHERE pr.product_id = p.id AND pr.effective_from > ${date}::date
               ORDER BY pr.effective_from, pr.created_at LIMIT 1),
             p.dealer_price,
             round(p.base_price * (1 + p.gst_percent / 100), 2)
           )::float8 AS price
      FROM products p
     WHERE p.deleted_at IS NULL
       AND (${ids ? ids.join(",") : null}::text IS NULL
            OR p.id = ANY(string_to_array(${ids ? ids.join(",") : ""}, ',')::uuid[]))
     ORDER BY p.sort_order, p.name
  ` as any[] as { id: string; code: string | null; name: string; full_name: string; unit: string; price: number }[];
}

interface TermsOn { billingType: "km" | "trip" | "litre"; rate: number; kmPerDay: number; vehicleNumber: string | null; effectiveFrom: string }

/** Route terms in force on `date`, or null (none, or the route was not billed then). */
async function termsOn(sql: Sql, routeId: string, date: string): Promise<TermsOn | null> {
  const [t] = await sql`
    SELECT billing_type, rate::float8 AS rate, km_per_day::float8 AS km_per_day, vehicle_number, active,
           effective_from::text AS effective_from
      FROM dtc_route_terms
     WHERE route_id = ${routeId}::uuid AND effective_from <= ${date}::date
     ORDER BY effective_from DESC LIMIT 1
  ` as any[];
  if (!t || !t.active) return null;
  return {
    billingType: t.billing_type, rate: Number(t.rate), kmPerDay: Number(t.km_per_day),
    vehicleNumber: t.vehicle_number, effectiveFrom: t.effective_from,
  };
}

/** ₹ a km on these terms: the km rate, or a trip rate spread over the route's daily km. */
function perKmRate(t: TermsOn | null): number | null {
  if (!t) return null;
  if (t.billingType === "km") return t.rate;
  if (t.billingType === "trip" && t.kmPerDay > 0) return round3(t.rate / t.kmPerDay);
  return null;
}

// ── Body ────────────────────────────────────────────────────────────────
const bodySchema = z.object({
  entryDate: isoDate,
  routeId: z.string().uuid(),
  shift: z.enum(["morning", "evening"]),
  type: z.enum(ENTRY_TYPES),
  dealerId: z.string().uuid().optional().nullable(),
  reportSource: z.enum(["customer_call", "officer_visit", "dispatch_check", "return_check", "on_route"]).optional().nullable(),
  items: z.array(z.object({
    productId: z.string().uuid(),
    qty: z.number().int("packets must be a whole number").positive().max(100000),
  })).max(50).optional().nullable(),
  cratesSent: z.number().int().min(0).max(100000).optional().nullable(),
  cratesReturned: z.number().int().min(0).max(100000).optional().nullable(),
  kmRun: z.number().min(0).max(10000).optional().nullable(),
  /** Extra km: km. Extra trip: trips (trip-basis route) or the trip's km. */
  qty: z.number().positive().max(10000).optional().nullable(),
  /** Penalty only */
  amount: z.number().positive().max(1e7).optional().nullable(),
  reason: z.string().trim().max(300).optional().nullable(),
  reference: z.string().trim().max(100).optional().nullable(),
  remarks: z.string().trim().max(500).optional().nullable(),
  photoUrl: z.string().url().max(1000).optional().nullable(),
});
type Body = z.infer<typeof bodySchema>;

const PENALTY_REASONS = ["late_arrival", "not_clean", "misbehaviour", "other"];

/** The stored columns of an entry, with its amount worked out here. */
async function computeEntry(sql: Sql, b: Body) {
  const bad = (msg: string) => new HttpError(400, "Validation Error", msg);
  const out = {
    dealerId: null as string | null, reportSource: null as string | null, items: [] as EntryItem[],
    cratesSent: null as number | null, cratesReturned: null as number | null,
    qty: null as number | null, unit: null as string | null, rate: null as number | null,
    kmExpected: null as number | null, kmRun: null as number | null,
    amount: 0, reason: b.reason || null, reference: null as string | null,
  };

  const priceItems = async () => {
    const lines = b.items ?? [];
    if (!lines.length) throw bad("Add at least one product.");
    const ids = [...new Set(lines.map(i => i.productId))];
    if (ids.length !== lines.length) throw bad("A product is listed twice. Put its packets on one row.");
    const prices = new Map((await productPricesOn(sql, b.entryDate, ids)).map(p => [p.id, p]));
    out.items = lines.map(i => {
      const p = prices.get(i.productId);
      if (!p) throw bad("A product on the list no longer exists.");
      if (!(p.price > 0)) throw bad(`${p.name} has no dealer price on that date.`);
      return { productId: p.id, name: p.name, qty: i.qty, rate: round2(p.price), amount: round2(i.qty * p.price) };
    });
    out.qty = out.items.reduce((s, i) => s + i.qty, 0);
    out.unit = "packet";
    out.amount = round2(out.items.reduce((s, i) => s + i.amount, 0));
  };

  switch (b.type) {
    case "short_supply": {
      if (!b.dealerId) throw bad("Pick the customer who was delivered short.");
      const [d] = await sql`
        SELECT id FROM dealers WHERE id = ${b.dealerId}::uuid AND route_id = ${b.routeId}::uuid AND deleted_at IS NULL
      `;
      if (!d) throw bad("That customer is not on this route.");
      if (b.reportSource !== "customer_call" && b.reportSource !== "officer_visit") {
        throw bad("Say how you came to know: customer phoned, or found on visit.");
      }
      out.dealerId = b.dealerId;
      out.reportSource = b.reportSource;
      await priceItems();
      break;
    }
    case "product_shortage": {
      if (!b.dealerId) throw bad("Pick the agent who was short.");
      const [d] = await sql`
        SELECT id FROM dealers WHERE id = ${b.dealerId}::uuid AND route_id = ${b.routeId}::uuid AND deleted_at IS NULL
      `;
      if (!d) throw bad("That agent is not on this route.");
      if (!b.reportSource || !["dispatch_check", "return_check", "on_route"].includes(b.reportSource)) {
        throw bad("Say where the shortage was found.");
      }
      out.dealerId = b.dealerId;
      out.reportSource = b.reportSource;
      await priceItems();
      break;
    }
    case "crate_shortage": {
      if (b.cratesSent == null || b.cratesReturned == null) throw bad("Enter the crates sent and returned.");
      if (b.cratesReturned >= b.cratesSent) throw bad("Crates returned must be fewer than crates sent.");
      const rate = await crateRateOn(sql, b.entryDate);
      if (!(rate > 0)) throw bad("No crate shortage rate is set for that date. Ask Marketing to set it in DTC Billing → Crate Rates.");
      out.cratesSent = b.cratesSent;
      out.cratesReturned = b.cratesReturned;
      out.qty = b.cratesSent - b.cratesReturned;
      out.unit = "crate";
      out.rate = rate;
      out.amount = round2(out.qty * rate);
      break;
    }
    case "km_short": {
      const t = await termsOn(sql, b.routeId, b.entryDate);
      const rate = perKmRate(t);
      if (!t || !(t.kmPerDay > 0) || rate == null) {
        throw bad("This route has no km per day and rate on that date. Ask Marketing to set the route's billing terms.");
      }
      if (b.kmRun == null) throw bad("Enter the km actually run.");
      if (b.kmRun >= t.kmPerDay) throw bad(`The route is ${t.kmPerDay} km a day; km run must be less than that.`);
      out.kmExpected = t.kmPerDay;
      out.kmRun = b.kmRun;
      out.qty = round2(t.kmPerDay - b.kmRun);
      out.unit = "km";
      out.rate = rate;
      out.amount = round2(out.qty * rate);
      break;
    }
    case "extra_km":
    case "extra_trip": {
      if (!b.reason || b.reason.length < 3) throw bad("Say why it was needed.");
      const t = await termsOn(sql, b.routeId, b.entryDate);
      if (!t) throw bad("This route has no billing terms on that date. Ask Marketing to set them.");
      if (b.qty == null) throw bad(b.type === "extra_trip" && t.billingType === "trip" ? "Enter the number of trips." : "Enter the km.");
      if (b.type === "extra_trip" && t.billingType === "trip") {
        if (!Number.isInteger(b.qty)) throw bad("Trips must be a whole number.");
        out.unit = "trip";
        out.rate = t.rate;
      } else {
        const rate = perKmRate(t);
        if (rate == null) throw bad("This route is not paid by the km. Ask Marketing to add it on the bill.");
        out.unit = "km";
        out.rate = rate;
      }
      out.qty = round2(b.qty);
      out.amount = round2(out.qty * out.rate);
      break;
    }
    case "penalty": {
      if (!b.reason || !PENALTY_REASONS.includes(b.reason)) throw bad("Pick the reason for the penalty.");
      if (b.reason === "other" && !(b.remarks && b.remarks.length >= 3)) throw bad("Say what the penalty is for in the remarks.");
      if (b.amount == null) throw bad("Enter the penalty amount.");
      out.amount = round2(b.amount);
      out.reference = b.reference || null;
      break;
    }
  }
  if (!(out.amount > 0)) throw bad("The amount works out to zero.");
  return out;
}

// ── The bill side ───────────────────────────────────────────────────────
/**
 * Locks the month's bill run, if there is one. Throws when its bills are
 * past draft, since the entry could then no longer reach (or leave) the bill.
 */
async function lockMonth(tx: Sql, date: string, verb: string) {
  const monthStart = date.slice(0, 7) + "-01";
  const [run] = await tx`
    SELECT id, status FROM dtc_bill_runs WHERE bill_month = ${monthStart}::date FOR UPDATE
  ` as any[];
  if (run && run.status !== "draft") {
    throw new HttpError(409, "Bill locked",
      `${monthLabel(monthStart)} contractor bills have been sent for approval, so entries for that month can't be ${verb} now. ` +
      "Ask Marketing to send the bills back first.");
  }
  return { monthStart, run: (run ?? null) as { id: string; status: string } | null };
}

/**
 * Puts one entry's line on its month's draft bill (or takes it off), and
 * refreshes the bill's totals. The security deposit instalment is not
 * re-sized here; "Refresh" on the month's bills does that.
 */
async function refreshEntryLine(
  tx: Sql, entryId: string, month: { monthStart: string; run: { id: string } | null },
  userId: string, action: string,
) {
  const run = month.run;
  if (!run) return;
  const removed = await tx`
    DELETE FROM dtc_bill_lines l USING dtc_bills b
     WHERE l.bill_id = b.id AND b.run_id = ${run.id}::uuid AND l.source = 'auto' AND l.source_ref = ${entryId}::uuid
    RETURNING b.id AS bill_id, l.head, l.amount::float8 AS amount
  ` as any[];
  const touched = new Map<string, string>();
  for (const r of removed) touched.set(r.bill_id, `${HEAD_LABELS[r.head] ?? r.head} ${inr(r.amount)}`);

  const { start, end } = monthBounds(month.monthStart);
  const [row] = await loadEntryLineRows(tx, start, end, entryId);
  if (row) {
    const [bill] = await tx`
      SELECT id, suppressed_auto FROM dtc_bills
       WHERE run_id = ${run.id}::uuid AND route_id = ${row.route_id}::uuid
         AND ${row.entry_date}::date BETWEEN period_from AND period_to
    ` as any[];
    const suppressed = ((bill?.suppressed_auto ?? []) as string[]).some(k => k.endsWith(`:${entryId}`));
    const l = entryLine(row);
    if (bill && !suppressed && l.amount > 0) {
      await tx`
        INSERT INTO dtc_bill_lines (bill_id, kind, head, qty, rate, amount, remarks, source, source_ref)
        VALUES (${bill.id}::uuid, ${l.kind}, ${l.head}, ${l.qty}::numeric, ${l.rate}::numeric,
                ${l.amount.toFixed(2)}::numeric, ${l.remarks}, 'auto', ${entryId}::uuid)
      `;
      touched.set(bill.id, `${HEAD_LABELS[l.head] ?? l.head} ${inr(l.amount)} (${l.remarks})`);
    }
  }
  for (const [billId, text] of touched) {
    await recomputeBill(tx, billId);
    await logEvent(tx, { runId: run.id, billId, action: "officer_entry", detail: `Route officer entry ${action}: ${text}`, userId });
  }
}

// ── Reading entries ─────────────────────────────────────────────────────
export type EntryStatus = "not_on_bill" | "on_bill" | "removed" | "locked";

async function loadEntries(sql: Sql, where: { id?: string; from?: string; to?: string; routeId?: string | null; zoneId: string | null }) {
  const rows = await sql`
    SELECT e.id, e.route_id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.shift, e.type,
           e.dealer_id, d.code AS dealer_code, d.name AS dealer_name, e.report_source, e.items,
           e.crates_sent, e.crates_returned, e.qty::float8 AS qty, e.unit, e.rate::float8 AS rate,
           e.km_expected::float8 AS km_expected, e.km_run::float8 AS km_run,
           e.amount::float8 AS amount, e.reason, e.reference, e.remarks, e.photo_url,
           e.created_at, cu.name AS created_by_name, e.updated_at, uu.name AS updated_by_name,
           r.code AS route_code, r.name AS route_name,
           e.contractor_id, c.name AS contractor_name,
           run.status AS run_status, b.id AS bill_id,
           (ln.id IS NOT NULL) AS on_bill,
           COALESCE(EXISTS (SELECT 1 FROM unnest(b.suppressed_auto) s WHERE s LIKE '%:' || e.id::text), false) AS removed
      FROM dtc_officer_entries e
      JOIN routes r ON r.id = e.route_id
      LEFT JOIN dealers d ON d.id = e.dealer_id
      LEFT JOIN contractors c ON c.id = e.contractor_id
      LEFT JOIN users cu ON cu.id = e.created_by
      LEFT JOIN users uu ON uu.id = e.updated_by
      LEFT JOIN dtc_bill_runs run ON run.bill_month = date_trunc('month', e.entry_date)::date
      LEFT JOIN dtc_bills b ON b.run_id = run.id AND b.route_id = e.route_id
                           AND e.entry_date BETWEEN b.period_from AND b.period_to
      LEFT JOIN LATERAL (
        SELECT l.id FROM dtc_bill_lines l WHERE l.bill_id = b.id AND l.source_ref = e.id LIMIT 1
      ) ln ON true
     WHERE e.deleted_at IS NULL
       AND (${where.id ?? null}::uuid IS NULL OR e.id = ${where.id ?? null}::uuid)
       AND (${where.from ?? null}::date IS NULL OR e.entry_date >= ${where.from ?? null}::date)
       AND (${where.to ?? null}::date IS NULL OR e.entry_date <= ${where.to ?? null}::date)
       AND (${where.routeId ?? null}::uuid IS NULL OR e.route_id = ${where.routeId ?? null}::uuid)
       AND ${routeInScope(sql, "e.route_id", where.zoneId)}
     ORDER BY e.entry_date DESC, e.created_at DESC
  ` as any[];

  return rows.map(r => {
    const line = entryLine(r as EntryLineRow);
    const locked = !!r.run_status && r.run_status !== "draft";
    const status: EntryStatus = r.removed ? "removed" : locked ? "locked" : r.on_bill ? "on_bill" : "not_on_bill";
    return {
      id: r.id as string,
      entryDate: r.entry_date as string,
      month: (r.entry_date as string).slice(0, 7),
      shift: r.shift as string,
      type: r.type as EntryType,
      kind: line.kind,
      head: line.head,
      headLabel: HEAD_LABELS[line.head] ?? line.head,
      detail: line.detail,
      routeId: r.route_id as string, routeCode: r.route_code as string, routeName: r.route_name as string,
      contractorId: r.contractor_id as string | null, contractorName: r.contractor_name as string | null,
      dealerId: r.dealer_id as string | null, dealerCode: r.dealer_code as string | null, dealerName: r.dealer_name as string | null,
      reportSource: r.report_source as string | null,
      items: (r.items ?? []) as EntryItem[],
      cratesSent: r.crates_sent as number | null, cratesReturned: r.crates_returned as number | null,
      qty: r.qty as number | null, unit: r.unit as string | null, rate: r.rate as number | null,
      kmExpected: r.km_expected as number | null, kmRun: r.km_run as number | null,
      amount: Number(r.amount),
      reason: r.reason as string | null, reference: r.reference as string | null,
      remarks: r.remarks as string | null, photoUrl: r.photo_url as string | null,
      createdAt: r.created_at, createdByName: r.created_by_name as string | null,
      updatedAt: r.updated_at, updatedByName: r.updated_by_name as string | null,
      status, locked,
      runStatus: (r.run_status ?? null) as string | null,
      billId: (r.bill_id ?? null) as string | null,
    };
  });
}

export async function officerEntryRoutes(app: FastifyInstance) {
  // ── List ──
  dtcRoute(app, "get", "/api/v1/officer-entries", "officer_entries.view", async (request) => {
    const q = parseWith(z.object({
      month: monthParam.optional(),
      routeId: z.string().uuid().optional(),
      type: z.enum(ENTRY_TYPES).optional(),
      q: z.string().trim().max(100).optional(),
    }), request.query);
    const month = q.month ?? istToday().slice(0, 7);
    const { start, end } = monthBounds(month);
    const all = await loadEntries(pgClient, { from: start, to: end, routeId: q.routeId ?? null, zoneId: scopeZone(request) });

    // Figures for the month (route filter applies; type / search don't).
    const totals = {
      count: all.length,
      deductions: round2(all.filter(e => e.kind === "deduction" && e.status !== "removed").reduce((s, e) => s + e.amount, 0)),
      additions: round2(all.filter(e => e.kind === "earning" && e.status !== "removed").reduce((s, e) => s + e.amount, 0)),
      notOnBill: all.filter(e => e.status === "not_on_bill").length,
    };
    const needle = (q.q ?? "").toLowerCase();
    const data = all.filter(e =>
      (!q.type || e.type === q.type) &&
      (!needle || [e.routeCode, e.routeName, e.contractorName, e.dealerCode, e.dealerName, e.detail, e.remarks, e.reference]
        .some(v => (v ?? "").toLowerCase().includes(needle))));
    return { month, totals, data };
  });

  // ── Form lookups ──
  dtcRoute(app, "get", "/api/v1/officer-entries/lookups", "officer_entries.view", async (request) => {
    const { date = istToday() } = parseWith(z.object({ date: isoDate.optional() }), request.query);
    const zoneId = scopeZone(request);
    // The contractor who held each route on the entry date (0084), not today's.
    const routes = await pgClient`
      SELECT r.id, r.code, r.name, c.id AS "contractorId", c.name AS "contractorName",
             c.phone AS "contractorPhone", c.vehicle_number AS "contractorVehicle"
        FROM routes r
        LEFT JOIN contractors c ON c.id = route_contractor_on(r.id, ${date}::date) AND c.deleted_at IS NULL
       WHERE r.deleted_at IS NULL AND r.active AND r.code <> 'DEMO'
         AND ${routeInScope(pgClient, "r.id", zoneId)}
       ORDER BY r.code
    ` as any[];
    const withTerms = [];
    for (const r of routes) {
      const terms = await termsOn(pgClient, r.id, date);
      withTerms.push({
        id: r.id, code: r.code, name: r.name,
        contractorId: r.contractorId, contractorName: r.contractorName, contractorPhone: r.contractorPhone,
        vehicleNumber: terms?.vehicleNumber || r.contractorVehicle || null,
        terms: terms ? { ...terms, perKmRate: perKmRate(terms) } : null,
      });
    }
    const products = (await productPricesOn(pgClient, date, null)).filter(p => p.price > 0);
    const [run] = await pgClient`
      SELECT status FROM dtc_bill_runs WHERE bill_month = ${date.slice(0, 7) + "-01"}::date
    ` as any[];
    return {
      date,
      // The date's month: null = bills not prepared yet; anything past 'draft' is locked.
      runStatus: (run?.status ?? null) as string | null,
      routes: withTerms,
      crateRate: await crateRateOn(pgClient, date),
      products: products.map(p => ({ id: p.id, code: p.code, name: p.name, fullName: p.full_name, unit: p.unit, price: round2(p.price) })),
    };
  });

  dtcRoute(app, "get", "/api/v1/officer-entries/lookups/dealers", "officer_entries.view", async (request) => {
    const { routeId } = parseWith(z.object({ routeId: z.string().uuid() }), request.query);
    await assertRouteInScope(pgClient, routeId, scopeZone(request));
    const rows = await pgClient`
      SELECT id, code, name, phone FROM dealers
       WHERE route_id = ${routeId}::uuid AND deleted_at IS NULL AND active
       ORDER BY code NULLS LAST, name
    `;
    return { data: rows };
  });

  // ── Photo upload (R2), same as product images ──
  dtcRoute(app, "post", "/api/v1/officer-entries/photo-presign", "officer_entries.manage", async (request, reply) => {
    const { filename, contentType } = parseWith(z.object({
      filename: z.string().min(1).max(200),
      contentType: z.enum(["image/jpeg", "image/png", "image/webp"]),
    }), request.body);
    const accountId = process.env.R2_ACCOUNT_ID;
    const accessKey = process.env.R2_ACCESS_KEY_ID;
    const secret = process.env.R2_SECRET_ACCESS_KEY;
    const bucket = process.env.R2_BUCKET_NAME;
    const publicBase = process.env.R2_PUBLIC_URL;
    if (!accountId || !accessKey || !secret || !bucket) {
      return reply.status(503).send({ error: "Not configured", message: "Photo storage is not set up on this server." });
    }
    const { S3Client, PutObjectCommand } = await import("@aws-sdk/client-s3");
    const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
    const ext = (filename.split(".").pop() ?? "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
    const key = `officer-entries/${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`;
    const s3 = new S3Client({
      region: "auto",
      endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: accessKey, secretAccessKey: secret },
      // See products.ts: no default checksum in a presigned browser PUT.
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
    const uploadUrl = await getSignedUrl(s3, new PutObjectCommand({ Bucket: bucket, Key: key, ContentType: contentType }), { expiresIn: 300 });
    const publicUrl = publicBase ? `${publicBase}/${key}` : uploadUrl.split("?")[0];
    return { uploadUrl, publicUrl };
  });

  // ── One entry ──
  dtcRoute(app, "get", "/api/v1/officer-entries/:id", "officer_entries.view", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const [entry] = await loadEntries(pgClient, { id, zoneId: scopeZone(request) });
    if (!entry) throw new HttpError(404, "Not found", "Entry not found.");
    return { entry };
  });

  // ── Create ──
  dtcRoute(app, "post", "/api/v1/officer-entries", "officer_entries.manage", async (request, reply) => {
    const body = parseWith(bodySchema, request.body);
    if (body.entryDate > istToday()) throw new HttpError(400, "Validation Error", "The date can't be in the future.");
    const { userId } = requestAdmin(request);
    const zoneId = scopeZone(request);
    const id = await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const route = await assertRouteInScope(tx, body.routeId, zoneId, body.entryDate);
      const month = await lockMonth(tx, body.entryDate, "added");
      const v = await computeEntry(tx, body);
      const [row] = await tx`
        INSERT INTO dtc_officer_entries (
          entry_date, route_id, contractor_id, shift, type, dealer_id, report_source, items,
          crates_sent, crates_returned, qty, unit, rate, km_expected, km_run, amount,
          reason, reference, remarks, photo_url, created_by, updated_by
        ) VALUES (
          ${body.entryDate}::date, ${body.routeId}::uuid, ${route.contractor_id}::uuid, ${body.shift}, ${body.type},
          ${v.dealerId}::uuid, ${v.reportSource}, ${JSON.stringify(v.items)}::jsonb,
          ${v.cratesSent}::int, ${v.cratesReturned}::int, ${v.qty}::numeric, ${v.unit}, ${v.rate}::numeric,
          ${v.kmExpected}::numeric, ${v.kmRun}::numeric, ${v.amount.toFixed(2)}::numeric,
          ${v.reason}, ${v.reference}, ${body.remarks || null}, ${body.photoUrl || null},
          ${userId}::uuid, ${userId}::uuid
        ) RETURNING id
      ` as any[];
      await refreshEntryLine(tx, row.id, month, userId, "added");
      return row.id as string;
    });
    const [entry] = await loadEntries(pgClient, { id, zoneId });
    await notifyShortage(request, entry, "recorded");
    return reply.status(201).send({ message: `Saved: ${entry?.headLabel ?? "entry"} ${inr(entry?.amount ?? 0)}`, entry });
  });

  // ── Update ──
  dtcRoute(app, "patch", "/api/v1/officer-entries/:id", "officer_entries.manage", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const body = parseWith(bodySchema, request.body);
    if (body.entryDate > istToday()) throw new HttpError(400, "Validation Error", "The date can't be in the future.");
    const { userId } = requestAdmin(request);
    const zoneId = scopeZone(request);
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const [old] = await tx`
        SELECT id, route_id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date FROM dtc_officer_entries
         WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE
      ` as any[];
      if (!old) throw new HttpError(404, "Not found", "Entry not found.");
      await assertRouteInScope(tx, old.route_id, zoneId);
      const route = await assertRouteInScope(tx, body.routeId, zoneId, body.entryDate);
      // Both months must be open: the line leaves the old month's bill and joins the new one's.
      const oldMonth = await lockMonth(tx, old.entry_date, "changed");
      const newMonth = old.entry_date.slice(0, 7) === body.entryDate.slice(0, 7)
        ? oldMonth : await lockMonth(tx, body.entryDate, "moved into that month");
      const v = await computeEntry(tx, body);
      await tx`
        UPDATE dtc_officer_entries SET
          entry_date = ${body.entryDate}::date, route_id = ${body.routeId}::uuid,
          contractor_id = ${route.contractor_id}::uuid, shift = ${body.shift}, type = ${body.type},
          dealer_id = ${v.dealerId}::uuid, report_source = ${v.reportSource}, items = ${JSON.stringify(v.items)}::jsonb,
          crates_sent = ${v.cratesSent}::int, crates_returned = ${v.cratesReturned}::int,
          qty = ${v.qty}::numeric, unit = ${v.unit}, rate = ${v.rate}::numeric,
          km_expected = ${v.kmExpected}::numeric, km_run = ${v.kmRun}::numeric, amount = ${v.amount.toFixed(2)}::numeric,
          reason = ${v.reason}, reference = ${v.reference}, remarks = ${body.remarks || null},
          photo_url = ${body.photoUrl || null}, updated_by = ${userId}::uuid, updated_at = now()
        WHERE id = ${id}::uuid
      `;
      await refreshEntryLine(tx, id, newMonth, userId, "changed");
      if (newMonth !== oldMonth) await refreshEntryLine(tx, id, oldMonth, userId, "moved to another month");
    });
    const [entry] = await loadEntries(pgClient, { id, zoneId });
    await notifyShortage(request, entry, "changed");
    return { message: `Updated: ${entry?.headLabel ?? "entry"} ${inr(entry?.amount ?? 0)}`, entry };
  });

  // ── Delete (soft) ──
  dtcRoute(app, "delete", "/api/v1/officer-entries/:id", "officer_entries.manage", async (request) => {
    const { id } = parseWith(uuidParam, request.params);
    const { userId } = requestAdmin(request);
    const zoneId = scopeZone(request);
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as Sql;
      const [old] = await tx`
        SELECT id, route_id, to_char(entry_date, 'YYYY-MM-DD') AS entry_date FROM dtc_officer_entries
         WHERE id = ${id}::uuid AND deleted_at IS NULL FOR UPDATE
      ` as any[];
      if (!old) throw new HttpError(404, "Not found", "Entry not found.");
      await assertRouteInScope(tx, old.route_id, zoneId);
      const month = await lockMonth(tx, old.entry_date, "removed");
      await tx`
        UPDATE dtc_officer_entries SET deleted_at = now(), deleted_by = ${userId}::uuid, updated_at = now()
         WHERE id = ${id}::uuid
      `;
      await refreshEntryLine(tx, id, month, userId, "deleted");
    });
    return { message: "Entry deleted" };
  });
}
