/**
 * schema.org JSON-LD for search engines and agents. Pure builders — the
 * `JsonLd` component (app/json-ld.tsx) serialises them.
 *
 * The same rules as every other surface apply: a congressional amount is a
 * disclosed range and is described as one; no builder states a bracket as a
 * figure. Counts carry no caveat, so that is mostly what appears here.
 */

import { portraitUrl, PARTY_LABEL } from "./members";
import { SITE_DESCRIPTION, SITE_NAME, absoluteUrl, chamberTitle } from "./site";

type Ld = Record<string, unknown>;

const CONTEXT = "https://schema.org";

/** The brand, referenced by @id from the other nodes. */
export function organizationLd(): Ld {
  return {
    "@context": CONTEXT,
    "@type": "Organization",
    "@id": absoluteUrl("/#organization"),
    name: SITE_NAME,
    url: absoluteUrl("/"),
    logo: absoluteUrl("/apple-icon"),
    description: SITE_DESCRIPTION,
  };
}

/** The site, with its search page as a SearchAction (`/search?q=`). */
export function websiteLd(): Ld {
  return {
    "@context": CONTEXT,
    "@type": "WebSite",
    "@id": absoluteUrl("/#website"),
    name: SITE_NAME,
    url: absoluteUrl("/"),
    description: SITE_DESCRIPTION,
    inLanguage: "en-US",
    publisher: { "@id": absoluteUrl("/#organization") },
    potentialAction: {
      "@type": "SearchAction",
      target: { "@type": "EntryPoint", urlTemplate: `${absoluteUrl("/search")}?q={search_term_string}` },
      "query-input": "required name=search_term_string",
    },
  };
}

/**
 * The disclosure data as a Dataset. `variableMeasured` says in so many words
 * that congressional amounts are brackets and insider values are computed,
 * because an agent reading only this node must not come away thinking a
 * member reported a dollar figure.
 */
export function datasetLd({
  firstFilingDate,
  lastFilingDate,
  transactions,
  members,
  insiderTrades,
}: {
  firstFilingDate: string | null;
  lastFilingDate: string | null;
  transactions: number;
  members: number;
  insiderTrades: number;
}): Ld {
  return {
    "@context": CONTEXT,
    "@type": "Dataset",
    "@id": absoluteUrl("/#dataset"),
    name: "US congressional and corporate-insider stock trades",
    description:
      `Periodic transaction reports (PTRs) filed under the STOCK Act by members of the US House and Senate` +
      `${firstFilingDate ? ` since ${firstFilingDate}` : ""} — ` +
      `${transactions.toLocaleString("en-US")} transactions by ${members.toLocaleString("en-US")} members — ` +
      `parsed into one row per trade, plus ${insiderTrades.toLocaleString("en-US")} open-market purchases and sales ` +
      `from SEC Form 4 filings by corporate insiders. Congressional amounts are the disclosure brackets as filed ` +
      `(for example "$1,001 - $15,000"), never a single figure; the open-ended top bracket has no upper bound. ` +
      `Rows transcribed from scanned paper filings are shown but excluded from every total.`,
    url: absoluteUrl("/"),
    keywords: [
      "STOCK Act",
      "congressional stock trades",
      "periodic transaction report",
      "SEC Form 4",
      "insider trading disclosures",
    ],
    creator: { "@id": absoluteUrl("/#organization") },
    publisher: { "@id": absoluteUrl("/#organization") },
    isAccessibleForFree: true,
    conditionsOfAccess:
      "Free to read. The source filings are public records published by the Clerk of the US House, the " +
      "Secretary of the US Senate (eFD) and the SEC (EDGAR); this compilation adds parsing and aggregation only.",
    isBasedOn: [
      "https://disclosures-clerk.house.gov/FinancialDisclosure",
      "https://efdsearch.senate.gov/search/",
      "https://www.sec.gov/edgar/search/",
    ],
    temporalCoverage:
      firstFilingDate && lastFilingDate ? `${firstFilingDate}/${lastFilingDate}` : undefined,
    spatialCoverage: { "@type": "Country", name: "United States" },
    variableMeasured: [
      {
        "@type": "PropertyValue",
        name: "amount range",
        description:
          "Congressional transaction amount as the disclosed bracket: a floor and a ceiling in US dollars. The STOCK Act " +
          "requires only the bracket; the top bracket is open-ended (≥ its floor). Any single figure derived from it is an estimate.",
        unitText: "USD",
      },
      {
        "@type": "PropertyValue",
        name: "insider trade value",
        description: "Form 4 value computed as shares × the reported price per share; may be a weighted-average price.",
        unitText: "USD",
      },
      { "@type": "PropertyValue", name: "transaction date" },
      { "@type": "PropertyValue", name: "filing date" },
      {
        "@type": "PropertyValue",
        name: "disclosure delay",
        description: "Days from the trade date to the filing date; the STOCK Act deadline is 45 days.",
        unitText: "days",
      },
      { "@type": "PropertyValue", name: "ticker" },
      { "@type": "PropertyValue", name: "transaction type", description: "purchase, sale, partial sale or exchange" },
    ],
    dateModified: lastFilingDate ?? undefined,
  };
}

/** A breadcrumb trail; every item but the last links. */
export function breadcrumbLd(items: { name: string; path: string }[]): Ld {
  return {
    "@context": CONTEXT,
    "@type": "BreadcrumbList",
    itemListElement: items.map((it, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: it.name,
      item: absoluteUrl(it.path),
    })),
  };
}

const PARTY_ORG: Record<string, string> = {
  D: "Democratic Party",
  R: "Republican Party",
  L: "Libertarian Party",
};

/**
 * A member of Congress. Only what the roster says: no affiliation for an
 * independent beyond the label, no title for a filer the roster could not
 * match, and the official public-domain portrait the page itself shows.
 */
export function personLd({
  name,
  bioguideId,
  chamber,
  party,
  state,
  path,
}: {
  name: string;
  bioguideId: string | null;
  chamber: string | null;
  party: string | null;
  state: string | null;
  path: string;
}): Ld {
  const job = chamberTitle(chamber);
  const body =
    chamber === "senate" ? "United States Senate" : chamber === "house" ? "United States House of Representatives" : null;
  const partyOrg = party ? PARTY_ORG[party] : undefined;
  return {
    "@context": CONTEXT,
    "@type": "Person",
    "@id": `${absoluteUrl(path)}#person`,
    name,
    url: absoluteUrl(path),
    jobTitle: job ? `${job}${state ? ` from ${state}` : ""}` : undefined,
    image: portraitUrl(bioguideId, "450x550") ?? undefined,
    affiliation: partyOrg
      ? { "@type": "PoliticalParty", name: partyOrg }
      : party && PARTY_LABEL[party]
        ? { "@type": "Organization", name: PARTY_LABEL[party] }
        : undefined,
    memberOf: body ? { "@type": "GovernmentOrganization", name: body } : undefined,
    identifier: bioguideId ? { "@type": "PropertyValue", propertyID: "bioguide", value: bioguideId } : undefined,
    sameAs: bioguideId ? [`https://bioguide.congress.gov/search/bio/${bioguideId}`] : undefined,
  };
}

/**
 * JSON for a `<script type="application/ld+json">`. `<` is escaped so a
 * name or description can never close the script element; JSON.stringify
 * drops the `undefined` fields the builders leave for absent facts.
 */
export function serializeLd(data: Ld | Ld[]): string {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}
