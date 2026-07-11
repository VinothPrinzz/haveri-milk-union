-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Refresh expired banners
-- 0017_refresh_banners.sql
--
-- Banners seeded in 0003 ended on 2025-12-31. The dealer app filters
-- to active && start_date ≤ today ≤ end_date, so they vanished from
-- the dashboard once we crossed into 2026. This migration extends
-- their end_date and adds a small set of fresh ones so the
-- PromoBanner row has content again.
--
-- Idempotent — safe to re-run.
-- ══════════════════════════════════════════════════════════════════

-- 1. Extend any banner whose end_date is in the past.
UPDATE banners
SET end_date   = '2027-12-31'::date,
    updated_at = now()
WHERE end_date < CURRENT_DATE;

-- 2. Insert a fresh trio of banners, only if no active banners exist
--    today. The ON CONFLICT DO NOTHING is a safety net (banners has
--    no UNIQUE constraint on title, so we use a NOT EXISTS guard).
INSERT INTO banners (title, subtitle, category, image_url, start_date, end_date, zone_id, active)
SELECT
  v.title, v.subtitle, v.category, v.image_url,
  CURRENT_DATE, CURRENT_DATE + INTERVAL '1 year', NULL, true
FROM (VALUES
  ('Bulk Discount on Full Cream Milk', 'Buy 50+ units · Save 5%', 'Promotion',  NULL),
  ('Premium Butter Available Now',     'Fresh from Haveri farms', 'New Launch', NULL),
  ('Window Closes 8 AM Daily',         'Place indents before 7:45 AM',  'Notice',     NULL)
) AS v(title, subtitle, category, image_url)
WHERE NOT EXISTS (
  SELECT 1 FROM banners
  WHERE active = true
    AND start_date <= CURRENT_DATE
    AND end_date   >= CURRENT_DATE
);
