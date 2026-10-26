import { NextResponse } from "next/server";
import {
  cookieOptions,
  googleAuthorizeUrl,
  googleCredentials,
  googleRedirectUri,
  newOAuthState,
  NO_STORE,
  OAUTH_COOKIE,
  OAUTH_TTL_SECONDS,
  safeNextPath,
  sealOAuthState,
} from "@/lib/auth";
import { authBackend, isSecure, signInError } from "@/lib/auth-routes";

/**
 * `GET /api/auth/google?next=…` — starts Google sign-in. The state and PKCE
 * verifier ride in a signed, HttpOnly cookie for ten minutes; the callback
 * refuses a reply that does not match them.
 */
export async function GET(req: Request) {
  const next = safeNextPath(new URL(req.url).searchParams.get("next"));
  const google = googleCredentials();
  const auth = authBackend();
  if (!google || !auth) return signInError(req, "google_unavailable", next);

  const state = newOAuthState(next);
  const origin = new URL(req.url).origin;
  const res = NextResponse.redirect(
    googleAuthorizeUrl({
      clientId: google.clientId,
      redirectUri: googleRedirectUri(origin),
      state: state.state,
      verifier: state.verifier,
    }),
    { status: 303, headers: NO_STORE }
  );
  res.cookies.set(OAUTH_COOKIE, sealOAuthState(state, auth.secret), {
    ...cookieOptions(isSecure(req), OAUTH_TTL_SECONDS),
    path: "/api/auth/google",
  });
  return res;
}
