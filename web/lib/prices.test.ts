import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import {
  FAILURE_CDN_SECONDS,
  MIN_FROM_YEAR,
  SERIES_CDN_SECONDS,
  finalThrough,
  fromYear,
  normaliseSymbol,
  parseYahooChart,
  seriesHeaders,
  yahooSymbol,
  yahooUrl,
} from "./prices.ts";

// The pipeline's own fixture (tests/test_prices.py reads the same file), so the
// TypeScript parser is held to the Python one's answers. No network.
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(process.cwd(), "..", "tests", "fixtures", "yahoo_chart_spy.json"), "utf8")
);

test("parses Yahoo's chart JSON into one close per exchange session, like prices.parse_yahoo_chart", () => {
  const closes = parseYahooChart(FIXTURE);
  assert.equal(closes.length, 33);
  assert.equal(closes[0].date, "2026-09-01");
  assert.equal(closes[closes.length - 1].date, "2026-10-16");
  const dates = new Set(closes.map((c) => c.date));
  assert.ok(!dates.has("2026-09-07"), "Labor Day is not a session");
  assert.ok(dates.has("2026-10-12"), "Columbus Day is a federal holiday but NYSE trades");
  assert.ok(Math.abs(closes[closes.length - 1].close - 763.25) < 0.01);
  // Sorted, unique.
  for (let i = 1; i < closes.length; i++) assert.ok(closes[i - 1].date < closes[i].date);
});

test("a session is dated by the exchange offset, so a 13:30Z open never slips a day", () => {
  // 2026-01-05 14:30Z open, EST offset -18000: still Jan 5 in New York.
  const payload = {
    chart: {
      result: [
        {
          meta: { gmtoffset: -18000 },
          timestamp: [Date.UTC(2026, 0, 5, 14, 30) / 1000, Date.UTC(2026, 0, 6, 0, 30) / 1000],
          indicators: { quote: [{ close: [100, 101] }] },
        },
      ],
    },
  };
  // 00:30Z on Jan 6 is 19:30 on Jan 5 in New York: the later row for the same day wins.
  assert.deepEqual(parseYahooChart(payload), [{ date: "2026-01-05", close: 101 }]);
});

test("null, zero and non-finite closes are skipped, never read as 0", () => {
  const payload = {
    chart: {
      result: [
        {
          meta: { gmtoffset: 0 },
          timestamp: [86400 * 20000, 86400 * 20001, 86400 * 20002, 86400 * 20003],
          indicators: { quote: [{ close: [null, 0, 12.5, Number.NaN] }] },
        },
      ],
    },
  };
  assert.deepEqual(parseYahooChart(payload), [{ date: "2024-10-06", close: 12.5 }]);
});

test("Not Found is an empty series; any other error or a malformed body throws", () => {
  assert.deepEqual(
    parseYahooChart({ chart: { result: null, error: { code: "Not Found", description: "No data found, symbol may be delisted" } } }),
    []
  );
  assert.throws(() => parseYahooChart({ chart: { result: null, error: { code: "Bad Request", description: "x" } } }), /Bad Request/);
  assert.throws(() => parseYahooChart({}), /no result/);
  assert.throws(() => parseYahooChart(null), /no result/);
});

test("a close is final only after the New York session ends (prices.final_through)", () => {
  assert.equal(finalThrough(new Date(Date.UTC(2026, 9, 16, 19, 0))), "2026-10-15");
  assert.equal(finalThrough(new Date(Date.UTC(2026, 9, 16, 20, 10))), "2026-10-16");
  // 02:00Z Saturday is Friday evening in New York.
  assert.equal(finalThrough(new Date(Date.UTC(2026, 9, 17, 2, 0))), "2026-10-16");
  // Winter time: 16:04 EST is 21:04Z, still before the cut-off.
  assert.equal(finalThrough(new Date(Date.UTC(2026, 0, 6, 21, 4))), "2026-01-05");
  assert.equal(finalThrough(new Date(Date.UTC(2026, 0, 6, 21, 5))), "2026-01-06");
});

test("symbols: listed shapes pass, normalised; exchange-prefixed, CIK-shaped and junk are refused", () => {
  assert.equal(normaliseSymbol("nvda"), "NVDA");
  assert.equal(normaliseSymbol(" brk.b "), "BRK.B");
  assert.equal(normaliseSymbol("BRK%2EB"), "BRK.B");
  assert.equal(normaliseSymbol("GOOGL"), "GOOGL");
  assert.equal(normaliseSymbol("ASX:LNW"), null);
  assert.equal(normaliseSymbol("ASX%3ALNW"), null);
  assert.equal(normaliseSymbol("N.A."), null);
  assert.equal(normaliseSymbol("0001742952"), null);
  assert.equal(normaliseSymbol("A B"), null);
  assert.equal(normaliseSymbol("../etc"), null);
  assert.equal(normaliseSymbol("%E0%A4%A"), null);
  assert.equal(normaliseSymbol(""), null);
  assert.equal(normaliseSymbol(null), null);
});

test("Yahoo symbol and URL mirror prices.yahoo_symbol / _fetch_yahoo", () => {
  assert.equal(yahooSymbol("BRK.B"), "BRK-B");
  const url = new URL(yahooUrl("BRK.B", 2025, new Date(Date.UTC(2026, 9, 22, 13, 0))));
  assert.equal(url.pathname, "/v8/finance/chart/BRK-B");
  assert.equal(url.searchParams.get("period1"), String(Date.UTC(2025, 0, 1) / 1000));
  assert.equal(url.searchParams.get("period2"), String(Date.UTC(2026, 9, 23) / 1000));
  assert.equal(url.searchParams.get("interval"), "1d");
});

test("from year: integer, clamped to [MIN_FROM_YEAR, this year], three years back by default", () => {
  const now = new Date(Date.UTC(2026, 9, 22));
  assert.equal(fromYear("2025", now), 2025);
  assert.equal(fromYear("1999", now), MIN_FROM_YEAR);
  assert.equal(fromYear("2031", now), 2026);
  assert.equal(fromYear("abc", now), 2023);
  assert.equal(fromYear("2025.5", now), 2023);
  assert.equal(fromYear(null, now), 2023);
});

test("cache headers: a series is held half a day plus SWR; a failure only minutes", () => {
  const ok = seriesHeaders("ok");
  assert.match(ok["CDN-Cache-Control"], new RegExp(`s-maxage=${SERIES_CDN_SECONDS}`));
  assert.match(ok["CDN-Cache-Control"], /stale-while-revalidate=\d+/);
  assert.match(seriesHeaders("no_data")["CDN-Cache-Control"], new RegExp(`s-maxage=${SERIES_CDN_SECONDS}`));
  const failed = seriesHeaders("unavailable");
  assert.equal(failed["CDN-Cache-Control"], `public, s-maxage=${FAILURE_CDN_SECONDS}`);
  assert.doesNotMatch(failed["CDN-Cache-Control"], /stale-while-revalidate/);
});
