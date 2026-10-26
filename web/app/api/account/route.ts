import type { NextRequest } from "next/server";
import { isSameOrigin } from "@/lib/auth";
import { accountJson, authBackend, clearSession, json, sessionEmail } from "@/lib/auth-routes";
import { deleteSubscription, getSubscription, updateAccountSettings } from "@/lib/subscription-store";

/**
 * The signed-in reader's account: `GET` reads it, `POST` changes the email
 * settings, `DELETE` removes it. Follows change through `/api/account/watch`.
 * Every answer is `no-store`; a 401 means "signed out", and clears a session
 * whose account has been deleted elsewhere.
 */

export async function GET(req: NextRequest) {
  const auth = authBackend();
  if (!auth) return json({ error: "Accounts are not configured on this deployment." }, 503);
  const email = sessionEmail(req, auth.secret);
  if (!email) return clearSession(json({ error: "Signed out." }, 401), req);
  const sub = await getSubscription(auth.backend, auth.secret, email);
  if (!sub) return clearSession(json({ error: "Signed out." }, 401), req);
  return json({ account: accountJson(sub) });
}

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json({ error: "Cross-site request refused." }, 403);
  const auth = authBackend();
  if (!auth) return json({ error: "Accounts are not configured on this deployment." }, 503);
  const email = sessionEmail(req, auth.secret);
  if (!email) return json({ error: "Signed out." }, 401);

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const flag = (k: string) => (typeof body[k] === "boolean" ? (body[k] as boolean) : undefined);
  const sub = await updateAccountSettings(auth.backend, auth.secret, email, {
    emailAlerts: flag("emailAlerts"),
    clusters: flag("clusters"),
    weeklyDigest: flag("weeklyDigest"),
  });
  if (!sub) return clearSession(json({ error: "Signed out." }, 401), req);
  return json({ account: accountJson(sub) });
}

export async function DELETE(req: NextRequest) {
  if (!isSameOrigin(req)) return json({ error: "Cross-site request refused." }, 403);
  const auth = authBackend();
  if (!auth) return json({ error: "Accounts are not configured on this deployment." }, 503);
  const email = sessionEmail(req, auth.secret);
  if (!email) return json({ error: "Signed out." }, 401);
  await deleteSubscription(auth.backend, auth.secret, email);
  return clearSession(json({ status: "deleted" }), req);
}
