-- ─────────────────────────────────────────────────────────────────────────────
-- Migration 0024: Add `username` column to `users` table
-- Admins now log in with a short username instead of their email address.
-- Email is kept as-is for notifications / contact purposes.
-- ─────────────────────────────────────────────────────────────────────────────

-- 1. Add the column as nullable first so the backfill can run cleanly
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS username TEXT;

-- 2. Backfill existing rows: derive username from the part of email before '@'
--    e.g. admin@haverimunion.coop  →  admin
--    Append a random suffix only if there is a collision (unlikely for staff DBs)
UPDATE users
SET username = SPLIT_PART(email, '@', 1)
WHERE username IS NULL;

-- 3. If any collisions exist after the backfill, make them unique by appending
--    the first 4 chars of the user id
UPDATE users u
SET username = SPLIT_PART(u.email, '@', 1) || '_' || LEFT(u.id::text, 4)
WHERE u.id IN (
  SELECT id FROM (
    SELECT id,
           ROW_NUMBER() OVER (PARTITION BY SPLIT_PART(email, '@', 1) ORDER BY created_at) AS rn
    FROM users
    WHERE deleted_at IS NULL
  ) t
  WHERE t.rn > 1
);

-- 4. Now make it NOT NULL and UNIQUE
ALTER TABLE users
  ALTER COLUMN username SET NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS users_username_unique
  ON users (username)
  WHERE deleted_at IS NULL;   -- partial index: soft-deleted users don't block reuse
