import assert from "node:assert/strict";
import { test } from "node:test";

import { memberHref, memberSlug, slugBioguide, slugify, tickerHref } from "./format.ts";
import { clip, pageMetadata } from "./seo.ts";
import { absoluteUrl, siteUrl } from "./site.ts";
import { breadcrumbLd, datasetLd, personLd, serializeLd, websiteLd } from "./structured-data.ts";

// The entity URL scheme. The member cases are mirrored in
// tests/test_filing_summary.py (`member_page_url`): Telegram alerts build the
// same URLs in Python, and the two slug functions must not drift.

test("slugify folds accents and collapses punctuation", () => {
  assert.equal(slugify("Gilbert Ray Cisneros, Jr."), "gilbert-ray-cisneros-jr");
  assert.equal(slugify("Nydia M. Velázquez"), "nydia-m-velazquez");
  assert.equal(slugify("O'Halleran, Tom"), "o-halleran-tom");
  assert.equal(slugify("  --  "), "");
});

test("a roster-matched member's slug carries the bioguide id", () => {
  assert.equal(memberSlug("Nancy Pelosi", "P000197"), "nancy-pelosi-p000197");
  assert.equal(memberHref("Gilbert Ray Cisneros, Jr.", "C001123"), "/members/gilbert-ray-cisneros-jr-c001123");
  assert.equal(memberHref("Kevin Hern", "H001082"), "/members/kevin-hern-h001082");
});

test("an unmatched filer's slug is the printed name; a malformed id is dropped", () => {
  assert.equal(memberHref("Nydia M. Velázquez"), "/members/nydia-m-velazquez");
  assert.equal(memberHref("O'Halleran, Tom", null), "/members/o-halleran-tom");
  assert.equal(memberHref("Kevin Hern", "h1082"), "/members/kevin-hern");
  assert.equal(memberHref(""), "/members/member");
});

test("the trade filter stays a query parameter", () => {
  assert.equal(memberHref("Nancy Pelosi", "P000197", "buy"), "/members/nancy-pelosi-p000197?action=buy");
});

test("slugBioguide reads the id back, and only an id", () => {
  assert.equal(slugBioguide("nancy-pelosi-p000197"), "P000197");
  assert.equal(slugBioguide("NANCY-PELOSI-P000197"), "P000197");
  assert.equal(slugBioguide("nancy-pelosi"), null);
  assert.equal(slugBioguide("p000197"), null, "the id alone has no name part");
});

test("ticker URLs are upper case and keep class suffixes", () => {
  assert.equal(tickerHref("MSFT"), "/tickers/MSFT");
  assert.equal(tickerHref("brk.b"), "/tickers/BRK.B");
  assert.equal(tickerHref("MOG.A"), "/tickers/MOG.A");
  assert.equal(tickerHref("A/B"), "/tickers/A%2FB");
});

test("siteUrl prefers the explicit URL, then Vercel's production domain, then localhost", () => {
  assert.equal(siteUrl({ NEXT_PUBLIC_SITE_URL: "https://whaletracker-blue.vercel.app/" }), "https://whaletracker-blue.vercel.app");
  assert.equal(siteUrl({ NEXT_PUBLIC_SITE_URL: "  ", VERCEL_PROJECT_PRODUCTION_URL: "whaletracker-blue.vercel.app" }), "https://whaletracker-blue.vercel.app");
  assert.equal(siteUrl({}), "http://localhost:3000");
  assert.equal(absoluteUrl("/tickers/MSFT", { NEXT_PUBLIC_SITE_URL: "https://x.test" }), "https://x.test/tickers/MSFT");
});

test("pageMetadata sets canonical, robots and the social copies together", () => {
  const m = pageMetadata({ title: "MSFT trades", description: "d", path: "/tickers/MSFT" });
  assert.deepEqual(m.alternates, { canonical: "/tickers/MSFT" });
  assert.equal(m.robots, undefined);
  assert.equal((m.openGraph as { siteName?: string }).siteName, "Whale Tracker", "a page's openGraph replaces the layout's");
  assert.equal((m.openGraph as { url?: string }).url, "/tickers/MSFT");
  const search = pageMetadata({ title: "Search", description: "d", path: "/search", noindex: true });
  assert.deepEqual(search.robots, { index: false, follow: true });
});

test("clip keeps short text and cuts long text on a word", () => {
  assert.equal(clip("short"), "short");
  const out = clip("word ".repeat(60), 50);
  assert.ok(out.length <= 50 && out.endsWith("…"), out);
  assert.ok(!out.includes("wor…"), out);
});

test("JSON-LD cannot close its script element", () => {
  const s = serializeLd({ name: "</script><script>alert(1)</script> & co" });
  assert.ok(!s.includes("<") && !s.includes(">"), s);
  assert.equal(JSON.parse(s).name, "</script><script>alert(1)</script> & co");
});

test("the search action points at /search?q=", () => {
  const ld = websiteLd() as { potentialAction: { target: { urlTemplate: string } } };
  assert.match(ld.potentialAction.target.urlTemplate, /\/search\?q=\{search_term_string\}$/);
});

test("the Dataset says amounts are ranges, not figures", () => {
  const ld = datasetLd({ firstFilingDate: "2026-01-01", lastFilingDate: "2026-10-15", transactions: 10, members: 2, insiderTrades: 3 }) as {
    temporalCoverage: string;
    description: string;
    variableMeasured: { name: string; description?: string }[];
  };
  assert.equal(ld.temporalCoverage, "2026-01-01/2026-10-15");
  assert.match(ld.description, /brackets as filed/);
  const amount = ld.variableMeasured.find((v) => v.name === "amount range");
  assert.ok(amount?.description?.includes("open-ended"));
  assert.match(ld.variableMeasured.find((v) => v.name === "insider trade value")!.description!, /shares × the reported price/);
});

test("Person carries only what the roster says", () => {
  const p = JSON.parse(
    serializeLd(personLd({ name: "Nancy Pelosi", bioguideId: "P000197", chamber: "house", party: "D", state: "CA", path: "/members/nancy-pelosi-p000197" }))
  );
  assert.equal(p.jobTitle, "U.S. Representative from CA");
  assert.equal(p.image, "https://unitedstates.github.io/images/congress/450x550/P000197.jpg");
  assert.equal(p.affiliation.name, "Democratic Party");
  const unmatched = JSON.parse(serializeLd(personLd({ name: "A Filer", bioguideId: null, chamber: null, party: null, state: null, path: "/members/a-filer" })));
  assert.deepEqual(Object.keys(unmatched).sort(), ["@context", "@id", "@type", "name", "url"]);
});

test("breadcrumbs are absolute and numbered from 1", () => {
  const b = breadcrumbLd([
    { name: "Whale Tracker", path: "/" },
    { name: "Tickers", path: "/tickers" },
  ]) as { itemListElement: { position: number; item: string }[] };
  assert.deepEqual(b.itemListElement.map((i) => i.position), [1, 2]);
  assert.ok(b.itemListElement.every((i) => /^https?:\/\//.test(i.item)));
});
