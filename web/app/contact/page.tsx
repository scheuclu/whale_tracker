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

/**
 * The page without JavaScript. Every route renders inside the root
 * loading.tsx Suspense boundary, and React 19.2 outlines a completed
 * boundary once the shell before it passes ~12.8 KB (the site header alone
 * does): the content is sent as a `<div hidden id="S:0">` at the end of
 * <body> and swapped in by an inline script. With scripting off that script
 * never runs, so the reader sees the skeleton. This style — parsed only when
 * scripting is off, because it sits in <noscript> — hides the skeleton,
 * unhides the outlined content and moves it above the footer, so the form
 * (a plain POST to a server action) works with JavaScript disabled. Scoped
 * to this page; with JavaScript on it does nothing.
 */
const NO_SCRIPT_CSS = `
body{display:flex;flex-direction:column}
body>footer{order:3}
main.page-flow:has(>[aria-busy="true"]){display:none}
body>div[hidden][id^="S:"]{order:2;width:100%;max-width:72rem;margin-inline:auto;padding:1.75rem 1rem 5rem}
@media (min-width:640px){body>div[hidden][id^="S:"]{padding:2.5rem 1.5rem 6rem}}
@layer theme{body>div[hidden][id^="S:"]{display:block!important}}
`;
// The unhiding rule sits in Tailwind's first layer on purpose: preflight's
// `[hidden]{display:none!important}` is in `base`, and for !important rules an
// earlier cascade layer wins (and any layer beats unlayered CSS).

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
      <noscript>
        <style>{NO_SCRIPT_CSS}</style>
      </noscript>
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
