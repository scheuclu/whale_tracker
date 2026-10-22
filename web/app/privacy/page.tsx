import { pageMetadata } from "@/lib/seo";
import { PRIVACY_UPDATED } from "@/lib/legal";
import { Code, LegalPage, TextLink, type LegalSection } from "../legal";

/**
 * What the site actually collects. Every statement here is checked against
 * the code: `@vercel/analytics` in app/layout.tsx, next-themes' `theme` key,
 * the portrait loader in next.config.ts, the contact form's stored fields,
 * the CSP in lib/security-headers.ts (which is what makes "no third-party
 * scripts" true). Change this page in the same PR as any change to those.
 */

export const metadata = pageMetadata({
  title: "Privacy",
  description:
    "What FatCat Watch collects: cookieless page-view counts, hosting logs, and what you send through the contact form. No reader accounts, no ad trackers, no third-party scripts.",
  path: "/privacy",
});

const SECTIONS: LegalSection[] = [
  {
    id: "reading",
    title: "When you read the site",
    body: (
      <>
        <p>
          <strong>Page-view counts.</strong> We use Vercel Web Analytics to see which pages are read. It sets no
          cookies and stores nothing in your browser. For each page view it records the page address, the
          referring site, approximate location derived from your IP address (country, region, city), browser,
          operating system, device type and the time. To count a visit once rather than on every click, Vercel
          tells visitors apart with a hash computed from the request, which it discards after 24 hours; we only
          ever see totals. It is not used to identify you or to follow you to other sites. The script is served
          from this domain, and a content blocker that stops it changes nothing about how the site works.
        </p>
        <p>
          <strong>Hosting logs.</strong> The site runs on Vercel. Like any web server, it handles your IP
          address, the address you requested, your browser&apos;s user-agent string and the time, in order to
          deliver the page and to keep the service secure. Vercel keeps these request logs for a limited time
          (between one hour and 30 days, depending on the hosting plan); we look at them only to fix errors and
          stop abuse.
        </p>
        <p>
          <strong>Your theme.</strong> If you switch between light and dark mode, the choice is saved in your own
          browser&apos;s local storage under the key <Code>theme</Code>. It never leaves your device.
        </p>
      </>
    ),
  },
  {
    id: "not-collected",
    title: "What we do not do",
    body: (
      <ul>
        <li>No accounts, sign-ups or newsletters for readers, and no cookies set for readers.</li>
        <li>
          No advertising, no ad networks, no social-media pixels, no fingerprinting, and no third-party scripts:
          the site&apos;s Content Security Policy allows scripts from this domain only.
        </li>
        <li>
          Fonts are bundled with the site, so reading it makes no request to Google Fonts or any other font
          service.
        </li>
        <li>
          Members&apos; official portraits come from the public{" "}
          <TextLink href="https://github.com/unitedstates/images">unitedstates/images</TextLink> project. Our
          server fetches and resizes them and serves them from this domain, so your browser never contacts
          GitHub.
        </li>
        <li>
          Share links are ordinary links. Nothing is sent to a social network unless you follow one and post
          from there.
        </li>
        <li>We do not sell, rent or trade personal data, and we do not use it for marketing.</li>
      </ul>
    ),
  },
  {
    id: "api",
    title: "The public API and data files",
    body: (
      <p>
        The <TextLink href="/methodology#machines">read-only API</TextLink>, <Code>llms.txt</Code> and the CSV
        exports need no key or account. Requests to them appear in the hosting logs like any page request and
        are not tracked any further.
      </p>
    ),
  },
  {
    id: "contact",
    title: "When you contact us",
    body: (
      <>
        <p>If you write to us through the contact form, we store:</p>
        <ul>
          <li>your name, if you give one (it is optional);</li>
          <li>your email address, so we can reply;</li>
          <li>the topic you chose and your message;</li>
          <li>
            a one-way hash of your IP address, used only to limit how many messages can be sent from one place
            in a short time. Your IP address itself is not stored;
          </li>
          <li>when the message arrived and when we dealt with it.</li>
        </ul>
        <p>
          Messages are kept in private storage that is not publicly accessible, and are read only by the person
          who runs this site, who signs in to a private admin page to do so. Readers never sign in, and no
          sign-in script loads on public pages. We use your message to answer it and, if it reports an error in
          the data, to fix it. We do not add you to any list.
        </p>
        <p>
          We keep a message for as long as we need it to deal with your request and keep a record of any
          correction it led to, and no longer than 12 months after it is handled. You can ask us to delete it
          sooner at any time.
        </p>
      </>
    ),
  },
  {
    id: "people-in-the-data",
    title: "The people in the data",
    body: (
      <>
        <p>
          The site republishes public financial disclosures: periodic transaction reports that members of
          Congress file under the STOCK Act, and Form 4 reports that corporate insiders file with the SEC. These
          name public officials and company insiders and are published by the House Clerk, the Senate and the
          SEC so that the public can read them. We reproduce them as filed, for that same purpose.
        </p>
        <p>
          If you think a row misreads its filing, please tell us through the{" "}
          <TextLink href="/contact">contact form</TextLink>. We correct our own reading errors; we do not change
          what was filed. See the <TextLink href="/terms#as-filed">terms</TextLink> for how corrections work.
        </p>
      </>
    ),
  },
  {
    id: "providers",
    title: "Who processes data for us",
    body: (
      <ul>
        <li>
          <strong>Vercel Inc.</strong> hosts the site, runs the page-view analytics, keeps the hosting logs and
          stores contact-form messages in private storage. Vercel is a US company, and data it handles may be
          processed in the United States; see{" "}
          <TextLink href="https://vercel.com/legal/privacy-policy">Vercel&apos;s privacy policy</TextLink>.
        </li>
        <li>
          <strong>Sign in with Vercel</strong> (also Vercel Inc.) confirms who is signing in to the admin page. It
          receives nothing about readers or about anyone who writes to us.
        </li>
        <li>
          <strong>GitHub</strong> hosts the code and the disclosure database. No reader or contact data is
          stored there.
        </li>
      </ul>
    ),
  },
  {
    id: "your-rights",
    title: "Your choices and rights",
    body: (
      <>
        <p>
          You can ask to see, correct or delete anything you have sent us, or object to how we use it, through
          the <TextLink href="/contact">contact form</TextLink>. Use the email address you wrote from, so we can
          match the request to your message. We answer within 30 days.
        </p>
        <p>
          Page-view counts are aggregated and cannot be traced back to you, so there is nothing in them to look
          up or delete. If you are in the EU, the UK or another place with data-protection law, you also have the
          right to complain to your local data-protection authority.
        </p>
      </>
    ),
  },
  {
    id: "changes",
    title: "Changes to this policy",
    body: (
      <p>
        When what the site collects changes, this page changes with it and the date at the top moves. A change
        that uses data you already sent us in a new way will not apply to that data without your agreement.
      </p>
    ),
  },
];

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy"
      subtitle="What this site collects about you, why, and for how long. Short, because it is not much."
      updated={PRIVACY_UPDATED}
      summary={
        <>
          Readers need no account and get no cookies. We count page views with a cookieless analytics tool and
          see only totals; the host keeps short-lived request logs; and if you use the{" "}
          <TextLink href="/contact">contact form</TextLink>, we keep what you send so we can answer it, then
          delete it. There are no ad trackers or third-party scripts.
        </>
      }
      sections={SECTIONS}
    />
  );
}
