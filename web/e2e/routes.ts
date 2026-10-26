/**
 * Every page the smoke suite visits. Adding a route is one line here: each
 * entry is loaded in a browser (200, no console or page errors, one <h1>,
 * a <title>, a meta description) and its canonical checked.
 *
 * `canonical` is the path the page must name as its canonical — its own path
 * by default; a sorted/filtered variant names its base page. `null` means
 * the page must have none (the 404). Pages that exist only in a newer branch
 * do not belong here until that branch has merged.
 */
export type PageCase = {
  path: string;
  /** Expected canonical path; defaults to `path`, `null` asserts there is none. */
  canonical?: string | null;
  /** Expected HTTP status; 200 by default. */
  status?: number;
  /** The page carries `noindex` (search, scan pages, the 404). */
  noindex?: boolean;
};

export const PAGES: PageCase[] = [
  { path: "/" },
  { path: "/feed" },
  { path: "/feed?action=buy", canonical: "/feed" },
  { path: "/politicians" },
  { path: "/rankings" },
  { path: "/rankings?h=30", canonical: "/rankings" },
  { path: "/rankings?view=active" },
  { path: "/rankings?view=late" },
  { path: "/rankings?view=trends" },
  { path: "/rankings?view=trends&w=24", canonical: "/rankings?view=trends" },
  { path: "/politicians?sort=trades&dir=asc", canonical: "/politicians" },
  { path: "/members/nancy-pelosi-p000197" },
  { path: "/tickers" },
  { path: "/tickers?sort=trades", canonical: "/tickers" },
  { path: "/tickers/MSFT" },
  { path: "/tickers/BRK.B" },
  { path: "/insiders" },
  { path: "/insiders?t=BBD" },
  { path: "/alerts" },
  { path: "/pipeline" },
  { path: "/scans" },
  { path: "/scans/9116378", noindex: true },
  { path: "/search?q=pelosi", canonical: "/search", noindex: true },
  { path: "/account", noindex: true },
  { path: "/signin", noindex: true },
  { path: "/methodology" },
  { path: "/this-page-does-not-exist", status: 404, canonical: null, noindex: true },
];

/**
 * Query-string entity URLs from before /members/<slug> and /tickers/<SYM>:
 * a permanent (308) redirect to the canonical path.
 */
export const LEGACY_REDIRECTS: { from: string; to: string }[] = [
  { from: "/politicians?m=Nancy%20Pelosi", to: "/members/nancy-pelosi-p000197" },
  { from: "/tickers?t=NVDA", to: "/tickers/NVDA" },
];

/** Plain-text and JSON documents served for agents and API clients. */
export const DOCUMENTS: { path: string; type: RegExp }[] = [
  { path: "/robots.txt", type: /^text\/plain/ },
  { path: "/sitemap.xml", type: /xml/ },
  { path: "/llms.txt", type: /^text\/plain/ },
  { path: "/llms-full.txt", type: /^text\/plain/ },
  { path: "/openapi.json", type: /json/ },
  { path: "/api/v1", type: /json/ },
  { path: "/api/v1/track-record", type: /json/ },
];

/**
 * The origin canonicals and the sitemap must be built on: the build's
 * `NEXT_PUBLIC_SITE_URL`, which the tests are run against.
 */
export function siteOrigin(baseURL: string | undefined): string {
  return (process.env.NEXT_PUBLIC_SITE_URL ?? baseURL ?? "").replace(/\/+$/, "");
}
