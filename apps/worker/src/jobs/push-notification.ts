import { Job } from "bullmq";
import { sendPushNotification } from "../lib/fcm.js";

export interface PushNotificationJobData {
  event: "order.confirmed" | "order.dispatched" | "window.opening" | "window.closing" | "payment.reminder" | "custom";
  dealerId?: string;
  zoneId?: string;
  orderId?: string;
  title?: string;
  body?: string;
}

export async function processPushNotification(job: Job<PushNotificationJobData>) {
  const { event, dealerId, zoneId, orderId, title, body } = job.data;

  let pushTitle = title || "";
  let pushBody = body || "";

  switch (event) {
    case "order.confirmed":
      pushTitle = "Indent Confirmed ✅";
      pushBody = `Your indent #${orderId?.slice(0, 8)} has been confirmed. Dispatch tomorrow morning.`;
      break;

    case "order.dispatched":
      pushTitle = "Order Dispatched 🚚";
      pushBody = `Your indent #${orderId?.slice(0, 8)} is on the way!`;
      break;

    case "window.opening":
      pushTitle = "Window Opening Soon 🟢";
      pushBody = "The ordering window opens in 5 minutes. Get ready to place your indent!";
      break;

    case "window.closing":
      pushTitle = "Window Closing Soon ⚠️";
      pushBody = "Only 15 minutes left! Place your indent now before the window closes.";
      break;

    case "payment.reminder":
      pushTitle = "Payment Reminder 💰";
      pushBody = "You have an outstanding balance. Please top up your wallet to continue ordering.";
      break;

    case "custom":
      // title and body already set from job data
      break;
  }

  const sent = await sendPushNotification({
    dealerId,
    zoneId,
    title: pushTitle,
    body: pushBody,
    data: { event, orderId: orderId || "" },
  });

  return { event, sent, dealerId: dealerId || zoneId || "all" };
}
