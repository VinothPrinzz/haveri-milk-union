// ═══════════════════════════════════════════════════════════════════════
// diag-fix-gp-ada6-cash-to-credit.ts
//
// "GP-ADA6" is the web UI's fallback label for a sale with no gp_no:
// `GP-${id.slice(-4).toUpperCase()}` (apps/web/src/services/api.ts). It is
// NOT a gate pass — it is the EMPLOYEE SUBSIDY indent
// 55069931-371e-4b06-9649-c6474c77ada6, SUPRIYA ATAVALAGI (code 23), ghee
// sachet 500ml × 2, ₹576.32 on 2026-08-13. It was rung up on `cash` by
// mistake; the subsidy is always recovered from salary, i.e. credit. Every
// one of its 12 peers on this rail carries payment_mode='credit' and a
// matching ₹576.32 employee_ledger debit; this one alone carries neither.
//
// ── What has to move, and why ──
// On the employee_orders rail the payment mode is not decoration:
//
//   credit — POST /direct-sales/employee-subsidy debits employee_ledger, so
//            the amount shows in Finance → Employee Credit and is recovered
//            from salary (routes/direct-sales.ts, the `chargeDelta` block).
//            Sales reports put it on the CREDIT side.
//   cash   — posts nothing at all. No ledger row, no `payments` receipt.
//            Sales reports count it as collected cash
//            (sales-reports.ts: `eo.payment_mode IN ('cash','upi','wallet')`).
//
// So the sale has been sitting in the reports as ₹576.32 of money the union
// took at the counter, when in fact nobody paid and nothing was billed to
// the employee. Two writes fix it, and only two:
//
//   1. employee_orders.payment_mode → 'credit'
//   2. the employee_ledger debit that was never made
//
// NOTHING needs reversing on the cash side, because cash posted nothing —
// verified below, not assumed: the script aborts if a `payments` receipt or
// a dealer_ledger row is found against this indent.
//
// The INVOICE is deliberately untouched. INV-HMU-2026-55069931 already reads
// unpaid / ₹0 paid, which is what a credit sale should read, and it carries
// dealer_id = NULL so it never entered AR Aging (that report keys on
// i.dealer_id). Employee debt is tracked in Finance → Employee Credit, which
// is exactly what write 2 restores.
//
// Idempotent: a ledger row already posted against this indent means the fix
// has run, and the script stops rather than billing the employee twice.
//
// USAGE (from apps/api):
//   npx tsx src/diag-fix-gp-ada6-cash-to-credit.ts           # dry run
//   npx tsx src/diag-fix-gp-ada6-cash-to-credit.ts --apply
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";

const APPLY = process.argv.includes("--apply");
const ORDER_ID = "55069931-371e-4b06-9649-c6474c77ada6";

// ── Read the current state ──
const [eo] = (await pgClient`
  SELECT eo.id::text AS id,
         eo.employee_id::text AS "employeeId",
         eo.delivery_date::text AS "deliveryDate",
         eo.status::text AS status,
         eo.payment_mode::text AS mode,
         eo.grand_total::float8 AS total,
         eo.placed_by::text AS "placedBy",
         e.name AS "employeeName", e.employee_code AS "employeeCode",
         e.credit_limit::float8 AS "creditLimit"
    FROM employee_orders eo
    JOIN employees e ON e.id = eo.employee_id
   WHERE eo.id = ${ORDER_ID}::uuid
`) as any[];

if (!eo) {
  console.error(`No employee_orders row ${ORDER_ID}`);
  await pgClient.end();
  process.exit(1);
}

console.log("── Target ──");
console.table([{
  id: eo.id,
  employee: `${eo.employeeCode} ${eo.employeeName}`,
  date: eo.deliveryDate,
  status: eo.status,
  mode: eo.mode,
  total: eo.total,
}]);

// ── Guards. Each one is a reason NOT to write. ──
const problems: string[] = [];

if (eo.mode !== "cash") {
  problems.push(`payment_mode is already '${eo.mode}', not 'cash'. Nothing to change.`);
}
if (eo.status === "cancelled") {
  problems.push(`This indent is cancelled; billing it to the employee would invent debt.`);
}

const [posted] = (await pgClient`
  SELECT COALESCE(SUM(CASE WHEN el.type = 'debit'  THEN  el.amount
                           WHEN el.type = 'credit' THEN -el.amount
                           ELSE 0 END), 0)::float8 AS net,
         count(*)::int AS rows
    FROM employee_ledger el
   WHERE el.reference_id = ${ORDER_ID}::uuid
`) as any[];
if (posted.rows > 0) {
  problems.push(
    `${posted.rows} employee_ledger row(s) already posted against this indent ` +
    `(net ₹${Number(posted.net).toFixed(2)}). The fix has already run.`,
  );
}

// Cash posted nothing on this rail — prove it rather than trust it, because
// a stray receipt would mean the employee HAS paid and must not be billed.
const strayPayments = (await pgClient`
  SELECT p.id::text AS id, p.amount::float8 AS amount, p.mode::text AS mode, p.notes
    FROM payments p
   WHERE p.invoice_id IN (SELECT i.id FROM invoices i WHERE i.order_id = ${ORDER_ID}::uuid)
      OR p.notes ILIKE ${"%" + ORDER_ID + "%"}
      OR p.reference ILIKE ${"%" + ORDER_ID + "%"}
`) as any[];
if (strayPayments.length > 0) {
  console.log("\n── Unexpected `payments` receipts ──");
  console.table(strayPayments);
  problems.push(
    `${strayPayments.length} payments receipt(s) exist for this indent. Someone HAS ` +
    `paid, so this must be settled by hand, not flipped to credit.`,
  );
}

const strayLedger = (await pgClient`
  SELECT id::text AS id, type::text AS type, amount::float8 AS amount, description
    FROM dealer_ledger WHERE reference_id = ${ORDER_ID}::uuid
`) as any[];
if (strayLedger.length > 0) {
  console.log("\n── Unexpected dealer_ledger rows ──");
  console.table(strayLedger);
  problems.push(`${strayLedger.length} dealer_ledger row(s) exist; an employee has no dealer ledger.`);
}

if (problems.length > 0) {
  console.log("\nABORT:");
  for (const p of problems) console.log(`  • ${p}`);
  await pgClient.end();
  process.exit(1);
}

// ── What the write will do ──
const [before] = (await pgClient`
  SELECT
    COALESCE(e.opening_balance, 0)
    + COALESCE((SELECT SUM(CASE WHEN el.type = 'credit'
                                 AND COALESCE(el.voucher_type,'') <> 'Opening'
                                THEN el.amount ELSE 0 END)
                  FROM employee_ledger el WHERE el.employee_id = e.id), 0)
    - COALESCE((SELECT SUM(CASE WHEN el.type = 'debit'
                                 AND COALESCE(el.voucher_type,'') <> 'Opening'
                                THEN el.amount ELSE 0 END)
                  FROM employee_ledger el WHERE el.employee_id = e.id), 0)
    AS bal
  FROM employees e WHERE e.id = ${eo.employeeId}::uuid
`) as any[];
const balBefore = parseFloat(before.bal);

console.log("\n── Planned writes ──");
console.log(`  1. employee_orders.payment_mode : 'cash' → 'credit'`);
console.log(`  2. employee_ledger debit        : ₹${eo.total.toFixed(2)}`);
console.log(
  `\n  ${eo.employeeCode} ${eo.employeeName} balance ` +
  `₹${balBefore.toFixed(2)} → ₹${(balBefore - eo.total).toFixed(2)} ` +
  `(credit limit ₹${Number(eo.creditLimit ?? 0).toFixed(2)})`,
);
// Note, not a gate: credit_limit is 0 for EVERY employee on the subsidy rail
// and the create path never checks it (only the standing-indent confirm in
// employee-indents.ts does). A -576.32 balance against a 0 limit is the
// normal, universal state here — all 13 peers sit at exactly that.
if (eo.creditLimit != null && balBefore - eo.total < -Number(eo.creditLimit)) {
  console.log(
    `  (credit_limit is unset on the subsidy rail, as it is for every peer, ` +
    `so this is the normal resting state rather than an overdraw.)`,
  );
}

if (!APPLY) {
  console.log("\nDRY RUN — nothing written. Re-run with --apply.");
  await pgClient.end();
  process.exit(0);
}

// ── Apply ──
let balanceAfter = 0;
await pgClient.begin(async (_tx) => {
  const tx = _tx as unknown as typeof pgClient;

  // Re-read under lock: the mode and total are what the ledger row is built
  // from, so they must not move between the check above and the write.
  const [live] = (await tx`
    SELECT payment_mode::text AS mode, status::text AS status,
           grand_total::float8 AS total, delivery_date::text AS "deliveryDate"
      FROM employee_orders WHERE id = ${ORDER_ID}::uuid FOR UPDATE
  `) as any[];
  if (!live) throw new Error("Indent vanished");
  if (live.mode !== "cash") throw new Error(`Mode changed to '${live.mode}' under us`);
  if (live.status === "cancelled") throw new Error("Indent was cancelled under us");

  const [again] = (await tx`
    SELECT count(*)::int AS rows FROM employee_ledger
     WHERE reference_id = ${ORDER_ID}::uuid
  `) as any[];
  if (again.rows > 0) throw new Error("A ledger row appeared under us; aborting to avoid double billing");

  await tx`
    UPDATE employee_orders
       SET payment_mode = 'credit'::payment_mode,
           updated_at   = now()
     WHERE id = ${ORDER_ID}::uuid
  `;

  // balance_after computed inside the transaction, as every other posting
  // path on this rail does, so the running balance reads correctly.
  const [bal] = (await tx`
    SELECT
      COALESCE(e.opening_balance, 0)
      + COALESCE((SELECT SUM(CASE WHEN el.type = 'credit'
                                   AND COALESCE(el.voucher_type,'') <> 'Opening'
                                  THEN el.amount ELSE 0 END)
                    FROM employee_ledger el WHERE el.employee_id = e.id), 0)
      - COALESCE((SELECT SUM(CASE WHEN el.type = 'debit'
                                   AND COALESCE(el.voucher_type,'') <> 'Opening'
                                  THEN el.amount ELSE 0 END)
                    FROM employee_ledger el WHERE el.employee_id = e.id), 0)
      AS bal
    FROM employees e WHERE e.id = ${eo.employeeId}::uuid
  `) as any[];
  balanceAfter = parseFloat(bal.bal) - live.total;

  // Same shape the create path writes (routes/direct-sales.ts), so the row
  // sits alongside its 12 peers rather than looking like a foreign entry.
  // voucher_date is the DELIVERY date, not today, so the debt ages from when
  // the goods actually went out.
  await tx`
    INSERT INTO employee_ledger
      (employee_id, type, amount, reference_id, reference_type,
       voucher_type, voucher_date, description, balance_after, performed_by)
    VALUES
      (${eo.employeeId}::uuid, 'debit', ${live.total.toFixed(2)}::numeric,
       ${ORDER_ID}::uuid, 'order',
       'Invoice', ${live.deliveryDate}::date,
       ${"Employee subsidy indent " + ORDER_ID + " (payment mode corrected from cash to credit)"},
       ${balanceAfter.toFixed(2)}::numeric, ${eo.placedBy}::uuid)
  `;
});

console.log("\nAPPLIED.");

// ── Verify ──
const [after] = (await pgClient`
  SELECT eo.payment_mode::text AS mode,
         COALESCE((SELECT SUM(CASE WHEN el.type='debit' THEN el.amount ELSE -el.amount END)
                     FROM employee_ledger el WHERE el.reference_id = eo.id), 0)::float8 AS "ledgerNet",
         (SELECT count(*)::int FROM employee_ledger el WHERE el.reference_id = eo.id) AS "ledgerRows"
    FROM employee_orders eo WHERE eo.id = ${ORDER_ID}::uuid
`) as any[];
console.log("\n── After ──");
console.table([{
  mode: after.mode,
  ledgerRows: after.ledgerRows,
  ledgerNet: after.ledgerNet,
  matchesTotal: Math.abs(after.ledgerNet - eo.total) < 0.01,
  employeeBalance: balanceAfter,
}]);

// The whole 2026-08 employee-subsidy batch, so the outlier is visibly gone.
const batch = (await pgClient`
  SELECT eo.delivery_date::text AS date, eo.status::text AS status,
         eo.payment_mode::text AS mode, eo.grand_total::float8 AS total,
         e.name AS "employeeName",
         COALESCE((SELECT SUM(CASE WHEN el.type='debit' THEN el.amount ELSE -el.amount END)
                     FROM employee_ledger el WHERE el.reference_id = eo.id), 0)::float8 AS "ledgerNet"
    FROM employee_orders eo
    JOIN employees e ON e.id = eo.employee_id
   WHERE eo.delivery_date >= '2026-08-01'::date
     AND eo.status <> 'cancelled'
   ORDER BY eo.delivery_date, eo.created_at
`) as any[];
console.log("\n── 2026-08 employee subsidy indents ──");
console.table(batch.map((b) => ({
  ...b,
  billed: Math.abs(b.ledgerNet - b.total) < 0.01 ? "yes" : "NO",
})));

await pgClient.end();
