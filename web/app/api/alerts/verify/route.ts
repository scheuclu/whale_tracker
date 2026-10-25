import { NextResponse } from "next/server";
import { subscriptionBackend } from "@/lib/subscription-blob";
import { verifySubscriber } from "@/lib/subscription-store";
import {
  alertsSecret,
  signSubscriptionToken,
  verifySubscriptionToken,
} from "@/lib/subscription-token";
import { absoluteUrl } from "@/lib/site";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const token = searchParams.get("token");
  const secret = alertsSecret();
  const backend = subscriptionBackend();

  if (!secret || !backend) {
    return NextResponse.redirect(absoluteUrl("/watchlist?status=unavailable"), 303);
  }

  const payload = verifySubscriptionToken(token, "verify", secret);
  if (!payload) {
    return NextResponse.redirect(absoluteUrl("/watchlist?status=invalid_token"), 303);
  }

  const sub = await verifySubscriber(backend, secret, payload.email);
  if (!sub) {
    return NextResponse.redirect(absoluteUrl("/watchlist?status=not_found"), 303);
  }

  const manageToken = signSubscriptionToken({ purpose: "manage", email: sub.email }, secret);
  return NextResponse.redirect(
    absoluteUrl(`/watchlist?token=${encodeURIComponent(manageToken)}&status=verified`),
    303
  );
}
