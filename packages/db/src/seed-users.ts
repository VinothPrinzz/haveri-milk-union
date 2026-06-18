/**
 * Seed admin/ERP user logins for Haveri Milk Union.
 * Run with: pnpm --filter @hmu/db seed:users
 *
 * Creates the operational staff accounts the union actually uses, mapped onto
 * the system's role enum (see packages/db/src/schema/enums.ts):
 *
 *   Business group            → role             → what it can do
 *   ──────────────────────────────────────────────────────────────────────
 *   Manager        (2)        → manager          orders / dealers / routes mgmt
 *   Indent         (3)        → call_desk        record & edit dealer indents
 *   FGS            (2)        → dispatch_officer  stock entry + dispatch
 *   Route officer  (6)        → officer          direct sales / gate pass
 *   Finance        (2)        → accountant       finance incl. credit limits
 *
 * Idempotent: re-running upserts on username (refreshes name/role/password).
 *
 * Default password is "password123" for every account — override with the
 * SEED_USER_PASSWORD env var. Tell staff to change it on first login.
 *
 * Prerequisites:
 *   1. DATABASE_URL is set in .env
 *   2. Migrations are applied (users table + username column — migration 0024)
 */

import dotenv from "dotenv";
import path from "path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import postgres from "postgres";
import bcrypt from "bcryptjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("❌ Missing DATABASE_URL in .env");
  process.exit(1);
}

const DEFAULT_PASSWORD = process.env.SEED_USER_PASSWORD || "password123";
const EMAIL_DOMAIN = "haverimilkunion.coop";

type Role =
  | "super_admin" | "manager" | "dispatch_officer"
  | "accountant" | "call_desk" | "officer" | "viewer"
  | "fgs_milk_curd" | "fgs_others";

interface SeedUser {
  name: string;
  username: string;
  role: Role;
  phone?: string;
  email?: string; // defaults to <username>@haverimilkunion.coop
}

// ── The staff roster ────────────────────────────────────────────────────
// NOTE: All non-FGS accounts are already seeded. They're commented out so a
// re-run only upserts the two FGS logins (whose roles changed to the bucket-
// scoped fgs_milk_curd / fgs_others). Un-comment to re-seed the full roster.
const USERS: SeedUser[] = [
  // // Managers (2)
  // { name: "Prashant",            username: "prashant",  role: "manager" },
  // { name: "Ramya",               username: "ramya",     role: "manager" },

  // // Indent operators (3) — record/edit dealer indents
  // { name: "Indent Operator 1",   username: "indent1",   role: "call_desk" },
  // { name: "Indent Operator 2",   username: "indent2",   role: "call_desk" },
  // { name: "Indent Operator 3",   username: "indent3",   role: "call_desk" },

  // FGS — Finished Goods Store (2): one per product line. Bucket-scoped roles
  // limit each operator's stock view/entry to their own SK diary.
  { name: "SKA Dairy (FGS)",         username: "fgs_ska",    role: "fgs_milk_curd" },
  { name: "Other Products (FGS)",    username: "fgs_others", role: "fgs_others" },

  // // Route officers (6) — direct sales / gate pass
  // { name: "Route Officer 1",     username: "route1",    role: "officer" },
  // { name: "Route Officer 2",     username: "route2",    role: "officer" },
  // { name: "Route Officer 3",     username: "route3",    role: "officer" },
  // { name: "Route Officer 4",     username: "route4",    role: "officer" },
  // { name: "Route Officer 5",     username: "route5",    role: "officer" },
  // { name: "Route Officer 6",     username: "route6",    role: "officer" },

  // // Finance (2) — accountants; only role that may edit credit limits
  // { name: "Finance Officer 1",   username: "finance1",  role: "accountant" },
  // { name: "Finance Officer 2",   username: "finance2",  role: "accountant" },
];

const sql = postgres(DATABASE_URL, { max: 1 });

async function seedUsers() {
  console.log("🔑 Seeding ERP user logins...\n");

  // bcrypt cost 12 — matches hashPassword() in apps/api/src/lib/auth.ts
  const passwordHash = await bcrypt.hash(DEFAULT_PASSWORD, 12);

  let created = 0;
  let updated = 0;

  for (const u of USERS) {
    const email = u.email ?? `${u.username}@${EMAIL_DOMAIN}`;
    const [row] = await sql`
      INSERT INTO users (name, username, email, password_hash, role, phone, active)
      VALUES (
        ${u.name}, ${u.username}, ${email}, ${passwordHash},
        ${u.role}::user_role, ${u.phone ?? null}, true
      )
      ON CONFLICT (username) WHERE deleted_at IS NULL DO UPDATE SET
        name          = EXCLUDED.name,
        email         = EXCLUDED.email,
        password_hash = EXCLUDED.password_hash,
        role          = EXCLUDED.role,
        phone         = EXCLUDED.phone,
        active        = true,
        deleted_at    = NULL,
        updated_at    = now()
      RETURNING (xmax = 0) AS inserted
    `;
    if (row?.inserted) created++; else updated++;
    console.log(`  ✅ ${u.username.padEnd(12)} ${u.role.padEnd(16)} ${u.name}`);
  }

  console.log(
    `\n🎉 Done — ${created} created, ${updated} updated (${USERS.length} total).`,
  );
  console.log(`   Login with username + password: "${DEFAULT_PASSWORD}"`);
  console.log(`   ⚠️  Ask each user to change their password after first login.\n`);

  await sql.end();
}

seedUsers()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error("❌ Seed failed:", err);
    process.exit(1);
  });
