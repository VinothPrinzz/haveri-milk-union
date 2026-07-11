-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0045: Add a read-only `viewer` role to user_role
-- The viewer role is granted ONLY *.view permissions in the API middleware
-- (apps/api/src/middleware/admin-auth.ts) — it can browse every module but
-- every create/update/delete/manage endpoint returns 403.
--
-- NOTE: ALTER TYPE ... ADD VALUE is safe inside this migration's transaction
-- (PG 12+) because the new value is NOT used elsewhere in the same migration.
-- The viewer user itself is created separately (see seed-viewer.ts).
-- ─────────────────────────────────────────────────────────────────────────────

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'viewer';
