-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Reset FGS stock to zero, then load a fresh snapshot
-- 0055_stock_reset_and_load.sql
--
-- Why:
--   The client supplied a current stock-on-hand snapshot (the
--   "STOCK ONLINE(in)" sheet). It is a FULL snapshot: every product
--   not listed should read zero. So we first zero every product's
--   current FGS count, then set the listed products to their snapshot
--   value. Any product absent from the snapshot is therefore left at 0.
--
-- What:
--   1. UPDATE products SET stock = 0      — wipe the existing counts.
--   2. UPDATE products SET stock = <snapshot> for each listed code via a
--      VALUES join on products.code (PDxxxx / Pxx). 176 rows.
--   3. Upsert the one supplier the snapshot names (SUP-0001, SKA FOODS
--      SPECIALITY PVT LTD) into the suppliers master.
--   4. RESET the daily stock log so the snapshot becomes the carried-forward
--      OPENING stock. products.stock is only a denormalised on-hand cache;
--      the Stock Entry screen reads fgs_stock_log, where a day's opening
--      auto-fills from the most recent prior day's closing. So we:
--        a. delete every fgs_stock_log / stock_receipts row dated on/after the
--           count date 2026-06-29 (this discards any post-count daily entries),
--        b. write ONE baseline fgs_stock_log row per live product dated
--           2026-06-29 whose closing = the on-hand from step 2 (opening =
--           closing for products with no receipt; the 6 GRN products carry
--           their received qty so opening = closing − received),
--        c. record the 6 GRN receipt lines (qty / unit cost / supplier) on
--           stock_receipts so the supplier provenance is preserved too.
--
-- Notes:
--   • Matches on products.code; soft-deleted products are skipped.
--   • Codes in the snapshot with no matching live product simply no-op.
--   • The baseline row is written for EVERY live product (not just the listed
--     codes), so products absent from the snapshot get a clean 0 opening too —
--     no stale prior-day closing can carry forward against their now-zero stock.
--   • entered_by is the FGS milk/curd operator (fgs_ska), falling back to any
--     super_admin / any user.
--   • Idempotent — it is a full snapshot and step 4a deletes before re-writing,
--     so re-running reproduces the same end state.
-- ════════════════════════════════════════════════════════════════════

-- ── 1. Zero out all current stock ──
UPDATE products
   SET stock = 0,
       updated_at = now()
 WHERE deleted_at IS NULL
   AND stock <> 0;

-- ── 2. Apply the snapshot values ──
UPDATE products p
   SET stock = v.stock,
       updated_at = now()
  FROM (VALUES
  ('PD0086', 55),
  ('PD0087', 0),
  ('PD0088', 20),
  ('PD0089', 2),
  ('PD0090', 49),
  ('PD0091', 43),
  ('PD0093', 4),
  ('PD0064', 0),
  ('PD0094', 0),
  ('PD0057', 0),
  ('PD0095', 13),
  ('PD0097', 3),
  ('PD0058', 0),
  ('PD0226', 10),
  ('P02', 10),
  ('P01', 10),
  ('PD0105', 0),
  ('PD0114', 10),
  ('PD0117', 0),
  ('PD0129', 0),
  ('PD0033', 0),
  ('PD0229', 5),
  ('PD0233', 0),
  ('PD0240', 5),
  ('PD0100', 0),
  ('PD0101', 0),
  ('PD0102', 23),
  ('PD0034', 0),
  ('PD0103', 1840),
  ('PD0036', 0),
  ('PD0037', 34),
  ('PD0038', 0),
  ('PD0039', 0),
  ('PD0041', 0),
  ('PD0056', 42),
  ('PD0045', 0),
  ('PD0107', 0),
  ('PD0108', 0),
  ('PD0223', 0),
  ('PD0032', 0),
  ('PD0242', 0),
  ('PD0241', 2),
  ('PD0109', 0),
  ('PD0110', 0),
  ('PD0111', 0),
  ('PD0120', 1),
  ('PD0001', 251),
  ('PD0004', 180),
  ('PD0012', 0),
  ('PD0014', 0),
  ('PD0122', 100),
  ('PD0124', 100),
  ('PD0125', 100),
  ('PD0127', 10),
  ('PD0128', 0),
  ('PD0136', 0),
  ('PD0137', 63),
  ('PD0157', 0),
  ('PD0075', 0),
  ('PD0076', 0),
  ('PD0077', 0),
  ('PD0078', 0),
  ('PD0158', 0),
  ('PD0160', 0),
  ('PD0146', 4),
  ('PD0156', 22),
  ('PD0143', 67),
  ('PD0153', 20),
  ('PD0178', 0),
  ('PD0182', 50),
  ('PD0179', 113),
  ('PD0183', 38),
  ('PD0168', 40),
  ('PD0169', 0),
  ('PD0170', 0),
  ('PD0171', 0),
  ('PD0172', 57),
  ('PD0173', 0),
  ('PD0164', 1654),
  ('PD0166', 102),
  ('PD0167', 2744),
  ('PD0165', 0),
  ('PD0187', 0),
  ('PD0188', 0),
  ('PD0191', 0),
  ('PD0193', 100),
  ('PD0198', 55),
  ('PD0069', 0),
  ('PD0199', 27),
  ('PD0008', 0),
  ('PD0018', 0),
  ('PD0054', 10),
  ('PD0200', 50),
  ('PD0201', 0),
  ('PD0202', 20),
  ('PD0205', 5),
  ('PD0060', 10),
  ('PD0206', 89),
  ('PD0208', 2),
  ('PD0213', 0),
  ('PD0214', 0),
  ('PD0061', 60),
  ('PD0215', 0),
  ('PD0106', 0),
  ('PD0174', 0),
  ('PD0280', 0),
  ('PD0184', 1),
  ('PD0216', 10),
  ('PD0217', 200),
  ('PD0218', 100),
  ('PD0219', 0),
  ('PD0048', 0),
  ('PD0221', 108),
  ('PD0020', 26),
  ('PD0021', 31),
  ('PD0022', 29),
  ('PD0023', 28),
  ('PD0024', 31),
  ('PD0011', 45),
  ('PD0224', 46),
  ('PD0231', 705),
  ('PD0232', 102),
  ('PD0234', 0),
  ('PD0235', 0),
  ('PD0236', 272),
  ('PD0239', 40),
  ('PD0135', 194),
  ('PD0134', 236),
  ('PD0138', 10),
  ('PD0203', 16),
  ('PD0044', 0),
  ('PD0245', 40),
  ('PD0246', 0),
  ('PD0247', 0),
  ('PD0210', 0),
  ('PD0211', 0),
  ('PD0212', 0),
  ('PD0248', 0),
  ('PD0043', 0),
  ('PD0253', 0),
  ('PD0254', 0),
  ('P05', 45),
  ('PD0255', 0),
  ('PD0256', 0),
  ('PD0257', 0),
  ('PD0002', 0),
  ('PD0005', 26),
  ('PD0052', 20),
  ('PD0070', 0),
  ('PD0006', 0),
  ('PD0007', 0),
  ('PD0009', 0),
  ('PD0010', 1),
  ('PD0053', 12),
  ('PD0071', 7),
  ('PD0013', 0),
  ('PD0015', 0),
  ('PD0274', 0),
  ('PD0276', 0),
  ('PD0277', 0),
  ('PD0073', 59),
  ('PD0059', 53),
  ('PD0079', 31),
  ('PD0080', 51),
  ('PD0281', 33),
  ('PD0282', 0),
  ('PD0072', 132),
  ('P04', 1),
  ('P03', 0),
  ('PD0285', 2),
  ('PD0287', 0),
  ('PD0288', 0),
  ('PD0293', 0),
  ('PD0294', 5),
  ('PD0295', 202),
  ('PD0296', 50)
  ) AS v(code, stock)
 WHERE p.code = v.code
   AND p.deleted_at IS NULL;

-- ── 3. Supplier master — SUP-0001 (SKA FOODS SPECIALITY PVT LTD) ──
-- The suppliers.code column has no unique constraint, so guard with
-- NOT EXISTS for the insert, then refresh the descriptive fields so a
-- pre-existing thin row picks up the snapshot's address / GST.
INSERT INTO suppliers (code, name, phone, address, gst_no, active)
SELECT 'SUP-0001', 'SKA FOODS SPECIALITY PVT LTD', NULL,
       'HAVERI UHT PLANT, JANGAMANAKOPPA HAVERI', '29ABHCS8450R1ZA', true
WHERE NOT EXISTS (
  SELECT 1 FROM suppliers WHERE code = 'SUP-0001' AND deleted_at IS NULL
);

UPDATE suppliers
   SET name       = 'SKA FOODS SPECIALITY PVT LTD',
       address    = 'HAVERI UHT PLANT, JANGAMANAKOPPA HAVERI',
       gst_no     = '29ABHCS8450R1ZA',
       updated_at = now()
 WHERE code = 'SUP-0001' AND deleted_at IS NULL;

-- ── 4. Reset the daily stock-log baseline, then re-establish it ──
-- See the header: products.stock alone is not enough — the Stock Entry screen
-- derives a day's opening from the most recent prior day's closing. So the
-- snapshot has to live in fgs_stock_log as the authoritative latest baseline.

-- 4a. Wipe post-count daily-log + receipt rows so nothing shadows the baseline.
-- (Discards any fgs_stock_log / stock_receipts entries on/after the count date.)
DELETE FROM stock_receipts WHERE date >= DATE '2026-06-29';
DELETE FROM fgs_stock_log  WHERE date >= DATE '2026-06-29';

-- 4b. Baseline fgs_stock_log for EVERY live product, dated the count date.
-- closing = the on-hand set in step 2; opening = closing for products with no
-- receipt that day; the 6 GRN products carry their received qty so the day's
-- arithmetic (opening + received − dispatched − wastage = closing) reconciles.
INSERT INTO fgs_stock_log
  (product_id, date, opening, received, dispatched, wastage, closing, entered_by)
SELECT p.id, DATE '2026-06-29',
       p.stock - COALESCE(r.received, 0) AS opening,
       COALESCE(r.received, 0)           AS received,
       0, 0,
       p.stock                            AS closing,
       COALESCE(
         (SELECT id FROM users WHERE username = 'fgs_ska'            AND deleted_at IS NULL LIMIT 1),
         (SELECT id FROM users WHERE role = 'super_admin'::user_role AND deleted_at IS NULL ORDER BY created_at LIMIT 1),
         (SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1)
       )
FROM products p
LEFT JOIN (VALUES
  ('PD0122', 100),
  ('PD0124', 100),
  ('PD0125', 100),
  ('PD0127', 10),
  ('PD0193', 100),
  ('PD0217', 100)
) AS r(code, received) ON r.code = p.code
WHERE p.deleted_at IS NULL;

-- 4c. stock_receipts — the 6 GRN lines the snapshot carries (supplier + cost)
INSERT INTO stock_receipts
  (product_id, supplier_id, date, quantity, unit_cost, total_cost, entered_by)
SELECT p.id,
       (SELECT id FROM suppliers WHERE code = 'SUP-0001' AND deleted_at IS NULL LIMIT 1),
       DATE '2026-06-29', v.quantity, v.unit_cost, v.total_cost,
       COALESCE(
         (SELECT id FROM users WHERE username = 'fgs_ska'        AND deleted_at IS NULL LIMIT 1),
         (SELECT id FROM users WHERE role = 'super_admin'::user_role AND deleted_at IS NULL ORDER BY created_at LIMIT 1),
         (SELECT id FROM users WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1)
       )
FROM (VALUES
  ('PD0122', 100, NULL::numeric, NULL::numeric),
  ('PD0124', 100, NULL::numeric, NULL::numeric),
  ('PD0125', 100, 12::numeric,   1200::numeric),
  ('PD0127', 10,  NULL::numeric, NULL::numeric),
  ('PD0193', 100, 45::numeric,   4500::numeric),
  ('PD0217', 100, 8.33::numeric, 833::numeric)
) AS v(code, quantity, unit_cost, total_cost)
JOIN products p ON p.code = v.code AND p.deleted_at IS NULL;
