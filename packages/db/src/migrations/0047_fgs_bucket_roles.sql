-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0047: Bucket-scoped FGS roles
--
-- The plant runs two physical SK diaries — one for Milk + Curd, another for
-- everything else (see apps/web/src/lib/stock-buckets.ts). Until now both FGS
-- data-entry accounts shared the generic `dispatch_officer` role, so RBAC could
-- not stop the Milk & Curd operator from editing Other-Products stock and vice
-- versa.
--
-- These two roles carry the SAME FGS capabilities as dispatch_officer, but the
-- inventory (stock) view/entry endpoints scope them to a single bucket — see
-- bucketsForRole() in apps/api/src/routes/inventory.ts.
--
--   • fgs_milk_curd → Stock Entry / Overview limited to Milk & Curd
--   • fgs_others    → Stock Entry / Overview limited to Other Products
--
-- NOTE: ALTER TYPE ... ADD VALUE is safe here (PG 12+) because the new values
-- are NOT referenced elsewhere in this same migration. The seed reassigns the
-- two FGS accounts to these roles (see packages/db/src/seed-users.ts).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'fgs_milk_curd';
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'fgs_others';
