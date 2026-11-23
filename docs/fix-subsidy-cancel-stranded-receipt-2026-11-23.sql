-- ═══════════════════════════════════════════════════════════════════════
-- One-off: remove the cash receipt stranded by a cancelled subsidy indent.
--
-- Dealer  : RAKESH G HARKAMANI (158aeafb-d0dc-47f6-88a7-6bde1bece1a5)
-- Order   : 1ff48971-db2e-463c-80fa-4effc484817f (#HMU-817F), cash subsidy
--           indent, Rs 106.40, placed by mistake and cancelled 2026-11-23.
--           No cash was collected.
-- Receipt : aa13b4fe-2014-4452-b04e-d08940f0ddc9 (RC-40F0DDC9, SUB-1FF48971)
--
-- The cancel left the receipt behind, so the Dealer Statement read
-- Rs 157.25 Cr against a ledger / available balance of Rs 50.85.
-- After this both read Rs 50.85 Cr. Code fix: lib/cancel-order.ts now
-- deletes the subsidy counter receipt on cancel.
--
-- Checked before writing: no cheque, payment_allocation or dealer_ledger
-- row references this payment, and it is the only stranded subsidy
-- receipt in the database.
-- ═══════════════════════════════════════════════════════════════════════
BEGIN;

DELETE FROM payments
 WHERE id = 'aa13b4fe-2014-4452-b04e-d08940f0ddc9'
   AND reference = 'SUB-1FF48971'
   AND amount = 106.40;

-- Same result refreshInvoiceSettlement() gives once the receipt is gone.
UPDATE invoices
   SET paid_amount = 0, payment_status = 'unpaid'
 WHERE id = '4de1e23d-df8a-4c7f-9dea-1f9b843318cf'
   AND order_id = '1ff48971-db2e-463c-80fa-4effc484817f';

-- Expect: 0 rows
SELECT id FROM payments WHERE id = 'aa13b4fe-2014-4452-b04e-d08940f0ddc9';

COMMIT;
