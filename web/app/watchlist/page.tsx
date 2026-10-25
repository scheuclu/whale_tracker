import type { Metadata } from "next";
import { pageMetadata } from "@/lib/seo";
import { PAGE_STACK, PageHeader } from "../page-header";
import { resendConfigured } from "@/lib/email-digest";
import { subscriptionBackend, subscriptionsConfigured } from "@/lib/subscription-blob";
import { getSubscription } from "@/lib/subscription-store";
import { alertsSecret, verifySubscriptionToken } from "@/lib/subscription-token";
import { WatchlistManager, type ManagedSubscriptionProps } from "./watchlist-manager";

export const dynamic = "force-dynamic";

export const metadata: Metadata = pageMetadata({
  title: "Watchlist & Alert Subscriptions",
  description:
    "Manage your personal watchlist of members of Congress and stock tickers, and configure daily email digest alerts for STOCK Act and SEC Form 4 filings.",
  path: "/watchlist",
  noindex: true,
});

const STATUS_MESSAGES: Record<string, string> = {
  verified: "Your email address is confirmed. Daily digest alerts are now active for your subscription.",
  unsubscribed: "You have been unsubscribed from all email alerts.",
  invalid_token: "That confirmation or preferences link is invalid or has expired.",
  not_found: "No active subscription was found for that link.",
  unavailable: "Email subscription storage is not configured on this environment.",
};

export default async function WatchlistPage({
  searchParams,
}: {
  searchParams: Promise<{ token?: string; status?: string }>;
}) {
  const params = await searchParams;
  const emailEnabled = subscriptionsConfigured() && resendConfigured();
  let initialSub: ManagedSubscriptionProps | null = null;
  let validToken: string | undefined;

  if (params.token) {
    const secret = alertsSecret();
    const backend = subscriptionBackend();
    if (secret && backend) {
      const payload = verifySubscriptionToken(params.token, "manage", secret);
      if (payload) {
        const stored = await getSubscription(backend, secret, payload.email);
        if (stored) {
          validToken = params.token;
          initialSub = {
            email: stored.email,
            verified: stored.verified,
            members: stored.members,
            tickers: stored.tickers,
            clusters: stored.clusters,
            weeklyDigest: stored.weeklyDigest,
          };
        }
      }
    }
  }

  const statusNotice = params.status ? STATUS_MESSAGES[params.status] ?? null : null;

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        eyebrow="Personal Tracking"
        title="Watchlist & Alerts"
        subtitle="Follow specific members of Congress and stock tickers on this device, share a filtered feed link, or subscribe to a combined daily email digest."
      />
      <WatchlistManager
        token={validToken}
        initialSub={initialSub}
        statusCode={params.status ?? null}
        statusNotice={statusNotice}
        emailEnabled={emailEnabled}
      />
    </div>
  );
}
