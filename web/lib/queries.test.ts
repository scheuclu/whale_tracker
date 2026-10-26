import assert from "node:assert/strict";
import { test } from "node:test";

import * as q from "./queries.ts";
import * as iq from "./insider-queries.ts";
import * as sq from "./scan-queries.ts";
import * as tq from "./trend-queries.ts";
import { monthKeys } from "./months.ts";
import * as xq from "./crossover-queries.ts";
import * as aq from "./alert-queries.ts";
import * as oq from "./outcome-queries.ts";

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
  ["getTransactions(options)", () => q.getTransactions({ ticker: "MSFT", options: true, limit: 5 })],
  ["getPoliticians", () => q.getPoliticians(undefined, 5)],
  ["getPoliticianTotals", () => q.getPoliticianTotals()],
  ["getPoliticianDetail", () => q.getPoliticianDetail("Nancy Pelosi")],
  ["getPoliticianTickers", () => q.getPoliticianTickers("Nancy Pelosi", 5)],
  ["getPoliticianCommittees", () => q.getPoliticianCommittees("Brett Guthrie")],
  ["getCommittee", () => q.getCommittee("HSIF")],
  ["getSubcommittees", () => q.getSubcommittees("HSIF")],
  ["getCommitteeMembers", () => q.getCommitteeMembers("HSIF")],
  ["getTickerDetail", () => q.getTickerDetail("NVDA")],
  [
    "getTransactions(every filter)",
    () =>
      q.getTransactions({
        action: "sell",
        chamber: "house",
        party: "D",
        assetType: "ST",
        owner: "SP",
        from: "2026-01-01",
        to: "2026-12-31",
        transcribed: "exclude",
        limit: 5,
        offset: 5,
      }),
  ],
  ["getTransactionTotals", () => q.getTransactionTotals()],
  ["getTransactionTotals(filtered)", () => q.getTransactionTotals({ chamber: "senate", owner: "self" })],
  ["searchMembers", () => q.searchMembers("Pelosi")],
  ["searchRoster", () => q.searchRoster("Pelosi")],
  ["searchTickers", () => q.searchTickers("NVDA")],
  ["searchInsiderIssuers", () => iq.searchInsiderIssuers("NVDA")],
  ["getPoliticianSectors", () => q.getPoliticianSectors("Nancy Pelosi")],
  ["getSectorLeaderboard", () => q.getSectorLeaderboard(90)],
  ["getSectorLeaderboard(all)", () => q.getSectorLeaderboard()],
  ["getPipeline", () => q.getPipeline()],
  ["getLateMembers", () => q.getLateMembers(5)],
  ["getLateMonthly", () => q.getLateMonthly()],
  ["getLateTotals", () => q.getLateTotals()],
  ["getLateFilings", () => q.getLateFilings(3)],
  ["getInsiderTotals", () => iq.getInsiderTotals()],
  ["getInsiderIssuers", () => iq.getInsiderIssuers(30, 5)],
  ["getInsiderIssuer", () => iq.getInsiderIssuer("LEN")],
  ["getInsiderClusters", () => iq.getInsiderClusters(30, 3, 5)],
  ["getInsiderTrades", () => iq.getInsiderTrades({ limit: 5 })],
  ["getInsiderTrades(watch)", () => iq.getInsiderTrades({ watch: { insiders: ["0001767470"], tickers: ["GME"] }, limit: 5 })],
  ["getInsiderFilers", () => iq.getInsiderFilers({ limit: 5 })],
  ["getInsiderFilers(officer buy)", () => iq.getInsiderFilers({ role: "officer", direction: "buy", limit: 5 })],
  ["getInsiderFiler", () => iq.getInsiderFiler("0001767470")],
  ["getInsiderFilerIssuers", () => iq.getInsiderFilerIssuers("0001767470")],
  ["getInsiderTrackLeaderboard(20)", () => iq.getInsiderTrackLeaderboard(20)],
  ["getInsiderTrackLeaderboard(5)", () => iq.getInsiderTrackLeaderboard(5)],
  ["getInsiderFilerTrack", () => iq.getInsiderFilerTrack("0001767470")],
  ["getIssuerInsiders", () => iq.getIssuerInsiders("LEN")],
  ["getInsiderSectors", () => iq.getInsiderSectors(30)],
  ["getInsiderPipeline", () => iq.getInsiderPipeline()],
  ["getScanFilings", () => sq.getScanFilings()],
  ["getScanFiling", () => sq.getScanFiling("9116308")],
  ["getScanFiling(page)", () => sq.getScanFiling("8221322", 2)],
  ["getScanTotals", () => sq.getScanTotals()],
  ["getScanPagePng", () => sq.getScanPagePng(1, 1)],
  ["getMonthlyTrades", () => tq.getMonthlyTrades(12)],
  ["getMonthlyDelay", () => tq.getMonthlyDelay(12)],
  ["getRisingTickers", () => tq.getRisingTickers("2026-09", 5)],
  ["getRisingTickers(malformed)", () => tq.getRisingTickers("2026-9", 5)],
  ["getMonthlyScans", () => tq.getMonthlyScans(12)],
  ["getInsiderMonthly", () => iq.getInsiderMonthly(12)],
  // Cross-links (#54): the windowed lookups each detail page makes of the
  // other side's tables, and the feed's overlap card.
  ["getTickerDetail(90d)", () => q.getTickerDetail("NVDA", 90)],
  ["getTickerMembers", () => q.getTickerMembers("NVDA", 90)],
  ["getInsiderIssuer(90d)", () => iq.getInsiderIssuer("LEN", 90)],
  ["getIssuerInsiders(90d)", () => iq.getIssuerInsiders("LEN", 90)],
  ["getBothSides", () => xq.getBothSides(30, 5)],
  ["getSharedTickers", () => xq.getSharedTickers(60)],
  ["getAlerts", () => aq.getAlerts({ limit: 5 })],
  ["getAlerts(cluster)", () => aq.getAlerts({ kind: "cluster", limit: 5 })],
  ["getAlertTotals", () => aq.getAlertTotals()],
  ["getAlertsPerWeek", () => aq.getAlertsPerWeek(8)],
  // The committed database predates the price tables: these must answer
  // "nothing yet", not throw, until the pipeline migrates it.
  ["getAlertOutcomes", () => oq.getAlertOutcomes()],
  ["getOutcomeSummary", () => oq.getOutcomeSummary()],
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

// --- feed filters ---------------------------------------------------------

test("each feed filter narrows to rows that satisfy it", async () => {
  const senate = await q.getTransactions({ chamber: "senate", limit: 50 });
  assert.ok(senate.length > 0);
  // The filter is on the filing's chamber; the row's is the roster's and may be unmatched.
  for (const r of senate) assert.ok(r.chamber === "senate" || r.chamber == null, `${r.member_name} is ${r.chamber}`);

  const dems = await q.getTransactions({ party: "D", limit: 50 });
  assert.ok(dems.length > 0);
  for (const r of dems) assert.equal(r.party, "D");

  const spouse = await q.getTransactions({ owner: "SP", limit: 50 });
  assert.ok(spouse.length > 0);
  for (const r of spouse) assert.equal(r.owner, "SP");
  const self = await q.getTransactions({ owner: "self", limit: 50 });
  assert.ok(self.length > 0);
  for (const r of self) assert.ok(r.owner == null || r.owner === "");

  const stock = await q.getTransactions({ assetType: "GS", limit: 50 });
  assert.ok(stock.length > 0);
  for (const r of stock) assert.equal(r.asset_type, "GS");

  const window = await q.getTransactions({ from: "2026-02-01", to: "2026-02-28", limit: 50 });
  assert.ok(window.length > 0);
  for (const r of window) assert.ok(r.tx_date! >= "2026-02-01" && r.tx_date! <= "2026-02-28", r.tx_date!);

  const only = await q.getTransactions({ transcribed: "only", limit: 50 });
  for (const r of only) assert.equal(r.transcribed, 1);
  const none = await q.getTransactions({ transcribed: "exclude", limit: 50 });
  assert.ok(none.length > 0);
  for (const r of none) assert.equal(r.transcribed, 0);
});

test("offset pages through the same ordering without overlap", async () => {
  const first = await q.getTransactions({ limit: 20 });
  const second = await q.getTransactions({ limit: 20, offset: 20 });
  const both = await q.getTransactions({ limit: 40 });
  assert.deepEqual(
    [...first, ...second].map((r) => r.id),
    both.map((r) => r.id)
  );
});

test("the totals describe the same rows the list does, as a bracket range", async () => {
  for (const filters of [{}, { ticker: "NVDA" }, { chamber: "senate" as const, action: "buy" as const }]) {
    const totals = await q.getTransactionTotals(filters);
    const rows = await q.getTransactions({ ...filters, limit: 100_000 });
    assert.equal(totals.trades, rows.length, JSON.stringify(filters));
    assert.equal(
      totals.transcribed,
      rows.filter((r) => r.transcribed).length
    );
    // Floor and ceiling summed over the counted rows; NULL ceiling once any is open-ended.
    const counted = rows.filter((r) => !r.transcribed);
    const floor = counted.reduce((a, r) => a + (r.amount_min_cents ?? 0), 0);
    const open = counted.some((r) => r.amount_max_cents == null && r.amount_exact_cents == null);
    assert.equal(totals.volume_min, floor);
    if (open) assert.equal(totals.volume_max, null);
    else {
      assert.equal(
        totals.volume_max,
        counted.reduce((a, r) => a + (r.amount_max_cents ?? r.amount_exact_cents ?? 0), 0)
      );
      assert.ok(totals.volume_mid <= totals.volume_max!);
    }
    assert.ok(totals.volume_mid >= totals.volume_min);
  }
});

// --- search -----------------------------------------------------------------

test("search finds a member, a ticker and an insider issuer", async () => {
  const members = await q.searchMembers("pelosi");
  assert.ok(members.some((m) => m.member_name === "Nancy Pelosi"), JSON.stringify(members));
  assert.ok(members.every((m) => m.trades > 0));
  // She has trades, so she is not in the roster-only list.
  const roster = await q.searchRoster("pelosi");
  assert.ok(!roster.some((r) => r.full_name === "Nancy Pelosi"));

  const tickers = await q.searchTickers("nvda");
  assert.equal(tickers[0]?.ticker, "NVDA", "exact symbol ranks first");
  const byName = await q.searchTickers("nvidia");
  assert.ok(byName.some((t) => t.ticker === "NVDA"), "asset name matches too");

  const issuers = await iq.searchInsiderIssuers("nvda");
  assert.equal(issuers[0]?.ticker, "NVDA", JSON.stringify(issuers));
  assert.ok(issuers[0].insiders > 0 && issuers[0].filings > 0);
});

test("LIKE wildcards in a query are literal", () => {
  assert.equal(q.likePattern("a%b_c\\d"), "%a\\%b\\_c\\\\d%");
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

test("the overlap window is bounded at today, like every other window", async () => {
  // A handful of filings carry a mistyped future trade date. `sinceClause`
  // excludes them, so widening the window never pulls in a trade that has
  // not happened yet: the 60-day overlap can only grow by adding past days.
  const [d30, d60] = await Promise.all([xq.getSharedTickers(30), xq.getSharedTickers(60)]);
  assert.ok(d60.tickers >= d30.tickers);
  assert.ok(d60.same_direction >= d30.same_direction);
});

// --- scans, one page at a time (#62) ----------------------------------------
// 8221322 is the 56-page Khanna filing the issue was opened over; 8221326 is
// a transcribed one whose every row is linked to a transaction.

test("a long scan is served one page at a time, with the whole page list", async () => {
  const d = await sq.getScanFiling("8221322", 2);
  assert.ok(d, "8221322 is a scan");
  assert.equal(d.page, 2);
  assert.equal(d.pages.length, 56);
  assert.ok(d.rows.length > 0, "page 2 has rows");
  assert.ok(
    d.rows.every((r) => r.page_no === 2),
    "only the requested page's rows are loaded"
  );
  const perPage = d.pages.reduce((n, p) => n + p.rows, 0);
  assert.equal(perPage, d.filing.rows, "the per-page counts add up to the filing's");
});

test("a captured filing stays a scan whatever its parse_method became", async () => {
  // Its last vision attempt crashed, so its parse_method is 'error' — not
  // one of the scan methods — yet 56 pages are captured. Were it re-read
  // later the method would change and this would still hold.
  const d = await sq.getScanFiling("8221322");
  assert.ok(d, "listed by its captured pages, not by parse_method");
  assert.ok((await sq.getScanFilings()).some((f) => f.doc_id === "8221322"));
});

test("a page the filing does not have yields no rows, not an error", async () => {
  const d = await sq.getScanFiling("8221326", 99);
  assert.ok(d);
  assert.equal(d.page, 99);
  assert.equal(d.rows.length, 0);
});

test("a transcribed filing's rows carry the transaction and the model's own reading", async () => {
  const d = await sq.getScanFiling("8221326", 1);
  assert.ok(d);
  assert.ok(d.rows.length > 0);
  for (const r of d.rows) {
    assert.ok(r.transaction_id != null, `row ${r.row_index + 1} is linked`);
    assert.ok(r.asset_name, `row ${r.row_index + 1} has the transcribed asset name`);
    assert.ok(r.tx_date, `row ${r.row_index + 1} has the transcribed date`);
  }
  assert.ok(d.rows.some((r) => r.owner != null), "owner comes through the join");
  assert.ok(d.rows.some((r) => r.model_action != null), "the model's reading is parsed from raw_text");
  assert.ok(d.filing.linked >= d.rows.length, "the filing-wide linked count covers this page");
});

test("parsePageNo: a positive integer as typed, else page 1", () => {
  assert.equal(sq.parsePageNo(undefined), 1);
  assert.equal(sq.parsePageNo(""), 1);
  assert.equal(sq.parsePageNo("3"), 3);
  assert.equal(sq.parsePageNo("0"), 1);
  assert.equal(sq.parsePageNo("-2"), 1);
  assert.equal(sq.parsePageNo("2.5"), 1);
  assert.equal(sq.parsePageNo("abc"), 1);
});

test("modelReading recovers the model's amount letter and type from raw_text", () => {
  const raw =
    "(scanned filing: text transcribed by gemini; amount column A and type purchase " +
    "read from the printed grid, page 1; model read B / sale)";
  assert.deepEqual(sq.modelReading(raw), { amount_letter: "B", action: "sale" });
  assert.deepEqual(sq.modelReading("(…; model read ? / ?)"), { amount_letter: null, action: null });
  assert.deepEqual(sq.modelReading("(…; model read A / ?)"), { amount_letter: "A", action: null });
  assert.deepEqual(sq.modelReading(null), { amount_letter: null, action: null });
  assert.deepEqual(sq.modelReading("a text-layer filing"), { amount_letter: null, action: null });
});

test("a type dispute is one of direction, as vision.join counts it", () => {
  assert.equal(sq.isTypeDisputed("purchase", "sale"), true);
  assert.equal(sq.isTypeDisputed("sale", "purchase"), true);
  assert.equal(sq.isTypeDisputed("sale", "sale_partial"), false);
  assert.equal(sq.isTypeDisputed("sale_partial", "sale"), false);
  assert.equal(sq.isTypeDisputed("purchase", null), false);
  assert.equal(sq.isTypeDisputed(null, "sale"), false);
  assert.equal(sq.isTypeDisputed("purchase", "unknown"), false);
});

test("getPipeline().lastUpdated is the last pipeline run, not the last filing change", async () => {
  // A run that finds nothing new still writes sync_state; the footer's
  // "Updated … ago" line and /pipeline's "Last run" must follow it.
  const db = await (await import("./db.ts")).getDb();
  const run = (db.prepare("SELECT MAX(updated_at) AS t FROM sync_state").get() as { t: string | null }).t;
  const p = await q.getPipeline();
  assert.ok(run, "fixture database has sync_state rows");
  assert.equal(p.lastUpdated, run);
});

test("watch filter matches rows by bioguide_id or ticker", async () => {
  const rows = await q.getTransactions({
    watch: { members: ["P000197"], tickers: ["MSFT"] },
    limit: 200,
  });
  assert.ok(rows.length > 0, "watched member or ticker has rows");
  for (const r of rows) {
    assert.ok(
      r.bioguide_id === "P000197" || r.ticker === "MSFT",
      `row ${r.id} matches watched member or ticker`
    );
  }
  const totals = await q.getTransactionTotals({
    watch: { members: ["P000197"], tickers: ["MSFT"] },
  });
  assert.ok(totals.trades >= rows.length);
});

test("insider filers and track leaderboard return populated, well-formed rows", async () => {
  const filers = await iq.getInsiderFilers({ direction: "buy", limit: 10 });
  assert.ok(filers.length > 0, "insider filers leaderboard is populated");
  for (const f of filers) {
    assert.ok(f.cik.trim() !== "");
    assert.equal(f.buys + f.sells, f.trades);
    assert.ok(f.buy_value >= 0 && f.sell_value >= 0);
  }

  const cohen = await iq.getInsiderFiler("0001767470");
  assert.ok(cohen, "Ryan Cohen CIK 0001767470 is in the committed DB");
  assert.equal(cohen.cik, "0001767470");
  assert.ok(cohen.buys > 0 && cohen.buy_value > 0);
  const cohenIssuers = await iq.getInsiderFilerIssuers("0001767470");
  assert.ok(cohenIssuers.some((i) => i.ticker === "GME"));

  const track20 = await iq.getInsiderTrackLeaderboard(20);
  assert.ok(track20.rows.length > 0, "20d insider track leaderboard has ranked rows");
  assert.ok(track20.rows.some((r) => r.cik === "0001767470" && r.primary_ticker === "GME"));

  const cohenTrack = await iq.getInsiderFilerTrack("0001767470");
  assert.ok(cohenTrack.score5 && cohenTrack.score5.n === 5);
  assert.ok(cohenTrack.score20 && cohenTrack.score20.n === 2);
  assert.equal(cohenTrack.decisions.length, 5);
});
