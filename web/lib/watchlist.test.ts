import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EMPTY_WATCHLIST,
  isBioguideId,
  isWatchTicker,
  parseWatchParam,
  sanitizeWatchlistState,
  serializeWatchParam,
  toggleWatchItem,
  watchlistFeedHref,
} from "./watchlist.ts";

test("isBioguideId and isWatchTicker partition member IDs and stock symbols", () => {
  assert.equal(isBioguideId("P000197"), true);
  assert.equal(isBioguideId("c001123"), true);
  assert.equal(isBioguideId("NVDA"), false);
  assert.equal(isBioguideId("BRK.B"), false);

  assert.equal(isWatchTicker("NVDA"), true);
  assert.equal(isWatchTicker("brk.b"), true);
  assert.equal(isWatchTicker("P000197"), false);
  assert.equal(isWatchTicker("NOT_A_TICKER_123"), false);
});

test("parseWatchParam and serializeWatchParam round-trip members and tickers", () => {
  const parsed = parseWatchParam("p000197, nvda, brk.b, C001123, nvda, invalid$$$");
  assert.deepEqual(parsed, {
    members: ["P000197", "C001123"],
    tickers: ["NVDA", "BRK.B"],
  });
  assert.equal(serializeWatchParam(parsed!), "P000197,C001123,NVDA,BRK.B");
  assert.equal(watchlistFeedHref(parsed!), "/?watch=P000197%2CC001123%2CNVDA%2CBRK.B#trades");
  assert.equal(parseWatchParam(""), null);
  assert.equal(parseWatchParam(undefined), null);
});

test("toggleWatchItem adds and removes items while preserving labels", () => {
  const step1 = toggleWatchItem(EMPTY_WATCHLIST, {
    kind: "member",
    id: "p000197",
    label: "Nancy Pelosi",
  });
  assert.equal(step1.followed, true);
  assert.deepEqual(step1.next.members, ["P000197"]);
  assert.equal(step1.next.labels.P000197, "Nancy Pelosi");

  const step2 = toggleWatchItem(step1.next, {
    kind: "ticker",
    id: "nvda",
    label: "NVIDIA Corp",
  });
  assert.equal(step2.followed, true);
  assert.deepEqual(step2.next.tickers, ["NVDA"]);

  const step3 = toggleWatchItem(step2.next, {
    kind: "member",
    id: "P000197",
  });
  assert.equal(step3.followed, false);
  assert.deepEqual(step3.next.members, []);
  assert.deepEqual(step3.next.tickers, ["NVDA"]);

  const sanitized = sanitizeWatchlistState(step2.next);
  assert.deepEqual(sanitized.members, ["P000197"]);
  assert.deepEqual(sanitized.tickers, ["NVDA"]);
});
