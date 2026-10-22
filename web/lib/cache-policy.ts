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
 * state), so `/tickers?w=30` and `/tickers?w=90` are separate entries and
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
 * Pages that must never be held by the CDN or shared between readers:
 * `/admin` (a signed-in view) and `/contact` (a server action posts to it,
 * and its response is one sender's result). They get `PRIVATE_CACHE_CONTROL`.
 */
export const PRIVATE_PAGES = ["admin", "contact"] as const;

/** path-to-regexp source for `next.config.ts` matching each private page and anything under it. */
export const PRIVATE_SOURCE = `/((?:${PRIVATE_PAGES.join("|")})(?:/.*)?)`;

/**
 * Sent on the private pages: no CDN copy (`CDN-Cache-Control` too, since
 * Vercel's CDN reads that one first) and no browser copy. Next already sends
 * `no-store` for a dynamic page; this states it where a later change to the
 * page rule cannot silently undo it.
 */
export const PRIVATE_CACHE_CONTROL = "private, no-store, max-age=0";

/**
 * Which request paths get it: every page, and not
 *
 * - `/admin`, `/contact` — `PRIVATE_PAGES`, never cached;
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
  "/((?!api/|_next/)(?!(?:admin|contact)(?:/|$))(?!(?:.*/)?(?:opengraph-image|twitter-image|apple-icon|icon)(?:[-./]|$))(?!.*\\.(?:svg|png|jpe?g|gif|webp|ico|txt|xml|json|md|webmanifest|csv)$).*)";

/**
 * Share cards (every `opengraph-image`). They read the database, so Next
 * renders them per request and sends `public, max-age=0, must-revalidate`:
 * until this header every unfurl re-rendered the PNG (production,
 * 2026-10-22: `x-vercel-cache: MISS` on every repeat request, ~0.9 s each).
 * A card is a count summary that the sites fetching it cache for days
 * anyway, so the CDN holds it an hour and serves a stale copy for a day
 * while one request re-renders it. This sits outside the 120 s page bound
 * above on purpose: a card a few hours behind the page misstates nothing,
 * it says "21 trades" where the page now says 22.
 *
 * Set by the card renderers on their own response (app/share-card.tsx),
 * not in `next.config.ts`, so the policy travels with the image. Browsers
 * get the same `CDN-Cache-Control`-ignoring treatment as pages.
 */
export const CARD_CDN_SECONDS = 3600;
export const CARD_SWR_SECONDS = 86400;
export const CARD_CDN_CACHE_CONTROL = `public, s-maxage=${CARD_CDN_SECONDS}, stale-while-revalidate=${CARD_SWR_SECONDS}`;
