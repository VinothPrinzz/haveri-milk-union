// Read-only: did AutoConfirm run a heavy pass during the 10:30-10:40 IST stall?
// Its ledger rows are self-identifying ("Auto-confirmed standing-indent order").
import { pgClient } from "./lib/db.js";

async function main() {
  console.log("=== 1. Auto-confirm ledger writes per MINUTE today (IST) ===");
  const perMin = await pgClient`
    SELECT to_char(dl.created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS minute,
           count(*) AS n
      FROM dealer_ledger dl
     WHERE (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date
           = (now() AT TIME ZONE 'Asia/Kolkata')::date
       AND dl.description LIKE 'Auto-confirmed standing-indent order%'
     GROUP BY 1 ORDER BY 1
  `;
  console.table(perMin);

  console.log("\n=== 2. Same, but per minute BY ROUTE (10:00-12:00 IST) ===");
  const byRoute = await pgClient`
    SELECT to_char(dl.created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS minute,
           r.name AS route,
           count(*) AS n
      FROM dealer_ledger dl
      JOIN orders o ON o.id = dl.reference_id
      LEFT JOIN routes r ON r.id = o.route_id
     WHERE (dl.created_at AT TIME ZONE 'Asia/Kolkata')::date
           = (now() AT TIME ZONE 'Asia/Kolkata')::date
       AND dl.description LIKE 'Auto-confirmed standing-indent order%'
       AND (dl.created_at AT TIME ZONE 'Asia/Kolkata')::time
             BETWEEN '10:00' AND '12:00'
     GROUP BY 1, 2 ORDER BY 1, 2
  `;
  console.table(byRoute);

  console.log("\n=== 3. ALL order confirms per minute, 10:20-10:50 IST (any source) ===");
  const confirms = await pgClient`
    SELECT to_char(o.confirmed_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS minute,
           count(*) AS n
      FROM orders o
     WHERE (o.confirmed_at AT TIME ZONE 'Asia/Kolkata')::date
           = (now() AT TIME ZONE 'Asia/Kolkata')::date
       AND (o.confirmed_at AT TIME ZONE 'Asia/Kolkata')::time
             BETWEEN '10:20' AND '10:50'
     GROUP BY 1 ORDER BY 1
  `;
  console.table(confirms);

  console.log("\n=== 4. Employee auto-confirms today (same job, second pass) ===");
  const emp = await pgClient`
    SELECT to_char(el.created_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS minute,
           count(*) AS n
      FROM employee_ledger el
     WHERE (el.created_at AT TIME ZONE 'Asia/Kolkata')::date
           = (now() AT TIME ZONE 'Asia/Kolkata')::date
       AND el.description LIKE 'Auto-confirmed employee standing-indent order%'
     GROUP BY 1 ORDER BY 1
  `;
  console.table(emp);

  await pgClient.end();
}

main().catch(async (e) => {
  console.error(e);
  await pgClient.end();
  process.exit(1);
});
