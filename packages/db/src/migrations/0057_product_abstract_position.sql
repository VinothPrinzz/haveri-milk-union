-- ════════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Product "Abstract Sheet Position"
-- 0057_product_abstract_position.sql
--
-- Why:
--   The Route Sheet across-columns and the Route Sheet Abstract table must
--   list products in a specific, client-defined order. Until now that order
--   was hard-coded in the web app (ACROSS_CODE_ORDER) and keyed off a column
--   whose values did not actually match, so the ordering was effectively a
--   no-op and fell back to the generic sort_order.
--
-- What:
--   Add a dedicated `abstract_position` integer to products. This is the
--   single source of truth for the product sequence on BOTH the route-sheet
--   across columns and the abstract table. It is editable from the admin
--   panel (Products → Behaviour → "Abstract Sheet Position").
--
--   0 means "unset" — such products sort AFTER all positioned products, in
--   their normal sort_order. Positioned products sort ascending (1, 2, 3…).
--
--   The seed below reproduces the historical intended order so nothing moves
--   until an admin edits a position.
--
-- Idempotent — ADD COLUMN IF NOT EXISTS + guarded UPDATE.
-- ════════════════════════════════════════════════════════════════════

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS abstract_position integer NOT NULL DEFAULT 0;

-- Seed the abstract-sheet ordering to the historical fixed sequence.
-- Match on report_alias (the human label, e.g. 'HTM-1000ML') OR code, so it
-- works regardless of which column holds the alias-style value in a given DB.
UPDATE products AS p
   SET abstract_position = v.pos
  FROM (VALUES
    ('HTM-1000ML',        1),
    ('HTM 1000ML (sub)',  2),
    ('HTM-500ML',         3),
    ('HCM-500ML',         4),
    ('SHBM 1000ML',       5),
    ('SHBM 500ML',        6),
    ('SHBM 200ML',        7),
    ('SAMRUDHI 500ML',    8),
    ('CURD 200GM',        9),
    ('CURD 500GM',       10)
  ) AS v(alias, pos)
 WHERE p.deleted_at IS NULL
   AND (
        UPPER(TRIM(COALESCE(p.report_alias, ''))) = UPPER(v.alias)
     OR UPPER(TRIM(COALESCE(p.code,         ''))) = UPPER(v.alias)
   );
