import { isSameOrigin } from "@/lib/auth";
import { clearSession, json } from "@/lib/auth-routes";

/** `POST /api/auth/signout` — clears the session cookies on this browser. */
export async function POST(req: Request) {
  if (!isSameOrigin(req)) return json({ error: "Cross-site request refused." }, 403);
  return clearSession(json({ status: "signed_out" }), req);
}
