import assert from "node:assert/strict";
import { test } from "node:test";

import { CARD_CDN_CACHE_CONTROL, CARD_CDN_SECONDS, CARD_SWR_SECONDS, PAGE_SOURCE } from "./cache-policy.ts";
import { pageCard, pageMetadata } from "./seo.ts";
import { shareTargets } from "./share.ts";

const PAGE = "https://www.fatcatwatch.com/politicians?committee=HSIF&x=1";
const TEXT = "House Committee on Energy & Commerce: members' disclosed stock trades";

test("every share target is an https intent URL carrying the canonical URL, encoded once", () => {
  const targets = shareTargets(PAGE, TEXT);
  assert.deepEqual(
    targets.map((t) => t.network),
    ["x", "bluesky", "reddit", "linkedin"]
  );
  for (const t of targets) {
    const u = new URL(t.href);
    assert.equal(u.protocol, "https:", t.network);
    const carried = [...u.searchParams.values()].join(" ");
    assert.ok(carried.includes(PAGE), `${t.network} carries the URL: ${carried}`);
    // `&` inside the shared URL or text must not split the intent's own query.
    assert.ok(!u.searchParams.has("x") && !u.searchParams.has(" Commerce: members' disclosed stock trades"), t.network);
  }
  assert.equal(new URL(targets[0].href).searchParams.get("text"), TEXT);
  assert.equal(new URL(targets[1].href).searchParams.get("text"), `${TEXT} ${PAGE}`);
  assert.equal(new URL(targets[2].href).searchParams.get("title"), TEXT);
});

test("a page card names one image for both Open Graph and X, at 1200×630", () => {
  const card = pageCard("/cards/committee/HSIF", "alt text");
  assert.equal(card.og.url, "/cards/committee/HSIF/opengraph-image");
  assert.deepEqual(card.twitter, card.og);
  assert.equal(card.og.width, 1200);
  assert.equal(card.og.height, 630);
  assert.equal(card.og.alt, "alt text");
  // Only the path part names the segment.
  assert.equal(pageCard("/insiders?t=AAPL", "a").og.url, "/insiders/opengraph-image");
});

test("pageMetadata emits the card and summary_large_image", () => {
  const m = pageMetadata({ title: "T", description: "D", path: "/trends", card: pageCard("/trends", "A") });
  const og = m.openGraph as { images: { url: string; alt: string }[]; url: string };
  assert.equal(og.images[0].url, "/trends/opengraph-image");
  assert.equal(og.images[0].alt, "A");
  assert.equal(og.url, "/trends");
  const tw = m.twitter as { card: string; images: { url: string }[] };
  assert.equal(tw.card, "summary_large_image");
  assert.equal(tw.images[0].url, "/trends/opengraph-image");
});

test("card images are cached on the CDN for an hour and kept out of the page policy", () => {
  assert.equal(CARD_CDN_CACHE_CONTROL, `public, s-maxage=${CARD_CDN_SECONDS}, stale-while-revalidate=${CARD_SWR_SECONDS}`);
  assert.equal(CARD_CDN_SECONDS, 3600);
  const page = new RegExp(`^${PAGE_SOURCE}$`);
  for (const p of [
    "/politicians/opengraph-image",
    "/cards/late/opengraph-image",
    "/cards/committee/HSIF/opengraph-image",
    "/cards/issuer/BRK.B/opengraph-image",
    "/scans/20012345/opengraph-image",
  ]) {
    assert.ok(!page.test(p), p);
  }
});
