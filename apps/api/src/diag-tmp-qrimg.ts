import { pgClient } from "./lib/db.js";
const rows = await pgClient`
  SELECT razorpay_qr_code_id AS "qrId", notes->>'imageUrl' AS "imageUrl"
    FROM razorpay_payments
   WHERE kind='gate_pass' AND notes->>'imageUrl' IS NOT NULL
   ORDER BY created_at DESC LIMIT 3
`;
for (const r of rows as any[]) console.log(`${r.qrId}  ${r.imageUrl}`);
await pgClient.end();
