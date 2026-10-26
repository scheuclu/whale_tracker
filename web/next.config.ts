import path from "node:path";
import type { NextConfig } from "next";
import { PAGE_CDN_CACHE_CONTROL, PAGE_SOURCE } from "./lib/cache-policy";
import { SECURITY_SOURCE, securityHeaders } from "./lib/security-headers";
import { FILTER_KEYS } from "./lib/feed-filters";

const FEED_REDIRECT_KEYS = [...FILTER_KEYS.filter((k) => k !== "member"), "offset"];

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
  // The share cards read their fonts from assets/fonts at render time
  // (app/share-card.tsx); a path built from process.cwd() is not traced, so
  // the files are named for every card route here.
  outputFileTracingIncludes: {
    "/**/opengraph-image*": ["./assets/fonts/*.ttf"],
    "/**/twitter-image*": ["./assets/fonts/*.ttf"],
  },
  // No `X-Powered-By: Next.js`: it tells a scanner which advisories to try.
  poweredByHeader: false,
  // Pin the workspace root: without it Turbopack walks up past the repo and
  // picks up an unrelated package-lock.json from the home directory.
  turbopack: { root: path.join(__dirname) },
  // Member portraits (app/avatar.tsx): official public-domain photos, served
  // through the optimizer so a 24px avatar is a ~2 KB WebP rather than the
  // 56 KB source JPEG. Locked to the one path they live under. The source
  // sends max-age=600; a portrait changes once a Congress at most, so the
  // optimized copy is kept for 31 days to hold transformations near one per
  // member and width.
  images: {
    remotePatterns: [
      new URL("https://unitedstates.github.io/images/congress/**"),
      new URL("https://financialmodelingprep.com/image-stock/**"),
    ],
    minimumCacheTTL: 2678400,
    qualities: [75],
  },
  // The query-string entity URLs from before /members/<slug> and
  // /tickers/<SYMBOL>, answered with a 308 by app/api/legacy-redirect
  // (see the note there for why a page cannot do it). Matched on the query
  // key, so `/politicians` and `/tickers` themselves are untouched; the
  // original query string travels with the rewrite.
  // The watchlist page became the signed-in dashboard; old links (email
  // footers, bookmarks) keep working, query string included.
  // `/` became the landing page and the feed moved to `/feed`: a filtered or
  // paged feed link from before (bookmarks, digest emails, shared watchlists)
  // carries its query string over. `?member=` is not here — it still goes to
  // the member's own page through the legacy rewrite below.
  async redirects() {
    return [
      { source: "/watchlist", destination: "/account", permanent: true },
      // The track record, the late view and the trends moved into /rankings;
      // the query string (`h`, `w`, `t`, `view`) travels with them.
      { source: "/politicians", has: [{ type: "query" as const, key: "view", value: "track" }], destination: "/rankings", permanent: true },
      { source: "/politicians", has: [{ type: "query" as const, key: "view", value: "late" }], destination: "/rankings", permanent: true },
      { source: "/trends", destination: "/rankings?view=trends", permanent: true },
      ...FEED_REDIRECT_KEYS.map((key) => ({
        source: "/",
        has: [{ type: "query" as const, key }],
        destination: "/feed",
        permanent: true,
      })),
    ];
  },
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/politicians", has: [{ type: "query", key: "m" }], destination: "/api/legacy-redirect/member" },
        { source: "/", has: [{ type: "query", key: "member" }], destination: "/api/legacy-redirect/feed-member" },
        { source: "/tickers", has: [{ type: "query", key: "t" }], destination: "/api/legacy-redirect/ticker" },
        { source: "/insiders", has: [{ type: "query", key: "t" }], destination: "/api/legacy-redirect/issuer" },
        { source: "/insiders", has: [{ type: "query", key: "cik" }], destination: "/api/legacy-redirect/insider" },
      ],
      afterFiles: [],
      fallback: [],
    };
  },
  // Every page renders per request (they read searchParams), so Next sends
  // `Cache-Control: private, no-store`; this targeted header lets Vercel's
  // CDN hold each URL for a minute anyway. The lifetimes, and the staleness
  // bound they add up to: lib/cache-policy.ts.
  //
  // Security headers (CSP, HSTS, framing, sniffing, referrer, permissions) go
  // on every path, pages and API alike; why the CSP is shaped the way it is,
  // and how to add an origin to it: lib/security-headers.ts. VERCEL_ENV is
  // read at build time, so only a preview build allows the Vercel Toolbar.
  async headers() {
    return [
      { source: PAGE_SOURCE, headers: [{ key: "CDN-Cache-Control", value: PAGE_CDN_CACHE_CONTROL }] },
      {
        source: SECURITY_SOURCE,
        headers: securityHeaders({
          dev: process.env.NODE_ENV === "development",
          preview: process.env.VERCEL_ENV === "preview",
        }),
      },
    ];
  },
};

export default nextConfig;
