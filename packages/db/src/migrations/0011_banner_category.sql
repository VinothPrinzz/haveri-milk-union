-- ═══════════════════════════════════════════════════════════════════
-- Banners: add the `category` column the UI already shows.
-- 0011_banner_category.sql
-- ═══════════════════════════════════════════════════════════════════

ALTER TABLE banners ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'Announcement';

-- (optional) Backfill existing rows if you want something other than the default.
-- UPDATE banners SET category = 'Promotion' WHERE title ILIKE '%offer%';