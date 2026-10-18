import assert from "node:assert/strict";
import { test } from "node:test";

import { getSitemapMembers, getSitemapTickers, resolveMemberName, resolveMemberSlug } from "./entities.ts";
import { memberSlug, tickerHref } from "./format.ts";
import { getTickerDetail } from "./queries.ts";

// Against the committed database: the URL a page links, the URL the sitemap
// lists and the URL a legacy `?m=` link redirects to must all be the one
// slug the resolver treats as canonical — otherwise a crawler is sent round
// a redirect from the site's own links.

test("every sitemap member resolves to exactly its sitemap slug", async () => {
  const members = await getSitemapMembers();
  assert.ok(members.length > 50);
  for (const m of members) {
    const slug = memberSlug(m.name, m.bioguide_id);
    const bySlug = await resolveMemberSlug(slug);
    assert.equal(bySlug?.slug, slug, `slug ${slug}`);
    assert.equal(bySlug?.name, m.name);
    const byName = await resolveMemberName(m.name);
    assert.equal(byName?.slug, slug, `legacy ?m=${m.name}`);
  }
});

test("a name-only or stale slug resolves to the canonical one; nobody is null", async () => {
  const [m] = (await getSitemapMembers()).filter((x) => x.bioguide_id);
  const canonical = memberSlug(m.name, m.bioguide_id);
  assert.equal((await resolveMemberSlug(memberSlug(m.name)))?.slug, canonical);
  assert.equal((await resolveMemberSlug(`someone-else-${m.bioguide_id!.toLowerCase()}`))?.slug, canonical);
  assert.equal((await resolveMemberSlug(canonical.toUpperCase()))?.slug, canonical);
  assert.equal(await resolveMemberSlug("nobody-by-this-name-z999999"), null);
  assert.equal(await resolveMemberSlug("nobody-by-this-name"), null);
});

test("every sitemap ticker has a ticker page", async () => {
  const tickers = await getSitemapTickers();
  assert.ok(tickers.some((t) => t.ticker === "BRK.B"), "class-suffixed symbols are listed");
  for (const t of tickers.slice(0, 50)) {
    assert.ok(await getTickerDetail(t.ticker), t.ticker);
    assert.equal(tickerHref(t.ticker), `/tickers/${encodeURIComponent(t.ticker)}`);
  }
});
