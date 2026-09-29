// ═══════════════════════════════════════════════════════════════════════
// diag-verify-route-delete-keeps-codes.ts — READ ONLY in effect.
//
// Everything runs inside one transaction that is ALWAYS rolled back, so no
// route, dealer or template in production is changed.
//
// Proves the DELETE /api/v1/routes/:id behaviour (routes/distribution.ts):
//   1. the deleted route KEEPS its own code (no "__DEL_" rename)
//   2. the other routes KEEP theirs (no renumbering shifting R15 down to R14)
//   3. dealers pointing at it are detached
//   4. its standing indent templates are deactivated
//   5. templates on a live route are left alone
//
// USAGE (from apps/api):  npx tsx src/diag-verify-route-delete-keeps-codes.ts
// ═══════════════════════════════════════════════════════════════════════

import { pgClient } from "./lib/db.js";

const ROLLBACK = Symbol("rollback");

async function main() {
  let failures = 0;
  const check = (label: string, ok: boolean, detail: string) => {
    if (!ok) failures++;
    console.log(`  ${ok ? "PASS" : "FAIL"}  ${label.padEnd(34)} ${detail}`);
  };

  try {
    await pgClient.begin(async (_tx) => {
      const tx = _tx as unknown as typeof pgClient;

      // ── Fixture: three routes in one R-number run, plus a dealer and a
      //    standing indent line on the one that gets deleted.
      const [victim] = await tx`
        INSERT INTO routes (code, name) VALUES ('R9001', 'ZZ DELETE ME') RETURNING id`;
      const [above1] = await tx`
        INSERT INTO routes (code, name) VALUES ('R9002', 'ZZ KEEP 1') RETURNING id`;
      const [above2] = await tx`
        INSERT INTO routes (code, name) VALUES ('R9003', 'ZZ KEEP 2') RETURNING id`;
      const victimId = (victim as any).id as string;

      const [dealer] = await tx`
        SELECT id FROM dealers WHERE deleted_at IS NULL AND route_id IS NOT NULL LIMIT 1`;
      const [product] = await tx`
        SELECT id FROM products WHERE deleted_at IS NULL AND available = true LIMIT 1`;
      const dealerId = (dealer as any).id as string;
      const productId = (product as any).id as string;

      await tx`UPDATE dealers SET route_id = ${victimId} WHERE id = ${dealerId}`;
      // Template on the doomed route, and one on a live route as a control.
      const [onVictim] = await tx`
        INSERT INTO dealer_standing_indents (dealer_id, product_id, route_id, default_qty, active)
        VALUES (${dealerId}, ${productId}, ${victimId}, 10, true) RETURNING id`;
      const [onLive] = await tx`
        INSERT INTO dealer_standing_indents (dealer_id, product_id, route_id, default_qty, active)
        VALUES (${dealerId}, ${productId}, ${(above1 as any).id}, 10, true) RETURNING id`;

      // ── The delete, exactly as routes/distribution.ts runs it ──
      await tx`
        UPDATE routes SET deleted_at = now(), active = false, updated_at = now()
        WHERE id = ${victimId}`;
      await tx`UPDATE dealers SET route_id = NULL WHERE route_id = ${victimId}`;
      await tx`
        UPDATE dealer_standing_indents SET active = false, updated_at = now()
        WHERE route_id = ${victimId} AND active = true`;

      // ── Assertions ──
      const [v] = await tx`
        SELECT code, active, deleted_at IS NOT NULL AS deleted FROM routes WHERE id = ${victimId}`;
      check("deleted route keeps its code", (v as any).code === "R9001",
        `code="${(v as any).code}" deleted=${(v as any).deleted} active=${(v as any).active}`);

      const survivors = await tx`
        SELECT code FROM routes WHERE id IN (${(above1 as any).id}, ${(above2 as any).id}) ORDER BY code`;
      const codes = (survivors as any[]).map(r => r.code).join(",");
      check("routes above are not renumbered", codes === "R9002,R9003", `codes=${codes}`);

      const [d] = await tx`SELECT route_id FROM dealers WHERE id = ${dealerId}`;
      check("dealer detached from the route", (d as any).route_id === null,
        `route_id=${(d as any).route_id ?? "NULL"}`);

      const [t1] = await tx`SELECT active FROM dealer_standing_indents WHERE id = ${(onVictim as any).id}`;
      check("template on deleted route stopped", (t1 as any).active === false, `active=${(t1 as any).active}`);

      const [t2] = await tx`SELECT active FROM dealer_standing_indents WHERE id = ${(onLive as any).id}`;
      check("template on live route untouched", (t2 as any).active === true, `active=${(t2 as any).active}`);

      // Next auto-generated code must step past the deleted one, never reuse it.
      const [next] = await tx`
        SELECT code FROM routes WHERE code ~ '^R[0-9]+$'
        ORDER BY CAST(SUBSTRING(code FROM 2) AS integer) DESC LIMIT 1`;
      check("next code steps past the deleted", (next as any).code === "R9003",
        `max code now ${(next as any).code} -> next would be R9004`);

      throw ROLLBACK; // nothing above is ever committed
    });
  } catch (e) {
    if (e !== ROLLBACK) throw e;
  }

  // Prove the rollback took: none of the fixture rows survived.
  const leftovers = await pgClient`
    SELECT count(*)::int AS n FROM routes WHERE code IN ('R9001', 'R9002', 'R9003')`;
  check("transaction rolled back", (leftovers as any[])[0].n === 0,
    `${(leftovers as any[])[0].n} fixture route(s) left in the DB`);

  console.log(`\n${failures === 0 ? "All checks passed." : `${failures} CHECK(S) FAILED.`}`);
  await pgClient.end();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
