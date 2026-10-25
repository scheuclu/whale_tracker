import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import {
  hasDigestMatches,
  matchSubscriberDigest,
  renderDigestEmail,
  resendConfigured,
  sendResendEmail,
  subscriptionActionUrls,
} from "@/lib/email-digest";
import { subscriptionBackend, subscriptionsConfigured } from "@/lib/subscription-blob";
import { listVerifiedSubscriptions, markDigestSent } from "@/lib/subscription-store";
import { alertsSecret } from "@/lib/subscription-token";

function checkBearer(req: Request): boolean {
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ")) return false;
  const token = header.slice("Bearer ".length).trim();
  const expected = process.env.CRON_SECRET?.trim() || alertsSecret();
  if (!token || !expected) return false;
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Daily email digest dispatcher (`/api/alerts/dispatch`).
 *
 * Protected by `Authorization: Bearer <CRON_SECRET | ALERTS_SECRET>`.
 * Sends at most 1 combined daily digest email per verified subscriber when
 * new filings or cluster alerts arrived after their `lastSentDate`.
 */
async function runDispatch(req: Request) {
  if (!checkBearer(req)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const secret = alertsSecret();
  const backend = subscriptionBackend();
  if (!secret || !backend || !subscriptionsConfigured() || !resendConfigured()) {
    return NextResponse.json(
      { status: "skipped", reason: "Blob or Resend not configured" },
      { status: 200 }
    );
  }

  const todayIso = new Date().toISOString().slice(0, 10);
  const yesterdayIso = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  const subscribers = await listVerifiedSubscriptions(backend);

  let sentCount = 0;
  let skippedNoMatch = 0;
  let skippedAlreadySent = 0;
  let failedCount = 0;

  for (const sub of subscribers) {
    if (sub.lastSentDate && sub.lastSentDate >= todayIso) {
      skippedAlreadySent++;
      continue;
    }
    const sinceDate = sub.lastSentDate ?? yesterdayIso;
    const matches = await matchSubscriberDigest(sub, sinceDate);
    if (!hasDigestMatches(matches)) {
      skippedNoMatch++;
      continue;
    }

    const urls = subscriptionActionUrls(sub.email, secret);
    const mail = renderDigestEmail(matches, urls);
    const res = await sendResendEmail({
      to: sub.email,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      unsubscribeUrl: urls.unsubscribeUrl,
    });

    if (res.ok) {
      await markDigestSent(backend, secret, sub.email, todayIso);
      sentCount++;
    } else {
      failedCount++;
    }
  }

  return NextResponse.json({
    status: "ok",
    date: todayIso,
    subscribers: subscribers.length,
    sent: sentCount,
    skippedNoMatch,
    skippedAlreadySent,
    failed: failedCount,
  });
}

export async function GET(req: Request) {
  return runDispatch(req);
}

export async function POST(req: Request) {
  return runDispatch(req);
}
