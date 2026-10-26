import type { NextRequest } from "next/server";
import {
  cookieOptions,
  exchangeGoogleCode,
  googleCredentials,
  googleRedirectUri,
  OAUTH_COOKIE,
  openOAuthState,
  stateMatches,
} from "@/lib/auth";
import { authBackend, completeSignIn, isSecure, signInError } from "@/lib/auth-routes";

/** `GET /api/auth/google/callback?code=…&state=…` — Google's redirect back. */
export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const google = googleCredentials();
  const auth = authBackend();
  if (!google || !auth) return signInError(req, "google_unavailable");

  const sealed = openOAuthState(req.cookies.get(OAUTH_COOKIE)?.value, auth.secret);
  const next = sealed?.next;
  const res = await (async () => {
    // The reader pressed Cancel on Google's screen.
    if (searchParams.get("error")) return signInError(req, "cancelled", next);
    if (!sealed || !stateMatches(searchParams.get("state"), sealed.state)) {
      return signInError(req, "expired", next);
    }
    const code = searchParams.get("code");
    if (!code) return signInError(req, "failed", next);

    const email = await exchangeGoogleCode({
      code,
      verifier: sealed.verifier,
      redirectUri: googleRedirectUri(new URL(req.url).origin),
      clientId: google.clientId,
      clientSecret: google.clientSecret,
    }).catch(() => null);
    if (!email) return signInError(req, "failed", sealed.next);

    return completeSignIn(req, email, "google", sealed.next);
  })();

  res.cookies.set(OAUTH_COOKIE, "", { ...cookieOptions(isSecure(req), 0), path: "/api/auth/google" });
  return res;
}
