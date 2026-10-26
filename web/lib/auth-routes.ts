import { NextResponse, type NextRequest } from "next/server";
import {
  cookieOptions,
  NO_STORE,
  readSession,
  SESSION_COOKIE,
  signSession,
  SIGNED_IN_HINT_COOKIE,
  withSignedInFlag,
  type SignInMethod,
} from "./auth";
import { subscriptionBackend } from "./subscription-blob";
import { signInAccount, type StoredSubscription, type SubscriptionBlobBackend } from "./subscription-store";
import { alertsSecret, SESSION_TTL_SECONDS } from "./subscription-token";

/** Response helpers shared by the `/api/auth/*` and `/api/account/*` route handlers. */

export function isSecure(req: Request): boolean {
  return new URL(req.url).protocol === "https:";
}

/** Sign-in needs the store (the account lives there) and the signing secret. */
export function authBackend(): { secret: string; backend: SubscriptionBlobBackend } | null {
  const secret = alertsSecret();
  const backend = subscriptionBackend();
  return secret && backend ? { secret, backend } : null;
}

/** Back to the sign-in page with a reason the page knows how to word. */
export function signInError(req: Request, code: string, next?: string): NextResponse {
  const url = new URL("/signin", req.url);
  url.searchParams.set("error", code);
  if (next && next !== "/watchlist") url.searchParams.set("next", next);
  return NextResponse.redirect(url, { status: 303, headers: NO_STORE });
}

/** Creates or verifies the account, sets the session, and sends the reader on. */
export async function completeSignIn(
  req: Request,
  email: string,
  method: SignInMethod,
  next: string
): Promise<NextResponse> {
  const auth = authBackend();
  if (!auth) return signInError(req, "unavailable", next);
  try {
    await signInAccount(auth.backend, auth.secret, email);
  } catch {
    return signInError(req, "failed", next);
  }
  const res = NextResponse.redirect(new URL(withSignedInFlag(next, method), req.url), {
    status: 303,
    headers: NO_STORE,
  });
  const secure = isSecure(req);
  res.cookies.set(SESSION_COOKIE, signSession(email, auth.secret), cookieOptions(secure, SESSION_TTL_SECONDS));
  res.cookies.set(SIGNED_IN_HINT_COOKIE, "1", cookieOptions(secure, SESSION_TTL_SECONDS, false));
  return res;
}

/** The signed-in reader's email, or null. */
export function sessionEmail(req: NextRequest, secret: string): string | null {
  return readSession(req.cookies.get(SESSION_COOKIE)?.value, secret)?.email ?? null;
}

export function clearSession(res: NextResponse, req: Request): NextResponse {
  const secure = isSecure(req);
  res.cookies.set(SESSION_COOKIE, "", cookieOptions(secure, 0));
  res.cookies.set(SIGNED_IN_HINT_COOKIE, "", cookieOptions(secure, 0, false));
  return res;
}

export function json(body: unknown, status = 200): NextResponse {
  return NextResponse.json(body, { status, headers: NO_STORE });
}

/** The account as the browser sees it (`lib/account.ts` mirrors this type). */
export function accountJson(s: StoredSubscription) {
  return {
    email: s.email,
    members: s.members,
    tickers: s.tickers,
    clusters: s.clusters,
    weeklyDigest: s.weeklyDigest,
    emailAlerts: s.emailAlerts,
  };
}
