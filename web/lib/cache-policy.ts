/**
 * How long anything the dashboard serves may lag the committed database.
 *
 * The data changes only when the scheduled pipeline commits
 * `data/trades.sqlite3` (every 90 minutes at best, a ~5 h median in practice),
 * so pages are cached on Vercel's CDN rather than rendered per request. Two
 * layers can hold an old copy, and their sum is the staleness bound:
 *
 *   DB_TTL_SECONDS       a function instance re-checks the database this
 *                        often (a conditional GET: an unchanged file is a 304
 *                        and costs no download — lib/db.ts);
 *   PAGE_CDN_SECONDS +   the CDN serves a rendered page this long, then up to
 *   PAGE_SWR_SECONDS     the SWR window more while one request re-renders it.
 *
 * Their sum must stay within MAX_STALENESS_SECONDS, which is the 120 s the
 * database TTL alone allowed before the CDN layer existed — caching pages may
 * not make the dashboard any staler than it already was.
 *
 * The CDN keys each entry on the full URL, query string included, plus
 * Next's `Vary` request headers (RSC payload vs HTML, prefetch, router
 * state), so `/tickers?t=MSFT` and `/tickers?t=NVDA` are separate entries and
 * an RSC payload is never served for a document request.
 */
export const DB_TTL_SECONDS = 30;
export const PAGE_CDN_SECONDS = 60;
export const PAGE_SWR_SECONDS = 30;
export const MAX_STALENESS_SECONDS = 120;

/**
 * `CDN-Cache-Control` for every rendered page. A targeted header (RFC 9213):
 * Vercel's CDN honours it over the `Cache-Control: private, no-store` Next
 * sends for a dynamic route, while browsers ignore it and keep revalidating,
 * so a reader's own cache never holds a page past the bound either.
 */
export const PAGE_CDN_CACHE_CONTROL = `public, s-maxage=${PAGE_CDN_SECONDS}, stale-while-revalidate=${PAGE_SWR_SECONDS}`;

/**
 * Which request paths get it: every page, and not
 *
 * - `/api/…` — each route handler states its own policy (the CSV export is
 *   `no-store`, a scan image is cached for a week);
 * - `/_next/…` — hashed assets and the image optimizer, which Next caches;
 * - files and metadata images (`/icon.svg`, `/opengraph-image`, `…/robots.txt`)
 *   — prerendered, and already cached far longer than a page.
 *
 * Only real file extensions are excluded, so a dotted ticker (`/tickers/BRK.B`)
 * is still a page. A path-to-regexp source for `next.config.ts` `headers()`;
 * the whole string is also a plain regex, which is how the tests check it.
 */
export const PAGE_SOURCE =
  "/((?!api/|_next/)(?!(?:.*/)?(?:opengraph-image|twitter-image|apple-icon|icon)(?:[-./]|$))(?!.*\\.(?:svg|png|jpe?g|gif|webp|ico|txt|xml|json|md|webmanifest|csv)$).*)";
