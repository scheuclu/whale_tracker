import type { MetadataRoute } from "next";
import { getFilingSpan, getSitemapMembers, getSitemapTickers } from "@/lib/entities";
import { memberHref, tickerHref } from "@/lib/format";
import { absoluteUrl } from "@/lib/site";

/**
 * Every indexable page: home, the section pages, every member and every
 * ticker with a counted trade. `lastModified` is the newest filing date
 * behind the page — a real data date, never the time of the request.
 *
 * One file, not an index: the protocol allows 50,000 URLs per sitemap, and
 * the corpus is ~150 members and ~900 tickers (2026-10). Switch to
 * `generateSitemaps` if the ticker count ever nears 40,000.
 *
 * Search, filtered/sorted variants and the per-scan pages are left out on
 * purpose: they are `noindex` or canonicalise elsewhere.
 */
export const revalidate = 3600;

export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  let members: Awaited<ReturnType<typeof getSitemapMembers>> = [];
  let tickers: Awaited<ReturnType<typeof getSitemapTickers>> = [];
  let last: string | null = null;
  try {
    const [m, t, span] = await Promise.all([getSitemapMembers(), getSitemapTickers(), getFilingSpan()]);
    members = m;
    tickers = t;
    last = span.last;
  } catch {
    /* no database at build time: the static sections still list */
  }
  const lastModified = last ?? undefined;
  const section = (path: string, priority: number): MetadataRoute.Sitemap[number] => ({
    url: absoluteUrl(path),
    lastModified,
    changeFrequency: "daily",
    priority,
  });

  return [
    section("/", 1),
    section("/politicians", 0.9),
    section("/tickers", 0.9),
    section("/insiders", 0.8),
    section("/politicians?view=late", 0.7),
    section("/trends", 0.6),
    section("/methodology", 0.6),
    section("/alerts", 0.5),
    section("/pipeline", 0.4),
    section("/scans", 0.3),
    ...members.map((m) => ({
      url: absoluteUrl(memberHref(m.name, m.bioguide_id)),
      lastModified: m.last_filed ?? undefined,
      changeFrequency: "weekly" as const,
      priority: 0.8,
    })),
    ...tickers.map((t) => ({
      url: absoluteUrl(tickerHref(t.ticker)),
      lastModified: t.last_filed ?? undefined,
      changeFrequency: "weekly" as const,
      priority: 0.6,
    })),
  ];
}
