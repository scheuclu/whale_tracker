import type { MetadataRoute } from "next";
import { absoluteUrl } from "../lib/site";

/**
 * Everyone may crawl everything a reader can see, AI crawlers included —
 * they are named so the intent is explicit rather than inferred from `*`.
 *
 * Disallowed: the CSV export (a download of rows the pages already show, at
 * up to 5,000 rows a request) and the scan-image route behind the noindexed
 * scan pages. Nothing else under /api/ — in particular not the
 * public /api/v1/, which is meant to be read by agents.
 *
 * Also disallowed: the *views* of a list — every window, direction, insider
 * filter, sort and row count is a link, so their combinations are an
 * unbounded URL space that canonicalises to one page. GPTBot walked
 * `/insiders` views from 2026-10-18 at ~140k uncached renders a day. The
 * pages themselves stay open: `/insiders`, the old issuer URL (`/insiders?t=X`, a redirect),
 * `/tickers` and every member page. Rules are scoped to those paths, never
 * `/*`, because the longest match wins and `/api/v1/` takes `action`/`sort`.
 */
const AI_CRAWLERS = [
  "GPTBot",
  "OAI-SearchBot",
  "ChatGPT-User",
  "ClaudeBot",
  "Claude-User",
  "Claude-SearchBot",
  "anthropic-ai",
  "PerplexityBot",
  "Perplexity-User",
  "Google-Extended",
  "Applebot-Extended",
  "CCBot",
  "Bytespider",
  "Amazonbot",
  "meta-externalagent",
  "cohere-ai",
  "DuckAssistBot",
  "MistralAI-User",
];

/** Parameters of the `/insiders` list that select a view rather than a page (`t`, the issuer, is a page). */
const INSIDER_VIEW_PARAMS = ["w", "action", "cik", "sort", "dir", "n"];

export const DISALLOW = [
  "/api/export.csv",
  "/api/scan-page/",
  "/api/health",
  // The operator's account list: noindex and behind sign-in, kept out of crawls too.
  "/admin",
  ...INSIDER_VIEW_PARAMS.map((p) => `/insiders?${p}=`),
  // A second parameter is always a view: an issuer plus a window, or a filter plus a sort.
  "/insiders?*&",
  // Every /tickers parameter (w, sort, dir, n) is a view of the one list.
  "/tickers?",
  // A member page filtered to buys or sells.
  "/members/*?",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: ["/", "/api/v1/"], disallow: DISALLOW },
      { userAgent: AI_CRAWLERS, allow: ["/", "/api/v1/"], disallow: DISALLOW },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
