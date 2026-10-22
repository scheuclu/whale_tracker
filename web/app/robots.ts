import type { MetadataRoute } from "next";
import { absoluteUrl } from "@/lib/site";

/**
 * Everyone may crawl everything a reader can see, AI crawlers included —
 * they are named so the intent is explicit rather than inferred from `*`.
 *
 * Disallowed: the CSV export (a download of rows the pages already show, at
 * up to 5,000 rows a request) and the scan-image route behind the noindexed
 * scan pages; /admin (also `noindex`) and the sign-in endpoints behind it.
 * Nothing else under /api/ — in particular not the
 * public /api/v1/, which is meant to be read by agents.
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

const DISALLOW = ["/api/export.csv", "/api/scan-page/", "/api/health", "/admin", "/api/auth/"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: ["/", "/api/v1/"], disallow: DISALLOW },
      { userAgent: AI_CRAWLERS, allow: ["/", "/api/v1/"], disallow: DISALLOW },
    ],
    sitemap: absoluteUrl("/sitemap.xml"),
  };
}
