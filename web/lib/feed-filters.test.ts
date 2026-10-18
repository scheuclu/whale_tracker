import assert from "node:assert/strict";
import { test } from "node:test";

import {
  exportFilename,
  exportHref,
  feedHref,
  filtersToParams,
  parseOffset,
  parseTransactionFilters,
} from "./feed-filters.ts";

test("every understood parameter round-trips through the URL", () => {
  const { filters, ignored } = parseTransactionFilters({
    ticker: "nvda",
    member: "Nancy Pelosi",
    action: "buy",
    chamber: "house",
    party: "D",
    type: "st",
    owner: "SP",
    from: "2026-01-01",
    to: "2026-06-30",
    scans: "exclude",
  });
  assert.deepEqual(ignored, []);
  assert.deepEqual(filters, {
    ticker: "NVDA",
    member: "Nancy Pelosi",
    action: "buy",
    chamber: "house",
    party: "D",
    assetType: "ST",
    owner: "SP",
    from: "2026-01-01",
    to: "2026-06-30",
    transcribed: "exclude",
  });
  const again = parseTransactionFilters(Object.fromEntries(filtersToParams(filters)));
  assert.deepEqual(again.filters, filters);
});

test("an unrecognised value is reported, not silently dropped", () => {
  const { filters, ignored } = parseTransactionFilters({
    chamber: "congress",
    party: "Whig",
    type: "stock",
    owner: "dog",
    from: "yesterday",
    to: "2026-13-45",
    scans: "yes",
    action: "hold",
  });
  assert.deepEqual(filters, {});
  assert.deepEqual(ignored, [
    "action=hold",
    "chamber=congress",
    "party=Whig",
    "type=stock",
    "owner=dog",
    "from=yesterday",
    "to=2026-13-45",
    "scans=yes",
  ]);
});

test("empty and repeated parameters: blank is unset, the first repeat wins", () => {
  const { filters, ignored } = parseTransactionFilters({ chamber: "", party: ["R", "D"], offset: "5" });
  assert.deepEqual(filters, { party: "R" });
  assert.deepEqual(ignored, []);
});

test("hrefs: the feed anchors the list, the export is the same query", () => {
  assert.equal(feedHref({}), "/");
  assert.equal(feedHref({ action: "sell", party: "R" }, 240), "/?action=sell&party=R&offset=240#trades");
  assert.equal(exportHref({}), "/api/export.csv");
  assert.equal(exportHref({ ticker: "NVDA" }), "/api/export.csv?ticker=NVDA");
  assert.equal(exportHref({ member: "Nancy Pelosi" }), "/api/export.csv?member=Nancy+Pelosi");
});

test("offset: non-negative integers only", () => {
  assert.equal(parseOffset("120"), 120);
  assert.equal(parseOffset(undefined), 0);
  assert.equal(parseOffset("-5"), 0);
  assert.equal(parseOffset("abc"), 0);
  assert.equal(parseOffset(["240", "1"]), 240);
});

test("the download name says what was filtered", () => {
  assert.equal(exportFilename({}), "trades.csv");
  assert.equal(exportFilename({ ticker: "NVDA", action: "buy" }), "trades-NVDA-buy.csv");
  assert.equal(exportFilename({ member: "Nancy Pelosi" }), "trades-Nancy_Pelosi.csv");
});
