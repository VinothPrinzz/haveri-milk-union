// India Standard Time helpers.
//
// `new Date().toISOString().slice(0, 10)` is the UTC date, which is still
// yesterday in India until 05:30 IST. Every "today" default on the admin must
// match the business day the API uses (see apps/api/src/lib/ist-date.ts), so
// derive it by shifting the clock to IST before taking the date part.

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

/** Today's date in IST, as YYYY-MM-DD. */
export function todayIST(): string {
  return new Date(Date.now() + IST_OFFSET_MS).toISOString().slice(0, 10);
}
