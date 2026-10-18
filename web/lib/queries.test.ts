import assert from "node:assert/strict";
import { test } from "node:test";

import * as q from "./queries.ts";
import * as iq from "./insider-queries.ts";
import * as sq from "./scan-queries.ts";
import * as tq from "./trend-queries.ts";
import { monthKeys } from "./months.ts";

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
  ["getMonthlyTrades", () => tq.getMonthlyTrades(12)],
  ["getMonthlyDelay", () => tq.getMonthlyDelay(12)],
  ["getRisingTickers", () => tq.getRisingTickers("2026-09", 5)],
  ["getRisingTickers(malformed)", () => tq.getRisingTickers("2026-9", 5)],
  ["getMonthlyScans", () => tq.getMonthlyScans(12)],
  ["getInsiderMonthly", () => iq.getInsiderMonthly(12)],
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

// The monthly series are dense and end in the current month: a quiet month
// is a zero row, never a missing slot, and the window never names a month
// the database considers not to have started.
test("every monthly series has one row per month of the window, in order", async () => {
  const keys = monthKeys(12);
  const [trades, delay, insiders, scans] = await Promise.all([
    tq.getMonthlyTrades(12),
    tq.getMonthlyDelay(12),
    iq.getInsiderMonthly(12),
    tq.getMonthlyScans(12),
  ]);
  for (const rows of [trades, delay.months, insiders, scans]) {
    assert.deepEqual(
      rows.map((r) => r.month),
      keys
    );
  }
});

test("the party split and the direction split both add up", async () => {
  const rows = await tq.getMonthlyTrades(12);
  assert.ok(rows.some((r) => r.trades > 0), "the window has trades");
  for (const r of rows) {
    assert.equal(r.buy_d + r.buy_r + r.buy_other, r.buys, `${r.month} buys by party`);
    assert.equal(r.sell_d + r.sell_r + r.sell_other, r.sells, `${r.month} sells by party`);
    // Exchanges and unknown actions are in the total, in neither direction.
    assert.ok(r.buys + r.sells <= r.trades, `${r.month} directions within total`);
  }
});

test("the delay quantiles are ordered and present exactly when a month has measurable trades", async () => {
  const { months, overall } = await tq.getMonthlyDelay(12);
  for (const m of months) {
    if (m.n === 0) {
      assert.equal(m.median, null, `${m.month} median`);
      assert.equal(m.p90, null, `${m.month} p90`);
    } else {
      assert.ok(m.median != null && m.p90 != null, `${m.month} quantiles`);
      assert.ok(m.median <= m.p90, `${m.month} median ${m.median} <= p90 ${m.p90}`);
      assert.ok(m.late <= m.n, `${m.month} late within n`);
    }
  }
  assert.ok(overall.n > 0 && overall.median != null && overall.p90 != null);
  assert.ok(overall.median <= overall.p90);
});

test("a rising ticker gained members, and its direction counts are within its member count", async () => {
  const rows = await tq.getRisingTickers("2026-09", 10);
  for (const r of rows) {
    assert.equal(r.gain, r.members - r.prev_members);
    assert.ok(r.gain > 0, `${r.ticker} gained`);
    assert.ok(r.buy_members <= r.members && r.sell_members <= r.members, `${r.ticker} directions`);
  }
});

test("the insider monthly values are exact-but-computed: an unpriced row is in trades, in no value", async () => {
  const rows = await iq.getInsiderMonthly(12);
  for (const r of rows) {
    assert.equal(r.buys + r.sells, r.trades, `${r.month} only P and S rows are stored`);
    assert.ok(r.unpriced <= r.trades);
    assert.ok(r.buy_value >= 0 && r.sell_value >= 0);
  }
});
