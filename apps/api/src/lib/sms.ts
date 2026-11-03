// ══════════════════════════════════════════════════════════════════
// SMS sending — gateway-agnostic.
//
// Indian SMS gateways (DoveSoft, Digimiles, MSG91, 2Factor, …) all boil
// down to one HTTP call carrying an API key, DLT sender ID, DLT template
// ID, the mobile number and the message. Rather than hard-code one vendor,
// the request URL is an env template with placeholders:
//
//   SMS_PROVIDER=http
//   SMS_API_URL=https://gateway.example/send?apikey=XXX&sender=HAVMUL&templateid=1207...&to={mobile_cc}&msg={message}
//
// Placeholders (values are URL-encoded):
//   {mobile}     10-digit number            e.g. 9876543210
//   {mobile_cc}  with 91 country code       e.g. 919876543210
//   {message}    full rendered SMS text
//   {otp}        the bare OTP (for gateways with a dedicated OTP param)
//
// Optional:
//   SMS_API_METHOD=GET|POST   (POST sends SMS_API_BODY, same placeholders, JSON-escaped)
//   SMS_API_BODY={"to":"{mobile_cc}","text":"{message}"}
//   SMS_SUCCESS_PATTERN=regex — many gateways reply HTTP 200 even on
//     failure; if set, the response body must match it to count as sent.
//
// SMS_PROVIDER=console (default outside production) just logs the SMS,
// so OTP flows can be tested without a gateway or DLT approval.
// ══════════════════════════════════════════════════════════════════

import { env } from "./env.js";

export class SmsNotConfiguredError extends Error {}
export class SmsSendError extends Error {}

const SMS_TIMEOUT_MS = 10_000;

/** Last 10 digits of an Indian mobile number, or null if it isn't one. */
export function normalizeIndianMobile(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  const ten = digits.length > 10 ? digits.slice(-10) : digits;
  return /^[6-9]\d{9}$/.test(ten) ? ten : null;
}

function provider(): "console" | "http" {
  if (env.SMS_PROVIDER) return env.SMS_PROVIDER;
  return env.NODE_ENV === "production" ? "http" : "console";
}

/** True when an OTP can actually reach a dealer's phone. */
export function isSmsConfigured(): boolean {
  return provider() === "console" || !!env.SMS_API_URL;
}

function fill(
  template: string,
  values: Record<string, string>,
  encode: (v: string) => string
): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    const value = values[key];
    return value === undefined ? match : encode(value);
  });
}

export async function sendSms(
  phone: string,
  message: string,
  extra: { otp?: string } = {}
): Promise<void> {
  const mobile = normalizeIndianMobile(phone);
  if (!mobile) throw new SmsSendError(`Invalid mobile number: ${phone}`);

  if (provider() === "console") {
    console.info(`[sms:console] to=${mobile} message="${message}"`);
    return;
  }

  if (!env.SMS_API_URL) {
    throw new SmsNotConfiguredError("SMS_API_URL is not set");
  }

  const values = {
    mobile,
    mobile_cc: `91${mobile}`,
    message,
    otp: extra.otp ?? "",
  };
  const url = fill(env.SMS_API_URL, values, encodeURIComponent);
  const method = env.SMS_API_METHOD;
  const body =
    method === "POST" && env.SMS_API_BODY
      ? fill(env.SMS_API_BODY, values, (v) => JSON.stringify(v).slice(1, -1))
      : undefined;

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      signal: AbortSignal.timeout(SMS_TIMEOUT_MS),
      ...(body ? { body, headers: { "Content-Type": "application/json" } } : {}),
    });
  } catch (err) {
    throw new SmsSendError(`SMS gateway unreachable: ${(err as Error).message}`);
  }

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    throw new SmsSendError(`SMS gateway HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  if (env.SMS_SUCCESS_PATTERN && !new RegExp(env.SMS_SUCCESS_PATTERN, "i").test(text)) {
    throw new SmsSendError(`SMS gateway rejected message: ${text.slice(0, 300)}`);
  }
}
