// ═══════════════════════════════════════════════════════════════════════
// diag-fix-d74741bb-cash-to-credit.ts
//
// Indent d74741bb-a2ab-4d72-8fce-4fd0767528a9 was placed on `cash` by
// mistake. It is a credit indent: nobody paid at the counter.
//
// ── Which rail? ──
// An indent can only carry payment_mode='cash' on three rails, and each one
// posts different money, so a column flip alone is never the whole fix. The
// script finds the id first, then applies that rail's correction:
//
//   orders          — a SUBSIDY indent (routes/subsidy-indents.ts is the only
//                     orders path that accepts cash). Cash wrote a `payments`
//                     receipt noted "Counter receipt for subsidy indent <id>";
//                     credit writes a dealer_ledger debit instead.
//                       1. orders.payment_mode -> 'credit'
//                       2. delete the subsidy counter receipt
//                       3. dealer_ledger debit for the order total
//                       4. reissueInvoiceIfExists, so paid_amount /
//                          payment_status re-derive from the new evidence
//
//   employee_orders — an EMPLOYEE SUBSIDY indent. Cash posts nothing; credit
//                     debits employee_ledger (recovered from salary). Same fix
//                     as diag-fix-gp-ada6-cash-to-credit.ts:
//                       1. employee_orders.payment_mode -> 'credit'
//                       2. employee_ledger debit for the indent total
//                       3. re-render the invoice, whose PDF prints the mode
//
//   direct_sales    — an AGENT gate pass. Same fix as
//                     diag-fix-gp0051-cash-to-credit.ts:
//                       1. direct_sales.payment_mode -> 'credit'
//                       2. reverseCounterCashReceipt
//                       3. debitDealerBalance
//                       4. reissueDirectSaleInvoiceIfExists
//
// The indent ledger debits are dated on the indent's delivery date so the
// debt sits beside the goods it bills; the gate-pass debit goes through
// debitDealerBalance unchanged, exactly as GP-0051's did.
//
// Every branch aborts rather than writes if the row is cancelled or not
// placed, if money that proves someone DID pay is found (a gateway capture,
// or a receipt this rail did not write), or if a ledger posting already
// exists against the id — which also makes a re-run a no-op instead of
// billing twice.
//
// USAGE (from apps/api):
//   npx tsx src/diag-fix-d74741bb-cash-to-credit.ts           # dry run
//   npx tsx src/diag-fix-d74741bb-cash-to-credit.ts --apply
// ═══════════════════════════════════════════════════════════════════════
import { pgClient } from "./lib/db.js";
import {
  debitDealerBalance,
  reverseCounterCashReceipt,
  ledgerPostedForSale,
  loadDirectSaleMoney,
} from "./lib/direct-sale-money.js";
import {
  reissueInvoiceIfExists,
  reissueDirectSaleInvoiceIfExists,
  generateEmployeeInvoicePdfSync,
} from "./lib/invoice-pdf.js";

const APPLY = process.argv.includes("--apply");
const ID = "d74741bb-a2ab-4d72-8fce-4fd0767528a9";
const NOTE = "(payment mode corrected from cash to credit)";

function abort(problems: string[]): never {
  console.log("\nABORT:");
  for (const p of problems) console.log(`  * ${p}`);
  throw new AbortRun();
}
class AbortRun extends Error {}

function dryRunStop(): never {
  console.log("\nDRY RUN - nothing written. Re-run with --apply.");
  throw new DryRun();
}
class DryRun extends Error {}

// A FUNCTION, not a shared query object: postgres.js caches an awaited query,
// so re-awaiting one object after the writes would report the old balance.
async function dealerBalance(tx: typeof pgClient, dealerId: string): Promise<number> {
  const [row] = (await tx`
    SELECT
      COALESCE(d.opening_balance, 0)
      + COALESCE((SELECT SUM(CASE WHEN dl.type='credit'
            AND COALESCE(dl.voucher_type,'') <> 'Opening'
            THEN dl.amount ELSE 0 END)
          FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      - COALESCE((SELECT SUM(CASE WHEN dl.type='debit'
            AND COALESCE(dl.voucher_type,'') <> 'Opening'
            THEN dl.amount ELSE 0 END)
          FROM dealer_ledger dl WHERE dl.dealer_id = d.id), 0)
      AS bal
    FROM dealers d WHERE d.id = ${dealerId}::uuid
  `) as any[];
  if (!row) throw new Error(`Dealer ${dealerId} not found`);
  return parseFloat(row.bal);
}

async function employeeBalance(tx: typeof pgClient, employeeId: string): Promise<number> {
  const [row] = (await tx`
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
    FROM employees e WHERE e.id = ${employeeId}::uuid
  `) as any[];
  if (!row) throw new Error(`Employee ${employeeId} not found`);
  return parseFloat(row.bal);
}

async function invoiceRow(id: string): Promise<any | undefined> {
  const [inv] = (await pgClient`
    SELECT invoice_number AS "invoiceNumber", total_amount::float8 AS total,
           paid_amount::float8 AS paid, payment_status::text AS "paymentStatus",
           due_date::text AS "dueDate", pdf_url IS NOT NULL AS "hasPdf"
      FROM invoices WHERE order_id = ${id}::uuid
  `) as any[];
  return inv;
}

// ════════════════════════════════════════════════════════════════════
// Rail 1: orders (subsidy indent)
// ════════════════════════════════════════════════════════════════════
async function fixOrder(): Promise<void> {
  const receiptNote = `Counter receipt for subsidy indent ${ID}`;

  const [o] = (await pgClient`
    SELECT o.id::text AS id, o.status::text AS status,
           o.payment_mode::text AS mode, o.payment_reference AS "paymentRef",
           o.grand_total::float8 AS total, o.delivery_date::text AS "deliveryDate",
           o.placed_by::text AS "placedBy",
           d.id::text AS "dealerId", d.code AS "dealerCode", d.name AS "dealerName",
           d.customer_type::text AS "custType"
      FROM orders o
      JOIN dealers d ON d.id = o.dealer_id
     WHERE o.id = ${ID}::uuid
  `) as any[];

  console.log("== Target: orders (subsidy indent) ==");
  console.table([{
    id: o.id, date: o.deliveryDate, status: o.status, mode: o.mode,
    dealer: `${o.dealerCode} ${o.dealerName}`, custType: o.custType, total: o.total,
  }]);

  const problems: string[] = [];
  if (o.mode !== "cash") problems.push(`payment_mode is already '${o.mode}', not 'cash'. Nothing to change.`);
  if (!["confirmed", "dispatched", "delivered"].includes(o.status)) {
    problems.push(
      `Status is '${o.status}'. Only a placed indent has posted money; a draft's ` +
      `confirm bills it later from its mode, so it needs no ledger correction here.`,
    );
  }
  if (o.paymentRef?.trim()) {
    problems.push(`The order carries a gateway reference '${o.paymentRef}'. Someone paid online.`);
  }

  const [posted] = (await pgClient`
    SELECT count(*)::int AS rows,
           COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE -amount END), 0)::float8 AS net
      FROM dealer_ledger WHERE reference_id = ${ID}::uuid
  `) as any[];
  if (posted.rows > 0) {
    problems.push(
      `${posted.rows} dealer_ledger row(s) already reference this indent ` +
      `(net Rs.${Number(posted.net).toFixed(2)}). The fix has already run, or this needs a manual look.`,
    );
  }

  // Our receipt, and anything else that says the dealer paid.
  const receipts = (await pgClient`
    SELECT p.id::text AS id, p.received_date::text AS "receivedDate",
           p.amount::float8 AS amount, p.mode::text AS mode, p.reference, p.notes
      FROM payments p
     WHERE p.notes = ${receiptNote}
        OR p.invoice_id IN (SELECT i.id FROM invoices i WHERE i.order_id = ${ID}::uuid)
  `) as any[];
  console.log("\n== Receipts against this indent ==");
  console.table(receipts);
  const ours = receipts.filter((r) => r.notes === receiptNote && r.mode === "cash");
  const foreign = receipts.filter((r) => !(r.notes === receiptNote && r.mode === "cash"));
  if (foreign.length > 0) {
    problems.push(
      `${foreign.length} receipt(s) were not written by the cash subsidy path. ` +
      `The dealer HAS paid something; settle by hand rather than flip to credit.`,
    );
  }
  const receiptTotal = ours.reduce((s, r) => s + Number(r.amount), 0);
  if (Math.abs(receiptTotal - o.total) > 0.01) {
    problems.push(
      `Counter receipt totals Rs.${receiptTotal.toFixed(2)} but the indent is ` +
      `Rs.${o.total.toFixed(2)}. The order holds lines beyond the cash subsidy line; ` +
      `needs a manual look before billing the dealer.`,
    );
  }

  if (problems.length > 0) abort(problems);

  const inv = await invoiceRow(ID);
  console.log("\n== Invoice today ==");
  console.table(inv ? [inv] : []);

  const balBefore = await dealerBalance(pgClient, o.dealerId);
  console.log("\n== Planned writes ==");
  console.log(`  1. orders.payment_mode          : 'cash' -> 'credit'`);
  console.log(`  2. remove subsidy cash receipt  : Rs.${receiptTotal.toFixed(2)}`);
  console.log(`  3. dealer_ledger debit          : Rs.${o.total.toFixed(2)} dated ${o.deliveryDate}`);
  console.log(`  4. reissue invoice ${inv?.invoiceNumber ?? "(none)"}; paid / status re-derived`);
  console.log(
    `\n  ${o.dealerCode} ${o.dealerName} balance ` +
    `Rs.${balBefore.toFixed(2)} -> Rs.${(balBefore - o.total).toFixed(2)}`,
  );
  console.log(`  Day Book loses Rs.${receiptTotal.toFixed(2)} of counter cash on ${o.deliveryDate}.`);

  if (!APPLY) dryRunStop();

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    const [live] = (await tx`
      SELECT payment_mode::text AS mode, status::text AS status,
             grand_total::float8 AS total
        FROM orders WHERE id = ${ID}::uuid FOR UPDATE
    `) as any[];
    if (!live) throw new Error("Indent vanished");
    if (live.mode !== "cash") throw new Error(`Mode changed to '${live.mode}' under us`);
    if (live.status === "cancelled") throw new Error("Indent was cancelled under us");
    if (Math.abs(live.total - o.total) > 0.001) throw new Error("Total changed under us");

    const [again] = (await tx`
      SELECT count(*)::int AS rows FROM dealer_ledger WHERE reference_id = ${ID}::uuid
    `) as any[];
    if (again.rows > 0) throw new Error("A ledger row appeared under us; aborting to avoid double billing");

    await tx`
      UPDATE orders
         SET payment_mode = 'credit'::payment_mode,
             updated_at   = now()
       WHERE id = ${ID}::uuid
    `;

    await tx`
      DELETE FROM payments
       WHERE dealer_id = ${o.dealerId}::uuid
         AND mode = 'cash'
         AND notes = ${receiptNote}
    `;

    // Same shape the subsidy credit path writes (routes/subsidy-indents.ts).
    const bal = await dealerBalance(tx, o.dealerId);
    await tx`
      INSERT INTO dealer_ledger
        (dealer_id, type, amount, reference_id, reference_type,
         voucher_type, voucher_date, description, balance_after, performed_by)
      VALUES
        (${o.dealerId}::uuid, 'debit', ${live.total.toFixed(2)}::numeric,
         ${ID}::uuid, 'order', 'Invoice', ${o.deliveryDate}::date,
         ${`Subsidy indent ${ID} ${NOTE}`},
         ${(bal - live.total).toFixed(2)}::numeric, ${o.placedBy}::uuid)
    `;
  });
  console.log("\nAPPLIED.");

  console.log("Invoice reissue:", await reissueInvoiceIfExists(ID));

  const [after] = (await pgClient`
    SELECT o.payment_mode::text AS mode,
           COALESCE((SELECT SUM(CASE WHEN dl.type='debit' THEN dl.amount ELSE -dl.amount END)
                       FROM dealer_ledger dl WHERE dl.reference_id = o.id), 0)::float8 AS "ledgerDr",
           COALESCE((SELECT SUM(p.amount) FROM payments p WHERE p.notes = ${receiptNote}), 0)::float8 AS "cashRcpt"
      FROM orders o WHERE o.id = ${ID}::uuid
  `) as any[];
  console.log("\n== After ==");
  console.table([{ ...after, billedInFull: Math.abs(after.ledgerDr - o.total) < 0.01 }]);
  console.table([await invoiceRow(ID)]);
  console.log(`${o.dealerCode} ${o.dealerName} balance: Rs.${(await dealerBalance(pgClient, o.dealerId)).toFixed(2)}`);
}

// ════════════════════════════════════════════════════════════════════
// Rail 2: employee_orders (employee subsidy indent)
// ════════════════════════════════════════════════════════════════════
async function fixEmployeeOrder(): Promise<void> {
  const [eo] = (await pgClient`
    SELECT eo.id::text AS id, eo.employee_id::text AS "employeeId",
           eo.delivery_date::text AS "deliveryDate", eo.status::text AS status,
           eo.payment_mode::text AS mode, eo.grand_total::float8 AS total,
           eo.placed_by::text AS "placedBy",
           e.name AS "employeeName", e.employee_code AS "employeeCode"
      FROM employee_orders eo
      JOIN employees e ON e.id = eo.employee_id
     WHERE eo.id = ${ID}::uuid
  `) as any[];

  console.log("== Target: employee_orders (employee subsidy indent) ==");
  console.table([{
    id: eo.id, employee: `${eo.employeeCode} ${eo.employeeName}`,
    date: eo.deliveryDate, status: eo.status, mode: eo.mode, total: eo.total,
  }]);

  const problems: string[] = [];
  if (eo.mode !== "cash") problems.push(`payment_mode is already '${eo.mode}', not 'cash'. Nothing to change.`);
  if (eo.status === "cancelled") problems.push(`This indent is cancelled; billing it would invent debt.`);

  const [posted] = (await pgClient`
    SELECT count(*)::int AS rows,
           COALESCE(SUM(CASE WHEN type='debit' THEN amount ELSE -amount END), 0)::float8 AS net
      FROM employee_ledger WHERE reference_id = ${ID}::uuid
  `) as any[];
  if (posted.rows > 0) {
    problems.push(
      `${posted.rows} employee_ledger row(s) already posted against this indent ` +
      `(net Rs.${Number(posted.net).toFixed(2)}). The fix has already run.`,
    );
  }

  // Cash posts nothing on this rail. A receipt would mean the employee paid.
  const stray = (await pgClient`
    SELECT p.id::text AS id, p.amount::float8 AS amount, p.mode::text AS mode, p.notes
      FROM payments p
     WHERE p.invoice_id IN (SELECT i.id FROM invoices i WHERE i.order_id = ${ID}::uuid)
        OR p.notes ILIKE ${"%" + ID + "%"}
        OR p.reference ILIKE ${"%" + ID + "%"}
  `) as any[];
  if (stray.length > 0) {
    console.table(stray);
    problems.push(`${stray.length} payments receipt(s) exist; the employee HAS paid. Settle by hand.`);
  }
  const [dl] = (await pgClient`
    SELECT count(*)::int AS rows FROM dealer_ledger WHERE reference_id = ${ID}::uuid
  `) as any[];
  if (dl.rows > 0) problems.push(`${dl.rows} dealer_ledger row(s) exist; an employee has no dealer ledger.`);

  if (problems.length > 0) abort(problems);

  const balBefore = await employeeBalance(pgClient, eo.employeeId);
  const inv = await invoiceRow(ID);
  console.log("\n== Planned writes ==");
  console.log(`  1. employee_orders.payment_mode : 'cash' -> 'credit'`);
  console.log(`  2. employee_ledger debit        : Rs.${eo.total.toFixed(2)} dated ${eo.deliveryDate}`);
  console.log(`  3. re-render invoice ${inv?.invoiceNumber ?? "(none - skipped)"} so the PDF reads Credit`);
  console.log(
    `\n  ${eo.employeeCode} ${eo.employeeName} balance ` +
    `Rs.${balBefore.toFixed(2)} -> Rs.${(balBefore - eo.total).toFixed(2)}`,
  );

  if (!APPLY) dryRunStop();

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;

    const [live] = (await tx`
      SELECT payment_mode::text AS mode, status::text AS status,
             grand_total::float8 AS total, delivery_date::text AS "deliveryDate"
        FROM employee_orders WHERE id = ${ID}::uuid FOR UPDATE
    `) as any[];
    if (!live) throw new Error("Indent vanished");
    if (live.mode !== "cash") throw new Error(`Mode changed to '${live.mode}' under us`);
    if (live.status === "cancelled") throw new Error("Indent was cancelled under us");

    const [again] = (await tx`
      SELECT count(*)::int AS rows FROM employee_ledger WHERE reference_id = ${ID}::uuid
    `) as any[];
    if (again.rows > 0) throw new Error("A ledger row appeared under us; aborting to avoid double billing");

    await tx`
      UPDATE employee_orders
         SET payment_mode = 'credit'::payment_mode,
             updated_at   = now()
       WHERE id = ${ID}::uuid
    `;

    // Same shape the create path writes (routes/direct-sales.ts).
    const bal = await employeeBalance(tx, eo.employeeId);
    await tx`
      INSERT INTO employee_ledger
        (employee_id, type, amount, reference_id, reference_type,
         voucher_type, voucher_date, description, balance_after, performed_by)
      VALUES
        (${eo.employeeId}::uuid, 'debit', ${live.total.toFixed(2)}::numeric,
         ${ID}::uuid, 'order', 'Invoice', ${live.deliveryDate}::date,
         ${`Employee subsidy indent ${ID} ${NOTE}`},
         ${(bal - live.total).toFixed(2)}::numeric, ${eo.placedBy}::uuid)
    `;
  });
  console.log("\nAPPLIED.");

  // The employee invoice PDF prints the payment mode, so re-render it when
  // one exists. Never mint one the indent didn't already have.
  if (inv) {
    try {
      const r = await generateEmployeeInvoicePdfSync(ID);
      console.log("Invoice re-rendered:", r.invoiceNumber);
    } catch (err) {
      console.error("Invoice re-render failed (books are already corrected):", err);
    }
  }

  const [after] = (await pgClient`
    SELECT eo.payment_mode::text AS mode,
           COALESCE((SELECT SUM(CASE WHEN el.type='debit' THEN el.amount ELSE -el.amount END)
                       FROM employee_ledger el WHERE el.reference_id = eo.id), 0)::float8 AS "ledgerNet"
      FROM employee_orders eo WHERE eo.id = ${ID}::uuid
  `) as any[];
  console.log("\n== After ==");
  console.table([{
    ...after,
    matchesTotal: Math.abs(after.ledgerNet - eo.total) < 0.01,
    employeeBalance: await employeeBalance(pgClient, eo.employeeId),
  }]);
}

// ════════════════════════════════════════════════════════════════════
// Rail 3: direct_sales (agent gate pass)
// ════════════════════════════════════════════════════════════════════
async function fixDirectSale(): Promise<void> {
  const [sale] = (await pgClient`
    SELECT ds.id::text AS id, ds.gp_no AS "gpNo", ds.sale_date::text AS "saleDate",
           ds.status::text AS status, ds.customer_type::text AS "customerType",
           ds.customer_id::text AS "customerId", ds.payment_mode::text AS mode,
           ds.grand_total::float8 AS total, ds.officer_id::text AS "officerId",
           d.code AS "dealerCode", d.name AS "dealerName"
      FROM direct_sales ds
      LEFT JOIN dealers d ON d.id = ds.customer_id
     WHERE ds.id = ${ID}::uuid
  `) as any[];

  console.log("== Target: direct_sales (gate pass) ==");
  console.table([{
    gpNo: sale.gpNo, id: sale.id, date: sale.saleDate, status: sale.status,
    customerType: sale.customerType, dealer: `${sale.dealerCode ?? ""} ${sale.dealerName ?? ""}`.trim(),
    mode: sale.mode, total: sale.total,
  }]);

  const problems: string[] = [];
  if (sale.mode !== "cash") problems.push(`payment_mode is already '${sale.mode}', not 'cash'. Nothing to change.`);
  if (sale.status === "cancelled") problems.push(`This sale is cancelled; billing it would invent debt.`);
  if (sale.customerType !== "agent") {
    problems.push(
      `customer_type is '${sale.customerType}', not 'agent'. Only an agent pass has a ` +
      `dealer ledger to bill; a walk-in cash customer cannot be put on credit.`,
    );
  }
  const money = await loadDirectSaleMoney(pgClient, sale.id);
  if (money.collected > 0.001) {
    problems.push(`The counter QR collected Rs.${money.collected.toFixed(2)}; that is real money, refund it instead.`);
  }
  const posted = await ledgerPostedForSale(pgClient, sale.id);
  if (posted > 0.001) problems.push(`Rs.${posted.toFixed(2)} already posted to the dealer ledger. The fix has already run.`);

  if (problems.length > 0) abort(problems);

  const receipts = (await pgClient`
    SELECT p.id::text AS id, p.received_date::text AS "receivedDate",
           p.amount::float8 AS amount, p.reference, p.notes
      FROM payments p
     WHERE p.mode = 'cash'
       AND p.notes IN (${"Counter cash for gate pass " + (sale.gpNo ?? sale.id)},
                       ${"Counter cash for gate pass " + sale.id})
  `) as any[];
  const receiptTotal = receipts.reduce((s, r) => s + Number(r.amount), 0);
  console.log("\n== Counter cash receipt(s) to remove ==");
  console.table(receipts);

  const inv = await invoiceRow(sale.id);
  console.log("\n== Invoice today ==");
  console.table(inv ? [inv] : []);

  const balBefore = await dealerBalance(pgClient, sale.customerId);
  console.log("\n== Planned writes ==");
  console.log(`  1. direct_sales.payment_mode   : 'cash' -> 'credit'`);
  console.log(`  2. remove counter cash receipt : Rs.${receiptTotal.toFixed(2)}`);
  console.log(`  3. dealer_ledger debit         : Rs.${sale.total.toFixed(2)}`);
  console.log(`  4. reissue invoice ${inv?.invoiceNumber ?? "(none)"}; PDF re-stamped NOT PAID`);
  console.log(
    `\n  ${sale.dealerCode} ${sale.dealerName} balance ` +
    `Rs.${balBefore.toFixed(2)} -> Rs.${(balBefore - sale.total).toFixed(2)}`,
  );

  if (!APPLY) dryRunStop();

  await pgClient.begin(async (_tx) => {
    const tx = _tx as unknown as typeof pgClient;
    const [live] = (await tx`
      SELECT payment_mode::text AS mode, status::text AS status,
             grand_total::float8 AS total, gp_no AS "gpNo"
        FROM direct_sales WHERE id = ${sale.id}::uuid FOR UPDATE
    `) as any[];
    if (!live) throw new Error("Sale vanished");
    if (live.mode !== "cash") throw new Error(`Mode changed to '${live.mode}' under us`);
    if (live.status === "cancelled") throw new Error("Sale was cancelled under us");
    if ((await ledgerPostedForSale(tx, sale.id)) > 0.001)
      throw new Error("A ledger posting appeared under us; aborting to avoid double billing");

    await tx`
      UPDATE direct_sales
         SET payment_mode = 'credit'::payment_mode,
             updated_at   = now()
       WHERE id = ${sale.id}::uuid
    `;
    await reverseCounterCashReceipt(tx, sale.id);
    await debitDealerBalance(
      tx, sale.customerId, live.total, sale.id,
      `Gate pass ${live.gpNo ?? sale.id} ${NOTE}`, sale.officerId,
    );
  });
  console.log("\nAPPLIED.");

  console.log("Invoice reissue:", await reissueDirectSaleInvoiceIfExists(sale.id));
  console.log("\n== After ==");
  console.table([{
    ledgerDr: await ledgerPostedForSale(pgClient, sale.id),
    total: sale.total,
  }]);
  console.table([await invoiceRow(sale.id)]);
  console.log(`${sale.dealerCode} ${sale.dealerName} balance: Rs.${(await dealerBalance(pgClient, sale.customerId)).toFixed(2)}`);
}

// ════════════════════════════════════════════════════════════════════
// Resolve the id, then dispatch
// ════════════════════════════════════════════════════════════════════
async function main(): Promise<void> {
  const [hit] = (await pgClient`
    SELECT
      EXISTS (SELECT 1 FROM orders          WHERE id = ${ID}::uuid) AS "inOrders",
      EXISTS (SELECT 1 FROM employee_orders WHERE id = ${ID}::uuid) AS "inEmployeeOrders",
      EXISTS (SELECT 1 FROM direct_sales    WHERE id = ${ID}::uuid) AS "inDirectSales"
  `) as any[];
  console.log("== Where the id lives ==");
  console.table([hit]);

  const found = [hit.inOrders, hit.inEmployeeOrders, hit.inDirectSales].filter(Boolean).length;
  if (found === 0) abort([`${ID} is not in orders, employee_orders or direct_sales.`]);
  if (found > 1) abort([`${ID} matches more than one table; resolve by hand.`]);

  if (hit.inOrders) await fixOrder();
  else if (hit.inEmployeeOrders) await fixEmployeeOrder();
  else await fixDirectSale();
}

try {
  await main();
} catch (err) {
  if (err instanceof AbortRun) process.exitCode = 1;
  else if (!(err instanceof DryRun)) {
    console.error(err);
    process.exitCode = 1;
  }
} finally {
  await pgClient.end();
}
