import { sql } from "../lib/db.js";

export async function processPartitionCreation() {
  // Calculate next month
  const now = new Date();
  const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
  const monthAfter = new Date(now.getFullYear(), now.getMonth() + 2, 1);

  const partName = `orders_${nextMonth.getFullYear()}_${String(nextMonth.getMonth() + 1).padStart(2, "0")}`;
  const rangeStart = nextMonth.toISOString().split("T")[0];
  const rangeEnd = monthAfter.toISOString().split("T")[0];

  console.log(`[Partition] Creating ${partName} for ${rangeStart} to ${rangeEnd}`);

  try {
    // Check if partition already exists
    const [existing] = await sql`
      SELECT 1 FROM pg_class WHERE relname = ${partName}
    `;

    if (existing) {
      console.log(`[Partition] ${partName} already exists — skipping`);
      return { partition: partName, status: "already_exists" };
    }

    // Create the partition using the helper function from migration 0001.
    // Its signature is (p_year integer, p_month integer) — it derives the
    // range itself. This was called with two dates, which meant the job threw
    // "function create_orders_partition(date, date) does not exist" the first
    // time it actually had to create anything. It went unnoticed because the
    // pg_class check above short-circuits whenever the partition already
    // exists, and partitions were pre-created through 2026-12.
    await sql`SELECT create_orders_partition(
      ${nextMonth.getFullYear()}::int, ${nextMonth.getMonth() + 1}::int
    )`;

    console.log(`[Partition] ✅ Created ${partName}`);
    return { partition: partName, status: "created", rangeStart, rangeEnd };
  } catch (err: any) {
    // If partition already exists (race condition), that's OK
    if (err.message?.includes("already exists")) {
      console.log(`[Partition] ${partName} already exists (race) — OK`);
      return { partition: partName, status: "already_exists" };
    }
    throw err;
  }
}
