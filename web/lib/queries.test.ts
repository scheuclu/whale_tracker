import assert from "node:assert/strict";
import { test } from "node:test";

import * as q from "./queries.ts";
import * as iq from "./insider-queries.ts";
import * as sq from "./scan-queries.ts";
import * as xq from "./crossover-queries.ts";

// Every query the dashboard runs, executed against the committed database.
// A page renders its error inside a 200 response, so a broken query is
// invisible to a status check: the Insiders tab shipped "no such column:
// f.parse_method" for a day because a shared value helper gained a clause
// that only the congressional tables can satisfy. This is the guard.
const calls: Array<[string, () => Promise<unknown>]> = [
  ["getTickers", () => q.getTickers(90, 5)],
  ["getConsensusTickers", () => q.getConsensusTickers(90, 6)],
  ["getTransactions", () => q.getTransactions({ limit: 5 })],
  ["getTransactions(buy)", () => q.getTransactions({ action: "buy", limit: 5 })],
  ["getPoliticians", () => q.getPoliticians(undefined, 5)],
  ["getPoliticianTotals", () => q.getPoliticianTotals()],
  ["getPoliticianDetail", () => q.getPoliticianDetail("Nancy Pelosi")],
  ["getPoliticianTickers", () => q.getPoliticianTickers("Nancy Pelosi", 5)],
  ["getTickerDetail", () => q.getTickerDetail("NVDA")],
  ["getPipeline", () => q.getPipeline()],
  ["getInsiderTotals", () => iq.getInsiderTotals()],
  ["getInsiderIssuers", () => iq.getInsiderIssuers(30, 5)],
  ["getInsiderIssuer", () => iq.getInsiderIssuer("LEN")],
  ["getInsiderClusters", () => iq.getInsiderClusters(30, 3, 5)],
  ["getInsiderTrades", () => iq.getInsiderTrades({ limit: 5 })],
  ["getIssuerInsiders", () => iq.getIssuerInsiders("LEN")],
  ["getInsiderPipeline", () => iq.getInsiderPipeline()],
  ["getScanFilings", () => sq.getScanFilings()],
  ["getScanFiling", () => sq.getScanFiling("9116308")],
  ["getScanTotals", () => sq.getScanTotals()],
  ["getScanPagePng", () => sq.getScanPagePng(1, 1)],
  // Cross-links (#54): the windowed lookups each detail page makes of the
  // other side's tables, and the feed's overlap card.
  ["getTickerDetail(90d)", () => q.getTickerDetail("NVDA", 90)],
  ["getTickerMembers", () => q.getTickerMembers("NVDA", 90)],
  ["getInsiderIssuer(90d)", () => iq.getInsiderIssuer("LEN", 90)],
  ["getIssuerInsiders(90d)", () => iq.getIssuerInsiders("LEN", 90)],
  ["getBothSides", () => xq.getBothSides(30, 5)],
  ["getSharedTickers", () => xq.getSharedTickers(60)],
];

for (const [name, run] of calls) {
  test(`${name} runs against the committed database`, async () => {
    await assert.doesNotReject(run, `${name} threw`);
  });
}

test("the insider totals are populated, not an error page", async () => {
  const t = await iq.getInsiderTotals();
  assert.ok(t.trades > 0, "insider_transactions is populated in the committed DB");
});

// The overlap card sets two sets of books beside each other and must never
// mix them: each count on a row has to be exactly what that side's own page
// reports for the same ticker and window. If the insider join ever leaked
// into the member count (or vice versa) these would drift apart.
test("both sides reports each side's own aggregate, matched on listed symbols", async () => {
  const days = 30;
  const [rows, shared] = await Promise.all([xq.getBothSides(days, 100), xq.getSharedTickers(days)]);
  assert.ok(shared.tickers >= shared.same_direction, "same-direction overlap is a subset of the overlap");
  if (rows.length < 100) {
    assert.equal(new Set(rows.map((r) => r.ticker)).size, shared.same_direction);
  }
  for (const r of rows) {
    assert.ok(r.direction === "buy" || r.direction === "sell", `direction ${r.direction}`);
    assert.ok(r.members >= 1 && r.insiders >= 1, `${r.ticker}: both sides present`);
    assert.ok(r.ticker.trim() !== "", "matched on a listed symbol");

    const stat = await q.getTickerDetail(r.ticker, days);
    assert.ok(stat, `${r.ticker}: the ticker page finds the same window`);
    assert.equal(
      r.members,
      r.direction === "buy" ? stat.buy_politicians : stat.sell_politicians,
      `${r.ticker} ${r.direction}: member count is the ticker page's own figure`
    );

    const owners = await iq.getIssuerInsiders(r.ticker, days);
    assert.equal(
      r.insiders,
      owners.filter((o) => (r.direction === "buy" ? o.buys : o.sells) > 0).length,
      `${r.ticker} ${r.direction}: insider count is the issuer page's own figure`
    );
  }
});

test("the overlap window is bounded at today, like every other window", async () => {
  // A handful of filings carry a mistyped future trade date. `sinceClause`
  // excludes them, so widening the window never pulls in a trade that has
  // not happened yet: the 60-day overlap can only grow by adding past days.
  const [d30, d60] = await Promise.all([xq.getSharedTickers(30), xq.getSharedTickers(60)]);
  assert.ok(d60.tickers >= d30.tickers);
  assert.ok(d60.same_direction >= d30.same_direction);
});
