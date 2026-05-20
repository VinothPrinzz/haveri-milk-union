import { create } from "zustand";

/**
 * useTargetDateStore — global "which date am I editing?" state.
 *
 * Shared by every tab so that:
 *   • Home's "Adding to: Today" pill knows what date it's targeting
 *   • Tapping `+` on a product card adds to the right date's draft
 *   • Indent tab reads the same state and pre-selects that date in
 *     its date strip
 *   • Categories tab uses the same target when adding from a
 *     category-detail view
 *
 * Default behavior:
 *   • selectedDate starts as today's IST date.
 *   • When today's ordering window closes, callers can call
 *     advanceIfNeeded(closeTimeIsoIst) to flip the target to tomorrow.
 *     This is opt-in — some flows (Orders tab viewing today's locked
 *     order) want to keep the target on today.
 *
 * Date format throughout: ISO YYYY-MM-DD in IST. We deliberately do
 * NOT use Date objects in state — they serialize badly and IST date
 * math gets gnarly across day boundaries. Stick to strings; convert
 * at the display layer.
 */

interface TargetDateState {
  selectedDate: string; // YYYY-MM-DD in IST

  // ── Setters ─────────────────────────────────────────────────────
  setSelectedDate: (date: string) => void;
  resetToToday: () => void;

  /**
   * If `selectedDate` is today's IST date AND the window for today
   * has closed, advance to tomorrow. Called by AppHeader/DatePill on
   * window-status updates so the dealer isn't left targeting a
   * locked day.
   *
   * Returns true if a change was made.
   */
  advanceIfWindowClosed: (windowClosedForToday: boolean) => boolean;
}

// ── Date helpers ─────────────────────────────────────────────────
// IST is UTC+5:30 with no DST, so we can do this without a TZ library.
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export function istTodayIso(): string {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS);
  return nowIst.toISOString().slice(0, 10);
}

export function istTomorrowIso(): string {
  const nowIst = new Date(Date.now() + IST_OFFSET_MS + 86_400_000);
  return nowIst.toISOString().slice(0, 10);
}

export function addDaysIst(isoDate: string, days: number): string {
  // isoDate is already a calendar date string — just add days as ms.
  const base = new Date(isoDate + "T00:00:00.000Z");
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}

/** Human-readable label for an ISO date relative to today (IST). */
export function relativeLabel(isoDate: string): string {
  const today = istTodayIso();
  const tomorrow = istTomorrowIso();
  if (isoDate === today) return "Today";
  if (isoDate === tomorrow) return "Tomorrow";

  // For dates further out, return "Wed 21" style.
  const d = new Date(isoDate + "T00:00:00.000Z");
  const weekday = d.toLocaleDateString("en-IN", { weekday: "short" });
  const day = d.getUTCDate();
  return `${weekday} ${day}`;
}

// ── Store ──────────────────────────────────────────────────────────
export const useTargetDateStore = create<TargetDateState>((set, get) => ({
  selectedDate: istTodayIso(),

  setSelectedDate: (date) => set({ selectedDate: date }),
  resetToToday: () => set({ selectedDate: istTodayIso() }),

  advanceIfWindowClosed: (windowClosedForToday) => {
    const today = istTodayIso();
    const current = get().selectedDate;
    if (windowClosedForToday && current === today) {
      set({ selectedDate: istTomorrowIso() });
      return true;
    }
    return false;
  },
}));