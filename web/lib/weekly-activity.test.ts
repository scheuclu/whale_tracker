import assert from "node:assert/strict";
import { test } from "node:test";

import * as q from "./queries.ts";

// The feed's stat tiles show a 12-week trend under totals for the whole
// corpus. The buckets must add up to the window figures they sit beside, and
// no window may claim more than the corpus holds.

test("weekly buckets sum to the window totals", async () => {
  const w = await q.getWeeklyActivity(12);
  assert.equal(w.trades.length, 12);
  assert.equal(w.filings.length, 12);
  assert.equal(w.trades.reduce((a, b) => a + b, 0), w.window.trades);
  assert.equal(w.filings.reduce((a, b) => a + b, 0), w.window.filings);
  assert.ok(w.trades.every((n) => Number.isInteger(n) && n >= 0));
});

test("the window never exceeds the whole-corpus totals", async () => {
  const [w, p] = await Promise.all([q.getWeeklyActivity(12), q.getPipeline()]);
  assert.ok(w.window.trades <= p.totals.transactions);
  assert.ok(w.window.filings <= p.coverage.parsed);
  assert.ok(w.window.tickers <= p.totals.tickers);
  assert.ok(w.window.members <= p.totals.members);
});

test("a window longer than the corpus has no prior baseline", async () => {
  // 520 weeks reaches back ten years, before any filing in the corpus.
  const w = await q.getWeeklyActivity(520);
  assert.equal(w.priorTrades, null);
});
