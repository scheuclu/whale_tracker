import { NextResponse } from "next/server";
import {
  renderVerificationEmail,
  resendConfigured,
  sendResendEmail,
  subscriptionActionUrls,
} from "@/lib/email-digest";
import { subscriptionBackend, subscriptionsConfigured } from "@/lib/subscription-blob";
import { upsertSubscription } from "@/lib/subscription-store";
import { alertsSecret, normalizeEmail } from "@/lib/subscription-token";

export async function POST(req: Request) {
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const email = normalizeEmail(body.email);
  if (!email) {
    return NextResponse.json({ error: "Please enter a valid email address." }, { status: 400 });
  }

  const members = Array.isArray(body.members)
    ? body.members.filter((x): x is string => typeof x === "string")
    : [];
  const tickers = Array.isArray(body.tickers)
    ? body.tickers.filter((x): x is string => typeof x === "string")
    : [];
  const clusters = Boolean(body.clusters);
  const weeklyDigest = Boolean(body.weeklyDigest);

  if (members.length === 0 && tickers.length === 0 && !clusters && !weeklyDigest) {
    return NextResponse.json(
      { error: "Select at least one member, ticker, cluster alert, or weekly digest to subscribe." },
      { status: 400 }
    );
  }

  const secret = alertsSecret();
  const backend = subscriptionBackend();
  if (!secret || !backend || !subscriptionsConfigured() || !resendConfigured()) {
    return NextResponse.json(
      {
        error:
          "Email alert dispatch is not yet configured on this deployment (missing Private Vercel Blob or Resend credentials). Your watchlist is still saved locally on this device.",
        code: "email_unconfigured",
      },
      { status: 503 }
    );
  }

  const sub = await upsertSubscription(backend, secret, {
    email,
    members,
    tickers,
    clusters,
    weeklyDigest,
    merge: true,
  });

  if (sub.verified) {
    return NextResponse.json({
      status: "updated",
      verified: true,
      message: "Added to your verified daily email alert subscription.",
    });
  }

  const urls = subscriptionActionUrls(sub.email, secret);
  const mail = renderVerificationEmail(sub, urls);
  const sent = await sendResendEmail({
    to: sub.email,
    subject: mail.subject,
    html: mail.html,
    text: mail.text,
    unsubscribeUrl: urls.unsubscribeUrl,
  });

  if (!sent.ok) {
    return NextResponse.json(
      { error: "Could not send verification email right now. Please try again shortly." },
      { status: 502 }
    );
  }

  return NextResponse.json({
    status: "verification_sent",
    verified: false,
    message: "Check your inbox for a confirmation link to activate daily alerts.",
  });
}
