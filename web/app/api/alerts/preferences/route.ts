import { NextResponse } from "next/server";
import { subscriptionBackend } from "@/lib/subscription-blob";
import { unsubscribeAll, upsertSubscription } from "@/lib/subscription-store";
import { alertsSecret, verifySubscriptionToken } from "@/lib/subscription-token";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const secret = alertsSecret();
  const backend = subscriptionBackend();
  if (!secret || !backend) {
    return NextResponse.json({ error: "Subscription store unavailable." }, { status: 503 });
  }

  const token = typeof body.token === "string" ? body.token : null;
  const payload = verifySubscriptionToken(token, "manage", secret);
  if (!payload) {
    return NextResponse.json({ error: "Invalid or expired preferences token." }, { status: 401 });
  }

  if (body.unsubscribeAll === true) {
    await unsubscribeAll(backend, secret, payload.email);
    return NextResponse.json({ status: "unsubscribed" });
  }

  const members = Array.isArray(body.members)
    ? body.members.filter((x): x is string => typeof x === "string")
    : [];
  const tickers = Array.isArray(body.tickers)
    ? body.tickers.filter((x): x is string => typeof x === "string")
    : [];
  const insiders = Array.isArray(body.insiders)
    ? body.insiders.filter((x): x is string => typeof x === "string")
    : [];
  const clusters = Boolean(body.clusters);
  const weeklyDigest = Boolean(body.weeklyDigest);

  const updated = await upsertSubscription(backend, secret, {
    email: payload.email,
    members,
    tickers,
    insiders,
    clusters,
    weeklyDigest,
    merge: false,
  });

  return NextResponse.json({
    status: "saved",
    subscription: {
      email: updated.email,
      verified: updated.verified,
      members: updated.members,
      tickers: updated.tickers,
      insiders: updated.insiders ?? [],
      clusters: updated.clusters,
      weeklyDigest: updated.weeklyDigest,
    },
  });
}
