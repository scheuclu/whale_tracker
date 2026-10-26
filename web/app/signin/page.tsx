import type { Metadata } from "next";
import { googleCredentials, safeNextPath } from "@/lib/auth";
import { resendConfigured } from "@/lib/email-digest";
import { pageMetadata } from "@/lib/seo";
import { subscriptionsConfigured } from "@/lib/subscription-blob";
import { SignInPanel } from "../account-client";
import { PAGE_STACK, PageHeader } from "../page-header";

export const metadata: Metadata = pageMetadata({
  title: "Sign in",
  description:
    "Sign in to FatCat Watch with Google or an emailed link to keep your watchlist on every device and get a daily email digest of what you follow.",
  path: "/signin",
  noindex: true,
});

/**
 * Same for every visitor (the account is read in the browser, see
 * `lib/auth.ts`), so it is safe under the CDN page cache. `next` and `error`
 * only steer the form.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; error?: string }>;
}) {
  const params = await searchParams;
  const accounts = subscriptionsConfigured();
  return (
    <div className={PAGE_STACK}>
      <PageHeader
        eyebrow="Account"
        title="Sign in"
        subtitle="Keep your watchlist on every device and get it by email."
      />
      <div className="max-w-[440px]">
        <SignInPanel
          next={safeNextPath(params.next)}
          error={typeof params.error === "string" ? params.error : null}
          googleEnabled={accounts && googleCredentials() !== null}
          emailEnabled={accounts && resendConfigured()}
        />
      </div>
    </div>
  );
}
