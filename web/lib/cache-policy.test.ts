import assert from "node:assert/strict";
import { test } from "node:test";

import {
  DB_TTL_SECONDS,
  MAX_STALENESS_SECONDS,
  PAGE_CDN_CACHE_CONTROL,
  PAGE_CDN_SECONDS,
  PAGE_SOURCE,
  PAGE_SWR_SECONDS,
  PRIVATE_CACHE_CONTROL,
  PRIVATE_PAGES,
  PRIVATE_SOURCE,
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

test("admin and contact are never CDN-cached, and get the private header instead", () => {
  const priv = (path: string) => new RegExp(`^${PRIVATE_SOURCE}$`).test(path);
  for (const p of ["/admin", "/admin/", "/admin?status=handled", "/contact", "/contact?topic=press"]) {
    const path = p.split("?")[0];
    assert.ok(!matches(path), `${p} must not get the CDN header`);
    assert.ok(priv(path), `${p} must get the private header`);
  }
  for (const page of PRIVATE_PAGES) assert.ok(!matches(`/${page}`) && priv(`/${page}`), page);
  // Only those exact segments: a page merely starting with the word is still a page.
  for (const p of ["/administrators", "/contacts", "/tickers/ADMN"]) {
    assert.ok(matches(p), p);
    assert.ok(!priv(p), p);
  }
  assert.match(PRIVATE_CACHE_CONTROL, /no-store/);
  assert.doesNotMatch(PRIVATE_CACHE_CONTROL, /public|s-maxage/);
});
