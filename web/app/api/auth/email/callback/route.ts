import { readLoginToken, safeNextPath } from "@/lib/auth";
import { authBackend, completeSignIn, signInError } from "@/lib/auth-routes";

/**
 * `GET /api/auth/email/callback?token=…&next=…` — the link in the sign-in
 * email. The token is stateless and lives 15 minutes, so a mail scanner that
 * fetches the link first does not use it up for the reader.
 */
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const next = safeNextPath(searchParams.get("next"));
  const auth = authBackend();
  if (!auth) return signInError(req, "unavailable", next);

  const email = readLoginToken(searchParams.get("token"), auth.secret);
  if (!email) return signInError(req, "expired", next);

  return completeSignIn(req, email, "email", next);
}
