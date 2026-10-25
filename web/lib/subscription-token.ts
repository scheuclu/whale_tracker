import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Stateless HMAC-SHA256 tokens and subscriber keys for email alert subscriptions.
 *
 * Three token purposes:
 * - `verify`: sent in double-opt-in emails, expires in 48 hours.
 * - `manage`: sent in every email footer to open `/watchlist?token=...` without a password.
 * - `unsubscribe`: used in RFC 8058 `List-Unsubscribe` headers and footer links.
 */

export type TokenPurpose = "verify" | "manage" | "unsubscribe";

export interface SubscriptionTokenPayload {
  v: 1;
  purpose: TokenPurpose;
  email: string;
  /** Unix timestamp (seconds) when the token expires; omitted for non-expiring unsubscribe/manage links. */
  exp?: number;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const VERIFY_TTL_SECONDS = 48 * 3600;

export function normalizeEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 254 || !EMAIL_RE.test(trimmed)) return null;
  return trimmed;
}

export function alertsSecret(env: Record<string, string | undefined> = process.env): string | null {
  const s = env.ALERTS_SECRET?.trim() || env.AUTH_SECRET?.trim() || env.CONTACT_IP_SALT?.trim();
  return s && s.length >= 16 ? s : null;
}

/** 32-hex keyed hash of the normalized email address, used as the private blob key. */
export function emailSubscriberKey(email: string, secret: string): string {
  const norm = normalizeEmail(email);
  if (!norm) throw new Error("Invalid email");
  if (!secret || secret.length < 16) throw new Error("Secret too short");
  return createHmac("sha256", secret).update(`subscriber:v1:${norm}`).digest("hex").slice(0, 32);
}

function signRaw(payloadB64: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(`token:v1:${payloadB64}`).digest();
}

export function signSubscriptionToken(
  payload: { purpose: TokenPurpose; email: string; exp?: number },
  secret: string
): string {
  const norm = normalizeEmail(payload.email);
  if (!norm) throw new Error("Invalid email");
  if (!secret || secret.length < 16) throw new Error("Secret too short");
  const full: SubscriptionTokenPayload = {
    v: 1,
    purpose: payload.purpose,
    email: norm,
    ...(payload.exp != null ? { exp: payload.exp } : {}),
  };
  const payloadB64 = Buffer.from(JSON.stringify(full), "utf8").toString("base64url");
  const sigB64 = signRaw(payloadB64, secret).toString("base64url");
  return `${payloadB64}.${sigB64}`;
}

export function verifySubscriptionToken(
  token: string | null | undefined,
  expectedPurpose: TokenPurpose | TokenPurpose[],
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): SubscriptionTokenPayload | null {
  if (!token || typeof token !== "string" || !secret || secret.length < 16) return null;
  const parts = token.trim().split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;
  if (!payloadB64 || !sigB64) return null;

  let actualSig: Buffer;
  try {
    actualSig = Buffer.from(sigB64, "base64url");
  } catch {
    return null;
  }
  const expectedSig = signRaw(payloadB64, secret);
  if (actualSig.length !== expectedSig.length || !timingSafeEqual(actualSig, expectedSig)) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const p = parsed as Record<string, unknown>;
  if (p.v !== 1) return null;
  const allowed = Array.isArray(expectedPurpose) ? expectedPurpose : [expectedPurpose];
  if (typeof p.purpose !== "string" || !allowed.includes(p.purpose as TokenPurpose)) return null;
  const email = normalizeEmail(p.email);
  if (!email) return null;
  if (p.exp !== undefined) {
    if (typeof p.exp !== "number" || !Number.isFinite(p.exp) || nowSeconds > p.exp) {
      return null;
    }
  }
  return {
    v: 1,
    purpose: p.purpose as TokenPurpose,
    email,
    ...(typeof p.exp === "number" ? { exp: p.exp } : {}),
  };
}
