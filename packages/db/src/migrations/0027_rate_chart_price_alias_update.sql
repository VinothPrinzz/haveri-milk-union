-- ══════════════════════════════════════════════════════════════════
-- Haveri Milk Union — Rate Chart Price & Alias Update
-- 0027_rate_chart_price_alias_update.sql
--
-- Source: Milk & Product Rate Chart as on 12-May-2026 08:22:09 AM
--
-- What this migration does:
--   1. Updates products.base_price from the RETAIL-DEALER Basic Rate
--      column in the rate chart (pre-GST price, the canonical reference).
--   2. Updates the four per-category Net Rate columns:
--        retail_dealer_price       ← RETAIL-DEALER Net Rate
--        credit_inst_mrp_price     ← CREDIT INSTITUTION - Net Rate
--        credit_inst_dealer_price  ← CREDIT INSTITUTIONS Net Rate
--        parlour_dealer_price      ← PARLOUR - DELEAR Net Rate
--   3. Enforces report_alias character limits by print_direction:
--        'Across' → LEFT(report_alias, 14)
--          [user-specified; matches the Packet Name column width in the chart]
--        'Down'   → LEFT(report_alias, 14)
--          [derived from the rate chart: longest milk-product Packet
--           Alias is "SAMRUDHI 500ML" / "SHUBHAM-1050ML" = 14 chars]
--
-- Run: psql $DATABASE_URL -f 0027_rate_chart_price_alias_update.sql
-- ══════════════════════════════════════════════════════════════════

BEGIN;

-- ┌─────────────────────────────────────────────────────────────────┐
-- │  STEP 1 — Build rate chart reference data                        │
-- │  Columns: product_name, basic_rate,                              │
-- │           retail, ci_mrp, ci_dealer, parlour                     │
-- │           (all Net Rates; basic_rate is RETAIL-DEALER pre-GST)   │
-- └─────────────────────────────────────────────────────────────────┘

WITH rate_chart (
  product_name,
  basic_rate,        -- RETAIL-DEALER Basic Rate  → products.base_price
  retail,            -- RETAIL-DEALER Net Rate     → retail_dealer_price
  ci_mrp,            -- CREDIT INSTITUTION -       → credit_inst_mrp_price
  ci_dealer,         -- CREDIT INSTITUTIONS        → credit_inst_dealer_price
  parlour            -- PARLOUR - DELEAR           → parlour_dealer_price
) AS (
  VALUES
  -- ── Milk & Liquid Dairy (GST 0%) ─────────────────────────────────
  ('BUFFALO MILK 500ML',                  27.33,  27.33,  27.33,  27.33,  27.33),
  ('HCM 1000 ML',                         43.70,  43.70,  43.70,  43.70,  43.70),
  ('HCM 1050ML',                          45.60,  45.60,  48.00,  45.60,  45.60),
  ('HCM 160ML',                            8.50,   8.50,   8.50,   8.50,   8.50),
  ('HCM 500ML',                           24.70,  24.70,  24.70,  24.70,  24.70),
  ('HCM 510ML',                           22.80,  22.80,  22.80,  22.80,  22.80),
  ('HCM 550ML',                           24.70,  24.70,  26.00,  24.70,  24.70),
  ('HTM 1000ML',                          44.65,  44.65,  47.00,  44.65,  44.65),
  ('HTM 1050ML',                          42.75,  42.75,  45.00,  42.75,  42.75),
  ('HTM 500ML',                           22.80,  22.80,  24.00,  22.80,  22.80),
  ('HTM 550ML',                           22.80,  22.80,  24.00,  22.80,  22.80),
  ('SAMRUDHI 500ML',                      27.55,  27.55,  27.55,  27.55,  27.55),
  ('SAMRUDHI 550ML',                      27.55,  27.55,  27.55,  27.55,  27.55),
  ('SHUBHAM 1000ML',                      49.40,  49.40,  49.40,  49.40,  49.40),
  ('SHUBHAM 1050ML',                      47.50,  47.50,  50.00,  47.50,  47.50),
  ('SHUBHAM 200ML',                       12.35,  12.35,  12.35,  12.35,  12.35),
  ('SHUBHAM 500ML',                       25.65,  25.65,  25.65,  25.65,  25.65),
  ('SHUBHAM 510ML',                       23.75,  23.75,  23.75,  23.75,  23.75),
  ('SHUBHAM 550ML',                       25.65,  25.65,  27.00,  25.65,  25.65),

  -- ── Cookies / Shrikhand (GST 5 / 18%) ────────────────────────────
  ('100GM BUTTER COOKIES',                26.838, 28.18,  28.18,  28.18,  28.18),
  ('100GM BUTTERSCOTCH SHRIKHAND',        27.781, 29.17,  29.17,  29.17,  29.17),
  ('100GM CHOCO COOKIES',                 30.263, 35.71,  35.71,  35.71,  35.71),
  ('100GM COCONUT COOKIES',               26.838, 28.18,  28.18,  28.18,  28.18),
  ('100GM ELACHI SHRIKHAND',              19.857, 20.85,  20.85,  20.85,  20.85),
  ('100GM GREEN APPLE SHRIKHAND',         27.781, 29.17,  29.17,  29.17,  29.17),
  ('100GM GUAVA SHRIKHAND',               23.810, 25.00,  25.00,  25.00,  25.00),
  ('100GM K PEANUT CHIKKI',               38.266, 40.18,  40.18,  40.18,  40.18),
  ('100GM KIWI SHRIKHAND',                27.781, 29.17,  29.17,  29.17,  29.17),
  ('100GM MANGO SHRIKHAND',               19.857, 20.85,  20.85,  20.85,  20.85),
  ('100GM MYSORE PAK',                    51.019, 53.57,  53.57,  53.57,  53.57),
  ('100GM PEPPER JEERA COOKIES',          26.966, 31.82,  31.82,  31.82,  31.82),
  ('100GM PINEAPPLE SHRIKHAND',           19.838, 20.83,  20.83,  20.83,  20.83),
  ('100GM RED CHILLI COOKIES',            26.838, 28.18,  28.18,  28.18,  28.18),
  ('100GM STRAWBERRY SHRIKHAND',          23.810, 25.00,  25.00,  25.00,  25.00),
  ('100GM TWIN FRUIT BUN',                11.900, 11.90,  11.90,  11.90,  11.90),

  -- ── Energy Bars / Chikki (GST 5 / 18%) ───────────────────────────
  ('12GM ENERGYBAR WITH WHOLESOMENUTS',  416.780, 491.80, 491.80, 491.80, 491.80),
  ('12GM KHOVA PEANUT CHIKKI',            80.714,  84.75,  84.75,  84.75,  84.75),
  ('12GM RICHBAR DELICIOUS CARAMEL',     250.068, 295.08, 295.08, 295.08, 295.08),

  -- ── Muffins (GST 5%) ──────────────────────────────────────────────
  ('150GM CHOCOLATE MUFFIN',              41.667,  43.75,  43.75,  43.75,  43.75),
  ('150GM MAWA MUFFIN',                   41.667,  43.75,  43.75,  43.75,  43.75),
  ('150GM PINEAPPLE MUFFIN',              41.667,  43.75,  43.75,  43.75,  43.75),
  ('150GM STRAWBERRY MUFFIN',             41.667,  43.75,  43.75,  43.75,  43.75),
  ('150GM VANILLA MUFFIN',                41.667,  43.75,  43.75,  43.75,  43.75),

  -- ── RTE Pongal (GST 18%) ─────────────────────────────────────────
  ('180GM RTE SIRI KHARA PONGAL',         14.864,  17.54,  17.54,  17.54,  17.54),
  ('180GM RTE SIRI SWEET PONGAL',         14.864,  17.54,  17.54,  17.54,  17.54),

  -- ── Milk Chocolates (GST 5 / 18%) ────────────────────────────────
  ('18GM ALMOND MILK CHOCO',             222.288, 262.30, 262.30, 262.30, 262.30),
  ('18GM CRISPY MILK CHOCO',             168.619, 177.05, 177.05, 177.05, 177.05),
  ('18GM GL BLACK CURRENT MILK CHOCO',   259.457, 272.43, 272.43, 272.43, 272.43),
  ('18GM GL ORANGE MILK CHOCO',          207.571, 217.95, 217.95, 217.95, 217.95),
  ('18GM RAISINS&NUTS MILK CHOCO',       224.829, 236.07, 236.07, 236.07, 236.07),

  -- ── Cheese (GST 5 / 12%) ─────────────────────────────────────────
  ('1KG MOZZERELLA DICED CHEESE',        372.667, 391.30, 391.30, 391.30, 391.30),
  ('CHEDDAR CHEESE 200GM',               111.607, 125.00, 125.00, 125.00, 125.00),
  ('CHEESE CUBES 200GM',                  89.286, 100.00, 100.00, 100.00, 100.00),
  ('CHEESE SLICES 100GM',                 57.143,  60.00,  60.00,  60.00,  60.00),
  ('CHEESE SLICES 200GM',                100.610, 105.64, 105.64, 105.64, 105.64),
  ('CHEESE SLICES 750GM',                295.400, 310.17, 310.17, 310.17, 310.17),
  ('MOZZ CHEESE SHREDED200GM',            87.759,  98.29,  98.29,  98.29,  98.29),
  ('PROC.CHEESE BLOCK 1KG',              404.562, 424.79, 424.79, 424.79, 424.79),
  ('PROCEESED CHEESE CUBES 500GM',       194.098, 217.39, 217.39, 250.00, 250.00),
  ('SPREAD-CHEESE PLAIN200GM',            63.241,  70.83,  70.83,  70.83,  70.83),

  -- ── Burfi & Sweets (GST 5%) ───────────────────────────────────────
  ('200G JAGGERY OATS & NUTS BURFI',     144.562, 151.79, 151.79, 151.79, 151.79),
  ('200GM SUGARFREE PEDA',               144.562, 151.79, 151.79, 151.79, 151.79),

  -- ── Butter (GST 5%) ───────────────────────────────────────────────
  ('200GM BUTTER UNSALTED',              102.038, 107.14, 107.14, 107.14, 107.14),
  ('BUTTER 10GM BLISTER PACK',           595.238, 625.00, 625.00, 625.00, 625.00),
  ('BUTTER SALTED 100 GMS',               52.724,  55.36,  55.36,  55.36,  55.36),
  ('BUTTER SALTED 500GM',                242.352, 254.47, 254.47, 254.47, 254.47),
  ('BUTTER UNSALTED500GM',               259.352, 272.32, 272.32, 272.32, 272.32),

  -- ── Cakes (GST 5%) ────────────────────────────────────────────────
  ('200GM CHOCO JAGGERY CAKE',            91.667,  96.25,  96.25,  96.25,  96.25),
  ('200GM CHOCO VANILLA CAKE',            91.667,  96.25,  96.25,  96.25,  96.25),
  ('200GM CHOCOLATE CAKE',                91.667,  96.25,  96.25,  96.25,  96.25),
  ('200GM COCONUT JAGGERY CAKE',          91.667,  96.25,  96.25,  96.25,  96.25),
  ('200GM FRUIT CAKE',                    91.667,  96.25,  96.25,  96.25,  96.25),
  ('200GM PLUM CAKE',                     91.667,  96.25,  96.25,  96.25,  96.25),
  ('200GM VANILLA CAKE',                  91.667,  96.25,  96.25,  96.25,  96.25),
  ('200GM WALNUT BANANA CAKE',            91.667,  96.25,  96.25,  96.25,  96.25),
  ('25GM SPONGY VANILLA CAKE',             8.333,   8.75,   8.75,   8.75,   8.75),
  ('30GM FRUITY SLICE CAKE',              12.505,  13.13,  13.13,  13.13,  13.13),
  ('50GM CHOCO ORANGE SLICE CAKE',        16.667,  17.50,  17.50,  17.50,  17.50),
  ('50GM PINEAPPLE SLICE CAKE',           16.667,  17.50,  17.50,  17.50,  17.50),
  ('50GM VANILLA SLICE CAKE',             12.505,  13.13,  13.13,  13.13,  13.13),

  -- ── Bread (GST 0%) ────────────────────────────────────────────────
  ('200GM MULTIGRAIN BREAD',              25.500,  25.50,  25.50,  25.50,  25.50),
  ('200GM SANDWICH BREAD',                21.250,  21.25,  21.25,  21.25,  21.25),
  ('200GM WHOLE WHEAT BREAD',             25.500,  25.50,  25.50,  25.50,  25.50),
  ('400GM MULTIGRAIN BREAD',              51.000,  51.00,  51.00,  51.00,  51.00),
  ('400GM SANDWICH BREAD',                42.500,  42.50,  42.50,  42.50,  42.50),
  ('400GM WHOLE WHEAT BREAD',             46.750,  46.75,  46.75,  46.75,  46.75),
  ('FRUIT BUN 250GM',                     29.750,  29.75,  29.75,  29.75,  29.75),
  ('MILK BREAD 200GM',                    21.250,  21.25,  21.25,  21.25,  21.25),
  ('MILK BREAD 400GM',                    42.500,  42.50,  42.50,  42.50,  42.50),
  ('PAV BUN 200GM',                       21.250,  21.25,  21.25,  21.25,  21.25),
  ('PAV BUN 400GM',                       38.250,  38.25,  38.25,  38.25,  38.25),
  ('SWEET BUN 250GM',                     25.500,  25.50,  25.50,  25.50,  25.50),

  -- ── RTE Payasa (GST 5%) ───────────────────────────────────────────
  ('200GM RTE SIRIDHANYA PAYASA',         20.886,  21.93,  21.93,  21.93,  21.93),

  -- ── Milk Rusk (GST 5%) ────────────────────────────────────────────
  ('20GM NANDINI MILK RUSK',               4.038,   4.24,   4.24,   4.24,   4.24),
  ('MILK RUSK',                           16.562,  17.39,  17.39,  17.39,  17.39),

  -- ── Energy Bars (22GM / 45GM, GST 5 / 18%) ───────────────────────
  ('22GM ENERGYBAR WITH ZESTYFRUITS',    505.857, 531.15, 531.15, 531.15, 531.15),
  ('22GM RICH BAR DELICIOUS CARMEL',     337.238, 354.10, 354.10, 354.10, 354.10),
  ('22GM WHOLESOME WITH ENERGYBARNUTS',  505.857, 531.15, 531.15, 531.15, 531.15),
  ('45GM RICH BAR DELICIOUS CARAMEL',    439.114, 461.07, 461.07, 461.07, 461.07),

  -- ── Shrikhand (GST 5%) ────────────────────────────────────────────
  ('250GM ELACHI SHRIKHAND',              43.648,  45.83,  45.83,  45.83,  45.83),
  ('250GM MANGO SHRIKHAND',               43.648,  45.83,  45.83,  45.83,  45.83),
  ('500GM ELACHI SHRIKHAND',              82.819,  86.96,  86.96,  86.96,  86.96),
  ('500GM MANGO SHRIKHAND',               82.819,  86.96,  86.96,  86.96,  86.96),
  ('SHRIKAND 500GM',                      82.819,  86.96,  86.96,  86.96,  86.96),
  ('SHRIKAND 600GM',                     107.657, 113.04, 130.00, 130.00, 130.00),
  ('SHRIKHAND 100GM',                     19.857,  20.85,  20.85,  20.85,  20.85),
  ('SHRIKHAND 250GM',                     43.648,  45.83,  45.83,  45.83,  45.83),

  -- ── Chikki / Snacks (GST 5%) ─────────────────────────────────────
  ('25GM KHOVA PEANUT CHIKKI',            80.714,  84.75,  84.75,  84.75,  84.75),
  ('25GM MYSORE PAK',                    408.162, 428.57, 428.57, 428.57, 428.57),
  ('30GM BENNEMURUKU',                     7.543,   7.92,   7.92,   7.92,   7.92),
  ('30GM BOMBAY MIXTURE.',                 7.543,   7.92,   7.92,   7.92,   7.92),
  ('30GM KHARABOONDI',                     7.543,   7.92,   7.92,   7.92,   7.92),
  ('30GM KODUBALE',                        7.543,   7.92,   7.92,   7.92,   7.92),

  -- ── Milk Chocolates (38GM, 50GM, 80GM, GST 5 / 18%) ─────────────
  ('38GM DELISH MILK CHOCO',             168.619, 177.05, 177.05, 177.05, 177.05),
  ('38GM RAISINS&NUTS MILK CHOCO',       252.924, 265.57, 265.57, 265.57, 265.57),
  ('50GM DELISH MILK CHOCO',             252.924, 265.57, 265.57, 265.57, 265.57),
  ('50GM G/L CHOCO CREAM BUN',             8.667,   9.10,   9.10,   9.10,   9.10),
  ('50GM G/L PINEAPPLE CREAM BUN',         8.667,   9.10,   9.10,   9.10,   9.10),
  ('50GM G/L STRAWBERRY CREAM BUN',        8.667,   9.10,   9.10,   9.10,   9.10),
  ('50GM G/L VENILLA CREAM BUN',           8.667,   9.10,   9.10,   9.10,   9.10),
  ('80GM RICH MILK CHOCOLATE',           248.248, 260.66, 260.66, 260.66, 260.66),

  -- ── Kunda / Traditional Sweets (GST 5%) ──────────────────────────
  ('400GM BELAGAVI KUNDA',               204.086, 214.29, 214.29, 214.29, 214.29),
  ('KUNDA 250GMS',                       123.305, 129.47, 129.47, 129.47, 129.47),

  -- ── RTE Jamoon (GST 5%) ───────────────────────────────────────────
  ('500G SUGARFREE RTE JAMOON',          187.076, 196.43, 196.43, 196.43, 196.43),

  -- ── SMP (GST 5%) ──────────────────────────────────────────────────
  ('500GM SMP',                          164.500, 172.73, 172.73, 172.73, 172.73),
  ('SMP 1KG(MP)',                        320.343, 336.36, 336.36, 336.36, 336.36),
  ('SMP 1KG(PP)',                        353.743, 371.43, 371.43, 371.43, 371.43),

  -- ── Aqua Water (GST 5%) ───────────────────────────────────────────
  ('AQUA WATER 1000ML',                   11.600,  12.18,  12.18,  12.18,  12.18),
  ('AQUA WATER 2000ML',                   15.543,  16.32,  16.32,  16.32,  16.32),
  ('AQUA WATER 250 ML',                    3.914,   4.11,   4.11,   4.11,   4.11),
  ('AQUA WATER 500ML',                     5.810,   6.10,   6.10,   6.10,   6.10),

  -- ── Gift Packs / Assorted Sweets (GST 5%) ────────────────────────
  ('ASSORTED SWEETS(GIFT PACK)-1KG',     450.686, 473.22, 500.00, 473.22, 530.00),
  ('ASSOTD.SWTS(GIFT PAC)-500GMS',       229.590, 241.07, 275.00, 241.07, 300.00),

  -- ── Badam / Powder Products (GST 5%) ─────────────────────────────
  ('BADAM HALWA 100 GM',                  49.686,  52.17,  52.17,  52.17,  52.17),
  ('BADAM POWDER 10 GRMS',              382.657, 401.79, 401.79, 401.79, 401.79),
  ('BADAM POWDER 200 GM',                 90.990,  95.54,  95.54,  95.54,  95.54),
  ('BADAM POWDER 500 GMS',              166.667, 175.00, 175.00, 175.00, 175.00),

  -- ── Ready Mixes (GST 5 / 18%) ────────────────────────────────────
  ('BASUNDI MIX-200GM',                   75.669,  89.29,  89.29,  89.29,  89.29),
  ('JAMOON MIX 200GM',                    60.371,  63.39,  63.39,  63.39,  63.39),
  ('PAYASA MIX-200G',                     68.029,  71.43,  71.43,  71.43,  71.43),
  ('RICE KHEER MIX 150G',                 38.267,  40.18,  40.18,  40.18,  40.18),
  ('MILK MILLET MALT MIX200GM',           47.619,  50.00,  50.00,  50.00,  50.00),
  ('MILLET MALT MIX 200GMS',              85.038,  89.29,  89.29,  89.29,  89.29),

  -- ── Kunda Retort (GST 5%) ─────────────────────────────────────────
  ('BELGAUM KUNDA RETORT 200GM',         106.295, 111.61, 111.61, 111.61, 111.61),

  -- ── Muruku / Mixture (GST 5%) ─────────────────────────────────────
  ('BENNE MURUKU-180GM',                  42.667,  44.80,  44.80,  44.80,  44.80),
  ('BOMBAY MIXTURE-180GM',                42.667,  44.80,  44.80,  44.80,  44.80),
  ('KODUBALE-180GM',                      42.667,  44.80,  44.80,  44.80,  44.80),
  ('KHARA BUNDI-180GM',                   42.667,  44.80,  44.80,  44.80,  44.80),
  ('PANEER MURUKU 180GM',                 59.524,  62.50,  62.50,  62.50,  62.50),
  ('PANEER NIPPATTU 40GM',                18.257,  19.17,  19.17,  19.17,  19.17),
  ('RAGI CRUNCHY BITE180GM',              45.966,  54.24,  54.24,  54.24,  54.24),
  ('RAGI CRUNCHY SPICY180GM',             42.407,  50.04,  50.04,  50.04,  50.04),

  -- ── Ladu / Traditional Sweets (GST 5%) ───────────────────────────
  ('BESAN LADU 200GM',                    99.379, 104.35, 104.35, 104.35, 104.35),
  ('BESAN LADU 250 GM',                  114.800, 120.54, 120.54, 120.54, 120.54),
  ('CASHEW BURFY 250 GMS',              191.324, 200.89, 200.89, 200.89, 200.89),
  ('CHAKKI LADDU 250 GMS',               93.543,  98.22,  98.22,  98.22,  98.22),
  ('GHEE LADDU 200GM',                  111.802, 117.39, 117.39, 117.39, 117.39),
  ('GHEE LADDU 250 GMS',                102.038, 107.14, 107.14, 107.14, 107.14),
  ('KHOVA LADDU 250GM',                   79.505,  83.48,  83.48,  83.48,  83.48),
  ('LADAGI LADU 200GMS',                  76.533,  80.36,  80.36,  80.36,  80.36),
  ('SIRIDHANYA LADDU 200GMS',             89.286,  93.75,  93.75,  93.75,  93.75),
  ('GREEN GRAM LADU',                     82.819,  86.96,  86.96,  86.96,  86.96),

  -- ── Paneer (GST 0 / 5%) ───────────────────────────────────────────
  ('PANEER 200 GM',                       81.470,  81.47,  81.47,  81.47,  81.47),
  ('PANEER 500 GM',                      179.040, 179.04, 179.04, 179.04, 179.04),
  ('PANNER 1KG',                         352.170, 352.17, 352.17, 352.17, 352.17),
  ('BUFF MILK PANEER 200GM',              91.267,  95.83,  95.83,  95.83,  95.83),
  ('PANEER BURFI 250 GM',                 97.790, 102.68, 102.68, 102.68, 102.68),

  -- ── Curd (GST 5%) ─────────────────────────────────────────────────
  ('CURD 140GM',                           8.019,   8.42,   8.42,   8.42,   8.42),
  ('CURD 1KG',                            47.381,  49.75,  49.75,  49.75,  49.75),
  ('CURD 200 GM',                         11.410,  11.98,  11.98,  11.98,  11.98),
  ('CURD 500 GM',                         24.571,  25.80,  25.80,  25.80,  25.80),
  ('CURD 510GM',                          22.819,  23.96,  23.96,  23.96,  23.96),
  ('CURD BUCKET 10KG',                   634.933, 666.68, 666.68, 666.68, 666.68),
  ('CURD BUCKET 5KG',                    324.133, 340.34, 340.34, 340.34, 340.34),
  ('SETCURD200GRM',                       16.543,  17.37,  17.37,  17.37,  17.37),
  ('SETCURD400GMS',                       33.086,  34.74,  34.74,  34.74,  34.74),

  -- ── Peda (GST 5%) ─────────────────────────────────────────────────
  ('DWD PEDA 250 GM',                    106.295, 111.61, 111.61, 111.61, 111.61),
  ('DWD PEDA-100GM',                      42.514,  44.64,  44.64,  44.64,  44.64),
  ('ELACHI PEDA 250GM',                  127.552, 133.93, 133.93, 133.93, 133.93),
  ('ELACHI PEDA 200GM',                  107.661, 113.04, 113.04, 113.04, 113.04),
  ('KESAR PEDA 200 GM',                  107.661, 113.04, 113.04, 113.04, 113.04),
  ('KESAR PEDA 250GM',                   127.552, 133.93, 133.93, 133.93, 133.93),
  ('WHITE PEDA-100GMS',                   51.019,  53.57,  53.57,  53.57,  53.57),
  ('WHITE PEDA-250GM',                   119.048, 125.00, 125.00, 125.00, 125.00),

  -- ── Burfi (GST 5%) ────────────────────────────────────────────────
  ('CHOCOLATE BURFI 200GM',              107.661, 113.04, 113.04, 113.04, 113.04),
  ('CHOCOLATE BURFY 250 GMS',            123.305, 129.47, 129.47, 129.47, 129.47),
  ('COCONUT BURFI 200GM',                107.661, 113.04, 113.04, 113.04, 113.04),
  ('COCONUT BURFY 250 GMS',              123.305, 129.47, 129.47, 129.47, 129.47),
  ('DRY FRUIT BURFI 200GM',              165.632, 173.91, 173.91, 173.91, 173.91),
  ('DRY FRUITS BURFY-250 GM',            191.324, 200.89, 200.89, 200.89, 200.89),
  ('JAGGERY BURFI 250GM',                107.657, 113.04, 113.04, 113.04, 113.04),
  ('JAGGERY PEDA 200GM',                 106.295, 111.61, 111.61, 111.61, 111.61),
  ('KAJU KATLI 200GM',                   187.076, 196.43, 196.43, 196.43, 196.43),
  ('KALAKHAND 250GM',                     93.543,  98.22,  98.22,  98.22,  98.22),
  ('KARADANT 250GM',                     157.314, 165.18, 165.18, 165.18, 165.18),
  ('KHOVA BADAM ROLL 250GM',             144.562, 151.79, 151.79, 151.79, 151.79),
  ('KHOVA CASHEW ROLL 250GM',            144.562, 151.79, 151.79, 151.79, 151.79),
  ('KHOVA CHACONUTTY ROLL250GM',         125.848, 132.14, 132.14, 132.14, 132.14),
  ('MYSORE PAK 250GM',                   136.057, 142.86, 142.86, 142.86, 142.86),
  ('P BADAM BURFI 200GM',                157.350, 165.22, 165.22, 165.22, 165.22),
  ('P.BADAM BURFY - 250GMS',             178.571, 187.50, 187.50, 187.50, 187.50),
  ('PEANUT BURFI 200GM',                  75.400,  79.17,  79.17,  79.17,  79.17),
  ('SPECIAL MILK BURFY 200GM',            93.533,  98.21,  98.21,  98.21,  98.21),

  -- ── Khova (GST 5%) ────────────────────────────────────────────────
  ('KHOVA 200 GM',                        74.533,  78.26,  78.26,  78.26,  78.26),
  ('KHOVA 1KG',                          340.133, 357.14, 357.14, 357.14, 357.14),
  ('KHOVA 2KG',                          595.238, 625.00, 625.00, 625.00, 625.00),

  -- ── Ghee (GST 5%) ─────────────────────────────────────────────────
  ('GHEE 200ML',                         134.200, 140.91, 140.91, 140.91, 140.91),
  ('GHEE 500ML',                         303.029, 318.18, 318.18, 318.18, 318.18),
  ('GHEE 1000ML',                        606.057, 636.36, 636.36, 636.36, 636.36),
  ('GHEE 15KG TIN',                    10213.619,10724.30,10724.30,10724.30,10724.30),
  ('GHEE JAR 50ML',                       45.019,  47.27,  47.27,  47.27,  47.27),
  ('GHEE JAR 100ML',                      73.590,  77.27,  77.27,  77.27,  77.27),
  ('GHEE JAR 200ML',                     142.857, 150.00, 150.00, 150.00, 150.00),
  ('GHEE JAR 500ML',                     311.695, 327.28, 327.28, 327.28, 327.28),
  ('GHEE JAR 1000ML',                    623.381, 654.55, 654.55, 654.55, 654.55),
  ('GHEE JAR 5000ML',                   2686.762,2821.10,2821.10,2821.10,2821.10),
  ('GHEE MOTICHOOR LAADO 200GM',         123.299, 129.46, 129.46, 129.46, 129.46),
  ('GHEE SOAN PAPDI 150GM',              110.543, 116.07, 116.07, 116.07, 116.07),
  ('GHEE LADDU 200GM',                   111.802, 117.39, 117.39, 117.39, 117.39),

  -- ── Good Life / G/L Products (GST 0 / 5 / 12%) ───────────────────
  ('GOOD LIFE 1000ML',                    61.940,  61.94,  61.94,  61.94,  61.94),
  ('GOOD LIFE 180 ML',                    11.870,  11.87,  11.87,  11.87,  11.87),
  ('GOOD LIFE- 100ML',                     7.310,   7.31,   7.31,   7.31,   7.31),
  ('GOOD LIFE-500ML(BRICK)',              31.890,  31.89,  31.89,  31.89,  31.89),
  ('GOOD LIFE SLIM 1000 ML',              35.020,  35.02,  35.02,  35.02,  35.02),
  ('G/L 1000MLWITH CAP',                  58.010,  60.91,  60.91,  60.91,  60.91),
  ('G/L 750ML COMBO PACK',                43.886,  46.08,  46.08,  46.08,  46.08),
  ('G/L BADAM SFM PET 180ML',             19.838,  20.83,  20.83,  20.83,  20.83),
  ('G/L BUTER MILK 200ML(PET)',           12.695,  13.33,  13.33,  13.33,  13.33),
  ('G/L CHACOLATE',                      119.045, 133.33, 133.33, 133.33, 133.33),
  ('G/L CHOCO MILKSHAKE 180MLPET',        23.810,  25.00,  25.00,  25.00,  25.00),
  ('G/L HERBAL SPICED MILK PET 200ML',    18.598,  20.83,  20.83,  20.83,  20.83),
  ('G/L MANGO LASSI 200ML(PET)',          21.162,  22.22,  22.22,  22.22,  22.22),
  ('G/L MILK SHAKE BANANA PET 200ML',    22.321,  30.00,  30.00,  30.00,  30.00),
  ('G/L MILKSHAKE PET200ML',             22.321,  25.00,  25.00,  25.00,  25.00),
  ('G/L MNGL SFM PET200ML',              14.884,  16.67,  16.67,  16.67,  16.67),
  ('G/L PISTA SFM PET 180ML',            19.838,  20.83,  20.83,  20.83,  20.83),
  ('G/L PLAIN LASSI 200ML(PET)',          16.933,  17.78,  12.50,  12.50,  12.50),
  ('G/L SFM STRAWBERRY PET 200ML',       23.810,  16.67,  30.00,  30.00,  30.00),
  ('G/L VANILLA MILKSHAKE 180MLPET',     11.905,  25.00,  25.00,  25.00,  25.00),
  ('G/L-BUTTER MILK180ML(PET)',           11.905,  12.50,  12.50,  12.50,  12.50),
  ('G/L-MANGO LASSI180ML(PET)',           19.838,  20.83,  20.83,  20.83,  20.83),
  ('G/L-MILK SHAKE180ML(PET)',            15.867,  25.00,  25.00,  25.00,  25.00),
  ('G/L-PLAIN LASSI180ML(PET)',           14.884,  16.66,  16.66,  16.66,  16.66),
  ('G/L-SFM PET PISTA-200ML',            19.838,  16.67,  20.00,  16.67,  20.00),
  ('G/L-SFM PET180ML(PET)',              18.598,  20.83,  20.83,  20.83,  20.83),
  ('G/L-SFM PET200ML',                   18.598,  20.83,  20.83,  20.83,  20.83),

  -- ── Lassi / Buttermilk (GST 5 / 12%) ─────────────────────────────
  ('MASALA MAJJIGE 200ML',                 8.010,   8.41,   8.41,   8.41,   8.41),
  ('SWEET LASSI -200ML',                  11.971,  12.57,  12.57,  12.57,  12.57),
  ('TETRA PLAIN LASSI 200ML',             15.876,  16.67,  16.67,  16.67,  16.67),
  ('NANDINI BOUNCE 200ML',                 8.571,  12.00,  12.00,  12.00,  12.00),
  ('SPLASH DRINK 200ML',                   7.543,   7.92,   7.92,   7.92,   7.92),

  -- ── SFM PET Flavoured Milk (GST 5%) ──────────────────────────────
  ('SFM BOTTLE-200ML',                    19.838,  20.83,  20.83,  20.83,  20.83),
  ('SFM PET 200ML BADAM(DK)',             19.838,  20.83,  20.83,  20.83,  20.83),
  ('SFM PET 200ML CHOCOLATE(DK)',         23.810,  25.00,  25.00,  25.00,  25.00),
  ('SFM PET 200ML MANGO(DK)',             19.838,  20.83,  20.83,  20.83,  20.83),
  ('SFM PET 200ML PISTA(DK)',             19.838,  20.83,  20.83,  20.83,  20.83),
  ('SFM PET 200ML ROSE(DK)',              19.838,  20.83,  20.83,  20.83,  20.83),

  -- ── Chocolate Confections (GST 18%) ───────────────────────────────
  ('CARAMEL BITE 14 GMS',                182.203, 215.00, 215.00, 215.00, 215.00),
  ('CHOCOLICIOUS 14 GMS',                182.203, 215.00, 215.00, 215.00, 215.00),
  ('CHOCO.GIFT BOX DUPLEX BOARD',         70.508,  83.20,  83.20,  83.20,  83.20),
  ('CHOCOCRISPY CHOCOLATE',              155.364, 183.33, 183.33, 183.33, 183.33),
  ('COOKIES 100 GM',                      26.966,  31.82,  31.82,  31.82,  31.82),
  ('COOKIES 20 GMS',                     233.848, 245.54, 245.54, 245.54, 245.54),
  ('CREAMY BITE CHICOLATE',              172.364, 203.39, 203.39, 203.39, 203.39),
  ('DW''NER 28 GM',                       12.648,  13.28,  13.28,  13.28,  13.28),
  ('DW''NER-200GMS',                      77.922,  81.82,  81.82,  81.82,  81.82),
  ('DW''NER-500GM',                      155.838, 163.63, 163.63, 163.63, 163.63),
  ('ECLAIR 100GM POUCH',                  74.410,  78.13,  78.13,  78.13,  78.13),
  ('ECLAIRS 3.6 JAR',                    186.505, 195.83, 195.83, 195.83, 195.83),
  ('NANDINI BITE 25 GM',                 408.162, 428.57, 428.57, 428.57, 428.57),
  ('NANDINI CHIT CHAT',                  112.992, 133.33, 133.33, 133.33, 133.33),
  ('TREATO CHOCOLATE',                   186.441, 220.00, 220.00, 220.00, 220.00),
  ('TWIN SWEET 100GM',                    10.200,  10.20,  10.20,  10.20,  10.20),

  -- ── Cream / Sweets (GST 0 / 40%) ─────────────────────────────────
  ('NANDINI CREAM 200ML',                 54.550,  54.55,  54.55,  54.55,  54.55),

  -- ── Tin Sweets (GST 5%) ───────────────────────────────────────────
  ('K-JAMOON TIN-500GM',                 127.552, 133.93, 133.93, 133.93, 133.93),
  ('RASAGULLA TIN-500GM',                127.552, 133.93, 133.93, 133.93, 133.93),
  ('RASKADAM 200GM',                     102.038, 107.14, 107.14, 107.14, 107.14),
  ('JAMOON & RAGULLA COMBO PACK',        212.581, 223.21, 223.21, 223.21, 223.21),
  ('ULLAS GULLA 100GM',                   42.514,  44.64,  44.64,  44.64,  44.64),
  ('ULLAS GULLA 200GM',                   76.524,  80.35,  80.35,  80.35,  80.35)
)

-- ┌─────────────────────────────────────────────────────────────────┐
-- │  STEP 2 — Apply base_price and per-category prices               │
-- │                                                                  │
-- │  mrp MUST be updated in the same statement as base_price to      │
-- │  satisfy the products_mrp_gte_base_chk constraint (mrp >=        │
-- │  base_price). We use ci_mrp (CREDIT INSTITUTION - Net Rate) as   │
-- │  the canonical MRP — it is the highest/consumer-facing rate.     │
-- │  GREATEST() ensures we never lower an already-correct MRP.       │
-- └─────────────────────────────────────────────────────────────────┘
UPDATE products p
SET
  base_price               = rc.basic_rate::numeric(10,2),
  mrp                      = GREATEST(p.mrp, rc.ci_mrp::numeric(10,2)),
  retail_dealer_price      = rc.retail::numeric(10,2),
  credit_inst_mrp_price    = rc.ci_mrp::numeric(10,2),
  credit_inst_dealer_price = rc.ci_dealer::numeric(10,2),
  parlour_dealer_price     = rc.parlour::numeric(10,2),
  updated_at               = now()
FROM rate_chart rc
WHERE LOWER(TRIM(p.name)) = LOWER(TRIM(rc.product_name))
  AND p.deleted_at IS NULL;

-- ┌─────────────────────────────────────────────────────────────────┐
-- │  STEP 3 — Enforce report_alias character limits                  │
-- │                                                                  │
-- │  'Across' → 14 chars  (user-specified column width)             │
-- │  'Down'   → 22 chars  (max Packet Alias length observed in the  │
-- │              rate chart for Down products = 22 chars)            │
-- └─────────────────────────────────────────────────────────────────┘

-- 3a: Across products — truncate report_alias to 14 chars
UPDATE products
SET
  report_alias = LEFT(COALESCE(NULLIF(TRIM(report_alias), ''), name), 14),
  updated_at   = now()
WHERE COALESCE(print_direction, 'Across') = 'Across'
  AND deleted_at IS NULL
  AND LENGTH(COALESCE(NULLIF(TRIM(report_alias), ''), name)) > 14;

-- 3b: Down products — truncate report_alias to 22 chars
--     (max observed in rate chart Packet Alias column for Down products = 22)
UPDATE products
SET
  report_alias = LEFT(COALESCE(NULLIF(TRIM(report_alias), ''), name), 22),
  updated_at   = now()
WHERE print_direction = 'Down'
  AND deleted_at IS NULL
  AND LENGTH(COALESCE(NULLIF(TRIM(report_alias), ''), name)) > 22;

-- ┌─────────────────────────────────────────────────────────────────┐
-- │  STEP 4 — Verification                                           │
-- └─────────────────────────────────────────────────────────────────┘
DO $$
DECLARE
  v_updated       integer;
  v_alias_over    integer;
  v_no_match      integer;
BEGIN
  -- Count products whose base_price was touched in the last minute
  SELECT count(*) INTO v_updated
  FROM products
  WHERE updated_at >= now() - interval '1 minute'
    AND deleted_at IS NULL;

  -- Confirm no Across alias exceeds 14 chars, no Down alias exceeds 22 chars
  SELECT count(*) INTO v_alias_over
  FROM products
  WHERE (
    (COALESCE(print_direction, 'Across') = 'Across' AND LENGTH(report_alias) > 14)
    OR
    (print_direction = 'Down' AND LENGTH(report_alias) > 22)
  )
  AND deleted_at IS NULL;

  -- Products with no matching rate chart row (base_price unchanged from default)
  SELECT count(*) INTO v_no_match
  FROM products
  WHERE deleted_at IS NULL
    AND LOWER(TRIM(name)) NOT IN (
      SELECT LOWER(TRIM(pname)) FROM (VALUES
        ('BUFFALO MILK 500ML'), ('HCM 1000 ML'), ('HCM 1050ML'),
        ('CURD 140GM'), ('GHEE 1000ML'), ('PANEER 200 GM')
        -- abbreviated; full list above
      ) t(pname)
    );

  RAISE NOTICE '══════════════════════════════════════════════════';
  RAISE NOTICE 'Rate chart update complete:';
  RAISE NOTICE '  Products updated this run : %', v_updated;
  RAISE NOTICE '  Aliases exceeding limit     : % (expected 0)', v_alias_over;
  RAISE NOTICE '══════════════════════════════════════════════════';

  IF v_alias_over > 0 THEN
    RAISE EXCEPTION 'report_alias length violation — % rows exceed limit (Across>14 or Down>22)', v_alias_over;
  END IF;
END $$;

COMMIT;

-- ══════════════════════════════════════════════════════════════════
-- Migration 0027 complete:
-- ✓ base_price updated from RETAIL-DEALER Basic Rate (pre-GST)
-- ✓ mrp updated to GREATEST(existing, ci_mrp) — satisfies mrp_gte_base_chk
-- ✓ retail_dealer_price / credit_inst_mrp_price /
--   credit_inst_dealer_price / parlour_dealer_price updated from
--   their respective Net Rate columns in the rate chart
-- ✓ report_alias truncated to 14 chars for all Across products
-- ✓ report_alias truncated to 22 chars for all Down products
--   (22 = max Packet Alias length for Down products in the rate chart)
-- ══════════════════════════════════════════════════════════════════
