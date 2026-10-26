import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  LOGIN_TTL_SECONDS,
  normalizeEmail,
  SESSION_TTL_SECONDS,
  signSubscriptionToken,
  verifySubscriptionToken,
} from "./subscription-token";

/**
 * Reader sign-in. Server-only.
 *
 * Two ways in, both ending in a proven email address: an emailed link
 * (`login` token, 15 minutes) or Google (OAuth 2.0 code flow with PKCE,
 * `openid email` only). The address keys the reader's record in the
 * subscription store (`lib/subscription-store.ts`), so the same address via
 * either method is the same account, and there is no password to keep.
 *
 * The session is a signed `session` token in an HttpOnly cookie. Nothing a
 * page renders on the server depends on it: pages are held on the CDN under
 * their URL (`lib/cache-policy.ts`), so a page that read the cookie would
 * serve one reader's account to the next. Account state is fetched by the
 * browser from `/api/account`, which is `no-store`. The readable
 * `fcw_signed_in` hint cookie only spares signed-out visitors that request.
 */

type Env = Record<string, string | undefined>;

export const SESSION_COOKIE = "fcw_session";
export const SIGNED_IN_HINT_COOKIE = "fcw_signed_in";
export const OAUTH_COOKIE = "fcw_oauth";
export const OAUTH_TTL_SECONDS = 10 * 60;

export type SignInMethod = "google" | "email";

/** No caching anywhere: every response that reads or sets the session. */
export const NO_STORE = { "Cache-Control": "private, no-store" } as const;

/**
 * Where to send the reader after signing in: a same-site path, or `/account`.
 * `//evil.example`, `/\evil.example` and anything with a scheme are refused —
 * an open redirect on the sign-in route would lend our domain to phishing.
 */
export function safeNextPath(raw: unknown): string {
  const fallback = "/account";
  if (typeof raw !== "string") return fallback;
  const s = raw.trim();
  if (!s.startsWith("/") || s.startsWith("//") || s.startsWith("/\\")) return fallback;
  if (s.length > 512 || /[\u0000-\u001f\\]/.test(s)) return fallback;
  if (s.startsWith("/api/")) return fallback;
  return s;
}

/** `next` with `signed_in=<method>` added, so the browser can count the sign-in. */
export function withSignedInFlag(next: string, method: SignInMethod): string {
  const url = new URL(next, "http://x");
  url.searchParams.set("signed_in", method);
  return `${url.pathname}${url.search}${url.hash}`;
}

export function signSession(email: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  return signSubscriptionToken({ purpose: "session", email, exp: nowSeconds + SESSION_TTL_SECONDS }, secret);
}

/** The signed-in email, or null for a missing, forged, expired or other-purpose token. */
export function readSession(
  cookieValue: string | null | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): { email: string } | null {
  const payload = verifySubscriptionToken(cookieValue, "session", secret, nowSeconds);
  return payload && payload.exp != null ? { email: payload.email } : null;
}

export function signLoginToken(email: string, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  return signSubscriptionToken({ purpose: "login", email, exp: nowSeconds + LOGIN_TTL_SECONDS }, secret);
}

export function readLoginToken(
  token: string | null | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string | null {
  const payload = verifySubscriptionToken(token, "login", secret, nowSeconds);
  return payload && payload.exp != null ? payload.email : null;
}

export function cookieOptions(secure: boolean, maxAge: number, httpOnly = true) {
  return { httpOnly, secure, sameSite: "lax" as const, path: "/", maxAge };
}

/**
 * Cross-site request guard for the state-changing account routes. The
 * cookie is SameSite=Lax, which already keeps it off a cross-site POST; this
 * refuses one outright, and refuses a request that names no origin at all.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (origin) return origin === new URL(req.url).origin;
  return req.headers.get("sec-fetch-site") === "same-origin";
}

// --- Google ----------------------------------------------------------------

const GOOGLE_AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";
const GOOGLE_ISSUERS = new Set(["https://accounts.google.com", "accounts.google.com"]);

export function googleCredentials(env: Env = process.env): { clientId: string; clientSecret: string } | null {
  const clientId = env.GOOGLE_CLIENT_ID?.trim();
  const clientSecret = env.GOOGLE_CLIENT_SECRET?.trim();
  return clientId && clientSecret ? { clientId, clientSecret } : null;
}

/** Must be listed verbatim under the OAuth client's authorized redirect URIs. */
export function googleRedirectUri(origin: string): string {
  return `${origin.replace(/\/+$/, "")}/api/auth/google/callback`;
}

export interface OAuthState {
  state: string;
  verifier: string;
  next: string;
}

export function newOAuthState(next: string): OAuthState {
  return {
    state: randomBytes(16).toString("base64url"),
    verifier: randomBytes(32).toString("base64url"),
    next: safeNextPath(next),
  };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function googleAuthorizeUrl(o: { clientId: string; redirectUri: string; state: string; verifier: string }): string {
  const url = new URL(GOOGLE_AUTHORIZE);
  url.searchParams.set("client_id", o.clientId);
  url.searchParams.set("redirect_uri", o.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid email");
  url.searchParams.set("state", o.state);
  url.searchParams.set("code_challenge", pkceChallenge(o.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

/** The OAuth round-trip state, signed so the callback can trust what it reads back. */
export function sealOAuthState(s: OAuthState, secret: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const body = Buffer.from(JSON.stringify({ ...s, exp: nowSeconds + OAUTH_TTL_SECONDS }), "utf8").toString("base64url");
  const sig = createHmac("sha256", secret).update(`oauth:v1:${body}`).digest("base64url");
  return `${body}.${sig}`;
}

export function openOAuthState(
  sealed: string | null | undefined,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): OAuthState | null {
  if (!sealed) return null;
  const [body, sig] = sealed.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(`oauth:v1:${body}`).digest();
  const actual = Buffer.from(sig, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as Record<string, unknown>;
    if (typeof p.exp !== "number" || nowSeconds > p.exp) return null;
    if (typeof p.state !== "string" || typeof p.verifier !== "string") return null;
    return { state: p.state, verifier: p.verifier, next: safeNextPath(p.next) };
  } catch {
    return null;
  }
}

/** Constant-time comparison of the `state` Google echoed with the one we sealed. */
export function stateMatches(a: string | null, b: string): boolean {
  if (!a) return false;
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function decodeJwtPayload(jwt: string): Record<string, unknown> | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const p = JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as unknown;
    return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * The verified email in a Google ID token, or null. The token comes straight
 * from Google's token endpoint over TLS in exchange for our client secret,
 * which OpenID Connect Core §3.1.3.7 accepts in place of checking the
 * signature; the claims are still checked: issuer, audience (our client, not
 * another app's), expiry, and that Google itself verified the address.
 */
export function googleEmailFromIdToken(
  idToken: string,
  clientId: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string | null {
  const c = decodeJwtPayload(idToken);
  if (!c) return null;
  if (typeof c.iss !== "string" || !GOOGLE_ISSUERS.has(c.iss)) return null;
  const aud = Array.isArray(c.aud) ? c.aud : [c.aud];
  if (!aud.includes(clientId)) return null;
  if (typeof c.exp !== "number" || nowSeconds > c.exp) return null;
  if (c.email_verified !== true && c.email_verified !== "true") return null;
  return normalizeEmail(c.email);
}

export async function exchangeGoogleCode(o: {
  code: string;
  verifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
  fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const res = await (o.fetchImpl ?? fetch)(GOOGLE_TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code: o.code,
      client_id: o.clientId,
      client_secret: o.clientSecret,
      redirect_uri: o.redirectUri,
      grant_type: "authorization_code",
      code_verifier: o.verifier,
    }),
  });
  if (!res.ok) return null;
  const body = (await res.json().catch(() => null)) as { id_token?: unknown } | null;
  return typeof body?.id_token === "string" ? googleEmailFromIdToken(body.id_token, o.clientId) : null;
}
