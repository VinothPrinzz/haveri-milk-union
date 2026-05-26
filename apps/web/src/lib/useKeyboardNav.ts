import { useEffect } from "react";

/**
 * App-wide keyboard navigation.
 *  - Tab / Shift+Tab  → cycle regions: content ⇄ sidebar ⇄ topbar
 *  - Arrows           → roving highlight inside sidebar / topbar
 *  - Enter (content)  → advance to the next input field
 * Mount once, in AppLayout. Regions are found via [data-kbd-region].
 */

type Region = "topbar" | "sidebar" | "content";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  'input:not([disabled]):not([type="hidden"])',
  "select:not([disabled])",
  "textarea:not([disabled])",
  '[tabindex]:not([tabindex="-1"])',
].join(",");

function isVisible(el: HTMLElement) {
  return !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
}

function focusablesIn(root: Element | null): HTMLElement[] {
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(isVisible);
}

function regionEl(region: Region): Element | null {
  return document.querySelector(`[data-kbd-region="${region}"]`);
}

function regionOf(el: Element | null): Region {
  const host = el?.closest("[data-kbd-region]") as HTMLElement | null;
  return (host?.dataset.kbdRegion as Region) || "content";
}

/** A modal / popover / command palette is open — hand control back to the browser. */
function overlayOpen(): boolean {
  return !!document.querySelector(
    '[role="dialog"],[data-radix-popper-content-wrapper],[data-kbd-modal]',
  );
}

/** Move focus into a region; prefer its active item, then first input, then first focusable. */
function focusRegion(region: Region): boolean {
  const root = regionEl(region);
  if (!root) return false;
  const items = focusablesIn(root);
  if (items.length === 0) return false;
  const active = items.find((el) => el.getAttribute("aria-current") === "page");
  const firstField = items.find((el) =>
    ["INPUT", "SELECT", "TEXTAREA"].includes(el.tagName),
  );
  (active ?? (region === "content" ? firstField ?? items[0] : items[0])).focus();
  return true;
}

export function useKeyboardNav() {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Runs in the CAPTURE phase (see addEventListener below) — i.e. before
      // React's own handlers. When we decide to act on a key we call
      // stopPropagation() so the focused control (a Radix Select, an F9
      // lookup, etc.) never receives it. That is what guarantees an arrow
      // key moves between fields and never opens a dropdown.
      //
      // If a dropdown / dialog / command palette is already open, we stand
      // down completely so its own keys (↑/↓ to pick an option) still work.
      if (e.defaultPrevented || overlayOpen()) return;

      const active = document.activeElement as HTMLElement | null;
      const region = regionOf(active);

      // ── Tab: cycle regions  content → sidebar → topbar → content ──────
      if (e.key === "Tab") {
        const order = (["content", "sidebar", "topbar"] as Region[]).filter((r) =>
          regionEl(r),
        );
        if (order.length < 2) return;
        const i = order.indexOf(region);
        const next = e.shiftKey
          ? order[(i - 1 + order.length) % order.length]
          : order[(i + 1) % order.length];
        if (focusRegion(next)) {
          e.preventDefault();
          e.stopPropagation();
        }
        return;
      }

      // Helper: focus the previous / next focusable within a region.
      const move = (region: Region, step: 1 | -1) => {
        const items = focusablesIn(regionEl(region));
        if (items.length === 0) return;
        const idx = active ? items.indexOf(active) : -1;
        const target = items[(idx + step + items.length) % items.length];
        target?.focus();
        try {
          (target as HTMLInputElement)?.select?.();
        } catch {
          /* not a text input — ignore */
        }
      };

      // ── Enter inside CONTENT: advance to the next field ───────────────
      if (e.key === "Enter" && region === "content") {
        const tag = active?.tagName;
        const type = (active as HTMLInputElement | null)?.type;
        const isTextInput =
          tag === "INPUT" &&
          !["button", "submit", "reset", "checkbox", "radio", "file"].includes(type ?? "");
        if (!isTextInput) return; // buttons / links / textareas keep default
        e.preventDefault(); // also suppresses implicit <form> submit ("Enter to save")
        e.stopPropagation();
        move("content", e.shiftKey ? -1 : 1);
        return;
      }

      // ── Arrows: move between fields (content) or nav items (side/top) ──
      // In CONTENT only ↑/↓ are used, so ←/→ stay free for the text cursor.
      // In sidebar/topbar both axes work. Because this runs in the capture
      // phase and we stopPropagation(), the key never reaches a Radix Select
      // / F9 lookup — so an arrow ONLY moves between inputs, it never opens
      // or changes a dropdown. (An already-open dropdown was handled by the
      // overlayOpen() bail-out at the top.)
      {
        const goPrev =
          e.key === "ArrowUp" || (region !== "content" && e.key === "ArrowLeft");
        const goNext =
          e.key === "ArrowDown" || (region !== "content" && e.key === "ArrowRight");
        if (!goPrev && !goNext) return;

        if (region === "content" && active?.tagName === "TEXTAREA") {
          return; // a textarea genuinely needs ↑/↓ to move between its lines
        }
        e.preventDefault();
        e.stopPropagation();
        move(region, goNext ? 1 : -1);
        // Enter on a focused sidebar/topbar <a> navigates natively.
      }
    };

    // Capture phase (third arg `true`) is essential: it lets us intercept the
    // key before Radix / F9 / native controls can react to it.
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
}

/**
 * Ctrl+S / Cmd+S → save. Use inside any form component.
 * Pass the form's submit handler (e.g. form.handleSubmit(onValid)).
 */
export function useSaveShortcut(onSave: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const h = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        onSave();
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onSave, enabled]);
}