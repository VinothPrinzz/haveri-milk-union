import { Job, Queue } from "bullmq";
import { sql } from "../lib/db.js";
import { redis } from "../lib/redis.js";

export async function processPaymentReminders(job: Job) {
  // Find dealers with overdue credit orders (pending > 3 days)
  const overdue = await sql`
    SELECT d.id, d.name, d.phone,
           COALESCE(SUM(o.grand_total), 0)::numeric AS overdue_amount,
           COUNT(o.id)::int AS overdue_orders
    FROM dealers d
    JOIN orders o ON o.dealer_id = d.id
    WHERE o.payment_mode = 'credit'
      AND o.status IN ('pending', 'confirmed', 'dispatched')
      AND o.created_at < now() - interval '3 days'
      AND d.active = true
      AND d.deleted_at IS NULL
    GROUP BY d.id, d.name, d.phone
    HAVING SUM(o.grand_total) > 0
  `;

  if (overdue.length === 0) {
    console.log("[PaymentReminders] No overdue dealers found");
    return { checked: 0, reminders: 0 };
  }

  console.log(`[PaymentReminders] Found ${overdue.length} dealers with overdue payments`);

  // Queue push notifications for each overdue dealer
  const notifQueue = new Queue("push-notifications", { connection: redis });

  for (const dealer of overdue) {
    const amount = parseFloat(dealer.overdue_amount);
    await notifQueue.add("payment-reminder", {
      event: "payment.reminder" as const,
      dealerId: dealer.id,
      title: "Payment Reminder 💰",
      body: `You have ₹${amount.toFixed(0)} outstanding across ${dealer.overdue_orders} orders. Please clear your dues.`,
    });
  }

  await notifQueue.close();

  console.log(`[PaymentReminders] Queued ${overdue.length} reminder notifications`);
  return { checked: overdue.length, reminders: overdue.length };
}
