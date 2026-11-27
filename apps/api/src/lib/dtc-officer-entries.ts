// apps/api/src/lib/dtc-officer-entries.ts
// ═══════════════════════════════════════════════════════════════════════
// Contractor entries recorded by route officers → DTC bill lines.
//
// Each live entry becomes one automatic line on its route's bill for the
// entry's month (source 'auto', source_ref = entry id):
//
//   short_supply      deduction  short_supply
//   product_shortage  deduction  packet
//   crate_shortage    deduction  crate
//   km_short          deduction  km
//   penalty           deduction  penalty
//   extra_km          earning    extra_km
//   extra_trip        earning    extra_trip
//
// The entry's amount was worked out by the API when it was saved (see
// routes/officer-entries.ts); the line copies it. Bill generation
// (refreshAutoLines in dtc.ts) rebuilds these lines with the others, and
// saving an entry refreshes its own line while the month is a draft.
// A line Marketing removed is listed in dtc_bills.suppressed_auto and is
// not put back.
// ═══════════════════════════════════════════════════════════════════════
import type { pgClient } from "./db.js";

type Sql = typeof pgClient;

export const ENTRY_TYPES = [
  "short_supply", "crate_shortage", "product_shortage", "km_short", "extra_km", "extra_trip", "penalty",
] as const;
export type EntryType = (typeof ENTRY_TYPES)[number];

export const ENTRY_LINE: Record<EntryType, { kind: "earning" | "deduction"; head: string }> = {
  short_supply:     { kind: "deduction", head: "short_supply" },
  product_shortage: { kind: "deduction", head: "packet" },
  crate_shortage:   { kind: "deduction", head: "crate" },
  km_short:         { kind: "deduction", head: "km" },
  penalty:          { kind: "deduction", head: "penalty" },
  extra_km:         { kind: "earning",   head: "extra_km" },
  extra_trip:       { kind: "earning",   head: "extra_trip" },
};

export const REPORT_SOURCE_LABEL: Record<string, string> = {
  customer_call: "Customer phoned",
  officer_visit: "Found on visit",
  dispatch_check: "Dispatch check",
  return_check: "Return check",
  on_route: "On the route",
};
export const PENALTY_REASON_LABEL: Record<string, string> = {
  late_arrival: "Late arrival (over 1 hour)",
  not_clean: "Vehicle or crates not clean",
  misbehaviour: "Misbehaviour with customer",
  other: "Other",
};

export interface EntryItem { productId: string; name: string; qty: number; rate: number; amount: number }

/** An entry with what its bill line needs (dealer joined). */
export interface EntryLineRow {
  id: string;
  route_id: string;
  entry_date: string;          // YYYY-MM-DD
  shift: string;
  type: EntryType;
  dealer_code: string | null;
  dealer_name: string | null;
  report_source: string | null;
  items: EntryItem[] | null;
  crates_sent: number | null;
  crates_returned: number | null;
  qty: number | null;
  /** What qty counts: 'km' | 'trip' | 'crate' | 'packet' */
  unit: string | null;
  rate: number | null;
  km_expected: number | null;
  km_run: number | null;
  amount: number;
  reason: string | null;
  reference: string | null;
}

const nice = (n: number | null | undefined) =>
  (Number(n) || 0).toLocaleString("en-IN", { maximumFractionDigits: 3 });

/** "26-11", plus "eve" for the evening shift. */
function dayLabel(e: Pick<EntryLineRow, "entry_date" | "shift">) {
  const [, m, d] = e.entry_date.slice(0, 10).split("-");
  return `${d}-${m}${e.shift === "evening" ? " eve" : ""}`;
}

/** "24 toned 500 ml, 12 curd 500 g" */
export function itemsText(items: EntryItem[] | null | undefined) {
  return (items ?? []).map(i => `${nice(i.qty)} ${i.name}`).join(", ");
}

/** The bill line an entry becomes. */
export function entryLine(e: EntryLineRow) {
  const { kind, head } = ENTRY_LINE[e.type];
  const parts: string[] = [];
  let qty: number | null = null;
  let rate: number | null = null;
  switch (e.type) {
    case "short_supply": {
      const who = [e.dealer_code, e.dealer_name].filter(Boolean).join(" ");
      if (who) parts.push(who);
      parts.push(itemsText(e.items));
      qty = (e.items ?? []).reduce((s, i) => s + Number(i.qty || 0), 0);
      break;
    }
    case "product_shortage": {
      const who = [e.dealer_code, e.dealer_name].filter(Boolean).join(" ");
      if (who) parts.push(who);
      if (e.report_source) parts.push(REPORT_SOURCE_LABEL[e.report_source] ?? e.report_source);
      parts.push(itemsText(e.items));
      qty = (e.items ?? []).reduce((s, i) => s + Number(i.qty || 0), 0);
      break;
    }
    case "crate_shortage":
      parts.push(`${nice(e.qty)} crates short (${nice(e.crates_sent)} sent, ${nice(e.crates_returned)} returned)`);
      qty = e.qty; rate = e.rate;
      break;
    case "km_short":
      parts.push(`${nice(e.qty)} km short (route ${nice(e.km_expected)} km, ran ${nice(e.km_run)} km)`);
      if (e.reason) parts.push(e.reason);
      qty = e.qty; rate = e.rate;
      break;
    case "extra_km":
    case "extra_trip":
      // An extra trip is paid per trip on a trip-basis route, per km otherwise.
      parts.push(e.type === "extra_km" ? `${nice(e.qty)} extra km`
        : e.unit === "trip" ? `${nice(e.qty)} extra trip${Number(e.qty) === 1 ? "" : "s"}`
        : `Extra trip, ${nice(e.qty)} km`);
      if (e.reason) parts.push(e.reason);
      qty = e.qty; rate = e.rate;
      break;
    case "penalty":
      parts.push(PENALTY_REASON_LABEL[e.reason ?? ""] ?? e.reason ?? "Penalty");
      if (e.reference) parts.push(e.reference);
      break;
  }
  const detail = parts.filter(Boolean).join(" · ");
  return {
    kind, head, qty, rate,
    amount: Math.round(Number(e.amount) * 100) / 100,
    /** What happened, without the date (the entries list shows the date apart). */
    detail,
    /** The bill line's remarks: "26-11 · D-3107 Sri Siddeshwara Milk Agency · 24 toned 500 ml" */
    remarks: [dayLabel(e), detail].filter(Boolean).join(" · "),
  };
}

/**
 * Live entries dated in [from, to], optionally just one. Read for bill
 * generation and for refreshing one entry's line.
 */
export async function loadEntryLineRows(sql: Sql, from: string, to: string, entryId?: string) {
  return await sql`
    SELECT e.id, e.route_id, to_char(e.entry_date, 'YYYY-MM-DD') AS entry_date, e.shift, e.type,
           d.code AS dealer_code, d.name AS dealer_name, e.report_source, e.items,
           e.crates_sent, e.crates_returned, e.qty::float8 AS qty, e.unit, e.rate::float8 AS rate,
           e.km_expected::float8 AS km_expected, e.km_run::float8 AS km_run,
           e.amount::float8 AS amount, e.reason, e.reference
      FROM dtc_officer_entries e
      LEFT JOIN dealers d ON d.id = e.dealer_id
     WHERE e.deleted_at IS NULL
       AND e.entry_date >= ${from}::date AND e.entry_date <= ${to}::date
       AND (${entryId ?? null}::uuid IS NULL OR e.id = ${entryId ?? null}::uuid)
     ORDER BY e.entry_date, e.created_at
  ` as any[] as EntryLineRow[];
}
