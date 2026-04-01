-- Migration 0003: Seed marketing banners + dummy invoices
-- Run after 0001 and 0002

-- ── Marketing Banners ──
INSERT INTO banners (title, subtitle, image_url, start_date, end_date, zone_id, active) VALUES
  ('Bulk Discount on Full Cream Milk', 'Buy 50+ units and save 5% instantly', NULL, '2025-01-01', '2025-12-31', NULL, true),
  ('Premium Butter Now Available', 'Fresh from Haveri dairy farms', NULL, '2025-01-01', '2025-12-31', NULL, true),
  ('Free Delivery on Orders Above ₹500', 'Limited time offer for all zones', NULL, '2025-01-15', '2025-06-30', NULL, true),
  ('Festive Season Special', 'Extra 10% off on sweets & flavoured milk', NULL, '2025-03-01', '2025-04-30', NULL, true)
ON CONFLICT DO NOTHING;

-- ── Dummy Orders + Items + Invoices (for first seeded dealer) ──
-- Get first dealer and zone
DO $$
DECLARE
  v_dealer_id uuid;
  v_zone_id uuid;
  v_order1 uuid;
  v_order2 uuid;
  v_order3 uuid;
  v_order4 uuid;
  v_prod1 uuid;
  v_prod2 uuid;
  v_prod3 uuid;
BEGIN
  SELECT id, zone_id INTO v_dealer_id, v_zone_id FROM dealers WHERE deleted_at IS NULL ORDER BY created_at LIMIT 1;
  IF v_dealer_id IS NULL THEN RETURN; END IF;

  SELECT id INTO v_prod1 FROM products WHERE available = true ORDER BY name LIMIT 1;
  SELECT id INTO v_prod2 FROM products WHERE available = true ORDER BY name LIMIT 1 OFFSET 1;
  SELECT id INTO v_prod3 FROM products WHERE available = true ORDER BY name LIMIT 1 OFFSET 2;

  IF v_prod1 IS NULL THEN RETURN; END IF;

  -- Order 1: confirmed (today)
  INSERT INTO orders (dealer_id, zone_id, status, payment_mode, subtotal, total_gst, grand_total, item_count, created_at)
  VALUES (v_dealer_id, v_zone_id, 'confirmed', 'wallet', 850.00, 42.50, 892.50, 15, now() - interval '2 hours')
  RETURNING id INTO v_order1;

  INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total) VALUES
    (v_order1, v_prod1, 'Full Cream Milk', 10, 28.00, 5, 14.00, 294.00),
    (v_order1, v_prod2, 'Curd Cup', 5, 34.00, 5, 8.50, 178.50);

  -- Order 2: delivered (yesterday)
  INSERT INTO orders (dealer_id, zone_id, status, payment_mode, subtotal, total_gst, grand_total, item_count, created_at)
  VALUES (v_dealer_id, v_zone_id, 'delivered', 'wallet', 720.00, 36.00, 756.00, 12, now() - interval '1 day')
  RETURNING id INTO v_order2;

  INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total) VALUES
    (v_order2, v_prod1, 'Full Cream Milk', 8, 28.00, 5, 11.20, 235.20),
    (v_order2, v_prod3, 'Fresh Paneer', 4, 95.00, 5, 19.00, 399.00);

  -- Order 3: pending (2 days ago)
  INSERT INTO orders (dealer_id, zone_id, status, payment_mode, subtotal, total_gst, grand_total, item_count, created_at)
  VALUES (v_dealer_id, v_zone_id, 'pending', 'credit', 340.00, 17.00, 357.00, 6, now() - interval '2 days')
  RETURNING id INTO v_order3;

  INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total) VALUES
    (v_order3, v_prod2, 'Curd Cup', 6, 34.00, 5, 10.20, 214.20);

  -- Order 4: cancelled (3 days ago)
  INSERT INTO orders (dealer_id, zone_id, status, payment_mode, subtotal, total_gst, grand_total, item_count, created_at)
  VALUES (v_dealer_id, v_zone_id, 'cancelled', 'wallet', 190.00, 9.50, 199.50, 4, now() - interval '3 days')
  RETURNING id INTO v_order4;

  INSERT INTO order_items (order_id, product_id, product_name, quantity, unit_price, gst_percent, gst_amount, line_total) VALUES
    (v_order4, v_prod1, 'Full Cream Milk', 4, 28.00, 5, 5.60, 117.60);

  -- Invoices for delivered + confirmed orders
  INSERT INTO invoices (order_id, dealer_id, invoice_number, invoice_date, taxable_amount, cgst, sgst, total_tax, total_amount, dealer_name, dealer_gst_number)
  VALUES
    (v_order1, v_dealer_id, 'INV-HMU-2025-0001', now() - interval '2 hours', 850.00, 21.25, 21.25, 42.50, 892.50,
     (SELECT name FROM dealers WHERE id = v_dealer_id), (SELECT gst_number FROM dealers WHERE id = v_dealer_id)),
    (v_order2, v_dealer_id, 'INV-HMU-2025-0002', now() - interval '1 day', 720.00, 18.00, 18.00, 36.00, 756.00,
     (SELECT name FROM dealers WHERE id = v_dealer_id), (SELECT gst_number FROM dealers WHERE id = v_dealer_id))
  ON CONFLICT (order_id) DO NOTHING;

END $$;
