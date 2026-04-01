import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID;
const R2_ACCESS_KEY_ID = process.env.R2_ACCESS_KEY_ID;
const R2_SECRET_ACCESS_KEY = process.env.R2_SECRET_ACCESS_KEY;
const R2_BUCKET_NAME = process.env.R2_BUCKET_NAME || "hmu-files";

let client: S3Client | null = null;

function getClient(): S3Client | null {
  if (client) return client;
  if (!R2_ACCOUNT_ID || !R2_ACCESS_KEY_ID || !R2_SECRET_ACCESS_KEY) {
    console.warn("[R2] Cloudflare R2 credentials not set — PDF upload disabled");
    return null;
  }

  client = new S3Client({
    region: "auto",
    endpoint: `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: R2_ACCESS_KEY_ID,
      secretAccessKey: R2_SECRET_ACCESS_KEY,
    },
  });
  console.log("[R2] Client initialized");
  return client;
}

export async function uploadPDF(key: string, pdfBytes: Uint8Array): Promise<string | null> {
  const s3 = getClient();
  if (!s3) {
    console.log("[R2] Skipped upload (not configured):", key);
    return null;
  }

  await s3.send(
    new PutObjectCommand({
      Bucket: R2_BUCKET_NAME,
      Key: key,
      Body: pdfBytes,
      ContentType: "application/pdf",
    })
  );

  const publicUrl = process.env.R2_PUBLIC_URL;
  if (publicUrl) return `${publicUrl}/${key}`;

  // Generate a signed URL valid for 7 days
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: R2_BUCKET_NAME, Key: key }),
    { expiresIn: 7 * 24 * 60 * 60 }
  );
  return url;
}
