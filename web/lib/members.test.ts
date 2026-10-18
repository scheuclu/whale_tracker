import assert from "node:assert/strict";
import { test } from "node:test";

import { initials, longDate, portraitUrl, seatLabel, tradeSummary } from "./members.ts";
import * as q from "./queries.ts";

test("leaderboard rows carry the bioguide id the portraits are keyed on", async () => {
  const rows = await q.getPoliticians(undefined, 20);
  assert.ok(rows.length > 0);
  const withId = rows.filter((r) => r.bioguide_id);
  assert.ok(withId.length >= rows.length - 2, "most top members are roster matches");
  for (const r of withId) assert.ok(portraitUrl(r.bioguide_id), `${r.member_name}: ${r.bioguide_id}`);
  const detail = await q.getPoliticianDetail(rows[0].member_name);
  assert.equal(detail?.bioguide_id, rows[0].bioguide_id);
});

test("a ticker's member list adds up to the ticker's trades", async () => {
  const [stat, members] = await Promise.all([q.getTickerDetail("NVDA"), q.getTickerMembers("nvda")]);
  assert.ok(stat && members.length > 0);
  assert.equal(
    members.reduce((s, m) => s + m.trades, 0),
    stat.trades
  );
  assert.equal(
    members.reduce((s, m) => s + m.buys, 0),
    stat.buys
  );
  // Floors add up; the ceiling is unknown as soon as one member's is.
  assert.equal(
    members.reduce((s, m) => s + m.volume_min, 0),
    stat.volume_min
  );
  if (members.some((m) => m.volume_max == null)) assert.equal(stat.volume_max, null);
});

test("portraitUrl builds the official photo path from a bioguide id", () => {
  assert.equal(
    portraitUrl("P000197"),
    "https://unitedstates.github.io/images/congress/225x275/P000197.jpg"
  );
  assert.equal(
    portraitUrl("T000278", "450x550"),
    "https://unitedstates.github.io/images/congress/450x550/T000278.jpg"
  );
});

test("portraitUrl refuses anything that is not a bioguide id", () => {
  assert.equal(portraitUrl(null), null);
  assert.equal(portraitUrl(""), null);
  assert.equal(portraitUrl("p000197"), null);
  assert.equal(portraitUrl("../../evil"), null);
  assert.equal(portraitUrl("P000197.jpg?x=1"), null);
});

test("initials skip middle initials and generational suffixes", () => {
  assert.equal(initials("Nancy Pelosi"), "NP");
  assert.equal(initials("Nicholas J. Begich III"), "NB");
  assert.equal(initials("Christian D. Menefee"), "CM");
  assert.equal(initials("Sheila Cherfilus-McCormick"), "SC");
  assert.equal(initials("John Smith, Jr."), "JS");
  assert.equal(initials("Madonna"), "M");
  assert.equal(initials("  "), "?");
  assert.equal(initials(null), "?");
});

test("seatLabel names chamber and seat, and nothing for an unmatched filer", () => {
  assert.equal(seatLabel("house", "CA", "11"), "House · CA-11");
  assert.equal(seatLabel("house", "AK", "0"), "House · AK");
  assert.equal(seatLabel("senate", "AL", null), "Senate · AL");
  assert.equal(seatLabel(null, "AL", null), null);
});

test("longDate reads an ISO date as written", () => {
  assert.equal(longDate("2025-12-24"), "Dec 24, 2025");
  assert.equal(longDate("2026-01-05T00:00:00"), "Jan 5, 2026");
  assert.equal(longDate(null), "—");
  assert.equal(longDate("13/01/2026"), "13/01/2026");
});

test("tradeSummary calls a 2:1 majority 'mostly', anything closer a mix", () => {
  assert.equal(
    tradeSummary({ trades: 28, tickers: 10, buys: 20, sells: 7 }),
    "28 trades across 10 tickers, mostly buys"
  );
  assert.equal(
    tradeSummary({ trades: 9, tickers: 3, buys: 3, sells: 6 }),
    "9 trades across 3 tickers, mostly sells"
  );
  assert.equal(
    tradeSummary({ trades: 10, tickers: 4, buys: 5, sells: 5 }),
    "10 trades across 4 tickers, a mix of buys and sells"
  );
  assert.equal(tradeSummary({ trades: 4, tickers: 2, buys: 4, sells: 0 }), "4 trades across 2 tickers, all buys");
  assert.equal(tradeSummary({ trades: 1, tickers: 1, buys: 0, sells: 1 }), "1 trade across 1 ticker, a sell");
  // Treasuries have no ticker, and exchanges are neither direction.
  assert.equal(tradeSummary({ trades: 3, tickers: 0, buys: 0, sells: 0 }), "3 trades");
});
