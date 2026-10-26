import assert from "node:assert/strict";
import { test } from "node:test";

import robots from "../app/robots.ts";

// robots.txt matching per RFC 9309: `*` matches any run of characters, `$`
// anchors the end, the longest matching rule wins, and a tie goes to Allow.
function allowed(rules: { allow: string[]; disallow: string[] }, url: string): boolean {
  const matcher = (pattern: string) =>
    new RegExp("^" + pattern.replace(/[.+?^${}()|[\]\\]/g, (c) => (c === "$" ? "$" : `\\${c}`)).replace(/\*/g, ".*").replace(/\\\$$/, "$"));
  let best: { len: number; allow: boolean } = { len: -1, allow: true };
  for (const [list, allow] of [[rules.allow, true], [rules.disallow, false]] as const) {
    for (const p of list) {
      if (!matcher(p).test(url)) continue;
      if (p.length > best.len || (p.length === best.len && allow)) best = { len: p.length, allow };
    }
  }
  return best.allow;
}

const groups = [robots().rules].flat().map((r) => ({
  agents: [r.userAgent].flat(),
  allow: [r.allow ?? []].flat(),
  disallow: [r.disallow ?? []].flat(),
}));

test("the matcher follows RFC 9309 precedence", () => {
  const rules = { allow: ["/", "/api/v1/"], disallow: ["/api/", "/x?*&"] };
  assert.equal(allowed(rules, "/api/health"), false);
  assert.equal(allowed(rules, "/api/v1/trades"), true, "the longer Allow wins");
  assert.equal(allowed(rules, "/x?a=1"), true);
  assert.equal(allowed(rules, "/x?a=1&b=2"), false);
});

for (const g of groups) {
  const who = g.agents.includes("*") ? "*" : "AI crawlers";

  test(`${who}: pages stay crawlable`, () => {
    for (const url of [
      "/",
      "/insiders",
      "/insiders?t=AAPL",
      "/tickers",
      "/tickers/MSFT",
      "/politicians",
      "/rankings",
      "/rankings?view=late",
      "/politicians?committee=HSIF",
      "/members/nancy-pelosi-P000197",
      "/api/v1/trades?ticker=MSFT&action=buy&sort=date",
    ]) {
      assert.ok(allowed(g, url), `${url} should be allowed`);
    }
  });

  test(`${who}: list views are not crawled`, () => {
    for (const url of [
      "/insiders?n=all",
      "/insiders?n=all&w=365",
      "/insiders?dir=asc&n=200&sort=bought&w=365",
      "/insiders?cik=0001277392",
      "/insiders?action=sell&cik=0000936828",
      "/insiders?t=BBD&w=90",
      "/tickers?sort=trades",
      "/members/nancy-pelosi-P000197?action=buy",
    ]) {
      assert.equal(allowed(g, url), false, `${url} should be disallowed`);
    }
  });
}
