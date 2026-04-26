import jwt from "jsonwebtoken";
import bcrypt from "bcryptjs";
import { nanoid } from "nanoid";
import { env } from "./env.js";

// ── JWT (Dealer App) ──
// Short-lived access tokens (15 min), long-lived refresh tokens (30 days).

interface DealerTokenPayload {
  dealerId: string;
  phone: string;
  zoneId: string;
}

export function signDealerAccessToken(payload: DealerTokenPayload): string {
  return jwt.sign(payload, env.JWT_SECRET, { expiresIn: "15m" });
}

export function signDealerRefreshToken(payload: DealerTokenPayload & { family: string }): string {
  return jwt.sign(payload, env.JWT_REFRESH_SECRET, { expiresIn: "30d" });
}

export function verifyDealerAccessToken(token: string): DealerTokenPayload {
  return jwt.verify(token, env.JWT_SECRET) as DealerTokenPayload;
}

export function verifyDealerRefreshToken(
  token: string
): DealerTokenPayload & { family: string } {
  return jwt.verify(token, env.JWT_REFRESH_SECRET) as DealerTokenPayload & {
    family: string;
  };
}

// ── Password Hashing (Admin Users) ──
const SALT_ROUNDS = 12;

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, SALT_ROUNDS);
}

export async function comparePassword(
  password: string,
  hash: string
): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

// ── Session Tokens (Admin ERP) ──
// Server-side sessions. Token stored in httpOnly cookie.
// Revocable — Super Admin can kill sessions immediately.

export function generateSessionToken(): string {
  return nanoid(64);
}

// ── OTP Generation ──
export function generateOTP(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ── Invoice PDF Access Tokens ──
// Short-lived (10 min) JWT used in publicly-reachable PDF download URLs.
// We can't put a Bearer header on a Linking.openURL call, so the token
// goes in the query string. Verified by the public endpoint.

interface InvoicePdfTokenPayload {
  orderId: string;
  dealerId: string;
}

export function signInvoicePdfToken(payload: InvoicePdfTokenPayload): string {
  return jwt.sign({ ...payload, kind: "invoice-pdf" }, env.JWT_SECRET, {
    expiresIn: "10m",
  });
}

export function verifyInvoicePdfToken(token: string): InvoicePdfTokenPayload {
  const decoded = jwt.verify(token, env.JWT_SECRET) as InvoicePdfTokenPayload & {
    kind?: string;
  };
  if (decoded.kind !== "invoice-pdf") {
    throw new Error("Invalid token kind");
  }
  return { orderId: decoded.orderId, dealerId: decoded.dealerId };
}