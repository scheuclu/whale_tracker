import { NextResponse } from "next/server";
import { subscriptionBackend } from "@/lib/subscription-blob";
import { unsubscribeAll } from "@/lib/subscription-store";
import { alertsSecret, verifySubscriptionToken } from "@/lib/subscription-token";
import { absoluteUrl } from "@/lib/site";

async function handleUnsubscribe(req: Request): Promise<{ ok: boolean }> {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  const secret = alertsSecret();
  const backend = subscriptionBackend();

  if (!secret || !backend) return { ok: false };
  const payload = verifySubscriptionToken(token, ["unsubscribe", "manage"], secret);
  if (!payload) return { ok: false };

  await unsubscribeAll(backend, secret, payload.email);
  return { ok: true };
}

/** Browser click on the email footer unsubscribe link. */
export async function GET(req: Request) {
  const { ok } = await handleUnsubscribe(req);
  return NextResponse.redirect(
    absoluteUrl(`/watchlist?status=${ok ? "unsubscribed" : "invalid_token"}`),
    303
  );
}

/** RFC 8058 One-Click Unsubscribe POST (`List-Unsubscribe-Post: List-Unsubscribe=One-Click`). */
export async function POST(req: Request) {
  const { ok } = await handleUnsubscribe(req);
  if (!ok) {
    return NextResponse.json({ error: "Invalid or expired unsubscribe token" }, { status: 400 });
  }
  return NextResponse.json({ status: "unsubscribed" });
}
