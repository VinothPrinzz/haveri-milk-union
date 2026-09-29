-- ═══════════════════════════════════════════════════════════════════
-- 0074_ist_calendar_day.sql
--
-- A day at the union runs 00:00:00 to 23:59:59 IST. Postgres did not
-- agree.
--
-- The API connects to Supabase with no TimeZone set, so the session runs
-- in UTC and every UNQUALIFIED date expression resolves to a UTC day:
--
--     CURRENT_DATE                -- rolls over at 05:30 IST
--     now()::date                 -- rolls over at 05:30 IST
--     some_timestamptz::date      -- the UTC calendar day of that instant
--
-- A UTC day begins at 05:30 IST, so anything happening between midnight
-- and 05:29 IST was reported under the PREVIOUS day. At 02:00 IST the
-- Finance Dashboard's "Collected today" showed Rs.6.09 lakh of the
-- previous day's receipts, and a payment taken at 02:00 counted towards
-- neither day's figure on screen.
--
-- Setting the session TimeZone would have fixed all of it in one line, but
-- Supabase's transaction pooler drops the TimeZone startup parameter
-- (probed against aws-1-ap-south-1.pooler.supabase.com:6543 — the setting
-- never reaches the backend), and a bare `SET TIME ZONE` leaks across
-- clients sharing a pooled server connection. So the IST day is spelled
-- out in the SQL at every site that computes one, the way the ~100
-- existing `AT TIME ZONE 'Asia/Kolkata'` call sites already do.
--
-- That part of the fix is pure application code and ships with the deploy.
-- This migration closes the one remaining way for a wrong date to be
-- WRITTEN rather than merely displayed: a receipt inserted without an
-- explicit received_date between midnight and 05:29 IST would have been
-- stamped a day early by the column DEFAULT.
--
-- No stored row is rewritten, and none needs to be. Every date column was
-- audited against the IST creation instant of its row first — payments,
-- cheques, dealer_ledger, direct_sales, orders, employee_orders, invoices,
-- stock_receipts — and all of them were already correct. The two receipts
-- ever taken before 05:30 IST (Rs.7,000 on 2026-09-03 at 04:32 and
-- Rs.17,000 on 2026-08-01 at 05:28) both carry the right received_date,
-- because the Razorpay receipt path had already been written with an
-- explicit AT TIME ZONE. The damage was confined to what the reports
-- COMPUTED, not to what was stored.
-- ═══════════════════════════════════════════════════════════════════

BEGIN;

-- Receipt dates default to the IST day, not the UTC one. Both columns are
-- `date NOT NULL DEFAULT CURRENT_DATE` from 0015.
ALTER TABLE payments
  ALTER COLUMN received_date SET DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date;

ALTER TABLE cheques
  ALTER COLUMN received_date SET DEFAULT (now() AT TIME ZONE 'Asia/Kolkata')::date;

COMMENT ON COLUMN payments.received_date IS
  'IST calendar day the money arrived (00:00-23:59 Asia/Kolkata). Never '
  'CURRENT_DATE: the API session runs in UTC, whose day rolls at 05:30 IST.';

COMMENT ON COLUMN cheques.received_date IS
  'IST calendar day the cheque was taken in (00:00-23:59 Asia/Kolkata).';

COMMIT;
