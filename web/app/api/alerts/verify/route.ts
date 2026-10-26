import { NextResponse } from "next/server";
import { subscriptionBackend } from "@/lib/subscription-blob";
import { verifySubscriber } from "@/lib/subscription-store";
import { alertsSecret, verifySubscriptionToken } from "@/lib/subscription-token";
import { absoluteUrl } from "@/lib/site";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  const secret = alertsSecret();
  const backend = subscriptionBackend();

  if (!secret || !backend) {
    return NextResponse.redirect(absoluteUrl("/account?status=unavailable"), 303);
  }

  const payload = verifySubscriptionToken(token, "verify", secret);
  if (!payload) {
    return NextResponse.redirect(absoluteUrl("/account?status=invalid_token"), 303);
  }

  const sub = await verifySubscriber(backend, secret, payload.email);
  if (!sub) {
    return NextResponse.redirect(absoluteUrl("/account?status=not_found"), 303);
  }

  // Managing the subscription now means signing in; the dashboard offers it.
  return NextResponse.redirect(absoluteUrl("/account?status=verified"), 303);
}
