import { handlers } from "@/auth";
import { authConfigured } from "@/lib/admin-auth";

export const runtime = "nodejs";

/**
 * Auth.js endpoints (sign-in redirect, Google callback, session, sign-out).
 * Until sign-in is fully configured they do not exist: Auth.js would answer
 * a missing AUTH_SECRET with a server error, and a 404 says it better.
 */
const notConfigured = () => new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });

export async function GET(req: Request) {
  return authConfigured() ? handlers.GET(req as Parameters<typeof handlers.GET>[0]) : notConfigured();
}

export async function POST(req: Request) {
  return authConfigured() ? handlers.POST(req as Parameters<typeof handlers.POST>[0]) : notConfigured();
}
