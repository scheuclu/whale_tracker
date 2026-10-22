import Link from "next/link";

import { contactConfigured } from "@/lib/contact-blob";
import { pageMetadata } from "@/lib/seo";
import { Card } from "../charts";
import { PAGE_STACK, PageHeader } from "../page-header";
import { ContactForm } from "./contact-form";

// Per request: whether the form is offered depends on the deployment's
// environment, and `?topic=correction` preselects a topic (a "report an
// error" link can use it). Never CDN-cached (lib/cache-policy.ts).
export const dynamic = "force-dynamic";

// Works without JavaScript: the form is a plain server-action POST, and the
// site-wide <noscript> stylesheet (app/no-script.tsx) reveals the streamed
// page when scripting is off.

export const metadata = pageMetadata({
  title: "Contact",
  description:
    "Report a row that does not match its filing, ask a press question, or send feedback about FatCat Watch.",
  path: "/contact",
});

export default async function ContactPage({ searchParams }: { searchParams: Promise<{ topic?: string | string[] }> }) {
  const params = await searchParams;
  const topic = typeof params.topic === "string" ? params.topic : "";
  const available = contactConfigured();

  return (
    <div className={PAGE_STACK}>
      <PageHeader
        eyebrow="Contact"
        title="Get in touch"
        subtitle={
          <>
            Spotted a trade that does not match its filing? Every row here is reproduced as filed, so a mismatch is
            something we want to fix. Press questions and feedback are welcome too. For how figures are computed, see
            the{" "}
            <Link href="/methodology" className="underline decoration-border-strong underline-offset-2 hover:text-primary">
              methodology
            </Link>
            .
          </>
        }
      />
      <Card className="max-w-3xl">
        {available ? (
          <ContactForm topic={topic} />
        ) : (
          <div role="status" className="space-y-1.5 text-sm">
            <p className="font-semibold text-foreground">The contact form is temporarily unavailable.</p>
            <p className="text-muted-foreground">Messages cannot be received right now. Please try again later.</p>
          </div>
        )}
      </Card>
    </div>
  );
}
