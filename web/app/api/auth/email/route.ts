import { isSameOrigin, safeNextPath, signLoginToken } from "@/lib/auth";
import { authBackend, json } from "@/lib/auth-routes";
import { renderSignInEmail, resendConfigured, sendResendEmail } from "@/lib/email-digest";
import { normalizeEmail } from "@/lib/subscription-token";

/**
 * `POST /api/auth/email` `{ email, next? }` — emails a one-time sign-in link.
 *
 * Answers the same whether or not the address has an account, so the form
 * cannot be used to learn who reads the site. No record is written until the
 * link is opened: an address someone else typed in gets one email and nothing
 * stored.
 */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json({ error: "Cross-site request refused." }, 403);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const email = normalizeEmail(body.email);
  if (!email) return json({ error: "Please enter a valid email address." }, 400);

  const auth = authBackend();
  if (!auth || !resendConfigured()) {
    return json({ error: "Email sign-in is not configured on this deployment.", code: "unavailable" }, 503);
  }

  // The link opens on the origin the reader asked from, so a preview or a
  // local run signs in there rather than on production.
  const url = new URL("/api/auth/email/callback", req.url);
  url.searchParams.set("token", signLoginToken(email, auth.secret));
  const next = safeNextPath(body.next);
  if (next !== "/account") url.searchParams.set("next", next);

  const mail = renderSignInEmail(url.toString());
  const sent = await sendResendEmail({ to: email, subject: mail.subject, html: mail.html, text: mail.text });
  if (!sent.ok) return json({ error: "Could not send the sign-in email right now. Please try again shortly." }, 502);

  return json({ status: "sent" });
}
