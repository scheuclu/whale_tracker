import path from "node:path";
import type { NextConfig } from "next";
import { PAGE_CDN_CACHE_CONTROL, PAGE_SOURCE } from "./lib/cache-policy";

const nextConfig: NextConfig = {
  serverExternalPackages: ["better-sqlite3"],
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
  async headers() {
    return [{ source: PAGE_SOURCE, headers: [{ key: "CDN-Cache-Control", value: PAGE_CDN_CACHE_CONTROL }] }];
  },
};

export default nextConfig;
