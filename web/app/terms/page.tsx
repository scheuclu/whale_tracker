import { pageMetadata } from "@/lib/seo";
import { TERMS_UPDATED } from "@/lib/legal";
import { LegalPage, TextLink, type LegalSection } from "../legal";

/**
 * The terms restate, for a reader, rules the methodology already sets
 * (lib/methodology.ts: "not-advice", "amounts-are-ranges", "dates-as-filed",
 * "transcribed-excluded", "disclosure-delay"). They may add to those rules,
 * never contradict them: change the methodology first, then this page.
 */

export const metadata = pageMetadata({
  title: "Terms of use",
  description:
    "FatCat Watch reproduces public STOCK Act and SEC Form 4 disclosures for information. Not investment advice; a disclosed trade is not evidence of wrongdoing; data is shown as filed and may contain errors.",
  path: "/terms",
});

const SECTIONS: LegalSection[] = [
  {
    id: "what-this-is",
    title: "What this site is",
    body: (
      <p>
        FatCat Watch reproduces public financial disclosures for information: periodic transaction reports filed
        by members of the US House and Senate under the STOCK Act, read from the House Clerk and the Senate eFD,
        and Form 4 reports filed by corporate insiders with the SEC. It is an independent project, not affiliated
        with Congress, the SEC or any member, company or political party. By using the site or its API you
        accept these terms.
      </p>
    ),
  },
  {
    id: "not-advice",
    title: "Not investment advice",
    body: (
      <>
        <p>
          <strong>
            Nothing on this site is investment, financial, legal or tax advice, or a recommendation to buy, sell
            or hold any security.
          </strong>{" "}
          Rankings, clusters, alerts and charts describe what was filed; they are not signals to act on. We are
          not your adviser and owe you no duty as one.
        </p>
        <p>
          Disclosures arrive late by design: members of Congress have up to 45 days to report a trade (and some
          report later still), insiders two business days. By the time a trade appears here the market has moved,
          and someone else&apos;s past trade says nothing reliable about future returns. Make your own decisions,
          with professional advice where you need it.
        </p>
      </>
    ),
  },
  {
    id: "not-wrongdoing",
    title: "A disclosed trade is not evidence of wrongdoing",
    body: (
      <p>
        Members of Congress and corporate insiders are allowed to trade, and filing these reports is how they
        comply with the law. A trade appearing here, its size, its timing, or several people trading the same
        stock, does not suggest that anyone acted improperly or had non-public information. A report filed after
        the deadline is marked late: that is a reporting fact, not an allegation. Please do not present anything
        from this site as more than that.
      </p>
    ),
  },
  {
    id: "as-filed",
    title: "Data is reproduced as filed and may contain errors",
    body: (
      <>
        <p>
          We show what the filings say, and the filings are not always precise or correct. Read the figures the
          way the <TextLink href="/methodology">methodology</TextLink> explains them:
        </p>
        <ul>
          <li>
            Congressional amounts are <strong>ranges</strong>, because members disclose a bracket, not a figure.
            Any single number derived from a bracket, such as a midpoint, is an estimate and is labelled as one.
          </li>
          <li>Insider values are shares × the price the filer reported, which may be a weighted average.</li>
          <li>
            Dates are shown as filed. A few filings carry mistyped dates; those rows are flagged, not corrected.
          </li>
          <li>
            Electronic filings are read automatically, and scanned paper filings are transcribed by machine. Rows
            transcribed from scans are labelled and kept out of every dollar total, and any reading can be wrong.
          </li>
          <li>
            Coverage has gaps (filings we could not read, recent weeks not yet reported); they are listed on the
            methodology and <TextLink href="/pipeline">pipeline</TextLink> pages.
          </li>
        </ul>
        <p>
          Every row links to its original filing. <strong>Check the filing before you rely on or publish a
          figure.</strong> If we have misread one, tell us through the{" "}
          <TextLink href="/contact">contact form</TextLink> with a link to the row: we correct our reading errors,
          but we do not change what was filed.
        </p>
      </>
    ),
  },
  {
    id: "using-the-data",
    title: "Using the data and the API",
    body: (
      <>
        <p>
          The filings are public records of the US government. You may quote, reuse and republish what this site
          shows, through the pages, the CSV exports or the{" "}
          <TextLink href="/methodology#machines">API</TextLink>. Please name FatCat Watch, link the original
          filing so readers can check it, and follow the{" "}
          <TextLink href="/methodology#rules">rules for quoting</TextLink>, so a range is not reported as a
          precise figure.
        </p>
        <p>
          The API is free and needs no key. Keep automated use reasonable: cache what you fetch, and do not send
          requests at a rate that slows the site for others. We may limit or block traffic that does, and we may
          change or retire endpoints.
        </p>
        <p>
          Do not try to break, overload or gain unauthorised access to the site. If you find a security problem,
          please report it through the <TextLink href="/contact">contact form</TextLink> (see also{" "}
          <TextLink href="/.well-known/security.txt">security.txt</TextLink>).
        </p>
      </>
    ),
  },
  {
    id: "no-warranty",
    title: "No warranty; limits on liability",
    body: (
      <p>
        The site, the data and the API are provided as they are, without warranty of any kind: we do not promise
        that they are accurate, complete, current or available. To the fullest extent the law allows, we are not
        liable for any loss or damage arising from using them or relying on them, including trading losses.
        Nothing in these terms limits any liability that cannot be limited by law.
      </p>
    ),
  },
  {
    id: "links",
    title: "Links to other sites",
    body: (
      <p>
        The site links to the official sources (the House Clerk, the Senate eFD, SEC EDGAR) and to other sites.
        We do not control them; their own terms and privacy policies apply when you visit them.
      </p>
    ),
  },
  {
    id: "changes",
    title: "Changes and contact",
    body: (
      <p>
        We may update these terms; the date at the top shows when they last changed, and using the site after a
        change means you accept the new version. Questions go through the{" "}
        <TextLink href="/contact">contact form</TextLink>. How we handle what you send is in the{" "}
        <TextLink href="/privacy">privacy policy</TextLink>.
      </p>
    ),
  },
];

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of use"
      subtitle="The conditions for using FatCat Watch, its data and its API."
      updated={TERMS_UPDATED}
      summary={
        <>
          This site shows public disclosures for information. It is <strong className="font-semibold text-ink-2">not
          investment advice</strong>, a disclosed trade is <strong className="font-semibold text-ink-2">not evidence
          of wrongdoing</strong>, and the data is reproduced as filed and may contain errors. Check the linked
          filing before relying on a figure, and send corrections through the{" "}
          <TextLink href="/contact">contact form</TextLink>.
        </>
      }
      sections={SECTIONS}
    />
  );
}
