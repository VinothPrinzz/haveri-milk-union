import admin from "firebase-admin";
import { sql } from "./db.js";

let initialized = false;

function initFirebase() {
  if (initialized) return;

  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n");
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!projectId || !privateKey || !clientEmail) {
    console.warn("[FCM] Firebase credentials not set — push notifications disabled");
    return;
  }

  admin.initializeApp({
    credential: admin.credential.cert({ projectId, privateKey, clientEmail }),
  });
  initialized = true;
  console.log("[FCM] Firebase initialized");
}

export interface PushPayload {
  dealerId?: string;
  zoneId?: string;
  title: string;
  body: string;
  data?: Record<string, string>;
}

export async function sendPushNotification(payload: PushPayload): Promise<number> {
  initFirebase();
  if (!initialized) {
    console.log("[FCM] Skipped (not configured):", payload.title);
    return 0;
  }

  // Get FCM tokens for target dealers
  let tokens: string[] = [];

  if (payload.dealerId) {
    // Single dealer
    const rows = await sql`
      SELECT fcm_token FROM dealers WHERE id = ${payload.dealerId} AND fcm_token IS NOT NULL
    `;
    tokens = rows.map((r: any) => r.fcm_token);
  } else if (payload.zoneId) {
    // All dealers in a zone
    const rows = await sql`
      SELECT fcm_token FROM dealers WHERE zone_id = ${payload.zoneId} AND fcm_token IS NOT NULL AND active = true
    `;
    tokens = rows.map((r: any) => r.fcm_token);
  } else {
    // All active dealers
    const rows = await sql`
      SELECT fcm_token FROM dealers WHERE fcm_token IS NOT NULL AND active = true AND deleted_at IS NULL
    `;
    tokens = rows.map((r: any) => r.fcm_token);
  }

  if (tokens.length === 0) {
    console.log("[FCM] No tokens found for:", payload.title);
    return 0;
  }

  const message: admin.messaging.MulticastMessage = {
    tokens,
    notification: { title: payload.title, body: payload.body },
    data: payload.data ?? {},
    android: { priority: "high", notification: { channelId: "hmu_orders" } },
  };

  try {
    const response = await admin.messaging().sendEachForMulticast(message);
    console.log(`[FCM] Sent ${response.successCount}/${tokens.length}: ${payload.title}`);

    // Log to notifications_log
    await sql`
      INSERT INTO notifications_log (target, title, message, delivery_status, sent_at)
      VALUES (${payload.dealerId || payload.zoneId || 'all'}, ${payload.title}, ${payload.body}, 'delivered', now())
    `;

    return response.successCount;
  } catch (err) {
    console.error("[FCM] Send failed:", err);
    return 0;
  }
}
