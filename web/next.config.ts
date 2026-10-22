import path from "node:path";
import type { NextConfig } from "next";
import { PAGE_CDN_CACHE_CONTROL, PAGE_SOURCE } from "./lib/cache-policy";
import { SECURITY_SOURCE, securityHeaders } from "./lib/security-headers";

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
    remotePatterns: [new URL("https://unitedstates.github.io/images/congress/**")],
    minimumCacheTTL: 2678400,
    qualities: [75],
  },
  // The query-string entity URLs from before /members/<slug> and
  // /tickers/<SYMBOL>, answered with a 308 by app/api/legacy-redirect
  // (see the note there for why a page cannot do it). Matched on the query
  // key, so `/politicians` and `/tickers` themselves are untouched; the
  // original query string travels with the rewrite.
  async rewrites() {
    return {
      beforeFiles: [
        { source: "/politicians", has: [{ type: "query", key: "m" }], destination: "/api/legacy-redirect/member" },
        { source: "/", has: [{ type: "query", key: "member" }], destination: "/api/legacy-redirect/feed-member" },
        { source: "/tickers", has: [{ type: "query", key: "t" }], destination: "/api/legacy-redirect/ticker" },
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
