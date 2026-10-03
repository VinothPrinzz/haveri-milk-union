// ═══════════════════════════════════════════════════════════════════════
// Route code display.
//
// routes.code is globally unique, so DELETE /api/v1/routes/:id frees the R
// slot by renaming the row it soft-deletes to "__DEL_<first 8 of id>" before
// renumbering the survivors (routes/distribution.ts). The route itself stays,
// and so does everything already sold on it, so past dates still print it —
// but that marker is an internal artefact and must never reach a report.
//
// A deleted route therefore has no code. Reports show its name, which is what
// identifies the route on the sheet anyway, and leave the code blank.
// ═══════════════════════════════════════════════════════════════════════

export const RETIRED_CODE_PREFIX = "__DEL_";

/** Printable route code: blank once the code has been given up on delete. */
export function displayRouteCode(code: string | null | undefined): string {
  const c = code ?? "";
  return c.startsWith(RETIRED_CODE_PREFIX) ? "" : c;
}
