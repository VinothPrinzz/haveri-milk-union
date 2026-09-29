import { z } from "zod";

/**
 * A real calendar date, not just the right shape. A syntactically-valid-but-
 * impossible value like 2026-13-99 would otherwise sail through and silently
 * produce a nonsense period instead of an error.
 */
export const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD")
  .refine((s) => {
    const d = new Date(s + "T00:00:00Z");
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, "not a valid calendar date");

/**
 * IST calendar day — the union books everything on Asia/Kolkata dates.
 * The API runs in UTC, so `new Date().toISOString()` would resolve to
 * YESTERDAY between 00:00 and 05:30 IST. Never use it for a booking date.
 */
export function istToday(): string {
  return new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
}

/**
 * The same rule, in SQL — written out, not exported.
 *
 * A day here runs 00:00:00 to 23:59:59 IST. Postgres does not know that:
 * the API connects to Supabase without a TimeZone, so the session runs in
 * UTC and every unqualified date expression yields a UTC day, which begins
 * at 05:30 IST. That put anything happening between midnight and 05:29 IST
 * on the previous day — at 02:00 IST the Finance Dashboard's "Collected
 * today" was showing Rs.6.09 lakh of the PREVIOUS day's receipts, and a
 * payment taken at 02:00 counted towards neither day on screen.
 *
 * Setting the session TimeZone would fix it in one line, but Supabase's
 * transaction pooler drops the TimeZone startup parameter (probed against
 * aws-1-ap-south-1.pooler.supabase.com:6543 — it never reaches the
 * backend), and a bare `SET TIME ZONE` leaks between clients sharing a
 * pooled server connection. So the conversion is spelled out at every site
 * that computes a day:
 *
 *     CURRENT_DATE, now()::date  ->  (now() AT TIME ZONE 'Asia/Kolkata')::date
 *     <timestamptz>::date        ->  (<col> AT TIME ZONE 'Asia/Kolkata')::date
 *
 * It is written literally rather than interpolated from a constant because
 * a plain string in a postgres.js template is sent as a BIND PARAMETER,
 * not as SQL — `sql`SELECT ${FRAG}`` returns the text of the fragment, not
 * a date. Inlining also keeps every site greppable, which is how the ~100
 * pre-existing `AT TIME ZONE 'Asia/Kolkata'` call sites already read.
 *
 * A `date` column needs no conversion: it carries no time zone and is
 * already the day it says it is. Only timestamptz has to be converted.
 */
