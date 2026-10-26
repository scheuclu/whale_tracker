import type { NextRequest } from "next/server";
import { isSameOrigin } from "@/lib/auth";
import { accountJson, authBackend, clearSession, json, sessionEmail } from "@/lib/auth-routes";
import { updateAccountWatch } from "@/lib/subscription-store";

function ids(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 100) : [];
}

/**
 * `POST /api/account/watch` `{ add?: { members, tickers }, remove?: { … } }` —
 * follows and unfollows on the signed-in account, item by item, and returns
 * the account as stored.
 */
export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return json({ error: "Cross-site request refused." }, 403);
  const auth = authBackend();
  if (!auth) return json({ error: "Accounts are not configured on this deployment." }, 503);
  const email = sessionEmail(req, auth.secret);
  if (!email) return json({ error: "Signed out." }, 401);

  let body: Record<string, Record<string, unknown> | undefined>;
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  const sub = await updateAccountWatch(auth.backend, auth.secret, email, {
    add: { members: ids(body.add?.members), tickers: ids(body.add?.tickers) },
    remove: { members: ids(body.remove?.members), tickers: ids(body.remove?.tickers) },
  });
  if (!sub) return clearSession(json({ error: "Signed out." }, 401), req);
  return json({ account: accountJson(sub) });
}
