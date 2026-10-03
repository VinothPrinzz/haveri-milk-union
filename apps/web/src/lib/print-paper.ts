// apps/web/src/lib/print-paper.ts
// ════════════════════════════════════════════════════════════════════
// Paper-size selection for printed reports.
//
// The union still has a bundle of 15" × 12" continuous (dot-matrix)
// stationery left over from the old software and wants to print route
// sheets on it until the bundle runs out, then switch to A4. So the
// paper size is a user-visible choice, not a constant.
//
// One physical printer holds one kind of paper, so the choice is a
// single localStorage value shared by every report. It is broadcast on
// a window event, which keeps the Print menu and the Route Sheet's own
// Paper picker in sync AND lets height-paginated reports (Route Sheet)
// re-chunk their rows the moment the paper changes.
//
// Two things follow from the selection:
//   • the @page rule  → real sheet size + margins at print time
//   • <html data-print-paper="…"> → paper-specific print/screen CSS
// ════════════════════════════════════════════════════════════════════
import { useCallback, useEffect, useState } from "react";

export type Orientation = "portrait" | "landscape";
export type PaperId = "a4" | "cont15x12";

export interface PaperSpec {
  id: PaperId;
  /** Full name for menus. */
  label: string;
  /** Compact badge shown on the Print button. */
  short: string;
  /** Long physical edge, in mm. */
  longMm: number;
  /** Short physical edge, in mm. */
  shortMm: number;
  /** Printable margins, in mm. */
  margin: { top: number; right: number; bottom: number; left: number };
  /** CSS `@page { size: … }` value for the given orientation. */
  cssSize: (orient: Orientation) => string;
}

export const PAPERS: Record<PaperId, PaperSpec> = {
  a4: {
    id: "a4",
    label: "A4 (210 × 297 mm)",
    short: "A4",
    longMm: 297,
    shortMm: 210,
    margin: { top: 14, right: 12, bottom: 16, left: 12 },
    cssSize: (orient) => `A4 ${orient}`,
  },
  cont15x12: {
    id: "cont15x12",
    // Indian continuous stationery, quoted width × depth in inches:
    // 15" across (132-column) by 12" deep — fed long-edge first, which
    // is why landscape is its natural orientation.
    label: '15" × 12" continuous (381 × 305 mm)',
    short: "15×12",
    longMm: 381, // 15 in
    shortMm: 305, // 12 in
    // Side margins clear the 0.5" tractor-feed strips so nothing lands
    // on (or is lost with) the sprocket edges if they are torn off.
    margin: { top: 10, right: 15, bottom: 10, left: 15 },
    cssSize: (orient) =>
      orient === "portrait" ? "12in 15in" : "15in 12in",
  },
};

export const DEFAULT_PAPER: PaperId = "a4";

const PAPER_KEY = "erp:printPaper";
const ORIENT_KEY = "erp:printOrient";
const PAPER_EVENT = "erp:print-paper-change";
// Kept from the orientation-only implementation so an older tag left in
// <head> by a previous render is replaced, never duplicated.
const STYLE_ID = "erp-print-orient";

/* ── Persisted selection ─────────────────────────────────────────── */

export function getPrintPaper(): PaperId {
  if (typeof window === "undefined") return DEFAULT_PAPER;
  const raw = window.localStorage.getItem(PAPER_KEY);
  return raw && raw in PAPERS ? (raw as PaperId) : DEFAULT_PAPER;
}

export function setPrintPaper(id: PaperId) {
  try {
    window.localStorage.setItem(PAPER_KEY, id);
  } catch {}
  reflectPaperOnRoot(id);
  window.dispatchEvent(new CustomEvent(PAPER_EVENT, { detail: id }));
}

export function getPrintOrientation(): Orientation | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(ORIENT_KEY);
  return raw === "portrait" || raw === "landscape" ? raw : null;
}

/* ── Applying the selection ──────────────────────────────────────── */

/** Mirrors the paper onto <html> so CSS can key off it. */
function reflectPaperOnRoot(id: PaperId) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.printPaper = id;
}

/**
 * Mounts (or replaces) the `<style id="erp-print-orient">` tag that sets
 * the sheet size and margins for the next print. Pass `null` for the
 * paper to fall back to the browser's own page setup.
 */
export function applyPrintPageSetup(
  paper: PaperId | null,
  orient: Orientation | null
) {
  document.getElementById(STYLE_ID)?.remove();
  if (!paper || !orient) return;

  const spec = PAPERS[paper] ?? PAPERS[DEFAULT_PAPER];
  const m = spec.margin;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent =
    `@media print { @page { size: ${spec.cssSize(orient)}; ` +
    `margin: ${m.top}mm ${m.right}mm ${m.bottom}mm ${m.left}mm; } }`;
  document.head.appendChild(style);
  reflectPaperOnRoot(spec.id);
}

/* ── Geometry helpers ────────────────────────────────────────────── */

/** Printable area of a sheet, in mm, after margins. */
export function usablePageMm(paper: PaperId, orient: Orientation) {
  const spec = PAPERS[paper] ?? PAPERS[DEFAULT_PAPER];
  const w = orient === "landscape" ? spec.longMm : spec.shortMm;
  const h = orient === "landscape" ? spec.shortMm : spec.longMm;
  return {
    widthMm: w - spec.margin.left - spec.margin.right,
    heightMm: h - spec.margin.top - spec.margin.bottom,
  };
}

/* ── React binding ───────────────────────────────────────────────── */

/**
 * Subscribes to the shared paper choice. Every control that can read or
 * change the paper uses this, so a change made in the Print menu is seen
 * immediately by the Route Sheet's pagination (and vice versa).
 */
export function usePrintPaper(): [PaperId, (id: PaperId) => void] {
  const [paper, setPaper] = useState<PaperId>(getPrintPaper);

  useEffect(() => {
    reflectPaperOnRoot(paper);
  }, [paper]);

  useEffect(() => {
    const sync = () => setPaper(getPrintPaper());
    window.addEventListener(PAPER_EVENT, sync);
    // Another tab (e.g. the ?clean=1 print view) changing the setting.
    window.addEventListener("storage", sync);
    return () => {
      window.removeEventListener(PAPER_EVENT, sync);
      window.removeEventListener("storage", sync);
    };
  }, []);

  const choose = useCallback((id: PaperId) => setPrintPaper(id), []);
  return [paper, choose];
}
