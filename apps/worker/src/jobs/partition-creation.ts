import { Job } from "bullmq";
import { sql } from "../lib/db.js";

export async function processPartitionCreation(job: Job) {
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

    // Create the partition using the helper function from migration 0001
    await sql`SELECT create_orders_partition(${rangeStart}::date, ${rangeEnd}::date)`;

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
