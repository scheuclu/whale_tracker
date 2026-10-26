import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DB_TTL_SECONDS,
  MAX_STALENESS_SECONDS,
  PAGE_CDN_CACHE_CONTROL,
  PAGE_CDN_SECONDS,
  PAGE_SOURCE,
  PAGE_SWR_SECONDS,
} from "./cache-policy.ts";

test("caching pages cannot make the dashboard staler than the old 120 s database TTL", () => {
  assert.equal(MAX_STALENESS_SECONDS, 120);
  assert.ok(DB_TTL_SECONDS + PAGE_CDN_SECONDS + PAGE_SWR_SECONDS <= MAX_STALENESS_SECONDS);
  assert.ok(DB_TTL_SECONDS > 0 && PAGE_CDN_SECONDS > 0 && PAGE_SWR_SECONDS >= 0);
});

test("the CDN header states exactly those lifetimes", () => {
  assert.equal(
    PAGE_CDN_CACHE_CONTROL,
    `public, s-maxage=${PAGE_CDN_SECONDS}, stale-while-revalidate=${PAGE_SWR_SECONDS}`
  );
  assert.doesNotMatch(PAGE_CDN_CACHE_CONTROL, /immutable|max-age=\d{4,}/);
});

const matches = (path: string) => new RegExp(`^${PAGE_SOURCE}$`).test(path);

test("every page gets the CDN header", () => {
  for (const p of [
    "/",
    "/politicians",
    "/tickers",
    "/insiders",
    "/trends",
    "/alerts",
    "/pipeline",
    "/scans",
    "/scans/123",
    "/search",
    "/members/nancy-pelosi",
    "/tickers/MSFT",
    "/tickers/BRK.B",
    "/methodology",
    "/iconic", // only the exact metadata-image names are excluded
  ]) {
    assert.ok(matches(p), p);
  }
});

test("the signed-in dashboard is never held on the CDN", () => {
  for (const p of ["/account", "/account/"]) assert.ok(!matches(p), p);
  // Only that page: a ticker or member that merely starts with the word is still cached.
  assert.ok(matches("/accounts"));
});

test("API routes, Next assets, files and metadata images keep their own policy", () => {
  for (const p of [
    "/api/export.csv",
    "/api/scan-page/56/1",
    "/api/v1/trades",
    "/_next/static/chunks/a.js",
    "/_next/image",
    "/icon.svg",
    "/apple-icon",
    "/opengraph-image",
    "/twitter-image",
    "/opengraph-image-1a2b3c",
    "/members/nancy-pelosi/opengraph-image",
    "/robots.txt",
    "/sitemap.xml",
    "/llms.txt",
    "/favicon.ico",
    "/members/nancy-pelosi.md",
  ]) {
    assert.ok(!matches(p), p);
  }
});
