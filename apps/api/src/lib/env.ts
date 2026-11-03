import 'dotenv/config';
import { config } from "dotenv";
config();

import { z } from "zod";

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_POOLED: z.string().optional(),

  // JWT (Dealer App)
  JWT_SECRET: z.string().min(32),
  JWT_REFRESH_SECRET: z.string().min(32),

  // Session (Admin ERP)
  SESSION_SECRET: z.string().min(32),

  // API
  PORT: z.coerce.number().optional(),       // Railway injects this
  API_PORT: z.coerce.number().default(3001),
  API_HOST: z.string().default("0.0.0.0"),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),

  // Cloudflare R2 (optional in dev)
  R2_ACCOUNT_ID: z.string().optional(),
  R2_ACCESS_KEY_ID: z.string().optional(),
  R2_SECRET_ACCESS_KEY: z.string().optional(),
  R2_BUCKET_NAME: z.string().default("hmu-files"),
  R2_PUBLIC_URL: z.string().optional(),

  // Firebase (optional in dev)
  FIREBASE_PROJECT_ID: z.string().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),
  FIREBASE_CLIENT_EMAIL: z.string().optional(),

  // SMS gateway (dealer OTP) — see lib/sms.ts for the URL template format.
  // Defaults to "console" (log only) outside production.
  SMS_PROVIDER: z.enum(["console", "http"]).optional(),
  SMS_API_URL: z.string().optional(),
  SMS_API_METHOD: z.enum(["GET", "POST"]).default("GET"),
  SMS_API_BODY: z.string().optional(),
  SMS_SUCCESS_PATTERN: z.string().optional(),
  // Must match the DLT-approved template text exactly; {otp} is substituted.
  SMS_OTP_MESSAGE: z
    .string()
    .default(
      "Your Havemul OTP for password change is {otp}. Valid for 5 minutes. Do not share it with anyone. - Haveri Milk Union"
    ),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
